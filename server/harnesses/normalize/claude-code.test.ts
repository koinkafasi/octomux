import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from '../../bun-test.js';
import type { AgentEvent, AgentEventKind, AgentEventOf } from '../events.js';
import {
  ClaudeCodeNormalizer,
  createClaudeCodeNormalizer,
  normalizeClaudeCodeStream,
  toolKindFor,
} from './claude-code.js';

/**
 * The recorded transcript the module was written against (claude 2.1.183, two
 * compactions). Every distribution assertion below is a measured number from this
 * file, not an invented one — if a mapping regresses, the count moves.
 */
const FIXTURE_PATH = path.join(
  import.meta.dirname,
  '..',
  '..',
  'orchestrator',
  '__fixtures__',
  'transcript-2.1.183-with-compaction.jsonl',
);
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');
const FIXTURE_LINES = FIXTURE.split('\n').filter((l) => l.length > 0);
const EVENTS = normalizeClaudeCodeStream(FIXTURE);

const SESSION_ID = '78d07962-2644-419f-bbee-4215e4fa8f05';

function countByKind(events: AgentEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.t] = (counts[e.t] ?? 0) + 1;
  return counts;
}

function of<K extends AgentEventKind>(events: AgentEvent[], kind: K): Array<AgentEventOf<K>> {
  return events.filter((e): e is AgentEventOf<K> => e.t === kind);
}

/** First fixture line whose top-level `type` matches. */
function lineOfType(type: string): string {
  const found = FIXTURE_LINES.find((l) => (JSON.parse(l) as { type?: string }).type === type);
  if (!found) throw new Error(`fixture has no line of type ${type}`);
  return found;
}

// ─── toolKindFor ──────────────────────────────────────────────────────────────

describe('toolKindFor', () => {
  it.each([
    ['Read', 'read'],
    ['NotebookRead', 'read'],
    ['Glob', 'search'],
    ['Grep', 'search'],
    ['ToolSearch', 'search'],
    ['WebSearch', 'search'],
    ['Edit', 'edit'],
    ['MultiEdit', 'edit'],
    ['Write', 'edit'],
    ['NotebookEdit', 'edit'],
    ['Bash', 'execute'],
    ['BashOutput', 'execute'],
    ['KillShell', 'execute'],
    ['WebFetch', 'fetch'],
    ['ExitPlanMode', 'switch_mode'],
  ])('maps the built-in %s to %s', (toolName, kind) => {
    expect(toolKindFor(toolName)).toBe(kind);
  });

  it.each([
    ['Agent', 'a tool with no ACP analogue'],
    ['Skill', 'a tool with no ACP analogue'],
    ['TaskCreate', 'an octomux tool'],
    ['TodoWrite', 'the plan tool, which never reaches a tool_call'],
    ['mcp__linear__create_issue', 'an MCP tool'],
    ['SomethingAddedInAFutureRelease', 'an unknown tool'],
    ['read', 'the wrong case — the table is case-sensitive'],
    ['', 'the empty string'],
  ])('falls back to other for %s (%s)', (toolName) => {
    expect(toolKindFor(toolName)).toBe('other');
  });

  it('never returns undefined for an unknown name', () => {
    expect(toolKindFor('__definitely_not_a_tool__')).toBeDefined();
  });
});

// ─── Fixture: what the whole transcript normalises to ─────────────────────────

