/**
 * server/harnesses/acp/normalize.ts
 *
 * ACP wire objects → octomux `AgentEvent`s (spec/engine-layer.md §2.3).
 *
 * `AgentEvent`'s vocabulary was lifted from ACP, so most of this file is a
 * near-identity mapping. It exists anyway because "near" is doing real work:
 * ACP's union is fifteen `sessionUpdate` kinds wide against octomux's ten
 * events, ACP marks optional-with-`null` where octomux uses plain optional, and
 * ACP's content model has variants (`audio`, `diff`, `terminal`) that
 * `ContentBlock` does not.
 *
 * Everything here is pure and synchronous: same input, same output, no I/O. The
 * process and connection machinery lives in `./client.ts`.
 *
 * ## Mapping
 *
 * | ACP                                        | AgentEvent                          |
 * | ------------------------------------------ | ----------------------------------- |
 * | `session/new` response                     | `session_start`                     |
 * | update `user_message_chunk`                | `message` (role `user`)             |
 * | update `agent_message_chunk`               | `message` (role `assistant`)        |
 * | update `agent_thought_chunk`               | `thought`                           |
 * | update `tool_call`                         | `tool_call` (+ `tool_update` if it already carries content/output) |
 * | update `tool_call_update`                  | `tool_update`                       |
 * | update `plan`                              | `plan`                              |
 * | `session/request_permission` params        | `request_permission`                |
 * | `session/prompt` response `usage`          | `usage`                             |
 * | `session/prompt` response `stopReason`     | `done`                              |
 * | transport / process failure (`./client.ts`)| `error` then `done`                 |
 *
 * ## What is deliberately dropped
 *
 * - `usage_update` reports *context occupancy* (`used` tokens out of a `size`
 *   window), not a turn's input/output split. octomux's `usage` event requires
 *   that split, and inventing one — `inputTokens: used, outputTokens: 0` — would
 *   put wrong numbers on M2's cost card. The honest source is
 *   `PromptResponse.usage`, which really does carry `inputTokens`/`outputTokens`
 *   and is mapped in full, cache counters included.
 * - `plan_update` / `plan_removed` are patch-semantics updates gated behind the
 *   `plan` client capability. `./client.ts` does not advertise it, so a
 *   conforming agent must not send them, and octomux's `Plan` is
 *   replace-the-whole-list anyway.
 * - `available_commands_update`, `current_mode_update`, `config_option_update`,
 *   `session_info_update`, `compaction_update`, `compaction_summary_chunk` have
 *   no `AgentEvent` counterpart. They are logged at debug and skipped.
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

import { childLogger } from '../../logger.js';
import {
  textBlock,
  type AgentEvent,
  type ContentBlock,
  type PermissionOption,
  type PermissionRequest,
  type Plan,
  type ToolCall,
  type ToolCallLocation,
  type ToolCallStatus,
  type ToolCallUpdate,
  type ToolKind,
} from '../events.js';

const logger = childLogger('harnesses/acp');

export interface AcpNormalizeOptions {
  /**
   * Model label stamped onto `usage` events. ACP has no field that reports the
   * model in use, so it has to come from the launch config; `unknown` when the
   * caller has nothing better.
   */
  model?: string;
  /** Included in debug logs so a dropped update can be traced to a task. */
  sessionId?: string;
}

const UNKNOWN_MODEL = 'unknown';

// ─── Content ──────────────────────────────────────────────────────────────────

/**
 * ACP `ContentBlock` → octomux `ContentBlock`.
 *
 * `text`, `image`, and `resource_link` map one-to-one. The two that do not:
 *
 * - `audio` has no octomux variant. Dropping it would silently delete a turn, so
 *   it becomes a text placeholder naming its MIME type.
 * - `resource` (an MCP embedded resource) is either text — used directly — or a
 *   base64 blob, which becomes a `resource_link` to the URI it came from rather
 *   than inlining megabytes of base64 into the event stream.
 */
