import type { EarnedBadge, Task, TaskPage, UserStats } from '@adhd/shared';
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
  confirmedAt: null,
  parentTaskId: null,
  stepOrder: null,
  estimateMinutes: null,
  suggestedEstimateMinutes: null,
  ingestionRecordId: null,
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
/** What GET /me/badges serves. Mutable so a test can award one. */
let BADGES_EARNED: EarnedBadge[] = [];

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
    const body = url.includes('/me/stats')
      ? stats
      : url.includes('/me/badges')
        ? BADGES_EARNED
        : page;

    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
};

const urlsCalled = (): string[] => fetchMock.mock.calls.map((call) => call[0]);

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('starter badges', () => {
  afterEach(() => {
    BADGES_EARNED = [];
  });

  it('shows the badges the server says were earned, and none it did not', async () => {
    BADGES_EARNED = [
      {
        key: 'first_task_done',
        name: 'First win',
        description: 'Finished your first task.',
        awardedAt: '2026-10-07T18:00:00.000Z',
      },
    ];
    serve([]);

    render(<HomePage />);

    const list = await screen.findByRole('list', { name: 'Badges' });
    expect(within(list).getByText('First win')).toBeInTheDocument();
    expect(screen.queryByText('On a roll')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/me/badges'))).toBe(true);
  });
});

describe('task list', () => {
  it('renders each task with its title, priority, status and due date', async () => {
    serve([
      task({
        title: 'Write the report',
        manualPriority: 'urgent',
        dueAt: '2026-09-20T00:00:00.000Z',
      }),
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

  it('asks the API for drafts, which it no longer sends by default', async () => {
    withDraft();

    render(<HomePage />);
    await screen.findByText('Typed by hand');

    // The API fences drafts out of the default page. This view is the review
    // surface, so it opts in — without this the suggestions toggle would show
    // (0) forever and the user would never see what was extracted.
    expect(urlsCalled().some((url) => url.includes('include=drafts'))).toBe(true);
  });

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

  it('drops the badge once the user approves the suggestion', async () => {
    withDraft();

    render(<HomePage />);
    await screen.findByText('Typed by hand');
    fireEvent.click(screen.getByLabelText(/AI suggestions/));

    const draftRow = screen.getByText('Suggested by AI').closest('li') as HTMLElement;
    expect(within(draftRow).getByText('AI draft')).toBeInTheDocument();

    // Approving returns the confirmed task, and the refetch that follows
    // serves it. `source` is deliberately still ai_suggested — provenance does
    // not change — so a badge keyed on source alone would survive this.
    serve([
      task({ title: 'Typed by hand' }),
      task({
        id: '55555555-5555-5555-5555-555555555555',
        title: 'Suggested by AI',
        source: 'ai_suggested',
        confirmedAt: '2026-09-08T11:00:00.000Z',
      }),
    ]);

    fireEvent.click(within(draftRow).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(callWithMethod('POST')?.[0]).toContain(
        '/tasks/55555555-5555-5555-5555-555555555555/approve',
      );
    });

    // It has left the suggestions list for the ordinary open one, unbadged.
    await waitFor(() => {
      const row = screen.getByText('Suggested by AI').closest('li') as HTMLElement;
      expect(within(row).queryByText('AI draft')).not.toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    });
  });

  it('rejects a suggestion through the reject route', async () => {
    withDraft();

    render(<HomePage />);
    await screen.findByText('Typed by hand');
    fireEvent.click(screen.getByLabelText(/AI suggestions/));

    const draftRow = screen.getByText('Suggested by AI').closest('li') as HTMLElement;
    fireEvent.click(within(draftRow).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(callWithMethod('POST')?.[0]).toContain(
        '/tasks/55555555-5555-5555-5555-555555555555/reject',
      );
    });
  });

  it('offers no approve button on a task the user typed themselves', async () => {
    withDraft();

    render(<HomePage />);
    const manualRow = (await screen.findByText('Typed by hand')).closest('li') as HTMLElement;

    // Confirmation is for suggestions. Offering it here would imply a hand-typed
    // task was somehow provisional.
    expect(within(manualRow).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('offers steps under an open task the user owns, and not under a suggestion', async () => {
    withDraft();

    render(<HomePage />);
    const manualRow = (await screen.findByText('Typed by hand')).closest('li') as HTMLElement;
    fireEvent.click(screen.getByLabelText(/AI suggestions/));
    const draftRow = screen.getByText('Suggested by AI').closest('li') as HTMLElement;

    // A suggestion has to be approved before it can be broken down — the API
    // 409s otherwise — so the panel is not there to offer it.
    expect(within(manualRow).getByRole('button', { name: 'Steps' })).toBeInTheDocument();
    expect(within(draftRow).queryByRole('button', { name: 'Steps' })).not.toBeInTheDocument();
  });

  it('offers an estimate under an open task the user owns, and not under a suggestion or a finished task', async () => {
    serve([
      task({ title: 'Typed by hand' }),
      task({ id: '55555555-5555-5555-5555-555555555555', title: 'Suggested by AI', source: 'ai_suggested' }),
      task({
        id: '44444444-4444-4444-4444-444444444444',
        title: 'Finished',
        status: 'done',
        completedAt: '2026-09-08T11:00:00.000Z',
      }),
    ]);

    render(<HomePage />);
    const manualRow = (await screen.findByText('Typed by hand')).closest('li') as HTMLElement;
    fireEvent.click(screen.getByLabelText(/AI suggestions/));
    const draftRow = screen.getByText('Suggested by AI').closest('li') as HTMLElement;

    // Same rule as Steps: the API 409s an estimate on an unapproved suggestion.
    expect(within(manualRow).getByRole('button', { name: 'Estimate' })).toBeInTheDocument();
    expect(within(draftRow).queryByRole('button', { name: 'Estimate' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const doneRow = (await screen.findByText('Finished')).closest('li') as HTMLElement;
    expect(within(doneRow).queryByRole('button', { name: 'Estimate' })).not.toBeInTheDocument();
  });

  it('offers no steps under a finished task, which has nothing left to start', async () => {
    serve([task({ title: 'Finished', status: 'done', completedAt: '2026-09-08T11:00:00.000Z' })]);

    render(<HomePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    const doneRow = (await screen.findByText('Finished')).closest('li') as HTMLElement;

    expect(within(doneRow).queryByRole('button', { name: 'Steps' })).not.toBeInTheDocument();
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
