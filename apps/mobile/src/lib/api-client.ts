import {
  AUDIO_UPLOAD_FIELD,
  type IngestionAccepted,
  type IngestionRecord,
  type ListTasksQuery,
  type Task,
  type TaskPage,
  type UpdateTaskInput,
  type UserStats,
} from '@adhd/shared';

/**
 * The only place this app talks to the API.
 *
 * Deliberately free of any React Native import. Everything that carries the
 * contract — the paths, the query string, the multipart field name, the auth
 * header, the error mapping — lives here in plain TypeScript over `fetch`, so
 * it can be run against the *real* API rather than a stubbed `fetch` inside a
 * jsdom-alike. `test/mobile-client.e2e-spec.ts` in apps/api does exactly that.
 *
 * That split is the point. A React Native Testing Library test that mocks
 * `fetch` proves the component renders what the fixture said; it cannot tell
 * you the phone would have reached the endpoint at all. See CLAUDE.md, the
 * fence incident.
 *
 * Types come from `@adhd/shared`, never restated — same rule as the web client.
 */

const DEFAULT_BASE_URL = 'http://localhost:3001';

/** A response the caller can act on, rather than a thrown string. */
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

/**
 * Where the API lives.
 *
 * `localhost` is the phone, not the laptop, so a device or a non-localhost
 * emulator needs this set to the machine's LAN address. The default is only
 * useful for a simulator sharing the host's loopback.
 */
export function apiBaseUrl(): string {
  return process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_BASE_URL;
}

/**
 * Whether to attach the development sign-in header.
 *
 * Same rule as the web client, and for the same reason: this decides only what
 * the *client* sends. Whether the header means anything is the API's decision,
 * behind its own server-side `DEV_AUTH_BYPASS`. An `EXPO_PUBLIC_` value is
 * inlined into the JavaScript bundle that ships to the device and is readable
 * by anyone holding the app, so it could never be the thing protecting a route.
 */
export function devModeEnabled(): boolean {
  return process.env.EXPO_PUBLIC_DEV_MODE === 'true';
}

function devUserLabel(): string {
  return process.env.EXPO_PUBLIC_DEV_USER ?? 'dev';
}

type TokenProvider = () => string | null;

let authToken: TokenProvider = () => null;

/**
 * Installs the real session-token source.
 *
 * A phone has no cookie jar the API can rely on, so the production path is a
 * bearer token rather than the web client's `credentials: 'include'`. The
 * provider is injected rather than imported so this module stays free of any
 * auth SDK — wiring Clerk's React Native session into it is a one-line call at
 * app start, and is NOT part of this milestone. Until it is made, the app is
 * dev-bypass only, which is why the sign-in gate says so on screen.
 */
export function setAuthTokenProvider(provider: TokenProvider): void {
  authToken = provider;
}

function authHeaders(): Record<string, string> {
  const token = authToken();

  return {
    ...(devModeEnabled() ? { 'x-dev-user': devUserLabel() } : {}),
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  };
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
  const headers: Record<string, string> = { ...authHeaders() };

  // Only for a body we serialised ourselves. A multipart body must set its own
  // content-type, because the boundary is generated with it — declaring JSON
  // over a FormData body produces a request the server cannot parse at all.
  if (typeof init.body === 'string') headers['content-type'] = 'application/json';

  Object.assign(headers, init.headers);

  let response: Response;

  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch (cause) {
    // No response at all — a phone off wifi, or a base URL pointing at the
    // device's own loopback. Status 0 lets the UI say "cannot reach the API"
    // instead of rendering an empty list as though there were no tasks.
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

/**
 * The suggestions view: unconfirmed AI drafts, which the API hides by default.
 *
 * A named function rather than a flag each screen has to remember, because
 * `include: 'drafts'` is the whole difference between the review surface
 * working and silently showing nothing. The server fence is what enforces the
 * exclusion; this only opts in. Check: `serves the phone its drafts only when
 * it asks for them` in the API's e2e suite.
 */
export function listDrafts(): Promise<TaskPage> {
  return listTasks({ include: 'drafts' });
}

/** PATCH /tasks/:id. Completing a task here is what triggers the XP flow. */
export function updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
  return send<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** PATCH /tasks/:id {status:'done'}. */
export function completeTask(id: string): Promise<Task> {
  return updateTask(id, { status: 'done' });
}

/**
 * POST /tasks/:id/approve — confirms an AI suggestion into a real task.
 *
 * An act, not an edit: `confirmedAt` cannot be set through PATCH, and the
 * server makes a second approve a no-op. Pays the review XP once.
 */
export function approveTask(id: string): Promise<Task> {
  return send<Task>(`/tasks/${encodeURIComponent(id)}/approve`, { method: 'POST' });
}

/** GET /me/stats. */
export function getStats(): Promise<UserStats> {
  return send<UserStats>('/me/stats');
}

/**
 * GET /ingestion/:id — where one memo has got to.
 *
 * The upload's 202 only says the bytes arrived; transcription and extraction
 * run afterwards on the worker. This is how the app finds out they finished,
 * and what they heard, so the user is not left looking at "Queued" while a
 * suggestion they cannot see has already been made.
 */
export function getIngestionRecord(id: string): Promise<IngestionRecord> {
  return send<IngestionRecord>(`/ingestion/${encodeURIComponent(id)}`);
}

/**
 * The audio part, in the shape React Native's `FormData` understands.
 *
 * RN marshals `{ uri, name, type }` into a file part by reading the file off
 * disk in native code; there is no `Blob` to hand it. Node and the browser take
 * a `Blob` instead, which is why {@link uploadVoiceMemo} accepts either — the
 * platform supplies the part, this module owns everything about the request
 * that the API actually contracts on.
 */
export interface AudioPart {
  uri: string;
  name: string;
  type: string;
}

/**
 * POST /ingestion/audio — hands a memo to the pipeline.
 *
 * 202, not 201: the bytes are accepted and queued. Drafts appear later, in the
 * suggestions view, and still need confirming. Nothing here creates a task.
 *
 * The field name comes from `AUDIO_UPLOAD_FIELD` in `@adhd/shared` rather than
 * a string literal, so both ends read one constant and the mismatch that cost
 * the browser client an afternoon cannot be made here at all. If it somehow is,
 * the API's 400 now names the field it wanted and the field it got.
 */
export function uploadVoiceMemo(
  part: AudioPart | Blob,
  filename: string,
): Promise<IngestionAccepted> {
  const form = new FormData();

  // Cast: RN's FormData accepts the `{uri,name,type}` shape at runtime, which
  // the DOM lib's signature cannot express. The filename third argument is what
  // Node and the browser read; RN reads `name` off the object instead, so
  // passing both is correct everywhere rather than a hedge.
  form.append(AUDIO_UPLOAD_FIELD, part as Blob, filename);

  return send<IngestionAccepted>('/ingestion/audio', { method: 'POST', body: form });
}
