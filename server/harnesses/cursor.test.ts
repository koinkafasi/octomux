import { describe, it, expect, beforeAll, afterAll } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { cursorHarness } from './cursor.js';

// ---------------------------------------------------------------------------
// Stub setup for installHooks (bridge.js doesn't exist yet — Part B)
// ---------------------------------------------------------------------------

const bridgeSrcPath = fileURLToPath(new URL('../../bin/octomux-hook-bridge.js', import.meta.url));
let stubCreated = false;

beforeAll(() => {
  if (!fs.existsSync(bridgeSrcPath)) {
    fs.mkdirSync(path.dirname(bridgeSrcPath), { recursive: true });
    fs.writeFileSync(bridgeSrcPath, '#!/usr/bin/env node\n');
    stubCreated = true;
  }
});

afterAll(() => {
  if (stubCreated && fs.existsSync(bridgeSrcPath)) {
    fs.rmSync(bridgeSrcPath);
  }
});

// ---------------------------------------------------------------------------
// Basic identity
// ---------------------------------------------------------------------------

describe('cursorHarness', () => {
  it('has stable id, display name, and sessionIdMode', () => {
    expect(cursorHarness.id).toBe('cursor');
    expect(cursorHarness.displayName).toBe('Cursor');
    expect(cursorHarness.sessionIdMode).toBe('harness-issued');
  });

  it('newSessionId returns a UUID', () => {
    const id = cursorHarness.newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  // -------------------------------------------------------------------------
  // buildLaunchCommand
  // -------------------------------------------------------------------------

  describe('buildLaunchCommand', () => {
    it.each([
      [{ sessionId: 's1' }, 'cursor-agent'],
      [{ sessionId: 's1', flags: ' --verbose' }, 'cursor-agent --verbose'],
      [
        {
          sessionId: 's1',
          workspacePath: '/tmp/wt/a',
          flags: ' --verbose',
        },
        // Shell-inert paths render bare: the string form is now
        // `argvToCommand(head)`, which quotes only tokens that need it.
        `cursor-agent --workspace /tmp/wt/a --verbose`,
      ],
    ])('builds %j -> %s', (opts, expected) => {
      expect(cursorHarness.buildLaunchCommand(opts)).toBe(expected);
    });

    // resolveHarnessFlags → appendOctomuxPluginFlags trims the leading space,
    // which used to glue the first flag onto the quoted --workspace value:
    // `--workspace '/tmp/wt/a'--force` → "Workspace directory does not exist".
    it('separates flags that arrive without a leading space', () => {
      expect(
        cursorHarness.buildLaunchCommand({
          sessionId: 's1',
          workspacePath: '/tmp/wt/a',
          flags: '--force --model composer-2.5',
        }),
      ).toBe(`cursor-agent --workspace /tmp/wt/a --force --model composer-2.5`);
    });

    it('quotes workspace paths that contain apostrophes', () => {
      expect(
        cursorHarness.buildLaunchCommand({
          sessionId: 's1',
          workspacePath: "/tmp/it's-fine",
        }),
      ).toBe(`cursor-agent --workspace '/tmp/it'\\''s-fine'`);
    });
  });

  // -------------------------------------------------------------------------
  // buildResumeCommand
  // -------------------------------------------------------------------------

  describe('buildResumeCommand', () => {
    it.each([
      [{ sessionId: 'chat-abc' }, 'cursor-agent --resume chat-abc'],
      [{ sessionId: 'chat-abc', flags: ' --verbose' }, 'cursor-agent --resume chat-abc --verbose'],
      [
        {
          sessionId: 'chat-abc',
          workspacePath: '/tmp/repo',
          flags: ' --force',
        },
        `cursor-agent --workspace /tmp/repo --resume chat-abc --force`,
      ],
    ])('builds %j -> %s', (opts, expected) => {
      expect(cursorHarness.buildResumeCommand(opts)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // argv builders (the source of truth the *Command members render)
  // -------------------------------------------------------------------------

  describe('buildLaunchArgv', () => {
    it.each([
      [{ sessionId: 's1' }, ['cursor-agent']],
      [{ sessionId: 's1', flags: ' --verbose' }, ['cursor-agent', '--verbose']],
      [
        { sessionId: 's1', workspacePath: '/tmp/wt/a', flags: ' --verbose' },
        ['cursor-agent', '--workspace', '/tmp/wt/a', '--verbose'],
      ],
      [
        { sessionId: 's1', workspacePath: "/tmp/it's-fine" },
        ['cursor-agent', '--workspace', "/tmp/it's-fine"],
      ],
      [
        { sessionId: 's1', flags: '--force --model composer-2.5' },
        ['cursor-agent', '--force', '--model', 'composer-2.5'],
      ],
    ])('builds %j', (opts, expected) => {
      expect(cursorHarness.buildLaunchArgv?.(opts)).toEqual(expected);
    });

    it('ignores the per-task model — Cursor gets its model from resolveFlags', () => {
      expect(cursorHarness.buildLaunchArgv?.({ sessionId: 's1', model: 'composer-9' })).toEqual([
        'cursor-agent',
      ]);
    });
  });

  describe('buildResumeArgv', () => {
    it.each([
      [{ sessionId: 'chat-abc' }, ['cursor-agent', '--resume', 'chat-abc']],
      [
        { sessionId: 'chat-abc', workspacePath: '/tmp/repo', flags: ' --force' },
        ['cursor-agent', '--workspace', '/tmp/repo', '--resume', 'chat-abc', '--force'],
      ],
    ])('builds %j', (opts, expected) => {
      expect(cursorHarness.buildResumeArgv?.(opts)).toEqual(expected);
    });

    it('keeps a hostile session id as ONE argv token', () => {
      expect(cursorHarness.buildResumeArgv?.({ sessionId: 'x; rm -rf /' })).toEqual([
        'cursor-agent',
        '--resume',
        'x; rm -rf /',
      ]);
    });
  });

  describe('buildContinueArgv', () => {
    it('returns null — cursor-agent has no --continue', () => {
      expect(cursorHarness.buildContinueArgv?.({ sessionId: 's1' })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // instructionFile / capabilities / detectReady
  // -------------------------------------------------------------------------

  describe('engine metadata', () => {
    it('declares its instruction file', () => {
      expect(cursorHarness.instructionFile).toBe('.cursor/rules/octomux.md');
    });

    it('declares every capability conservatively false (none binary-verified)', () => {
      expect(cursorHarness.capabilities).toEqual({
        contextUsage: false,
        sessionFork: false,
        setupHelper: false,
        acp: false,
      });
    });
  });

  describe('detectReady', () => {
    it.each([
      ['', 'starting'],
      ['   \n  \n', 'starting'],
      ['Connecting to cursor-agent...', 'starting'],
      ['Do you trust the authors of the files in this folder?', 'permission_warning'],
      ['Trust this workspace?  [a] yes', 'permission_warning'],
      ['Trust this folder?', 'permission_warning'],
      ['\u2502 > \u2502', 'ready'],
      ['> ask anything', 'ready'],
      ['Editing src/app.ts (3s)', 'unknown'],
    ])('classifies %j as %s', (pane, expected) => {
      expect(cursorHarness.detectReady?.(pane)).toBe(expected);
    });

    it('the trust prompt wins over a visible prompt line', () => {
      expect(cursorHarness.detectReady?.('> \nTrust this workspace?')).toBe('permission_warning');
    });
  });

  // -------------------------------------------------------------------------
  // buildContinueCommand
  // -------------------------------------------------------------------------

  describe('buildContinueCommand', () => {
    it('returns null', () => {
      expect(cursorHarness.buildContinueCommand({ sessionId: 's1' })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // resolveFlags
  // -------------------------------------------------------------------------

  describe('resolveFlags', () => {
    it.each([
      [{ harnesses: {} }, ' --model composer-2.5'],
      [{ harnesses: { cursor: { force: true } } }, ' --force --model composer-2.5'],
      [{ harnesses: { cursor: { flags: '--mode plan' } } }, ' --mode plan --model composer-2.5'],
      [
        { harnesses: { cursor: { force: true, flags: '--mode plan' } } },
        ' --force --mode plan --model composer-2.5',
      ],
      [
        {
          harnesses: { 'claude-code': { dangerouslySkipPermissions: true } },
        },
        ' --force --model composer-2.5',
      ],
      [
        {
          harnesses: {
            'claude-code': { dangerouslySkipPermissions: true },
            cursor: { flags: '--mode plan' },
          },
        },
        ' --force --mode plan --model composer-2.5',
      ],
      [{ harnesses: { cursor: { flags: '--model gpt-5' } } }, ' --model gpt-5'],
      [{ harnesses: { cursor: { model: 'composer-2.5-fast' } } }, ' --model composer-2.5-fast'],
      [
        { harnesses: { cursor: { model: 'gpt-5.4-high', force: true } } },
        ' --force --model gpt-5.4-high',
      ],
    ])('settings %j -> %s', (settings, expected) => {
      expect(cursorHarness.resolveFlags(settings as any)).toBe(expected);
    });

    it('throws on bad flags', () => {
      expect(() =>
        cursorHarness.resolveFlags({ harnesses: { cursor: { flags: '; rm -rf /' } } } as any),
      ).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // validateSettings
  // -------------------------------------------------------------------------

  describe('validateSettings', () => {
    it.each([
      [{}, {}],
      [{ flags: '--x' }, { flags: '--x' }],
      [{ force: true }, { force: true }],
      [{ model: 'composer-2.5' }, { model: 'composer-2.5' }],
      [{ model: '  gpt-5.4-high  ' }, { model: 'gpt-5.4-high' }],
    ])('accepts %j -> %j', (input, expected) => {
      expect(cursorHarness.validateSettings(input)).toEqual(expected);
    });

    it('throws on wrong type for force', () => {
      expect(() => cursorHarness.validateSettings({ force: 'yes' })).toThrow(/force/);
    });

    it('throws on invalid model id', () => {
      expect(() => cursorHarness.validateSettings({ model: 'bad model' })).toThrow(/model/);
    });

    it('throws on unknown key', () => {
      expect(() => cursorHarness.validateSettings({ unknown: 'x' })).toThrow(/unknown/);
    });

    it.each([[null], [42], ['string'], [[]]])('throws on non-object: %j', (val) => {
      expect(() => cursorHarness.validateSettings(val)).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// installHooks integration test
// ---------------------------------------------------------------------------

describe('cursorHarness.installHooks', () => {
  it('writes all required files with correct modes and content', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-cursor-hooks-'));
    try {
      await cursorHarness.installHooks(tmpDir, 'http://127.0.0.1:7777', 'tok-abc');

      const bridgeDest = path.join(tmpDir, '.octomux-hooks', 'bridge.js');
      const configPath = path.join(tmpDir, '.octomux-hooks', 'config.json');
      const hooksJsonPath = path.join(tmpDir, '.cursor', 'hooks.json');

      // bridge.js exists and has mode 0500
      expect(fs.existsSync(bridgeDest)).toBe(true);
      expect(fs.statSync(bridgeDest).mode & 0o777).toBe(0o500);

      // config.json exists, mode 0600, correct content
      expect(fs.existsSync(configPath)).toBe(true);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config).toEqual({ baseUrl: 'http://127.0.0.1:7777', token: 'tok-abc' });

      // hooks.json exists with correct structure
      expect(fs.existsSync(hooksJsonPath)).toBe(true);
      const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
      expect(hooksJson.version).toBe(1);
      const eventNames = [
        'sessionStart',
        'beforeSubmitPrompt',
        'beforeShellExecution',
        'postToolUse',
        'afterFileEdit',
      ];
      for (const event of eventNames) {
        expect(hooksJson.hooks[event]).toHaveLength(1);
        expect(hooksJson.hooks[event][0].command).toBe(bridgeDest);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installHooks leaves config and hooks.json unchanged when inputs match', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-cursor-hooks-idem-'));
    try {
      await cursorHarness.installHooks(tmpDir, 'http://127.0.0.1:7777', 'tok-abc');
      const configPath = path.join(tmpDir, '.octomux-hooks', 'config.json');
      const hooksPath = path.join(tmpDir, '.cursor', 'hooks.json');
      const configBefore = fs.readFileSync(configPath, 'utf-8');
      const hooksBefore = fs.readFileSync(hooksPath, 'utf-8');
      await cursorHarness.installHooks(tmpDir, 'http://127.0.0.1:7777', 'tok-abc');
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(configBefore);
      expect(fs.readFileSync(hooksPath, 'utf-8')).toBe(hooksBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uninstallHooks removes the bridge dir and our hooks.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-cursor-hooks-rm-'));
    try {
      await cursorHarness.installHooks(tmpDir, 'http://127.0.0.1:7777', 'tok-abc');
      await cursorHarness.uninstallHooks(tmpDir);
      expect(fs.existsSync(path.join(tmpDir, '.octomux-hooks'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, '.cursor', 'hooks.json'))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uninstallHooks keeps a hooks.json that is not ours, and no-ops on a bare dir', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-cursor-hooks-keep-'));
    try {
      const hooksPath = path.join(tmpDir, '.cursor', 'hooks.json');
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, '{"version":1,"hooks":{"sessionStart":[]}}', 'utf-8');
      await cursorHarness.uninstallHooks(tmpDir);
      expect(fs.existsSync(hooksPath)).toBe(true);

      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-cursor-hooks-bare-'));
      await expect(cursorHarness.uninstallHooks(bare)).resolves.toBeUndefined();
      fs.rmSync(bare, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
