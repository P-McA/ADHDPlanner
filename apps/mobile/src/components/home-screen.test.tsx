import type { Task, TaskPage, UserStats } from '@adhd/shared';
import { render, screen, waitFor } from '@testing-library/react-native';

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
    getStats: jest.fn(),
    completeTask: jest.fn(),
  };
});

const listTasks = api.listTasks as jest.MockedFunction<typeof api.listTasks>;
const listDrafts = api.listDrafts as jest.MockedFunction<typeof api.listDrafts>;
const getStats = api.getStats as jest.MockedFunction<typeof api.getStats>;

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

const page = (items: Task[]): TaskPage => ({ items, total: items.length, limit: 50, offset: 0 });

beforeEach(() => {
  jest.clearAllMocks();
  getStats.mockResolvedValue(stats);
  listDrafts.mockResolvedValue(
    page([
      task(),
      task({ id: 'a0000000-0000-4000-8000-000000000002', source: 'ai_suggested', title: 'ring the dentist' }),
    ]),
  );
  listTasks.mockResolvedValue(page([]));
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
});
