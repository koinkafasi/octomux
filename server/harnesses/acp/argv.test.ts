/**
 * `buildAcpArgv` — the three routes an engine takes into ACP mode (spec §2.2).
 *
 * Every expectation is an argv **array**. That is the point of the module: spec
 * §3 ("argv kararının gerekçesi") retires the hand-rolled shell quoting the
 * ported implementations used, so a test that asserted a joined string would be
 * asserting the thing being removed.
 */

import { describe, it, expect } from '../../bun-test.js';
import type { EnginePresetAcp } from '../preset-schema.js';
import { buildAcpArgv, AcpArgvError, type AcpArgvSource } from './argv.js';

/** The three shipped presets that carry an `acp` block, as of spec §3. */
const GEMINI: AcpArgvSource = {
  id: 'gemini',
  command: 'gemini',
  args: ['--approval-mode', 'yolo'],
  acp: { mode: 'flag', args: ['--acp'] },
};

const OPENCODE: AcpArgvSource = {
  id: 'opencode',
  command: 'opencode',
  args: [],
  acp: { mode: 'subcommand', args: ['acp'] },
};

const CLAUDE_CODE_ACP: AcpArgvSource = {
  id: 'claude-code-acp',
  command: 'claude',
  args: ['--permission-mode', 'bypassPermissions'],
  acp: { mode: 'native', args: ['claude-code-acp'] },
};

