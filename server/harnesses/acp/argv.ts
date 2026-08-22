/**
 * server/harnesses/acp/argv.ts
 *
 * Turns a preset's `acp` block into the argv that starts that engine in ACP
 * mode (spec/engine-layer.md §2.2).
 *
 * Three engines reach ACP by three different routes, and the preset says which:
 *
 * | mode         | example                | argv                                  |
 * | ------------ | ---------------------- | ------------------------------------- |
 * | `native`     | `claude-code-acp`      | `acp.args` verbatim                   |
 * | `subcommand` | `opencode acp`         | `command` + `acp.args` + preset `args`|
 * | `flag`       | `gemini --acp`         | `command` + preset `args` + `acp.args`|
 *
 * The ordering differences are not cosmetic. A subcommand CLI parses its verb
 * first and rejects global flags placed ahead of it, so `acp.args` goes directly
 * after the binary and the preset's own flags follow. A flag-mode engine has no
 * verb, so the preset's flags keep their normal position and the ACP flag is
 * appended. `native` ignores `command`/`args` entirely by definition: `acp.args[0]`
 * *is* the binary, and the preset's interactive flags belong to a different
 * executable.
 *
 * Returns `string[]`, never a shell string — spec §3 ("argv kararının gerekçesi")
 * is explicit that the escaping every prior implementation hand-rolled is the
 * surface this replaces.
 */

import { checkShellSafe, type EnginePresetAcp } from '../preset-schema.js';

/** Thrown when a preset cannot produce a usable ACP argv. */
export class AcpArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpArgvError';
  }
}

/**
 * The slice of a preset this module reads. An `EnginePreset` satisfies it
 * structurally, so callers can pass one straight through.
 */
export interface AcpArgvSource {
  /** Only used to name the engine in error messages. */
  id?: string;
  /** Executable name or absolute path. */
  command: string;
  /** The preset's always-on interactive flags. */
  args?: string[];
  /** `null` means this engine does not speak ACP. */
  acp: EnginePresetAcp | null;
}

export interface BuildAcpArgvOptions {
  /**
   * Per-run arguments appended last — `--model <id>` and friends, which vary by
   * task and therefore cannot live in a preset.
   */
  extraArgs?: string[];
}

/**
 * Reject empty tokens and shell metacharacters.
 *
 * argv is not itself shell-interpreted, so this is defence in depth rather than
 * the primary control: octomux still launches engines *inside tmux*, where the
 * argv is rendered back into a command line. Keeping the same character set as
 * `PRESET_FORBIDDEN_RE` means a token that survives here survives that too.
 */
function assertToken(value: string, field: string, engine: string): void {
  if (value.length === 0) {
    throw new AcpArgvError(`${engine}: \`${field}\` is an empty string`);
  }
  const err = checkShellSafe(value, field);
  if (err) throw new AcpArgvError(`${engine}: ${err}`);
}

/**
 * Build the argv that launches `source` in ACP mode.
 *
 * @throws {AcpArgvError} when the preset has no `acp` block, when a mode that
 * needs `acp.args` has none, or when any resulting token is empty or carries a
 * shell metacharacter.
 */
export function buildAcpArgv(source: AcpArgvSource, options: BuildAcpArgvOptions = {}): string[] {
  const engine = source.id ?? source.command;
  const acp = source.acp;

  if (acp === null || acp === undefined) {
    throw new AcpArgvError(`${engine}: no \`acp\` block — this engine does not speak ACP`);
  }

  const presetArgs = source.args ?? [];
  const extraArgs = options.extraArgs ?? [];

  let argv: string[];
  switch (acp.mode) {
    case 'native':
      if (acp.args.length === 0) {
        throw new AcpArgvError(
          `${engine}: \`acp.mode\` is "native" but \`acp.args\` is empty — args[0] must be the ACP binary`,
        );
      }
      // `command`/`args` describe the *interactive* binary and are deliberately
      // dropped: a native ACP engine ships a separate executable.
      argv = [...acp.args, ...extraArgs];
      break;

    case 'subcommand':
      if (acp.args.length === 0) {
        throw new AcpArgvError(
          `${engine}: \`acp.mode\` is "subcommand" but \`acp.args\` is empty — it must name the subcommand`,
        );
      }
      argv = [source.command, ...acp.args, ...presetArgs, ...extraArgs];
      break;

    case 'flag':
      if (acp.args.length === 0) {
        throw new AcpArgvError(
          `${engine}: \`acp.mode\` is "flag" but \`acp.args\` is empty — it must name the ACP flag`,
        );
      }
      argv = [source.command, ...presetArgs, ...acp.args, ...extraArgs];
      break;

    default: {
      // Unreachable while `AcpMode` is the three literals above; kept so adding
      // a fourth mode fails loudly instead of producing a silently empty argv.
      const unknown: string = acp.mode;
      throw new AcpArgvError(`${engine}: unknown \`acp.mode\` "${unknown}"`);
    }
  }

  argv.forEach((token, i) => assertToken(token, `argv[${i}]`, engine));
  return argv;
}
