import { describe, it, expect } from '../bun-test.js';
import {
  AGENT_EVENT_KINDS,
  LineBuffer,
  isAgentEvent,
  textBlock,
  type AgentEvent,
  type AgentEventKind,
} from './events.js';

/**
 * One well-formed sample per variant. Doubles as the guard that the union has not
 * silently grown: the coverage test below compares its keys against
 * `AGENT_EVENT_KINDS`, so a new kind fails here until it is given a sample.
 */
const SAMPLES: Record<AgentEventKind, AgentEvent> = {
  session_start: { t: 'session_start', sessionId: '78d07962-2644-419f-bbee-4215e4fa8f05' },
  message: { t: 'message', content: textBlock('hello'), role: 'assistant' },
  thought: { t: 'thought', content: textBlock('let me check the schema first') },
  tool_call: {
    t: 'tool_call',
    call: {
      toolCallId: 'toolu_01',
      title: 'Read design doc',
      kind: 'execute',
      status: 'in_progress',
      toolName: 'Bash',
    },
  },
  tool_update: {
    t: 'tool_update',
    update: { toolCallId: 'toolu_01', status: 'completed', content: [textBlock('ok')] },
  },
  plan: {
    t: 'plan',
    plan: { entries: [{ content: 'write the tests', status: 'in_progress', priority: 'high' }] },
  },
  request_permission: {
    t: 'request_permission',
    req: {
      requestId: 'req_1',
      toolCall: { toolCallId: 'toolu_02', title: 'Bash', kind: 'execute', status: 'pending' },
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
    },
  },
  usage: { t: 'usage', inputTokens: 8865, outputTokens: 897, model: 'claude-opus-4-8' },
  error: { t: 'error', message: 'boom' },
  done: { t: 'done', reason: 'stop_hook_summary' },
};

/**
 * The one field `isAgentEvent` insists on per variant. Mirrors the module's private
 * `REQUIRED_FIELD` table on purpose — it is the published contract of the guard, so
 * a change to it should have to be made in two places.
 */
const PAYLOAD_FIELD: Record<AgentEventKind, string> = {
  session_start: 'sessionId',
  message: 'content',
  thought: 'content',
  tool_call: 'call',
  tool_update: 'update',
  plan: 'plan',
  request_permission: 'req',
  usage: 'model',
  error: 'message',
  done: 'reason',
};

describe('AGENT_EVENT_KINDS', () => {
  it('is exactly the ten-variant vocabulary from spec/engine-layer.md §2.3', () => {
    expect([...AGENT_EVENT_KINDS]).toEqual([
      'session_start',
      'message',
      'thought',
      'tool_call',
      'tool_update',
      'plan',
      'request_permission',
      'usage',
      'error',
      'done',
    ]);
  });

  it('has no duplicate discriminants', () => {
    expect(new Set(AGENT_EVENT_KINDS).size).toBe(AGENT_EVENT_KINDS.length);
  });

  it('has a sample for every kind (guards the tables below against a new variant)', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...AGENT_EVENT_KINDS].sort());
  });
});

describe('textBlock', () => {
  it.each(['hello', '', 'multi\nline', '  padded  '])('wraps %j as a text block', (text) => {
    expect(textBlock(text)).toEqual({ type: 'text', text });
  });

  it('returns a fresh object each call', () => {
    expect(textBlock('a')).not.toBe(textBlock('a'));
  });
});

describe('isAgentEvent', () => {
  it.each(AGENT_EVENT_KINDS.map((kind) => [kind, SAMPLES[kind]] as const))(
    'accepts a well-formed %s event',
    (_kind, event) => {
      expect(isAgentEvent(event)).toBe(true);
    },
  );

  // Only the discriminant and the one payload field are checked — the guard is a
  // boundary filter, not a deep validator, so extra keys must not disqualify.
  it.each(AGENT_EVENT_KINDS.map((kind) => [kind, SAMPLES[kind]] as const))(
    'accepts a %s event carrying unknown extra keys',
    (_kind, event) => {
      expect(isAgentEvent({ ...event, somethingElse: 1 })).toBe(true);
    },
  );

  it.each(
    AGENT_EVENT_KINDS.map((kind) => {
      const event = { ...SAMPLES[kind] } as Record<string, unknown>;
      delete event[PAYLOAD_FIELD[kind]];
      return [kind, event] as const;
    }),
  )('rejects a %s event missing its payload field', (_kind, event) => {
    expect(isAgentEvent(event)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'message'],
    ['a boolean', true],
    ['an array', []],
    ['an empty object', {}],
    ['an unknown discriminant', { t: 'nope', content: textBlock('x') }],
    ['a non-string discriminant', { t: 123, content: textBlock('x') }],
    ['a missing discriminant', { content: textBlock('x') }],
    ['the kind list itself', AGENT_EVENT_KINDS],
    ['a payload field on the wrong variant', { t: 'done', message: 'boom' }],
    ['a nested event', { event: SAMPLES.done }],
  ])('rejects %s', (_label, value) => {
    expect(isAgentEvent(value)).toBe(false);
  });

  it('narrows the type for a consumer', () => {
    const value: unknown = SAMPLES.usage;
    expect(isAgentEvent(value) && value.t === 'usage' && value.model).toBe('claude-opus-4-8');
  });
});

