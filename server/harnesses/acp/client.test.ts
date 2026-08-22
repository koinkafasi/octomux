/**
 * `AcpClient` against a real child process.
 *
 * Every test here spawns `./fake-agent.fixture.ts` — a miniature but genuine ACP
 * agent built on the same SDK — and talks to it over stdio. Nothing is mocked,
 * because the claims this file has to check are all about the *process*: that a
 * dead child ends the stream instead of hanging it, that SIGTERM alone does not
 * stop an engine that ignores it, that stderr is drained. A `Bun.spawn` mock
 * would assert the mock.
 *
 * No test depends on a real engine being installed (CI has no `gemini`), and
 * every one tears its child down in a `finally`, so a failure cannot leak a
 * process into the rest of the suite.
 */

import { describe, it, expect, vi } from '../../bun-test.js';
import type { AgentEvent } from '../events.js';
import { AcpClient, AcpClientError, runAcpPrompt, type AcpClientOptions } from './client.js';
import type { Scenario } from './fake-agent.fixture.js';
import { CRASH_EXIT_CODE, FAKE_SESSION_ID } from './fake-agent.fixture.js';

const FIXTURE = new URL('./fake-agent.fixture.ts', import.meta.url).pathname;
const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

/** Short by design: a stalled test is a 15s suite timeout, not a useful signal. */
const GRACE_MS = 250;

function optionsFor(
  scenario: Scenario,
  overrides: Partial<AcpClientOptions> = {},
): AcpClientOptions {
  return {
    argv: [process.execPath, FIXTURE, scenario],
    cwd: REPO_ROOT,
    shutdownGraceMs: GRACE_MS,
    requestTimeoutMs: 5_000,
    ...overrides,
  };
}

/** Run `body` against a started client, always closing it afterwards. */
async function withClient<T>(
  scenario: Scenario,
  body: (client: AcpClient) => Promise<T>,
  overrides: Partial<AcpClientOptions> = {},
): Promise<T> {
  const client = await AcpClient.start(optionsFor(scenario, overrides));
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const kinds = (events: AgentEvent[]): string[] => events.map((e) => e.t);

const texts = (events: AgentEvent[]): string[] =>
  events.flatMap((e) =>
    (e.t === 'message' || e.t === 'thought') && e.content.type === 'text' ? [e.content.text] : [],
  );

/** `true` once the pid is gone (and reaped, which `close()` guarantees). */
function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

// ─── Handshake ────────────────────────────────────────────────────────────────

describe('AcpClient.start', () => {
  it('completes the handshake and exposes the agent’s initialize response', async () => {
    await withClient('handshake-then-idle', async (client) => {
      expect(client.initializeResponse.protocolVersion).toBeGreaterThan(0);
      expect(client.initializeResponse.agentInfo).toEqual({
        name: 'fake-acp-agent',
        version: '1.0.0',
      });
      expect(client.pid).toBeGreaterThan(0);
    });
  });

  it('rejects an empty argv before spawning anything', async () => {
    await expect(AcpClient.start(optionsFor('handshake-then-idle', { argv: [] }))).rejects.toThrow(
      /argv is empty/,
    );
  });

  it('turns a spawn failure into an AcpClientError naming the binary', async () => {
    const promise = AcpClient.start(
      optionsFor('handshake-then-idle', { argv: ['/nonexistent/octomux-acp-probe'] }),
    );
    await expect(promise).rejects.toThrow(AcpClientError);
    await expect(promise).rejects.toThrow(
      /failed to spawn ACP agent `\/nonexistent\/octomux-acp-probe`/,
    );
  });

  it('surfaces a binary that exits instead of speaking ACP as a handshake failure', async () => {
    const promise = AcpClient.start(optionsFor('exit-immediately'));
    await expect(promise).rejects.toThrow(AcpClientError);
    await expect(promise).rejects.toThrow(/ACP handshake failed/);
  });

  it('times out an agent that accepts the connection and then says nothing', async () => {
    const started = Date.now();
    const promise = AcpClient.start(optionsFor('silent-initialize', { requestTimeoutMs: 300 }));
    await expect(promise).rejects.toThrow(
      /ACP handshake failed: ACP initialize timed out after 300ms/,
    );
    // The point of the timeout is that it is *ours*: ACP cancellation is
    // cooperative, so a peer that never answers would otherwise hang forever.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('leaves nothing running when the handshake fails', async () => {
    let pid: number | undefined;
    await expect(
      AcpClient.start(
        optionsFor('silent-initialize', {
          requestTimeoutMs: 200,
          onStderr: (text) => {
            const match = /pid:(\d+)/.exec(text);
            if (match) pid = Number(match[1]);
          },
        }),
      ),
    ).rejects.toThrow(AcpClientError);

    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(isDead(pid!)).toBe(true), 5_000);
  });
});

