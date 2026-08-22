import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from '../../bun-test.js';
import { runVerify, VERIFY_CACHE_REL_PATH } from './verify.js';

const created: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function write(repo: string, rel: string, contents: string): void {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function makeRepo(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-verify-test-')));
  created.push(repo);
  git(repo, ['init', '-q']);
  write(repo, 'src/a.txt', 'alpha\n');
  git(repo, ['add', '-A']);
  git(repo, [
    '-c',
    'user.email=test@octomux.local',
    '-c',
    'user.name=octomux test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'init',
  ]);
  return repo;
}

/** A tally file kept OUTSIDE the repo, so counting runs can't perturb the tree hash. */
function makeTally(): { cmd: (suffix?: string) => string; runs: () => number } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-tally-')));
  created.push(dir);
  const file = path.join(dir, 'runs.log');
  return {
    cmd: (suffix = '') => `printf 'x' >> '${file}'; ${suffix || 'true'}`,
    runs: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0),
  };
}

function readCacheFile(repo: string): { version: number; entries: Record<string, unknown> } | null {
  const file = path.join(repo, VERIFY_CACHE_REL_PATH);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

afterEach(() => {
  while (created.length) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

describe('runVerify', () => {
  it('passes when the command exits 0', async () => {
    const result = await runVerify(makeRepo(), 'echo hello');
    expect(result.passed).toBe(true);
    expect(result.output).toContain('hello');
    expect(result.cached).toBe(false);
  });

  it('fails with captured output when the command exits non-zero', async () => {
    const result = await runVerify(makeRepo(), 'echo boom >&2; exit 1');
    expect(result.passed).toBe(false);
    expect(result.output).toContain('boom');
    expect(result.cached).toBe(false);
  });

  it('skips the command on a second run against the same tree', async () => {
    const repo = makeRepo();
    const tally = makeTally();

    const first = await runVerify(repo, tally.cmd());
    const second = await runVerify(repo, tally.cmd());

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.passed).toBe(true);
    expect(tally.runs()).toBe(1);
  });

  it('re-runs after an edit and serves the cache again once the edit is reverted', async () => {
    const repo = makeRepo();
    const tally = makeTally();
    const cmd = tally.cmd();

    const initial = await runVerify(repo, cmd);
    write(repo, 'src/a.txt', 'edited\n');
    const afterEdit = await runVerify(repo, cmd);
    write(repo, 'src/a.txt', 'alpha\n');
    const afterRevert = await runVerify(repo, cmd);

    expect([initial.cached, afterEdit.cached, afterRevert.cached]).toEqual([false, false, true]);
    expect(tally.runs()).toBe(2);
  });

  it('caches failing verdicts too', async () => {
    const repo = makeRepo();
    const tally = makeTally();

    const first = await runVerify(repo, tally.cmd('exit 1'));
    const second = await runVerify(repo, tally.cmd('exit 1'));

    expect(first.passed).toBe(false);
    expect(second).toEqual({ passed: false, output: first.output, cached: true });
    expect(tally.runs()).toBe(1);
  });

  it('keys the cache on the command as well as the tree', async () => {
    const repo = makeRepo();
    const tally = makeTally();

    await runVerify(repo, tally.cmd());
    const other = await runVerify(repo, tally.cmd('true # different command'));

    expect(other.cached).toBe(false);
    expect(tally.runs()).toBe(2);
    expect(Object.keys(readCacheFile(repo)!.entries)).toHaveLength(2);
  });

  const outcomes: Array<{ what: string; suffix: string; cacheable: boolean }> = [
    { what: 'a plain non-zero exit', suffix: 'exit 3', cacheable: true },
    { what: 'a command-not-found exit 127', suffix: 'octomux-no-such-binary', cacheable: true },
    { what: 'a SIGKILL', suffix: 'kill -9 $$', cacheable: false },
    { what: 'a SIGTERM (what a timeout looks like)', suffix: 'kill -TERM $$', cacheable: false },
  ];

  it.each(outcomes)('$what is cached: $cacheable', async ({ suffix, cacheable }) => {
    const repo = makeRepo();
    const tally = makeTally();
    const cmd = tally.cmd(suffix);

    const first = await runVerify(repo, cmd);
    const second = await runVerify(repo, cmd);

    expect(first.passed).toBe(false);
    expect(second.cached).toBe(cacheable);
    expect(tally.runs()).toBe(cacheable ? 1 : 2);
  });

  it('bypasses the cache entirely with { cache: false }', async () => {
    const repo = makeRepo();
    const tally = makeTally();

    await runVerify(repo, tally.cmd(), { cache: false });
    const second = await runVerify(repo, tally.cmd(), { cache: false });

    expect(second.cached).toBe(false);
    expect(tally.runs()).toBe(2);
    expect(readCacheFile(repo)).toBeNull();
  });

  it('runs normally and caches nothing outside a git repository', async () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-nogit-verify-')));
    created.push(plain);
    const tally = makeTally();

    const first = await runVerify(plain, tally.cmd());
    const second = await runVerify(plain, tally.cmd());

    expect(first).toEqual({ passed: true, output: '', cached: false });
    expect(second.cached).toBe(false);
    expect(tally.runs()).toBe(2);
    expect(readCacheFile(plain)).toBeNull();
  });

  it('stores an inspectable entry at .octomux/verify-cache.json', async () => {
    const repo = makeRepo();
    await runVerify(repo, 'echo hi');

    const cache = readCacheFile(repo)!;
    expect(cache.version).toBe(1);
    const entry = Object.values(cache.entries)[0] as Record<string, unknown>;
    expect(entry.command).toBe('echo hi');
    expect(entry.passed).toBe(true);
    expect(entry.output).toContain('hi');
    expect(typeof entry.durationMs).toBe('number');
  });

  it('treats a corrupt cache file as a miss instead of throwing', async () => {
    const repo = makeRepo();
    const tally = makeTally();
    write(repo, VERIFY_CACHE_REL_PATH, 'not json {{{');

    const result = await runVerify(repo, tally.cmd());

    expect(result.passed).toBe(true);
    expect(result.cached).toBe(false);
    expect(tally.runs()).toBe(1);
    expect(readCacheFile(repo)!.version).toBe(1);
  });

  it('never writes to the repository index', async () => {
    const repo = makeRepo();
    write(repo, 'src/b.txt', 'staged\n');
    git(repo, ['add', 'src/b.txt']);
    const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index'));

    await runVerify(repo, 'echo hi');
    await runVerify(repo, 'echo hi');

    expect(fs.readFileSync(path.join(repo, '.git', 'index')).equals(indexBefore)).toBe(true);
    expect(git(repo, ['status', '--porcelain'])).toContain('A  src/b.txt');
  });
});
