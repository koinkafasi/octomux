/**
 * Per-worktree port allocation.
 *
 * Every task gets its own git worktree, and the moment two of them run
 * `docker compose up` or a dev server they fight over the same Postgres/Redis/
 * app port. With parallel tasks now the normal mode of operation, that
 * collision is a matter of when, not if.
 *
 * The fix is deterministic offset arithmetic, not hashing: a task holds an
 * integer `offset` in `[1, poolSize]` and every service port is
 * `basePort + band * poolSize + offset`. Hashed ports are unpredictable and
 * un-shareable; with an offset, worktree 3 is always in the same place, so
 * `http://localhost:8003` still works tomorrow and can be pasted to a
 * colleague.
 *
 * The registry lives in SQLite (`port_allocations`), not a lockfile: the DB is
 * already there, already WAL, and a UNIQUE index on `offset` gives atomic
 * claim-or-lose semantics for free — no flock, no PID files, no stale-lock
 * recovery. Losing the race is just a constraint violation, and the loser
 * walks to the next offset.
 */

import fs from 'fs';
import net from 'net';
import path from 'path';
import {
  claimOffset,
  deleteOffset,
  readOffset,
  readTakenOffsets,
} from '../../repositories/port-allocations.js';
import { childLogger } from '../../logger.js';

const logger = childLogger('task-engine/setup/ports');

// ─── Configuration ────────────────────────────────────────────────────────────

/** Service slots a task gets a port for. Order defines the band each one lands
 *  in, so appending a service is additive and never renumbers an existing one. */
export const PORT_SERVICES = ['app', 'api', 'postgres', 'redis'] as const;

export type PortService = (typeof PORT_SERVICES)[number];

export interface PortPoolConfig {
  /** First port of the first (app) band. `app` for offset N is `basePort + N`. */
  basePort: number;
  /** How many concurrent tasks the pool serves, and the stride between bands. */
  poolSize: number;
}

/**
 * basePort 8000 / poolSize 100 → app 8001-8100, api 8101-8200,
 * postgres 8201-8300, redis 8301-8400.
 *
 * 8000 because it is the number a developer already reaches for and reads back
 * without effort (`localhost:8003` is obviously worktree 3), and because the
 * whole span stays clear of the two ranges that actually matter: the sub-1024
 * privileged ports, and Linux's default ephemeral range (32768-60999,
 * `net.ipv4.ip_local_port_range`) — allocating inside the latter means the
 * kernel can hand one of our ports out as a source port and the bind fails at
 * random. The well-known squatters inside the span (8080, 8081, 8088) are not
 * designed around; they are handled at allocation time by the liveness probe,
 * which skips any offset whose ports are already answering.
 *
 * poolSize 100 is far more parallel tasks than anyone runs, and using it as the
 * band stride keeps every band on a round hundred, which is the property that
 * makes the numbers memorable.
 */
export const DEFAULT_PORT_POOL: PortPoolConfig = { basePort: 8000, poolSize: 100 };

/** Env var carrying the raw offset; the derived ports use `OCTOMUX_PORT_<SERVICE>`. */
export const PORT_OFFSET_ENV = 'OCTOMUX_PORT_OFFSET';

/** Worktree-relative path of the sourceable dotenv file written per task. */
export const PORT_ENV_REL_PATH = path.join('.octomux', 'ports.env');

// ─── Derivation ───────────────────────────────────────────────────────────────

/**
 * Derive every service port from an offset. Pure — no DB, no I/O — so callers
 * that already know their offset (an agent reading `OCTOMUX_PORT_OFFSET`, a
 * test, a docs example) can recompute the same numbers without a database.
 */
export function portsForOffset(
  offset: number,
  config: PortPoolConfig = DEFAULT_PORT_POOL,
): Record<PortService, number> {
  const { basePort, poolSize } = config;
  if (!Number.isInteger(offset) || offset < 1 || offset > poolSize) {
    throw new RangeError(
      `port offset ${offset} is out of range: expected an integer in [1, ${poolSize}]`,
    );
  }
  const ports = {} as Record<PortService, number>;
  PORT_SERVICES.forEach((service, band) => {
    ports[service] = basePort + band * poolSize + offset;
  });
  return ports;
}

/** The offset plus its derived ports as environment variables. */
export function portEnvForOffset(
  offset: number,
  config: PortPoolConfig = DEFAULT_PORT_POOL,
): Record<string, string> {
  const env: Record<string, string> = { [PORT_OFFSET_ENV]: String(offset) };
  for (const [service, port] of Object.entries(portsForOffset(offset, config))) {
    env[`OCTOMUX_PORT_${service.toUpperCase()}`] = String(port);
  }
  return env;
}

// ─── Liveness probe ───────────────────────────────────────────────────────────

/** Returns true when nothing is listening on `port`. */
export type PortProbe = (port: number) => Promise<boolean>;

const PROBE_TIMEOUT_MS = 150;

/**
 * Probe a port by dialling it: a completed connection means somebody owns it,
 * and anything else (ECONNREFUSED, timeout) means it is free.
 *
 * Deliberately a connect and not a bind. Binding would need us to bind on every
 * interface a container might publish on to be meaningful, and would itself
 * race with the thing we are trying to leave room for. A refused connection is
 * the cheap, honest answer — and it is only advisory anyway: the registry, not
 * the probe, is what keeps two octomux tasks apart.
 */
export async function isTcpPortFree(
  port: number,
  host = '127.0.0.1',
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (free: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(false));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(true));
    socket.connect(port, host);
  });
}

async function everyPortFree(
  offset: number,
  config: PortPoolConfig,
  probe: PortProbe,
): Promise<boolean> {
  for (const port of Object.values(portsForOffset(offset, config))) {
    if (!(await probe(port))) return false;
  }
  return true;
}