describe('normalizeClaudeCodeStream over the recorded transcript', () => {
  it('produces the measured event distribution', () => {
    expect(countByKind(EVENTS)).toEqual({
      session_start: 1,
      message: 179,
      usage: 341,
      tool_call: 362,
      tool_update: 362,
      done: 23,
    });
    expect(EVENTS).toHaveLength(1268);
  });

  it.each([
    ['thought', 'every thinking block in this transcript is redacted to an empty string'],
    ['plan', 'the transcript contains no TodoWrite call'],
    ['error', 'no line is flagged isApiErrorMessage or is_error at the top level'],
    ['request_permission', 'control_request lines exist only on the stream-json stdout side'],
  ])('emits no %s events (%s)', (kind) => {
    expect(of(EVENTS, kind as AgentEventKind)).toHaveLength(0);
  });

  it('opens with exactly one session_start, taken from the first line that carries an id', () => {
    expect(EVENTS[0]).toEqual({ t: 'session_start', sessionId: SESSION_ID });
    expect(of(EVENTS, 'session_start')).toHaveLength(1);
  });

  it('closes every turn with a done carrying the stop-hook reason', () => {
    const done = of(EVENTS, 'done');
    expect(done).toHaveLength(23);
    expect(new Set(done.map((e) => e.reason))).toEqual(new Set(['stop_hook_summary']));
  });

  it('splits messages into the two roles the transcript can distinguish', () => {
    const messages = of(EVENTS, 'message');
    const byRole: Record<string, number> = {};
    for (const m of messages) byRole[m.role ?? 'none'] = (byRole[m.role ?? 'none'] ?? 0) + 1;
    expect(byRole).toEqual({ assistant: 150, user: 29 });
    expect(messages.every((m) => m.content.type === 'text')).toBe(true);
  });
});

// ─── Fixture: usage ───────────────────────────────────────────────────────────

describe('usage extraction', () => {
  it('emits once per message id, not once per assistant line', () => {
    const assistantLines = FIXTURE_LINES.filter(
      (l) => (JSON.parse(l) as { type?: string }).type === 'assistant',
    );
    const messageIds = new Set(
      assistantLines.map((l) => (JSON.parse(l) as { message: { id?: string } }).message.id),
    );
    expect(assistantLines).toHaveLength(585);
    expect(messageIds.size).toBe(341);
    // Every one of the 585 lines repeats the same cumulative usage; emitting per
    // line would multiply the bill by the content-block count.
    expect(of(EVENTS, 'usage')).toHaveLength(messageIds.size);
  });

  it('carries the four token fields off the first assistant message', () => {
    expect(of(EVENTS, 'usage')[0]).toEqual({
      t: 'usage',
      inputTokens: 8865,
      outputTokens: 897,
      model: 'claude-opus-4-8',
      cacheReadInputTokens: 16594,
      cacheCreationInputTokens: 10340,
    });
  });

  it('reports the model per message rather than once per run', () => {
    const models = new Set(of(EVENTS, 'usage').map((e) => e.model));
    expect(models).toEqual(new Set(['claude-opus-4-8', 'claude-sonnet-4-6']));
  });

  it('never emits a negative or non-finite token count', () => {
    for (const u of of(EVENTS, 'usage')) {
      expect(Number.isFinite(u.inputTokens) && u.inputTokens >= 0).toBe(true);
      expect(Number.isFinite(u.outputTokens) && u.outputTokens >= 0).toBe(true);
    }
  });

  it.each([
    [
      'input_tokens',
      '{"type":"assistant","sessionId":"s","message":{"id":"m1","model":"m","usage":{"output_tokens":7}}}',
      { inputTokens: 0, outputTokens: 7 },
    ],
    [
      'output_tokens',
      '{"type":"assistant","sessionId":"s","message":{"id":"m1","model":"m","usage":{"input_tokens":7}}}',
      { inputTokens: 7, outputTokens: 0 },
    ],
  ])('defaults a missing %s to zero', (_label, line, expected) => {
    const usage = of(normalizeClaudeCodeStream(`${line}\n`), 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].inputTokens).toBe(expected.inputTokens);
    expect(usage[0].outputTokens).toBe(expected.outputTokens);
    expect(usage[0].cacheReadInputTokens).toBeUndefined();
    expect(usage[0].cacheCreationInputTokens).toBeUndefined();
  });
});

// ─── Fixture: tool calls ──────────────────────────────────────────────────────

