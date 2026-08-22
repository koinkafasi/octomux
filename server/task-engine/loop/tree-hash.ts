import { execFile as execFileCb } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { childLogger } from '../../logger.js';

const execFile = promisify(execFileCb);
const logger = childLogger('task-engine/loop/tree-hash');

/**
 * Worktree-relative paths deliberately kept OUT of the content hash.
 *
 * `.octomux/` is octomux's own control plane living inside the worktree:
 * `loop-status.json` is rewritten at every iteration boundary (and committed by
 * `commitAll` on the next one), and `verify-cache.json` is the cache keyed by
 * this very hash. Hashing either would make every iteration look like a brand
 * new tree, and would let the cache invalidate itself the moment it is written.
 */
export const TREE_HASH_EXCLUDES = ['.octomux'];

/**
 * Seed the scratch index from the repo's real one.
 *
 * Purely an optimisation: git's index carries a stat cache, so a seeded index
 * only re-hashes files whose stat data moved, instead of reading every tracked
 * file in the worktree. Correctness does not depend on it — git re-hashes on
 * any stat mismatch — so a missing/unreadable index just means we start empty.
 */
async function seedScratchIndex(cwd: string, indexFile: string): Promise<void> {
  try {
    const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', '--git-path', 'index']);
    await fs.promises.copyFile(path.resolve(cwd, stdout.trim()), indexFile);
  } catch {
    // Fresh repo with no index yet, or not a repo at all. An empty scratch index
    // is still correct; `git add -A` will simply hash everything.
  }
}

/**
 * Content-address the (possibly dirty) working tree at `cwd` as a real git tree
 * object, without touching the repository's own index.
 *
 * The trick is `GIT_INDEX_FILE`: `git add -A` stages the entire worktree into a
 * throwaway index file under the OS temp dir, `git rm --cached` drops the
 * excluded control-plane paths back out of it, and `git write-tree` turns that
 * index into a genuine tree SHA. `.git/index` is never opened for writing, so a
 * concurrently staged change in the user's repo survives untouched — and the
 * lock file git takes is `<scratch>/index.lock`, so we never contend with a
 * real `git add` either.
 *
 * Known, intentional limit: `git add -A` honours `.gitignore`, so untracked-but-
 * ignored files (build output, `node_modules`, `.env`) do NOT contribute to the
 * hash. A verify command whose result depends only on ignored files can
 * therefore be served from cache after those files change. That is the same
 * boundary git itself draws around "the content of this project", and the loop
 * commits with `git add -A` for the same reason.
 *
 * @returns the tree SHA, or `null` when the tree cannot be hashed (not a git
 * repo, unmerged index, git missing). `null` means "caching is off for this
 * run" — never an error; callers fall back to running the command.
 */
export async function computeTreeHash(cwd: string): Promise<string | null> {
  let scratch: string | null = null;
  try {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octomux-tree-'));
    const indexFile = path.join(scratch, 'index');
    await seedScratchIndex(cwd, indexFile);

    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    await execFile('git', ['-C', cwd, 'add', '-A'], { env });
    for (const excluded of TREE_HASH_EXCLUDES) {
      await execFile(
        'git',
        ['-C', cwd, 'rm', '-r', '--cached', '--ignore-unmatch', '-q', '--', excluded],
        { env },
      );
    }
    const { stdout } = await execFile('git', ['-C', cwd, 'write-tree'], { env });
    return stdout.trim() || null;
  } catch (err) {
    logger.debug(
      { operation: 'compute_tree_hash', worktree: cwd, reason: (err as Error).message },
      'tree hash unavailable — verify cache disabled for this run',
    );
    return null;
  } finally {
    if (scratch) {
      await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}
