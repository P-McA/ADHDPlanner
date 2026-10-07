import type { Task, TaskPage, UserStats } from '@adhd/shared';

import {
  ApiError,
  approveTask,
  createTask,
  deleteTask,
  getStats,
  listTasks,
  rejectTask,
  updateTask,
} from './api-client';

/**
 * The client module against a mocked fetch. Everything asserted here is a
 * promise the UI relies on: the right method and path, the dev header only
 * when dev mode is on, and a 401 that arrives as a recognisable state rather
 * than a generic throw.
 */

const TASK: Task = {
  id: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  title: 'Write the thing',
  description: null,
  status: 'pending',
  manualPriority: 'med',
  source: 'manual',
  dueAt: null,
  completedAt: null,
  confirmedAt: null,
  parentTaskId: null,
  ingestionRecordId: null,
  createdAt: '2026-09-08T10:00:00.000Z',
  updatedAt: '2026-09-08T10:00:00.000Z',
};

// @types/jest still spells this `Mock<Return, Args>`, not the modern
// `Mock<Fn>` — passing a function type here would silently leave the call
// tuple as `any[]`, which is what the assertions below read off.
const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit]>();

/** The arguments fetch was called with most recently. */
const lastCall = (): [string, RequestInit] => {
  const { calls } = fetchMock.mock;
  const call = calls[calls.length - 1];

  if (call === undefined) throw new Error('fetch was never called');

  return call;
};

const headersOf = (): Record<string, string> =>
  (lastCall()[1].headers ?? {}) as Record<string, string>;

const respondWith = (body: unknown, status = 200): void => {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
};

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_API_URL: 'http://api.test' };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('request shape', () => {
  it('lists tasks against the configured base URL', async () => {
    const page: TaskPage = { items: [TASK], total: 1, limit: 25, offset: 0 };
    respondWith(page);

    await expect(listTasks()).resolves.toEqual(page);
    expect(lastCall()[0]).toBe('http://api.test/tasks');
  });

  it('sends only the filters it was given', async () => {
    respondWith({ items: [], total: 0, limit: 25, offset: 0 });

    await listTasks({ status: 'done', limit: 10 });

    // No stray `offset=undefined`: the API rejects unknown/!unparseable query
    // params rather than ignoring them.
    expect(lastCall()[0]).toBe('http://api.test/tasks?status=done&limit=10');
  });

  it('asks for drafts explicitly, since the API fences them out by default', async () => {
    respondWith({ items: [], total: 0, limit: 25, offset: 0 });

    await listTasks({ include: 'drafts' });

    expect(lastCall()[0]).toBe('http://api.test/tasks?include=drafts');
  });

  it('creates a task with POST and a JSON body', async () => {
    respondWith(TASK);

    await expect(createTask({ title: 'Write the thing' })).resolves.toEqual(TASK);

    const [url, init] = lastCall();
    expect(url).toBe('http://api.test/tasks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Write the thing' });
  });

  it('completes a task with PATCH', async () => {
    respondWith({ ...TASK, status: 'done' });

    await updateTask(TASK.id, { status: 'done' });

    const [url, init] = lastCall();
    expect(url).toBe(`http://api.test/tasks/${TASK.id}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'done' });
  });

  it('approves a draft through its own route, not a PATCH', async () => {
    const confirmed = { ...TASK, source: 'ai_suggested' as const, confirmedAt: '2026-09-08T11:00:00.000Z' };
    respondWith(confirmed);

    await expect(approveTask(TASK.id)).resolves.toEqual(confirmed);

    const [url, init] = lastCall();
    expect(url).toBe(`http://api.test/tasks/${TASK.id}/approve`);
    expect(init.method).toBe('POST');
    // No body: there is nothing for the caller to say beyond "yes".
    expect(init.body).toBeUndefined();
  });

  it('rejects a draft through its own route', async () => {
    respondWith({ ...TASK, source: 'ai_suggested' as const, status: 'archived' as const });

    await rejectTask(TASK.id);

    const [url, init] = lastCall();
    expect(url).toBe(`http://api.test/tasks/${TASK.id}/reject`);
    expect(init.method).toBe('POST');
  });

  it('deletes a task with DELETE', async () => {
    respondWith({ id: TASK.id, deletedSubtasks: 0 });

    await expect(deleteTask(TASK.id)).resolves.toEqual({ id: TASK.id, deletedSubtasks: 0 });
    expect(lastCall()[1].method).toBe('DELETE');
  });

  it('reads stats from /me/stats', async () => {
    const stats: UserStats = {
      totalXp: 28,
      level: 1,
      currentStreak: 1,
      longestStreak: 1,
      lastActiveDate: '2026-09-08',
    };
    respondWith(stats);

    await expect(getStats()).resolves.toEqual(stats);
    expect(lastCall()[0]).toBe('http://api.test/me/stats');
  });

  it('falls back to localhost when no base URL is configured', async () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    respondWith({ items: [], total: 0, limit: 25, offset: 0 });

    await listTasks();

    expect(lastCall()[0]).toBe('http://localhost:3001/tasks');
  });
});