describe('LineBuffer', () => {
  it('returns the lines a newline-terminated chunk completes', () => {
    const buf = new LineBuffer();
    expect(buf.push('alpha\nbeta\n')).toEqual(['alpha', 'beta']);
    expect(buf.pending).toBe('');
  });

  it('holds back a trailing partial line', () => {
    const buf = new LineBuffer();
    expect(buf.push('alpha\nbet')).toEqual(['alpha']);
    expect(buf.pending).toBe('bet');
  });

  it('returns nothing and buffers everything when the chunk has no newline', () => {
    const buf = new LineBuffer();
    expect(buf.push('no newline here')).toEqual([]);
    expect(buf.pending).toBe('no newline here');
  });

  it('completes a line split across two chunks', () => {
    const buf = new LineBuffer();
    expect(buf.push('{"type":"assi')).toEqual([]);
    expect(buf.push('stant"}\n')).toEqual(['{"type":"assistant"}']);
    expect(buf.pending).toBe('');
  });

  it('completes a line split across many chunks', () => {
    const buf = new LineBuffer();
    const out: string[] = [];
    for (const chunk of ['a', 'b', 'c', '\n', 'd']) out.push(...buf.push(chunk));
    expect(out).toEqual(['abc']);
    expect(buf.pending).toBe('d');
  });

  it.each([
    ['CRLF throughout', 'alpha\r\nbeta\r\n', ['alpha', 'beta']],
    ['mixed CRLF and LF', 'alpha\r\nbeta\n', ['alpha', 'beta']],
    ['blank lines preserved', 'a\n\nb\n', ['a', '', 'b']],
    ['a lone newline', '\n', ['']],
    ['a lone CRLF', '\r\n', ['']],
    ['inner carriage returns kept', 'a\rb\n', ['a\rb']],
  ])('normalises %s', (_label, chunk, expected) => {
    expect(new LineBuffer().push(chunk)).toEqual(expected);
  });

  it('strips a CR that arrives in a later chunk than its line', () => {
    const buf = new LineBuffer();
    expect(buf.push('alpha\r')).toEqual([]);
    expect(buf.pending).toBe('alpha\r');
    expect(buf.push('\nbeta')).toEqual(['alpha']);
  });

  it('flush returns the held-back remainder and clears the buffer', () => {
    const buf = new LineBuffer();
    buf.push('alpha\ntail');
    expect(buf.flush()).toBe('tail');
    expect(buf.pending).toBe('');
  });

  it('flush strips a trailing CR from the remainder', () => {
    const buf = new LineBuffer();
    buf.push('tail\r');
    expect(buf.flush()).toBe('tail');
  });

  it.each([
    ['a fresh buffer', ''],
    ['a buffer drained by a trailing newline', 'alpha\n'],
  ])('flush returns null on %s', (_label, chunk) => {
    const buf = new LineBuffer();
    if (chunk) buf.push(chunk);
    expect(buf.flush()).toBeNull();
  });

  it('flush is idempotent', () => {
    const buf = new LineBuffer();
    buf.push('tail');
    expect(buf.flush()).toBe('tail');
    expect(buf.flush()).toBeNull();
  });

  it('keeps working after a flush', () => {
    const buf = new LineBuffer();
    buf.push('tail');
    buf.flush();
    expect(buf.push('next\n')).toEqual(['next']);
  });

  it('accumulates across consecutive pushes without losing order', () => {
    const buf = new LineBuffer();
    const out: string[] = [];
    out.push(...buf.push('one\ntw'));
    out.push(...buf.push('o\nthree\nfo'));
    out.push(...buf.push('ur\n'));
    expect(out).toEqual(['one', 'two', 'three', 'four']);
    expect(buf.pending).toBe('');
  });
});

describe('LineBuffer chunking is boundary-independent', () => {
  const TEXT = 'first line\r\nsecond line\n\nfourth line\nno trailing newline';

  /** Feed `text` in slices of `size` bytes; return lines plus the flushed remainder. */
  function feed(text: string, size: number): string[] {
    const buf = new LineBuffer();
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(...buf.push(text.slice(i, i + size)));
    const rest = buf.flush();
    if (rest !== null) out.push(rest);
    return out;
  }

  const WHOLE = feed(TEXT, TEXT.length);

  it('splits the reference text as expected in one shot', () => {
    expect(WHOLE).toEqual(['first line', 'second line', '', 'fourth line', 'no trailing newline']);
  });

  it.each([1, 2, 3, 5, 7, 11, 13, 17, 23, TEXT.length - 1])(
    'yields the same lines when fed %i byte(s) at a time',
    (size) => {
      expect(feed(TEXT, size)).toEqual(WHOLE);
    },
  );

  it('yields the same lines when fed one character at a time', () => {
    expect(feed(TEXT, 1)).toEqual(WHOLE);
  });
});
