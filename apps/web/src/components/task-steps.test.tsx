import type { Task } from '@adhd/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { TaskSteps } from './task-steps';

/**
 * The steps panel under a task, through the real client module — only `fetch`
 * is stubbed, so the method and path each action produces are what is pinned.
 *
 * Nothing here proves the routes behave: that is `test/steps.e2e-spec.ts` in
 * apps/api, against real Postgres. These pin the screen's half — it asks for
 * the right thing, never confirms a step on the user's behalf, and says why
 * when the model could not help.
 */

const PARENT = '11111111-1111-1111-1111-111111111111';

const step = (n: number, over: Partial<Task> = {}): Task => ({
  id: `3333333${String(n)}-3333-3333-3333-333333333333`,
  userId: '22222222-2222-2222-2222-222222222222',
  title: `Step ${String(n)}`,
  description: null,
  status: 'pending',
  manualPriority: 'med',
  source: 'ai_suggested',
  dueAt: null,
  completedAt: null,
  confirmedAt: null,
  parentTaskId: PARENT,
  stepOrder: n,
  ingestionRecordId: null,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  ...over,
});

const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit]>();

/** What GET /tasks/:id/steps answers; a test changes it to model a write. */
let stepsOnServer: Task[] = [];

/** Set to make POST /tasks/:id/steps fail the way the API does. */
let breakdownFailure: { status: number; message: string } | null = null;

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

const calls = (method: string, suffix: string): number =>
  fetchMock.mock.calls.filter(
    ([url, init]) => (init.method ?? 'GET') === method && url.endsWith(suffix),
  ).length;

beforeEach(() => {
  stepsOnServer = [];
  breakdownFailure = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation((url, init) => {
    const method = init.method ?? 'GET';

    if (url.endsWith('/steps') && method === 'POST') {
      if (breakdownFailure !== null) {
        const { status, message } = breakdownFailure;

        return Promise.resolve({ ok: false, status, json: () => Promise.resolve({ message }) });
      }

      stepsOnServer = [step(1), step(2)];

      return ok(stepsOnServer);
    }

    if (url.endsWith('/steps')) return ok(stepsOnServer);

    if (url.endsWith('/approve')) {
      stepsOnServer = stepsOnServer.map((s) =>
        url.includes(s.id) ? { ...s, confirmedAt: '2026-10-09T11:00:00.000Z' } : s,
      );

      return ok(stepsOnServer[0]);
    }

    if (url.endsWith('/reject')) {
      stepsOnServer = stepsOnServer.filter((s) => !url.includes(s.id));

      return ok({});
    }

    return ok({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function open(onChanged = jest.fn()) {
  render(<TaskSteps taskId={PARENT} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole('button', { name: 'Steps' }));
  await waitFor(() => {
    expect(calls('GET', `/tasks/${PARENT}/steps`)).toBe(1);
  });

  return onChanged;
}

describe('TaskSteps', () => {
  it('asks the API nothing until it is opened', () => {
    // One panel per open task: loading eagerly would be a request per row on
    // every refresh of the dashboard.
    render(<TaskSteps taskId={PARENT} onChanged={jest.fn()} />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('breaks the task down and shows the steps as suggestions, confirming none of them', async () => {
    await open();

    fireEvent.click(await screen.findByRole('button', { name: 'Break into steps' }));

    expect(await screen.findByText('Step 2')).toBeInTheDocument();
    expect(calls('POST', `/tasks/${PARENT}/steps`)).toBe(1);
    // Suggestions, each with its own review buttons — asking approved nothing.
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Reject' })).toHaveLength(2);
    expect(calls('POST', '/approve')).toBe(0);
  });

  it('does not offer a second breakdown while suggestions are still waiting', async () => {
    // The API would 409 it; the button simply is not there to press.
    stepsOnServer = [step(1)];
    await open();

    expect(await screen.findByText('Step 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Break into steps' })).not.toBeInTheDocument();
  });

  it('adds a step through the approve route, then reloads and tells the dashboard', async () => {
    stepsOnServer = [step(1)];
    const onChanged = await open();
    const row = (await screen.findByText('Step 1')).closest('li');

    fireEvent.click(within(row!).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    expect(calls('POST', `/tasks/${step(1).id}/approve`)).toBe(1);
    expect(calls('POST', '/reject')).toBe(0);
    expect(calls('GET', `/tasks/${PARENT}/steps`)).toBe(2);
  });

  it('rejects a step through the reject route, and it leaves the list', async () => {
    stepsOnServer = [step(1)];
    await open();
    const row = (await screen.findByText('Step 1')).closest('li');

    fireEvent.click(within(row!).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(screen.queryByText('Step 1')).not.toBeInTheDocument();
    });
    expect(calls('POST', `/tasks/${step(1).id}/reject`)).toBe(1);
    expect(calls('POST', '/approve')).toBe(0);
  });

  it('says why the breakdown failed, in the API’s words', async () => {
    breakdownFailure = { status: 502, message: 'Could not break that task down: model timed out' };
    await open();

    fireEvent.click(await screen.findByRole('button', { name: 'Break into steps' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not break that task down: model timed out',
    );
  });
});
