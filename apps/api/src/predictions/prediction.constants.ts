/**
 * "Suggest tasks" cut-offs, measured against text-embedding-3-small by
 * `src/ai/embedding.eval.spec.ts` (2026-10-09). Cosine similarity:
 *
 *   same kind of task      0.616 – 0.885   ("Book MOT" / "Book MOT for the car")
 *   different kind         0.169 – 0.318
 *   same task, reworded    0.955, 0.767, 0.895
 *   follow-on              0.802, 0.625, 0.714   ("Book the MOT" / "Pay for the MOT")
 *
 * NEIGHBOUR separates cleanly: anything between 0.32 and 0.61 works, and 0.5
 * sits in the middle of the gap.
 *
 * DUPLICATE cannot separate cleanly — a loose rewording (0.767) scores below a
 * genuine follow-on (0.802). So it only aims at near-identical wording: 0.86 is
 * midway between the highest follow-on (0.802) and the lowest near-identical
 * pair measured ("Take the bins out" / "Take bins out", 0.92). A first guess of
 * 0.93 failed on exactly that pair. Alongside it, the exact-title check. The trade, chosen deliberately: an
 * occasional reworded duplicate reaches the user, who rejects it (and is paid
 * the usual review XP), rather than real follow-ons being silently thrown away
 * as copies of what they follow — which would hollow out the feature.
 */
export const NEIGHBOUR_MIN_SIMILARITY = 0.5;
export const DUPLICATE_MIN_SIMILARITY = 0.86;

/** Anchors: the user's open tasks, and what they finished in this many days. */
export const RECENT_DAYS = 14;

/** A follow-on is something finished within this many days after the past task. */
export const FOLLOW_ON_WINDOW_DAYS = 7;

/** How many similar past tasks are looked at per anchor. */
export const NEIGHBOURS_PER_ANCHOR = 5;

/** At most this many tasks are embedded per press; the rest wait for the next one. */
export const EMBED_BATCH_MAX = 200;
