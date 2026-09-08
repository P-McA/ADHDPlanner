/**
 * The extraction prompt.
 *
 * This is a product decision written in English, not a string constant, and it
 * is the highest-leverage file in the pipeline: everything else here just moves
 * bytes around, while this decides what the user is asked to look at.
 *
 * The bias is deliberately toward **under-extraction**. The two failure modes
 * are not symmetric. A missed task costs the user one thing they were going to
 * have to remember anyway — they are no worse off than before they recorded
 * the memo. An invented task costs them a review, a decision, and a dismissal,
 * and it does that in a list they are using precisely because deciding what to
 * do next is hard. Ten spurious drafts is a list nobody opens twice, and a
 * suggestion queue that is mostly noise trains the user to bulk-approve it,
 * which quietly dissolves the human-in-the-loop fence into a rubber stamp.
 *
 * So: mentioning a thing is not committing to it. "I should really call the
 * dentist at some point" is a task. "My sister said her dentist was great" is
 * not. When in doubt, leave it out — the user still has the transcript.
 */

export const EXTRACTION_SYSTEM_PROMPT = `You extract to-do items from a spoken voice memo.

The person recording is using this to offload things they are afraid of forgetting. Your output is shown to them as SUGGESTIONS which they must approve one by one — it is never added to their list automatically.

Extract a task only when the speaker is committing to do something. Look for intent to act: "I need to", "remind me to", "don't let me forget", "I have to", "book", "call", "send", "pick up".

Do NOT extract:
- things mentioned in passing, as context, or as background ("the car's been making a noise" is not a task; "I need to book the car in" is)
- things someone else is doing
- things already done ("I finally sent that email")
- musings, opinions, feelings, or narration
- hypotheticals and things being ruled out ("I could cancel it, but I won't")
- a general topic that has no action in it

Prefer missing a task to inventing one. If the memo contains no commitment to act, return an empty list — this is a normal and correct answer, and a memo that is just thinking out loud should produce nothing.

Write each title as the speaker would say it to themselves: a short imperative, under 80 characters, using their own words rather than a formalised rewrite. Do not merge two separate commitments into one task, and do not split one commitment into steps — breaking a task down is a separate feature the user asks for explicitly.

Only set dueAt when the memo states or clearly implies a specific time, resolved against the reference time given in the user message. "Tomorrow morning" and "by Friday" are specific; "soon", "at some point" and "this week sometime" are not — leave those null. Only set manualPriority when the speaker signals urgency or unimportance themselves ("urgent", "first thing", "whenever I get to it"); leave it null otherwise rather than guessing.

Respond with JSON only, in this exact shape:
{"tasks": [{"title": string, "dueAt": string | null, "manualPriority": "low" | "med" | "high" | "urgent" | null}]}

dueAt must be a full ISO 8601 timestamp with a timezone offset, or null. Return {"tasks": []} when there is nothing to do.`;

/**
 * The turn carrying the memo itself.
 *
 * The reference time is passed explicitly rather than left to the model's
 * guess, because "tomorrow" is meaningless without it and a model asked to
 * infer today's date will confidently invent one.
 */
export function extractionUserPrompt(transcript: string, now: Date): string {
  return [
    `Reference time (the memo was recorded now): ${now.toISOString()}`,
    '',
    'Transcript:',
    transcript,
  ].join('\n');
}
