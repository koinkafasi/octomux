/**
 * server/harnesses/normalize/claude-code.ts
 *
 * Claude Code (`--output-format stream-json`) → `AgentEvent[]`.
 *
 * The line shapes below were read off the recorded fixture at
 * `server/orchestrator/__fixtures__/transcript-2.1.183-with-compaction.jsonl`
 * (claude 2.1.183), not guessed. `server/orchestrator/transcript.ts` already parses
 * the same stream for the orchestrator chat; this module is the engine-layer
 * counterpart and deliberately agrees with it on every shared decision (which line
 * types carry content, what counts as end-of-turn, how array-form tool results are
 * flattened). It does not replace it — that one feeds the chat UI, this one feeds
 * the cross-engine contract in `../events.ts`.
 *
 * Recognised lines, with what the fixture showed:
 *
 *   type=assistant   `message.content[]` of `text` | `thinking` | `tool_use` blocks,
 *                    plus `message.model` and `message.usage`. Claude Code writes ONE
 *                    line per content block, repeating the same `message.id` and the
 *                    same cumulative `usage` on each — 585 assistant lines carry only
 *                    341 distinct message ids in the fixture — so usage is emitted
 *                    once per message id, never per line.
 *   type=user        `message.content` is either a string (the human's prompt) or an
 *                    array of `tool_result` blocks (`tool_use_id`, `content` as string
 *                    OR array of text blocks, `is_error`).
 *   type=system      `subtype`: `compact_boundary` | `stop_hook_summary` |
 *                    `turn_duration` | `away_summary`. `stop_hook_summary` is the only
 *                    reliable turn-complete signal (same call as `isTurnDone()` in
 *                    orchestrator/transcript.ts) → `done`. `compact_boundary` is
 *                    followed by a synthetic "This session is being continued…" user
 *                    line, which is swallowed.
 *   metadata         `attachment`, `last-prompt`, `mode`, `permission-mode`,
 *                    `ai-title`, `file-history-snapshot`, `queue-operation` — no chat
 *                    content, skipped. They do carry `sessionId`, which is where the
 *                    single `session_start` usually comes from (the fixture's first
 *                    line is a `last-prompt`).
 *
 * Two shapes are handled that the transcript fixture does not contain, because they
 * exist only on the `--output-format stream-json` stdout side and not in the
 * transcript file. Both are parsed defensively (every field optional, no throw):
 *
 *   type=result          the terminal line of a headless run → `usage` + `done`/`error`.
 *   type=control_request `request.subtype === 'can_use_tool'` → `request_permission`.
 *
 * If a future Claude Code version renames either, the worst case is that those two
 * events stop firing; nothing else in the mapping degrades.
 */

import { childLogger } from '../../logger.js';
import {
  LineBuffer,
  textBlock,
  type AgentEvent,
  type ContentBlock,
  type Normalizer,
  type PermissionOption,
  type Plan,
  type PlanEntry,
  type PlanEntryPriority,
  type PlanEntryStatus,
  type ToolCall,
  type ToolCallLocation,
  type ToolKind,
} from '../events.js';

const logger = childLogger('harnesses/normalize/claude-code');

// ─── Tool classification ──────────────────────────────────────────────────────

/**
 * Claude Code's built-in tool names → ACP tool kinds. Unknown names (MCP tools,
 * plugin tools, anything added in a later release) fall through to `other`, which
 * is the correct answer rather than a failure.
 */
const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Glob: 'search',
  Grep: 'search',
  ToolSearch: 'search',
  WebSearch: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  WebFetch: 'fetch',
  ExitPlanMode: 'switch_mode',
};

/** `TodoWrite` is not a tool call in the ACP vocabulary — it is a `plan`. */
const PLAN_TOOL = 'TodoWrite';

export function toolKindFor(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? 'other';
}

// ─── Normalizer ───────────────────────────────────────────────────────────────

