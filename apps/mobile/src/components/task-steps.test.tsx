import type { Task } from '@adhd/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type * as ApiClientModule from '../lib/api-client';
import * as api from '../lib/api-client';
import { TaskSteps } from './task-steps';

type ApiClient = typeof ApiClientModule;

/**
 * The steps panel under a task: which calls it makes, and when.
 *
 * Our own module is mocked, not the network, so nothing here says the routes
 * behave — that is `breaks a task into steps, lists them, and adds or rejects
 * each through the phone's own calls` in apps/api's mobile-client e2e, against
 * real Postgres. These pin the screen's half: it asks for the right thing, it
 * never confirms a step on the user's behalf, and it says why when it fails.
 */

jest.mock('../lib/api-client', () => {
  const actual = jest.requireActual<ApiClient>('../lib/api-client');

  return {
    ...actual,
    listSteps: jest.fn(),
    breakIntoSteps: jest.fn(),
    approveTask: jest.fn(),
    rejectTask: jest.fn(),
    completeTask: jest.fn(),
  };
});

const listSteps = api.listSteps as jest.MockedFunction<typeof api.listSteps>;
const breakIntoSteps = api.breakIntoSteps as jest.MockedFunction<typeof api.breakIntoSteps>;
const approveTask = api.approveTask as jest.MockedFunction<typeof api.approveTask>;
const rejectTask = api.rejectTask as jest.MockedFunction<typeof api.rejectTask>;

const PARENT = 'a0000000-0000-4000-8000-000000000001';

const step = (n: number, over: Partial<Task> = {}): Task => ({
  id: `b0000000-0000-4000-8000-00000000000${String(n)}`,
  userId: 'u1',
  title: `step ${String(n)}`,
  description: null,
  status: 'pending',
  dueAt: null,
  manualPriority: 'med',
  source: 'ai_suggested',
  parentTaskId: PARENT,
  stepOrder: n,
  estimateMinutes: null,
  suggestedEstimateMinutes: null,
  ingestionRecordId: null,
  confirmedAt: null,
  completedAt: null,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  ...over,
});

async function open(onChanged = jest.fn()) {
  await render(<TaskSteps taskId={PARENT} onChanged={onChanged} />);
  await fireEvent.press(screen.getByTestId(`steps-toggle-${PARENT}`));

  return onChanged;
}

beforeEach(() => {
  jest.clearAllMocks();
  listSteps.mockResolvedValue([]);
});

describe('TaskSteps', () => {
  it('asks the API nothing until it is opened', async () => {
    // One panel per task on the home screen: loading eagerly would be a
    // request per row on every refresh.
    await render(<TaskSteps taskId={PARENT} onChanged={jest.fn()} />);

    expect(listSteps).not.toHaveBeenCalled();
  });

  it('offers to break a task with no steps down, and shows what came back as suggestions', async () => {
    breakIntoSteps.mockResolvedValue([step(0), step(1)]);
    await open();
    await waitFor(() => screen.getByTestId(`break-${PARENT}`));
    listSteps.mockResolvedValue([step(0), step(1)]);

    await fireEvent.press(screen.getByTestId(`break-${PARENT}`));

    await waitFor(() => {
      expect(screen.getByText('step 1')).toBeTruthy();
    });
    expect(breakIntoSteps).toHaveBeenCalledWith(PARENT);
    // Drafts, so each one has Add and Reject — and nothing was confirmed for
    // the user by the act of asking.
    expect(screen.getByTestId(`approve-${step(0).id}`)).toBeTruthy();
    expect(screen.getByTestId(`reject-${step(0).id}`)).toBeTruthy();
    expect(approveTask).not.toHaveBeenCalled();
  });

  it('does not offer a second breakdown while suggestions are still waiting', async () => {
    // The API would 409 it; the button simply is not there to press.
    listSteps.mockResolvedValue([step(0)]);
    await open();

    await waitFor(() => screen.getByText('step 0'));
    expect(screen.queryByTestId(`break-${PARENT}`)).toBeNull();
  });

  it('adds a step through the approve route, then reloads it and tells the screen', async () => {
    listSteps.mockResolvedValue([step(0)]);
    approveTask.mockResolvedValue(step(0, { confirmedAt: '2026-10-09T11:00:00.000Z' }));
    const onChanged = await open();
    await waitFor(() => screen.getByTestId(`approve-${step(0).id}`));
    const loadsBefore = listSteps.mock.calls.length;

    await fireEvent.press(screen.getByTestId(`approve-${step(0).id}`));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    expect(approveTask).toHaveBeenCalledWith(step(0).id);
    expect(rejectTask).not.toHaveBeenCalled();
    expect(listSteps.mock.calls.length).toBeGreaterThan(loadsBefore);
  });

  it('rejects a step through the reject route, never the approve one', async () => {
    listSteps.mockResolvedValue([step(0)]);
    rejectTask.mockResolvedValue(step(0, { status: 'archived' }));
    await open();
    await waitFor(() => screen.getByTestId(`reject-${step(0).id}`));

    await fireEvent.press(screen.getByTestId(`reject-${step(0).id}`));

    await waitFor(() => {
      expect(rejectTask).toHaveBeenCalledWith(step(0).id);
    });
    expect(approveTask).not.toHaveBeenCalled();
  });

  it('says why the breakdown failed, in the API’s words', async () => {
    breakIntoSteps.mockRejectedValue(
      new api.ApiError(502, 'Could not break that task down: model timed out'),
    );
    await open();
    await waitFor(() => screen.getByTestId(`break-${PARENT}`));

    await fireEvent.press(screen.getByTestId(`break-${PARENT}`));

    await waitFor(() => {
      expect(screen.getByTestId(`steps-error-${PARENT}`)).toHaveTextContent(
        'Could not break that task down: model timed out',
      );
    });
  });
});
