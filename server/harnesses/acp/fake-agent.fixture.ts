/**
 * server/harnesses/acp/fake-agent.fixture.ts
 *
 * A real ACP agent, in miniature, for `client.test.ts` to talk to.
 *
 * Not a test file (the name deliberately misses bun's `*.test.ts` glob) and not
 * a mock: it is spawned as a child process and speaks newline-delimited JSON-RPC
 * over stdio through the same `@agentclientprotocol/sdk` the client uses. That is
 * the only way to exercise what `client.ts` actually claims — that a child's
 * death ends pending requests, that SIGTERM alone is not enough, that stderr is
 * drained. Mocking `Bun.spawn` would test the mock.
 *
 * Behaviour is selected by `argv[2]` (see `Scenario`), so one script covers the
 * whole matrix. Every scenario announces `pid:<n>` on stderr before doing
 * anything else, which lets a test verify the process was really reaped.
 */

import {
  agent as acpAgentApp,
  methods,
  ndJsonStream,
  RequestError,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type Stream,
} from '@agentclientprotocol/sdk';

/** Which behaviour to run. Kept in one union so the test file can import it. */
export type Scenario =
  | 'handshake-then-idle'
  | 'basic-turn'
  | 'permission'
  | 'crash-mid-turn'
  | 'silent-initialize'
  | 'slow-session-new'
  | 'exit-immediately'
  | 'stderr-chatter'
  | 'ignore-sigterm'
  | 'prompt-error'
  | 'stray-update'
  | 'wait-for-cancel'
  | 'cancel-then-echo';

/** Fixed so assertions can name it. */
export const FAKE_SESSION_ID = 'fake-session-0001';

/** The session id the `stray-update` scenario sends updates for. Never opened. */
export const GHOST_SESSION_ID = 'ghost-session-9999';

/** Exit code used by `crash-mid-turn`, chosen to be distinctive in assertions. */
export const CRASH_EXIT_CODE = 7;

function note(text: string): void {
  Bun.write(Bun.stderr, `${text}\n`);
}

