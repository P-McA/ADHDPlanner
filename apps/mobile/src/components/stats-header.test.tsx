import type { ActivityMetrics } from '@adhd/shared';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { StatsHeader } from './stats-header';

const activity: ActivityMetrics = {
  counts: { completedToday: 2, completedThisWeek: 4, completedThisMonth: 9 },
  pending: 3,
  day: { status: 'ok', direction: 'above', current: 180, baseline: 100 },
  week: { status: 'ok', direction: 'level', current: 100, baseline: 100 },
  month: { status: 'ok', direction: 'below', current: 60, baseline: 100 },
  series: [{ date: '2026-10-29', rating: 180 }],
};

const renderHeader = async (over: Partial<Parameters<typeof StatsHeader>[0]> = {}) =>
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
  it('shows the counts', async () => {
    await renderHeader();

    expect(screen.getByText('Done today')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
  });

  it('labels every direction in text, not colour alone', async () => {
    await renderHeader();

    expect(screen.getByText(/Above your average/)).toBeTruthy();
    expect(screen.getByText(/On your average/)).toBeTruthy();
    expect(screen.getByText(/Below your average/)).toBeTruthy();
  });

  it('hides the rating number by default', async () => {
    await renderHeader();

    expect(screen.queryByText(/180 vs 100/)).toBeNull();
  });

  it('reveals the rating number when the setting is on', async () => {
    await renderHeader({ showElo: true });

    expect(screen.getByText(/180 vs 100/)).toBeTruthy();
  });

  it('asks the parent to toggle the number', async () => {
    const onToggleElo = jest.fn();
    await renderHeader({ onToggleElo });

    await fireEvent.press(screen.getByText('Show rating'));

    expect(onToggleElo).toHaveBeenCalledTimes(1);
  });

  it('reports no baseline rather than a direction when there is no history', async () => {
    await renderHeader({ activity: { ...activity, day: { status: 'no-data' } } });

    expect(screen.getAllByText('No baseline yet').length).toBeGreaterThan(0);
  });
});

describe('StatsHeader — mode switch', () => {
  it('marks the active mode and switches to rewards', async () => {
    const onChangeMode = jest.fn();
    await renderHeader({ onChangeMode });

    expect(screen.getByRole('tab', { name: 'Activity' }).props.accessibilityState).toMatchObject({
      selected: true,
    });
    await fireEvent.press(screen.getByText('Rewards'));

    expect(onChangeMode).toHaveBeenCalledWith('xp');
  });

  it('shows level and XP in rewards mode', async () => {
    await renderHeader({
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

    expect(screen.getByText('Level 2')).toBeTruthy();
  });
});
