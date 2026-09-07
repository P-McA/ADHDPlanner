import { TaskDashboard } from '../components/task-dashboard';

export default function HomePage() {
  return (
    <main className="page">
      <h1>ADHD Planner</h1>
      <p className="subtitle">Phase 1 — tasks, XP and streaks</p>

      <TaskDashboard />
    </main>
  );
}
