import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { CoreHarness, HarnessLaunchOpts, HarnessResumeOpts, ReadyState } from './types.js';
import { validateAgentName, validateFlagString } from './types.js';
import {
  composeArgv,
  composeCommand,
  formatHarnessFlags,
  formatJsonConfig,
  validateSettingsObject,
  writeJsonConfig,
} from './shared.js';
import { registerHarness } from './registry.js';
import type { OctomuxSettings } from '../settings.js';
import { childLogger } from '../logger.js';
import { execTmux } from '../tmux-bin.js';

const logger = childLogger('harness:cursor');

/** Default cursor-agent model when harnesses.cursor.model and flags omit --model. */
export const CURSOR_DEFAULT_MODEL = 'composer-2.5';

const CURSOR_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateCursorModel(model: string): string {
  const trimmed = model.trim();
  if (!CURSOR_MODEL_RE.test(trimmed)) {
    throw new Error(
      `Invalid harnesses.cursor.model: ${JSON.stringify(model)}. Use an id from cursor-agent --list-models`,
    );
  }
  return trimmed;
}

/**
 * Regex matching the various wordings of Cursor's Workspace Trust prompt.
 * Cursor versions have used phrasings like:
 *   - "Trust this workspace?"
 *   - "Do you trust the authors of files in this folder?"
 *   - "Trust this folder?"
 * We match generously so we don't miss future minor reword variations.
 */
const TRUST_PROMPT_RE = /trust this (?:workspace|folder)|do you trust/i;
const TRUST_POLL_INTERVAL_MS = 200;
const TRUST_POLL_TIMEOUT_MS = 5000;

/**
 * argv head shared by launch and resume: the binary plus the workspace flag
 * when octomux pins one. `--resume <id>` is appended by the caller so the
 * token order matches what cursor-agent expects.
 */
function cursorHead(workspacePath?: string): string[] {
  return workspacePath ? ['cursor-agent', '--workspace', workspacePath] : ['cursor-agent'];
}

/**
 * Cursor's Workspace Trust gate, in the wordings shipped so far, plus the
 * generic "ready" and "starting" shapes of the cursor-agent TUI.
 */
const CURSOR_STARTING_RE = /connecting|loading|starting|initializ|signing in/i;
const CURSOR_PROMPT_RE = /^\s*>\s*$|^\s*>\s+\S/;
const BOX_GLYPHS_RE = /[\u2502\u2503\u2506\u2507\u250a\u250b\u254e|]/g;

function hooksJsonObject(bridgeDest: string) {
  const hookEntry = { command: bridgeDest, type: 'command', timeout: 5 };
  return {
    version: 1,
    hooks: {
      sessionStart: [hookEntry],
      beforeSubmitPrompt: [hookEntry],
      beforeShellExecution: [hookEntry],
      postToolUse: [hookEntry],
      afterFileEdit: [hookEntry],
    },
  };
}

/**
 * Locate the bridge script. The source layout is `<root>/bin/octomux-hook-bridge.js`
 * but `import.meta.url` differs between dev (`<root>/server/harnesses/cursor.ts`
 * under tsx) and bundled production (`<root>/dist-server/harnesses-*.js`). Walk up
 * from the running module looking for the bin/ sibling.
 */
function resolveBridgeSource(): string {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'bin', 'octomux-hook-bridge.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot locate bin/octomux-hook-bridge.js from ${startDir} (walked up 6 levels)`);
}

