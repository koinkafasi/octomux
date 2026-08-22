/**
 * `EventQueue`, `AcpSession`, and `errorMessage`.
 *
 * `client.test.ts` covers these against a live child process; this file drives
 * them directly with a stub `ClientContext`, which is the only way to pin the
 * edges that a real agent will not reliably produce on demand — a `session/prompt`
 * that never settles, a queue closed out from under a reader, two prompts racing
 * on one session.
 */

import type { ClientContext, PromptResponse } from '@agentclientprotocol/sdk';

import { describe, it, expect, vi } from '../../bun-test.js';
import type { AgentEvent } from '../events.js';
import { AcpSession, AcpSessionError, errorMessage, EventQueue } from './session.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface StubAgent {
  context: ClientContext;
  request: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
}

/**
 * A structural stand-in for the SDK's `ClientContext`.
 *
 * `ClientContext` has a private constructor, so there is no way to build a real
 * one outside a connection; the session only ever calls `request`/`notify`.
 */
function stubAgent(requestImpl?: (...args: unknown[]) => unknown): StubAgent {
  const request = vi.fn(
    requestImpl ?? ((): Promise<PromptResponse> => Promise.resolve({ stopReason: 'end_turn' })),
  );
  const notify = vi.fn(() => Promise.resolve());
  return { context: { request, notify } as unknown as ClientContext, request, notify };
}

const TEXT = (text: string): AgentEvent => ({ t: 'message', content: { type: 'text', text } });

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// ─── EventQueue ───────────────────────────────────────────────────────────────

describe('EventQueue', () => {
  it('hands buffered events back in push order', async () => {
    const queue = new EventQueue();
    queue.push(TEXT('one'));
    queue.push(TEXT('two'));
    queue.push(TEXT('three'));

    expect(await queue.next()).toEqual(TEXT('one'));
    expect(await queue.next()).toEqual(TEXT('two'));
    expect(await queue.next()).toEqual(TEXT('three'));
  });

  it('pushAll preserves order', async () => {
    const queue = new EventQueue();
    queue.pushAll([TEXT('a'), TEXT('b')]);
    expect(await queue.next()).toEqual(TEXT('a'));
    expect(await queue.next()).toEqual(TEXT('b'));
  });

  it('pushAll of an empty list is a no-op', () => {
    const queue = new EventQueue();
    queue.pushAll([]);
    expect(queue.size).toBe(0);
  });

  it('hands a pushed event straight to a waiting reader', async () => {
    const queue = new EventQueue();
    const pending = queue.next();
    expect(queue.size).toBe(0);

    queue.push(TEXT('late'));
    expect(await pending).toEqual(TEXT('late'));
    // Delivered to the waiter, never buffered.
    expect(queue.size).toBe(0);
  });

  it('serves multiple waiters in the order they arrived', async () => {
    const queue = new EventQueue();
    const first = queue.next();
    const second = queue.next();

    queue.pushAll([TEXT('1'), TEXT('2')]);

    expect(await first).toEqual(TEXT('1'));
    expect(await second).toEqual(TEXT('2'));
  });

  it('never splits one event between two waiters', async () => {
    const queue = new EventQueue();
    const first = queue.next();
    const second = queue.next();

    queue.push(TEXT('only'));
    expect(await first).toEqual(TEXT('only'));

    queue.close();
    expect(await second).toBeNull();
  });

  it('does not block the producer — push is synchronous and unbounded', () => {
    const queue = new EventQueue();
    for (let i = 0; i < 10_000; i++) queue.push(TEXT(`e${i}`));
    expect(queue.size).toBe(10_000);
  });

  describe('close', () => {
    it('resolves waiting readers with null', async () => {
      const queue = new EventQueue();
      const pending = queue.next();
      queue.close();
      expect(await pending).toBeNull();
    });

    it('resolves every waiting reader, not just the first', async () => {
      const queue = new EventQueue();
      const waiters = [queue.next(), queue.next(), queue.next()];
      queue.close();
      expect(await Promise.all(waiters)).toEqual([null, null, null]);
    });

    it('still drains what was already buffered', async () => {
      const queue = new EventQueue();
      queue.pushAll([TEXT('a'), TEXT('b')]);
      queue.close();

      expect(await queue.next()).toEqual(TEXT('a'));
      expect(await queue.next()).toEqual(TEXT('b'));
      expect(await queue.next()).toBeNull();
    });

    it('keeps returning null once drained', async () => {
      const queue = new EventQueue();
      queue.close();
      expect(await queue.next()).toBeNull();
      expect(await queue.next()).toBeNull();
    });

    it('refuses new pushes', async () => {
      const queue = new EventQueue();
      queue.close();
      queue.push(TEXT('too late'));
      queue.pushAll([TEXT('also too late')]);

      expect(queue.size).toBe(0);
      expect(await queue.next()).toBeNull();
    });

    it('is idempotent', async () => {
      const queue = new EventQueue();
      queue.close();
      queue.close();
      expect(queue.closed).toBe(true);
      expect(await queue.next()).toBeNull();
    });

    it('flips the closed flag', () => {
      const queue = new EventQueue();
      expect(queue.closed).toBe(false);
      queue.close();
      expect(queue.closed).toBe(true);
    });
  });

  it('reports only unread events in size', async () => {
    const queue = new EventQueue();
    expect(queue.size).toBe(0);
    queue.pushAll([TEXT('a'), TEXT('b')]);
    expect(queue.size).toBe(2);
    await queue.next();
    expect(queue.size).toBe(1);
  });
});

