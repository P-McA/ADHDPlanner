import type { RankedTask, Task, TaskPage, UserStats } from '@adhd/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type * as ApiClientModule from '../lib/api-client';
import * as api from '../lib/api-client';
import { HomeScreen } from './home-screen';

type ApiClient = typeof ApiClientModule;

/**
 * One question only: does the suggestions view opt in?
 *
 * The API hides unconfirmed drafts unless a request carries `include=drafts`,
 * so a screen that calls plain `listTasks()` renders "Suggestions (0)" for ever
 * and nothing anywhere goes red. That is the fence incident's shape exactly —
 * a client-side surface that looks like it works.
 *
 * What is mocked here is our own module, not the network: the assertion is
 * "the screen called the opt-in", and whether the opt-in actually returns
 * drafts is proved against real Postgres in `test/mobile-client.e2e-spec.ts`
 * (`serves the phone its drafts only when it asks for them`). Neither half is
 * sufficient alone — one pins the call, the other pins the contract.
 */

jest.mock('../lib/api-client', () => {
  const actual = jest.requireActual<ApiClient>('../lib/api-client');

  return {
    ...actual,
    listTasks: jest.fn(),
    listDrafts: jest.fn(),
    listNext: jest.fn(),
    predictTasks: jest.fn(),
    rejectTask: jest.fn(),
    getStats: jest.fn(),
    completeTask: jest.fn(),
    approveTask: jest.fn(),
    getBadges: jest.fn(),
  };
});

const listTasks = api.listTasks as jest.MockedFunction<typeof api.listTasks>;
const listDrafts = api.listDrafts as jest.MockedFunction<typeof api.listDrafts>;
const listNext = api.listNext as jest.MockedFunction<typeof api.listNext>;
const predictTasks = api.predictTasks as jest.MockedFunction<typeof api.predictTasks>;
const rejectTask = api.rejectTask as jest.MockedFunction<typeof api.rejectTask>;
const getStats = api.getStats as jest.MockedFunction<typeof api.getStats>;
const approveTask = api.approveTask as jest.MockedFunction<typeof api.approveTask>;
const getBadges = api.getBadges as jest.MockedFunction<typeof api.getBadges>;
const completeTask = api.completeTask as jest.MockedFunction<typeof api.completeTask>;

const task = (over: Partial<Task> = {}): Task => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  userId: 'u1',
  title: 'buy milk',
  description: null,
  status: 'pending',
  dueAt: null,
  manualPriority: 'med',
  source: 'manual',
  parentTaskId: null,
  stepOrder: null,
  estimateMinutes: null,
  suggestedEstimateMinutes: null,
  suggestionReason: null,
  ingestionRecordId: null,
  confirmedAt: null,
  completedAt: null,
  createdAt: '2026-09-08T10:00:00.000Z',
  updatedAt: '2026-09-08T10:00:00.000Z',
  ...over,
});

const stats: UserStats = {
  totalXp: 0,
  level: 1,
  currentStreak: 0,
  longestStreak: 0,
  lastActiveDate: null,
};

const ranked = (item: Task, reasons: string[] = []): RankedTask => ({
  ...item,
  rank: { score: 0, reasons },
});

const page = (items: Task[]): TaskPage => ({ items, total: items.length, limit: 50, offset: 0 });

beforeEach(() => {
  jest.clearAllMocks();
  getStats.mockResolvedValue(stats);
  getBadges.mockResolvedValue([]);
  listDrafts.mockResolvedValue(
    page([
      task(),
      task({
        id: 'a0000000-0000-4000-8000-000000000002',
        source: 'ai_suggested',
        title: 'ring the dentist',
      }),
    ]),
  );
  listTasks.mockResolvedValue(page([]));
  // "Next up" is the default order: by default it ranks just the one open task.
  listNext.mockResolvedValue({ items: [ranked(task())], nextCursor: null });
});

