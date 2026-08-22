/**
 * Declarative engine-preset schema (spec/engine-layer.md §2.2).
 *
 * octomux targets 12 coding CLIs. Most of them differ only in *data* — the
 * binary name, a couple of "yes, really, do it" flags, how a session is
 * resumed, where MCP config gets injected. Those are tier-1 engines: one JSON
 * file under `server/harnesses/presets/`, no TypeScript. Only the engines whose
 * behaviour doesn't fit the shape below (claude-code's hook path and
 * stream-json protocol, codex's JSON-RPC) get a tier-2 code adapter in
 * `server/harnesses/<id>.ts`.
 *
 * The idiom is the one `kinds/*.json` + `server/workflows/presets.ts` already
 * established for schedule kinds: an ajv-validated JSON file, defaults
 * materialized at load time, a malformed file warned-and-skipped rather than a
 * boot crash.
 *
 * This module owns the schema, the derived types, and the shell-safety rules.
 * `preset-loader.ts` owns reading the directory.
 */

import Ajv, { type ValidateFunction } from 'ajv';

/** Preset ids (and therefore filename stems) are bare kebab-case identifiers. */
export const ENGINE_PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Forbidden shell metacharacters: backtick, `;`, `|`, `&`, `>`, `<`, newline,
 * and `$(...)` command substitution.
 *
 * Deliberately identical to `FLAG_FORBIDDEN_RE` in `server/harnesses/types.ts`
 * (which backs `validateFlagString`). It is restated here rather than imported
 * so that the preset layer — data validated at load time — carries no
 * dependency on the `Harness` interface module, which is being reshaped by
 * spec/engine-layer.md §2.1. If one of the two sets ever changes, change both:
 * a preset string and a settings-supplied flag string end up on the same
 * command line.
 */
