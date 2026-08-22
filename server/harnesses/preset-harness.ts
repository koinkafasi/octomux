/**
 * Adapter: declarative tier-1 engine preset → live `Harness`
 * (spec/engine-layer.md §2.2, delivery step 6).
 *
 * `preset-loader.ts` turns `server/harnesses/presets/*.json` into validated
 * `EnginePreset` records. Nothing read them until this module: the registry
 * only ever held the two tier-2 code adapters, so `GET /api/harnesses`
 * answered with two engines while nine more sat on disk. `createHarnessFromPreset`
 * closes that gap by projecting a preset onto the `Harness` interface, and
 * `index.ts` registers one per preset at boot.
 *
 * What a preset can and cannot express:
 *
 * - **argv is the whole invocation.** `command` + `args` + the resolved flags
 *   string (tokenized by `shellSplitFlags`) is all there is. The `*Command`
 *   members are `argvToCommand()` renderings of that same argv, so every token
 *   is shell-quoted exactly once and nothing a preset or a settings blob
 *   carries can be reread as shell syntax.
 * - **No hooks.** Every shipped preset has `hooks.provider: null`; there is no
 *   hook system octomux knows how to install into for these engines, so
 *   `installHooks`/`uninstallHooks` are deliberate no-ops. That means no
 *   permission prompts, no stop events and no token accounting from a tier-1
 *   engine today — spec §2.3's `AgentEvent` stream is how that arrives later,
 *   not this file.
 * - **Sessions are harness-issued.** No preset field describes a
 *   "start with this session id" flag, so octomux cannot assign one;
 *   `sessionIdMode` is always `harness-issued` and `newSessionId()` exists only
 *   to give the worker row a local correlation id.
 */

import crypto from 'crypto';
import type { EnginePreset } from './preset-schema.js';
import type {
  Harness,
  HarnessCapabilities,
  HarnessLaunchOpts,
  HarnessResumeOpts,
  ReadyState,
} from './types.js';
import { validateAgentName, validateFlagString } from './types.js';
import {
  applyModelArgv,
  argvToCommand,
  formatHarnessFlags,
  shellSplitFlags,
  validateSettingsObject,
} from './shared.js';
import { childLogger } from '../logger.js';
import type { OctomuxSettings } from '../settings.js';

const logger = childLogger('harnesses/preset-harness');

/**
 * Box-drawing glyphs a TUI paints around its input line. Stripped before the
 * ready-prompt prefix is matched, same as `claude-code.ts` / `cursor.ts` do.
 */
const BOX_GLYPHS_RE = /[│┃┆┇┊┋╎|]/g;

/**
 * Generic "a modal gate is waiting on a keypress" shape, used only for presets
 * that opt in via `emitsPermissionWarning`. Kept deliberately narrow: a preset
 * that has NOT opted in never runs this regex, so a false positive can only
 * affect an engine whose author asserted it prints such a banner.
 */
const PRESET_PERMISSION_WARNING_RE =
  /do you (?:want to )?(?:trust|proceed|allow|continue)|trust (?:this|the) (?:workspace|folder|authors)|press enter to (?:continue|accept)|\[y\/n\]|\(y\/n\)/i;

/**
 * Append the resolved flags (and the per-task model override) to an argv head.
 *
 * Deliberately *not* `composeArgv()`: that helper applies `applyModelArgv` to
 * the flags tokens alone, which is right for the two core harnesses because
 * their heads are octomux-built and carry no `--model`. A preset's `args` is
 * author-supplied data, so a preset that ships `--model <id>` would otherwise
 * emit it twice when a task overrides the model. Here the strip runs across
 * `args` + flags together, so the per-task model always wins outright.
 */
function withFlags(
  command: string,
  rest: string[],
  flags: string | undefined,
  model: string | null | undefined,
): string[] {
  return [command, ...applyModelArgv([...rest, ...shellSplitFlags(flags ?? '')], model)];
}

/**
 * argv head for a resume/continue invocation, honouring `resumeStyle`:
 *
 * - `flag` — the token is an option, so it follows the always-on args:
 *   `gemini --approval-mode yolo --resume <id>`.
 * - `subcommand` — the token is a verb and must come first, before any option:
 *   `codex resume <id> --full-auto`.
 */
function resumeHead(preset: EnginePreset, token: string, sessionId?: string): string[] {
  const idArgs = sessionId === undefined ? [] : [sessionId];
  return preset.resumeStyle === 'subcommand'
    ? [token, ...idArgs, ...preset.args]
    : [...preset.args, token, ...idArgs];
}

/** `EnginePresetCapabilities` and `HarnessCapabilities` are the same four flags. */
function toHarnessCapabilities(preset: EnginePreset): HarnessCapabilities {
  return {
    contextUsage: preset.capabilities.contextUsage,
    sessionFork: preset.capabilities.sessionFork,
    setupHelper: preset.capabilities.setupHelper,
    acp: preset.capabilities.acp,
  };
}

/**
 * Classify a captured pane using only what the preset declares.
 *
 * An engine that declares neither a `readyPromptPrefix` nor
 * `emitsPermissionWarning` has no signal to read, so every non-empty pane is
 * `unknown` — honest, and better than guessing with a cross-engine prompt
 * regex. An *empty* pane is `starting` regardless of engine: nothing has been
 * painted yet, which is not engine-specific knowledge.
 */
