import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import Database from '../../sqlite.js';
import { describe, it, expect, beforeEach, afterEach } from '../../bun-test.js';
import { createTestDb, insertTask } from '../../test-helpers.js';
import {
  DEFAULT_PORT_POOL,
  PORT_ENV_REL_PATH,
  PORT_SERVICES,
  allocatePortOffset,
  isTcpPortFree,
  mergePortEnvIntoAgentSettings,
  portEnvForOffset,
  portsForOffset,
  provisionTaskPorts,
  releasePortOffset,
  writePortEnvFile,
  type PortPoolConfig,
  type PortProbe,
} from './ports.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let db: Database;
const tmpDirs: string[] = [];

/** Every port free, but with a real await so concurrent callers interleave. */
const freeProbe: PortProbe = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return true;
};

/** Every port free, resolving immediately (fast path for allocation-only tests). */
const alwaysFree: PortProbe = async () => true;

function busyProbe(busyPorts: number[]): PortProbe {
  const busy = new Set(busyPorts);
  return async (port) => !busy.has(port);
}

function seedTask(id: string): void {
  insertTask(db, { id });
}

function tmpWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-ports-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// ─── portsForOffset ───────────────────────────────────────────────────────────

describe('portsForOffset', () => {
  it.each([
    { offset: 1, app: 8001, api: 8101, postgres: 8201, redis: 8301 },
    { offset: 2, app: 8002, api: 8102, postgres: 8202, redis: 8302 },
    { offset: 3, app: 8003, api: 8103, postgres: 8203, redis: 8303 },
    { offset: 42, app: 8042, api: 8142, postgres: 8242, redis: 8342 },
    { offset: 100, app: 8100, api: 8200, postgres: 8300, redis: 8400 },
  ])('offset $offset → app $app / postgres $postgres', (row) => {
    expect(portsForOffset(row.offset)).toEqual({
      app: row.app,
      api: row.api,
      postgres: row.postgres,
      redis: row.redis,
    });
  });

  it('is pure offset arithmetic, not a hash — offset N app port is basePort + N', () => {
    for (let offset = 1; offset <= DEFAULT_PORT_POOL.poolSize; offset++) {
      expect(portsForOffset(offset).app).toBe(DEFAULT_PORT_POOL.basePort + offset);
    }
  });

  it('never overlaps two service bands across the whole pool', () => {
    const seen = new Set<number>();
    for (let offset = 1; offset <= DEFAULT_PORT_POOL.poolSize; offset++) {
      for (const port of Object.values(portsForOffset(offset))) {
        expect(seen.has(port)).toBe(false);
        seen.add(port);
      }
    }
    expect(seen.size).toBe(DEFAULT_PORT_POOL.poolSize * PORT_SERVICES.length);
  });

  it('stays clear of the privileged and Linux ephemeral ranges', () => {
    const all = Array.from({ length: DEFAULT_PORT_POOL.poolSize }, (_, i) =>
      Object.values(portsForOffset(i + 1)),
    ).flat();
    expect(Math.min(...all)).toBeGreaterThan(1023);
    expect(Math.max(...all)).toBeLessThan(32768);
  });

  it.each([
    { label: 'zero', offset: 0 },
    { label: 'negative', offset: -1 },
    { label: 'above the pool', offset: 101 },
    { label: 'fractional', offset: 1.5 },
    { label: 'NaN', offset: Number.NaN },
  ])('rejects an $label offset', (row) => {
    expect(() => portsForOffset(row.offset)).toThrow(RangeError);
  });

  it('honours a custom pool config', () => {
    const config: PortPoolConfig = { basePort: 20000, poolSize: 10 };
    expect(portsForOffset(3, config)).toEqual({
      app: 20003,
      api: 20013,
      postgres: 20023,
      redis: 20033,
    });
    expect(() => portsForOffset(11, config)).toThrow(RangeError);
  });
});

// ─── portEnvForOffset ─────────────────────────────────────────────────────────

