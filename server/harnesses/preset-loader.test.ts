import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';
import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import { getLogger, setLogger } from '../logger.js';
import {
  enginePresetsDir,
  getEnginePreset,
  listEnginePresets,
  loadEnginePresets,
} from './preset-loader.js';
import {
  ENGINE_PRESET_SCHEMA,
  PRESET_FORBIDDEN_RE,
  checkEnginePresetShape,
  checkShellSafe,
  type EnginePreset,
} from './preset-schema.js';

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

let tmpDir: string;

/** Write `data` (verbatim if a string) as `<tmpDir>/<name>`. */
function writePreset(name: string, data: unknown): void {
  fs.writeFileSync(
    path.join(tmpDir, name),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
  );
}

const MINIMAL = { id: 'minimal', displayName: 'Minimal Engine', command: 'minimal' };

/** Every field materialized from `MINIMAL` by the schema's defaults. */
const MINIMAL_DEFAULTED: EnginePreset = {
  id: 'minimal',
  displayName: 'Minimal Engine',
  command: 'minimal',
  args: [],
  env: {},
  processNames: [],
  resumeFlag: null,
  resumeStyle: 'flag',
  continueFlag: null,
  instructionFile: 'AGENTS.md',
  readyPromptPrefix: null,
  readyDelayMs: 0,
  emitsPermissionWarning: false,
  escapeCancelsRequest: false,
  hasTurnBoundaryDrain: false,
  hooks: { provider: null },
  mcp: null,
  acp: null,
  capabilities: { contextUsage: false, sessionFork: false, setupHelper: false, acp: false },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-engine-presets-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OCTOMUX_ENGINE_PRESETS_DIR;
});

