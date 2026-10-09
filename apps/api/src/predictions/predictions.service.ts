import { MAX_PREDICTIONS, predictionReason, sameTitle, type Task } from '@adhd/shared';
import { BadGatewayException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { EMBEDDER, type Embedder } from '../ai/ai.ports.js';
import { EMBEDDING_MODEL } from '../ai/openai.embedder.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toTask } from '../tasks/tasks.service.js';
import {
  DUPLICATE_MIN_SIMILARITY,
  EMBED_BATCH_MAX,
  FOLLOW_ON_WINDOW_DAYS,
  NEIGHBOUR_MIN_SIMILARITY,
  NEIGHBOURS_PER_ANCHOR,
  RECENT_DAYS,
} from './prediction.constants.js';

/** How long a rejected suggestion stays rejected before it may be offered again. */
const REJECTED_MEMORY_DAYS = 30;

/** What is embedded for a task: what it says, nothing about its state. */
function contentOf(task: { title: string; description: string | null }): string {
  return task.description === null || task.description.trim() === ''
    ? task.title
    : `${task.title}\n${task.description.trim()}`;
}

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** pgvector's text form; every value is a finite number, checked by the adapter. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

interface FollowOnRow {
  id: string;
  title: string;
  past_title: string;
  completed_at: Date;
}

/**
 * "Suggest tasks" (Phase 2, owner rulings 2026-10-09): what usually came next.
 *
 * 1. Embed whatever is new or changed since the last press — one batch call,
 *    and only on request, so nothing is spent unless the user asks.
 * 2. Anchors are the user's open tasks and what they finished in the last
 *    RECENT_DAYS. For each, the most similar tasks they finished *before*
 *    then (cosine ≥ NEIGHBOUR_MIN_SIMILARITY, in pgvector).
 * 3. What they finished within FOLLOW_ON_WINDOW_DAYS after each of those is a
 *    candidate — a title they once wrote themselves, never words from a model.
 * 4. Drop anything they already have: open, waiting as a draft, finished
 *    recently, or rejected as a suggestion lately — by exact title, and by
 *    near-identical embedding (DUPLICATE_MIN_SIMILARITY; see the calibration
 *    note in prediction.constants.ts for what that can and cannot catch).
 * 5. Rank by how many anchor/past pairs led to it, then by how recently;
 *    keep MAX_PREDICTIONS; write them as drafts with the reason.
 *
 * Drafts like any other: nothing here confirms anything, and the usual
 * approve/reject routes review them for the usual XP. No schedule is stored —
 * a suggestion exists only because the button was pressed.
 */
@Injectable()
export class PredictionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
  ) {}

  async predict(userId: string): Promise<Task[]> {
    // Before anything is spent: a second press while suggestions wait would
    // pay the model again and stack a second set on the first.
    await this.assertNothingWaiting(this.prisma, userId);

    try {
      await this.embedChanged(userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new BadGatewayException(`Could not look at your history: ${message}`);
    }

    const picks = await this.pick(userId);

    const rows = await this.prisma.$transaction(async (tx) => {
      // Serialises two presses for one user; the second waits, then finds the
      // first one's drafts and is refused.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`predict:${userId}`}))`;
      await this.assertNothingWaiting(tx, userId);

      const created = [];

      for (const pick of picks) {
        created.push(
          await tx.task.create({
            data: {
              userId,
              title: pick.title,
              source: 'ai_suggested',
              confirmedAt: null,
              suggestionReason: predictionReason(pick.pastTitle),
            },
          }),
        );
      }

      return created;
    });

    return rows.map(toTask);
  }

  private async assertNothingWaiting(
    client: Pick<PrismaService, 'task'>,
    userId: string,
  ): Promise<void> {
    const waiting = await client.task.count({
      where: {
        userId,
        source: 'ai_suggested',
        confirmedAt: null,
        status: { not: 'archived' },
        suggestionReason: { not: null },
      },
    });

    if (waiting > 0) {
      throw new ConflictException('Some suggestions are still waiting; add or reject those first');
    }
  }

  /** Embeds the user's top-level, unarchived tasks that are new or changed since last time. */
  private async embedChanged(userId: string): Promise<void> {
    const tasks = await this.prisma.$queryRaw<
      {
        id: string;
        title: string;
        description: string | null;
        content_hash: string | null;
        model: string | null;
      }[]
    >`
      SELECT t.id, t.title, t.description, e.content_hash, e.model
      FROM tasks t
      LEFT JOIN task_embeddings e ON e.task_id = t.id
      WHERE t.user_id = ${userId}::uuid
        AND t.parent_task_id IS NULL
        AND t.status <> 'archived'
      ORDER BY t.created_at DESC
    `;

    const stale = tasks
      .map((task) => ({ ...task, content: contentOf(task) }))
      .filter((task) => task.model !== EMBEDDING_MODEL || task.content_hash !== hashOf(task.content))
      .slice(0, EMBED_BATCH_MAX);

    if (stale.length === 0) return;

    const vectors = await this.embedder.embed(stale.map((task) => task.content));

    await this.prisma.$transaction(
      stale.map(
        (task, i) => this.prisma.$executeRaw`
          INSERT INTO task_embeddings (task_id, user_id, model, content_hash, embedding, updated_at)
          VALUES (${task.id}::uuid, ${userId}::uuid, ${EMBEDDING_MODEL}, ${hashOf(task.content)},
                  ${toVectorLiteral(vectors[i]!)}::vector, now())
          ON CONFLICT (task_id) DO UPDATE
            SET model = EXCLUDED.model,
                content_hash = EXCLUDED.content_hash,
                embedding = EXCLUDED.embedding,
                updated_at = now()
        `,
      ),
    );
  }

  /** Steps 2–5: candidates from history, deduped against what the user has, ranked. */
  private async pick(userId: string): Promise<{ title: string; pastTitle: string }[]> {
    const recent = `${String(RECENT_DAYS)} days`;
    const window = `${String(FOLLOW_ON_WINDOW_DAYS)} days`;
    const rejected = `${String(REJECTED_MEMORY_DAYS)} days`;

    // Every row the query reads is the caller's: the user_id filter sits on
    // `mine`, which every other CTE is built from, so nobody else's history
    // can leak in.
    const rows = await this.prisma.$queryRaw<FollowOnRow[]>`
      WITH mine AS (
        SELECT t.id, t.title, t.status, t.completed_at, t.source, t.confirmed_at, e.embedding
        FROM tasks t
        JOIN task_embeddings e ON e.task_id = t.id
        WHERE t.user_id = ${userId}::uuid
          AND t.parent_task_id IS NULL
          AND t.status <> 'archived'
      ),
      confirmed AS (
        SELECT * FROM mine WHERE NOT (source = 'ai_suggested' AND confirmed_at IS NULL)
      ),
      anchors AS (
        SELECT * FROM confirmed
        WHERE status IN ('pending', 'in_progress')
           OR (status = 'done' AND completed_at >= now() - ${recent}::interval)
      ),
      history AS (
        SELECT * FROM confirmed
        WHERE status = 'done' AND completed_at < now() - ${recent}::interval
      ),
      current AS (
        SELECT title, embedding FROM anchors
        UNION ALL
        SELECT title, embedding FROM mine WHERE source = 'ai_suggested' AND confirmed_at IS NULL
      ),
      neighbours AS (
        SELECT DISTINCT a.id AS anchor_id, h.id AS past_id, h.title AS past_title, h.completed_at AS past_at
        FROM anchors a
        CROSS JOIN LATERAL (
          SELECT h.* FROM history h
          WHERE 1 - (h.embedding <=> a.embedding) >= ${NEIGHBOUR_MIN_SIMILARITY}
          ORDER BY h.embedding <=> a.embedding
          LIMIT ${NEIGHBOURS_PER_ANCHOR}
        ) h
      )
      SELECT f.id, f.title, n.past_title, f.completed_at
      FROM neighbours n
      JOIN history f
        ON f.id <> n.past_id
       AND f.completed_at > n.past_at
       AND f.completed_at <= n.past_at + ${window}::interval
      WHERE NOT EXISTS (
        SELECT 1 FROM current c
        WHERE 1 - (c.embedding <=> f.embedding) >= ${DUPLICATE_MIN_SIMILARITY}
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks r
        WHERE r.user_id = ${userId}::uuid
          AND r.source = 'ai_suggested'
          AND r.status = 'archived'
          AND r.suggestion_reason IS NOT NULL
          AND r.updated_at >= now() - ${rejected}::interval
          AND lower(r.title) = lower(f.title)
      )
    `;

    // Titles the user already has, for the exact-title half of the dedupe —
    // the embedding half is in the query above.
    const have = await this.prisma.task.findMany({
      where: {
        userId,
        parentTaskId: null,
        OR: [
          { status: { in: ['pending', 'in_progress'] } },
          { status: 'done', completedAt: { gte: new Date(Date.now() - RECENT_DAYS * 86_400_000) } },
          { source: 'ai_suggested', confirmedAt: null, status: { not: 'archived' } },
        ],
      },
      select: { title: true },
    });

    const byTitle = new Map<
      string,
      { title: string; pastTitle: string; support: number; latest: number }
    >();

    for (const row of rows) {
      if (have.some((task) => sameTitle(task.title, row.title))) continue;

      const key = [...byTitle.keys()].find((title) => sameTitle(title, row.title)) ?? row.title;
      const at = row.completed_at.getTime();
      const seen = byTitle.get(key);

      if (seen === undefined) {
        byTitle.set(key, { title: row.title, pastTitle: row.past_title, support: 1, latest: at });
      } else {
        seen.support += 1;

        if (at > seen.latest) {
          seen.latest = at;
          seen.pastTitle = row.past_title;
        }
      }
    }

    return [...byTitle.values()]
      .sort((a, b) => b.support - a.support || b.latest - a.latest || a.title.localeCompare(b.title))
      .slice(0, MAX_PREDICTIONS)
      .map(({ title, pastTitle }) => ({ title, pastTitle }));
  }
}
