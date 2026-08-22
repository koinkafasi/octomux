import type { Task } from '@octomux/types';

/**
 * One running worker, flattened out of the task list.
 *
 * Lives here rather than beside a page because two surfaces consume it —
 * `/monitor`'s terminal grid and `/office`'s canvas — and importing it from
 * the monitor page dragged that page's module graph (TerminalView → xterm and
 * its addons) into the office chunk, which never renders a terminal.
 */
export interface FlatAgent {
  key: string;
  taskId: string;
  windowIndex: number;
  taskTitle: string;
  agentName: string;
  activity: 'active' | 'idle' | 'waiting';
}

/** Running (or starting) tasks' live workers, in task order. */
export function flattenRunningAgents(tasks: Task[]): FlatAgent[] {
  const out: FlatAgent[] = [];
  for (const task of tasks) {
    if (task.runtime_state !== 'running' && task.runtime_state !== 'setting_up') continue;
    for (const agent of task.workers ?? []) {
      if (agent.status === 'stopped') continue;
      out.push({
        key: `${task.id}:${agent.window_index}`,
        taskId: task.id,
        windowIndex: agent.window_index,
        taskTitle: task.title || '(untitled task)',
        agentName: agent.label,
        activity: agent.hook_activity,
      });
    }
  }
  return out;
}
