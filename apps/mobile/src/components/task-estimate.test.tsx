import type { Task } from '@adhd/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type * as ApiClientModule from '../lib/api-client';
import * as api from '../lib/api-client';
import { TaskEstimate } from './task-estimate';

type ApiClient = typeof ApiClientModule;

/**
 * The estimate line under a task: which calls it makes, and when.
 *
 * Our own module is mocked, not the network, so nothing here says the routes
 * behave — that is `test/estimates.e2e-spec.ts` and the mobile-client e2e in
 * apps/api, against real Postgres. These pin the screen's half: a suggestion
 * is shown as a suggestion, nothing is accepted on the user's behalf, and a
 * correction sends the bucket the user picked.
 */

jest.mock('../lib/api-client', () => {
  const actual = jest.requireActual<ApiClient>('../lib/api-client');

  return {
    ...actual,
    suggestEstimate: jest.fn(),
    acceptEstimate: jest.fn(),
    dismissEstimate: jest.fn(),
  };
});

const suggestEstimate = api.suggestEstimate as jest.MockedFunction<typeof api.suggestEstimate>;
const acceptEstimate = api.acceptEstimate as jest.MockedFunction<typeof api.acceptEstimate>;
const dismissEstimate = api.dismissEstimate as jest.MockedFunction<typeof api.dismissEstimate>;

const ID = 'a0000000-0000-4000-8000-000000000001';

const task = (over: Partial<Task> = {}): Task => ({
  id: ID,
  userId: 'u1',
  title: 'book the MOT',
  description: null,
  status: 'pending',
  dueAt: null,
  manualPriority: 'med',
  source: 'manual',
  parentTaskId: null,
  stepOrder: null,
  estimateMinutes: null,
  suggestedEstimateMinutes: null,
  ingestionRecordId: null,
  confirmedAt: null,
  completedAt: null,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TaskEstimate', () => {
  it('offers to estimate a task with no estimate, and tells the screen when the suggestion lands', async () => {
    suggestEstimate.mockResolvedValue(task({ suggestedEstimateMinutes: 30 }));
    const onChanged = jest.fn();
    await render(<TaskEstimate task={task()} onChanged={onChanged} />);

    await fireEvent.press(screen.getByTestId(`estimate-${ID}`));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    expect(suggestEstimate).toHaveBeenCalledWith(ID);
    expect(acceptEstimate).not.toHaveBeenCalled();
  });

  it('shows the user’s own estimate, and asks the model nothing', async () => {
    await render(<TaskEstimate task={task({ estimateMinutes: 60 })} onChanged={jest.fn()} />);

    expect(screen.getByTestId(`estimate-label-${ID}`)).toHaveTextContent('~1 hr');
    expect(screen.queryByTestId(`estimate-${ID}`)).toBeNull();
  });

  it('shows a waiting suggestion as a suggestion, with Accept and Dismiss, and accepts nothing by itself', async () => {
    await render(<TaskEstimate task={task({ suggestedEstimateMinutes: 30 })} onChanged={jest.fn()} />);

    expect(screen.getByTestId(`suggested-estimate-${ID}`)).toHaveTextContent('Suggested ~30 min');
    expect(screen.getByTestId(`accept-estimate-${ID}`)).toBeTruthy();
    expect(screen.getByTestId(`dismiss-estimate-${ID}`)).toBeTruthy();
    // No second request while one is waiting: the API would 409 it.
    expect(screen.queryByTestId(`estimate-${ID}`)).toBeNull();
    expect(acceptEstimate).not.toHaveBeenCalled();
  });

  it('accepts the suggestion as it is', async () => {
    acceptEstimate.mockResolvedValue(task({ estimateMinutes: 30 }));
    const onChanged = jest.fn();
    await render(<TaskEstimate task={task({ suggestedEstimateMinutes: 30 })} onChanged={onChanged} />);

    await fireEvent.press(screen.getByTestId(`accept-estimate-${ID}`));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    expect(acceptEstimate).toHaveBeenCalledWith(ID, undefined);
  });

  it('accepts the bucket the user picked instead, as a correction', async () => {
    acceptEstimate.mockResolvedValue(task({ estimateMinutes: 120 }));
    await render(<TaskEstimate task={task({ suggestedEstimateMinutes: 30 })} onChanged={jest.fn()} />);

    await fireEvent.press(screen.getByTestId(`estimate-bucket-${ID}-120`));

    await waitFor(() => {
      expect(acceptEstimate).toHaveBeenCalledWith(ID, 120);
    });
  });

  it('dismisses through the dismiss route, never the accept one', async () => {
    dismissEstimate.mockResolvedValue(task());
    await render(<TaskEstimate task={task({ suggestedEstimateMinutes: 30 })} onChanged={jest.fn()} />);

    await fireEvent.press(screen.getByTestId(`dismiss-estimate-${ID}`));

    await waitFor(() => {
      expect(dismissEstimate).toHaveBeenCalledWith(ID);
    });
    expect(acceptEstimate).not.toHaveBeenCalled();
  });

  it('says why the estimate failed, in the API’s words', async () => {
    suggestEstimate.mockRejectedValue(
      new api.ApiError(502, 'Could not estimate that task: model timed out'),
    );
    await render(<TaskEstimate task={task()} onChanged={jest.fn()} />);

    await fireEvent.press(screen.getByTestId(`estimate-${ID}`));

    await waitFor(() => {
      expect(screen.getByTestId(`estimate-error-${ID}`)).toHaveTextContent(
        'Could not estimate that task: model timed out',
      );
    });
  });
});
