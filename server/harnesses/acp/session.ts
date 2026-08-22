/**
 * server/harnesses/acp/session.ts
 *
 * One ACP session, exposed as an `AsyncIterable<AgentEvent>` per prompt turn.
 *
 * The SDK ships an `ActiveSession` helper that queues `session/update`
 * notifications, and this file deliberately does not use it. octomux needs
 * `session/request_permission` — a client-side *request*, not a notification —
 * interleaved in stream order with the updates around it, because the whole
 * point of spec §2.3 is that permission prompts stop being a Claude-Code hook
 * side channel. Racing the SDK's update queue against a second permission queue
 * would reorder exactly the events whose order matters, so both feed one
 * `EventQueue` here instead.
 *
 * Termination is the other reason. A prompt generator must end, always, and
 * three unrelated things can end it: the `session/prompt` response arriving, the
 * agent process dying, or the caller abandoning the loop. All three converge on
 * a `done` event in the same queue.
 */

import type { ClientContext, ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk';
import { methods } from '@agentclientprotocol/sdk';

import { childLogger } from '../../logger.js';
import type { AgentEvent } from '../events.js';
import { failureEvents, normalizePromptResponse, type AcpNormalizeOptions } from './normalize.js';

const logger = childLogger('harnesses/acp');

/** Raised for misuse of a session — a second concurrent prompt, a disposed session. */
export class AcpSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpSessionError';
  }
}

// ─── Event queue ──────────────────────────────────────────────────────────────

/**
 * Single-consumer async queue of `AgentEvent`s with an explicit end.
 *
 * Unbounded and never blocking on `push`: producers are JSON-RPC handlers on the
 * connection's read loop, and making them wait for a slow consumer would stall
 * the whole protocol — including the permission response the consumer may be
 * waiting on. Engine output is small enough that memory is not the constraint.
 *
 * "Single consumer" is a real contract, not a hint: `next()` hands a queued
 * event to exactly one waiter. Two concurrent readers would split the stream
 * between them, which is why `AcpSession` refuses overlapping prompts.
 */
export class EventQueue {
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters: Array<(event: AgentEvent | null) => void> = [];
  private ended = false;

  /** Queue one event, or hand it straight to a waiting `next()`. No-op once ended. */
  push(event: AgentEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.buffer.push(event);
  }

  /** Queue several events in order. */
  pushAll(events: readonly AgentEvent[]): void {
    for (const event of events) this.push(event);
  }

  /**
   * End the queue. Buffered events are still drained by `next()`; only new
   * pushes are refused. Waiters get `null` immediately.
   */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }

  /** `true` once `close()` has been called. */
  get closed(): boolean {
    return this.ended;
  }

  /** Events queued but not yet read. */
  get size(): number {
    return this.buffer.length;
  }

  /** The next event, or `null` when the queue is closed and drained. */
  next(): Promise<AgentEvent | null> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.ended) return Promise.resolve(null);
    return new Promise<AgentEvent | null>((resolve) => this.waiters.push(resolve));
  }
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface AcpSessionDeps {
  sessionId: string;
  /** Context for calling agent-side ACP methods, from `ClientApp.connect()`. */
  agent: ClientContext;
  /** Fed by `./client.ts`'s `session/update` and `session/request_permission` handlers. */
  queue: EventQueue;
  /** Stamped onto `usage` events; ACP does not report the model itself. */
  model?: string;
  /** Called by `dispose()` so the client stops routing updates to this queue. */
  onDispose?: () => void;
}

export interface AcpPromptOptions {
  /**
   * Aborting sends ACP's `$/cancel_request` for the in-flight `session/prompt`.
   * Cancellation is cooperative — the agent still answers, typically with
   * `stopReason: "cancelled"`, which surfaces as the usual `done` event.
   */
  signal?: AbortSignal;
}

/**
 * A live ACP session.
 *
 * Created by `AcpClient.newSession()`, which has already queued the
 * `session_start` event — so the first `prompt()` yields it before anything the
 * agent says.
 */
export class AcpSession {
  readonly sessionId: string;
  private readonly agent: ClientContext;
  private readonly queue: EventQueue;
  private readonly model: string | undefined;
  private readonly onDispose: (() => void) | undefined;
  private promptInFlight = false;
  private disposed = false;

  constructor(deps: AcpSessionDeps) {
    this.sessionId = deps.sessionId;
    this.agent = deps.agent;
    this.queue = deps.queue;
    this.model = deps.model;
    this.onDispose = deps.onDispose;
  }

  private get normalizeOptions(): AcpNormalizeOptions {
    return { model: this.model, sessionId: this.sessionId };
  }

