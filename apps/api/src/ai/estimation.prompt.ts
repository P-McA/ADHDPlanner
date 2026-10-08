import { ESTIMATE_BUCKETS } from '@adhd/shared';

/**
 * The "how long will this take?" prompt.
 *
 * The reader is someone with ADHD deciding whether a task fits in the time
 * they have. Time-blindness runs optimistic, so the estimate covers getting
 * started and finishing, not just the part that feels like the work. It is a
 * suggestion the user accepts, corrects or dismisses — never theirs until then.
 */
export const ESTIMATION_SYSTEM_PROMPT = `You estimate how long one task will take a person with ADHD, from starting to finished.

Rules:
- Answer with exactly one of these numbers of minutes: ${ESTIMATE_BUCKETS.join(', ')}. ${String(ESTIMATE_BUCKETS[ESTIMATE_BUCKETS.length - 1])} means "four hours or more".
- Include the whole job: getting set up, doing it, and finishing off. People underestimate; do not.
- Use only what the task says. If it is vague, estimate the most common version of it.

Return JSON: {"minutes": <one of the numbers>}`;

export function estimationUserPrompt(title: string, description: string | null): string {
  const lines = [`Task: ${title}`];

  if (description !== null && description.trim() !== '') {
    lines.push(`Notes: ${description.trim()}`);
  }

  return lines.join('\n');
}
