import type { Task, TaskPage, UserStats } from '@adhd/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import HomePage from './page';

/**
 * The task list rendered against a mocked API, exercised through the real
 * client module — only `fetch` is stubbed, so the URL and method each action
 * produces are part of what this covers.
 */

const task = (over: Partial<Task> = {}): Task => ({
  id: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  title: 'Write the report',
  description: null,
  status: 'pending',
  manualPriority: 'high',
  source: 'manual',
  dueAt: null,
  completedAt: null,
  parentTaskId: null,
  createdAt: '2026-09-08T10:00:00.000Z',
  updatedAt: '2026-09-08T10:00:00.000Z',
  ...over,
});

const STATS: UserStats = {
  totalXp: 28,
  level: 1,
  currentStreak: 2,
  longestStreak: 5,
  lastActiveDate: '2026-09-08',
};

// @types/jest still spells this `Mock<Return, Args>`, not the modern
// `Mock<Fn>` — passing a function type here would silently leave the call
// tuple as `any[]`, which is what the assertions below read off.
const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit]>();

/** The fetch call made with the given method, if any. */
const callWithMethod = (method: string): [string, RequestInit] | undefined =>
  fetchMock.mock.calls.find((call) => call[1].method === method);

/** The JSON body that call carried. */
const bodyOf = (call: [string, RequestInit] | undefined): unknown => {
  const body = call?.[1].body;

  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
};

/** Serves /tasks and /me/stats from the given fixtures, in any order. */
const serve = (items: Task[], stats: UserStats = STATS): void => {
  fetchMock.mockImplementation((url) => {
    const page: TaskPage = { items, total: items.length, limit: 100, offset: 0 };
    const body = url.includes('/me/stats') ? stats : page;

    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
};

const urlsCalled = (): string[] => fetchMock.mock.calls.map((call) => call[0]);

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('task list', () => {
  it('renders each task with its title, priority, status and due date', async () => {
    serve([
      task({ title: 'Write the report', manualPriority: 'urgent', dueAt: '2026-09-20T00:00:00.000Z' }),
      task({ id: '33333333-3333-3333-3333-333333333333', title: 'Book the dentist' }),
    ]);

    render(<HomePage />);

    const row = await screen.findByText('Write the report');
    const listItem = row.closest('li');

    expect(listItem).not.toBeNull();
    expect(within(listItem as HTMLElement).getByText('urgent')).toBeInTheDocument();
    expect(within(listItem as HTMLElement).getByText('pending')).toBeInTheDocument();
    expect(within(listItem as HTMLElement).getByText(/due /)).toBeInTheDocument();
    expect(screen.getByText('Book the dentist')).toBeInTheDocument();
  });

  it('shows the stats header from /me/stats', async () => {
    serve([task()]);

    render(<HomePage />);

    const header = await screen.findByLabelText('Your progress');

    expect(within(header).getByText('28')).toBeInTheDocument(); // total XP
    expect(within(header).getByText('2 d')).toBeInTheDocument(); // current streak
    expect(within(header).getByText('5 d')).toBeInTheDocument(); // longest streak
  });

  it('separates open from done behind the tabs', async () => {
    serve([
      task({ title: 'Still open' }),
      task({ id: '44444444-4444-4444-4444-444444444444', title: 'Finished', status: 'done' }),
    ]);

    render(<HomePage />);

    expect(await screen.findByText('Still open')).toBeInTheDocument();
    expect(screen.queryByText('Finished')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.getByText('Finished')).toBeInTheDocument();
    expect(screen.queryByText('Still open')).not.toBeInTheDocument();
  });
});

describe('the human-in-the-loop fence', () => {
  const withDraft = (): void => {
    serve([
      task({ title: 'Typed by hand' }),
      task({
        id: '55555555-5555-5555-5555-555555555555',
        title: 'Suggested by AI',
        source: 'ai_suggested',
      }),
    ]);
  };

  it('hides AI drafts until the toggle is switched on', async () => {
    withDraft();

    render(<HomePage />);

    // The whole point: an unconfirmed suggestion must not sit in the open list
    // looking like something the user already agreed to.
    expect(await screen.findByText('Typed by hand')).toBeInTheDocument();
    expect(screen.queryByText('Suggested by AI')).not.toBeInTheDocument();
  });

  it('keeps drafts out of the done list even when revealed', async () => {
    withDraft();

    render(<HomePage />);
    await screen.findByText('Typed by hand');

    fireEvent.click(screen.getByLabelText(/AI suggestions/));
    expect(screen.getByText('Suggested by AI')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    // A suggestion nobody has confirmed is not something the user completed.
    expect(screen.queryByText('Suggested by AI')).not.toBeInTheDocument();
  });

  it('marks a revealed draft with a distinct badge', async () => {
    withDraft();

    render(<HomePage />);
    await screen.findByText('Typed by hand');

    fireEvent.click(screen.getByLabelText(/AI suggestions/));

    const draftRow = screen.getByText('Suggested by AI').closest('li');
    expect(within(draftRow as HTMLElement).getByText('AI draft')).toBeInTheDocument();

    // And the hand-written one is not badged, so the badge means something.
    const manualRow = screen.getByText('Typed by hand').closest('li');
    expect(within(manualRow as HTMLElement).queryByText('AI draft')).not.toBeInTheDocument();
  });
});

describe('actions', () => {
  it('completes a task with PATCH status done and refetches stats', async () => {
    serve([task({ title: 'Write the report' })]);

    render(<HomePage />);
    await screen.findByText('Write the report');

    fireEvent.click(screen.getByLabelText('Complete Write the report'));

    await waitFor(() => {
      const patch = callWithMethod('PATCH');
      expect(patch).toBeDefined();
      expect(bodyOf(patch)).toEqual({ status: 'done' });
    });

    // Refetched rather than guessed: XP and streaks are server-derived.
    await waitFor(() => {
      expect(urlsCalled().filter((url) => url.includes('/me/stats'))).toHaveLength(2);
    });
  });

  it('creates a task from the form', async () => {
    serve([]);

    render(<HomePage />);
    await screen.findByText(/Nothing open/);

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Buy milk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(bodyOf(callWithMethod('POST'))).toMatchObject({
        title: 'Buy milk',
        manualPriority: 'med',
      });
    });
  });

  it('deletes a task', async () => {
    serve([task({ title: 'Write the report' })]);

    render(<HomePage />);
    await screen.findByText('Write the report');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(callWithMethod('DELETE')?.[0]).toContain(
        '/tasks/11111111-1111-1111-1111-111111111111',
      );
    });
  });

  it('renames a task inline without touching any other field', async () => {
    serve([task({ title: 'Write the report' })]);

    render(<HomePage />);
    await screen.findByText('Write the report');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByLabelText('Title for Write the report');
    fireEvent.change(input, { target: { value: 'Write the summary' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(bodyOf(callWithMethod('PATCH'))).toEqual({ title: 'Write the summary' });
    });
  });
});

describe('signed-out and unreachable states', () => {
  it('explains a 401 instead of rendering an empty list', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ message: 'No active Clerk session' }),
    });

    render(<HomePage />);

    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
    // An empty task list would read as "you're all caught up", which is a lie.
    expect(screen.queryByText(/Nothing open/)).not.toBeInTheDocument();
  });

  it('says so when the API cannot be reached at all', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<HomePage />);

    expect(await screen.findByText('Could not load your tasks')).toBeInTheDocument();
  });
});