describe('engine preset schema', () => {
  it('requires exactly id, displayName and command', () => {
    expect(ENGINE_PRESET_SCHEMA.required).toEqual(['id', 'displayName', 'command']);
  });

  it.each([
    { field: 'id', data: { displayName: 'X', command: 'x' } },
    { field: 'displayName', data: { id: 'x', command: 'x' } },
    { field: 'command', data: { id: 'x', displayName: 'X' } },
  ])('rejects a preset missing $field', ({ data }) => {
    const result = checkEnginePresetShape(data, 'x');
    expect(result.ok).toBe(false);
  });

  it('materializes every optional field from a minimal preset', () => {
    const result = checkEnginePresetShape(MINIMAL, 'minimal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preset).toEqual(MINIMAL_DEFAULTED);
    expect(result.warnings).toEqual([]);
  });

  it('does not mutate the caller-supplied object', () => {
    const input = { ...MINIMAL };
    checkEnginePresetShape(input, 'minimal');
    expect(input).toEqual(MINIMAL);
  });

  it.each([
    { name: 'not an object', data: 'nope' },
    { name: 'an array', data: [{ id: 'x' }] },
    { name: 'null', data: null },
    { name: 'unknown top-level field', data: { ...MINIMAL, id: 'x', nope: 1 } },
    { name: 'non-array args', data: { ...MINIMAL, id: 'x', args: '--yolo' } },
    { name: 'non-string arg element', data: { ...MINIMAL, id: 'x', args: [1] } },
    { name: 'bad resumeStyle', data: { ...MINIMAL, id: 'x', resumeStyle: 'argv' } },
    { name: 'bad mcp.inject', data: { ...MINIMAL, id: 'x', mcp: { inject: 'magic' } } },
    { name: 'bad acp.mode', data: { ...MINIMAL, id: 'x', acp: { mode: 'telepathy' } } },
    { name: 'acp without mode', data: { ...MINIMAL, id: 'x', acp: { args: ['--acp'] } } },
    { name: 'negative readyDelayMs', data: { ...MINIMAL, id: 'x', readyDelayMs: -1 } },
    { name: 'non-integer readyDelayMs', data: { ...MINIMAL, id: 'x', readyDelayMs: 1.5 } },
    { name: 'empty command', data: { ...MINIMAL, id: 'x', command: '' } },
    { name: 'non-string env value', data: { ...MINIMAL, id: 'x', env: { A: 1 } } },
    { name: 'invalid env var name', data: { ...MINIMAL, id: 'x', env: { 'a-b': 'c' } } },
    { name: 'uppercase id', data: { ...MINIMAL, id: 'X' } },
  ])('rejects $name', ({ data }) => {
    const result = checkEnginePresetShape(data, 'x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('rejects an expectedId that is not a valid engine id', () => {
    const result = checkEnginePresetShape(MINIMAL, 'Not An Id');
    expect(result.ok).toBe(false);
  });

  it('warns instead of rejecting when capabilities.acp disagrees with the acp block', () => {
    const result = checkEnginePresetShape(
      { ...MINIMAL, acp: { mode: 'flag', args: ['--acp'] } },
      'minimal',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(' ')).toContain('capabilities.acp');
  });
});

describe('engine preset shell safety', () => {
  // Same forbidden set as `validateFlagString()` in `server/harnesses/types.ts`.
  it.each([
    { name: 'backtick', bad: 'x`whoami`' },
    { name: 'semicolon', bad: 'x; rm -rf /' },
    { name: 'pipe', bad: 'x | tee /tmp/out' },
    { name: 'ampersand', bad: 'x & sleep 1' },
    { name: 'output redirect', bad: 'x > /tmp/out' },
    { name: 'input redirect', bad: 'x < /etc/passwd' },
    { name: 'newline', bad: 'x\nwhoami' },
    { name: 'carriage return', bad: 'x\rwhoami' },
    { name: 'command substitution', bad: 'x$(whoami)' },
  ])('flags $name in command', ({ bad }) => {
    expect(PRESET_FORBIDDEN_RE.test(bad)).toBe(true);
    expect(checkShellSafe(bad, 'command')).toContain('command');
    const result = checkEnginePresetShape({ ...MINIMAL, command: bad }, 'minimal');
    expect(result.ok).toBe(false);
  });

  it.each([
    { field: 'args', data: { args: ['--flag; rm -rf /'] } },
    { field: 'resumeFlag', data: { resumeFlag: '--resume`id`' } },
    { field: 'continueFlag', data: { continueFlag: '--continue|cat' } },
    { field: 'mcp.flag', data: { mcp: { inject: 'flag', flag: '--mcp>/tmp/x' } } },
    { field: 'acp.args', data: { acp: { mode: 'flag', args: ['--acp$(id)'] } } },
  ])('rejects a shell metacharacter in $field', ({ data }) => {
    const result = checkEnginePresetShape({ ...MINIMAL, ...data }, 'minimal');
    expect(result.ok).toBe(false);
  });

  it('allows an ordinary flag', () => {
    expect(checkShellSafe('--yolo', 'args[0]')).toBeNull();
  });
});

describe('loadEnginePresets', () => {
  it('loads a valid preset keyed by filename stem', () => {
    process.env.OCTOMUX_ENGINE_PRESETS_DIR = tmpDir;
    writePreset('minimal.json', MINIMAL);
    const map = loadEnginePresets();
    expect(map.get('minimal')).toEqual(MINIMAL_DEFAULTED);
    expect(getEnginePreset('minimal')).toEqual(MINIMAL_DEFAULTED);
    expect(listEnginePresets().map((p) => p.id)).toEqual(['minimal']);
  });

  it('ignores non-json files', () => {
    writePreset('README.md', 'not a preset');
    writePreset('minimal.json', MINIMAL);
    const map = loadEnginePresets(tmpDir);
    expect([...map.keys()]).toEqual(['minimal']);
  });

  it('returns an empty map when the directory does not exist', () => {
    const { result } = withCapturedLogs(() => loadEnginePresets(path.join(tmpDir, 'nope')));
    expect(result.size).toBe(0);
    expect(listEnginePresets()).toEqual([]);
  });

  it.each([
    { name: 'unparseable JSON', file: 'broken.json', body: '{ "id": "broken", ' },
    { name: 'schema violation', file: 'broken.json', body: JSON.stringify({ id: 'broken' }) },
    {
      name: 'a shell metacharacter',
      file: 'broken.json',
      body: JSON.stringify({ id: 'broken', displayName: 'B', command: 'b; rm -rf /' }),
    },
    {
      name: 'an unusable filename',
      file: 'Broken Engine.json',
      body: JSON.stringify({ id: 'broken', displayName: 'B', command: 'b' }),
    },
  ])('isolates $name — warns, skips, keeps loading the rest', ({ file, body }) => {
    writePreset(file, body);
    writePreset('minimal.json', MINIMAL);

    const { result, lines } = withCapturedLogs(() => loadEnginePresets(tmpDir));

    expect([...result.keys()]).toEqual(['minimal']);
    const warnings = lines.filter((l) => l.level === 40);
    expect(warnings.length).toBeGreaterThan(0);
    expect(String(warnings[0].msg)).toContain('skipped');
  });

  it('treats the filename as authoritative when `id` disagrees, and warns', () => {
    writePreset('renamed.json', { ...MINIMAL, id: 'minimal' });

    const { result, lines } = withCapturedLogs(() => loadEnginePresets(tmpDir));

    expect([...result.keys()]).toEqual(['renamed']);
    expect(result.get('renamed')?.id).toBe('renamed');
    const warned = lines.filter((l) => l.level === 40).map((l) => String(l.warning ?? ''));
    expect(warned.join(' ')).toContain('does not match filename');
  });

  it('never throws on a directory of nothing but garbage', () => {
    writePreset('a.json', '{{{');
    writePreset('b.json', '[]');
    writePreset('c.json', JSON.stringify({ id: 'c' }));
    const { result } = withCapturedLogs(() => loadEnginePresets(tmpDir));
    expect(result.size).toBe(0);
  });
});

describe('shipped presets', () => {
  it('loads every file under server/harnesses/presets without a warning', () => {
    const { result, lines } = withCapturedLogs(() => loadEnginePresets());
    expect(result.size).toBeGreaterThan(0);
    expect(lines.filter((l) => Number(l.level) >= 40)).toEqual([]);
  });

  it('resolves the shipped directory through assetRoot(), not __dirname', () => {
    expect(enginePresetsDir()).toBe(
      path.join(path.resolve(import.meta.dir, '..', '..'), 'server', 'harnesses', 'presets'),
    );
  });

  it('ships gemini as a tier-1 preset', () => {
    const gemini = loadEnginePresets().get('gemini');
    expect(gemini).toEqual({
      id: 'gemini',
      displayName: 'Gemini CLI',
      command: 'gemini',
      // Verified against the installed binary: `gemini --help` has no bare `--yolo`;
      // the flag is `--approval-mode <default|auto_edit|yolo|plan>`. See spec/engine-layer.md §3.
      args: ['--approval-mode', 'yolo'],
      env: {},
      processNames: ['gemini', 'node'],
      resumeFlag: '--resume',
      resumeStyle: 'flag',
      continueFlag: null,
      instructionFile: 'AGENTS.md',
      readyPromptPrefix: '> ',
      readyDelayMs: 1500,
      emitsPermissionWarning: false,
      escapeCancelsRequest: true,
      hasTurnBoundaryDrain: false,
      hooks: { provider: null },
      mcp: {
        inject: 'settings_file',
        settingsPath: '.gemini/settings.json',
        envVar: null,
        flag: null,
        transport: 'sse',
      },
      acp: { mode: 'flag', args: ['--acp'] },
      capabilities: { contextUsage: true, sessionFork: false, setupHelper: false, acp: true },
    });
  });
});
