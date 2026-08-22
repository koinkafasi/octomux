/**
 * `/office` — a pixel-art room that stands in for the running agents.
 *
 * This is an *additional* view, not a replacement for anything. agora-lab, where the canvas
 * engine comes from, demoted its own version out of the primary control surface ("Lab View is
 * a low-motion monitoring surface … The canvas is no longer the primary control surface"), and
 * octomux already has the surfaces that lesson points to: `/monitor` for live terminals,
 * `/tasks` for the board. So this page reads the same data those pages read, adds no API of its
 * own, changes no existing route, and keeps every character standing still until its activity
 * actually changes.
 *
 * The one thing it is trying to be better at than a grid of terminals: showing, at a glance,
 * which agents are blocked on a human.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { taskApi } from '@/lib/api/taskApi';
import { regularTasksOnly } from '@/lib/task-filters';
import { EmptyState } from '@/components/EmptyState';
import { AgentActivityDot } from '@/components/AgentActivityDot';
import { TerminalRectIcon } from '@/components/icons';
import { OfficeCanvas } from '@/components/office/OfficeCanvas';
import {
  agentsSignature,
  buildOfficeScene,
  type OfficeAgent,
} from '@/components/office/agents-to-characters';
import { flattenRunningAgents } from '@/lib/running-agents';

const REFRESH_MS = 5000;

export default function OfficePage() {
  // The agent list, not the task list: it is the smaller thing the view actually depends on,
  // and keeping the previous array whenever the poll changed nothing is what stops the canvas
  // from repainting every five seconds.
  const [agents, setAgents] = useState<OfficeAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchAgents = async () => {
      try {
        // Same source and same filters as GridMonitor: every live agent including automated
        // runs, minus auto_review tasks.
        const tasks = regularTasksOnly(await taskApi.listTasks({ includeAutomated: true }));
        if (cancelled) return;
        const next = flattenRunningAgents(tasks);
        setAgents((prev) => (agentsSignature(prev) === agentsSignature(next) ? prev : next));
        setError(null);
        setLoaded(true);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load agents');
        setLoaded(true);
      }
    };

    fetchAgents();
    const id = setInterval(fetchAgents, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const scene = useMemo(() => buildOfficeScene(agents), [agents]);
  const waiting = useMemo(() => agents.filter((a) => a.activity === 'waiting'), [agents]);
  const selected = useMemo(
    () => agents.find((a) => a.key === selectedKey) ?? null,
    [agents, selectedKey],
  );

  // An agent that stopped between polls should not stay selected.
  useEffect(() => {
    if (selectedKey && !agents.some((a) => a.key === selectedKey)) setSelectedKey(null);
  }, [agents, selectedKey]);

  const handleSelect = useCallback((key: string | null) => setSelectedKey(key), []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-glass-edge px-4 py-2">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider">Office</h1>
          <p className="text-[11px] text-muted-foreground">
            {agents.length} running agent{agents.length === 1 ? '' : 's'} · refreshes every 5s
          </p>
        </div>
        {waiting.length > 0 && (
          <p
            data-testid="office-waiting-banner"
            className="rounded-md border border-[#FFB800]/40 bg-[#FFB800]/10 px-3 py-1 text-[11px] font-medium text-[#FFB800]"
          >
            {waiting.length} agent{waiting.length === 1 ? '' : 's'} waiting for input
          </p>
        )}
        {error && (
          <p data-testid="office-error" className="text-[11px] text-destructive">
            {error}
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-hidden p-3">
        {loaded && agents.length === 0 ? (
          <EmptyState
            icon={<TerminalRectIcon size={32} />}
            heading="The office is empty"
            subtext="Start a task and its agents will take a desk here."
            action={
              <Link
                to="/"
                className="rounded-md border border-glass-edge bg-glass-l1 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-glass-l2"
              >
                Create a task
              </Link>
            }
          />
        ) : (
          <OfficeCanvas
            scene={scene}
            selectedCharacterId={selectedKey}
            onSelectCharacter={handleSelect}
            className="h-full w-full overflow-hidden rounded-lg border border-glass-edge bg-[#0a0d12]"
            label={`Pixel office with ${agents.length} agents, ${waiting.length} waiting for input`}
          />
        )}
      </div>

      {agents.length > 0 && (
        // The canvas is one opaque <canvas> to a screen reader and to a keyboard, so the same
        // roster exists in the DOM: it selects the same character and links to the same task.
        <aside
          data-testid="office-roster"
          aria-label="Agents in the office"
          className="max-h-48 shrink-0 overflow-auto border-t border-glass-edge px-3 py-2"
        >
          <ul className="flex flex-wrap gap-2">
            {agents.map((agent) => {
              const isSelected = agent.key === selectedKey;
              return (
                <li key={agent.key}>
                  <button
                    type="button"
                    data-testid={`office-roster-${agent.key}`}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedKey(isSelected ? null : agent.key)}
                    className={`flex items-center gap-2 rounded-md border px-2 py-1 text-left text-xs ${
                      isSelected
                        ? 'border-primary bg-glass-l2 text-foreground'
                        : 'border-glass-edge bg-glass-l1 text-muted-foreground hover:bg-glass-l2'
                    }`}
                  >
                    <AgentActivityDot activity={agent.activity} />
                    <span className="font-medium text-foreground">{agent.agentName}</span>
                    <span className="max-w-[16rem] truncate">{agent.taskTitle}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {selected && (
            <div
              data-testid="office-selection"
              className="mt-2 flex flex-wrap items-center gap-3 border-t border-glass-edge pt-2 text-xs"
            >
              <span className="font-medium text-foreground">{selected.agentName}</span>
              <span className="text-muted-foreground">{selected.taskTitle}</span>
              <AgentActivityDot activity={selected.activity} />
              <Link
                to={`/tasks/${selected.taskId}`}
                className="rounded-md border border-glass-edge bg-glass-l1 px-2 py-1 font-medium text-foreground hover:bg-glass-l2"
              >
                Open task
              </Link>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