export function acpContentToBlock(block: AcpContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return textBlock(block.text);

    case 'image':
      return { type: 'image', mimeType: block.mimeType, data: block.data };

    case 'resource_link':
      return {
        type: 'resource_link',
        uri: block.uri,
        name: block.name,
        ...(block.mimeType ? { mimeType: block.mimeType } : {}),
      };

    case 'audio':
      return textBlock(`[audio ${block.mimeType}]`);

    case 'resource': {
      const resource = block.resource;
      if ('text' in resource) return textBlock(resource.text);
      return {
        type: 'resource_link',
        uri: resource.uri,
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      };
    }

    default: {
      // ACP's ContentBlock union can grow; an unrecognised variant becomes a
      // placeholder rather than an exception on a hot path.
      const kind = (block as { type?: unknown }).type;
      logger.debug({ operation: 'acp_content_unknown', kind }, 'unknown ACP content block');
      return textBlock(`[unsupported content ${String(kind)}]`);
    }
  }
}

/**
 * ACP `ToolCallContent` → octomux `ContentBlock`.
 *
 * `diff` keeps the path and the new text; `oldText` is dropped because
 * `ContentBlock` has no diff variant and octomux's worktree diff surface
 * (`@octomux/diff-engine`) is the canonical before/after view anyway.
 * `terminal` becomes a reference: its output is fetched over `terminal/output`,
 * a client method this adapter does not implement.
 */
export function acpToolContentToBlock(content: AcpToolCallContent): ContentBlock {
  switch (content.type) {
    case 'content':
      return acpContentToBlock(content.content);
    case 'diff':
      return textBlock(`[diff ${content.path}]\n${content.newText}`);
    case 'terminal':
      return textBlock(`[terminal ${content.terminalId}]`);
    default: {
      const kind = (content as { type?: unknown }).type;
      logger.debug({ operation: 'acp_tool_content_unknown', kind }, 'unknown ACP tool content');
      return textBlock(`[unsupported tool content ${String(kind)}]`);
    }
  }
}

// ─── Tool calls ───────────────────────────────────────────────────────────────

/** ACP marks these optional-and-nullable; octomux's `ToolCall` requires both. */
const DEFAULT_TOOL_KIND: ToolKind = 'other';
const DEFAULT_TOOL_STATUS: ToolCallStatus = 'pending';

function acpLocations(
  locations: Array<{ path: string; line?: number | null }> | null | undefined,
): ToolCallLocation[] | undefined {
  if (!locations || locations.length === 0) return undefined;
  return locations.map((loc) =>
    typeof loc.line === 'number' ? { path: loc.path, line: loc.line } : { path: loc.path },
  );
}

/** ACP `ToolCall` → octomux `ToolCall`. `content` is not carried: see below. */
export function normalizeToolCall(call: AcpToolCall): ToolCall {
  const out: ToolCall = {
    toolCallId: call.toolCallId,
    title: call.title,
    kind: call.kind ?? DEFAULT_TOOL_KIND,
    status: call.status ?? DEFAULT_TOOL_STATUS,
  };
  if (call.name) out.toolName = call.name;
  const locations = acpLocations(call.locations);
  if (locations) out.locations = locations;
  if (call.rawInput !== undefined) out.rawInput = call.rawInput;
  return out;
}

/** ACP `ToolCallUpdate` → octomux `ToolCallUpdate`. Null means "unchanged" in ACP. */
export function normalizeToolCallUpdate(update: AcpToolCallUpdate): ToolCallUpdate {
  const out: ToolCallUpdate = { toolCallId: update.toolCallId };
  if (update.status) out.status = update.status;
  if (update.title) out.title = update.title;
  if (update.kind) out.kind = update.kind;
  if (update.content) out.content = update.content.map(acpToolContentToBlock);
  const locations = acpLocations(update.locations);
  if (locations) out.locations = locations;
  if (update.rawOutput !== undefined) out.rawOutput = update.rawOutput;
  return out;
}

// ─── Permissions ──────────────────────────────────────────────────────────────

/**
 * ACP `session/request_permission` params → octomux `PermissionRequest`.
 *
 * ACP has no `requestId` in the payload — the JSON-RPC envelope's id is what the
 * response correlates against — so the caller passes it in. `req.toolCall` is an
 * ACP `ToolCallUpdate` (every field but the id optional), while octomux's
 * `PermissionRequest.toolCall` is a full `ToolCall`, so the missing pieces take
 * the same defaults as a fresh tool call and the title falls back to the id.
 */
