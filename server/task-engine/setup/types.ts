import type { Task } from '../../types.js';

export interface SetupResult {
  worktreePath: string;
  branch: string | null;
  baseBranch: string | null;
  baseSha: string | null;
  installHooksAt: string;
  /**
   * Environment the launched agent should carry, produced by setup itself —
   * today the per-worktree port allocation (`OCTOMUX_PORT_OFFSET` and the
   * derived `OCTOMUX_PORT_*`), see `setup/ports.ts`.
   *
   * The values already reach the agent through the worktree
   * (`.octomux/ports.env` and the `env` block of
   * `.claude/settings.local.json`). Surfacing them here as well lets the launch
   * path pass them straight to `buildAgentStartupCommand({ env })`, which is
   * the one delivery that does not depend on the harness reading a file.
   */
  env?: Record<string, string>;
}

export type SetupFn = (task: Task) => Promise<SetupResult>;