export class ClaudeCodeNormalizer implements Normalizer {
  private readonly lines = new LineBuffer();
  private sessionStarted = false;
  /** Message ids whose `usage` has already been emitted (see the header note). */
  private readonly usageSeen = new Set<string>();
  /** Set by `compact_boundary`; swallows the synthetic continuation prompt. */
  private skipNextUserMessage = false;
  /**
   * Tool-use ids that became a `plan` instead of a `tool_call`. Their eventual
   * `tool_result` is dropped too, so no consumer sees an update for a call it was
   * never told about.
   */
  private readonly planToolIds = new Set<string>();

  push(chunk: string): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const line of this.lines.push(chunk)) {
      this.consume(line, out);
    }
    return out;
  }

  flush(): AgentEvent[] {
    const out: AgentEvent[] = [];
    const rest = this.lines.flush();
    if (rest !== null) this.consume(rest, out);
    return out;
  }

  private consume(rawLine: string, out: AgentEvent[]): void {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // A complete line that is not JSON: truncated write, or a stray banner the
      // CLI printed outside the stream. Drop it — never let it kill the run.
      logger.debug({ line: trimmed.slice(0, 120) }, 'unparseable stream-json line');
      return;
    }
    if (typeof obj !== 'object' || obj === null) return;

    this.maybeSessionStart(obj, out);

    switch (str(obj.type)) {
      case 'assistant':
        this.onAssistant(obj, out);
        return;
      case 'user':
        this.onUser(obj, out);
        return;
      case 'system':
        this.onSystem(obj, out);
        return;
      case 'result':
        this.onResult(obj, out);
        return;
      case 'control_request':
        this.onControlRequest(obj, out);
        return;
      default:
        // attachment / last-prompt / mode / permission-mode / ai-title /
        // file-history-snapshot / queue-operation — metadata, no chat content.
        return;
    }
  }

  // ── session_start ──────────────────────────────────────────────────────────

  private maybeSessionStart(obj: Record<string, unknown>, out: AgentEvent[]): void {
    if (this.sessionStarted) return;
    // Transcript lines say `sessionId`; the stream-json envelope says `session_id`.
    const id = str(obj.sessionId) ?? str(obj.session_id);
    if (!id) return;
    this.sessionStarted = true;
    out.push({ t: 'session_start', sessionId: id });
  }

  // ── assistant ──────────────────────────────────────────────────────────────

  private onAssistant(obj: Record<string, unknown>, out: AgentEvent[]): void {
    const msg = rec(obj.message);
    if (!msg) return;

    if (obj.isApiErrorMessage === true) {
      out.push({ t: 'error', message: blocksToText(arr(msg.content)) || 'API error' });
      return;
    }

    for (const raw of arr(msg.content)) {
      const block = rec(raw);
      if (!block) continue;
      switch (str(block.type)) {
        case 'text': {
          const text = str(block.text) ?? '';
          if (text) out.push({ t: 'message', content: textBlock(text), role: 'assistant' });
          break;
        }
        case 'thinking': {
          const text = str(block.thinking) ?? '';
          if (text) out.push({ t: 'thought', content: textBlock(text) });
          break;
        }
        case 'tool_use':
          this.onToolUse(block, out);
          break;
        default:
          break;
      }
    }

    this.emitUsage(msg, out);
  }

  private onToolUse(block: Record<string, unknown>, out: AgentEvent[]): void {
    const toolCallId = str(block.id);
    const toolName = str(block.name) ?? 'unknown';
    if (!toolCallId) return;

    const input = rec(block.input);

    if (toolName === PLAN_TOOL) {
      this.planToolIds.add(toolCallId);
      out.push({ t: 'plan', plan: planFromTodoWrite(input) });
      return;
    }

    const call: ToolCall = {
      toolCallId,
      title: titleFor(toolName, input),
      kind: toolKindFor(toolName),
      status: 'in_progress',
      toolName,
      rawInput: block.input,
    };
    const locations = locationsFor(input);
    if (locations.length > 0) call.locations = locations;
    out.push({ t: 'tool_call', call });
  }

  private emitUsage(msg: Record<string, unknown>, out: AgentEvent[]): void {
    const usage = rec(msg.usage);
    if (!usage) return;
    // Claude Code repeats the same cumulative usage on every content line of a
    // message. Emitting per line would multiply the bill by the block count.
    const id = str(msg.id) ?? '';
    if (id && this.usageSeen.has(id)) return;
    if (id) this.usageSeen.add(id);

    const event: AgentEventUsage = {
      t: 'usage',
      inputTokens: num(usage.input_tokens) ?? 0,
      outputTokens: num(usage.output_tokens) ?? 0,
      model: str(msg.model) ?? 'unknown',
    };
    const cacheRead = num(usage.cache_read_input_tokens);
    if (cacheRead !== undefined) event.cacheReadInputTokens = cacheRead;
    const cacheCreate = num(usage.cache_creation_input_tokens);
    if (cacheCreate !== undefined) event.cacheCreationInputTokens = cacheCreate;
    out.push(event);
  }

  // ── user ───────────────────────────────────────────────────────────────────

  private onUser(obj: Record<string, unknown>, out: AgentEvent[]): void {
    const msg = rec(obj.message);
    if (!msg) return;
    // The compaction marker applies to the very next user line, whatever it turns
    // out to be — consume the flag here so it can never leak onto a later turn.
    const skip = this.skipNextUserMessage;
    this.skipNextUserMessage = false;
    const content = msg.content;

    if (Array.isArray(content)) {
      const results = content.map(rec).filter(isToolResult);
      if (results.length > 0) {
        for (const result of results) this.onToolResult(result, out);
        return;
      }
      this.emitUserText(blocksToText(content), skip, out);
      return;
    }

    if (typeof content === 'string') this.emitUserText(content, skip, out);
  }

  private emitUserText(text: string, skip: boolean, out: AgentEvent[]): void {
    // `skip` marks the post-compaction "This session is being continued…" summary.
    // It replays context the consumer has already seen; it is not a new human turn.
    if (skip || !text) return;
    out.push({ t: 'message', content: textBlock(text), role: 'user' });
  }

  private onToolResult(block: Record<string, unknown>, out: AgentEvent[]): void {
    const toolCallId = str(block.tool_use_id);
    if (!toolCallId) return;
    if (this.planToolIds.has(toolCallId)) return; // its call became a `plan`

    const isError = block.is_error === true;
    const text = toolResultText(block.content);
    const content: ContentBlock[] = text ? [textBlock(text)] : [];
    out.push({
      t: 'tool_update',
      update: {
        toolCallId,
        status: isError ? 'failed' : 'completed',
        content,
        rawOutput: block.content,
      },
    });
  }

  // ── system ─────────────────────────────────────────────────────────────────

  private onSystem(obj: Record<string, unknown>, out: AgentEvent[]): void {
    const subtype = str(obj.subtype) ?? '';
    if (subtype === 'compact_boundary') {
      // Compaction APPENDS (boundary marker + a synthetic user summary); it never
      // rewrites. Swallow the marker and the summary that follows it.
      this.skipNextUserMessage = true;
      return;
    }
    if (subtype === 'stop_hook_summary') {
      out.push({ t: 'done', reason: 'stop_hook_summary' });
      return;
    }
    // turn_duration / away_summary / init and anything new: no chat content.
  }

  // ── result (stream-json terminal line) ─────────────────────────────────────

  private onResult(obj: Record<string, unknown>, out: AgentEvent[]): void {
    const usage = rec(obj.usage);
    if (usage) {
      const event: AgentEventUsage = {
        t: 'usage',
        inputTokens: num(usage.input_tokens) ?? 0,
        outputTokens: num(usage.output_tokens) ?? 0,
        model: str(obj.model) ?? 'unknown',
      };
      const cacheRead = num(usage.cache_read_input_tokens);
      if (cacheRead !== undefined) event.cacheReadInputTokens = cacheRead;
      const cacheCreate = num(usage.cache_creation_input_tokens);
      if (cacheCreate !== undefined) event.cacheCreationInputTokens = cacheCreate;
      out.push(event);
    }

    const subtype = str(obj.subtype) ?? 'result';
    if (obj.is_error === true) {
      out.push({ t: 'error', message: str(obj.result) ?? str(obj.error) ?? subtype });
      return;
    }
    out.push({ t: 'done', reason: subtype });
  }

  // ── control_request (permission prompt) ────────────────────────────────────

  private onControlRequest(obj: Record<string, unknown>, out: AgentEvent[]): void {
    const request = rec(obj.request);
    if (!request || str(request.subtype) !== 'can_use_tool') return;

    const requestId = str(obj.request_id) ?? str(obj.requestId) ?? '';
    const toolName = str(request.tool_name) ?? str(request.toolName) ?? 'unknown';
    const input = rec(request.input);
    const toolCallId = str(request.tool_use_id) ?? str(request.toolCallId) ?? requestId;

    const toolCall: ToolCall = {
      toolCallId,
      title: titleFor(toolName, input),
      kind: toolKindFor(toolName),
      status: 'pending',
      toolName,
      rawInput: request.input,
    };
    const locations = locationsFor(input);
    if (locations.length > 0) toolCall.locations = locations;

    out.push({
      t: 'request_permission',
      req: { requestId, toolCall, options: DEFAULT_PERMISSION_OPTIONS.map((o) => ({ ...o })) },
    });
  }
}

