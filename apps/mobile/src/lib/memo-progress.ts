import type { IngestionRecord } from '@adhd/shared';

import { getIngestionRecord, listDrafts } from './api-client';

/** How often to ask, and how long before giving up and saying so. */
export const MEMO_POLL_INTERVAL_MS = 1500;
export const MEMO_POLL_TIMEOUT_MS = 90_000;

const FINISHED = new Set(['draft_created', 'failed']);

export interface FollowMemoDeps {
  get?: (id: string) => Promise<IngestionRecord>;
  countDrafts?: (id: string) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function draftsFrom(id: string): Promise<number> {
  const page = await listDrafts();

  return page.items.filter((task) => task.ingestionRecordId === id).length;
}

/**
 * Waits for one memo to finish and says, in plain words, what came of it.
 *
 * Without this the app stopped at "Queued": the 202 arrives before the worker
 * has transcribed anything, the list refreshed once at that moment, and a
 * suggestion made seconds later stayed invisible until a manual reload. A note
 * that held nothing ("you" is what Whisper hears in silence) gave no feedback
 * at all.
 *
 * Polling rather than a push channel: one memo, a few seconds, and the route
 * already exists. Bounded, so a stuck worker becomes a message, not a spinner.
 */
export async function followMemo(id: string, deps: FollowMemoDeps = {}): Promise<string> {
  const get = deps.get ?? getIngestionRecord;
  const countDrafts = deps.countDrafts ?? draftsFrom;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const interval = deps.intervalMs ?? MEMO_POLL_INTERVAL_MS;
  const deadline = now() + (deps.timeoutMs ?? MEMO_POLL_TIMEOUT_MS);

  for (;;) {
    const record = await get(id);

    if (FINISHED.has(record.status)) {
      return describeOutcome(record, record.status === 'failed' ? 0 : await countDrafts(id));
    }

    if (now() >= deadline) {
      return 'Still working on that note — its suggestions will appear below when it finishes.';
    }

    await sleep(interval);
  }
}

/** The sentence the user sees once a memo has finished. */
export function describeOutcome(record: IngestionRecord, drafts: number): string {
  if (record.status === 'failed') {
    return `Couldn't process that note: ${record.error ?? 'unknown error'}`;
  }

  const heard = record.transcript?.trim() ?? '';
  const quoted = heard === '' ? 'nothing' : `“${heard}”`;

  if (drafts === 0) {
    return `Heard ${quoted} — nothing in it to suggest as a task.`;
  }

  const plural = drafts === 1 ? '' : 's';
  const object = drafts === 1 ? 'it a task' : 'them tasks';

  return `Heard ${quoted} — ${String(drafts)} suggestion${plural} added below. Approve to make ${object}.`;
}