describe('development sign-in header', () => {
  it('is absent unless dev mode is explicitly on', async () => {
    // Cleared here, not assumed: next/jest loads the developer's .env.local,
    // which sets this to `true` on any machine that has used dev sign-in.
    delete process.env.NEXT_PUBLIC_DEV_MODE;
    respondWith({ items: [], total: 0, limit: 25, offset: 0 });

    await listTasks();

    // The default build talks to the real auth path and nothing else.
    expect(headersOf()['x-dev-user']).toBeUndefined();
  });

  it('is absent when the flag is any other value', async () => {
    process.env.NEXT_PUBLIC_DEV_MODE = '1';
    respondWith({ items: [], total: 0, limit: 25, offset: 0 });

    await listTasks();

    expect(headersOf()['x-dev-user']).toBeUndefined();
  });

  it('carries the configured label when dev mode is on', async () => {
    process.env.NEXT_PUBLIC_DEV_MODE = 'true';
    process.env.NEXT_PUBLIC_DEV_USER = 'alice';
    respondWith({ items: [], total: 0, limit: 25, offset: 0 });

    await listTasks();

    expect(headersOf()['x-dev-user']).toBe('alice');
  });

  it('defaults the label when dev mode is on without one', async () => {
    process.env.NEXT_PUBLIC_DEV_MODE = 'true';
    delete process.env.NEXT_PUBLIC_DEV_USER;
    respondWith({ items: [], total: 0, limit: 25, offset: 0 });

    await listTasks();

    expect(headersOf()['x-dev-user']).toBe('dev');
  });
});

describe('failures', () => {
  it('reports 401 as an unauthenticated state, not a generic error', async () => {
    respondWith({ message: 'No active Clerk session' }, 401);

    const error = await listTasks().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isUnauthenticated).toBe(true);
    expect((error as ApiError).message).toBe('No active Clerk session');
  });

  it('treats the guard 403 as unauthenticated too', async () => {
    respondWith({ message: 'Forbidden' }, 403);

    const error = (await getStats().catch((e: unknown) => e)) as ApiError;

    expect(error.isUnauthenticated).toBe(true);
  });

  it('does not mistake a 404 for a sign-in problem', async () => {
    respondWith({ message: 'Task not found' }, 404);

    const error = (await updateTask(TASK.id, { title: 'x' }).catch((e: unknown) => e)) as ApiError;

    expect(error.isUnauthenticated).toBe(false);
    expect(error.status).toBe(404);
  });

  it('joins the array of messages a validation failure returns', async () => {
    respondWith({ message: ['title should not be empty', 'title must be a string'] }, 400);

    const error = (await createTask({ title: '' }).catch((e: unknown) => e)) as ApiError;

    expect(error.message).toBe('title should not be empty, title must be a string');
  });

  it('survives an error body that is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    });

    const error = (await listTasks().catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(502);
    expect(error.message).toBe('Request failed (502)');
  });

  it('distinguishes an unreachable API from an error response', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = (await listTasks().catch((e: unknown) => e)) as ApiError;

    // Status 0 rather than a 5xx: there was no response to read a status from,
    // and the UI must not render this as "you have no tasks".
    expect(error.status).toBe(0);
    expect(error.isUnauthenticated).toBe(false);
    expect(error.message).toContain('http://api.test');
  });
});