/** Claude Code offers allow/deny per call; `allow_always` maps to its "don't ask again". */
const DEFAULT_PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: "Allow and don't ask again", kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

type AgentEventUsage = Extract<AgentEvent, { t: 'usage' }>;

/** One normalizer per run. */
export function createClaudeCodeNormalizer(): Normalizer {
  return new ClaudeCodeNormalizer();
}

/**
 * Whole-stream convenience wrapper: feed a complete NDJSON blob, get every event.
 * Used by the fixture tests and by any caller that already has the full transcript.
 */
export function normalizeClaudeCodeStream(text: string): AgentEvent[] {
  const n = new ClaudeCodeNormalizer();
  return [...n.push(text), ...n.flush()];
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

/**
 * A human-readable one-liner for a tool call. Bash carries an authored
 * `description`; file tools are best identified by their path; everything else
 * falls back to the tool name.
 */
function titleFor(toolName: string, input: Record<string, unknown> | null): string {
  if (!input) return toolName;
  const description = str(input.description);
  if (description) return description;
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  if (path) return `${toolName}(${path})`;
  const pattern = str(input.pattern);
  if (pattern) return `${toolName}(${pattern})`;
  return toolName;
}

function locationsFor(input: Record<string, unknown> | null): ToolCallLocation[] {
  if (!input) return [];
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (!path) return [];
  const line = num(input.offset);
  return line !== undefined ? [{ path, line }] : [{ path }];
}

const PLAN_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);
const PLAN_PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

