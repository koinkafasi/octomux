import { describe, it, expect } from '../../bun-test.js';
import type { AgentEvent } from '../events.js';
import {
  PlainTextNormalizer,
  createPlainTextNormalizer,
  normalizePlainText,
  stripAnsi,
} from './plain-text.js';

/** Control bytes spelled out once, so the tables below stay readable. */
const ESC = '\u001B';
const BEL = '\u0007';
const CSI8 = '\u009B';
const ST8 = '\u009C';
const BS = '\u0008';
const DEL = '\u007F';
const NUL = '\u0000';

function texts(events: AgentEvent[]): string[] {
  return events.map((e) =>
    e.t === 'message' && e.content.type === 'text' ? e.content.text : `<${e.t}>`,
  );
}

// ─── stripAnsi ────────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it.each([
    ['plain prose', 'hello world', 'hello world'],
    ['the empty string', '', ''],
    ['unicode and emoji', 'ünïcödé ✅ 🐙', 'ünïcödé ✅ 🐙'],
    ['a tab, which is content', 'a\tb', 'a\tb'],
  ])('leaves %s alone', (_label, input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });

  it.each([
    ['a single SGR colour', `${ESC}[31mred${ESC}[0m`, 'red'],
    ['a multi-parameter SGR', `${ESC}[1;32;40mbold green${ESC}[0m`, 'bold green'],
    ['a 256-colour SGR', `${ESC}[38;5;200mpink${ESC}[39m`, 'pink'],
    ['a truecolour SGR', `${ESC}[38;2;255;0;0mred${ESC}[0m`, 'red'],
    ['cursor up', `${ESC}[2Ahi`, 'hi'],
    ['absolute cursor positioning', `${ESC}[10;20Hxy`, 'xy'],
    ['erase line', `${ESC}[2Kdone`, 'done'],
    ['home plus erase display', `${ESC}[H${ESC}[2Jcleared`, 'cleared'],
    ['a private-mode toggle (hide/show cursor)', `${ESC}[?25lspin${ESC}[?25h`, 'spin'],
    ['an 8-bit CSI introducer', `${CSI8}31mred`, 'red'],
    ['a scroll region', `${ESC}[1;40rtop`, 'top'],
  ])('strips %s', (_label, input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });

  it.each([
    [
      'an OSC window title whose payload contains spaces',
      `${ESC}]0;my window title${BEL}body`,
      'body',
    ],
    ['an OSC 7 cwd report', `${ESC}]7;file://host/some/dir${BEL}$ `, '$ '],
    [
      'an OSC 8 hyperlink terminated by ST',
      `${ESC}]8;;https://example.com/a b${ESC}\\link text${ESC}]8;;${ESC}\\`,
      'link text',
    ],
    ['an OSC terminated by the 8-bit ST', `${ESC}]0;title${ST8}after`, 'after'],
    ['an OSC with an empty payload', `${ESC}]0;${BEL}after`, 'after'],
    ['back-to-back OSC sequences', `${ESC}]0;a b${BEL}${ESC}]2;c d${BEL}rest`, 'rest'],
  ])('strips %s', (_label, input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });

  it.each([
    ['a charset designator', `${ESC}(Bplain`, 'plain'],
    ['a save-cursor two-character escape', `${ESC}7saved${ESC}8`, 'saved'],
    ['keypad mode', `${ESC}=on${ESC}>`, 'on'],
    ['reverse index', `${ESC}Mup`, 'up'],
  ])('strips %s', (_label, input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });

  it.each([
    ['a bare bell', `a${BEL}bc`, 'abc'],
    ['a backspace', `ab${BS}c`, 'abc'],
    ['a delete', `a${DEL}b`, 'ab'],
    ['a NUL', `a${NUL}b`, 'ab'],
    ['a carriage return', 'a\rb', 'ab'],
    ['an orphaned escape with no sequence', `a${ESC}`, 'a'],
  ])('strips %s', (_label, input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });

  it('reduces a line of pure escapes to the empty string', () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1G${ESC}[?25l`)).toBe('');
  });

  it('is idempotent', () => {
    const input = `${ESC}]0;title here${BEL}${ESC}[1;31mred${ESC}[0m${BEL}`;
    const once = stripAnsi(input);
    expect(stripAnsi(once)).toBe(once);
    expect(once).toBe('red');
  });

  it('is not affected by the global regexes holding a lastIndex', () => {
    const input = `${ESC}[31ma${ESC}[0m ${ESC}[32mb${ESC}[0m`;
    expect(stripAnsi(input)).toBe(stripAnsi(input));
    expect(stripAnsi(input)).toBe('a b');
  });
});

// ─── Line → message ───────────────────────────────────────────────────────────

describe('normalizePlainText', () => {
  it('turns each line into one assistant message', () => {
    const events = normalizePlainText('first\nsecond\nthird\n');
    expect(events).toEqual([
      { t: 'message', content: { type: 'text', text: 'first' }, role: 'assistant' },
      { t: 'message', content: { type: 'text', text: 'second' }, role: 'assistant' },
      { t: 'message', content: { type: 'text', text: 'third' }, role: 'assistant' },
    ]);
  });

  it('strips escapes on the way through', () => {
    expect(texts(normalizePlainText(`${ESC}[32mBuild succeeded${ESC}[0m\n`))).toEqual([
      'Build succeeded',
    ]);
  });

  it('emits the trailing line even without a final newline', () => {
    expect(texts(normalizePlainText('a\nb'))).toEqual(['a', 'b']);
  });

  it.each([
    ['LF', 'a\nb\n'],
    ['CRLF', 'a\r\nb\r\n'],
  ])('handles %s line endings identically', (_label, input) => {
    expect(texts(normalizePlainText(input))).toEqual(['a', 'b']);
  });

  it('drops blank and escape-only lines by default', () => {
    const input = `alpha\n\n   \n${ESC}[2K\nbeta\n`;
    expect(texts(normalizePlainText(input))).toEqual(['alpha', 'beta']);
  });

  it('keeps blank lines when asked', () => {
    const input = `alpha\n\n  \nbeta\n`;
    expect(texts(normalizePlainText(input, { keepBlankLines: true }))).toEqual([
      'alpha',
      '',
      '  ',
      'beta',
    ]);
  });

  it.each([
    ['assistant by default', undefined, 'assistant'],
    ['assistant when asked', 'assistant' as const, 'assistant'],
    ['user when asked', 'user' as const, 'user'],
  ])('tags the stream as %s', (_label, role, expected) => {
    const events = normalizePlainText('line\n', role ? { role } : undefined);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: 'message', role: expected });
  });

  it('never invents a tool_call, usage, or done event', () => {
    const input = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      'Running: bash -c "make test"',
      'tokens used: 1234',
      'Done.',
    ].join('\n');
    const events = normalizePlainText(`${input}\n`);
    expect(new Set(events.map((e) => e.t))).toEqual(new Set(['message']));
    expect(events).toHaveLength(4);
  });

  it('returns nothing for an empty stream', () => {
    expect(normalizePlainText('')).toEqual([]);
  });
});

// ─── Chunking ─────────────────────────────────────────────────────────────────

describe('PlainTextNormalizer chunking', () => {
  it('holds a line back until its newline arrives', () => {
    const n = new PlainTextNormalizer();
    expect(n.push('half a ')).toEqual([]);
    expect(texts(n.push('line\n'))).toEqual(['half a line']);
  });

  it('reassembles an escape sequence split across chunks', () => {
    const n = new PlainTextNormalizer();
    expect(n.push(`ok ${ESC}[3`)).toEqual([]);
    expect(texts(n.push('1mred\n'))).toEqual(['ok red']);
  });

  it('reassembles an OSC payload split across chunks', () => {
    const n = new PlainTextNormalizer();
    expect(n.push(`${ESC}]0;my win`)).toEqual([]);
    expect(texts(n.push(`dow title${BEL}body\n`))).toEqual(['body']);
  });

  it('handles a CRLF whose CR and LF land in different chunks', () => {
    const n = new PlainTextNormalizer();
    expect(n.push('alpha\r')).toEqual([]);
    expect(texts(n.push('\nbeta\n'))).toEqual(['alpha', 'beta']);
  });

  it.each([1, 2, 3, 5, 8, 13])('produces the same events fed %i byte(s) at a time', (size) => {
    const input = `first${ESC}[0m\r\n\nsecond line\n${ESC}]0;t i t l e${BEL}third\ntail`;
    const whole = normalizePlainText(input);
    const n = new PlainTextNormalizer();
    const out: AgentEvent[] = [];
    for (let i = 0; i < input.length; i += size) out.push(...n.push(input.slice(i, i + size)));
    out.push(...n.flush());
    expect(out).toEqual(whole);
    expect(texts(whole)).toEqual(['first', 'second line', 'third', 'tail']);
  });
});

// ─── flush ────────────────────────────────────────────────────────────────────

describe('PlainTextNormalizer flush', () => {
  it('emits the newline-less remainder', () => {
    const n = new PlainTextNormalizer();
    n.push('a\ntail');
    expect(texts(n.flush())).toEqual(['tail']);
  });

  it('returns nothing on an untouched normalizer', () => {
    expect(new PlainTextNormalizer().flush()).toEqual([]);
  });

  it('returns nothing when the stream ended on a newline', () => {
    const n = new PlainTextNormalizer();
    n.push('a\n');
    expect(n.flush()).toEqual([]);
  });

  it('is idempotent', () => {
    const n = new PlainTextNormalizer();
    n.push('tail');
    expect(texts(n.flush())).toEqual(['tail']);
    expect(n.flush()).toEqual([]);
  });

  it('drops a remainder that is only escapes', () => {
    const n = new PlainTextNormalizer();
    n.push(`${ESC}[2K`);
    expect(n.flush()).toEqual([]);
  });

  it('keeps an escape-only remainder when keepBlankLines is set', () => {
    const n = new PlainTextNormalizer({ keepBlankLines: true });
    n.push(`${ESC}[2K`);
    expect(texts(n.flush())).toEqual(['']);
  });
});

// ─── Factory ──────────────────────────────────────────────────────────────────

describe('createPlainTextNormalizer', () => {
  it('hands back a fresh instance each call', () => {
    const a = createPlainTextNormalizer();
    expect(a).not.toBe(createPlainTextNormalizer());
    expect(a).toBeInstanceOf(PlainTextNormalizer);
  });

  it('forwards its options', () => {
    const n = createPlainTextNormalizer({ role: 'user', keepBlankLines: true });
    expect(n.push('a\n\n')).toEqual([
      { t: 'message', content: { type: 'text', text: 'a' }, role: 'user' },
      { t: 'message', content: { type: 'text', text: '' }, role: 'user' },
    ]);
  });

  it('does not share state between instances', () => {
    const a = createPlainTextNormalizer();
    const b = createPlainTextNormalizer();
    a.push('partial');
    expect(b.flush()).toEqual([]);
    expect(texts(a.flush())).toEqual(['partial']);
  });
});