describe('buildAcpArgv', () => {
  describe('mode routing', () => {
    const cases: Array<{
      name: string;
      source: AcpArgvSource;
      extraArgs?: string[];
      expected: string[];
    }> = [
      {
        name: 'flag: preset args keep their place, the ACP flag is appended',
        source: GEMINI,
        expected: ['gemini', '--approval-mode', 'yolo', '--acp'],
      },
      {
        name: 'subcommand: the verb goes directly after the binary',
        source: OPENCODE,
        expected: ['opencode', 'acp'],
      },
      {
        name: 'subcommand: preset args follow the verb, never precede it',
        source: { ...OPENCODE, args: ['--print-logs'] },
        expected: ['opencode', 'acp', '--print-logs'],
      },
      {
        name: 'native: acp.args is the whole argv, command/args are dropped',
        source: CLAUDE_CODE_ACP,
        expected: ['claude-code-acp'],
      },
      {
        name: 'native: multi-token acp.args survives verbatim',
        source: {
          ...CLAUDE_CODE_ACP,
          acp: { mode: 'native', args: ['npx', '-y', '@zed-industries/claude-code-acp'] },
        },
        expected: ['npx', '-y', '@zed-industries/claude-code-acp'],
      },
      {
        name: 'flag: extraArgs land last',
        source: GEMINI,
        extraArgs: ['--model', 'gemini-2.5-pro'],
        expected: ['gemini', '--approval-mode', 'yolo', '--acp', '--model', 'gemini-2.5-pro'],
      },
      {
        name: 'subcommand: extraArgs land last',
        source: OPENCODE,
        extraArgs: ['--model', 'anthropic/claude-opus-4-8'],
        expected: ['opencode', 'acp', '--model', 'anthropic/claude-opus-4-8'],
      },
      {
        name: 'native: extraArgs land last',
        source: CLAUDE_CODE_ACP,
        extraArgs: ['--model', 'opus'],
        expected: ['claude-code-acp', '--model', 'opus'],
      },
      {
        name: 'missing `args` on the source is treated as empty',
        source: { id: 'gemini', command: 'gemini', acp: { mode: 'flag', args: ['--acp'] } },
        expected: ['gemini', '--acp'],
      },
      {
        name: 'empty extraArgs changes nothing',
        source: GEMINI,
        extraArgs: [],
        expected: ['gemini', '--approval-mode', 'yolo', '--acp'],
      },
    ];

    it.each(cases)('$name', ({ source, extraArgs, expected }) => {
      expect(buildAcpArgv(source, extraArgs ? { extraArgs } : {})).toEqual(expected);
    });
  });

  it('returns an array, not a shell string', () => {
    const argv = buildAcpArgv(GEMINI);
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.every((token) => typeof token === 'string')).toBe(true);
  });

  it('does not mutate the source preset', () => {
    const source: AcpArgvSource = {
      id: 'gemini',
      command: 'gemini',
      args: ['--approval-mode', 'yolo'],
      acp: { mode: 'flag', args: ['--acp'] },
    };
    buildAcpArgv(source, { extraArgs: ['--model', 'x'] });
    expect(source.args).toEqual(['--approval-mode', 'yolo']);
    expect(source.acp?.args).toEqual(['--acp']);
  });

  it('builds a fresh array on every call', () => {
    expect(buildAcpArgv(GEMINI)).not.toBe(buildAcpArgv(GEMINI));
  });

  describe('rejections', () => {
    const cases: Array<{
      name: string;
      source: AcpArgvSource;
      extraArgs?: string[];
      message: RegExp;
    }> = [
      {
        name: 'acp block is null',
        source: { id: 'aider', command: 'aider', args: ['--yes-always'], acp: null },
        message: /aider: no `acp` block — this engine does not speak ACP/,
      },
      {
        name: 'acp block is undefined',
        source: { id: 'amp', command: 'amp', acp: undefined as unknown as EnginePresetAcp },
        message: /amp: no `acp` block/,
      },
      {
        name: 'native with empty acp.args',
        source: { id: 'nativeless', command: 'x', acp: { mode: 'native', args: [] } },
        message: /`acp\.mode` is "native" but `acp\.args` is empty/,
      },
      {
        name: 'subcommand with empty acp.args',
        source: { id: 'verbless', command: 'x', acp: { mode: 'subcommand', args: [] } },
        message: /`acp\.mode` is "subcommand" but `acp\.args` is empty/,
      },
      {
        name: 'flag with empty acp.args',
        source: { id: 'flagless', command: 'x', acp: { mode: 'flag', args: [] } },
        message: /`acp\.mode` is "flag" but `acp\.args` is empty/,
      },
      {
        name: 'unknown mode',
        source: {
          id: 'martian',
          command: 'x',
          acp: { mode: 'telepathy', args: ['--think'] } as unknown as EnginePresetAcp,
        },
        message: /martian: unknown `acp\.mode` "telepathy"/,
      },
      {
        name: 'empty command token',
        source: { id: 'blank', command: '', acp: { mode: 'flag', args: ['--acp'] } },
        message: /blank: `argv\[0\]` is an empty string/,
      },
      {
        name: 'empty preset arg token',
        source: {
          id: 'gappy',
          command: 'gappy',
          args: [''],
          acp: { mode: 'flag', args: ['--acp'] },
        },
        message: /gappy: `argv\[1\]` is an empty string/,
      },
      {
        name: 'shell metacharacter in the command',
        source: { id: 'evil', command: 'gemini; rm -rf /', acp: { mode: 'flag', args: ['--acp'] } },
        message: /evil: `argv\[0\]` contains a forbidden shell metacharacter/,
      },
      {
        name: 'shell metacharacter in acp.args',
        source: { id: 'evil', command: 'gemini', acp: { mode: 'flag', args: ['--acp`whoami`'] } },
        message: /evil: `argv\[1\]` contains a forbidden shell metacharacter/,
      },
      {
        name: 'command substitution in extraArgs',
        source: GEMINI,
        extraArgs: ['--model', '$(cat /etc/passwd)'],
        message: /gemini: `argv\[5\]` contains a forbidden shell metacharacter/,
      },
      {
        name: 'pipe in extraArgs',
        source: OPENCODE,
        extraArgs: ['--model|tee'],
        message: /opencode: `argv\[2\]` contains a forbidden shell metacharacter/,
      },
      {
        name: 'newline in a native acp.arg',
        source: { id: 'multiline', command: 'x', acp: { mode: 'native', args: ['acp\nrm -rf /'] } },
        message: /multiline: `argv\[0\]` contains a forbidden shell metacharacter/,
      },
    ];

    it.each(cases)('$name', ({ source, extraArgs, message }) => {
      expect(() => buildAcpArgv(source, extraArgs ? { extraArgs } : {})).toThrow(AcpArgvError);
      expect(() => buildAcpArgv(source, extraArgs ? { extraArgs } : {})).toThrow(message);
    });

    it('names the engine by `command` when the source has no id', () => {
      expect(() => buildAcpArgv({ command: 'mystery', acp: null })).toThrow(
        /^mystery: no `acp` block/,
      );
    });

    it('carries the AcpArgvError name so callers can discriminate', () => {
      try {
        buildAcpArgv({ id: 'aider', command: 'aider', acp: null });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AcpArgvError);
        expect((err as AcpArgvError).name).toBe('AcpArgvError');
        expect(err).toBeInstanceOf(Error);
      }
    });
  });
});
