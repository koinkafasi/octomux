import { describe, it, expect, vi, beforeEach } from '../bun-test.js';

// Reached through `flattenRunningAgents`' module (GridMonitor → AgentGridCell → TerminalView);
// OfficePage never renders one, and the xterm/WebSocket tree is dead weight here.
vi.mock('@/components/TerminalView', () => ({
  TerminalView: () => <div data-testid="terminal-stub" />,
}));

const { taskApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));

const { screen, waitFor, fireEvent } = await import('@testing-library/react');
const { renderWithRouter, makeTask, makeAgent } = await import('../test-helpers');

const OfficePage = (await import('./OfficePage')).default;

type Activity = 'active' | 'idle' | 'waiting';

function runningTask(id: string, title: string, activities: Activity[]) {
  return makeTask({
    id,
    title,
    runtime_state: 'running',
    workers: activities.map((activity, index) =>
      makeAgent({
        id: `${id}-w${index}`,
        task_id: id,
        window_index: index,
        label: `Agent ${index + 1}`,
        hook_activity: activity,
      }),
    ),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  apiMock.listTasks.mockReset();
  apiMock.listTasks.mockResolvedValue([]);
});

describe('OfficePage', () => {
  it('shows the empty state when nothing is running', async () => {
    renderWithRouter(<OfficePage />);

    expect(await screen.findByText('The office is empty')).toBeInTheDocument();
    expect(screen.queryByTestId('office-canvas')).toBeNull();
    expect(screen.queryByTestId('office-roster')).toBeNull();
  });

  it('reads the same task feed GridMonitor does', async () => {
    renderWithRouter(<OfficePage />);
    await waitFor(() => expect(apiMock.listTasks).toHaveBeenCalled());
    expect(apiMock.listTasks).toHaveBeenCalledWith({ includeAutomated: true });
  });

  it('renders the canvas and a roster row per running agent', async () => {
    apiMock.listTasks.mockResolvedValue([
      runningTask('t1', 'Fix the poller', ['active', 'idle']),
      runningTask('t2', 'Ship the release', ['waiting']),
    ]);

    renderWithRouter(<OfficePage />);

    expect(await screen.findByTestId('office-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('office-roster')).toBeInTheDocument();
    expect(screen.getByTestId('office-roster-t1:0')).toBeInTheDocument();
    expect(screen.getByTestId('office-roster-t1:1')).toBeInTheDocument();
    expect(screen.getByTestId('office-roster-t2:0')).toBeInTheDocument();
    expect(screen.getByText('3 running agents · refreshes every 5s')).toBeInTheDocument();
  });

  it('flags the agents that are blocked on a human', async () => {
    apiMock.listTasks.mockResolvedValue([
      runningTask('t1', 'Fix the poller', ['active']),
      runningTask('t2', 'Ship the release', ['waiting']),
    ]);

    renderWithRouter(<OfficePage />);

    const banner = await screen.findByTestId('office-waiting-banner');
    expect(banner).toHaveTextContent('1 agent waiting for input');
  });

  it('has no waiting banner when nobody is blocked', async () => {
    apiMock.listTasks.mockResolvedValue([runningTask('t1', 'Fix the poller', ['active', 'idle'])]);

    renderWithRouter(<OfficePage />);

    await screen.findByTestId('office-canvas');
    expect(screen.queryByTestId('office-waiting-banner')).toBeNull();
  });

  it('skips tasks and agents GridMonitor skips', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 'idle-task', runtime_state: 'idle', workers: [makeAgent({ id: 'w' })] }),
      makeTask({
        id: 't1',
        runtime_state: 'running',
        workers: [makeAgent({ id: 'w1', task_id: 't1', window_index: 0, status: 'stopped' })],
      }),
    ]);

    renderWithRouter(<OfficePage />);

    expect(await screen.findByText('The office is empty')).toBeInTheDocument();
  });

  it('links a selected agent to its task', async () => {
    apiMock.listTasks.mockResolvedValue([runningTask('t1', 'Fix the poller', ['waiting'])]);

    renderWithRouter(<OfficePage />);

    const row = await screen.findByTestId('office-roster-t1:0');
    expect(screen.queryByTestId('office-selection')).toBeNull();

    fireEvent.click(row);

    const selection = await screen.findByTestId('office-selection');
    expect(selection).toHaveTextContent('Fix the poller');
    expect(screen.getByRole('link', { name: 'Open task' })).toHaveAttribute('href', '/tasks/t1');
    expect(row).toHaveAttribute('aria-pressed', 'true');
  });

  it('clears the selection when the same row is clicked again', async () => {
    apiMock.listTasks.mockResolvedValue([runningTask('t1', 'Fix the poller', ['active'])]);

    renderWithRouter(<OfficePage />);

    const row = await screen.findByTestId('office-roster-t1:0');
    fireEvent.click(row);
    await screen.findByTestId('office-selection');

    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByTestId('office-selection')).toBeNull());
  });

  it('surfaces a failed poll instead of rendering an empty office silently', async () => {
    apiMock.listTasks.mockRejectedValue(new Error('backend is down'));

    renderWithRouter(<OfficePage />);

    expect(await screen.findByTestId('office-error')).toHaveTextContent('backend is down');
  });
});
