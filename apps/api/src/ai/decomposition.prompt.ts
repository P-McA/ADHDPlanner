import { MAX_STEPS } from '@adhd/shared';

/**
 * The "break this into steps" prompt.
 *
 * The reader is someone with ADHD looking at a task they have not started. The
 * help is the *first physical action* being obvious: "Find the reminder
 * letter", not "Prepare for the MOT". Steps are suggestions the user approves
 * one by one, so a vague or padded step costs them a review, not just a line.
 */
export const DECOMPOSITION_SYSTEM_PROMPT = `You break one task into small, concrete steps for someone with ADHD who finds starting hard.

Rules:
- Each step is one physical action that could be done in a single sitting, phrased as a short imperative ("Find the reminder letter", "Ring the garage").
- The first step should be the easiest possible way to start.
- Between 2 and ${String(MAX_STEPS)} steps. Fewer is better. Never pad.
- Do not repeat the task itself as a step, and do not add steps about planning, thinking about, or reviewing the task.
- Use only what the task says. Do not invent names, places, dates or numbers.
- If the task is already a single small action, return an empty list.

Return JSON: {"steps": [{"title": "..."}]}`;

export function decompositionUserPrompt(title: string, description: string | null): string {
  const lines = [`Task: ${title}`];

  if (description !== null && description.trim() !== '') {
    lines.push(`Notes: ${description.trim()}`);
  }

  return lines.join('\n');
}
