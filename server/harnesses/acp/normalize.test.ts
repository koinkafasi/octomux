/**
 * ACP wire objects → octomux `AgentEvent`s.
 *
 * The module is pure and synchronous, so every test here is a table row: an ACP
 * payload in, the exact events out. The interesting rows are the ones where the
 * mapping is *not* an identity — ACP's optional-with-`null` fields against
 * octomux's plain-optional ones, the content variants octomux has no slot for
 * (`audio`, `diff`, `terminal`, blob resources), and the fifteen-wide
 * `sessionUpdate` union against ten `AgentEvent` kinds.
 */

import type {
  ContentBlock as AcpContentBlock,
  PromptResponse as AcpPromptResponse,
  RequestPermissionRequest as AcpRequestPermissionRequest,
  SessionUpdate as AcpSessionUpdate,
  ToolCall as AcpToolCall,
  ToolCallContent as AcpToolCallContent,
  ToolCallUpdate as AcpToolCallUpdate,
} from '@agentclientprotocol/sdk';

import { describe, it, expect } from '../../bun-test.js';
import { AGENT_EVENT_KINDS, isAgentEvent, type AgentEvent, type ContentBlock } from '../events.js';
import {
  acpContentToBlock,
  acpToolContentToBlock,
  failureEvents,
  normalizePermissionRequest,
  normalizePromptResponse,
  normalizeSessionUpdate,
  normalizeToolCall,
  normalizeToolCallUpdate,
  sessionStartEvent,
} from './normalize.js';

const B64_PNG = 'iVBORw0KGgo=';

// ─── Content blocks ───────────────────────────────────────────────────────────

describe('acpContentToBlock', () => {
  const cases: Array<{ name: string; input: AcpContentBlock; expected: ContentBlock }> = [
    {
      name: 'text passes through',
      input: { type: 'text', text: 'hello from the agent' },
      expected: { type: 'text', text: 'hello from the agent' },
    },
    {
      name: 'empty text is still a text block',
      input: { type: 'text', text: '' },
      expected: { type: 'text', text: '' },
    },
    {
      name: 'image keeps mimeType and base64 payload',
      input: { type: 'image', mimeType: 'image/png', data: B64_PNG },
      expected: { type: 'image', mimeType: 'image/png', data: B64_PNG },
    },
    {
      name: 'resource_link keeps uri, name and mimeType',
      input: {
        type: 'resource_link',
        uri: 'file:///repo/server/api.ts',
        name: 'api.ts',
        mimeType: 'text/x-typescript',
      },
      expected: {
        type: 'resource_link',
        uri: 'file:///repo/server/api.ts',
        name: 'api.ts',
        mimeType: 'text/x-typescript',
      },
    },
    {
      name: 'resource_link with a null mimeType omits the key entirely',
      input: {
        type: 'resource_link',
        uri: 'file:///repo/README.md',
        name: 'README.md',
        mimeType: null,
      },
      expected: { type: 'resource_link', uri: 'file:///repo/README.md', name: 'README.md' },
    },
    {
      name: 'audio has no octomux variant and becomes a naming placeholder',
      input: { type: 'audio', mimeType: 'audio/wav', data: B64_PNG },
      expected: { type: 'text', text: '[audio audio/wav]' },
    },
    {
      name: 'a text embedded resource is inlined',
      input: {
        type: 'resource',
        resource: { uri: 'file:///repo/notes.md', mimeType: 'text/markdown', text: '# notes' },
      },
      expected: { type: 'text', text: '# notes' },
    },
    {
      name: 'a blob embedded resource becomes a link, never inlined base64',
      input: {
        type: 'resource',
        resource: { uri: 'file:///repo/logo.png', mimeType: 'image/png', blob: B64_PNG },
      },
      expected: { type: 'resource_link', uri: 'file:///repo/logo.png', mimeType: 'image/png' },
    },
    {
      name: 'a blob resource with no mimeType omits the key',
      input: { type: 'resource', resource: { uri: 'file:///repo/blob.bin', blob: B64_PNG } },
      expected: { type: 'resource_link', uri: 'file:///repo/blob.bin' },
    },
    {
      name: 'an unrecognised variant degrades to a placeholder instead of throwing',
      input: { type: 'hologram', frames: 3 } as unknown as AcpContentBlock,
      expected: { type: 'text', text: '[unsupported content hologram]' },
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(acpContentToBlock(input)).toEqual(expected);
  });

  it('does not inline blob bytes into the event stream', () => {
    const block = acpContentToBlock({
      type: 'resource',
      resource: { uri: 'file:///repo/huge.bin', blob: 'A'.repeat(4096) },
    });
    expect(JSON.stringify(block)).not.toContain('AAAA');
  });
});

