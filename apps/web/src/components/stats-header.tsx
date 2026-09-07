import type { UserStats } from '@adhd/shared';

/**
 * The gamification summary from GET /me/stats.
 *
 * Every number here is derived server-side — level from the ledger, the streak
 * from the user's own timezone — so this component only formats what it is
 * given and never computes progress itself.
 */
export function StatsHeader({ stats }: { stats: UserStats | null }) {
  const cells: { label: string; value: string; accent?: boolean }[] = [
    { label: 'Level', value: stats ? String(stats.level) : '—', accent: true },
    { label: 'Total XP', value: stats ? String(stats.totalXp) : '—' },
    { label: 'Streak', value: stats ? `${String(stats.currentStreak)} d` : '—' },
    { label: 'Longest', value: stats ? `${String(stats.longestStreak)} d` : '—' },
  ];

  return (
    <section className="stats" aria-label="Your progress">
      {cells.map((cell) => (
        <div key={cell.label}>
          <div className="stat-label">{cell.label}</div>
          <div className={cell.accent ? 'stat-value accent' : 'stat-value'}>{cell.value}</div>
        </div>
      ))}
    </section>
  );
}
