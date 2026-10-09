import type { Task } from '@adhd/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TaskEstimate } from './task-estimate';

/**
 * The estimate line under a task, through the real client module — only
 * `fetch` is stubbed, so the method, path and body each button produces are
 * what is pinned.
 *
 * Nothing here proves the routes behave: that is `test/estimates.e2e-spec.ts`
 * in apps/api, against real Postgres. These pin the screen's half — a
 * suggestion reads as one, nothing is accepted for the user, and a correction
 * sends the bucket they picked.
 */

const ID = '11111111-1111-1111-1111-111111111111';

const task = (over: Partial<Task> = {}): Task => ({
  id: ID,
  userId: '22222222-2222-2222-2222-222222222222',
  title: 'Book the MOT',
  description: null,
  status: 'pending',
  manualPriority: 'med',
  source: 'manual',
  dueAt: null,
  completedAt: null,
  confirmedAt: null,
  parentTaskId: null,
  stepOrder: null,
  estimateMinutes: null,
  suggestedEstimateMinutes: null,
  ingestionRecordId: null,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  ...over,
});

const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit]>();

/** Set to make POST /tasks/:id/estimate fail the way the API does. */
let estimateFailure: { status: number; message: string } | null = null;

const calls = (suffix: string): [string, RequestInit][] =>
  fetchMock.mock.calls.filter(([url, init]) => init.method === 'POST' && url.endsWith(suffix));

beforeEach(() => {
  estimateFailure = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation((url) => {
    if (url.endsWith('/estimate') && estimateFailure !== null) {
      const { status, message } = estimateFailure;

      return Promise.resolve({ ok: false, status, json: () => Promise.resolve({ message }) });
    }

    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(task()) });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('TaskEstimate', () => {
  it('offers to estimate a task with no estimate, and tells the dashboard when the suggestion lands', async () => {
    const onChanged = jest.fn();
    render(<TaskEstimate task={task()} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    expect(calls(`/tasks/${ID}/estimate`)).toHaveLength(1);
    expect(calls('/accept')).toHaveLength(0);
  });

  it('shows the user’s own estimate and offers no model call', () => {
    render(<TaskEstimate task={task({ estimateMinutes: 60 })} onChanged={jest.fn()} />);

    expect(screen.getByText('~1 hr')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Estimate' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a waiting suggestion as a suggestion, and accepts nothing by itself', () => {
    render(<TaskEstimate task={task({ suggestedEstimateMinutes: 30 })} onChanged={jest.fn()} />);

    expect(screen.getByText('Suggested ~30 min')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    // No second request while one waits: the API would 409 it.
    expect(screen.queryByRole('button', { name: 'Estimate' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the suggestion as it is, with no bucket in the body', async () => {
    render(<TaskEstimate task={task({ suggestedEstimateMinutes: 30 })} onChanged={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      expect(calls(`/tasks/${ID}/estimate/accept`)).toHaveLength(1);
    });
    expect(JSON.parse(calls('/accept')[0]![1].body as string)).toEqual({});
  });

  it('accepts the bucket the user picked instead, as a correction', async () => {
    render(<TaskEstimate task={task({ suggestedEstimateMinutes: 30 })} onChanged={jest.fn()} />);

    fireEvent.change(screen.getByLabelText('Use a different estimate'), { target: { value: '120' } });

    await waitFor(() => {
      expect(calls(`/tasks/${ID}/estimate/accept`)).toHaveLength(1);
    });
    expect(JSON.parse(calls('/accept')[0]![1].body as string)).toEqual({ minutes: 120 });
  });

  it('dismisses through the dismiss route, never the accept one', async () => {
    render(<TaskEstimate task={task({ suggestedEstimateMinutes: 30 })} onChanged={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      expect(calls(`/tasks/${ID}/estimate/dismiss`)).toHaveLength(1);
    });
    expect(calls('/accept')).toHaveLength(0);
  });

  it('says why the estimate failed, in the API’s words', async () => {
    estimateFailure = { status: 502, message: 'Could not estimate that task: model timed out' };
    render(<TaskEstimate task={task()} onChanged={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not estimate that task: model timed out',
    );
  });
});
