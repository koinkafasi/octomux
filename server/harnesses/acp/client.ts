/**
 * server/harnesses/acp/client.ts
 *
 * The ACP client: spawn an engine, speak JSON-RPC to it over stdio, hand back
 * sessions whose turns arrive as `AgentEvent`s.
 *
 * This is spec/engine-layer.md §5 step 5. One adapter covers every engine that
 * speaks ACP — `gemini --acp`, `opencode acp`, `claude-code-acp` — because the
 * protocol, not the engine, is what this file knows about. Which of those three
 * shapes a given engine uses is `./argv.ts`'s problem; translating what comes
 * back is `./normalize.ts`'s.
 *
 * Two behaviours are load-bearing and were verified against a real binary rather
 * than assumed:
 *
 * - **The child's death ends every pending request.** When the agent process
 *   exits, its stdout EOFs, the SDK closes the connection, and in-flight
 *   requests reject with "ACP connection closed". So a non-ACP binary (or a
 *   crashed one) surfaces as an error, not a hang.
 * - **SIGTERM is not enough.** `gemini --acp` ignores it and keeps running.
 *   `close()` therefore escalates to SIGKILL after a grace period instead of
 *   waiting on `proc.exited` forever.
 *
 * File-system and terminal client capabilities are deliberately not advertised.
 * An agent that believes octomux can read and write files on its behalf will
 * route edits through `fs/write_text_file`, and octomux has no handler for that
 * — the engines here run in their own worktree and touch it directly. Claiming
 * a capability we do not implement is worse than claiming none.
 */

import type {
  ContentBlock as AcpContentBlock,
  ClientConnection,
  InitializeResponse,
  McpServer,
  Stream,
} from '@agentclientprotocol/sdk';
import {
  client as acpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

import { childLogger } from '../../logger.js';
import type { AgentEvent, PermissionRequest } from '../events.js';
import {
  failureEvents,
  normalizePermissionRequest,
  normalizeSessionUpdate,
  sessionStartEvent,
} from './normalize.js';
import { AcpSession, errorMessage, EventQueue } from './session.js';

const logger = childLogger('harnesses/acp');

/** Raised when the agent process cannot be started or the handshake fails. */
export class AcpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpClientError';
  }
}

/**
 * Decides a permission request. Return the `optionId` to grant, or `null` to
 * cancel.
 *
 * The default responder cancels. That is the safe default for an unattended
 * launch: an engine waiting on a human who is not there must not stall the turn,
 * and `request_permission` is still emitted into the event stream, so whatever
 * is wired to `permission_prompts` sees the ask either way.
 */
export type AcpPermissionResponder = (
  req: PermissionRequest,
  context: { sessionId: string; signal: AbortSignal },
) => string | null | Promise<string | null>;

export interface AcpClientOptions {
  /** Full argv, from `buildAcpArgv()`. `argv[0]` is the executable. */
  argv: string[];
  /** Working directory for the process and the default session `cwd`. */
  cwd: string;
  /** Extra environment, merged over `process.env`. */
  env?: Record<string, string | undefined>;
  /** Name reported to the agent in `clientInfo`. */
  clientName?: string;
  clientVersion?: string;
  /** Model label stamped onto `usage` events; ACP does not report it. */
  model?: string;
  onPermissionRequest?: AcpPermissionResponder;
  /** Receives the agent's stderr, decoded. Defaults to a debug log. */
  onStderr?: (text: string) => void;
  /**
   * Hard ceiling on `initialize` and `session/new`. ACP's own cancellation is
   * cooperative — the peer still has to answer — so a binary that accepts the
   * connection and then says nothing needs a timeout on our side.
   */
  requestTimeoutMs?: number;
  /** How long `close()` waits after closing the connection before SIGKILL. */
  shutdownGraceMs?: number;
}