describe('acpToolContentToBlock', () => {
  const cases: Array<{ name: string; input: AcpToolCallContent; expected: ContentBlock }> = [
    {
      name: 'content delegates to acpContentToBlock',
      input: { type: 'content', content: { type: 'text', text: 'tool said hi' } },
      expected: { type: 'text', text: 'tool said hi' },
    },
    {
      name: 'content carries nested images through unchanged',
      input: { type: 'content', content: { type: 'image', mimeType: 'image/png', data: B64_PNG } },
      expected: { type: 'image', mimeType: 'image/png', data: B64_PNG },
    },
    {
      name: 'diff keeps the path and the new text',
      input: { type: 'diff', path: '/repo/server/api.ts', newText: 'export const x = 1;\n' },
      expected: { type: 'text', text: '[diff /repo/server/api.ts]\nexport const x = 1;\n' },
    },
    {
      name: 'diff drops oldText — the worktree diff surface is canonical',
      input: {
        type: 'diff',
        path: '/repo/a.ts',
        oldText: 'THE OLD TEXT',
        newText: 'the new text',
      },
      expected: { type: 'text', text: '[diff /repo/a.ts]\nthe new text' },
    },
    {
      name: 'terminal becomes a reference, since terminal/output is unimplemented',
      input: { type: 'terminal', terminalId: 'term_42' },
      expected: { type: 'text', text: '[terminal term_42]' },
    },
    {
      name: 'an unrecognised variant degrades to a placeholder',
      input: { type: 'hologram' } as unknown as AcpToolCallContent,
      expected: { type: 'text', text: '[unsupported tool content hologram]' },
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(acpToolContentToBlock(input)).toEqual(expected);
  });
});

// ─── Tool calls ───────────────────────────────────────────────────────────────

describe('normalizeToolCall', () => {
  const cases: Array<{ name: string; input: AcpToolCall; expected: unknown }> = [
    {
      name: 'the bare minimum takes the documented defaults',
      input: { toolCallId: 'tc_1', title: 'Read README.md' },
      expected: { toolCallId: 'tc_1', title: 'Read README.md', kind: 'other', status: 'pending' },
    },
    {
      name: 'kind and status pass through when present',
      input: { toolCallId: 'tc_2', title: 'Run tests', kind: 'execute', status: 'in_progress' },
      expected: { toolCallId: 'tc_2', title: 'Run tests', kind: 'execute', status: 'in_progress' },
    },
    {
      name: "ACP's `name` becomes octomux's `toolName`",
      input: { toolCallId: 'tc_3', title: 'Run tests', name: 'Bash' },
      expected: {
        toolCallId: 'tc_3',
        title: 'Run tests',
        kind: 'other',
        status: 'pending',
        toolName: 'Bash',
      },
    },
    {
      name: 'a null `name` leaves toolName off',
      input: { toolCallId: 'tc_4', title: 'Run tests', name: null },
      expected: { toolCallId: 'tc_4', title: 'Run tests', kind: 'other', status: 'pending' },
    },
    {
      name: 'locations keep their line numbers',
      input: {
        toolCallId: 'tc_5',
        title: 'Edit',
        locations: [{ path: '/repo/a.ts', line: 12 }, { path: '/repo/b.ts' }],
      },
      expected: {
        toolCallId: 'tc_5',
        title: 'Edit',
        kind: 'other',
        status: 'pending',
        locations: [{ path: '/repo/a.ts', line: 12 }, { path: '/repo/b.ts' }],
      },
    },
    {
      name: 'a null line is dropped rather than emitted as null',
      input: {
        toolCallId: 'tc_6',
        title: 'Edit',
        locations: [{ path: '/repo/a.ts', line: null }] as AcpToolCall['locations'],
      },
      expected: {
        toolCallId: 'tc_6',
        title: 'Edit',
        kind: 'other',
        status: 'pending',
        locations: [{ path: '/repo/a.ts' }],
      },
    },
    {
      name: 'an empty locations array is omitted, not emitted empty',
      input: { toolCallId: 'tc_7', title: 'Edit', locations: [] },
      expected: { toolCallId: 'tc_7', title: 'Edit', kind: 'other', status: 'pending' },
    },
    {
      name: 'rawInput passes through verbatim',
      input: { toolCallId: 'tc_8', title: 'Bash', rawInput: { command: 'bun test', timeout: 5 } },
      expected: {
        toolCallId: 'tc_8',
        title: 'Bash',
        kind: 'other',
        status: 'pending',
        rawInput: { command: 'bun test', timeout: 5 },
      },
    },
    {
      name: 'a null rawInput is kept — null is a value the engine chose to send',
      input: { toolCallId: 'tc_9', title: 'Bash', rawInput: null },
      expected: {
        toolCallId: 'tc_9',
        title: 'Bash',
        kind: 'other',
        status: 'pending',
        rawInput: null,
      },
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(normalizeToolCall(input)).toEqual(expected);
  });

  it('does not carry ACP `content` — that becomes a separate tool_update', () => {
    const call = normalizeToolCall({
      toolCallId: 'tc_10',
      title: 'Bash',
      content: [{ type: 'content', content: { type: 'text', text: 'out' } }],
    });
    expect(call).not.toHaveProperty('content');
  });
});