describe('tool call mapping', () => {
  it('classifies the transcript tools into ACP kinds', () => {
    const kinds: Record<string, number> = {};
    for (const e of of(EVENTS, 'tool_call')) kinds[e.call.kind] = (kinds[e.call.kind] ?? 0) + 1;
    expect(kinds).toEqual({ execute: 137, read: 102, edit: 87, other: 35, search: 1 });
  });

  it('keeps the engine-native tool name alongside the kind', () => {
    const names: Record<string, number> = {};
    for (const e of of(EVENTS, 'tool_call')) {
      names[e.call.toolName ?? 'none'] = (names[e.call.toolName ?? 'none'] ?? 0) + 1;
    }
    expect(names).toEqual({
      Bash: 137,
      Read: 102,
      Edit: 74,
      Agent: 14,
      Write: 13,
      TaskUpdate: 12,
      TaskCreate: 6,
      Skill: 3,
      ToolSearch: 1,
    });
  });

  it('titles a Bash call with its authored description', () => {
    expect(of(EVENTS, 'tool_call')[0].call).toMatchObject({
      toolCallId: 'toolu_01UipsdSR1bXgVaSXU5VV25P',
      title: 'Read design doc',
      kind: 'execute',
      status: 'in_progress',
      toolName: 'Bash',
    });
  });

  it('attaches locations only to calls that name a file', () => {
    const calls = of(EVENTS, 'tool_call');
    const located = calls.filter((e) => e.call.locations !== undefined);
    expect(located).toHaveLength(189);
    expect(located.every((e) => (e.call.locations ?? []).every((l) => l.path.length > 0))).toBe(
      true,
    );
    expect(located[0].call.locations?.[0].path).toContain('/cli/src/index.ts');
  });

  it('pairs every tool_update with a tool_call it already announced', () => {
    const announced = new Set(of(EVENTS, 'tool_call').map((e) => e.call.toolCallId));
    const orphans = of(EVENTS, 'tool_update').filter((e) => !announced.has(e.update.toolCallId));
    expect(orphans).toEqual([]);
  });

  it('flips a tool_update to failed when the result is an error', () => {
    const statuses: Record<string, number> = {};
    for (const e of of(EVENTS, 'tool_update')) {
      statuses[e.update.status ?? 'none'] = (statuses[e.update.status ?? 'none'] ?? 0) + 1;
    }
    expect(statuses).toEqual({ completed: 349, failed: 13 });
  });
});

// ─── Fixture: compaction ──────────────────────────────────────────────────────

describe('compaction handling', () => {
  it('swallows the synthetic continuation prompt that follows each boundary', () => {
    const boundaries = FIXTURE_LINES.filter((l) => l.includes('"subtype":"compact_boundary"'));
    expect(boundaries).toHaveLength(2);
    const leaked = of(EVENTS, 'message').filter((m) =>
      m.content.type === 'text'
        ? m.content.text.includes('This session is being continued')
        : false,
    );
    expect(leaked).toEqual([]);
  });

  it('emits nothing at all for the boundary line itself', () => {
    const boundary = FIXTURE_LINES.find((l) => l.includes('"subtype":"compact_boundary"'));
    const events = normalizeClaudeCodeStream(`${boundary}\n`);
    expect(events.filter((e) => e.t !== 'session_start')).toEqual([]);
  });

  it('resumes the human turn after the swallowed one', () => {
    const stream = [
      '{"type":"system","subtype":"compact_boundary","sessionId":"s"}',
      '{"type":"user","sessionId":"s","message":{"content":"This session is being continued…"}}',
      '{"type":"user","sessionId":"s","message":{"content":"a genuinely new turn"}}',
    ].join('\n');
    const messages = of(normalizeClaudeCodeStream(`${stream}\n`), 'message');
    expect(messages).toEqual([
      { t: 'message', content: { type: 'text', text: 'a genuinely new turn' }, role: 'user' },
    ]);
  });
});

