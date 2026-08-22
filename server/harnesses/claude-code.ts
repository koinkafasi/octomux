import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { CoreHarness, ReadyState } from './types.js';
import { validateAgentName, validateFlagString } from './types.js';
import {
  buildClaudeContinueArgv,
  buildClaudeContinueCommand,
  buildClaudeLaunchArgv,
  buildClaudeLaunchCommand,
  buildClaudeResumeArgv,
  buildClaudeResumeCommand,
  formatHarnessFlags,
  validateSettingsObject,
  writeJsonConfig,
} from './shared.js';
import { registerHarness } from './registry.js';
import { execTmux } from '../tmux-bin.js';
import { childLogger } from '../logger.js';
import { getSettings } from '../settings.js';
import type { OctomuxSettings } from '../settings.js';

const logger = childLogger('harnesses/claude-code');

/**
 * Accept only an absolute http(s) URL for a gateway base.
 *
 * Narrow on purpose: the value is exported into the agent's shell, so anything
 * that is not a plain URL is either a mistake or an attempt to smuggle shell
 * syntax through a settings field. `new URL` rejects the malformed cases; the
 * protocol check rejects `file:`, `javascript:` and friends.
 */
function validateBaseUrl(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}: expected a string`);
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ${field}: not an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${field}: expected http or https, got ${parsed.protocol}`);
  }
  return trimmed;
}

function buildHookEvents(baseUrl: string, token: string) {
  const url = (event: string) => `${baseUrl}/api/hooks/${event}?token=${encodeURIComponent(token)}`;
  return {
    UserPromptSubmit: [{ hooks: [{ type: 'http', url: url('user-prompt-submit'), timeout: 5 }] }],
    PermissionRequest: [{ hooks: [{ type: 'http', url: url('permission-request'), timeout: 5 }] }],
    PostToolUse: [{ hooks: [{ type: 'http', url: url('post-tool-use'), timeout: 5 }] }],
    Stop: [{ hooks: [{ type: 'http', url: url('stop'), timeout: 5 }] }],
  };
}

/**
 * Claude Code's bypass-permissions / trust gate. Any of these lines means the
 * TUI is waiting on a keypress before it will accept a prompt.
 *
 * The folder-trust wording has changed over releases and the earlier pattern
 * matched none of what 2.1.x actually draws — observed verbatim in a fresh
 * worktree: "1. Yes, I trust this folder", "Enter to confirm · Esc to cancel",
 * "Only proceed if you trust this configuration". A missed match leaves
 * `detectReady` reporting `unknown` for a pane that is in fact blocked, so the
 * alternatives below are kept deliberately broad.
 */
const CLAUDE_PERMISSION_WARNING_RE =
  /bypass permissions mode|do you want to (?:proceed|trust)|yes, i (?:accept|trust)|trust this (?:folder|workspace|configuration)|press enter to continue|enter to confirm/i;

const TRUST_POLL_INTERVAL_MS = 200;
const TRUST_POLL_TIMEOUT_MS = 5000;
/** How long to wait for the gate to clear after answering before falling back to Enter. */
const TRUST_SETTLE_MS = 400;

/** Splash / boot chatter drawn before the input box exists. */
const CLAUDE_STARTING_RE = /welcome to claude code|loading|starting|initializ|logging in/i;

/**
 * The idle input box. Claude Code draws it inside a border, so box-drawing
 * glyphs are stripped before the `>` prompt is matched; `? for shortcuts` is
 * the footer that accompanies it.
 */
const CLAUDE_PROMPT_RE = /^\s*>\s*$|^\s*>\s+\S/;
const BOX_GLYPHS_RE = /[\u2502\u2503\u2506\u2507\u250a\u250b\u254e|]/g;

function paneLines(paneContent: string): string[] {
  return paneContent.split('\n').map((line) => line.replace(BOX_GLYPHS_RE, ' ').trimEnd());
}