describe('HomeScreen', () => {
  it('asks for drafts, which the API does not send by default', async () => {
    await render(<HomeScreen />);

    await waitFor(() => {
      expect(listDrafts).toHaveBeenCalled();
    });

    // Not the plain list: that request comes back fenced, and the suggestions
    // section would sit permanently empty with nothing to show for it.
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('puts the suggestion in the suggestions section and the task in the task list', async () => {
    await render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('suggestions-heading')).toHaveTextContent('Suggestions (1)');
    });

    expect(screen.getByText('buy milk')).toBeTruthy();
    expect(screen.getByText('ring the dentist')).toBeTruthy();
  });

  it('adds a suggestion to the tasks through the approve route, then reloads', async () => {
    const draftId = 'a0000000-0000-4000-8000-000000000002';
    approveTask.mockResolvedValue(task({ id: draftId, source: 'ai_suggested' }));
    await render(<HomeScreen />);
    await waitFor(() => screen.getByTestId(`approve-${draftId}`));
    const loadsBefore = listDrafts.mock.calls.length;

    await fireEvent.press(screen.getByTestId(`approve-${draftId}`));

    await waitFor(() => {
      expect(approveTask).toHaveBeenCalledWith(draftId);
    });
    // Approval, never completion: `done` on an unconfirmed draft is a 409.
    expect(completeTask).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(listDrafts.mock.calls.length).toBeGreaterThan(loadsBefore);
    });
  });

  it('puts "Steps" under an open task, and under neither a suggestion nor a finished task', async () => {
    const doneId = 'a0000000-0000-4000-8000-000000000003';
    listDrafts.mockResolvedValue(
      page([
        task(),
        task({ id: 'a0000000-0000-4000-8000-000000000002', source: 'ai_suggested' }),
        task({ id: doneId, status: 'done', completedAt: '2026-09-08T11:00:00.000Z' }),
      ]),
    );

    await render(<HomeScreen />);
    await waitFor(() => screen.getByTestId(`steps-toggle-${task().id}`));

    // A suggestion has to be added before it can be broken down (the API 409s
    // otherwise), and a finished task has nothing left to start.
    expect(screen.queryByTestId('steps-toggle-a0000000-0000-4000-8000-000000000002')).toBeNull();
    expect(screen.queryByTestId(`steps-toggle-${doneId}`)).toBeNull();
  });

  it('puts "Estimate" under an open task, and under neither a suggestion nor a finished task', async () => {
    const doneId = 'a0000000-0000-4000-8000-000000000003';
    listDrafts.mockResolvedValue(
      page([
        task(),
        task({ id: 'a0000000-0000-4000-8000-000000000002', source: 'ai_suggested' }),
        task({ id: doneId, status: 'done', completedAt: '2026-09-08T11:00:00.000Z' }),
      ]),
    );

    await render(<HomeScreen />);
    await waitFor(() => screen.getByTestId(`estimate-${task().id}`));

    // Same rule as Steps: the API 409s an estimate on a suggestion nobody has
    // approved, and a finished task has nothing left to plan.
    expect(screen.queryByTestId('estimate-a0000000-0000-4000-8000-000000000002')).toBeNull();
    expect(screen.queryByTestId(`estimate-${doneId}`)).toBeNull();
  });

  it('shows the badges the server says were earned, and none it did not', async () => {
    getBadges.mockResolvedValue([
      {
        key: 'first_task_done',
        name: 'First win',
        description: 'Finished your first task.',
        awardedAt: '2026-10-07T18:00:00.000Z',
      },
    ]);

    await render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByText('First win')).toBeTruthy();
    });
    expect(getBadges).toHaveBeenCalled();
    expect(screen.queryByText('On a roll')).toBeNull();
  });
});