describe('normalizeToolCallUpdate', () => {
  const cases: Array<{ name: string; input: AcpToolCallUpdate; expected: unknown }> = [
    {
      name: 'an id-only update stays an id-only update',
      input: { toolCallId: 'tc_1' },
      expected: { toolCallId: 'tc_1' },
    },
    {
      name: 'a status flip alone',
      input: { toolCallId: 'tc_1', status: 'completed' },
      expected: { toolCallId: 'tc_1', status: 'completed' },
    },
    {
      name: 'nulls mean "unchanged" and are dropped',
      input: { toolCallId: 'tc_1', status: null, title: null, kind: null, locations: null },
      expected: { toolCallId: 'tc_1' },
    },
    {
      name: 'content is mapped through acpToolContentToBlock',
      input: {
        toolCallId: 'tc_1',
        content: [
          { type: 'content', content: { type: 'text', text: 'ok' } },
          { type: 'terminal', terminalId: 'term_1' },
        ],
      },
      expected: {
        toolCallId: 'tc_1',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'text', text: '[terminal term_1]' },
        ],
      },
    },
    {
      name: 'an empty content array is still carried (it means "cleared")',
      input: { toolCallId: 'tc_1', content: [] },
      expected: { toolCallId: 'tc_1', content: [] },
    },
    {
      name: 'rawOutput passes through verbatim',
      input: { toolCallId: 'tc_1', rawOutput: { exitCode: 0, stdout: 'ok' } },
      expected: { toolCallId: 'tc_1', rawOutput: { exitCode: 0, stdout: 'ok' } },
    },
    {
      name: 'everything at once',
      input: {
        toolCallId: 'tc_1',
        status: 'failed',
        title: 'Run tests',
        kind: 'execute',
        locations: [{ path: '/repo/a.ts', line: 3 }],
        rawOutput: { exitCode: 1 },
      },
      expected: {
        toolCallId: 'tc_1',
        status: 'failed',
        title: 'Run tests',
        kind: 'execute',
        locations: [{ path: '/repo/a.ts', line: 3 }],
        rawOutput: { exitCode: 1 },
      },
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(normalizeToolCallUpdate(input)).toEqual(expected);
  });
});

// ─── Permission requests ──────────────────────────────────────────────────────

