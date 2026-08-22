import { getDb } from '../db.js';

/**
 * Repository for `port_allocations` — the per-task port offset registry that
 * keeps two worktrees from binding the same dev-server ports.
 *
 * The UNIQUE index on `offset` is the concurrency arbiter, not a lock: whoever
 * inserts first wins and every other writer takes SQLITE_CONSTRAINT and re-reads.
 * That is why `claimOffset` distinguishes the two constraint cases below.
 */

interface OffsetRow {
  offset: number;
}

export function readOffset(taskId: string): number | undefined {
  const row = getDb()
    .prepare<OffsetRow, [string]>(`SELECT offset FROM port_allocations WHERE task_id = ?`)
    .get(taskId);
  return row?.offset;
}

export function readTakenOffsets(): Set<number> {
  const rows = getDb().prepare<OffsetRow, []>(`SELECT offset FROM port_allocations`).all();
  return new Set(rows.map((r) => r.offset));
}

/**
 * Try to claim `offset` for `taskId`.
 *
 * Returns the offset the task definitively holds, or null when the claim lost a
 * race for this particular offset and the caller should try the next one. A
 * conflict on `task_id` rather than `offset` means a concurrent call already
 * allocated for the same task — that call's offset is authoritative and is what
 * comes back, which is what makes allocation idempotent even racing itself.
 */
export function claimOffset(taskId: string, offset: number): number | null {
  try {
    getDb()
      .prepare<
        unknown,
        [string, number]
      >(`INSERT INTO port_allocations (task_id, offset) VALUES (?, ?)`)
      .run(taskId, offset);
    return offset;
  } catch (err) {
    if (!isConstraintViolation(err)) throw err;
    return readOffset(taskId) ?? null;
  }
}

/** Release a task's offset back to the pool. Returns rows deleted (0 or 1). */
export function deleteOffset(taskId: string): number {
  const info = getDb()
    .prepare<unknown, [string]>(`DELETE FROM port_allocations WHERE task_id = ?`)
    .run(taskId);
  return info.changes;
}

function isConstraintViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}