// ─── AcpSession ───────────────────────────────────────────────────────────────

describe('AcpSession', () => {
  function makeSession(
    agent: StubAgent,
    extra: { queue?: EventQueue; model?: string; onDispose?: () => void } = {},
  ): { session: AcpSession; queue: EventQueue } {
    const queue = extra.queue ?? new EventQueue();
    const session = new AcpSession({
      sessionId: 'sess_1',
      agent: agent.context,
      queue,
      model: extra.model,
      onDispose: extra.onDispose,
    });
    return { session, queue };
  }

  it('exposes the session id it was constructed with', () => {
    const { session } = makeSession(stubAgent());
    expect(session.sessionId).toBe('sess_1');
  });

  describe('prompt', () => {
    it('wraps a string prompt in a single text content block', async () => {
      const agent = stubAgent();
      const { session } = makeSession(agent);

      await collect(session.prompt('do the thing'));

      expect(agent.request).toHaveBeenCalledWith(
        'session/prompt',
        { sessionId: 'sess_1', prompt: [{ type: 'text', text: 'do the thing' }] },
        undefined,
      );
    });

    it('passes explicit content blocks through unchanged', async () => {
      const agent = stubAgent();
      const { session } = makeSession(agent);
      const blocks = [
        { type: 'text' as const, text: 'look at this' },
        { type: 'resource_link' as const, uri: 'file:///a.ts', name: 'a.ts' },
      ];

      await collect(session.prompt(blocks));

      expect(agent.request).toHaveBeenCalledWith(
        'session/prompt',
        { sessionId: 'sess_1', prompt: blocks },
        undefined,
      );
    });

    it('forwards an abort signal as the request cancellation signal', async () => {
      const agent = stubAgent();
      const { session } = makeSession(agent);
      const controller = new AbortController();

      await collect(session.prompt('go', { signal: controller.signal }));

      expect(agent.request).toHaveBeenCalledWith('session/prompt', expect.anything(), {
        cancellationSignal: controller.signal,
      });
    });

    it('streams everything already queued, then the turn’s own done', async () => {
      const turn = deferred<PromptResponse>();
      const agent = stubAgent(() => turn.promise);
      const { session, queue } = makeSession(agent);

      queue.push({ t: 'session_start', sessionId: 'sess_1' });
      const events = collect(session.prompt('go'));

      queue.push(TEXT('working'));
      turn.resolve({ stopReason: 'end_turn' });

      expect(await events).toEqual([
        { t: 'session_start', sessionId: 'sess_1' },
        TEXT('working'),
        { t: 'done', reason: 'end_turn' },
      ]);
    });

    it('stamps the session’s model onto the turn’s usage event', async () => {
      const agent = stubAgent(() =>
        Promise.resolve({
          stopReason: 'end_turn' as const,
          usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 },
        }),
      );
      const { session } = makeSession(agent, { model: 'gemini-2.5-pro' });

      expect(await collect(session.prompt('go'))).toEqual([
        { t: 'usage', inputTokens: 2, outputTokens: 1, model: 'gemini-2.5-pro' },
        { t: 'done', reason: 'end_turn' },
      ]);
    });

    it('turns a rejected session/prompt into error then done', async () => {
      const agent = stubAgent(() => Promise.reject(new Error('ACP connection closed')));
      const { session } = makeSession(agent);

      expect(await collect(session.prompt('go'))).toEqual([
        { t: 'error', message: 'ACP connection closed' },
        { t: 'done', reason: 'error' },
      ]);
    });

    it('stops at the first done, ignoring anything queued behind it', async () => {
      const agent = stubAgent();
      const { session, queue } = makeSession(agent);

      queue.pushAll([TEXT('before'), { t: 'done', reason: 'end_turn' }, TEXT('after the done')]);

      expect(await collect(session.prompt('go'))).toEqual([
        TEXT('before'),
        { t: 'done', reason: 'end_turn' },
      ]);
    });

    it('ends with a synthetic done when the queue closes without one', async () => {
      const turn = deferred<PromptResponse>();
      const agent = stubAgent(() => turn.promise);
      const { session, queue } = makeSession(agent);

      const events = collect(session.prompt('go'));
      queue.push(TEXT('partial'));
      queue.close();

      expect(await events).toEqual([TEXT('partial'), { t: 'done', reason: 'disconnected' }]);
      turn.resolve({ stopReason: 'end_turn' });
    });

    it('refuses a second concurrent prompt on the same session', async () => {
      const turn = deferred<PromptResponse>();
      const agent = stubAgent(() => turn.promise);
      const { session, queue } = makeSession(agent);

      const first = collect(session.prompt('one'));
      // Start the generator; `prompt()` only reserves the session once iterated.
      await Promise.resolve();
      queue.push(TEXT('tick'));
      await Promise.resolve();

      const second = session.prompt('two');
      await expect(second.next()).rejects.toThrow(AcpSessionError);
      await expect(session.prompt('three').next()).rejects.toThrow(
        /session sess_1 already has a prompt in flight/,
      );

      turn.resolve({ stopReason: 'end_turn' });
      await first;
    });

    it('allows a second prompt once the first has finished', async () => {
      const agent = stubAgent();
      const { session } = makeSession(agent);

      await collect(session.prompt('one'));
      await collect(session.prompt('two'));

      expect(agent.request).toHaveBeenCalledTimes(2);
    });

    it('throws on a disposed session', async () => {
      const { session } = makeSession(stubAgent());
      session.dispose();
      await expect(session.prompt('go').next()).rejects.toThrow(/session sess_1 is disposed/);
    });
  });

  describe('abandoning a turn', () => {
    it('cancels the in-flight prompt on the way out', async () => {
      const turn = deferred<PromptResponse>();
      const agent = stubAgent(() => turn.promise);
      const { session, queue } = makeSession(agent);

      queue.push(TEXT('first'));
      for await (const _event of session.prompt('go')) break;

      expect(agent.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 'sess_1' });
      turn.resolve({ stopReason: 'cancelled' });
    });

    it('does not cancel a turn that already ended', async () => {
      const agent = stubAgent();
      const { session } = makeSession(agent);

      await collect(session.prompt('go'));

      expect(agent.notify).not.toHaveBeenCalled();
    });

    /**
     * Regression: the queue belongs to the session, not the turn, so an
     * abandoned turn's late `done` used to sit in the buffer and be handed to
     * the *next* `prompt()` as its first event — silently swallowing that turn.
     */
    it('discards the abandoned turn’s late outcome instead of leaking it forward', async () => {
      const first = deferred<PromptResponse>();
      const second = deferred<PromptResponse>();
      let call = 0;
      const agent = stubAgent(() => (++call === 1 ? first.promise : second.promise));
      const { session, queue } = makeSession(agent);

      queue.push(TEXT('turn one'));
      for await (const _event of session.prompt('one')) break;

      // The agent answers the cancelled turn only now, after the reader left.
      first.resolve({ stopReason: 'cancelled' });
      await Promise.resolve();
      await Promise.resolve();
      expect(queue.size).toBe(0);

      const events = collect(session.prompt('two'));
      queue.push(TEXT('turn two'));
      second.resolve({ stopReason: 'end_turn' });

      expect(await events).toEqual([TEXT('turn two'), { t: 'done', reason: 'end_turn' }]);
    });

    it('also discards a late failure from an abandoned turn', async () => {
      const first = deferred<PromptResponse>();
      const second = deferred<PromptResponse>();
      let call = 0;
      const agent = stubAgent(() => (++call === 1 ? first.promise : second.promise));
      const { session, queue } = makeSession(agent);

      queue.push(TEXT('turn one'));
      for await (const _event of session.prompt('one')) break;

      first.reject(new Error('connection closed'));
      await Promise.resolve();
      await Promise.resolve();
      expect(queue.size).toBe(0);

      const events = collect(session.prompt('two'));
      second.resolve({ stopReason: 'end_turn' });
      expect(await events).toEqual([{ t: 'done', reason: 'end_turn' }]);
    });

    it('releases the in-flight lock even when the caller throws', async () => {
      const turn = deferred<PromptResponse>();
      const agent = stubAgent(() => turn.promise);
      const { session, queue } = makeSession(agent);

      queue.push(TEXT('first'));
      await expect(
        (async () => {
          for await (const _event of session.prompt('go')) throw new Error('downstream');
        })(),
      ).rejects.toThrow(/downstream/);

      turn.resolve({ stopReason: 'cancelled' });
      // Not stuck: a fresh prompt is accepted.
      await collect(session.prompt('again'));
      expect(agent.request).toHaveBeenCalledTimes(2);
    });

    it('does not let a failing cancel escape to the caller', async () => {
      const turn = deferred<PromptResponse>();
      const agent = stubAgent(() => turn.promise);
      agent.notify.mockImplementation(() => Promise.reject(new Error('connection gone')));
      const { session, queue } = makeSession(agent);

      queue.push(TEXT('first'));
      for await (const _event of session.prompt('go')) break;

      turn.resolve({ stopReason: 'cancelled' });
      await Promise.resolve();
      expect(agent.notify).toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('sends session/cancel as a notification', async () => {
      const agent = stubAgent();
      const { session } = makeSession(agent);

      await session.cancel();

      expect(agent.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 'sess_1' });
      expect(agent.request).not.toHaveBeenCalled();
    });

    it('is a no-op on a disposed session', async () => {
      const agent = stubAgent();
      const { session } = makeSession(agent);
      session.dispose();

      await session.cancel();

      expect(agent.notify).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('closes the queue and tells the client to stop routing', () => {
      const onDispose = vi.fn();
      const { session, queue } = makeSession(stubAgent(), { onDispose });

      session.dispose();

      expect(queue.closed).toBe(true);
      expect(onDispose).toHaveBeenCalledTimes(1);
    });

    it('is idempotent', () => {
      const onDispose = vi.fn();
      const { session } = makeSession(stubAgent(), { onDispose });

      session.dispose();
      session.dispose();
      session.dispose();

      expect(onDispose).toHaveBeenCalledTimes(1);
    });

    it('ends a reader that is mid-turn', async () => {
      const turn = deferred<PromptResponse>();
      const agent = stubAgent(() => turn.promise);
      const { session, queue } = makeSession(agent);

      const events = collect(session.prompt('go'));
      queue.push(TEXT('partial'));
      await Promise.resolve();
      session.dispose();

      expect(await events).toEqual([TEXT('partial'), { t: 'done', reason: 'disconnected' }]);
      turn.resolve({ stopReason: 'cancelled' });
    });

    it('works without an onDispose callback', () => {
      const { session } = makeSession(stubAgent());
      expect(() => session.dispose()).not.toThrow();
    });
  });
});

// ─── errorMessage ─────────────────────────────────────────────────────────────

describe('errorMessage', () => {
  const cases: Array<{ name: string; input: unknown; expected: string }> = [
    { name: 'an Error yields its message', input: new Error('boom'), expected: 'boom' },
    {
      name: 'an Error subclass yields its message',
      input: new AcpSessionError('already in flight'),
      expected: 'already in flight',
    },
    { name: 'a string is itself', input: 'plain string', expected: 'plain string' },
    { name: 'an object is JSON', input: { code: -32603 }, expected: '{"code":-32603}' },
    { name: 'an array is JSON', input: [1, 2], expected: '[1,2]' },
    { name: 'a number is JSON', input: 42, expected: '42' },
    { name: 'null is JSON', input: null, expected: 'null' },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(errorMessage(input)).toBe(expected);
  });

  it('falls back to String() when JSON.stringify throws', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorMessage(circular)).toBe('[object Object]');
  });

  /**
   * `JSON.stringify` *returns* `undefined` for these rather than throwing, so the
   * try/catch alone does not catch them and the function would hand back a
   * non-string — which then becomes an `error` event with no message.
   */
  const stringifiesToUndefined: Array<{ name: string; input: unknown; expected: string }> = [
    { name: 'undefined', input: undefined, expected: 'undefined' },
    { name: 'a function', input: function boom() {}, expected: String(function boom() {}) },
    { name: 'a symbol', input: Symbol('nope'), expected: 'Symbol(nope)' },
  ];

  it.each(stringifiesToUndefined)('always returns a string for $name', ({ input, expected }) => {
    expect(typeof errorMessage(input)).toBe('string');
    expect(errorMessage(input)).toBe(expected);
  });

  it('never throws, whatever it is handed', () => {
    const hostile = {
      toJSON() {
        throw new Error('nope');
      },
    };
    expect(() => errorMessage(hostile)).not.toThrow();
  });
});