describe('portEnvForOffset', () => {
  it('exposes the offset and every derived port', () => {
    expect(portEnvForOffset(3)).toEqual({
      OCTOMUX_PORT_OFFSET: '3',
      OCTOMUX_PORT_APP: '8003',
      OCTOMUX_PORT_API: '8103',
      OCTOMUX_PORT_POSTGRES: '8203',
      OCTOMUX_PORT_REDIS: '8303',
    });
  });

  it('stringifies every value (env vars are strings)', () => {
    for (const value of Object.values(portEnvForOffset(7))) {
      expect(typeof value).toBe('string');
    }
  });
});

// ─── allocatePortOffset ───────────────────────────────────────────────────────

describe('allocatePortOffset', () => {
  it('hands the first task the lowest offset', async () => {
    seedTask('task-a');
    expect(await allocatePortOffset('task-a', { isPortFree: alwaysFree })).toBe(1);
  });

  it('is idempotent — a second call returns the same offset', async () => {
    seedTask('task-a');
    const first = await allocatePortOffset('task-a', { isPortFree: alwaysFree });
    const second = await allocatePortOffset('task-a', { isPortFree: alwaysFree });
    expect(second).toBe(first);
    expect(db.query('SELECT COUNT(*) AS n FROM port_allocations').get()).toEqual({ n: 1 });
  });

  it('gives distinct offsets to distinct tasks', async () => {
    for (const id of ['a', 'b', 'c']) seedTask(id);
    const offsets = [
      await allocatePortOffset('a', { isPortFree: alwaysFree }),
      await allocatePortOffset('b', { isPortFree: alwaysFree }),
      await allocatePortOffset('c', { isPortFree: alwaysFree }),
    ];
    expect(offsets).toEqual([1, 2, 3]);
    expect(new Set(offsets).size).toBe(3);
  });

  it('reuses the lowest offset freed by a release', async () => {
    for (const id of ['a', 'b', 'c']) seedTask(id);
    await allocatePortOffset('a', { isPortFree: alwaysFree });
    await allocatePortOffset('b', { isPortFree: alwaysFree });
    releasePortOffset('a');
    expect(await allocatePortOffset('c', { isPortFree: alwaysFree })).toBe(1);
  });

  it('skips an offset whose ports are already in use', async () => {
    seedTask('a');
    // Something else owns 8201 (offset 1's postgres port).
    const offset = await allocatePortOffset('a', { isPortFree: busyProbe([8201]) });
    expect(offset).toBe(2);
    expect(portsForOffset(offset).postgres).toBe(8202);
  });

  it('walks past a run of busy offsets', async () => {
    seedTask('a');
    const busy = [1, 2, 3].map((o) => portsForOffset(o).app);
    expect(await allocatePortOffset('a', { isPortFree: busyProbe(busy) })).toBe(4);
  });

  it('throws a meaningful error when the pool is exhausted', async () => {
    const config: PortPoolConfig = { basePort: 9000, poolSize: 2 };
    for (const id of ['a', 'b', 'c']) seedTask(id);
    await allocatePortOffset('a', { config, isPortFree: alwaysFree });
    await allocatePortOffset('b', { config, isPortFree: alwaysFree });
    await expect(allocatePortOffset('c', { config, isPortFree: alwaysFree })).rejects.toThrow(
      /port pool exhausted: all 2 offsets/,
    );
  });

  it('counts in-use ports toward exhaustion', async () => {
    const config: PortPoolConfig = { basePort: 9000, poolSize: 2 };
    seedTask('a');
    await expect(
      allocatePortOffset('a', { config, isPortFree: async () => false }),
    ).rejects.toThrow(/2 in use/);
  });

  it('rejects an allocation for a task that does not exist (FK)', async () => {
    await expect(allocatePortOffset('ghost', { isPortFree: alwaysFree })).rejects.toThrow();
  });

  // ── Concurrency ────────────────────────────────────────────────────────────
  // Both calls read the same "taken" set before either writes; the UNIQUE index
  // on `offset` is what stops them landing on the same one.

  it('never hands two concurrent tasks the same offset', async () => {
    seedTask('a');
    seedTask('b');
    const [first, second] = await Promise.all([
      allocatePortOffset('a', { isPortFree: freeProbe }),
      allocatePortOffset('b', { isPortFree: freeProbe }),
    ]);
    expect(first).not.toBe(second);
    expect(new Set([first, second])).toEqual(new Set([1, 2]));
  });

  it('keeps offsets unique across many concurrent allocations', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `task-${i}`);
    for (const id of ids) seedTask(id);
    const offsets = await Promise.all(
      ids.map((id) => allocatePortOffset(id, { isPortFree: freeProbe })),
    );
    expect(new Set(offsets).size).toBe(ids.length);
    expect([...offsets].sort((x, y) => x - y)).toEqual(ids.map((_, i) => i + 1));
  });

  it('produces non-overlapping port sets for concurrent tasks', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    for (const id of ids) seedTask(id);
    const offsets = await Promise.all(
      ids.map((id) => allocatePortOffset(id, { isPortFree: freeProbe })),
    );
    const ports = offsets.flatMap((o) => Object.values(portsForOffset(o)));
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('stays idempotent when the same task allocates concurrently', async () => {
    seedTask('a');
    const results = await Promise.all([
      allocatePortOffset('a', { isPortFree: freeProbe }),
      allocatePortOffset('a', { isPortFree: freeProbe }),
      allocatePortOffset('a', { isPortFree: freeProbe }),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(db.query('SELECT COUNT(*) AS n FROM port_allocations').get()).toEqual({ n: 1 });
  });
});

// ─── releasePortOffset ────────────────────────────────────────────────────────

describe('releasePortOffset', () => {
  it('returns true when it removed an allocation', async () => {
    seedTask('a');
    await allocatePortOffset('a', { isPortFree: alwaysFree });
    expect(releasePortOffset('a')).toBe(true);
    expect(db.query('SELECT COUNT(*) AS n FROM port_allocations').get()).toEqual({ n: 0 });
  });

  it('returns false when the task holds nothing', () => {
    expect(releasePortOffset('never-allocated')).toBe(false);
  });

  it('is idempotent', async () => {
    seedTask('a');
    await allocatePortOffset('a', { isPortFree: alwaysFree });
    expect(releasePortOffset('a')).toBe(true);
    expect(releasePortOffset('a')).toBe(false);
  });

  it('frees the offset for the next allocation', async () => {
    seedTask('a');
    seedTask('b');
    const first = await allocatePortOffset('a', { isPortFree: alwaysFree });
    releasePortOffset('a');
    expect(await allocatePortOffset('b', { isPortFree: alwaysFree })).toBe(first);
  });

  it('is cascaded by deleting the task row', async () => {
    seedTask('a');
    await allocatePortOffset('a', { isPortFree: alwaysFree });
    db.query('DELETE FROM tasks WHERE id = ?').run('a');
    expect(db.query('SELECT COUNT(*) AS n FROM port_allocations').get()).toEqual({ n: 0 });
  });
});

// ─── isTcpPortFree ────────────────────────────────────────────────────────────

describe('isTcpPortFree', () => {
  it('reports a listening port as busy and a closed one as free', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    expect(await isTcpPortFree(port)).toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isTcpPortFree(port)).toBe(true);
  });
});