  /**
   * Send a prompt and stream the turn as `AgentEvent`s.
   *
   * The generator is guaranteed to terminate, and to terminate on a `done`
   * event. `session/prompt` resolving produces one (`normalizePromptResponse`),
   * `session/prompt` rejecting produces `error` + `done`, and the agent process
   * dying makes `./client.ts` push `error` + `done` into this same queue.
   * The synthetic `done` at the end is the last resort — a queue closed without
   * one would otherwise end the loop with no terminal event at all.
   *
   * Abandoning the loop early (a `break`, or a `return` from `for await`) cancels
   * the in-flight prompt on the way out and discards that turn's late outcome, so
   * a later `prompt()` on the same session still starts from a clean stream. It
   * does not wait for the agent to acknowledge: an engine that ignores
   * `session/cancel` must not be able to block the caller.
   */
  async *prompt(
    input: string | AcpContentBlock[],
    options: AcpPromptOptions = {},
  ): AsyncGenerator<AgentEvent, void, void> {
    if (this.disposed) throw new AcpSessionError(`session ${this.sessionId} is disposed`);
    if (this.promptInFlight) {
      throw new AcpSessionError(`session ${this.sessionId} already has a prompt in flight`);
    }
    this.promptInFlight = true;

    const prompt = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input;
    let settled = false;
    /**
     * Set when the consumer walks away before the turn ends.
     *
     * The queue is per *session*, not per turn, so a late `done` from a turn
     * nobody is reading any more would sit in the buffer and be handed to the
     * next `prompt()` as its first event — ending that stream before the agent
     * had said anything. Dropping it is safe in both directions: there is no
     * reader left to receive it, and `prompt()` is documented as reusable.
     */
    let abandoned = false;

    // Not awaited here: the response is what *ends* the stream we are about to
    // read, so awaiting it first would deadlock against our own consumer.
    const turn = this.agent
      .request(
        methods.agent.session.prompt,
        { sessionId: this.sessionId, prompt },
        options.signal ? { cancellationSignal: options.signal } : undefined,
      )
      .then((response) => {
        settled = true;
        if (abandoned) return this.dropLateTurn('response');
        this.queue.pushAll(normalizePromptResponse(response, this.normalizeOptions));
      })
      .catch((err: unknown) => {
        settled = true;
        if (abandoned) return this.dropLateTurn('failure');
        // A rejection here is a transport or protocol failure — the connection
        // closed, the agent returned a JSON-RPC error. `./client.ts` may already
        // have queued the same failure from the process side; a duplicate `done`
        // is harmless because the first one ends the loop.
        this.queue.pushAll(failureEvents(errorMessage(err)));
      });

    try {
      for (;;) {
        const event = await this.queue.next();
        if (event === null) break;
        yield event;
        if (event.t === 'done') return;
      }
      yield { t: 'done', reason: 'disconnected' };
    } finally {
      this.promptInFlight = false;
      if (!settled) {
        abandoned = true;
        void this.cancel().catch(() => {
          /* best effort — the connection may already be gone */
        });
      }
      void turn; // never rejects; kept referenced so the catch above is not dropped
    }
  }

  /** Log a turn whose outcome arrived after its reader had gone. */
  private dropLateTurn(kind: 'response' | 'failure'): void {
    logger.debug(
      { operation: 'acp_turn_abandoned', session_id: this.sessionId, outcome: kind },
      'dropping the outcome of an abandoned prompt turn',
    );
  }

  /**
   * Ask the agent to stop the current turn (`session/cancel`, a notification).
   *
   * The agent still answers the outstanding `session/prompt`, so the stream ends
   * with a normal `done` — usually `reason: "cancelled"`.
   */
  async cancel(): Promise<void> {
    if (this.disposed) return;
    await this.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  /**
   * Stop routing updates to this session and end any reader.
   *
   * Does not close the session on the agent — `AcpClient.close()` tears down the
   * process, which is what actually ends it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.close();
    this.onDispose?.();
    logger.debug(
      { operation: 'acp_session_dispose', session_id: this.sessionId },
      'session disposed',
    );
  }
}

/**
 * Best-effort human-readable message from an unknown throwable.
 *
 * The `?? String(err)` is not belt-and-braces: `JSON.stringify` *returns*
 * `undefined` (rather than throwing) for `undefined`, functions, and symbols,
 * all of which are legal to `throw`. Without the fallback this returns a
 * non-string despite its signature, and `failureEvents(errorMessage(err))` then
 * emits an `error` event whose `message` is `undefined`.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