export interface NewSessionOptions {
  /** Defaults to the client's `cwd`. Must be absolute. */
  cwd?: string;
  /** MCP servers the agent should connect to. Empty by default. */
  mcpServers?: McpServer[];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_CLIENT_NAME = 'octomux';
const DEFAULT_CLIENT_VERSION = '0.0.0';

/** Reject after `ms` unless `promise` settles first. Always clears its timer. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AcpClientError(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Bun's stdin pipe is a `FileSink`, not a `WritableStream`, and `ndJsonStream`
 * wants the latter. Flushing on every write matters: JSON-RPC is
 * request/response, so a buffered frame is a request the agent never sees.
 *
 * The `close`/`abort` handlers exist for the `WritableStream` contract but are
 * never reached in practice — `ndJsonStream`'s own writable declares no `close`,
 * and the SDK's shutdown cancels its outbound *reader* rather than closing the
 * writable, so nothing propagates down to this sink. `endStdin()` below is what
 * actually EOFs the child.
 */
function sinkToWritable(sink: Bun.FileSink): WritableStream<Uint8Array> {
  const end = (): void => {
    try {
      sink.end();
    } catch {
      /* already ended, or the pipe died with the process */
    }
  };
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk);
      await sink.flush();
    },
    close: end,
    abort: end,
  });
}

/**
 * EOF the agent's stdin.
 *
 * This is the polite half of shutdown and it has to be done by hand: closing the
 * ACP connection does *not* reach the pipe (see `sinkToWritable`). Without it a
 * well-behaved agent never learns the client hung up, sits there until
 * `shutdownGraceMs` expires, and gets SIGTERM/SIGKILL for its trouble — so every
 * `close()` costs the full grace period and no engine ever exits cleanly.
 */
function endStdin(proc: AcpSubprocess): void {
  try {
    proc.stdin.end();
  } catch {
    /* already ended, or the pipe died with the process */
  }
}

/** Only string values survive into the child's environment. */
function mergeEnv(extra: Record<string, string | undefined> | undefined): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') merged[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (typeof value === 'string') merged[key] = value;
  }
  return merged;
}

type AcpSubprocess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

/**
 * A running ACP agent process plus its connection.
 *
 * Construct with `AcpClient.start()`, which does not resolve until `initialize`
 * has round-tripped — so a client you hold is one that answered.
 */
export class AcpClient {
  private readonly proc: AcpSubprocess;
  private readonly connection: ClientConnection;
  private readonly options: AcpClientOptions;
  /** One queue per live session; the JSON-RPC handlers write into these. */
  private readonly queues = new Map<string, EventQueue>();
  private closing = false;
  private exitReported = false;

  /** The agent's `initialize` response: protocol version, capabilities, auth methods. */
  readonly initializeResponse: InitializeResponse;

  private constructor(
    proc: AcpSubprocess,
    connection: ClientConnection,
    options: AcpClientOptions,
    initializeResponse: InitializeResponse,
    queues: Map<string, EventQueue>,
  ) {
    this.proc = proc;
    this.connection = connection;
    this.options = options;
    this.initializeResponse = initializeResponse;
    // The handlers registered before `connect()` already close over this map.
    this.queues = queues;
  }