describe('normalizePermissionRequest', () => {
  const full: AcpRequestPermissionRequest = {
    sessionId: 'sess_1',
    toolCall: {
      toolCallId: 'tc_1',
      title: 'rm -rf build',
      kind: 'execute',
      status: 'pending',
      name: 'Bash',
      locations: [{ path: '/repo/build', line: null }],
      rawInput: { command: 'rm -rf build' },
    },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  };

  it('carries the JSON-RPC envelope id in, since ACP has no requestId field', () => {
    expect(normalizePermissionRequest(full, 'jsonrpc-7').requestId).toBe('jsonrpc-7');
  });

  it('fills the partial ACP ToolCallUpdate out into a full octomux ToolCall', () => {
    expect(normalizePermissionRequest(full, 'r1').toolCall).toEqual({
      toolCallId: 'tc_1',
      title: 'rm -rf build',
      kind: 'execute',
      status: 'pending',
      toolName: 'Bash',
      locations: [{ path: '/repo/build' }],
      rawInput: { command: 'rm -rf build' },
    });
  });

  it('falls back to the tool call id when the engine sent no title', () => {
    const req = normalizePermissionRequest(
      { sessionId: 's', toolCall: { toolCallId: 'tc_bare' }, options: [] },
      'r2',
    );
    expect(req.toolCall).toEqual({
      toolCallId: 'tc_bare',
      title: 'tc_bare',
      kind: 'other',
      status: 'pending',
    });
    expect(req.options).toEqual([]);
  });

  it('maps every option, dropping ACP-only extras', () => {
    const options = normalizePermissionRequest(full, 'r3').options;
    expect(options).toEqual([
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ]);
  });

  it('produces something isAgentEvent accepts once wrapped', () => {
    const event: AgentEvent = {
      t: 'request_permission',
      req: normalizePermissionRequest(full, 'r4'),
    };
    expect(isAgentEvent(event)).toBe(true);
  });
});

// ─── Session updates ──────────────────────────────────────────────────────────

