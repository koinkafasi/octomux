import type { OctomuxSettings } from '../settings.js';

const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Forbidden shell metacharacters: backtick, `;`, `|`, `&`, `>`, `<`, newline,
// and `$(...)` command substitution.
const FLAG_FORBIDDEN_RE = /[`;|&><\n\r]|\$\(/;

/**
 * Validate a custom agent name. Returns the input unchanged if valid;
 * throws with a stable message otherwise. Used at the API boundary AND in
 * harness implementations (defense in depth).
 */
export function validateAgentName(name: string): string {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(`Invalid agent name: ${JSON.stringify(name)}. Must match ${AGENT_NAME_RE}`);
  }
  return name;
}

/**
 * Validate a flag string for shell-injection metacharacters. Reuses the
 * existing rules from `server/settings.ts::validateClaudeFlags` and adds
 * `;`, `|`, `&`, `>`, `<`, `\n`, `\r`.
 */
export function validateFlagString(flags: string, fieldName: string): string {
  if (typeof flags !== 'string') {
    throw new Error(`Invalid ${fieldName}: must be a string`);
  }
  const trimmed = flags.trim();
  if (FLAG_FORBIDDEN_RE.test(trimmed)) {
    throw new Error(
      `Invalid ${fieldName}: contains forbidden shell metacharacter (one of \` ; | & > < $( or newline)`,
    );
  }
  const singleQuotes = (trimmed.match(/'/g) ?? []).length;
  const doubleQuotes = (trimmed.match(/"/g) ?? []).length;
  if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
    throw new Error(`Invalid ${fieldName}: unbalanced quotes`);
  }
  return trimmed;
}

export interface HarnessLaunchOpts {
  sessionId: string;
  agent?: string | null;
  flags?: string;
  /** Per-task model override. When set, replaces any --model in flags. */
  model?: string | null;
  /** Absolute cwd for harnesses where the CLI needs an explicit `--workspace` (Cursor). */
  workspacePath?: string;
}

export interface HarnessResumeOpts {
  sessionId: string;
  flags?: string;
  /** Per-task model override. When set, replaces any --model in flags. */
  model?: string | null;
  workspacePath?: string;
}

/**
 * What a captured tmux pane says about the engine running in it
 * (spec/engine-layer.md §2.1). Generalizes two things that are hardcoded
 * today: Cursor's "Trust this workspace" gate (`postLaunch`) and the
 * never-wired `detectActivity`.
 *
 * - `ready` — the prompt is drawn and accepting input.
 * - `starting` — the process is up but hasn't painted a prompt yet.
 * - `permission_warning` — a modal trust/permission gate is blocking input.
 * - `unknown` — content present, none of the above matched (e.g. mid-turn).
 */
export type ReadyState = 'ready' | 'starting' | 'permission_warning' | 'unknown';

/**
 * Per-engine feature flags (spec/engine-layer.md §2.4, from vibe-kanban's
 * `BaseAgentCapability`). The UI hides features whose flag is false; M2's cost
 * card reads `contextUsage`. Structurally identical to
 * `EnginePresetCapabilities` in `preset-schema.ts` — that is the declarative
 * (tier-1 preset) spelling of the same four flags, this is the code-adapter one.
 */
export interface HarnessCapabilities {
  /** Engine reports its own token usage (feeds M2's cost card). */
  contextUsage: boolean;
  /** Engine supports forking a session (`--fork-session` or equivalent). */
  sessionFork: boolean;
  /** Engine needs an interactive login/setup pass before first use. */
  setupHelper: boolean;
  /** Engine speaks the Agent Client Protocol. */
  acp: boolean;
}

export interface Harness {
  readonly id: string;
  readonly displayName: string;
  readonly sessionIdMode: 'orchestrator-assigned' | 'harness-issued';

  newSessionId(): string;

  /**
   * Repo-root instruction file this engine reads (`CLAUDE.md`, `AGENTS.md`,
   * `.cursor/rules/…`). spec/engine-layer.md §2.1 / §3.
   *
   * Optional only so the partial `Harness` stubs in other suites keep
   * compiling; both core harnesses declare it, and `types.test.ts` asserts
   * that at the type level.
   */
  readonly instructionFile?: string;
  /**
   * Feature flags the UI and the cost card read (spec §2.4). Optional for the
   * same compatibility reason as `instructionFile`; both core harnesses set it.
   */
  readonly capabilities?: HarnessCapabilities;

  // ── invocation: argv is the source of truth ────────────────────────────────
  //
  // `buildLaunchArgv` / `buildResumeArgv` / `buildContinueArgv` describe an
  // invocation as an argv array — no shell involved, so no engine's arguments
  // can be misread as shell syntax (spec §2.1, "argv kararının gerekçesi").
  // The three `*Command` members below are the legacy string spelling of the
  // very same invocation and stay until step 7 of spec §5 rewires
  // `task-engine/launch.ts`, `orchestrator/runner.ts`, `chats.ts` and
  // `agent-session/session.ts` onto argv.

  /** Fresh launch, as argv. Preferred over `buildLaunchCommand`. */
  buildLaunchArgv?(opts: HarnessLaunchOpts): string[];
  /** Resume an existing engine session, as argv. */
  buildResumeArgv?(opts: HarnessResumeOpts): string[];
  /** Continue the last session under a new id, as argv; `null` if unsupported. */
  buildContinueArgv?(opts: HarnessResumeOpts): string[] | null;

  /** Legacy shell-string form of `buildLaunchArgv`. */
  buildLaunchCommand(opts: HarnessLaunchOpts): string;
  /** Legacy shell-string form of `buildResumeArgv`. */
  buildResumeCommand(opts: HarnessResumeOpts): string;
  /** Legacy shell-string form of `buildContinueArgv`. */
  buildContinueCommand(opts: HarnessResumeOpts): string | null;

  /**
   * Classify a captured tmux pane (`tmux capture-pane -p` output). Pure — the
   * caller does the capturing, so this is trivially testable against recorded
   * pane fixtures. Replaces the unwired `detectActivity` and generalizes
   * Cursor's `postLaunch` trust-prompt scan.
   */
  detectReady?(paneContent: string): ReadyState;

  installHooks(worktreePath: string, baseUrl: string, hookToken: string): Promise<void>;
  /**
   * Remove octomux's hook wiring from a directory. Called on teardown for paths
   * octomux does NOT own (run_mode `existing`/`none`), which survive deleteTask
   * — otherwise the config outlives the worker row whose token it carries and
   * every later session in that directory 401s on every hook. Must leave the
   * user's own hooks and permissions intact, and no-op when nothing is there.
   */
  uninstallHooks(dirPath: string): Promise<void>;
  /**
   * Optional post-launch hook called after the launch command is sent to the
   * tmux pane. Used by harnesses with an interactive first-run gate (e.g.
   * Cursor's "Trust this workspace" prompt). Receives the tmux target so the
   * harness can capture and/or send keys.
   *
   * Still wired (`start-task.ts`, `add-agent.ts`, `hop-agent.ts`,
   * `resume-task.ts` all call it), so it is NOT deprecated yet — but the
   * detection half of it now has a pure equivalent in `detectReady`, and the
   * acting half should move to the caller once step 7 of spec §5 lands.
   */
  postLaunch?(target: string): Promise<void>;
  resolveFlags(settings: OctomuxSettings): string;
  validateSettings(blob: unknown): Record<string, unknown>;
  validateAgentName(name: string): string;

  /**
   * Whether this harness supports Claude Code's plugin ecosystem
   * (`--plugin-dir`, marketplaces, skills/agents delivery). Purely
   * descriptive today — nothing reads it yet.
   */
  readonly supportsClaudePlugins?: boolean;
  /**
   * Was going to replace the hardcoded prompt-delivery construction in
   * `task-engine/launch.ts::buildAgentStartupCommand`. Still unwired — no
   * call site reads this member.
   *
   * @deprecated Superseded by `buildLaunchArgv`: prompt delivery is argv
   * (`--append-system-prompt` / `--append-system-prompt-file` and friends),
   * not string surgery on an already-built command. Kept only so existing
   * `Harness` implementations keep compiling; nothing will start reading it.
   */
  buildPromptDelivery?(baseCmd: string, promptFile: string): string;
  /**
   * Was going to replace the hardcoded MCP config wiring in
   * `task-engine/launch.ts::applyOrchestratorMcpConfig`. Still unwired.
   *
   * @deprecated Superseded by the preset's `mcp` block (spec §2.2:
   * `settings_file` | `env` | `flag` | `proxy_flag`) plus `buildLaunchArgv`
   * for the flag case. Building a shell string here was itself the injection
   * surface argv removes.
   */
  attachMcp?(flags: string, worktreePath: string, configPath: string): string;
  /**
   * Was going to replace the harness-specific message-sending path used to
   * talk to a running agent. Still unwired.
   *
   * @deprecated Superseded by the reverse direction of the `AgentEvent`
   * stream (spec §2.3 — `events()` / `send()`), which is transport-typed
   * instead of shelling out with hand-quoted arguments.
   */
  sendMessage?(target: string, text: string): Promise<void>;
  /**
   * Was going to replace the harness-specific idle/active detection
   * hardcoded in the task engine. Still unwired.
   *
   * @deprecated Superseded by `detectReady(paneContent)`, which is pure
   * (no tmux round-trip inside the harness) and distinguishes
   * `starting` / `permission_warning` instead of collapsing both into
   * "active".
   */
  detectActivity?(target: string): Promise<'active' | 'idle'>;
}

/**
 * A first-party (core) harness: `Harness` with every engine-layer member
 * mandatory. The members are optional on `Harness` itself so partial stubs —
 * the ones other suites build, and plugin-supplied payloads — keep compiling
 * while spec/engine-layer.md §5 step 7 is still in flight; `claude-code` and
 * `cursor` are annotated with this type instead, so dropping one of them from
 * either harness is a compile error rather than a silent capability gap.
 */
export type CoreHarness = Harness &
  Required<
    Pick<
      Harness,
      | 'instructionFile'
      | 'capabilities'
      | 'buildLaunchArgv'
      | 'buildResumeArgv'
      | 'buildContinueArgv'
      | 'detectReady'
    >
  >;