// ─── Allocation ───────────────────────────────────────────────────────────────

export interface AllocateOptions {
  config?: PortPoolConfig;
  /** Override the liveness probe (tests inject a deterministic one). */
  isPortFree?: PortProbe;
}

/**
 * Reserve the lowest free offset for `taskId` and return it.
 *
 * Idempotent: a second call for the same task returns the same offset without
 * touching the pool. Throws when every offset in the pool is either allocated
 * or has a port somebody else is already listening on.
 */
export async function allocatePortOffset(
  taskId: string,
  opts: AllocateOptions = {},
): Promise<number> {
  const config = opts.config ?? DEFAULT_PORT_POOL;
  const probe = opts.isPortFree ?? ((port: number) => isTcpPortFree(port));

  const existing = readOffset(taskId);
  if (existing !== undefined) return existing;

  const taken = readTakenOffsets();
  const busy: number[] = [];

  for (let offset = 1; offset <= config.poolSize; offset++) {
    if (taken.has(offset)) continue;
    if (!(await everyPortFree(offset, config, probe))) {
      busy.push(offset);
      continue;
    }
    const claimed = claimOffset(taskId, offset);
    if (claimed !== null) {
      logger.info(
        { task_id: taskId, operation: 'allocatePortOffset', port_offset: claimed },
        'ports: allocated port offset',
      );
      return claimed;
    }
    // Lost the race for this offset — somebody else holds it now.
    taken.add(offset);
  }

  throw new Error(
    `port pool exhausted: all ${config.poolSize} offsets from ${config.basePort + 1} are ` +
      `allocated to other tasks or already in use (${taken.size} allocated, ${busy.length} in use)`,
  );
}

/**
 * Release a task's offset back to the pool. Returns true when a row went away.
 *
 * `ON DELETE CASCADE` already covers task deletion; this is the explicit path
 * for close/reset, where the task row survives but its ports should not.
 */
export function releasePortOffset(taskId: string): boolean {
  const removed = deleteOffset(taskId) > 0;
  if (removed) {
    logger.info({ task_id: taskId, operation: 'releasePortOffset' }, 'ports: released port offset');
  }
  return removed;
}

// ─── Delivery into the worktree ───────────────────────────────────────────────

/**
 * Write the sourceable dotenv file at `<worktree>/.octomux/ports.env`.
 *
 * `.octomux/` inside a worktree is the established home for per-task files the
 * agent is meant to see (`artifact.md`, the phase sentinels, `hooks/`), and a
 * flat `KEY=value` file is what a compose file (`env_file:`), a shell
 * (`source`), and an agent reading it all understand without a helper.
 */
export function writePortEnvFile(worktreePath: string, env: Record<string, string>): string {
  const file = path.join(worktreePath, PORT_ENV_REL_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.writeFileSync(file, `${body}\n`);
  return file;
}

/**
 * Merge the port vars into `<worktree>/.claude/settings.local.json`'s `env`
 * block, which is how the harness actually exports them into every session it
 * runs in this worktree. The file is already written during setup
 * (`writeAgentLocalSettings`), so this extends it rather than introducing a
 * second settings surface.
 *
 * Never clobbers: an unreadable or non-JSON file is left exactly as-is and only
 * warned about. Losing a user's settings to rescue a port number is a bad
 * trade, and `ports.env` still carries the values either way.
 */
export function mergePortEnvIntoAgentSettings(
  worktreePath: string,
  env: Record<string, string>,
): boolean {
  const settingsPath = path.join(worktreePath, '.claude', 'settings.local.json');
  let settings: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('settings.local.json is not a JSON object');
      }
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      logger.warn(
        { operation: 'mergePortEnvIntoAgentSettings', settings_path: settingsPath, err },
        'ports: could not read agent settings; leaving it untouched (ports.env still written)',
      );
      return false;
    }
  }

  const current = settings.env;
  const merged =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>), ...env }
      : { ...env };
  settings.env = merged;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

export interface TaskPortProvision {
  offset: number;
  ports: Record<PortService, number>;
  env: Record<string, string>;
}

/**
 * Allocate an offset for the task and publish the derived ports into its
 * worktree. Returns null when nothing could be allocated.
 *
 * Best-effort by design: an exhausted pool or an unwritable worktree must not
 * fail task creation. Without ports the worktree is exactly as usable as it was
 * before this feature existed, so the failure mode is "no isolation", not "no
 * task" — the warning says which one happened. A delivery that fails after the
 * offset is reserved still returns the provision, so the launch path can pass
 * the vars through the environment even when neither file landed.
 */
export async function provisionTaskPorts(
  taskId: string,
  worktreePath: string,
  opts: AllocateOptions = {},
): Promise<TaskPortProvision | null> {
  const config = opts.config ?? DEFAULT_PORT_POOL;

  let offset: number;
  try {
    offset = await allocatePortOffset(taskId, opts);
  } catch (err) {
    logger.warn(
      { task_id: taskId, operation: 'provisionTaskPorts', worktree: worktreePath, err },
      'ports: could not allocate a port offset; task continues without port isolation',
    );
    return null;
  }

  const ports = portsForOffset(offset, config);
  const env = portEnvForOffset(offset, config);

  try {
    writePortEnvFile(worktreePath, env);
    mergePortEnvIntoAgentSettings(worktreePath, env);
  } catch (err) {
    logger.warn(
      { task_id: taskId, operation: 'provisionTaskPorts', worktree: worktreePath, err },
      'ports: allocated an offset but could not write it into the worktree',
    );
  }

  logger.info(
    { task_id: taskId, operation: 'provisionTaskPorts', port_offset: offset, ports },
    'ports: provisioned worktree ports',
  );
  return { offset, ports, env };
}
