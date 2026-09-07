import { TASK_STATUSES } from '@adhd/shared';

export default function HomePage() {
  return (
    <main>
      <h1>ADHD Planner</h1>
      <p>Phase 0 — Foundation</p>

      <h2>Task statuses from @adhd/shared</h2>
      <ul>
        {TASK_STATUSES.map((status) => (
          <li key={status}>{status}</li>
        ))}
      </ul>
    </main>
  );
}