describe('normalizeSessionUpdate', () => {
  const cases: Array<{ name: string; input: AcpSessionUpdate; expected: AgentEvent[] }> = [
    {
      name: 'user_message_chunk → message with role user',
      input: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'do the thing' },
      },
      expected: [{ t: 'message', content: { type: 'text', text: 'do the thing' }, role: 'user' }],
    },
    {
      name: 'agent_message_chunk → message with role assistant',
      input: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } },
      expected: [{ t: 'message', content: { type: 'text', text: 'on it' }, role: 'assistant' }],
    },
    {
      name: 'agent_thought_chunk → thought, kept separate from message',
      input: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      expected: [{ t: 'thought', content: { type: 'text', text: 'hmm' } }],
    },
    {
      name: 'tool_call → one tool_call event',
      input: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_1',
        title: 'Read api.ts',
        kind: 'read',
        status: 'in_progress',
      },
      expected: [
        {
          t: 'tool_call',
          call: { toolCallId: 'tc_1', title: 'Read api.ts', kind: 'read', status: 'in_progress' },
        },
      ],
    },
    {
      name: 'tool_call carrying content also emits a follow-up tool_update',
      input: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_2',
        title: 'Bash',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'exit 0' } }],
      },
      expected: [
        {
          t: 'tool_call',
          call: { toolCallId: 'tc_2', title: 'Bash', kind: 'other', status: 'completed' },
        },
        {
          t: 'tool_update',
          update: { toolCallId: 'tc_2', content: [{ type: 'text', text: 'exit 0' }] },
        },
      ],
    },
    {
      name: 'tool_call carrying rawOutput also emits a follow-up tool_update',
      input: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_3',
        title: 'Bash',
        rawOutput: { exitCode: 0 },
      },
      expected: [
        {
          t: 'tool_call',
          call: { toolCallId: 'tc_3', title: 'Bash', kind: 'other', status: 'pending' },
        },
        { t: 'tool_update', update: { toolCallId: 'tc_3', rawOutput: { exitCode: 0 } } },
      ],
    },
    {
      name: 'tool_call with an empty content array emits no follow-up',
      input: { sessionUpdate: 'tool_call', toolCallId: 'tc_4', title: 'Bash', content: [] },
      expected: [
        {
          t: 'tool_call',
          call: { toolCallId: 'tc_4', title: 'Bash', kind: 'other', status: 'pending' },
        },
      ],
    },
    {
      name: 'tool_call_update → tool_update',
      input: { sessionUpdate: 'tool_call_update', toolCallId: 'tc_1', status: 'completed' },
      expected: [{ t: 'tool_update', update: { toolCallId: 'tc_1', status: 'completed' } }],
    },
    {
      name: 'plan → plan, whole-list replace semantics',
      input: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'read the spec', status: 'completed', priority: 'high' },
          { content: 'write the tests', status: 'in_progress', priority: 'medium' },
        ],
      },
      expected: [
        {
          t: 'plan',
          plan: {
            entries: [
              { content: 'read the spec', status: 'completed', priority: 'high' },
              { content: 'write the tests', status: 'in_progress', priority: 'medium' },
            ],
          },
        },
      ],
    },
    {
      name: 'an empty plan is still a plan event',
      input: { sessionUpdate: 'plan', entries: [] },
      expected: [{ t: 'plan', plan: { entries: [] } }],
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(normalizeSessionUpdate(input, { sessionId: 'sess_1' })).toEqual(expected);
  });

  /**
   * The updates spec §2.3 has no slot for. Each is dropped deliberately (see the
   * module header's "What is deliberately dropped"), so an empty array here is
   * the assertion — a future `usage_update` mapping would have to change this row
   * and justify the invented input/output split.
   */
  const dropped: Array<{ name: string; input: AcpSessionUpdate }> = [
    {
      name: 'usage_update — context occupancy, not a turn input/output split',
      input: {
        sessionUpdate: 'usage_update',
        usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
      } as unknown as AcpSessionUpdate,
    },
    {
      name: 'plan_update — patch semantics, and the capability is not advertised',
      input: { sessionUpdate: 'plan_update' } as unknown as AcpSessionUpdate,
    },
    {
      name: 'plan_removed',
      input: { sessionUpdate: 'plan_removed' } as unknown as AcpSessionUpdate,
    },
    {
      name: 'available_commands_update',
      input: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
      } as unknown as AcpSessionUpdate,
    },
    {
      name: 'current_mode_update',
      input: {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'ask',
      } as unknown as AcpSessionUpdate,
    },
    {
      name: 'config_option_update',
      input: { sessionUpdate: 'config_option_update' } as unknown as AcpSessionUpdate,
    },
    {
      name: 'session_info_update',
      input: { sessionUpdate: 'session_info_update' } as unknown as AcpSessionUpdate,
    },
    {
      name: 'compaction_update',
      input: { sessionUpdate: 'compaction_update' } as unknown as AcpSessionUpdate,
    },
    {
      name: 'compaction_summary_chunk',
      input: { sessionUpdate: 'compaction_summary_chunk' } as unknown as AcpSessionUpdate,
    },
    {
      name: 'a sessionUpdate kind that does not exist yet',
      input: { sessionUpdate: 'telepathy_chunk' } as unknown as AcpSessionUpdate,
    },
  ];

  it.each(dropped)('drops $name', ({ input }) => {
    expect(normalizeSessionUpdate(input, { sessionId: 'sess_1' })).toEqual([]);
  });

  it('works with no options argument at all', () => {
    expect(
      normalizeSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
    ).toEqual([{ t: 'message', content: { type: 'text', text: 'hi' }, role: 'assistant' }]);
  });

  it('only ever emits events isAgentEvent accepts', () => {
    for (const { input } of cases) {
      for (const event of normalizeSessionUpdate(input)) {
        expect(isAgentEvent(event)).toBe(true);
      }
    }
  });
});

// ─── Turn boundaries ──────────────────────────────────────────────────────────

