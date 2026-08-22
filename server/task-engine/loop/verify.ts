import { execFile as execFileCb } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { childLogger } from '../../logger.js';
import { computeTreeHash } from './tree-hash.js';

const execFile = promisify(execFileCb);
const logger = childLogger('task-engine/loop/verify');

/**
 * Where the cache lives, relative to the worktree.
 *
 * Inside the worktree, next to `loop-status.json`, because that is the only
 * store whose lifetime already matches the thing being cached: the cache is
 * only valid for trees of THIS worktree, and `deleteTask`'s `git worktree
 * remove` takes it away with no extra bookkeeping. It is also plain JSON a
 * human can open when a cached verdict looks wrong. The DB was not an option
 * (and would have outlived the worktree anyway).
 *
 * `tree-hash.ts` excludes `.octomux/` from the hash, so writing this file does
 * not change the key that indexes it.
 */
export const VERIFY_CACHE_REL_PATH = path.join('.octomux', 'verify-cache.json');

const CACHE_VERSION = 1;
/** Keep the file bounded: a long loop touches a handful of trees, not hundreds. */
const MAX_ENTRIES = 50;
/** A failing test suite can print megabytes; the loop prompt only ever shows 4k of it. */
const MAX_OUTPUT_CHARS = 64 * 1024;
const TRUNCATION_MARKER = '\n… [octomux: verify output truncated for cache]';

export interface VerifyResult {
  passed: boolean;
  output: string;
  /**
   * True when this verdict was replayed from the cache instead of running the
   * command. Optional so existing `VerifyResult` literals stay valid.
   */
  cached?: boolean;
}

export interface VerifyOptions {
  /** Set false to bypass the cache entirely — the command always runs, nothing is stored. */
  cache?: boolean;
}

interface CacheEntry {
  command: string;
  passed: boolean;
  output: string;
  durationMs: number;
  at: string;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

/** `(treeHash, command)` — the command is hashed only to keep the key short. */
function cacheKey(treeHash: string, cmd: string): string {
  return `${treeHash}:${createHash('sha256').update(cmd).digest('hex').slice(0, 16)}`;
}

function cachePath(cwd: string): string {
  return path.join(cwd, VERIFY_CACHE_REL_PATH);
}

/** Never throws: a missing, unreadable or corrupt cache file is simply a miss. */
function readCache(cwd: string): CacheFile | null {
  try {
    const raw = fs.readFileSync(cachePath(cwd), 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed?.version !== CACHE_VERSION || typeof parsed.entries !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Never throws: a read-only worktree must not turn into a failed verify. */
function writeCache(cwd: string, key: string, entry: CacheEntry): void {
  try {
    const cache = readCache(cwd) ?? { version: CACHE_VERSION, entries: {} };
    // Re-insert so key order tracks recency, then evict the oldest.
    delete cache.entries[key];
    cache.entries[key] = entry;
    const keys = Object.keys(cache.entries);
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
      delete cache.entries[stale];
    }
    fs.mkdirSync(path.dirname(cachePath(cwd)), { recursive: true });
    fs.writeFileSync(cachePath(cwd), JSON.stringify(cache, null, 2) + '\n');
  } catch (err) {
    logger.debug(
      { operation: 'verify_cache_write', worktree: cwd, reason: (err as Error).message },
      'loop: could not persist verify cache',
    );
  }
}

function truncateForCache(output: string): string {
  return output.length <= MAX_OUTPUT_CHARS
    ? output
    : output.slice(0, MAX_OUTPUT_CHARS) + TRUNCATION_MARKER;
}

interface CommandOutcome {
  passed: boolean;
  output: string;
  /**
   * Whether the outcome is a verdict about the TREE rather than about the
   * environment. Exit 0 and any plain non-zero exit code qualify. A process
   * killed by a signal (loop/CI timeout, OOM killer), a command that could not
   * be spawned at all (`ENOENT`), or one that blew past `maxBuffer` do not —
   * re-running them on the same tree can legitimately produce a different
   * answer, so they must never be cached.
   */
  deterministic: boolean;
}

async function runCommand(cwd: string, cmd: string): Promise<CommandOutcome> {
  try {
    const { stdout, stderr } = await execFile('sh', ['-c', cmd], { cwd });
    return { passed: true, output: stdout + stderr, deterministic: true };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      message: string;
      code?: number | string | null;
      signal?: string | null;
    };
    const output = [e.stdout, e.stderr].filter(Boolean).join('') || e.message;
    const deterministic = typeof e.code === 'number' && e.signal == null;
    return { passed: false, output, deterministic };
  }
}

/**
 * Run the loop's verify shell command in `cwd`; exit 0 = pass.
 *
 * Verification is content-addressed: the working tree is hashed into a real git
 * tree SHA (`computeTreeHash`) and the verdict for `(tree, command)` is cached
 * in the worktree. An iteration that changed nothing — or that made an edit and
 * then reverted it — hits the cache and skips the command entirely, which is
 * where a multi-minute test suite gets its time back. Test the tree, not every
 * commit.
 *
 * Every path other than a cache hit behaves exactly as it did before: the
 * command runs in `cwd` under `sh -c`, and pass/fail plus combined output are
 * reported the same way. When the tree cannot be hashed (not a git repo) the
 * cache silently disables itself.
 */
export async function runVerify(
  cwd: string,
  cmd: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const treeHash = options.cache === false ? null : await computeTreeHash(cwd);
  const key = treeHash ? cacheKey(treeHash, cmd) : null;

  if (key) {
    const hit = readCache(cwd)?.entries[key];
    if (hit) {
      logger.info(
        {
          operation: 'verify_cache_hit',
          worktree: cwd,
          tree_hash: treeHash,
          passed: hit.passed,
          saved_ms: hit.durationMs,
        },
        'loop: verify served from cache — same tree, same command',
      );
      return { passed: hit.passed, output: hit.output, cached: true };
    }
  }

  const startedAt = Date.now();
  const outcome = await runCommand(cwd, cmd);
  const durationMs = Date.now() - startedAt;

  if (key && outcome.deterministic) {
    writeCache(cwd, key, {
      command: cmd,
      passed: outcome.passed,
      output: truncateForCache(outcome.output),
      durationMs,
      at: new Date().toISOString(),
    });
  } else if (key) {
    logger.debug(
      { operation: 'verify_cache_skip', worktree: cwd, tree_hash: treeHash },
      'loop: verify ended ambiguously (signal or spawn failure) — result not cached',
    );
  }

  return { passed: outcome.passed, output: outcome.output, cached: false };
}