/** `Bun.stdout` is a `FileSink`; `ndJsonStream` wants a `WritableStream`. */
function stdoutWritable(): WritableStream<Uint8Array> {
  const sink = Bun.stdout.writer();
  const end = (): void => {
    try {
      sink.end();
    } catch {
      /* already closed */
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

/** A promise that never settles — for scenarios that must not answer. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

async function main(): Promise<void> {
  const scenario = (process.argv[2] ?? 'handshake-then-idle') as Scenario;
  /** Prompt turns served so far, for the scenarios whose behaviour changes. */
  let turns = 0;
  /** Aborted by `session/cancel`; replaced at the start of each turn. */
  let cancelled = new AbortController();

  /** Resolve when either the JSON-RPC request or `session/cancel` says stop. */
  const untilCancelled = (requestSignal: AbortSignal): Promise<void> => {
    const turnSignal = cancelled.signal;
    return new Promise<void>((resolve) => {
      if (requestSignal.aborted || turnSignal.aborted) {
        resolve();
        return;
      }
      const done = (): void => resolve();
      requestSignal.addEventListener('abort', done, { once: true });
      turnSignal.addEventListener('abort', done, { once: true });
    });
  };
  note(`pid:${process.pid}`);

  if (scenario === 'exit-immediately') {
    process.exit(0);
  }

  if (scenario === 'stderr-chatter') {
    note('fake agent: loading model weights');
    note('fake agent: ready');
  }

  /**
   * Survive the SIGTERM `close()` sends first, so the test can observe the
   * SIGKILL escalation. `gemini --acp` behaves exactly this way in practice.
   */
  if (scenario === 'ignore-sigterm') {
    process.on('SIGTERM', () => {
      note('fake agent: ignoring SIGTERM');
    });
  }

  const app = acpAgentApp({ name: 'fake-acp-agent' })
    .onRequest(
      methods.agent.initialize,
      (ctx): InitializeResponse | Promise<InitializeResponse> => {
        if (scenario === 'silent-initialize') return never<InitializeResponse>();
        return {
          protocolVersion: ctx.params.protocolVersion,
          agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      },
    )
    .onRequest(methods.agent.session.new, (): NewSessionResponse | Promise<NewSessionResponse> => {
      if (scenario === 'slow-session-new') return never<NewSessionResponse>();
      return { sessionId: FAKE_SESSION_ID };
    })
    .onNotification(methods.agent.session.cancel, () => {
      note('fake agent: got session/cancel');
      // ACP's `session/cancel` is a notification, so nothing aborts the inbound
      // `session/prompt` for us — a real agent wires it up itself, and so must
      // this one, or a cancelled turn would simply hang.
      cancelled.abort();
    })
    .onRequest(methods.agent.session.prompt, async (ctx): Promise<PromptResponse> => {
      const sessionId = ctx.params.sessionId;
      cancelled = new AbortController();
      const update = (u: Parameters<typeof ctx.client.notify>[1]): Promise<void> =>
        ctx.client.notify(methods.client.session.update, u as never);

      if (scenario === 'prompt-error') {
        // A plain Error is flattened to "Internal error" on the wire; a
        // RequestError is how a real agent reports something the client can read.
        throw new RequestError(-32603, 'fake agent refuses to prompt');
      }

      if (scenario === 'stray-update') {
        await update({
          sessionId: GHOST_SESSION_ID,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'BOO' } },
        });
        await update({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'routed correctly' },
          },
        });
        return { stopReason: 'end_turn' };
      }

      if (scenario === 'crash-mid-turn') {
        await update({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'about to die' },
          },
        });
        // Let the frame reach the client's reader before the pipe EOFs.
        await Bun.sleep(25);
        process.exit(CRASH_EXIT_CODE);
      }

      // First turn stalls until cancelled, every later turn answers normally —
      // so a test can abandon turn 1 and check that turn 2 still gets its own
      // stream rather than turn 1's leftover `done`.
      if (scenario === 'cancel-then-echo') {
        turns += 1;
        if (turns === 1) {
          await update({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'turn1' },
            },
          });
          await untilCancelled(ctx.signal);
          return { stopReason: 'cancelled' };
        }
        await update({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `turn${turns}` },
          },
        });
        return { stopReason: 'end_turn' };
      }

      if (scenario === 'wait-for-cancel') {
        await update({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'working' },
          },
        });
        // Either `$/cancel_request` (aborts ctx.signal) or `session/cancel`.
        await untilCancelled(ctx.signal);
        return { stopReason: 'cancelled' };
      }

      if (scenario === 'permission') {
        const outcome = await ctx.client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId: 'tc_rm',
            title: 'rm -rf build',
            kind: 'execute',
            status: 'pending',
            name: 'Bash',
            rawInput: { command: 'rm -rf build' },
          },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
          ],
        });
        const decision =
          outcome.outcome.outcome === 'selected' ? outcome.outcome.optionId : 'cancelled';
        await update({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `decision:${decision}` },
          },
        });
        return { stopReason: 'end_turn' };
      }

      // 'basic-turn' and anything else: a representative full turn.
      await update({
        sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      });
      await update({
        sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'read the file', status: 'in_progress', priority: 'high' }],
        },
      });
      await update({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_1',
          title: 'Read README.md',
          kind: 'read',
          status: 'in_progress',
          name: 'Read',
        },
      });
      await update({
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc_1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: '# octomux' } }],
        },
      });
      await update({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'the readme says octomux' },
        },
      });
      return {
        stopReason: 'end_turn',
        usage: {
          totalTokens: 30,
          inputTokens: 20,
          outputTokens: 10,
          cachedReadTokens: 5,
          cachedWriteTokens: 2,
        },
      };
    });

  const stream: Stream = ndJsonStream(stdoutWritable(), Bun.stdin.stream());
  const connection = app.connect(stream);
  await connection.closed;

  // Every other scenario is done once the client hangs up; this one has to still
  // be alive for `close()` to have something to escalate against.
  if (scenario === 'ignore-sigterm') await never<void>();
}

/**
 * Only when spawned as a process. `client.test.ts` imports this module for its
 * constants and the `Scenario` union, and without the guard that import would
 * start an ACP agent on the *test runner's* stdio.
 */
if (import.meta.main) await main();