  /**
   * Spawn the engine, connect, and complete the ACP handshake.
   *
   * @throws {AcpClientError} when argv is empty, the process cannot be spawned,
   * or `initialize` fails or times out. The process is killed on every failure
   * path, so a rejected `start()` leaves nothing running.
   */
  static async start(options: AcpClientOptions): Promise<AcpClient> {
    if (options.argv.length === 0) throw new AcpClientError('argv is empty');

    const queues = new Map<string, EventQueue>();
    const model = options.model;
    const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    let proc: AcpSubprocess;
    try {
      proc = Bun.spawn({
        cmd: options.argv,
        cwd: options.cwd,
        env: mergeEnv(options.env),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      throw new AcpClientError(
        `failed to spawn ACP agent \`${options.argv[0]}\`: ${errorMessage(err)}`,
      );
    }

    logger.info(
      { operation: 'acp_spawn', pid: proc.pid, command: options.argv[0], cwd: options.cwd },
      'spawned ACP agent',
    );

    pumpStderr(proc, options.onStderr);

    // Permission requests must be answered even before `start()` returns — an
    // agent is free to ask during `initialize` — so the handlers go on the app,
    // not on the constructed client.
    const responder = options.onPermissionRequest ?? (() => null);
    const app = acpClientApp({ name: options.clientName ?? DEFAULT_CLIENT_NAME })
      .onNotification(methods.client.session.update, (ctx) => {
        const queue = queues.get(ctx.params.sessionId);
        if (!queue) {
          logger.debug(
            { operation: 'acp_update_unrouted', session_id: ctx.params.sessionId },
            'session update for an unknown session',
          );
          return;
        }
        queue.pushAll(
          normalizeSessionUpdate(ctx.params.update, { model, sessionId: ctx.params.sessionId }),
        );
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const sessionId = ctx.params.sessionId;
        const req = normalizePermissionRequest(ctx.params, String(ctx.requestId));
        queues.get(sessionId)?.push({ t: 'request_permission', req });

        let optionId: string | null = null;
        try {
          // Raced against the request's own signal so a responder that never
          // settles cannot pin a JSON-RPC handler open for the connection's life.
          optionId = await raceSignal(
            Promise.resolve(responder(req, { sessionId, signal: ctx.signal })),
            ctx.signal,
          );
        } catch (err) {
          logger.warn(
            {
              operation: 'acp_permission_responder_failed',
              session_id: sessionId,
              err: errorMessage(err),
            },
            'permission responder threw; cancelling the request',
          );
        }

        return optionId === null
          ? { outcome: { outcome: 'cancelled' as const } }
          : { outcome: { outcome: 'selected' as const, optionId } };
      });

    const stream: Stream = ndJsonStream(sinkToWritable(proc.stdin), proc.stdout);
    const connection = app.connect(stream);

    let initializeResponse: InitializeResponse;
    try {
      initializeResponse = await withTimeout(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          // Nothing advertised: see the module header.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: options.clientName ?? DEFAULT_CLIENT_NAME,
            version: options.clientVersion ?? DEFAULT_CLIENT_VERSION,
          },
        }),
        timeoutMs,
        'ACP initialize',
      );
    } catch (err) {
      connection.close();
      endStdin(proc);
      await killProcess(proc, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
      throw new AcpClientError(`ACP handshake failed: ${errorMessage(err)}`);
    }

    const acpClient = new AcpClient(proc, connection, options, initializeResponse, queues);
    acpClient.watchProcess();
    return acpClient;
  }

  /** PID of the agent process. */
  get pid(): number {
    return this.proc.pid;
  }

  /** Resolves with the agent's exit code (or `null` when it was signalled). */
  get exited(): Promise<number | null> {
    return this.proc.exited.then(() => this.proc.exitCode);
  }