export const cursorHarness: CoreHarness = {
  id: 'cursor',
  displayName: 'Cursor',
  sessionIdMode: 'harness-issued',

  newSessionId(): string {
    return crypto.randomUUID();
  },

  instructionFile: '.cursor/rules/octomux.md',
  capabilities: {
    // Deliberately conservative: none of these four are verified against a
    // real cursor-agent build (spec/engine-layer.md §3 lists Cursor as
    // source-derived, not binary-verified). cursor-agent does report token
    // usage in its TUI and does have `--resume`, but octomux has not confirmed
    // a machine-readable usage channel, a fork-session equivalent, or an ACP
    // mode — so they stay false until someone checks against the binary.
    contextUsage: false,
    sessionFork: false,
    setupHelper: false,
    acp: false,
  },

  // argv is the real builder; the *Command members render the same head.
  // Note: `model` is intentionally ignored on both paths — for Cursor the
  // model arrives inside the resolved flags (`resolveFlags` always appends
  // `--model <id>`), and honouring the per-task override here as well would
  // change today's behaviour, not just its spelling.
  buildLaunchArgv({ flags = '', workspacePath }: HarnessLaunchOpts): string[] {
    return composeArgv(cursorHead(workspacePath), flags);
  },

  buildResumeArgv({ sessionId, flags = '', workspacePath }: HarnessResumeOpts): string[] {
    return composeArgv([...cursorHead(workspacePath), '--resume', sessionId], flags);
  },

  buildContinueArgv(_opts: HarnessResumeOpts): null {
    return null;
  },

  buildLaunchCommand({ flags = '', workspacePath }: HarnessLaunchOpts): string {
    return composeCommand(cursorHead(workspacePath), flags);
  },

  buildResumeCommand({ sessionId, flags = '', workspacePath }: HarnessResumeOpts): string {
    return composeCommand([...cursorHead(workspacePath), '--resume', sessionId], flags);
  },

  buildContinueCommand(_opts: HarnessResumeOpts): null {
    return null;
  },

  /**
   * Same trust-prompt regex `postLaunch` polls with, exposed as a pure
   * classifier so the gate can be detected without a tmux round-trip.
   */
  detectReady(paneContent: string): ReadyState {
    if (!paneContent.trim()) return 'starting';
    if (TRUST_PROMPT_RE.test(paneContent)) return 'permission_warning';
    const lines = paneContent.split('\n').map((l) => l.replace(BOX_GLYPHS_RE, ' ').trimEnd());
    if (lines.some((line) => CURSOR_PROMPT_RE.test(line))) return 'ready';
    if (CURSOR_STARTING_RE.test(paneContent)) return 'starting';
    return 'unknown';
  },

  async installHooks(worktreePath: string, baseUrl: string, hookToken: string): Promise<void> {
    const hooksDir = path.join(worktreePath, '.octomux-hooks');
    fs.mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(hooksDir, 0o700);

    const bridgeSrc = resolveBridgeSource();
    const bridgeDest = path.join(hooksDir, 'bridge.js');
    try {
      if (fs.existsSync(bridgeDest)) {
        fs.chmodSync(bridgeDest, 0o600);
      }
    } catch {
      /* best-effort: dest may not exist yet or be inaccessible */
    }
    fs.copyFileSync(bridgeSrc, bridgeDest);
    fs.chmodSync(bridgeDest, 0o500);

    const expectedConfig = formatJsonConfig({ baseUrl, token: hookToken });
    const configPath = path.join(hooksDir, 'config.json');
    try {
      if (!fs.existsSync(configPath) || fs.readFileSync(configPath, 'utf-8') !== expectedConfig) {
        writeJsonConfig(configPath, { baseUrl, token: hookToken }, { mode: 0o600 });
      }
    } catch {
      writeJsonConfig(configPath, { baseUrl, token: hookToken }, { mode: 0o600 });
    }
    fs.chmodSync(configPath, 0o600);

    const hooksJsonObj = hooksJsonObject(bridgeDest);
    const hooksJsonExpected = formatJsonConfig(hooksJsonObj);
    const cursorDir = path.join(worktreePath, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const hooksJsonPath = path.join(cursorDir, 'hooks.json');
    try {
      if (
        !fs.existsSync(hooksJsonPath) ||
        fs.readFileSync(hooksJsonPath, 'utf-8') !== hooksJsonExpected
      ) {
        writeJsonConfig(hooksJsonPath, hooksJsonObj);
      }
    } catch {
      writeJsonConfig(hooksJsonPath, hooksJsonObj);
    }
  },

  async uninstallHooks(dirPath: string): Promise<void> {
    // `.cursor/hooks.json` is written wholesale by installHooks and every entry
    // points at our bridge — drop it only when that still holds, so a
    // hand-edited file survives.
    const hooksJsonPath = path.join(dirPath, '.cursor', 'hooks.json');
    try {
      const raw = fs.readFileSync(hooksJsonPath, 'utf-8');
      if (raw.includes('.octomux-hooks')) fs.rmSync(hooksJsonPath, { force: true });
    } catch {
      /* absent or unreadable — nothing to clean */
    }
    fs.rmSync(path.join(dirPath, '.octomux-hooks'), { recursive: true, force: true });
  },

  async postLaunch(target: string): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    const start = Date.now();
    while (Date.now() - start < TRUST_POLL_TIMEOUT_MS) {
      let stdout: string;
      try {
        ({ stdout } = await execTmux(['capture-pane', '-t', target, '-p']));
      } catch (err) {
        logger.warn(
          { target, err: (err as Error).message },
          'cursor postLaunch: tmux capture-pane failed; abandoning trust auto-accept',
        );
        return;
      }
      if (TRUST_PROMPT_RE.test(stdout)) {
        try {
          await execTmux(['send-keys', '-t', target, 'a']);
          logger.info(
            { target, elapsed_ms: Date.now() - start },
            'cursor postLaunch: accepted Workspace Trust prompt',
          );
        } catch (err) {
          logger.warn(
            { target, err: (err as Error).message },
            'cursor postLaunch: tmux send-keys failed while accepting trust prompt',
          );
        }
        return;
      }
      await new Promise((r) => setTimeout(r, TRUST_POLL_INTERVAL_MS));
    }
    logger.info(
      { target, timeout_ms: TRUST_POLL_TIMEOUT_MS },
      'cursor postLaunch: no Workspace Trust prompt detected within timeout (workspace probably already trusted)',
    );
  },

  resolveFlags(settings: OctomuxSettings): string {
    const ccHarness = settings.harnesses?.['claude-code'] as
      | { dangerouslySkipPermissions?: unknown }
      | undefined;
    const dangerouslyFromHarness =
      typeof ccHarness?.dangerouslySkipPermissions === 'boolean'
        ? ccHarness.dangerouslySkipPermissions
        : false;
    const dangerousAllow = dangerouslyFromHarness || Boolean(settings.dangerouslySkipPermissions);

    const sub = (settings.harnesses?.['cursor'] ?? {}) as {
      flags?: string;
      force?: boolean;
      model?: string;
    };

    const parts: string[] = [];
    if (sub.force || dangerousAllow) {
      parts.push('--force');
    }
    if (sub.flags) {
      parts.push(validateFlagString(sub.flags, 'harnesses.cursor.flags'));
    }
    const joined = parts.join(' ');
    if (!/\B--model\b/.test(joined)) {
      const modelId =
        typeof sub.model === 'string' && sub.model.trim()
          ? validateCursorModel(sub.model)
          : CURSOR_DEFAULT_MODEL;
      parts.push(`--model ${modelId}`);
    }
    return formatHarnessFlags(parts);
  },

  validateSettings(blob: unknown): Record<string, unknown> {
    return validateSettingsObject(
      blob,
      'cursor',
      {
        flags: (value) => validateFlagString(value as string, 'harnesses.cursor.flags'),
        force: (value) => {
          if (typeof value !== 'boolean') {
            throw new Error('Invalid cursor.force: expected boolean');
          }
          return value;
        },
        model: (value) => {
          if (typeof value !== 'string') {
            throw new Error('Invalid cursor.model: expected string');
          }
          const trimmed = value.trim();
          if (trimmed) return validateCursorModel(trimmed);
          return undefined;
        },
      },
      { rejectUnknownKeys: true },
    );
  },

  validateAgentName(name: string): string {
    return validateAgentName(name);
  },
};

registerHarness(cursorHarness);

export default cursorHarness;