// ─── Delivery into the worktree ───────────────────────────────────────────────

describe('writePortEnvFile', () => {
  it('writes a sourceable dotenv file under .octomux/', () => {
    const worktree = tmpWorktree();
    const file = writePortEnvFile(worktree, portEnvForOffset(3));
    expect(file).toBe(path.join(worktree, PORT_ENV_REL_PATH));
    expect(fs.readFileSync(file, 'utf-8')).toBe(
      [
        'OCTOMUX_PORT_OFFSET=3',
        'OCTOMUX_PORT_APP=8003',
        'OCTOMUX_PORT_API=8103',
        'OCTOMUX_PORT_POSTGRES=8203',
        'OCTOMUX_PORT_REDIS=8303',
        '',
      ].join('\n'),
    );
  });

  it('creates .octomux/ when it does not exist yet', () => {
    const worktree = tmpWorktree();
    writePortEnvFile(worktree, portEnvForOffset(1));
    expect(fs.existsSync(path.join(worktree, '.octomux'))).toBe(true);
  });
});

describe('mergePortEnvIntoAgentSettings', () => {
  function settingsPath(worktree: string): string {
    return path.join(worktree, '.claude', 'settings.local.json');
  }

  function writeSettings(worktree: string, body: string): string {
    const file = settingsPath(worktree);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  }

  it('adds an env block, preserving unrelated settings', () => {
    const worktree = tmpWorktree();
    writeSettings(worktree, JSON.stringify({ plugins: { 'remember@x': false } }));

    expect(mergePortEnvIntoAgentSettings(worktree, portEnvForOffset(2))).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath(worktree), 'utf-8'));
    expect(settings.plugins).toEqual({ 'remember@x': false });
    expect(settings.env.OCTOMUX_PORT_APP).toBe('8002');
    expect(settings.env.OCTOMUX_PORT_OFFSET).toBe('2');
  });

  it('merges into an existing env block instead of replacing it', () => {
    const worktree = tmpWorktree();
    writeSettings(worktree, JSON.stringify({ env: { MY_VAR: 'keep', OCTOMUX_PORT_APP: 'stale' } }));

    mergePortEnvIntoAgentSettings(worktree, portEnvForOffset(5));

    const settings = JSON.parse(fs.readFileSync(settingsPath(worktree), 'utf-8'));
    expect(settings.env.MY_VAR).toBe('keep');
    expect(settings.env.OCTOMUX_PORT_APP).toBe('8005');
  });

  it('creates the file (and .claude/) when the worktree has no settings yet', () => {
    const worktree = tmpWorktree();

    expect(mergePortEnvIntoAgentSettings(worktree, portEnvForOffset(1))).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath(worktree), 'utf-8')).env.OCTOMUX_PORT_APP).toBe(
      '8001',
    );
  });

  it.each([
    { label: 'invalid JSON', body: '{ not json' },
    { label: 'a JSON array', body: '[]' },
    { label: 'a JSON scalar', body: '"hello"' },
  ])('leaves $label untouched rather than clobbering it', (row) => {
    const worktree = tmpWorktree();
    writeSettings(worktree, row.body);

    expect(mergePortEnvIntoAgentSettings(worktree, portEnvForOffset(1))).toBe(false);
    expect(fs.readFileSync(settingsPath(worktree), 'utf-8')).toBe(row.body);
  });
});