export const claudeCodeHarness: CoreHarness = {
  id: 'claude-code',
  displayName: 'Claude Code',
  sessionIdMode: 'orchestrator-assigned',

  newSessionId() {
    return crypto.randomUUID();
  },

  instructionFile: 'CLAUDE.md',
  capabilities: {
    // `/context` and the Stop hook payload both report token usage.
    contextUsage: true,
    // `claude --fork-session` exists on the installed binary.
    sessionFork: true,
    // No octomux-driven setup pass: once the user is logged in, `claude` runs
    // unattended.
    setupHelper: false,
    // The `claude` binary itself does not speak ACP — `claude-code-acp` is a
    // separate adapter (spec/engine-layer.md §3) and would register as its own
    // engine.
    acp: false,
  },

  // argv is the real builder; the *Command members render the same head.
  buildLaunchArgv: buildClaudeLaunchArgv,
  buildResumeArgv: buildClaudeResumeArgv,
  buildContinueArgv: buildClaudeContinueArgv,

  buildLaunchCommand: buildClaudeLaunchCommand,
  buildResumeCommand: buildClaudeResumeCommand,
  buildContinueCommand: buildClaudeContinueCommand,

  detectReady(paneContent: string): ReadyState {
    if (!paneContent.trim()) return 'starting';
    if (CLAUDE_PERMISSION_WARNING_RE.test(paneContent)) return 'permission_warning';
    if (paneLines(paneContent).some((line) => CLAUDE_PROMPT_RE.test(line))) return 'ready';
    if (paneContent.includes('? for shortcuts')) return 'ready';
    if (CLAUDE_STARTING_RE.test(paneContent)) return 'starting';
    return 'unknown';
  },

  async installHooks(worktreePath: string, baseUrl: string, hookToken: string) {
    const { ALLOWED_TOOLS, DENIED_TOOLS } = await import('../hook-settings.js');
    const claudeDir = path.join(worktreePath, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    fs.mkdirSync(claudeDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      existing = JSON.parse(raw);
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        existing = {};
      }
    } catch {
      existing = {};
    }

    const existingHooks =
      typeof existing.hooks === 'object' &&
      existing.hooks !== null &&
      !Array.isArray(existing.hooks)
        ? (existing.hooks as Record<string, unknown>)
        : {};
    const mergedHooks = { ...existingHooks, ...buildHookEvents(baseUrl, hookToken) };

    const existingPerms =
      typeof existing.permissions === 'object' &&
      existing.permissions !== null &&
      !Array.isArray(existing.permissions)
        ? (existing.permissions as Record<string, unknown>)
        : {};
    const existingAllow = Array.isArray(existingPerms.allow)
      ? (existingPerms.allow as string[])
      : [];
    const mergedAllow = [...new Set([...ALLOWED_TOOLS, ...existingAllow])];
    const existingDeny = Array.isArray(existingPerms.deny) ? (existingPerms.deny as string[]) : [];
    const mergedDeny = [...new Set([...DENIED_TOOLS, ...existingDeny])];
    const mergedPermissions = { ...existingPerms, allow: mergedAllow, deny: mergedDeny };

    // Force NON-vim keybindings unless the worktree explicitly chose one. octomux
    // drives agents with tmux `send-keys` (paste → Enter to submit). If the
    // operator's global config has `editorMode: vim`, the agent's TUI starts in
    // vim INSERT mode where Enter's submit behavior is mode-dependent and
    // unreliable — turns (incl. plan approvals) get pasted but never submitted.
    // emacs keybindings make `send-keys Enter` submit deterministically.
    const editorMode = typeof existing.editorMode === 'string' ? existing.editorMode : 'emacs';

    const merged = { ...existing, editorMode, permissions: mergedPermissions, hooks: mergedHooks };
    writeJsonConfig(settingsPath, merged);
  },

  async uninstallHooks(dirPath: string) {
    const settingsPath = path.join(dirPath, '.claude', 'settings.local.json');

    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      return; // no config (or unparseable) — nothing to clean
    }
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) return;
    if (
      typeof existing.hooks !== 'object' ||
      existing.hooks === null ||
      Array.isArray(existing.hooks)
    ) {
      return;
    }

    // Strip only OUR entries (url contains /api/hooks/); the user's own hooks,
    // and their permissions, stay untouched.
    const hooks: Record<string, unknown> = {};
    for (const [event, matchers] of Object.entries(existing.hooks as Record<string, unknown>)) {
      if (!Array.isArray(matchers)) {
        hooks[event] = matchers;
        continue;
      }
      const kept = matchers
        .map((m) => {
          const inner = (m as { hooks?: unknown })?.hooks;
          if (!Array.isArray(inner)) return m;
          const keptInner = inner.filter(
            (h) => !String((h as { url?: unknown })?.url ?? '').includes('/api/hooks/'),
          );
          return keptInner.length === inner.length ? m : { ...(m as object), hooks: keptInner };
        })
        .filter((m) => {
          const inner = (m as { hooks?: unknown })?.hooks;
          return !Array.isArray(inner) || inner.length > 0;
        });
      if (kept.length > 0) hooks[event] = kept;
    }

    const next: Record<string, unknown> = { ...existing };
    if (Object.keys(hooks).length > 0) next.hooks = hooks;
    else delete next.hooks;
    writeJsonConfig(settingsPath, next);
  },

  resolveFlags(settings: OctomuxSettings): string {
    const envFlagsRaw = process.env.OCTOMUX_CLAUDE_FLAGS?.trim();
    if (envFlagsRaw) {
      const envFlags = validateFlagString(envFlagsRaw, 'OCTOMUX_CLAUDE_FLAGS');
      return ` ${envFlags}`;
    }

    const sub = (settings.harnesses?.['claude-code'] ?? {}) as {
      flags?: string;
      dangerouslySkipPermissions?: boolean;
    };

    const parts: string[] = [];
    if (sub.dangerouslySkipPermissions) parts.push('--dangerously-skip-permissions');
    if (sub.flags) {
      parts.push(validateFlagString(sub.flags, 'harnesses.claude-code.flags'));
    }
    return formatHarnessFlags(parts);
  },

  /**
   * Point Claude Code at an Anthropic-compatible gateway.
   *
   * `ANTHROPIC_BASE_URL` is read by the CLI at process start, so it has to be
   * exported ahead of the command rather than set later — that is what
   * `buildAgentStartupCommand` does with this map. Unlike routing through a
   * tier-1 preset, this keeps the harness intact: hooks still install, so
   * permission prompts, stop events and session tracking survive.
   *
   * `OCTOMUX_CLAUDE_BASE_URL` overrides settings, mirroring how
   * `OCTOMUX_CLAUDE_FLAGS` overrides configured flags.
   */
  resolveEnv(settings: OctomuxSettings): Record<string, string> {
    const fromEnv = process.env.OCTOMUX_CLAUDE_BASE_URL?.trim();
    if (fromEnv) return { ANTHROPIC_BASE_URL: validateBaseUrl(fromEnv, 'OCTOMUX_CLAUDE_BASE_URL') };

    const sub = (settings.harnesses?.['claude-code'] ?? {}) as { baseUrl?: string };
    const configured = sub.baseUrl?.trim();
    if (!configured) return {};
    return { ANTHROPIC_BASE_URL: validateBaseUrl(configured, 'harnesses.claude-code.baseUrl') };
  },

  /**
   * Answer Claude Code's folder-trust gate so a fresh worktree does not sit
   * blocked waiting for a keypress nobody is watching for.
   *
   * Opt-out via `harnesses['claude-code'].autoAcceptTrust = false`. It defaults
   * on because the gate is confirming a `.claude/settings.local.json` octomux
   * wrote itself for a worktree octomux created — but it is a setting rather
   * than a hardcode because that file also carries whatever tool permissions
   * the operator's own plugins contribute, and pre-approving those is their
   * call to revoke.
   *
   * The prompt is a numbered menu ("1. Yes, I trust this folder" / "2. No,
   * exit"), so `1` is sent rather than a bare Enter: Enter confirms whatever
   * the cursor happens to sit on, and being wrong there exits the agent. If
   * the gate is still up shortly after, Enter follows to confirm the now-
   * selected choice — some builds select without confirming.
   */
  async postLaunch(target: string): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    const settings = await getSettings();
    const sub = (settings.harnesses?.['claude-code'] ?? {}) as { autoAcceptTrust?: boolean };
    if (sub.autoAcceptTrust === false) return;

    const capture = async (): Promise<string | null> => {
      try {
        const { stdout } = await execTmux(['capture-pane', '-t', target, '-p']);
        return stdout;
      } catch (err) {
        logger.warn(
          { target, err: (err as Error).message },
          'claude-code postLaunch: tmux capture-pane failed; abandoning trust auto-accept',
        );
        return null;
      }
    };

    const start = Date.now();
    while (Date.now() - start < TRUST_POLL_TIMEOUT_MS) {
      const pane = await capture();
      if (pane === null) return;
      if (CLAUDE_PERMISSION_WARNING_RE.test(pane)) {
        try {
          await execTmux(['send-keys', '-t', target, '1']);
          await new Promise((r) => setTimeout(r, TRUST_SETTLE_MS));
          const after = await capture();
          if (after !== null && CLAUDE_PERMISSION_WARNING_RE.test(after)) {
            await execTmux(['send-keys', '-t', target, 'Enter']);
          }
          logger.info(
            { target, elapsed_ms: Date.now() - start },
            'claude-code postLaunch: accepted folder-trust prompt',
          );
        } catch (err) {
          logger.warn(
            { target, err: (err as Error).message },
            'claude-code postLaunch: tmux send-keys failed while accepting trust prompt',
          );
        }
        return;
      }
      await new Promise((r) => setTimeout(r, TRUST_POLL_INTERVAL_MS));
    }
    logger.info(
      { target, timeout_ms: TRUST_POLL_TIMEOUT_MS },
      'claude-code postLaunch: no trust prompt within timeout (folder probably already trusted)',
    );
  },

  validateSettings(blob: unknown): Record<string, unknown> {
    return validateSettingsObject(blob, 'claude-code', {
      baseUrl: (value) => validateBaseUrl(value as string, 'harnesses.claude-code.baseUrl'),
      autoAcceptTrust: (value) => {
        if (typeof value !== 'boolean') {
          throw new Error('Invalid claude-code.autoAcceptTrust: expected boolean');
        }
        return value;
      },
      flags: (value) => validateFlagString(value as string, 'harnesses.claude-code.flags'),
      dangerouslySkipPermissions: (value) => {
        if (typeof value !== 'boolean') {
          throw new Error('Invalid claude-code.dangerouslySkipPermissions: expected boolean');
        }
        return value;
      },
    });
  },

  validateAgentName(name: string): string {
    return validateAgentName(name);
  },
};

registerHarness(claudeCodeHarness);

export default claudeCodeHarness;
