import type {
  CreateTaskInput,
  DeleteTaskResult,
  EarnedBadge,
  ListTasksQuery,
  Task,
  TaskPage,
  UpdateTaskInput,
  UserStats,
} from '@adhd/shared';

/**
 * The only place this app talks to the API.
 *
 * Types come from `@adhd/shared` rather than being restated here, so a contract
 * change breaks the build instead of the browser: this module is the first real
 * consumer of that package outside the API itself.
 */

const DEFAULT_BASE_URL = 'http://localhost:3001';

/**
 * A response the caller can act on, rather than a thrown string.
 *
 * 401 is separated from every other failure because it is the one the UI has a
 * real answer for — sign in — while the rest are "something broke".
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiError';
  }

  /** True when the API rejected the request for want of a session. */
  get isUnauthenticated(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_BASE_URL;
}

/**
 * Whether to attach the development sign-in header.
 *
 * This only decides what the *client* sends. The API decides what it trusts,
 * behind its own server-side `DEV_AUTH_BYPASS` — a `NEXT_PUBLIC_` value is
 * inlined into the bundle and readable by anyone, so it could never be the
 * thing protecting a route.
 */
export function devModeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEV_MODE === 'true';
}

function devUserLabel(): string {
  return process.env.NEXT_PUBLIC_DEV_USER ?? 'dev';
}

function authHeaders(): Record<string, string> {
  return devModeEnabled() ? { 'x-dev-user': devUserLabel() } : {};
}

/** Pulls the API's message out of a Nest error body, if it sent one. */
function messageFrom(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const { message } = body;

    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join(', ');
  }

  return fallback;
}

async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      // Credentials so a real Clerk session cookie rides along; the dev header
      // is additive and only present when dev mode is on.
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(),
        ...init.headers,
      },
    });
  } catch (cause) {
    // A dead API is not a 500 — there is no response at all. Surfacing it as
    // status 0 lets the UI say "cannot reach the API" instead of rendering an
    // empty list as though the user simply had no tasks.
    throw new ApiError(0, `Cannot reach the API at ${apiBaseUrl()}`, { cause });
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new ApiError(response.status, messageFrom(body, `Request failed (${response.status})`));
  }

  return response.json() as Promise<T>;
}

/** GET /tasks. */
export function listTasks(query: ListTasksQuery = {}): Promise<TaskPage> {
  const params = new URLSearchParams();

  if (query.status !== undefined) params.set('status', query.status);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.include !== undefined) params.set('include', query.include);

  const suffix = params.size > 0 ? `?${params.toString()}` : '';

  return send<TaskPage>(`/tasks${suffix}`);
}

/** POST /tasks. */
export function createTask(input: CreateTaskInput): Promise<Task> {
  return send<Task>('/tasks', { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /tasks/:id. Completing a task here is what triggers the XP flow. */
export function updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
  return send<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/**
 * POST /tasks/:id/approve — the user accepts an AI suggestion.
 *
 * A route of its own rather than a PATCH, mirroring the API: `UpdateTaskInput`
 * deliberately cannot carry `confirmedAt`, so confirmation cannot happen as a
 * side effect of saving something else.
 */
export function approveTask(id: string): Promise<Task> {
  return send<Task>(`/tasks/${id}/approve`, { method: 'POST' });
}

/** POST /tasks/:id/reject — turns a suggestion down; it is archived, not deleted. */
export function rejectTask(id: string): Promise<Task> {
  return send<Task>(`/tasks/${id}/reject`, { method: 'POST' });
}

/** DELETE /tasks/:id. */
export function deleteTask(id: string): Promise<DeleteTaskResult> {
  return send<DeleteTaskResult>(`/tasks/${id}`, { method: 'DELETE' });
}

/** GET /me/stats. */
export function getStats(): Promise<UserStats> {
  return send<UserStats>('/me/stats');
}

/** GET /me/badges — the starter badges earned so far, oldest first. */
export function getBadges(): Promise<EarnedBadge[]> {
  return send<EarnedBadge[]>('/me/badges');
}
