import type {
  ActivityComparison,
  ActivityDirection,
  ActivityMetrics,
  EarnedBadge,
  TrackingMode,
  UserStats,
} from '@adhd/shared';
import { ACTIVITY_DIRECTION_LABELS, eloTone } from '@adhd/shared';

/**
 * Progress header. Two modes, one component.
 *
 * `metrics` is the adult default: counts and a colour-coded comparison against
 * the user's own trailing baseline. `xp` is the rewards view. Every number is
 * derived server-side, so this component only formats what it is given.
 *
 * Colour is never the only signal: each comparison carries an icon and a text
 * label, so the state survives colour blindness and a screen reader.
 */
export function StatsHeader({
  mode,
  showElo,
  stats,
  activity,
  badges = [],
  onChangeMode,
  onToggleElo,
}: {
  mode: TrackingMode;
  showElo: boolean;
  stats: UserStats | null;
  activity: ActivityMetrics | null;
  badges?: EarnedBadge[];
  onChangeMode: (mode: TrackingMode) => void;
  onToggleElo: () => void;
}) {
  return (
    <>
      <div className="tracking" role="group" aria-label="Tracking mode">
        <button
          type="button"
          className={mode === 'metrics' ? 'tracking-option active' : 'tracking-option'}
          aria-pressed={mode === 'metrics'}
          onClick={() => onChangeMode('metrics')}
        >
          Activity
        </button>
        <button
          type="button"
          className={mode === 'xp' ? 'tracking-option active' : 'tracking-option'}
          aria-pressed={mode === 'xp'}
          onClick={() => onChangeMode('xp')}
        >
          Rewards
        </button>
      </div>

      {mode === 'metrics' ? (
        <ActivityPanel activity={activity} showElo={showElo} onToggleElo={onToggleElo} />
      ) : (
        <RewardsPanel stats={stats} badges={badges} />
      )}
    </>
  );
}

function ActivityPanel({
  activity,
  showElo,
  onToggleElo,
}: {
  activity: ActivityMetrics | null;
  showElo: boolean;
  onToggleElo: () => void;
}) {
  const counts = activity?.counts;

  return (
    <section className="stats" aria-label="Your activity">
      <div>
        <div className="stat-label">Done today</div>
        <div className="stat-value accent">{counts ? counts.completedToday : '—'}</div>
      </div>
      <div>
        <div className="stat-label">Done this week</div>
        <div className="stat-value">{counts ? counts.completedThisWeek : '—'}</div>
      </div>
      <div>
        <div className="stat-label">Done this month</div>
        <div className="stat-value">{counts ? counts.completedThisMonth : '—'}</div>
      </div>
      <div>
        <div className="stat-label">Pending</div>
        <div className="stat-value">{activity ? activity.pending : '—'}</div>
      </div>

      <div className="activity-compare">
        <div className="activity-compare-head">
          <span className="stat-label">Against your average</span>
          <button
            type="button"
            className="tracking-option"
            aria-pressed={showElo}
            onClick={onToggleElo}
          >
            {showElo ? 'Hide rating' : 'Show rating'}
          </button>
        </div>
        <ComparisonRow label="Today" comparison={activity?.day} showElo={showElo} />
        <ComparisonRow label="This week" comparison={activity?.week} showElo={showElo} />
        <ComparisonRow label="This month" comparison={activity?.month} showElo={showElo} />
      </div>

      {activity?.series?.length ? <Sparkline points={activity.series} /> : null}
    </section>
  );
}

const DIRECTION_ICON: Record<ActivityDirection, string> = {
  above: '▲',
  level: '●',
  below: '▼',
};

function ComparisonRow({
  label,
  comparison,
  showElo,
}: {
  label: string;
  comparison: ActivityComparison | undefined;
  showElo: boolean;
}) {
  if (!comparison || comparison.status === 'no-data') {
    return (
      <div className="compare-row">
        <span className="compare-label">{label}</span>
        <span className="compare-chip neutral">No baseline yet</span>
      </div>
    );
  }

  const tone = eloTone(comparison.direction);

  return (
    <div className="compare-row">
      <span className="compare-label">{label}</span>
      <span className={`compare-chip ${tone}`}>
        <span aria-hidden="true">{DIRECTION_ICON[comparison.direction]}</span>{' '}
        {ACTIVITY_DIRECTION_LABELS[comparison.direction]}
        {showElo ? (
          <span className="compare-number">
            {' '}
            {comparison.current} vs {comparison.baseline}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function Sparkline({ points }: { points: ActivityMetrics['series'] }) {
  const max = Math.max(1, ...points.map((point) => point.rating ?? 0));

  const active = points.filter((point) => point.rating !== null).length;

  return (
    <div className="sparkline" aria-label={`Last 30 days, ${String(active)} active`} role="img">
      {points.map((point) => (
        <div
          key={point.date}
          className={point.rating === null ? 'spark-bar empty' : 'spark-bar'}
          style={{ height: `${String(Math.round(((point.rating ?? 0) / max) * 100))}%` }}
          title={point.rating === null ? `${point.date}: no activity` : `${point.date}: ${point.rating}`}
        />
      ))}
    </div>
  );
}

function RewardsPanel({ stats, badges }: { stats: UserStats | null; badges: EarnedBadge[] }) {
  const cells: { label: string; value: string; accent?: boolean }[] = [
    { label: 'Level', value: stats ? String(stats.level) : '—', accent: true },
    { label: 'Total XP', value: stats ? String(stats.totalXp) : '—' },
    { label: 'Streak', value: stats ? `${String(stats.currentStreak)} d` : '—' },
    { label: 'Longest', value: stats ? `${String(stats.longestStreak)} d` : '—' },
    { label: 'Freezes', value: stats ? String(stats.freezes) : '—' },
  ];

  return (
    <>
      <section className="stats" aria-label="Your progress">
        {cells.map((cell) => (
          <div key={cell.label}>
            <div className="stat-label">{cell.label}</div>
            <div className={cell.accent ? 'stat-value accent' : 'stat-value'}>{cell.value}</div>
          </div>
        ))}
      </section>
      {badges.length === 0 ? null : (
        <ul className="badges" aria-label="Badges">
          {badges.map((badge) => (
            <li key={badge.key} title={badge.description}>
              {badge.name}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