describe('HomeScreen — Next up', () => {
  const first = task({ id: 'a0000000-0000-4000-8000-000000000011', title: 'first in the list' });
  const urgent = task({ id: 'a0000000-0000-4000-8000-000000000012', title: 'overdue thing' });
  const titles = (): string[] =>
    screen.getAllByText(/^(first in the list|overdue thing)$/).map((node) => String(node.props.children));

  beforeEach(() => {
    listDrafts.mockResolvedValue(page([first, urgent]));
    listNext.mockResolvedValue({ items: [ranked(urgent, ['Overdue']), ranked(first)], nextCursor: null });
  });

  it('lists open tasks in Next-up order by default, with the reason under each', async () => {
    await render(<HomeScreen />);

    await waitFor(() => {
      expect(titles()).toEqual(['overdue thing', 'first in the list']);
    });
    expect(screen.getByTestId(`rank-reasons-${urgent.id}`)).toHaveTextContent('Overdue');
    expect(screen.queryByTestId(`rank-reasons-${first.id}`)).toBeNull();
  });

  it('switches to the plain due-date list', async () => {
    await render(<HomeScreen />);
    await waitFor(() => screen.getByTestId('order-due'));

    await fireEvent.press(screen.getByTestId('order-due'));

    expect(titles()).toEqual(['first in the list', 'overdue thing']);
  });

  it('loads the next page with the cursor the API gave it, and appends it', async () => {
    listNext.mockImplementation((query = {}) =>
      Promise.resolve(
        query.cursor === 'c1'
          ? { items: [ranked(first)], nextCursor: null }
          : { items: [ranked(urgent)], nextCursor: 'c1' },
      ),
    );
    await render(<HomeScreen />);
    await waitFor(() => screen.getByTestId('show-more'));

    await fireEvent.press(screen.getByTestId('show-more'));

    await waitFor(() => {
      expect(titles()).toEqual(['overdue thing', 'first in the list']);
    });
    expect(listNext).toHaveBeenCalledWith({ cursor: 'c1' });
    expect(screen.queryByTestId('show-more')).toBeNull();
  });
});

describe('HomeScreen — Suggest tasks', () => {
  it('asks for suggestions, then reloads so they appear under Suggestions', async () => {
    predictTasks.mockResolvedValue([task({ id: 'a0000000-0000-4000-8000-000000000021', source: 'ai_suggested' })]);
    await render(<HomeScreen />);
    await waitFor(() => screen.getByTestId('suggest-tasks'));
    const loadsBefore = listDrafts.mock.calls.length;

    await fireEvent.press(screen.getByTestId('suggest-tasks'));

    await waitFor(() => {
      expect(listDrafts.mock.calls.length).toBeGreaterThan(loadsBefore);
    });
    expect(predictTasks).toHaveBeenCalledTimes(1);
    expect(approveTask).not.toHaveBeenCalled();
  });

  it('says so when there is nothing to suggest yet, rather than doing nothing', async () => {
    predictTasks.mockResolvedValue([]);
    await render(<HomeScreen />);
    await waitFor(() => screen.getByTestId('suggest-tasks'));

    await fireEvent.press(screen.getByTestId('suggest-tasks'));

    await waitFor(() => {
      expect(screen.getByTestId('suggest-note')).toHaveTextContent(/Nothing to suggest yet/);
    });
  });
});

describe('HomeScreen — layout', () => {
  const doneTask = task({
    id: 'a0000000-0000-4000-8000-000000000031',
    title: 'already finished',
    status: 'done',
    completedAt: '2026-09-08T11:00:00.000Z',
  });

  it('keeps finished tasks out of the way until asked for', async () => {
    listDrafts.mockResolvedValue(page([task(), doneTask]));
    await render(<HomeScreen />);
    await waitFor(() => screen.getByText('buy milk'));

    expect(screen.queryByText('already finished')).toBeNull();

    await fireEvent.press(screen.getByTestId('done-toggle'));

    // A pattern, not exact: the chevron icon renders as a glyph in the text.
    expect(screen.getByTestId('done-toggle')).toHaveTextContent(/Done \(1\)/);
    expect(screen.getByText('already finished')).toBeTruthy();
  });

  it('lets a suggestion be rejected from the phone, through the reject route, then reloads', async () => {
    const draftId = 'a0000000-0000-4000-8000-000000000002';
    rejectTask.mockResolvedValue(task({ id: draftId, status: 'archived' }));
    await render(<HomeScreen />);
    await waitFor(() => screen.getByTestId(`reject-${draftId}`));
    const loadsBefore = listDrafts.mock.calls.length;

    await fireEvent.press(screen.getByTestId(`reject-${draftId}`));

    await waitFor(() => {
      expect(listDrafts.mock.calls.length).toBeGreaterThan(loadsBefore);
    });
    expect(rejectTask).toHaveBeenCalledWith(draftId);
    expect(approveTask).not.toHaveBeenCalled();
  });

  it('offers a place to type a task', async () => {
    await render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText('New task')).toBeTruthy();
    });
  });
});