export function normalizePermissionRequest(
  params: AcpRequestPermissionRequest,
  requestId: string,
): PermissionRequest {
  const partial = params.toolCall;
  const toolCall: ToolCall = {
    toolCallId: partial.toolCallId,
    title: partial.title ?? partial.toolCallId,
    kind: partial.kind ?? DEFAULT_TOOL_KIND,
    status: partial.status ?? DEFAULT_TOOL_STATUS,
  };
  if (partial.name) toolCall.toolName = partial.name;
  const locations = acpLocations(partial.locations);
  if (locations) toolCall.locations = locations;
  if (partial.rawInput !== undefined) toolCall.rawInput = partial.rawInput;

  const options: PermissionOption[] = params.options.map((opt) => ({
    optionId: opt.optionId,
    name: opt.name,
    kind: opt.kind,
  }));

  return { requestId, toolCall, options };
}

// ─── Session updates ──────────────────────────────────────────────────────────

/**
 * One ACP `session/update` payload → zero, one, or two `AgentEvent`s.
 *
 * Two only for `tool_call`: octomux's `ToolCall` has no content field, so an
 * announcement that already carries output (some engines batch the whole call
 * into one update) is followed by a `tool_update` rather than losing it.
 */
export function normalizeSessionUpdate(
  update: AcpSessionUpdate,
  options: AcpNormalizeOptions = {},
): AgentEvent[] {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return [{ t: 'message', content: acpContentToBlock(update.content), role: 'user' }];

    case 'agent_message_chunk':
      return [{ t: 'message', content: acpContentToBlock(update.content), role: 'assistant' }];

    case 'agent_thought_chunk':
      return [{ t: 'thought', content: acpContentToBlock(update.content) }];

    case 'tool_call': {
      const events: AgentEvent[] = [{ t: 'tool_call', call: normalizeToolCall(update) }];
      const hasContent = !!update.content && update.content.length > 0;
      if (hasContent || update.rawOutput !== undefined) {
        const follow: ToolCallUpdate = { toolCallId: update.toolCallId };
        if (hasContent) follow.content = update.content!.map(acpToolContentToBlock);
        if (update.rawOutput !== undefined) follow.rawOutput = update.rawOutput;
        events.push({ t: 'tool_update', update: follow });
      }
      return events;
    }

    case 'tool_call_update':
      return [{ t: 'tool_update', update: normalizeToolCallUpdate(update) }];

    case 'plan': {
      const plan: Plan = {
        entries: update.entries.map((entry) => ({
          content: entry.content,
          status: entry.status,
          priority: entry.priority,
        })),
      };
      return [{ t: 'plan', plan }];
    }

    default:
      logger.debug(
        {
          operation: 'acp_update_dropped',
          session_id: options.sessionId,
          update_kind: (update as { sessionUpdate?: unknown }).sessionUpdate,
        },
        'ACP session update has no AgentEvent counterpart',
      );
      return [];
  }
}

// ─── Turn boundaries ──────────────────────────────────────────────────────────

/**
 * `session/prompt` response → the events that close a turn.
 *
 * `usage` first when the agent reported it (it is `PromptResponse.usage`, an
 * experimental ACP field, so most engines send nothing), then `done` carrying
 * the ACP stop reason verbatim: `end_turn`, `max_tokens`, `max_turn_requests`,
 * `refusal`, or `cancelled`.
 */
export function normalizePromptResponse(
  response: AcpPromptResponse,
  options: AcpNormalizeOptions = {},
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const usage = response.usage;
  if (usage) {
    const event: Extract<AgentEvent, { t: 'usage' }> = {
      t: 'usage',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      model: options.model ?? UNKNOWN_MODEL,
    };
    if (typeof usage.cachedReadTokens === 'number') {
      event.cacheReadInputTokens = usage.cachedReadTokens;
    }
    if (typeof usage.cachedWriteTokens === 'number') {
      event.cacheCreationInputTokens = usage.cachedWriteTokens;
    }
    events.push(event);
  }
  events.push({ t: 'done', reason: response.stopReason });
  return events;
}

/** `session/new` response → the event that opens a stream. */
export function sessionStartEvent(sessionId: string): AgentEvent {
  return { t: 'session_start', sessionId };
}

/**
 * A failure → `error` then `done`.
 *
 * Always both, and always in that order: `error` carries the message, `done`
 * is what tells every consumer the stream is over. A transport that produced
 * only `error` would leave a `for await` waiting forever.
 */
export function failureEvents(message: string, reason = 'error'): AgentEvent[] {
  return [
    { t: 'error', message },
    { t: 'done', reason },
  ];
}