// ─── Chunk boundaries ─────────────────────────────────────────────────────────

/** Deterministic PRNG so the "random" split offsets are reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0xc0ffee);
const RANDOM_OFFSETS = Array.from(
  { length: 12 },
  () => 1 + Math.floor(random() * (FIXTURE.length - 2)),
);

describe('chunk-boundary independence', () => {
  function pushInTwo(at: number): AgentEvent[] {
    const n = new ClaudeCodeNormalizer();
    return [...n.push(FIXTURE.slice(0, at)), ...n.push(FIXTURE.slice(at)), ...n.flush()];
  }

  it.each(RANDOM_OFFSETS)('yields the identical stream when split at byte %i', (at) => {
    expect(pushInTwo(at)).toEqual(EVENTS);
  });

  it.each([
    ['the very first byte', 1],
    ['the last byte', FIXTURE.length - 1],
  ])('yields the identical stream when split at %s', (_label, at) => {
    expect(pushInTwo(at)).toEqual(EVENTS);
  });

  it('reassembles a JSON line deliberately cut mid-string', () => {
    const line = lineOfType('assistant');
    const cut = Math.floor(line.length / 2);
    const n = createClaudeCodeNormalizer();
    expect(n.push(line.slice(0, cut))).toEqual([]);
    const rest = [...n.push(`${line.slice(cut)}\n`), ...n.flush()];
    expect(rest).toEqual(normalizeClaudeCodeStream(`${line}\n`));
    expect(rest.length).toBeGreaterThan(0);
  });

  it('yields nothing until a newline arrives, then everything at once', () => {
    const line = lineOfType('assistant');
    const n = createClaudeCodeNormalizer();
    expect(n.push(line)).toEqual([]);
    expect(n.push('\n').length).toBeGreaterThan(0);
  });

  it('flush completes a trailing line that never got its newline', () => {
    const line = lineOfType('assistant');
    const n = createClaudeCodeNormalizer();
    expect(n.push(line)).toEqual([]);
    const flushed = n.flush();
    expect(flushed).toEqual(normalizeClaudeCodeStream(`${line}\n`));
    expect(n.flush()).toEqual([]);
  });

  it('is byte-for-byte stable across many small chunks', () => {
    const head = FIXTURE.slice(0, 200_000);
    const n = new ClaudeCodeNormalizer();
    const out: AgentEvent[] = [];
    for (let i = 0; i < head.length; i += 997) out.push(...n.push(head.slice(i, i + 997)));
    out.push(...n.flush());
    expect(out).toEqual(normalizeClaudeCodeStream(head));
  });
});

// ─── Malformed input ──────────────────────────────────────────────────────────

describe('malformed input never kills the stream', () => {
  const GOOD = lineOfType('assistant');
  const EXPECTED = normalizeClaudeCodeStream(`${GOOD}\n`);

  it.each([
    ['plain prose the CLI printed outside the stream', 'Welcome to Claude Code!'],
    ['a truncated JSON object', '{"type":"assistant","message":{"content":['],
    ['a stray closing brace', '}'],
    ['an empty line', ''],
    ['a whitespace-only line', '   \t  '],
    ['a JSON null', 'null'],
    ['a JSON number', '42'],
    ['a JSON string', '"just a string"'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON object with no type', '{"foo":"bar"}'],
    ['a type octomux does not know', '{"type":"brand-new-line-kind","payload":1}'],
    ['an ANSI-coloured banner', '\u001B[32mready\u001B[0m'],
  ])('drops %s without disturbing the surrounding events', (_label, junk) => {
    const events = normalizeClaudeCodeStream(`${junk}\n${GOOD}\n${junk}\n`);
    expect(events).toEqual(EXPECTED);
  });

  it('survives a stream that is nothing but junk', () => {
    expect(normalizeClaudeCodeStream('not json\n{\n]\n\n')).toEqual([]);
  });

  it('keeps parsing after a line is truncated mid-object', () => {
    const good = lineOfType('assistant');
    const events = normalizeClaudeCodeStream(`${good.slice(0, 80)}\n${good}\n`);
    expect(events).toEqual(EXPECTED);
  });

  it('drops an assistant line whose message is not an object', () => {
    expect(
      normalizeClaudeCodeStream('{"type":"assistant","sessionId":"s","message":"oops"}\n'),
    ).toEqual([{ t: 'session_start', sessionId: 's' }]);
  });

  it('drops a tool_use block with no id', () => {
    const line =
      '{"type":"assistant","sessionId":"s","message":{"id":"m","model":"m","content":' +
      '[{"type":"tool_use","name":"Bash","input":{}}]}}';
    expect(normalizeClaudeCodeStream(`${line}\n`)).toEqual([
      { t: 'session_start', sessionId: 's' },
    ]);
  });
});

// ─── stream-json-only shapes ──────────────────────────────────────────────────

/**
 * `result` and `control_request` lines exist only on `--output-format stream-json`
 * stdout — never in the transcript file — so they cannot be exercised from the
 * fixture. The shapes asserted here are the ones the module header documents.
 */
