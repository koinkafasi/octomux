import path from 'path';
import pino from 'pino';
import { describe, it, expect, afterEach } from '../bun-test.js';
import { getLogger, setLogger } from '../logger.js';
import { createHarnessFromPreset } from './preset-harness.js';
import { loadEnginePresets } from './preset-loader.js';
import { checkEnginePresetShape, type EnginePreset } from './preset-schema.js';
import {
  claudeCodeHarness,
  cursorHarness,
  freezeCoreHarnesses,
  getHarness,
  listHarnesses,
  registerHarness,
  resetHarnesses,
} from './index.js';
import type { Harness } from './types.js';

/** Collect pino JSON log lines into memory for assertions. */
function bufferStream() {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    lines(): Array<Record<string, unknown>> {
      return chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

/** Run `fn` with the root logger swapped for a buffered one, then restore it. */
function withCapturedLogs<T>(fn: () => T): { result: T; lines: Array<Record<string, unknown>> } {
  const original = getLogger();
  const buf = bufferStream();
  setLogger(pino({ level: 'trace' }, buf.stream));
  try {
    return { result: fn(), lines: buf.lines() };
  } finally {
    setLogger(original);
  }
}

/**
 * The shipped presets, read from the repo tree (not the module-level cache), so
 * these goldens fail the moment a preset file changes shape.
 */
const PRESETS_DIR = path.join(import.meta.dir, 'presets');
const SHIPPED = loadEnginePresets(PRESETS_DIR);

/** Build a preset from a partial literal, materializing schema defaults. */
function makePreset(input: Record<string, unknown> & { id: string }): EnginePreset {
  const result = checkEnginePresetShape(
    { displayName: input.id, command: input.id, ...input },
    input.id,
  );
  if (!result.ok) throw new Error(`test preset "${input.id}" is invalid: ${result.error}`);
  return result.preset;
}

function harnessFor(id: string): Harness {
  const preset = SHIPPED.get(id);
  if (!preset) throw new Error(`no shipped preset "${id}" — known: ${[...SHIPPED.keys()]}`);
  return createHarnessFromPreset(preset);
}

const LAUNCH = { sessionId: 'sess-1' };

describe('createHarnessFromPreset — shipped presets', () => {
  it('loads all nine tier-1 presets', () => {
    expect([...SHIPPED.keys()].sort()).toEqual([
      'aider',
      'amp',
      'copilot',
      'droid',
      'gemini',
      'goose',
      'opencode',
      'pi',
      'qwen',
    ]);
  });

  // Golden launch argv — asserted as an ARRAY, never a string, so a change in
  // token order or a stray space can't hide behind shell quoting.
  it.each([
    { id: 'aider', argv: ['aider', '--yes-always', '--no-auto-commits'] },
    { id: 'amp', argv: ['amp', '--yes'] },
    { id: 'copilot', argv: ['copilot', '--allow-all-tools'] },
    { id: 'droid', argv: ['droid', '--autonomy', 'skip-permissions-unsafe'] },
    { id: 'gemini', argv: ['gemini', '--approval-mode', 'yolo'] },
    { id: 'goose', argv: ['goose'] },
    { id: 'opencode', argv: ['opencode'] },
    { id: 'pi', argv: ['pi'] },
    { id: 'qwen', argv: ['qwen', '--approval-mode', 'yolo'] },
  ])('$id builds the expected launch argv', ({ id, argv }) => {
    expect(harnessFor(id).buildLaunchArgv!(LAUNCH)).toEqual(argv);
  });

  it.each([
    { id: 'aider', displayName: 'Aider', instructionFile: 'CONVENTIONS.md' },
    { id: 'amp', displayName: 'Amp', instructionFile: '.amp/AGENT.md' },
    {
      id: 'copilot',
      displayName: 'GitHub Copilot CLI',
      instructionFile: '.github/copilot-instructions.md',
    },
    { id: 'droid', displayName: 'Factory Droid', instructionFile: 'AGENTS.md' },
    { id: 'gemini', displayName: 'Gemini CLI', instructionFile: 'AGENTS.md' },
    { id: 'goose', displayName: 'Goose', instructionFile: '.goosehints' },
    { id: 'opencode', displayName: 'OpenCode', instructionFile: 'AGENTS.md' },
    { id: 'pi', displayName: 'Pi', instructionFile: 'AGENTS.md' },
    { id: 'qwen', displayName: 'Qwen Code', instructionFile: 'AGENTS.md' },
  ])('$id carries identity straight off the preset', ({ id, displayName, instructionFile }) => {
    const h = harnessFor(id);
    expect(h.id).toBe(id);
    expect(h.displayName).toBe(displayName);
    expect(h.instructionFile).toBe(instructionFile);
    // No preset field describes a "start with this session id" flag.
    expect(h.sessionIdMode).toBe('harness-issued');
  });

  it.each([...SHIPPED.keys()].sort())('%s copies the preset capability flags', (id) => {
    expect(harnessFor(id).capabilities).toEqual(SHIPPED.get(id)!.capabilities);
  });

  it.each([...SHIPPED.keys()].sort())('%s renders its launch command from its argv', (id) => {
    const h = harnessFor(id);
    expect(h.buildLaunchCommand(LAUNCH)).toBe(h.buildLaunchArgv!(LAUNCH).join(' '));
  });

  // gemini is the only shipped preset with a resumeFlag.
  it('gemini resumes with --resume <id> after its always-on args', () => {
    expect(harnessFor('gemini').buildResumeArgv!({ sessionId: 'abc-123' })).toEqual([
      'gemini',
      '--approval-mode',
      'yolo',
      '--resume',
      'abc-123',
    ]);
  });

  it.each(['aider', 'amp', 'copilot', 'droid', 'goose', 'opencode', 'pi', 'qwen'])(
    '%s throws on resume — its preset declares no resumeFlag',
    (id) => {
      expect(() => harnessFor(id).buildResumeArgv!({ sessionId: 'x' })).toThrow(
        /does not support resuming a session/,
      );
    },
  );

  it.each([...SHIPPED.keys()].sort())('%s has no continue path (continueFlag is null)', (id) => {
    const h = harnessFor(id);
    expect(h.buildContinueArgv!({ sessionId: 'x' })).toBeNull();
    expect(h.buildContinueCommand({ sessionId: 'x' })).toBeNull();
  });
});

describe('createHarnessFromPreset — flags and model', () => {
  const preset = makePreset({ id: 'flagtest', command: 'flagtest', args: ['--yolo'] });
  const h = createHarnessFromPreset(preset);

  it('tokenizes the resolved flags string into argv', () => {
    expect(h.buildLaunchArgv!({ ...LAUNCH, flags: ' --verbose --dir /tmp/a b' })).toEqual([
      'flagtest',
      '--yolo',
      '--verbose',
      '--dir',
      '/tmp/a',
      'b',
    ]);
  });

  it('keeps a quoted flag value as one argv token', () => {
    expect(h.buildLaunchArgv!({ ...LAUNCH, flags: "--prompt 'hello there'" })).toEqual([
      'flagtest',
      '--yolo',
      '--prompt',
      'hello there',
    ]);
  });

  it('appends the per-task model', () => {
    expect(h.buildLaunchArgv!({ ...LAUNCH, model: 'gpt-5-codex' })).toEqual([
      'flagtest',
      '--yolo',
      '--model',
      'gpt-5-codex',
    ]);
  });

  it('replaces a --model already present in the flags', () => {
    expect(h.buildLaunchArgv!({ ...LAUNCH, flags: '--model old --verbose', model: 'new' })).toEqual(
      ['flagtest', '--yolo', '--verbose', '--model', 'new'],
    );
  });

  it('replaces a --model baked into the preset args', () => {
    const baked = createHarnessFromPreset(
      makePreset({ id: 'baked', command: 'baked', args: ['--model', 'preset-default', '--yolo'] }),
    );
    expect(baked.buildLaunchArgv!({ ...LAUNCH, model: 'override' })).toEqual([
      'baked',
      '--yolo',
      '--model',
      'override',
    ]);
  });

  it('quotes a flag value that would otherwise break the command string', () => {
    const argv = h.buildLaunchArgv!({ ...LAUNCH, flags: "--prompt 'hello there'" });
    expect(argv).toContain('hello there');
    expect(h.buildLaunchCommand({ ...LAUNCH, flags: "--prompt 'hello there'" })).toBe(
      "flagtest --yolo --prompt 'hello there'",
    );
  });
});

describe('createHarnessFromPreset — resumeStyle', () => {
  const flagStyle = createHarnessFromPreset(
    makePreset({
      id: 'flagstyle',
      command: 'eng',
      args: ['--yolo'],
      resumeFlag: '--resume',
      resumeStyle: 'flag',
      continueFlag: '--continue',
    }),
  );
  const subcommandStyle = createHarnessFromPreset(
    makePreset({
      id: 'substyle',
      command: 'eng',
      args: ['--full-auto'],
      resumeFlag: 'resume',
      resumeStyle: 'subcommand',
      continueFlag: 'continue',
    }),
  );

  it('flag style puts the resume option after the always-on args', () => {
    expect(flagStyle.buildResumeArgv!({ sessionId: 's1' })).toEqual([
      'eng',
      '--yolo',
      '--resume',
      's1',
    ]);
  });

  it('subcommand style puts the verb first, before any option', () => {
    expect(subcommandStyle.buildResumeArgv!({ sessionId: 's1' })).toEqual([
      'eng',
      'resume',
      's1',
      '--full-auto',
    ]);
  });

  it.each([
    { style: 'flag', h: flagStyle, argv: ['eng', '--yolo', '--resume', 's1', '--verbose'] },
    {
      style: 'subcommand',
      h: subcommandStyle,
      argv: ['eng', 'resume', 's1', '--full-auto', '--verbose'],
    },
  ])('$style style appends resolved flags last', ({ h, argv }) => {
    expect(h.buildResumeArgv!({ sessionId: 's1', flags: '--verbose' })).toEqual(argv);
  });

  it.each([
    { style: 'flag', h: flagStyle, argv: ['eng', '--yolo', '--continue'] },
    { style: 'subcommand', h: subcommandStyle, argv: ['eng', 'continue', '--full-auto'] },
  ])('$style style continue omits the session id', ({ h, argv }) => {
    expect(h.buildContinueArgv!({ sessionId: 'ignored' })).toEqual(argv);
  });

  it('renders resume and continue commands from the same argv', () => {
    expect(flagStyle.buildResumeCommand({ sessionId: 's1' })).toBe('eng --yolo --resume s1');
    expect(flagStyle.buildContinueCommand({ sessionId: 's1' })).toBe('eng --yolo --continue');
  });

  it('names the harness in the "no resumeFlag" error', () => {
    const noResume = createHarnessFromPreset(makePreset({ id: 'noresume', command: 'nr' }));
    expect(() => noResume.buildResumeArgv!({ sessionId: 's1' })).toThrow(
      /Harness "noresume" does not support resuming a session/,
    );
  });
});

describe('createHarnessFromPreset — detectReady', () => {
  const withPrompt = createHarnessFromPreset(
    makePreset({ id: 'prompted', command: 'p', readyPromptPrefix: '> ' }),
  );
  const silent = createHarnessFromPreset(makePreset({ id: 'silent', command: 's' }));
  const gated = createHarnessFromPreset(
    makePreset({ id: 'gated', command: 'g', emitsPermissionWarning: true }),
  );

  it.each([
    { name: 'empty', content: '' },
    { name: 'whitespace only', content: '  \n \n' },
  ])('$name pane is starting', ({ content }) => {
    expect(withPrompt.detectReady!(content)).toBe('starting');
    expect(silent.detectReady!(content)).toBe('starting');
  });

  it.each([
    { name: 'bare prompt line', content: 'some output\n> ' },
    { name: 'trailing space stripped by capture-pane', content: 'some output\n>' },
    { name: 'prompt with typed text', content: '> hello' },
    { name: 'prompt inside a TUI box', content: '│ > hello                    │' },
  ])('$name reads as ready', ({ content }) => {
    expect(withPrompt.detectReady!(content)).toBe('ready');
  });

  it('non-prompt output is unknown', () => {
    expect(withPrompt.detectReady!('thinking about your request')).toBe('unknown');
  });

  it('a preset with no readyPromptPrefix can never report ready', () => {
    expect(silent.detectReady!('> ')).toBe('unknown');
    expect(silent.detectReady!('anything at all')).toBe('unknown');
  });

  it('emitsPermissionWarning gates the permission classification', () => {
    const banner = 'Do you trust the authors of files in this folder?';
    expect(gated.detectReady!(banner)).toBe('permission_warning');
    // Same banner, opted out — the regex never runs.
    expect(silent.detectReady!(banner)).toBe('unknown');
  });

  it('permission warning wins over a ready prompt on the same pane', () => {
    const both = createHarnessFromPreset(
      makePreset({
        id: 'both',
        command: 'b',
        readyPromptPrefix: '> ',
        emitsPermissionWarning: true,
      }),
    );
    expect(both.detectReady!('Do you want to proceed?\n> ')).toBe('permission_warning');
  });
});

describe('createHarnessFromPreset — hooks, settings, ids', () => {
  const preset = makePreset({ id: 'hooktest', command: 'h' });
  const h = createHarnessFromPreset(preset);

  it('installHooks/uninstallHooks are no-ops when hooks.provider is null', async () => {
    // Nothing to assert on disk precisely because nothing is written: these
    // resolve without touching the filesystem, and uninstall is safe to call
    // on a directory that never had hooks.
    await expect(
      h.installHooks('/nonexistent/worktree', 'http://127.0.0.1:7777', 't'),
    ).resolves.toBeUndefined();
    await expect(h.uninstallHooks('/nonexistent/worktree')).resolves.toBeUndefined();
  });

  it('warns instead of pretending when a preset names an unsupported hook provider', async () => {
    const provided = createHarnessFromPreset(
      makePreset({ id: 'hooked', command: 'hk', hooks: { provider: 'imaginary' } }),
    );
    const original = getLogger();
    const buf = bufferStream();
    setLogger(pino({ level: 'trace' }, buf.stream));
    try {
      await provided.installHooks('/tmp/x', 'http://127.0.0.1:7777', 'token');
    } finally {
      setLogger(original);
    }
    const warn = buf
      .lines()
      .find(
        (l) =>
          l.msg === 'preset declares a hook provider octomux cannot install — skipping hook setup',
      );
    expect(warn).toBeDefined();
    expect(warn!.harness_id).toBe('hooked');
    expect(warn!.provider).toBe('imaginary');
  });

  it('resolveFlags reads harnesses.<id>.flags', () => {
    expect(h.resolveFlags({ harnesses: { hooktest: { flags: '--verbose' } } } as never)).toBe(
      ' --verbose',
    );
    expect(h.resolveFlags({ harnesses: {} } as never)).toBe('');
  });

  it('resolveFlags rejects shell metacharacters', () => {
    expect(() =>
      h.resolveFlags({ harnesses: { hooktest: { flags: '--x; rm -rf /' } } } as never),
    ).toThrow(/forbidden shell metacharacter/);
  });

  it('validateSettings accepts flags and rejects anything else', () => {
    expect(h.validateSettings({ flags: '--verbose' })).toEqual({ flags: '--verbose' });
    expect(() => h.validateSettings({ nope: 1 })).toThrow(/unknown key "nope"/);
    expect(() => h.validateSettings({ flags: '--x `id`' })).toThrow(
      /forbidden shell metacharacter/,
    );
  });

  it('validateAgentName uses the shared rule', () => {
    expect(h.validateAgentName('reviewer')).toBe('reviewer');
    expect(() => h.validateAgentName('bad name')).toThrow(/Invalid agent name/);
  });

  it('newSessionId issues a uuid', () => {
    expect(h.newSessionId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.newSessionId()).not.toBe(h.newSessionId());
  });
});

describe('registry wiring', () => {
  /** Put the registry back the way `index.js` leaves it at boot. */
  function seedRegistry(): void {
    resetHarnesses();
    registerHarness(claudeCodeHarness);
    registerHarness(cursorHarness);
    for (const preset of SHIPPED.values()) registerHarness(createHarnessFromPreset(preset));
    freezeCoreHarnesses();
  }

  afterEach(seedRegistry);

  it('importing the barrel registers both core harnesses plus all nine presets', () => {
    expect(
      listHarnesses()
        .map((x) => x.id)
        .sort(),
    ).toEqual([
      'aider',
      'amp',
      'claude-code',
      'copilot',
      'cursor',
      'droid',
      'gemini',
      'goose',
      'opencode',
      'pi',
      'qwen',
    ]);
  });

  it.each([...SHIPPED.keys()].sort())('%s is reachable through getHarness', (id) => {
    expect(getHarness(id).id).toBe(id);
  });

  it('a preset claiming a core id loses to the real adapter (pre-freeze duplicate guard)', () => {
    // Reproduces the real boot order from `index.ts`: core adapters register
    // first, presets second, freeze last. A preset file named `claude-code.json`
    // therefore hits the DUPLICATE guard, not the freeze guard — the freeze
    // hasn't happened yet — and the registry keeps the first registration.
    resetHarnesses();
    registerHarness(claudeCodeHarness);
    registerHarness(cursorHarness);

    const impostor = createHarnessFromPreset(
      makePreset({ id: 'claude-code', displayName: 'Impostor', command: 'not-claude' }),
    );
    const { lines } = withCapturedLogs(() => registerHarness(impostor));

    expect(getHarness('claude-code')).toBe(claudeCodeHarness);
    expect(getHarness('claude-code').displayName).toBe('Claude Code');
    const dupLine = lines.find(
      (l) => l.msg === 'harness already registered, keeping first registration',
    );
    expect(dupLine).toBeDefined();
    expect(dupLine!.harness_id).toBe('claude-code');
  });

  it.each(['claude-code', 'cursor'])(
    'a preset claiming %s is refused even after the freeze',
    (coreId) => {
      seedRegistry(); // registers everything and freezes, as boot does
      const before = getHarness(coreId);

      const impostor = createHarnessFromPreset(
        makePreset({ id: coreId, displayName: 'Impostor', command: 'not-core' }),
      );
      const { lines } = withCapturedLogs(() => registerHarness(impostor));

      expect(getHarness(coreId)).toBe(before);
      const freezeLine = lines.find(
        (l) => l.msg === 'refusing to redefine core harness after freeze',
      );
      expect(freezeLine).toBeDefined();
      expect(freezeLine!.harness_id).toBe(coreId);
    },
  );
});
