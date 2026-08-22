/**
 * server/harnesses/events.ts
 *
 * The cross-engine event contract (spec/engine-layer.md §2.3).
 *
 * octomux is growing from two harnesses to twelve. Every engine prints something
 * different — Claude Code speaks NDJSON, codex speaks JSON-RPC, several speak ACP,
 * and a few speak nothing but ANSI-coloured prose. `AgentEvent` is the single
 * shape everything is funnelled into before it reaches the DB, the websocket, or
 * the UI, so that (for example) `request_permission` no longer depends on
 * Claude-Code-specific hooks and `usage` can feed M2's token/cost card from any
 * engine that reports it.
 *
 * The vocabulary is lifted from the Agent Client Protocol (`@agentclientprotocol/sdk`
 * v1.4.0 — referenced for type SHAPE only; the package is not a dependency). Only
 * the slice these ten events need is modelled here: ACP's full session-update union,
 * its capability negotiation, and its JSON-RPC envelope are deliberately absent.
 *
 * Engines that already speak ACP can produce these directly. Everything else goes
 * through a `Normalizer` in `./normalize/`.
 */

// ─── Event kinds ──────────────────────────────────────────────────────────────

/**
 * Every discriminant of `AgentEvent`, as a value. Exported so consumers can build
 * exhaustive lookup tables (UI renderers, DB writers) and so tests can assert the
 * union has not silently grown or shrunk.
 */