describe('stream-json-only line shapes', () => {
  it('turns a successful result line into usage + done', () => {
    const line =
      '{"type":"result","subtype":"success","session_id":"s1","model":"claude-opus-4-8",' +
      '"usage":{"input_tokens":11,"output_tokens":22,"cache_read_input_tokens":33,' +
      '"cache_creation_input_tokens":44}}';
    expect(normalizeClaudeCodeStream(`${line}\n`)).toEqual([
      { t: 'session_start', sessionId: 's1' },
      {
        t: 'usage',
        inputTokens: 11,
        outputTokens: 22,
        model: 'claude-opus-4-8',
        cacheReadInputTokens: 33,
        cacheCreationInputTokens: 44,
      },
      { t: 'done', reason: 'success' },
    ]);
  });

  it('turns a failed result line into an error rather than a done', () => {
    const line =
      '{"type":"result","subtype":"error_during_execution","is_error":true,' +
      '"result":"the model ran out of turns"}';
    expect(normalizeClaudeCodeStream(`${line}\n`)).toEqual([
      { t: 'error', message: 'the model ran out of turns' },
    ]);
  });

  it('turns a can_use_tool control request into a permission request', () => {
    const line =
      '{"type":"control_request","request_id":"req_7","request":{"subtype":"can_use_tool",' +
      '"tool_name":"Bash","tool_use_id":"toolu_9","input":{"command":"rm -rf /",' +
      '"description":"clean up"}}}';
    const events = normalizeClaudeCodeStream(`${line}\n`);
    expect(events).toHaveLength(1);
    const req = of(events, 'request_permission')[0].req;
    expect(req.requestId).toBe('req_7');
    expect(req.toolCall).toMatchObject({
      toolCallId: 'toolu_9',
      title: 'clean up',
      kind: 'execute',
      status: 'pending',
      toolName: 'Bash',
    });
    expect(req.options.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
  });

  it('gives each permission request its own options array', () => {
    const line =
      '{"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool",' +
      '"tool_name":"Read"}}';
    const [a, b] = [normalizeClaudeCodeStream(`${line}\n`), normalizeClaudeCodeStream(`${line}\n`)];
    const first = of(a, 'request_permission')[0].req.options;
    const second = of(b, 'request_permission')[0].req.options;
    expect(first).toEqual(second);
    expect(first[0]).not.toBe(second[0]);
  });

  it('ignores a control request that is not can_use_tool', () => {
    const line = '{"type":"control_request","request_id":"r","request":{"subtype":"interrupt"}}';
    expect(normalizeClaudeCodeStream(`${line}\n`)).toEqual([]);
  });

  it('turns a TodoWrite tool_use into a plan, not a tool_call', () => {
    const line =
      '{"type":"assistant","sessionId":"s","message":{"id":"m","model":"m","content":' +
      '[{"type":"tool_use","id":"toolu_todo","name":"TodoWrite","input":{"todos":[' +
      '{"content":"write the tests","status":"in_progress","priority":"high"},' +
      '{"content":"run typecheck","status":"pending"},' +
      '{"activeForm":"Shipping","status":"bogus","priority":"urgent"}]}}]}}';
    const events = normalizeClaudeCodeStream(`${line}\n`);
    expect(of(events, 'tool_call')).toEqual([]);
    expect(of(events, 'plan')[0].plan).toEqual({
      entries: [
        { content: 'write the tests', status: 'in_progress', priority: 'high' },
        { content: 'run typecheck', status: 'pending', priority: 'medium' },
        { content: 'Shipping', status: 'pending', priority: 'medium' },
      ],
    });
  });

  it('drops the tool_result of a TodoWrite, since no call was announced', () => {
    const stream = [
      '{"type":"assistant","sessionId":"s","message":{"id":"m","model":"m","content":' +
        '[{"type":"tool_use","id":"toolu_todo","name":"TodoWrite","input":{"todos":[]}}]}}',
      '{"type":"user","sessionId":"s","message":{"content":[{"type":"tool_result",' +
        '"tool_use_id":"toolu_todo","content":"ok"}]}}',
    ].join('\n');
    expect(of(normalizeClaudeCodeStream(`${stream}\n`), 'tool_update')).toEqual([]);
  });

  it('reports an isApiErrorMessage assistant line as an error', () => {
    const line =
      '{"type":"assistant","sessionId":"s","isApiErrorMessage":true,"message":{"content":' +
      '[{"type":"text","text":"API Error: 529 overloaded"}]}}';
    expect(of(normalizeClaudeCodeStream(`${line}\n`), 'error')).toEqual([
      { t: 'error', message: 'API Error: 529 overloaded' },
    ]);
  });

  it('emits a thought for a thinking block that actually carries text', () => {
    const line =
      '{"type":"assistant","sessionId":"s","message":{"id":"m","model":"m","content":' +
      '[{"type":"thinking","thinking":"the schema is forward-only"}]}}';
    expect(of(normalizeClaudeCodeStream(`${line}\n`), 'thought')).toEqual([
      { t: 'thought', content: { type: 'text', text: 'the schema is forward-only' } },
    ]);
  });

  it('reads session_start from the stream-json session_id spelling too', () => {
    expect(normalizeClaudeCodeStream('{"type":"mode","session_id":"snake_case"}\n')).toEqual([
      { t: 'session_start', sessionId: 'snake_case' },
    ]);
  });
});

// ─── Normalizer contract ──────────────────────────────────────────────────────

describe('Normalizer contract', () => {
  it('createClaudeCodeNormalizer hands back a fresh instance each call', () => {
    expect(createClaudeCodeNormalizer()).not.toBe(createClaudeCodeNormalizer());
    expect(createClaudeCodeNormalizer()).toBeInstanceOf(ClaudeCodeNormalizer);
  });

  it('emits session_start once even across many pushes', () => {
    const n = createClaudeCodeNormalizer();
    const out: AgentEvent[] = [];
    for (const line of FIXTURE_LINES.slice(0, 40)) out.push(...n.push(`${line}\n`));
    out.push(...n.flush());
    expect(of(out, 'session_start')).toHaveLength(1);
  });

  it('flush on an untouched normalizer returns no events', () => {
    expect(createClaudeCodeNormalizer().flush()).toEqual([]);
  });

  it('push never throws, whatever it is handed', () => {
    const n = createClaudeCodeNormalizer();
    expect(() => {
      n.push('');
      n.push('\n\n\n');
      n.push('{"type":');
      n.push('\u0000\u001B[31m\n');
      n.flush();
    }).not.toThrow();
  });
});
