import fs from 'fs';
import type { HarnessLaunchOpts, HarnessResumeOpts } from './types.js';
import { validateAgentName } from './types.js';
import { shellQuoteSingle } from '../shell-quote.js';

/** Canonical JSON settings/config serialization (trailing newline). */
export function formatJsonConfig(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n';
}

/** Write a JSON config file using the canonical harness serialization format. */
export function writeJsonConfig(
  filePath: string,
  obj: unknown,
  options?: fs.WriteFileOptions,
): void {
  fs.writeFileSync(filePath, formatJsonConfig(obj), options);
}

/** Join validated flag tokens with a leading space, or return '' when empty. */
export function formatHarnessFlags(parts: string[]): string {
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** Strip any existing --model <value> from a flags string, then append --model <model>. */
export function applyModel(flags: string, model: string | null | undefined): string {
  if (!model) return flags;
  const stripped = flags.replace(/\s*--model\s+\S+/g, '');
  return `${stripped} --model ${shellQuoteSingle(model)}`;
}

// ─── argv ⇄ shell string ─────────────────────────────────────────────────────
//
// argv is the source of truth for an invocation's *shape* (spec/engine-layer.md
// §2.1). The string builders below stay only because `task-engine/launch.ts`,
// `orchestrator/runner.ts`, `chats.ts` and `agent-session/session.ts` still hand
// a shell string to tmux; they are thin renderers over the same argv head.

/**
 * POSIX-portable "needs no quoting" character set (the one `shlex.quote` uses).
 * A token built only from these survives a shell round-trip byte-for-byte, so
 * quoting it would be noise; anything else — spaces, `$`, `~`, `*`, quotes,
 * metacharacters, the empty string — gets single-quoted.
 */
const SHELL_SAFE_TOKEN_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Single-quote one argv token unless it is already shell-inert. */
export function shellQuoteIfNeeded(token: string): string {
  return SHELL_SAFE_TOKEN_RE.test(token) ? token : shellQuoteSingle(token);
}

/**
 * Render an argv array as a shell command string. Every token that isn't
 * shell-inert is single-quoted, so no argv value can break out into the
 * command line — this is the property `buildLaunchCommand` inherits by being
 * a wrapper over `buildLaunchArgv`'s head.
 */
export function argvToCommand(argv: string[]): string {
  return argv.map(shellQuoteIfNeeded).join(' ');
}

/**
 * Split a resolved flags *string* into argv tokens, honouring single quotes,
 * double quotes and backslash escapes the way a POSIX shell does.
 *
 * Flags reach a harness as a string (`resolveFlags(settings): string`, plus the
 * orchestrator's `--append-system-prompt '<prompt>'`), so the argv path has to
 * undo that quoting exactly once. Unterminated quotes are tolerated — the
 * remainder becomes the final token — because this must never throw on a value
 * `validateFlagString` already accepted.
 */
export function shellSplitFlags(flags: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let i = 0;

  while (i < flags.length) {
    const c = flags[i];
    if (c === "'") {
      started = true;
      i++;
      while (i < flags.length && flags[i] !== "'") current += flags[i++];
      i++; // closing quote (or end of input)
    } else if (c === '"') {
      started = true;
      i++;
      while (i < flags.length && flags[i] !== '"') {
        if (flags[i] === '\\' && i + 1 < flags.length && '"\\$`'.includes(flags[i + 1])) {
          current += flags[i + 1];
          i += 2;
        } else {
          current += flags[i++];
        }
      }
      i++;
    } else if (c === '\\') {
      if (i + 1 < flags.length) {
        started = true;
        current += flags[i + 1];
        i += 2;
      } else {
        i++;
      }
    } else if (/\s/.test(c)) {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
      i++;
    } else {
      started = true;
      current += c;
      i++;
    }
  }
  if (started) out.push(current);
  return out;
}

/**
 * argv twin of `applyModel`: drop every `--model <value>` pair, then append the
 * per-task model. No quoting is involved — that is the point of argv.
 */
export function applyModelArgv(argv: string[], model: string | null | undefined): string[] {
  if (!model) return argv;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') {
      i++; // skip the value too
      continue;
    }
    out.push(argv[i]);
  }
  out.push('--model', model);
  return out;
}

export type SettingsFieldValidator = (value: unknown) => unknown;