function detectReadyFromPreset(preset: EnginePreset, paneContent: string): ReadyState {
  if (!paneContent.trim()) return 'starting';

  if (preset.emitsPermissionWarning && PRESET_PERMISSION_WARNING_RE.test(paneContent)) {
    return 'permission_warning';
  }

  const prefix = preset.readyPromptPrefix;
  if (prefix) {
    // `tmux capture-pane -p` strips trailing spaces, so a bare `> ` prompt
    // arrives as `>`. Match both the raw prefix and its trimmed form.
    const trimmedPrefix = prefix.trimEnd();
    const ready = paneContent
      .split('\n')
      .map((line) => line.replace(BOX_GLYPHS_RE, ' ').trimStart())
      .some((line) => line.startsWith(prefix) || line.trimEnd() === trimmedPrefix);
    if (ready) return 'ready';
  }

  return 'unknown';
}

/**
 * Project one validated preset onto the `Harness` interface.
 *
 * Pure: the returned object closes over `preset` and touches no module state,
 * so a caller can build a harness from a preset that was never registered
 * (which is exactly what the tests do).
 */
export function createHarnessFromPreset(preset: EnginePreset): Harness {
  const settingsLabel = `harnesses.${preset.id}.flags`;

  const buildLaunchArgv = ({ flags, model }: HarnessLaunchOpts): string[] =>
    // `agent` is ignored on purpose: no preset field describes a subagent flag,
    // so there is nothing to render it into. The API boundary still validates
    // the name (see `validateAgentName` below).
    withFlags(preset.command, preset.args, flags, model);

  const buildResumeArgv = ({ sessionId, flags, model }: HarnessResumeOpts): string[] => {
    if (!preset.resumeFlag) {
      throw new Error(
        `Harness "${preset.id}" does not support resuming a session (preset declares no resumeFlag)`,
      );
    }
    return withFlags(
      preset.command,
      resumeHead(preset, preset.resumeFlag, sessionId),
      flags,
      model,
    );
  };

  const buildContinueArgv = ({ flags, model }: HarnessResumeOpts): string[] | null => {
    if (!preset.continueFlag) return null;
    return withFlags(preset.command, resumeHead(preset, preset.continueFlag), flags, model);
  };

  return {
    id: preset.id,
    displayName: preset.displayName,
    // A preset has no "launch with this session id" flag, so octomux can never
    // assign one for a tier-1 engine.
    sessionIdMode: 'harness-issued',

    newSessionId(): string {
      return crypto.randomUUID();
    },

    instructionFile: preset.instructionFile,
    capabilities: toHarnessCapabilities(preset),

    buildLaunchArgv,
    buildResumeArgv,
    buildContinueArgv,

    // The string spellings are renderings of the argv above — the whole argv,
    // flags included, goes through `argvToCommand`. (The two core harnesses
    // append their resolved flags verbatim instead, to preserve pre-argv
    // behaviour they already shipped; a preset engine has no such history.)
    buildLaunchCommand(opts: HarnessLaunchOpts): string {
      return argvToCommand(buildLaunchArgv(opts));
    },

    buildResumeCommand(opts: HarnessResumeOpts): string {
      return argvToCommand(buildResumeArgv(opts));
    },

    buildContinueCommand(opts: HarnessResumeOpts): string | null {
      const argv = buildContinueArgv(opts);
      return argv === null ? null : argvToCommand(argv);
    },

    detectReady(paneContent: string): ReadyState {
      return detectReadyFromPreset(preset, paneContent);
    },

    /**
     * No-op: every shipped preset declares `hooks.provider: null`, meaning the
     * engine has no hook system octomux can install callbacks into. Writing
     * nothing is the correct behaviour, not a stub — there is no config file
     * to merge into and no event to subscribe to.
     *
     * A preset that names a provider is warned about once per call and still
     * no-ops: no provider implementation exists yet, and silently pretending to
     * install hooks would be worse than saying so in the log.
     */
    async installHooks(): Promise<void> {
      if (preset.hooks.provider) {
        logger.warn(
          { harness_id: preset.id, provider: preset.hooks.provider },
          'preset declares a hook provider octomux cannot install — skipping hook setup',
        );
      }
    },

    /** No-op for the same reason `installHooks` is: nothing was ever written. */
    async uninstallHooks(): Promise<void> {},

    /**
     * Tier-1 engines carry exactly one setting: a free-form flags string,
     * validated for shell metacharacters the same way the core harnesses
     * validate theirs.
     */
    resolveFlags(settings: OctomuxSettings): string {
      const sub = (settings.harnesses?.[preset.id] ?? {}) as { flags?: string };
      const parts: string[] = [];
      if (sub.flags) parts.push(validateFlagString(sub.flags, settingsLabel));
      return formatHarnessFlags(parts);
    },

    validateSettings(blob: unknown): Record<string, unknown> {
      return validateSettingsObject(
        blob,
        preset.id,
        { flags: (value) => validateFlagString(value as string, settingsLabel) },
        { rejectUnknownKeys: true },
      );
    },

    validateAgentName(name: string): string {
      return validateAgentName(name);
    },

    // Claude Code's plugin ecosystem (`--plugin-dir`, marketplaces) is
    // claude-code-only; no tier-1 engine reads it.
    supportsClaudePlugins: false,
  };
}
