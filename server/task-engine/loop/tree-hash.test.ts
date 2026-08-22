import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from '../../bun-test.js';
import { computeTreeHash, TREE_HASH_EXCLUDES } from './tree-hash.js';

const created: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function commit(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c',
    'user.email=test@octomux.local',
    '-c',
    'user.name=octomux test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  ]);
}

function write(repo: string, rel: string, contents: string): void {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** A real repo on disk: mirrors a loop worktree — sources, a .gitignore, and a committed
 * `.octomux/loop-status.json` (which `commitAll` really does commit every iteration). */
function makeRepo(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-treehash-test-')));
  created.push(repo);
  git(repo, ['init', '-q']);
  write(repo, '.gitignore', 'build/\n');
  write(repo, 'src/a.txt', 'alpha\n');
  write(repo, 'src/b.txt', 'beta\n');
  write(repo, '.octomux/loop-status.json', '{"iteration":1}\n');
  commit(repo, 'init');
  return repo;
}

afterEach(() => {
  while (created.length) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

describe('computeTreeHash', () => {
  it('produces a real git tree object, not a synthesised digest', async () => {
    const repo = makeRepo();
    const hash = await computeTreeHash(repo);

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, ['cat-file', '-t', hash!]).trim()).toBe('tree');
    expect(git(repo, ['cat-file', '-p', hash!])).toContain('src');
  });

  it('is stable across calls when nothing changes', async () => {
    const repo = makeRepo();
    expect(await computeTreeHash(repo)).toBe((await computeTreeHash(repo))!);
  });

  const mutations: Array<{ what: string; mutate: (repo: string) => void; changes: boolean }> = [
    {
      what: 'an edit to a tracked file',
      mutate: (repo) => write(repo, 'src/a.txt', 'edited\n'),
      changes: true,
    },
    {
      what: 'a new untracked file',
      mutate: (repo) => write(repo, 'src/c.txt', 'gamma\n'),
      changes: true,
    },
    {
      what: 'deleting a tracked file',
      mutate: (repo) => fs.rmSync(path.join(repo, 'src/b.txt')),
      changes: true,
    },
    {
      what: 'a gitignored build artifact (documented limit)',
      mutate: (repo) => write(repo, 'build/out.js', 'compiled\n'),
      changes: false,
    },
    {
      what: 'a rewritten .octomux/loop-status.json',
      mutate: (repo) => write(repo, '.octomux/loop-status.json', '{"iteration":2}\n'),
      changes: false,
    },
    {
      what: 'a brand new file under .octomux',
      mutate: (repo) => write(repo, '.octomux/verify-cache.json', '{"version":1}\n'),
      changes: false,
    },
  ];

  it.each(mutations)('$what changes the hash: $changes', async ({ mutate, changes }) => {
    const repo = makeRepo();
    const before = await computeTreeHash(repo);
    mutate(repo);
    const after = await computeTreeHash(repo);

    expect(before).not.toBeNull();
    if (changes) expect(after).not.toBe(before!);
    else expect(after).toBe(before!);
  });

  it('returns to the earlier hash when an edit is reverted (the greentree case)', async () => {
    const repo = makeRepo();
    const original = await computeTreeHash(repo);

    write(repo, 'src/a.txt', 'broken\n');
    const dirty = await computeTreeHash(repo);
    expect(dirty).not.toBe(original!);

    write(repo, 'src/a.txt', 'alpha\n');
    expect(await computeTreeHash(repo)).toBe(original!);
  });

  it('ignores .octomux even when the loop has committed it', async () => {
    const repo = makeRepo();
    const before = await computeTreeHash(repo);

    write(repo, '.octomux/loop-status.json', '{"iteration":7,"updatedAt":"later"}\n');
    commit(repo, 'loop(run-1): iteration 7');

    expect(await computeTreeHash(repo)).toBe(before!);
    expect(TREE_HASH_EXCLUDES).toContain('.octomux');
  });

  it('leaves the repository index and working tree untouched', async () => {
    const repo = makeRepo();
    write(repo, 'src/a.txt', 'dirty\n');
    write(repo, 'src/staged.txt', 'staged\n');
    git(repo, ['add', 'src/staged.txt']);

    const indexPath = path.join(repo, '.git', 'index');
    const indexBefore = fs.readFileSync(indexPath);
    const statusBefore = git(repo, ['status', '--porcelain']);

    await computeTreeHash(repo);

    expect(fs.readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(git(repo, ['status', '--porcelain'])).toBe(statusBefore);
    expect(fs.existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
  });

  it('leaves no scratch index behind in the temp dir', () => {
    const repo = makeRepo();
    // Own TMPDIR in a child process: parallel test files share os.tmpdir(), so counting
    // scratch dirs in-process would race with every other isolate.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-tmpdir-test-')));
    created.push(tmp);
    const script = path.join(tmp, 'run.ts');
    const modulePath = path.join(import.meta.dir, 'tree-hash.ts');
    fs.writeFileSync(
      script,
      `const { computeTreeHash } = await import(${JSON.stringify(modulePath)});\n` +
        `for (let i = 0; i < 3; i++) await computeTreeHash(${JSON.stringify(repo)});\n`,
    );

    execFileSync(process.execPath, [script], { env: { ...process.env, TMPDIR: tmp } });

    expect(fs.readdirSync(tmp)).toEqual(['run.ts']);
  });

  it('returns null outside a git repository instead of throwing', async () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-nogit-test-')));
    created.push(plain);
    write(plain, 'a.txt', 'alpha\n');

    expect(await computeTreeHash(plain)).toBeNull();
  });

  it('hashes a conflicted worktree without resolving the real index', async () => {
    const repo = makeRepo();
    git(repo, ['checkout', '-q', '-b', 'other']);
    write(repo, 'src/a.txt', 'theirs\n');
    commit(repo, 'theirs');
    git(repo, ['checkout', '-q', '-']);
    write(repo, 'src/a.txt', 'ours\n');
    commit(repo, 'ours');
    try {
      git(repo, ['merge', 'other']);
    } catch {
      // expected: the merge conflicts and leaves unmerged entries in the real index
    }
    expect(git(repo, ['ls-files', '-u'])).not.toBe('');

    // `git add -A` stages the marker-laden working copy into the SCRATCH index, so a
    // conflicted tree still hashes (and verify will legitimately fail on it) — while the
    // real index keeps its unmerged stages, i.e. the user's conflict is not resolved.
    expect(await computeTreeHash(repo)).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, ['ls-files', '-u'])).not.toBe('');
  });
});