describe('normalizePromptResponse', () => {
  const stopReasons: AcpPromptResponse['stopReason'][] = [
    'end_turn',
    'max_tokens',
    'max_turn_requests',
    'refusal',
    'cancelled',
  ];

  it.each(stopReasons)('carries stop reason %s through verbatim', (stopReason) => {
    expect(normalizePromptResponse({ stopReason })).toEqual([{ t: 'done', reason: stopReason }]);
  });

  it('emits usage before done when the agent reported it', () => {
    expect(
      normalizePromptResponse(
        {
          stopReason: 'end_turn',
          usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 },
        },
        { model: 'gemini-2.5-pro' },
      ),
    ).toEqual([
      { t: 'usage', inputTokens: 20, outputTokens: 10, model: 'gemini-2.5-pro' },
      { t: 'done', reason: 'end_turn' },
    ]);
  });

  it('maps ACP cache counters onto the Anthropic-style names', () => {
    expect(
      normalizePromptResponse(
        {
          stopReason: 'end_turn',
          usage: {
            totalTokens: 30,
            inputTokens: 20,
            outputTokens: 10,
            cachedReadTokens: 7,
            cachedWriteTokens: 3,
          },
        },
        { model: 'm' },
      )[0],
    ).toEqual({
      t: 'usage',
      inputTokens: 20,
      outputTokens: 10,
      model: 'm',
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 3,
    });
  });

  it('omits cache counters that arrive as null', () => {
    const usage = normalizePromptResponse({
      stopReason: 'end_turn',
      usage: {
        totalTokens: 30,
        inputTokens: 20,
        outputTokens: 10,
        cachedReadTokens: null,
        cachedWriteTokens: null,
      },
    })[0];
    expect(usage).not.toHaveProperty('cacheReadInputTokens');
    expect(usage).not.toHaveProperty('cacheCreationInputTokens');
  });

  it('stamps "unknown" when the launch config named no model', () => {
    expect(
      normalizePromptResponse({
        stopReason: 'end_turn',
        usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
      })[0],
    ).toMatchObject({ model: 'unknown' });
  });

  it('emits no usage event when usage is null', () => {
    expect(normalizePromptResponse({ stopReason: 'end_turn', usage: null })).toEqual([
      { t: 'done', reason: 'end_turn' },
    ]);
  });
});

describe('sessionStartEvent', () => {
  it('opens the stream with the agent-issued session id', () => {
    expect(sessionStartEvent('sess_abc')).toEqual({ t: 'session_start', sessionId: 'sess_abc' });
  });
});

describe('failureEvents', () => {
  it('always emits error then done, in that order', () => {
    expect(failureEvents('the pipe broke')).toEqual([
      { t: 'error', message: 'the pipe broke' },
      { t: 'done', reason: 'error' },
    ]);
  });

  it('takes a caller-supplied done reason', () => {
    expect(failureEvents('agent exited (exit code 7)', 'agent_exited')).toEqual([
      { t: 'error', message: 'agent exited (exit code 7)' },
      { t: 'done', reason: 'agent_exited' },
    ]);
  });

  it('always terminates the stream — a lone error would hang a for-await', () => {
    const events = failureEvents('boom');
    expect(events.at(-1)?.t).toBe('done');
  });

  it('keeps an empty message rather than substituting one', () => {
    expect(failureEvents('')).toEqual([
      { t: 'error', message: '' },
      { t: 'done', reason: 'error' },
    ]);
  });
});

// ─── Coverage of the contract ─────────────────────────────────────────────────

describe('mapping coverage', () => {
  /**
   * Which `AgentEvent` kinds this module can produce, and from where. `session_start`
   * comes from `session/new`, `error`/`done` from failures and turn ends, the rest
   * from `session/update`. Nothing in `AGENT_EVENT_KINDS` may be unreachable.
   */
  it('every AgentEvent kind has a producer in this module', () => {
    const produced = new Set<string>();

    produced.add(sessionStartEvent('s').t);
    for (const event of failureEvents('x')) produced.add(event.t);
    for (const event of normalizePromptResponse({
      stopReason: 'end_turn',
      usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
    })) {
      produced.add(event.t);
    }

    const updates: AcpSessionUpdate[] = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'b' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tc', title: 't' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc' },
      { sessionUpdate: 'plan', entries: [] },
    ];
    for (const update of updates) {
      for (const event of normalizeSessionUpdate(update)) produced.add(event.t);
    }

    produced.add('request_permission');

    expect([...produced].sort()).toEqual([...AGENT_EVENT_KINDS].sort());
  });
});