export const AGENT_EVENT_KINDS = [
  'session_start',
  'message',
  'thought',
  'tool_call',
  'tool_update',
  'plan',
  'request_permission',
  'usage',
  'error',
  'done',
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

// ─── Content blocks ───────────────────────────────────────────────────────────

/** Plain UTF-8 text — by far the common case. */
export interface TextContent {
  type: 'text';
  text: string;
}

/** An inline image, base64-encoded (ACP `ImageContent`). */
export interface ImageContent {
  type: 'image';
  /** e.g. `image/png` */
  mimeType: string;
  /** base64 payload */
  data: string;
}

/** A pointer to something on disk or on the network (ACP `ResourceLink`). */
export interface ResourceLinkContent {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
}

export type ContentBlock = TextContent | ImageContent | ResourceLinkContent;

/** Convenience constructor — the overwhelming majority of blocks are text. */
export function textBlock(text: string): TextContent {
  return { type: 'text', text };
}

// ─── Tool calls ───────────────────────────────────────────────────────────────

/**
 * Coarse classification of what a tool does, so the UI can pick an icon and a
 * colour without knowing every engine's tool names. Mirrors ACP's `ToolKind`.
 */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** A file (and optionally a line) a tool touched — drives "jump to source" in the UI. */
export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface ToolCall {
  /** Engine-issued id; `tool_update` events refer back to it. */
  toolCallId: string;
  /** Human-readable one-liner, e.g. the Bash `description` or the tool name. */
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  /**
   * Engine-native tool name (`Bash`, `Read`, …). Not part of ACP's `ToolCall`, but
   * octomux keeps it: the review/diff surfaces key off the real name, and `kind`
   * alone is lossy.
   */
  toolName?: string;
  locations?: ToolCallLocation[];
  /** The tool input exactly as the engine reported it. */
  rawInput?: unknown;
}

/**
 * A partial update to a previously announced `ToolCall`. Every field except the id
 * is optional — an engine may report only a status flip, only output, or both.
 */
export interface ToolCallUpdate {
  toolCallId: string;
  status?: ToolCallStatus;
  title?: string;
  kind?: ToolKind;
  /** Tool output rendered as content blocks. */
  content?: ContentBlock[];
  locations?: ToolCallLocation[];
  /** The tool result exactly as the engine reported it. */
  rawOutput?: unknown;
}

// ─── Plans ────────────────────────────────────────────────────────────────────

export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';
export type PlanEntryPriority = 'high' | 'medium' | 'low';

export interface PlanEntry {
  content: string;
  status: PlanEntryStatus;
  priority: PlanEntryPriority;
}

/**
 * The agent's current task list. Engines re-send the whole plan on every change
 * (ACP semantics), so a consumer replaces rather than merges.
 */
export interface Plan {
  entries: PlanEntry[];
}

// ─── Permission requests ──────────────────────────────────────────────────────

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

/**
 * The engine is asking the human to approve a tool call. This is the one path into
 * the `permission_prompts` table — today Claude Code's hooks fill it, tomorrow every
 * engine funnels through here.
 */
export interface PermissionRequest {
  /** Correlates the eventual approve/deny response back to the engine. */
  requestId: string;
  toolCall: ToolCall;
  options: PermissionOption[];
}

// ─── The union ────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { t: 'session_start'; sessionId: string }
  /**
   * A chunk of conversation. `role` defaults to the agent when absent; normalizers
   * that can distinguish the human's turn (Claude Code's transcript can) set it.
   */
  | { t: 'message'; content: ContentBlock; role?: 'assistant' | 'user' }
  /** Extended-thinking / reasoning output, kept separate so the UI can fold it away. */
  | { t: 'thought'; content: ContentBlock }
  | { t: 'tool_call'; call: ToolCall }
  | { t: 'tool_update'; update: ToolCallUpdate }
  | { t: 'plan'; plan: Plan }
  | { t: 'request_permission'; req: PermissionRequest }
  | {
      t: 'usage';
      inputTokens: number;
      outputTokens: number;
      model: string;
      /** Anthropic-style cache accounting; omitted by engines that do not report it. */
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  | { t: 'error'; message: string }
  | { t: 'done'; reason: string };

/** Narrow an `AgentEvent` to one variant, e.g. `AgentEventOf<'usage'>`. */
export type AgentEventOf<K extends AgentEventKind> = Extract<AgentEvent, { t: K }>;

// ─── Runtime guard ────────────────────────────────────────────────────────────

const KIND_SET: ReadonlySet<string> = new Set<string>(AGENT_EVENT_KINDS);

/** The one field each variant cannot be missing, used by the shallow guard below. */
const REQUIRED_FIELD: Record<AgentEventKind, string> = {
  session_start: 'sessionId',
  message: 'content',
  thought: 'content',
  tool_call: 'call',
  tool_update: 'update',
  plan: 'plan',
  request_permission: 'req',
  usage: 'model',
  error: 'message',
  done: 'reason',
};

/**
 * Shallow structural check — the discriminant is known and its payload field is
 * present. Deliberately not a deep validator: this exists to reject foreign objects
 * at a boundary (a plugin harness handing octomux something it made up), not to
 * re-typecheck what the compiler already proved.
 */
export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  const t = rec.t;
  if (typeof t !== 'string' || !KIND_SET.has(t)) return false;
  return REQUIRED_FIELD[t as AgentEventKind] in rec;
}

// ─── Normalizer ───────────────────────────────────────────────────────────────

/**
 * Turns one engine's raw stdout into `AgentEvent`s.
 *
 * Stateful on purpose: chunks arrive on arbitrary byte boundaries (a JSON object
 * can be split mid-string), and several mappings need memory across lines — token
 * usage is repeated on every content line of the same message and must be emitted
 * once, and Claude Code's compaction marker means "swallow the next user line".
 *
 * Contract:
 *  - `push(chunk)` returns the events completed by that chunk, in stream order.
 *    It never blocks and never throws on malformed input; unparseable lines are
 *    dropped (and logged at debug).
 *  - `flush()` returns whatever a trailing, newline-less remainder yields and
 *    clears internal buffers. Call it once, when the process exits.
 *  - One instance per engine run. Instances are not reusable across runs.
 */
export interface Normalizer {
  push(chunk: string): AgentEvent[];
  flush(): AgentEvent[];
}

/**
 * Splits an arbitrarily-chunked byte stream into complete lines, holding back the
 * trailing partial one. Shared by every line-oriented normalizer.
 */
export class LineBuffer {
  private buf = '';

  /** Feed a chunk; get back the lines it completed (CRLF normalised, `\n` stripped). */
  push(chunk: string): string[] {
    this.buf += chunk;
    if (!this.buf.includes('\n')) return [];
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map(stripCr);
  }

  /** Take the held-back remainder (if any) and reset. */
  flush(): string | null {
    const rest = this.buf;
    this.buf = '';
    return rest.length > 0 ? stripCr(rest) : null;
  }

  /** The bytes currently held back because no newline has arrived yet. */
  get pending(): string {
    return this.buf;
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