// ─── Sessions and turns ───────────────────────────────────────────────────────

describe('AcpClient.newSession', () => {
  it('opens a session and queues session_start ahead of the agent’s output', async () => {
    const events = await withClient('basic-turn', async (client) => {
      const session = await client.newSession();
      expect(session.sessionId).toBe(FAKE_SESSION_ID);
      return collect(session.prompt('hello'));
    });

    expect(events[0]).toEqual({ t: 'session_start', sessionId: FAKE_SESSION_ID });
  });

  it('times out a session/new the agent never answers', async () => {
    await withClient(
      'slow-session-new',
      async (client) => {
        await expect(client.newSession()).rejects.toThrow(/ACP session\/new timed out after 300ms/);
      },
      { requestTimeoutMs: 300 },
    );
  });

  it('passes an explicit cwd through instead of the client default', async () => {
    await withClient('handshake-then-idle', async (client) => {
      const session = await client.newSession({ cwd: '/tmp' });
      expect(session.sessionId).toBe(FAKE_SESSION_ID);
    });
  });
});

describe('a full prompt turn', () => {
  it('streams the whole turn in order and ends on done', async () => {
    const events = await withClient(
      'basic-turn',
      async (client) => {
        const session = await client.newSession();
        return collect(session.prompt('read the readme'));
      },
      { model: 'fake-model' },
    );

    expect(kinds(events)).toEqual([
      'session_start',
      'thought',
      'plan',
      'tool_call',
      'tool_update',
      'message',
      'usage',
      'done',
    ]);
    expect(events.at(-1)).toEqual({ t: 'done', reason: 'end_turn' });
  });

  it('normalizes each update through ./normalize.ts', async () => {
    const events = await withClient(
      'basic-turn',
      async (client) => collect((await client.newSession()).prompt('go')),
      { model: 'fake-model' },
    );

    expect(events).toContainEqual({
      t: 'tool_call',
      call: {
        toolCallId: 'tc_1',
        title: 'Read README.md',
        kind: 'read',
        status: 'in_progress',
        toolName: 'Read',
      },
    });
    expect(events).toContainEqual({
      t: 'tool_update',
      update: {
        toolCallId: 'tc_1',
        status: 'completed',
        content: [{ type: 'text', text: '# octomux' }],
      },
    });
  });

  it('stamps the configured model onto usage, since ACP does not report it', async () => {
    const events = await withClient(
      'basic-turn',
      async (client) => collect((await client.newSession()).prompt('go')),
      { model: 'gemini-2.5-pro' },
    );

    expect(events).toContainEqual({
      t: 'usage',
      inputTokens: 20,
      outputTokens: 10,
      model: 'gemini-2.5-pro',
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 2,
    });
  });

  it('falls back to "unknown" when no model was configured', async () => {
    const events = await withClient('basic-turn', async (client) =>
      collect((await client.newSession()).prompt('go')),
    );
    expect(events.find((e) => e.t === 'usage')).toMatchObject({ model: 'unknown' });
  });

  it('accepts ACP content blocks as well as a bare string', async () => {
    const events = await withClient('basic-turn', async (client) =>
      collect((await client.newSession()).prompt([{ type: 'text', text: 'structured' }])),
    );
    expect(events.at(-1)?.t).toBe('done');
  });

  it('turns a JSON-RPC error from session/prompt into error then done', async () => {
    const events = await withClient('prompt-error', async (client) =>
      collect((await client.newSession()).prompt('go')),
    );

    expect(kinds(events)).toEqual(['session_start', 'error', 'done']);
    expect(events[1]).toMatchObject({ t: 'error' });
    expect((events[1] as { message: string }).message).toMatch(/fake agent refuses to prompt/);
  });

  it('drops session updates addressed to a session it does not know', async () => {
    const events = await withClient('stray-update', async (client) =>
      collect((await client.newSession()).prompt('go')),
    );

    expect(texts(events)).toEqual(['routed correctly']);
    expect(events.at(-1)).toEqual({ t: 'done', reason: 'end_turn' });
  });
});

// ─── Permissions ──────────────────────────────────────────────────────────────