describe('provisionTaskPorts', () => {
  it('allocates, writes ports.env, and merges agent settings', async () => {
    seedTask('a');
    const worktree = tmpWorktree();

    const result = await provisionTaskPorts('a', worktree, { isPortFree: alwaysFree });

    expect(result).not.toBeNull();
    expect(result!.offset).toBe(1);
    expect(result!.ports.app).toBe(8001);
    expect(result!.env.OCTOMUX_PORT_REDIS).toBe('8301');
    expect(fs.readFileSync(path.join(worktree, PORT_ENV_REL_PATH), 'utf-8')).toContain(
      'OCTOMUX_PORT_APP=8001',
    );
    const settings = JSON.parse(
      fs.readFileSync(path.join(worktree, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(settings.env.OCTOMUX_PORT_APP).toBe('8001');
  });

  it('returns null instead of throwing when the pool is exhausted', async () => {
    const config: PortPoolConfig = { basePort: 9000, poolSize: 1 };
    seedTask('a');
    seedTask('b');
    await allocatePortOffset('a', { config, isPortFree: alwaysFree });

    expect(await provisionTaskPorts('b', tmpWorktree(), { config, isPortFree: alwaysFree })).toBe(
      null,
    );
  });

  it('returns null instead of throwing when the task row is missing', async () => {
    expect(await provisionTaskPorts('ghost', tmpWorktree(), { isPortFree: alwaysFree })).toBe(null);
  });

  it('is idempotent per task', async () => {
    seedTask('a');
    const worktree = tmpWorktree();
    const first = await provisionTaskPorts('a', worktree, { isPortFree: alwaysFree });
    const second = await provisionTaskPorts('a', worktree, { isPortFree: alwaysFree });
    expect(second!.offset).toBe(first!.offset);
  });

  it('gives two tasks in the same repo non-overlapping ports', async () => {
    seedTask('a');
    seedTask('b');
    const [first, second] = await Promise.all([
      provisionTaskPorts('a', tmpWorktree(), { isPortFree: freeProbe }),
      provisionTaskPorts('b', tmpWorktree(), { isPortFree: freeProbe }),
    ]);
    const firstPorts = Object.values(first!.ports);
    const secondPorts = Object.values(second!.ports);
    expect(firstPorts.some((p) => secondPorts.includes(p))).toBe(false);
  });
});