export const PRESET_FORBIDDEN_RE = /[`;|&><\n\r]|\$\(/;

/** Environment variable names accepted in a preset's `env` block. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type McpInject = 'settings_file' | 'env' | 'flag' | 'proxy_flag';
export type McpTransport = 'stdio' | 'sse' | 'http';
export type AcpMode = 'native' | 'subcommand' | 'flag';
export type ResumeStyle = 'flag' | 'subcommand';

/** How an engine is told about octomux's MCP server. Taxonomy from agentchattr. */
export interface EnginePresetMcp {
  /** `null` = this engine has no MCP wiring octomux knows how to drive. */
  inject: McpInject | null;
  /** `settings_file` only: worktree-relative JSON file to merge the server into. */
  settingsPath: string | null;
  /** `env` only: variable carrying the server URL/config. */
  envVar: string | null;
  /** `flag` / `proxy_flag` only: the CLI flag that takes the config path. */
  flag: string | null;
  transport: McpTransport | null;
}

/**
 * Agent Client Protocol wiring (Gas Town `ACPConfig`). `null` on the preset
 * means the engine doesn't speak ACP at all.
 *
 * - `native` — a separate ACP binary; `args` is the full argv, `args[0]` being
 *   that binary.
 * - `subcommand` — the engine's own binary plus a subcommand (`opencode acp`).
 * - `flag` — the engine's own binary plus a flag (`gemini --acp`).
 */
export interface EnginePresetAcp {
  mode: AcpMode;
  args: string[];
}

/** vibe-kanban's `BaseAgentCapability`, as read by the UI (spec §2.4). */
export interface EnginePresetCapabilities {
  /** Engine reports its own token usage (feeds M2's cost card). */
  contextUsage: boolean;
  /** Engine supports forking a session (`--fork-session` or equivalent). */
  sessionFork: boolean;
  /** Engine needs an interactive login/setup pass before first use. */
  setupHelper: boolean;
  /** Engine speaks ACP. Should agree with `acp !== null`. */
  acp: boolean;
}

/**
 * A fully materialized preset — what `loadEnginePresets()` hands back, with
 * every default already applied. The raw JSON file may omit everything except
 * `id`, `displayName`, and `command`.
 */
export interface EnginePreset {
  id: string;
  displayName: string;
  /** Executable name or absolute path. Never a shell string. */
  command: string;
  /** Always-on argv appended after `command` (e.g. `["--yolo"]`). */
  args: string[];
  /** Extra environment for the engine process. */
  env: Record<string, string>;
  /**
   * Process names to match against tmux's `pane_current_command` for liveness
   * detection. Engines that shell out through a launcher need both names
   * (e.g. `["gemini", "node"]`).
   */
  processNames: string[];
  /** `--resume`, `--continue-session`, … `null` when resume isn't supported. */
  resumeFlag: string | null;
  /** `flag` → `gemini --resume <id>`; `subcommand` → `codex resume <id>`. */
  resumeStyle: ResumeStyle;
  /** Flag that resumes the most recent session with no id. `null` if absent. */
  continueFlag: string | null;
  /** Repo-root instruction file this engine reads: `CLAUDE.md`, `AGENTS.md`, … */
  instructionFile: string;
  /** Pane prefix that means "prompt is idle and accepting input". */
  readyPromptPrefix: string | null;
  /** Grace period after launch before the pane is polled for readiness. */
  readyDelayMs: number;
  /** Engine prints a permission banner that must not be mistaken for output. */
  emitsPermissionWarning: boolean;
  /**
   * Escape cancels the in-flight request on this engine, so message injection
   * must NOT send Escape first (spec §2.2 — this closes a real trap: on the
   * engines where it's true, the "clear the input line" Escape aborts the
   * generation instead).
   */
  escapeCancelsRequest: boolean;
  /** Engine emits a drain/flush burst at each turn boundary. */
  hasTurnBoundaryDrain: boolean;
  /** `provider: null` = no hook system octomux can install into. */
  hooks: { provider: string | null };
  mcp: EnginePresetMcp | null;
  acp: EnginePresetAcp | null;
  capabilities: EnginePresetCapabilities;
}

/** The subset a preset file must declare; everything else is defaulted. */
export type EnginePresetInput = Pick<EnginePreset, 'id' | 'displayName' | 'command'> &
  Partial<Omit<EnginePreset, 'id' | 'displayName' | 'command'>>;

const stringArray = { type: 'array', items: { type: 'string' } } as const;

/**
 * ajv JSON Schema for one preset file.
 *
 * `additionalProperties: false` throughout: a typo'd field in a preset is a
 * silent behaviour change otherwise, and the loader's warn-and-skip policy only
 * helps if the schema actually notices.
 */
export const ENGINE_PRESET_SCHEMA = {
  type: 'object',
  required: ['id', 'displayName', 'command'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: ENGINE_PRESET_ID_RE.source },
    displayName: { type: 'string', minLength: 1 },
    command: { type: 'string', minLength: 1 },
    args: { ...stringArray, default: [] },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      propertyNames: { pattern: ENV_NAME_RE.source },
      default: {},
    },
    processNames: { ...stringArray, default: [] },
    resumeFlag: { type: ['string', 'null'], default: null },
    resumeStyle: { type: 'string', enum: ['flag', 'subcommand'], default: 'flag' },
    continueFlag: { type: ['string', 'null'], default: null },
    instructionFile: { type: 'string', minLength: 1, default: 'AGENTS.md' },
    readyPromptPrefix: { type: ['string', 'null'], default: null },
    readyDelayMs: { type: 'integer', minimum: 0, default: 0 },
    emitsPermissionWarning: { type: 'boolean', default: false },
    escapeCancelsRequest: { type: 'boolean', default: false },
    hasTurnBoundaryDrain: { type: 'boolean', default: false },
    hooks: {
      type: 'object',
      additionalProperties: false,
      properties: { provider: { type: ['string', 'null'], default: null } },
      default: {},
    },
    mcp: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        inject: {
          type: ['string', 'null'],
          enum: ['settings_file', 'env', 'flag', 'proxy_flag', null],
          default: null,
        },
        settingsPath: { type: ['string', 'null'], default: null },
        envVar: { type: ['string', 'null'], default: null },
        flag: { type: ['string', 'null'], default: null },
        transport: {
          type: ['string', 'null'],
          enum: ['stdio', 'sse', 'http', null],
          default: null,
        },
      },
      default: null,
    },
    acp: {
      type: ['object', 'null'],
      required: ['mode'],
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['native', 'subcommand', 'flag'] },
        args: { ...stringArray, default: [] },
      },
      default: null,
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contextUsage: { type: 'boolean', default: false },
        sessionFork: { type: 'boolean', default: false },
        setupHelper: { type: 'boolean', default: false },
        acp: { type: 'boolean', default: false },
      },
      default: {},
    },
  },
} as const;

// `allowUnionTypes` because several fields are genuinely `string | null`;
// `useDefaults` is what materializes the optional two-thirds of the schema at
// load time, mirroring `applyJsonSchemaDefaults` in `server/workflows/config.ts`.
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true, useDefaults: true });

let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
  if (!compiled) compiled = ajv.compile(ENGINE_PRESET_SCHEMA);
  return compiled;
}

/** Render ajv's error array into one `field: message` line, presets.ts-style. */
function formatAjvErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`.trim())
    .join('; ');
}