describe('permission requests', () => {
  it('emits request_permission and answers with the responder’s choice', async () => {
    const seen: string[] = [];
    const events = await withClient(
      'permission',
      async (client) => collect((await client.newSession()).prompt('rm the build dir')),
      {
        onPermissionRequest: (req, context) => {
          seen.push(`${context.sessionId}:${req.toolCall.toolCallId}`);
          return 'allow';
        },
      },
    );

    expect(seen).toEqual([`${FAKE_SESSION_ID}:tc_rm`]);
    expect(events).toContainEqual({
      t: 'request_permission',
      req: {
        requestId: expect.any(String) as unknown as string,
        toolCall: {
          toolCallId: 'tc_rm',
          title: 'rm -rf build',
          kind: 'execute',
          status: 'pending',
          toolName: 'Bash',
          rawInput: { command: 'rm -rf build' },
        },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    expect(texts(events)).toContain('decision:allow');
  });

  it('places request_permission in stream order, ahead of what follows it', async () => {
    const events = await withClient(
      'permission',
      async (client) => collect((await client.newSession()).prompt('go')),
      { onPermissionRequest: () => 'deny' },
    );

    const askedAt = events.findIndex((e) => e.t === 'request_permission');
    const answeredAt = events.findIndex(
      (e) => e.t === 'message' && e.content.type === 'text' && e.content.text === 'decision:deny',
    );
    expect(askedAt).toBeGreaterThanOrEqual(0);
    expect(answeredAt).toBeGreaterThan(askedAt);
  });

  it('cancels by default, so an unattended launch never stalls on a human', async () => {
    const events = await withClient('permission', async (client) =>
      collect((await client.newSession()).prompt('go')),
    );

    // The ask is still emitted — whatever writes `permission_prompts` sees it.
    expect(kinds(events)).toContain('request_permission');
    expect(texts(events)).toContain('decision:cancelled');
  });

  it('treats a responder returning null as a cancellation', async () => {
    const events = await withClient(
      'permission',
      async (client) => collect((await client.newSession()).prompt('go')),
      { onPermissionRequest: () => null },
    );
    expect(texts(events)).toContain('decision:cancelled');
  });

  it('awaits an async responder', async () => {
    const events = await withClient(
      'permission',
      async (client) => collect((await client.newSession()).prompt('go')),
      {
        onPermissionRequest: async () => {
          await Bun.sleep(20);
          return 'allow';
        },
      },
    );
    expect(texts(events)).toContain('decision:allow');
  });

  it('cancels the request when the responder throws, rather than hanging the turn', async () => {
    const events = await withClient(
      'permission',
      async (client) => collect((await client.newSession()).prompt('go')),
      {
        onPermissionRequest: () => {
          throw new Error('responder exploded');
        },
      },
    );

    expect(texts(events)).toContain('decision:cancelled');
    expect(events.at(-1)).toEqual({ t: 'done', reason: 'end_turn' });
  });
});

// ─── Process death ────────────────────────────────────────────────────────────

describe('when the agent process dies mid-turn', () => {
  it('ends the stream with error then done instead of hanging', async () => {
    const events = await withClient('crash-mid-turn', async (client) =>
      collect((await client.newSession()).prompt('go')),
    );

    expect(events.at(-1)?.t).toBe('done');
    expect(kinds(events)).toContain('error');
    // Whichever side notices first — the process watcher or the rejected
    // request — the caller gets a terminated stream, which is the contract.
    const error = events.find((e) => e.t === 'error') as { message: string };
    expect(error.message).toMatch(/exited|closed/i);
  });

  it('reports the child’s exit code', async () => {
    const client = await AcpClient.start(optionsFor('crash-mid-turn'));
    try {
      await collect((await client.newSession()).prompt('go'));
      expect(await client.exited).toBe(CRASH_EXIT_CODE);
    } finally {
      await client.close();
    }
  });

  it('leaves no live session queue behind, so a second prompt still terminates', async () => {
    const client = await AcpClient.start(optionsFor('crash-mid-turn'));
    try {
      const session = await client.newSession();
      await collect(session.prompt('go'));
      const second = await collect(session.prompt('again'));
      expect(second.at(-1)?.t).toBe('done');
    } finally {
      await client.close();
    }
  });
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────

describe('AcpClient.close', () => {
  it('lets a well-behaved agent exit cleanly on stdin EOF, without killing it', async () => {
    const client = await AcpClient.start(optionsFor('handshake-then-idle'));
    const started = Date.now();
    await client.close();

    expect(await client.exited).toBe(0);
    // Exit code 0 rather than a signal is the assertion that matters; the
    // elapsed bound just documents that no grace period was burned waiting.
    expect(Date.now() - started).toBeLessThan(GRACE_MS);
  });

  it('escalates to SIGKILL for an agent that ignores SIGTERM', async () => {
    const client = await AcpClient.start(optionsFor('ignore-sigterm'));
    await client.close();

    // Signalled, so there is no exit code — `gemini --acp` behaves this way.
    expect(await client.exited).toBeNull();
    await vi.waitFor(() => expect(isDead(client.pid)).toBe(true), 5_000);
  });

  it('is idempotent', async () => {
    const client = await AcpClient.start(optionsFor('handshake-then-idle'));
    await client.close();
    await client.close();
    await Promise.all([client.close(), client.close()]);
    expect(await client.exited).toBe(0);
  });

  it('ends every open session with error then done', async () => {
    const client = await AcpClient.start(optionsFor('wait-for-cancel'));
    const session = await client.newSession();

    const events: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.prompt('go')) events.push(event);
    })();

    // Wait until the turn is actually streaming before pulling the rug out.
    await vi.waitFor(() => expect(texts(events)).toContain('working'), 5_000);
    await client.close();
    await reader;

    expect(events.at(-1)?.t).toBe('done');
    expect(kinds(events)).toContain('error');
  });

  it('does not report an agent exit it caused itself', async () => {
    const client = await AcpClient.start(optionsFor('handshake-then-idle'));
    const session = await client.newSession();
    await client.close();

    // The queue was closed by close(); a prompt against it still terminates.
    const events = await collect(session.prompt('anyone there?'));
    expect(events.at(-1)?.t).toBe('done');
  });
});

// ─── stderr ───────────────────────────────────────────────────────────────────

describe('stderr pumping', () => {
  it('hands the agent’s stderr to onStderr', async () => {
    const chunks: string[] = [];
    await withClient('stderr-chatter', async () => Bun.sleep(50), {
      onStderr: (text) => chunks.push(text),
    });

    const all = chunks.join('');
    expect(all).toContain('fake agent: loading model weights');
    expect(all).toContain('fake agent: ready');
  });

  it('drains stderr even with no onStderr, so a chatty engine cannot block', async () => {
    // 64KB+ would fill a pipe buffer and wedge the child if nobody read it.
    const events = await withClient('basic-turn', async (client) =>
      collect((await client.newSession()).prompt('go')),
    );
    expect(events.at(-1)?.t).toBe('done');
  });
});

// ─── runAcpPrompt ─────────────────────────────────────────────────────────────

describe('runAcpPrompt', () => {
  it('runs one prompt end to end and tears the process down', async () => {
    let pid: number | undefined;
    const events = await collect(
      runAcpPrompt({
        ...optionsFor('basic-turn'),
        model: 'fake-model',
        prompt: 'read the readme',
        onStderr: (text) => {
          const match = /pid:(\d+)/.exec(text);
          if (match) pid = Number(match[1]);
        },
      }),
    );

    expect(kinds(events)).toEqual([
      'session_start',
      'thought',
      'plan',
      'tool_call',
      'tool_update',
      'message',
      'usage',
      'done',
    ]);
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(isDead(pid!)).toBe(true), 5_000);
  });

  it('kills the engine when the caller breaks out of the loop early', async () => {
    let pid: number | undefined;
    const stream = runAcpPrompt({
      ...optionsFor('wait-for-cancel'),
      prompt: 'go',
      onStderr: (text) => {
        const match = /pid:(\d+)/.exec(text);
        if (match) pid = Number(match[1]);
      },
    });

    for await (const event of stream) {
      if (event.t === 'message') break;
    }

    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(isDead(pid!)).toBe(true), 5_000);
  });

  it('kills the engine when the consumer throws', async () => {
    let pid: number | undefined;
    const stream = runAcpPrompt({
      ...optionsFor('wait-for-cancel'),
      prompt: 'go',
      onStderr: (text) => {
        const match = /pid:(\d+)/.exec(text);
        if (match) pid = Number(match[1]);
      },
    });

    await expect(
      (async () => {
        for await (const event of stream) {
          if (event.t === 'message') throw new Error('downstream blew up');
        }
      })(),
    ).rejects.toThrow(/downstream blew up/);

    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(isDead(pid!)).toBe(true), 5_000);
  });
});
