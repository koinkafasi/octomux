import { describe, it, expect, afterEach } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeCodeHarness } from './claude-code.js';

describe('claudeCodeHarness', () => {
  it('has stable id and display name', () => {
    expect(claudeCodeHarness.id).toBe('claude-code');
    expect(claudeCodeHarness.displayName).toBe('Claude Code');
    expect(claudeCodeHarness.sessionIdMode).toBe('orchestrator-assigned');
  });

  it('newSessionId returns a UUID', () => {
    const id = claudeCodeHarness.newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  describe('buildLaunchCommand', () => {
    it.each([
      [{ sessionId: 's1' }, 'claude --session-id s1'],
      [{ sessionId: 's1', agent: null }, 'claude --session-id s1'],
      [{ sessionId: 's1', agent: 'orchestrator' }, 'claude --agent orchestrator --session-id s1'],
      [{ sessionId: 's1', flags: ' --verbose' }, 'claude --session-id s1 --verbose'],
      [
        { sessionId: 's1', agent: 'planner', flags: ' --verbose' },
        'claude --agent planner --session-id s1 --verbose',
      ],
    ])('builds %j -> %s', (opts, expected) => {
      expect(claudeCodeHarness.buildLaunchCommand(opts)).toBe(expected);
    });

    it('rejects bad agent names', () => {
      expect(() =>
        claudeCodeHarness.buildLaunchCommand({ sessionId: 's1', agent: 'evil; rm' }),
      ).toThrow(/Invalid agent name/);
    });
  });

  describe('buildResumeCommand', () => {
    it.each([
      [{ sessionId: 's1' }, 'claude --resume s1'],
      [{ sessionId: 's1', flags: ' --verbose' }, 'claude --resume s1 --verbose'],
    ])('builds %j -> %s', (opts, expected) => {
      expect(claudeCodeHarness.buildResumeCommand(opts)).toBe(expected);
    });
  });

  describe('buildContinueCommand', () => {
    it('builds with --continue and a fresh session id', () => {
      expect(claudeCodeHarness.buildContinueCommand({ sessionId: 's1' })).toBe(
        'claude --continue --session-id s1',
      );
    });

    it('appends flags', () => {
      expect(claudeCodeHarness.buildContinueCommand({ sessionId: 's1', flags: ' --verbose' })).toBe(
        'claude --continue --session-id s1 --verbose',
      );
    });
  });
});

describe('detectReady — folder-trust gate', () => {
  it.each([
    // Verbatim from Claude Code 2.1.x in a fresh worktree; the earlier regex
    // matched none of these and reported the blocked pane as `unknown`.
    ['numbered trust choice', ' ❯ 1. Yes, I trust this folder\n   2. No, exit'],
    ['confirm footer', 'Enter to confirm · Esc to cancel'],
    ['configuration wording', 'Only proceed if you trust this configuration.'],
    // Older wordings that must keep matching.
    ['bypass banner', 'Bypass permissions mode is enabled'],
    ['accept wording', 'Yes, I accept'],
  ])('reports permission_warning for the %s', (_label, pane) => {
    expect(claudeCodeHarness.detectReady?.(pane)).toBe('permission_warning');
  });

  it('does not mistake the idle input box for a gate', () => {
    expect(claudeCodeHarness.detectReady?.('> \n? for shortcuts')).not.toBe('permission_warning');
  });
});

describe('resolveEnv — gateway base URL', () => {
  const settingsWith = (sub: Record<string, unknown>) =>
    ({ harnesses: { 'claude-code': sub } }) as never;

  afterEach(() => {
    delete process.env.OCTOMUX_CLAUDE_BASE_URL;
  });

  it('returns nothing when no base URL is configured', () => {
    expect(claudeCodeHarness.resolveEnv?.(settingsWith({}))).toEqual({});
  });

  it('exports ANTHROPIC_BASE_URL from settings', () => {
    expect(
      claudeCodeHarness.resolveEnv?.(settingsWith({ baseUrl: 'http://localhost:20128' })),
    ).toEqual({ ANTHROPIC_BASE_URL: 'http://localhost:20128' });
  });

  it('lets OCTOMUX_CLAUDE_BASE_URL override settings', () => {
    process.env.OCTOMUX_CLAUDE_BASE_URL = 'https://gw.example';
    expect(
      claudeCodeHarness.resolveEnv?.(settingsWith({ baseUrl: 'http://localhost:20128' })),
    ).toEqual({ ANTHROPIC_BASE_URL: 'https://gw.example' });
  });

  it.each([
    ['not-a-url', 'not an absolute URL'],
    ['/relative/path', 'not an absolute URL'],
    ['file:///etc/passwd', 'expected http or https'],
    ['javascript:alert(1)', 'expected http or https'],
  ])('rejects %s', (value, message) => {
    // The value is exported into the agent's shell, so anything that is not a
    // plain http(s) URL is either a mistake or an attempt to smuggle something.
    expect(() => claudeCodeHarness.resolveEnv?.(settingsWith({ baseUrl: value }))).toThrow(message);
  });

  it('rejects a bad base URL at the settings boundary too', () => {
    expect(() => claudeCodeHarness.validateSettings({ baseUrl: 'ftp://x' })).toThrow(
      'expected http or https',
    );
  });
});

describe('buildLaunchCommand model override', () => {
  it('appends --model when model is set and flags has no --model', () => {
    expect(claudeCodeHarness.buildLaunchCommand({ sessionId: 's1', model: 'sonnet' })).toBe(
      "claude --session-id s1 --model 'sonnet'",
    );
  });

  it('replaces --model in flags with per-task model', () => {
    expect(
      claudeCodeHarness.buildLaunchCommand({
        sessionId: 's1',
        flags: ' --model opus',
        model: 'sonnet',
      }),
    ).toBe("claude --session-id s1 --model 'sonnet'");
  });

  it('preserves non-model flags alongside per-task model', () => {
    expect(
      claudeCodeHarness.buildLaunchCommand({
        sessionId: 's1',
        flags: ' --dangerously-skip-permissions --model opus',
        model: 'sonnet',
      }),
    ).toBe("claude --session-id s1 --dangerously-skip-permissions --model 'sonnet'");
  });

  it('leaves flags unchanged when no per-task model', () => {
    expect(claudeCodeHarness.buildLaunchCommand({ sessionId: 's1', flags: ' --model opus' })).toBe(
      'claude --session-id s1 --model opus',
    );
  });
});

describe('buildResumeCommand model override', () => {
  it('replaces --model in flags with per-task model', () => {
    expect(
      claudeCodeHarness.buildResumeCommand({
        sessionId: 's1',
        flags: ' --model opus',
        model: 'sonnet',
      }),
    ).toBe("claude --resume s1 --model 'sonnet'");
  });
});

describe('buildContinueCommand model override', () => {
  it('replaces --model in flags with per-task model', () => {
    expect(
      claudeCodeHarness.buildContinueCommand({
        sessionId: 's1',
        flags: ' --model opus',
        model: 'sonnet',
      }),
    ).toBe("claude --continue --session-id s1 --model 'sonnet'");
  });
});

describe('claudeCodeHarness argv builders', () => {
  describe('buildLaunchArgv', () => {
    it.each([
      [{ sessionId: 's1' }, ['claude', '--session-id', 's1']],
      [{ sessionId: 's1', agent: null }, ['claude', '--session-id', 's1']],
      [
        { sessionId: 's1', agent: 'orchestrator' },
        ['claude', '--agent', 'orchestrator', '--session-id', 's1'],
      ],
      [{ sessionId: 's1', flags: ' --verbose' }, ['claude', '--session-id', 's1', '--verbose']],
      [
        { sessionId: 's1', agent: 'planner', flags: ' --verbose' },
        ['claude', '--agent', 'planner', '--session-id', 's1', '--verbose'],
      ],
      [
        { sessionId: 's1', flags: '--permission-mode bypassPermissions --add-dir /tmp/x' },
        [
          'claude',
          '--session-id',
          's1',
          '--permission-mode',
          'bypassPermissions',
          '--add-dir',
          '/tmp/x',
        ],
      ],
    ])('builds %j', (opts, expected) => {
      expect(claudeCodeHarness.buildLaunchArgv?.(opts)).toEqual(expected);
    });

    it('rejects bad agent names on the argv path too', () => {
      expect(() =>
        claudeCodeHarness.buildLaunchArgv?.({ sessionId: 's1', agent: 'evil; rm' }),
      ).toThrow(/Invalid agent name/);
    });

    it('unwraps a quoted flag value into exactly one argv token', () => {
      expect(
        claudeCodeHarness.buildLaunchArgv?.({
          sessionId: 's1',
          flags: "--append-system-prompt 'be brief; then stop'",
        }),
      ).toEqual(['claude', '--session-id', 's1', '--append-system-prompt', 'be brief; then stop']);
    });

    it('carries a hostile session id as one token — no shell syntax survives argv', () => {
      expect(claudeCodeHarness.buildLaunchArgv?.({ sessionId: '$(id); rm -rf /' })).toEqual([
        'claude',
        '--session-id',
        '$(id); rm -rf /',
      ]);
    });
  });

  describe('buildResumeArgv / buildContinueArgv', () => {
    it.each([
      [{ sessionId: 's1' }, ['claude', '--resume', 's1']],
      [{ sessionId: 's1', flags: ' --verbose' }, ['claude', '--resume', 's1', '--verbose']],
    ])('resume builds %j', (opts, expected) => {
      expect(claudeCodeHarness.buildResumeArgv?.(opts)).toEqual(expected);
    });

    it.each([
      [{ sessionId: 's1' }, ['claude', '--continue', '--session-id', 's1']],
      [
        { sessionId: 's1', flags: ' --verbose' },
        ['claude', '--continue', '--session-id', 's1', '--verbose'],
      ],
    ])('continue builds %j', (opts, expected) => {
      expect(claudeCodeHarness.buildContinueArgv?.(opts)).toEqual(expected);
    });
  });

  describe('model override on the argv path', () => {
    it.each([
      [{ sessionId: 's1', model: 'sonnet' }, ['claude', '--session-id', 's1', '--model', 'sonnet']],
      [
        { sessionId: 's1', flags: ' --model opus', model: 'sonnet' },
        ['claude', '--session-id', 's1', '--model', 'sonnet'],
      ],
      [
        {
          sessionId: 's1',
          flags: ' --dangerously-skip-permissions --model opus',
          model: 'sonnet',
        },
        ['claude', '--session-id', 's1', '--dangerously-skip-permissions', '--model', 'sonnet'],
      ],
      [
        { sessionId: 's1', flags: ' --model opus' },
        ['claude', '--session-id', 's1', '--model', 'opus'],
      ],
    ])('builds %j', (opts, expected) => {
      expect(claudeCodeHarness.buildLaunchArgv?.(opts)).toEqual(expected);
    });

    it('never quotes on the argv path — the value is one raw token', () => {
      expect(
        claudeCodeHarness.buildLaunchArgv?.({ sessionId: 's1', model: 'bad;rm -rf /' }),
      ).toEqual(['claude', '--session-id', 's1', '--model', 'bad;rm -rf /']);
    });

    it('resume and continue strip the flags --model too', () => {
      expect(
        claudeCodeHarness.buildResumeArgv?.({
          sessionId: 's1',
          flags: ' --model opus',
          model: 'sonnet',
        }),
      ).toEqual(['claude', '--resume', 's1', '--model', 'sonnet']);
      expect(
        claudeCodeHarness.buildContinueArgv?.({
          sessionId: 's1',
          flags: ' --model opus',
          model: 'sonnet',
        }),
      ).toEqual(['claude', '--continue', '--session-id', 's1', '--model', 'sonnet']);
    });
  });
});

describe('claudeCodeHarness engine metadata', () => {
  it('declares its instruction file', () => {
    expect(claudeCodeHarness.instructionFile).toBe('CLAUDE.md');
  });

  it('declares capabilities', () => {
    expect(claudeCodeHarness.capabilities).toEqual({
      contextUsage: true,
      sessionFork: true,
      setupHelper: false,
      acp: false,
    });
  });
});

describe('claudeCodeHarness.detectReady', () => {
  it.each([
    ['', 'starting'],
    ['  \n \n ', 'starting'],
    ['Welcome to Claude Code!', 'starting'],
    ['Loading plugins…', 'starting'],
    [
      'WARNING: Claude Code running in Bypass Permissions mode\n Yes, I accept',
      'permission_warning',
    ],
    ['Do you want to proceed?\n 1. Yes', 'permission_warning'],
    ['\u2502 > \u2502\n  ? for shortcuts', 'ready'],
    ['> ', 'ready'],
    ['> plan the migration', 'ready'],
    ['\u2733 Thinking… (12s · esc to interrupt)', 'unknown'],
  ])('classifies %j as %s', (pane, expected) => {
    expect(claudeCodeHarness.detectReady?.(pane)).toBe(expected);
  });

  it('the permission gate outranks a prompt line elsewhere in the pane', () => {
    expect(claudeCodeHarness.detectReady?.('> \nDo you want to proceed?')).toBe(
      'permission_warning',
    );
  });
});

describe('claudeCodeHarness.installHooks', () => {
  it('writes settings.local.json with token in URLs', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok-abc');
    const written = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(written.hooks.Stop[0].hooks[0].url).toBe(
      'http://127.0.0.1:7777/api/hooks/stop?token=tok-abc',
    );
    expect(written.permissions.allow).toContain('Bash(git diff:*)');
  });

  it("uninstallHooks strips our hooks but keeps the user's hooks and permissions", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok-abc');

    const settingsPath = path.join(tmp, '.claude', 'settings.local.json');
    const withUserHook = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    withUserHook.hooks.Stop.push({ hooks: [{ type: 'command', command: 'say done' }] });
    withUserHook.hooks.PreToolUse = [{ hooks: [{ type: 'command', command: 'lint' }] }];
    fs.writeFileSync(settingsPath, JSON.stringify(withUserHook), 'utf-8');

    await claudeCodeHarness.uninstallHooks(tmp);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(JSON.stringify(after)).not.toContain('/api/hooks/');
    expect(after.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }]);
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(after.hooks.UserPromptSubmit).toBeUndefined();
    expect(after.permissions.allow).toContain('Bash(git diff:*)');
  });

  it('uninstallHooks drops the hooks key entirely when only ours were there', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok-abc');
    await claudeCodeHarness.uninstallHooks(tmp);

    const after = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(after.hooks).toBeUndefined();
    expect(after.permissions.deny).toContain('Bash(rm -rf:*)');
  });

  it('uninstallHooks is a no-op when there is no settings file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    await expect(claudeCodeHarness.uninstallHooks(tmp)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(tmp, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('uri-encodes the token', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok&special=value');
    const written = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(written.hooks.Stop[0].hooks[0].url).toBe(
      'http://127.0.0.1:7777/api/hooks/stop?token=tok%26special%3Dvalue',
    );
  });

  it('forces editorMode: emacs so send-keys Enter submits (defeats global vim mode)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok');
    const written = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(written.editorMode).toBe('emacs');
  });

  it('preserves an explicit worktree editorMode', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({ editorMode: 'vim' }),
    );
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok');
    const written = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(written.editorMode).toBe('vim');
  });
});