/**
 * Reject shell metacharacters in a string destined for a command line.
 *
 * Same character set as `validateFlagString()` in `types.ts`. Returns an error
 * string (never throws) so the loader can warn-and-skip one file instead of
 * failing the whole load.
 */
export function checkShellSafe(value: string, field: string): string | null {
  if (PRESET_FORBIDDEN_RE.test(value)) {
    return `\`${field}\` contains a forbidden shell metacharacter (one of \` ; | & > < $( or newline)`;
  }
  return null;
}

/** Every preset string that can reach a command line, paired with its path. */
function shellBoundStrings(p: EnginePreset): Array<[string, string]> {
  const out: Array<[string, string]> = [['command', p.command]];
  p.args.forEach((a, i) => out.push([`args[${i}]`, a]));
  if (p.resumeFlag !== null) out.push(['resumeFlag', p.resumeFlag]);
  if (p.continueFlag !== null) out.push(['continueFlag', p.continueFlag]);
  if (p.mcp?.flag) out.push(['mcp.flag', p.mcp.flag]);
  p.acp?.args.forEach((a, i) => out.push([`acp.args[${i}]`, a]));
  return out;
}

export type EnginePresetCheckResult =
  | { ok: true; preset: EnginePreset; warnings: string[] }
  | { ok: false; error: string };

/**
 * Validate one preset's parsed JSON against `expectedId` (the filename stem),
 * materializing defaults.
 *
 * Pure — never logs, never throws, never mutates `data` — so both the
 * warn-and-skip file loader and any future 400-on-invalid API route can share
 * it, exactly like `checkPresetShape` in `server/workflows/presets.ts`.
 *
 * An `id` that disagrees with the filename is a **warning**, not a rejection:
 * the filename is authoritative and the returned preset carries the stem.
 */
export function checkEnginePresetShape(data: unknown, expectedId: string): EnginePresetCheckResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'preset must be a JSON object' };
  }
  if (!ENGINE_PRESET_ID_RE.test(expectedId)) {
    return {
      ok: false,
      error: `invalid preset id "${expectedId}" (must match ${ENGINE_PRESET_ID_RE})`,
    };
  }

  // structuredClone: `useDefaults` writes into the object it validates, and this
  // function promises not to touch the caller's data.
  const candidate = structuredClone(data) as Record<string, unknown>;
  const validate = validator();
  if (!validate(candidate)) {
    return { ok: false, error: formatAjvErrors(validate) };
  }

  const warnings: string[] = [];
  const preset = candidate as unknown as EnginePreset;

  if (preset.id !== expectedId) {
    warnings.push(`\`id\` ("${preset.id}") does not match filename — using "${expectedId}"`);
    preset.id = expectedId;
  }

  for (const [field, value] of shellBoundStrings(preset)) {
    const err = checkShellSafe(value, field);
    if (err) return { ok: false, error: err };
  }

  if (preset.capabilities.acp !== (preset.acp !== null)) {
    warnings.push(
      `\`capabilities.acp\` (${preset.capabilities.acp}) disagrees with \`acp\` block (${
        preset.acp === null ? 'absent' : 'present'
      })`,
    );
  }

  return { ok: true, preset, warnings };
}
