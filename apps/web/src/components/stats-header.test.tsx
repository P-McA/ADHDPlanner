import type { ActivityMetrics } from '@adhd/shared';
import { fireEvent, render, screen } from '@testing-library/react';

import { StatsHeader } from './stats-header';

const activity: ActivityMetrics = {
  counts: { completedToday: 2, completedThisWeek: 4, completedThisMonth: 9 },
  pending: 3,
  day: { status: 'ok', direction: 'above', current: 180, baseline: 100 },
  week: { status: 'ok', direction: 'level', current: 100, baseline: 100 },
  month: { status: 'ok', direction: 'below', current: 60, baseline: 100 },
  series: [{ date: '2026-10-29', rating: 180 }],
};

const renderHeader = (over: Partial<Parameters<typeof StatsHeader>[0]> = {}) =>
  render(
    <StatsHeader
      mode="metrics"
      showElo={false}
      stats={null}
      activity={activity}
      onChangeMode={jest.fn()}
      onToggleElo={jest.fn()}
      {...over}
    />,
  );

describe('StatsHeader — activity view', () => {
  it('shows the counts', () => {
    renderHeader();

    expect(screen.getByText('Done today')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
  });

  it('labels every direction in text, not colour alone', () => {
    renderHeader();

    expect(screen.getByText(/Above your average/)).toBeTruthy();
    expect(screen.getByText(/On your average/)).toBeTruthy();
    expect(screen.getByText(/Below your average/)).toBeTruthy();
  });

  it('hides the rating number by default', () => {
    renderHeader();

    expect(screen.queryByText(/180 vs 100/)).toBeNull();
  });

  it('reveals the rating number when the setting is on', () => {
    renderHeader({ showElo: true });

    expect(screen.getByText(/180 vs 100/)).toBeTruthy();
  });

  it('asks the parent to toggle the number', () => {
    const onToggleElo = jest.fn();
    renderHeader({ onToggleElo });

    fireEvent.click(screen.getByRole('button', { name: 'Show rating' }));

    expect(onToggleElo).toHaveBeenCalledTimes(1);
  });

  it('reports no baseline rather than a direction when there is no history', () => {
    renderHeader({ activity: { ...activity, day: { status: 'no-data' } } });

    expect(screen.getAllByText('No baseline yet').length).toBeGreaterThan(0);
  });
});

describe('StatsHeader — mode switch', () => {
  it('marks the active mode and switches to rewards', () => {
    const onChangeMode = jest.fn();
    renderHeader({ onChangeMode });

    expect(screen.getByRole('button', { name: 'Activity' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rewards' }));

    expect(onChangeMode).toHaveBeenCalledWith('xp');
  });

  it('shows level and XP in rewards mode', () => {
    renderHeader({
      mode: 'xp',
      stats: {
        totalXp: 120,
        level: 2,
        currentStreak: 3,
        longestStreak: 5,
        lastActiveDate: '2026-10-29',
        freezes: 1,
      },
    });

    expect(screen.getByText('Level')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });
});