export interface ValidateSettingsObjectOptions {
  /** When true, reject keys not listed in `fields`. */
  rejectUnknownKeys?: boolean;
}

/**
 * Validate a harness settings sub-object. Only keys present on the input blob
 * are validated and copied to the output; absent keys are omitted.
 */
export function validateSettingsObject(
  blob: unknown,
  harnessLabel: string,
  fields: Record<string, SettingsFieldValidator>,
  options?: ValidateSettingsObjectOptions,
): Record<string, unknown> {
  if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
    throw new Error(`Invalid ${harnessLabel} settings: expected object`);
  }
  const obj = blob as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (options?.rejectUnknownKeys) {
    const allowed = new Set(Object.keys(fields));
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        throw new Error(`Invalid ${harnessLabel} settings: unknown key "${key}"`);
      }
    }
  }

  for (const [key, validator] of Object.entries(fields)) {
    if (obj[key] !== undefined) {
      const validated = validator(obj[key]);
      if (validated !== undefined) {
        out[key] = validated;
      }
    }
  }
  return out;
}

/** Normalize resolved flags to a single leading-space-separated string (or ''),
 *  so callers can't accidentally glue flags onto the preceding token (e.g. the
 *  session id) by passing flags without/with-stray leading whitespace. */
export function flagsSuffix(flags: string, model?: string | null): string {
  const resolved = applyModel(flags, model).trim();
  return resolved ? ` ${resolved}` : '';
}

/**
 * Compose a full argv from a harness-specific head (binary + octomux-owned
 * flags) and the resolved flags string.
 */
export function composeArgv(
  head: string[],
  flags: string | undefined,
  model?: string | null,
): string[] {
  return [...head, ...applyModelArgv(shellSplitFlags(flags ?? ''), model)];
}

/**
 * Compose the legacy shell-string form of the same invocation: the head is
 * rendered through `argvToCommand` (so every octomux-supplied value is quoted
 * when it needs to be), and the resolved flags string is appended verbatim.
 *
 * The flags blob is NOT re-quoted on purpose: it is *already* shell text —
 * `resolveFlags()` and the orchestrator emit pre-quoted arguments such as
 * `--append-system-prompt '<prompt>'` — so splitting and re-quoting it would
 * only risk changing a value that is already correct. The argv path
 * (`composeArgv`) is where that string gets tokenized.
 */
export function composeCommand(
  head: string[],
  flags: string | undefined,
  model?: string | null,
): string {
  return argvToCommand(head) + flagsSuffix(flags ?? '', model);
}

// ─── Claude Code invocation shapes ───────────────────────────────────────────

/** argv before the resolved flags: `claude [--agent X] --session-id <id>`. */
function claudeLaunchHead({ sessionId, agent }: HarnessLaunchOpts): string[] {
  const head = ['claude'];
  if (agent) head.push('--agent', validateAgentName(agent));
  head.push('--session-id', sessionId);
  return head;
}

function claudeResumeHead({ sessionId }: HarnessResumeOpts): string[] {
  return ['claude', '--resume', sessionId];
}

function claudeContinueHead({ sessionId }: HarnessResumeOpts): string[] {
  return ['claude', '--continue', '--session-id', sessionId];
}

export function buildClaudeLaunchArgv(opts: HarnessLaunchOpts): string[] {
  return composeArgv(claudeLaunchHead(opts), opts.flags, opts.model);
}

export function buildClaudeResumeArgv(opts: HarnessResumeOpts): string[] {
  return composeArgv(claudeResumeHead(opts), opts.flags, opts.model);
}

export function buildClaudeContinueArgv(opts: HarnessResumeOpts): string[] {
  return composeArgv(claudeContinueHead(opts), opts.flags, opts.model);
}

export function buildClaudeLaunchCommand(opts: HarnessLaunchOpts): string {
  return composeCommand(claudeLaunchHead(opts), opts.flags, opts.model);
}

export function buildClaudeResumeCommand(opts: HarnessResumeOpts): string {
  return composeCommand(claudeResumeHead(opts), opts.flags, opts.model);
}

export function buildClaudeContinueCommand(opts: HarnessResumeOpts): string {
  return composeCommand(claudeContinueHead(opts), opts.flags, opts.model);
}