/**
 * `TodoWrite` input → `Plan`. Claude Code has shipped several todo shapes
 * (`content`/`activeForm`, with and without `priority`), so every field is read
 * defensively and unknown values fall back to the neutral option.
 */
function planFromTodoWrite(input: Record<string, unknown> | null): Plan {
  const todos = input ? arr(input.todos) : [];
  const entries: PlanEntry[] = [];
  for (const raw of todos) {
    const todo = rec(raw);
    if (!todo) continue;
    const content = str(todo.content) ?? str(todo.activeForm) ?? str(todo.title);
    if (!content) continue;
    const status = str(todo.status) ?? '';
    const priority = str(todo.priority) ?? '';
    entries.push({
      content,
      status: (PLAN_STATUSES.has(status) ? status : 'pending') as PlanEntryStatus,
      priority: (PLAN_PRIORITIES.has(priority) ? priority : 'medium') as PlanEntryPriority,
    });
  }
  return { entries };
}

/** `tool_result.content` is a string in most lines and an array of blocks in some. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return blocksToText(content);
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

function blocksToText(blocks: unknown[]): string {
  return blocks
    .map(rec)
    .filter((b): b is Record<string, unknown> => b !== null && str(b.type) === 'text')
    .map((b) => str(b.text) ?? '')
    .join('');
}

function isToolResult(block: Record<string, unknown> | null): block is Record<string, unknown> {
  return block !== null && str(block.type) === 'tool_result';
}

// ─── Narrow unknown → primitives (keeps `any` out of the module) ──────────────

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