  /**
   * Open a session. Queues its `session_start` event, so the first `prompt()`
   * yields it ahead of anything the agent says.
   */
  async newSession(options: NewSessionOptions = {}): Promise<AcpSession> {
    const cwd = options.cwd ?? this.options.cwd;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    const response = await withTimeout(
      this.connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: options.mcpServers ?? [],
      }),
      timeoutMs,
      'ACP session/new',
    );

    const queue = new EventQueue();
    queue.push(sessionStartEvent(response.sessionId));
    this.queues.set(response.sessionId, queue);

    logger.info(
      { operation: 'acp_session_new', session_id: response.sessionId, cwd },
      'opened ACP session',
    );

    return new AcpSession({
      sessionId: response.sessionId,
      agent: this.connection.agent,
      queue,
      model: this.options.model,
      onDispose: () => this.queues.delete(response.sessionId),
    });
  }

  /**
   * Close the connection and stop the process.
   *
   * Idempotent. Closes the connection and EOFs the agent's stdin, then gives it
   * `shutdownGraceMs` to exit on its own before SIGTERM and, if that is
   * ignored — `gemini --acp` ignores it — SIGKILL. Every open session gets
   * `error` + `done` unless it already finished cleanly, so nothing is left
   * waiting on a stream that will never produce another event.
   */
  async close(reason = 'closed'): Promise<void> {
    if (this.closing) {
      await this.proc.exited;
      return;
    }
    this.closing = true;

    this.connection.close();
    endStdin(this.proc);
    await killProcess(this.proc, this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
    this.endAllSessions(`ACP agent ${reason}`, reason);

    logger.info(
      { operation: 'acp_close', pid: this.proc.pid, exit_code: this.proc.exitCode },
      'closed ACP agent',
    );
  }

  /**
   * Turn the child's exit into events.
   *
   * Without this an engine that dies mid-turn leaves the prompt generator
   * waiting on a queue nobody will ever push to. The connection's own `closed`
   * promise fires too, but the exit code is the part worth reporting.
   */
  private watchProcess(): void {
    void this.proc.exited.then(() => {
      if (this.closing || this.exitReported) return;
      this.exitReported = true;
      const code = this.proc.exitCode;
      const signal = this.proc.signalCode;
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      logger.warn(
        { operation: 'acp_agent_exited', pid: this.proc.pid, exit_code: code, signal },
        'ACP agent exited while the connection was open',
      );
      this.endAllSessions(`ACP agent exited (${detail})`, 'agent_exited');
    });
  }

  /** Push `error` + `done` into every live session, then close their queues. */
  private endAllSessions(message: string, reason: string): void {
    for (const queue of this.queues.values()) {
      queue.pushAll(failureEvents(message, reason));
      queue.close();
    }
    this.queues.clear();
  }
}

/**
 * Resolve when `promise` settles, or with `null` as soon as `signal` aborts.
 *
 * Used to bound a caller-supplied permission responder: aborting does not stop
 * the responder, it just stops us waiting on it.
 */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err as Error);
      },
    );
  });
}

/** Drain the agent's stderr so a chatty engine cannot fill its pipe and block. */
function pumpStderr(proc: AcpSubprocess, onStderr: ((text: string) => void) | undefined): void {
  const sink =
    onStderr ??
    ((text: string): void => {
      logger.debug({ operation: 'acp_agent_stderr', pid: proc.pid }, text.trimEnd());
    });
  void (async () => {
    const decoder = new TextDecoder();
    // Explicit reader loop rather than `for await`: `Bun.spawn` hands back a web
    // `ReadableStream`, which TypeScript's lib does not declare as async-iterable
    // (TS2504) even though Bun implements it at runtime. getReader() is the shape
    // both agree on.
    const reader = proc.stderr.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.length > 0) sink(text);
      }
    } catch {
      /* the pipe closes with the process; nothing to report */
    } finally {
      reader.releaseLock();
    }
  })();
}

/**
 * Stop a child process, escalating until it is actually gone.
 *
 * Graceful wait → SIGTERM → grace again → SIGKILL. The second escalation is not
 * theoretical: `gemini --acp` survives SIGTERM indefinitely, so a `close()` that
 * stopped at SIGTERM would hang on `proc.exited`.
 */
async function killProcess(proc: AcpSubprocess, graceMs: number): Promise<void> {
  if (await settledWithin(proc.exited, graceMs)) return;

  proc.kill();
  if (await settledWithin(proc.exited, graceMs)) return;

  proc.kill('SIGKILL');
  await proc.exited;
}

/** `true` if `promise` settles within `ms`. Never leaves a timer behind. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Convenience: run one prompt against a fresh agent and stream the whole thing,
 * tearing the process down when the caller stops reading.
 *
 * The `try/finally` is the point — a `break` out of the loop, or a thrown error
 * downstream, still kills the engine.
 */
export async function* runAcpPrompt(
  options: AcpClientOptions & { prompt: string | AcpContentBlock[]; session?: NewSessionOptions },
): AsyncGenerator<AgentEvent, void, void> {
  const acpClient = await AcpClient.start(options);
  try {
    const session = await acpClient.newSession(options.session ?? {});
    yield* session.prompt(options.prompt);
  } finally {
    await acpClient.close();
  }
}
