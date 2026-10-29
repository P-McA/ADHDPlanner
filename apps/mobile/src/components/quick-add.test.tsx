import type { Task } from '@adhd/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type * as ApiClientModule from '../lib/api-client';
import * as api from '../lib/api-client';
import { QuickAdd } from './quick-add';

type ApiClient = typeof ApiClientModule;

/**
 * Typing a task on the phone. Our own module is mocked; the contract — that
 * the phone's createTask really makes the user's own task — is the
 * mobile-client e2e in apps/api, against real Postgres.
 */

jest.mock('../lib/api-client', () => {
  const actual = jest.requireActual<ApiClient>('../lib/api-client');

  return { ...actual, createTask: jest.fn() };
});

const createTask = api.createTask as jest.MockedFunction<typeof api.createTask>;

beforeEach(() => {
  jest.clearAllMocks();
  createTask.mockResolvedValue({ id: 't1' } as Task);
});

describe('QuickAdd', () => {
  it('adds what was typed, then clears the box and tells the screen', async () => {
    const onAdded = jest.fn();
    await render(<QuickAdd onAdded={onAdded} />);

    await fireEvent.changeText(screen.getByLabelText('New task'), '  Ring the garage ');
    await fireEvent.press(screen.getByTestId('quick-add-submit'));

    await waitFor(() => {
      expect(onAdded).toHaveBeenCalled();
    });
    expect(createTask).toHaveBeenCalledWith({ title: 'Ring the garage' });
    expect(screen.getByLabelText('New task').props.value).toBe('');
  });

  it('will not send an empty task', async () => {
    await render(<QuickAdd onAdded={jest.fn()} />);

    await fireEvent.changeText(screen.getByLabelText('New task'), '   ');
    await fireEvent.press(screen.getByTestId('quick-add-submit'));

    expect(createTask).not.toHaveBeenCalled();
  });

  it('sends a due date at the end of the chosen day, and a high priority, when picked', async () => {
    await render(<QuickAdd onAdded={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('New task'), 'Pay the bill');

    await fireEvent.press(screen.getByTestId('quick-add-tomorrow'));
    await fireEvent.press(screen.getByTestId('quick-add-high'));
    await fireEvent.press(screen.getByTestId('quick-add-submit'));

    await waitFor(() => {
      expect(createTask).toHaveBeenCalled();
    });
    const sent = createTask.mock.calls[0]![0];
    const due = new Date(sent.dueAt!);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    // End of tomorrow on the phone's clock: "due tomorrow", never "overdue" by lunchtime.
    expect(due.toDateString()).toBe(tomorrow.toDateString());
    expect(due.getHours()).toBe(23);
    expect(sent.manualPriority).toBe('high');
  });

  it('keeps what was typed and says why when the API refuses it', async () => {
    createTask.mockRejectedValue(new api.ApiError(400, 'title must be shorter than or equal to 500 characters'));
    await render(<QuickAdd onAdded={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('New task'), 'x');

    await fireEvent.press(screen.getByTestId('quick-add-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('quick-add-error')).toHaveTextContent(/shorter than or equal to 500/);
    });
    expect(screen.getByLabelText('New task').props.value).toBe('x');
  });
});
