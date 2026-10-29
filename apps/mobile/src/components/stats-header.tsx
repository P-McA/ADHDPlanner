import {
  type ActivityComparison,
  type ActivityDirection,
  type ActivityMetrics,
  type EarnedBadge,
  ACTIVITY_DIRECTION_LABELS,
  eloTone,
  type TrackingMode,
  type UserStats,
  XP_PER_LEVEL,
} from '@adhd/shared';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, space, TAP, type ThemeColors, type as typeScale, useTheme } from '../theme/theme';

/**
 * Progress header. `metrics` is the adult default: counts and a colour-coded
 * comparison against the user's own trailing baseline. `xp` is the rewards
 * view.
 *
 * Colour is never the only signal — every comparison also carries an icon and
 * a text label, so it survives colour blindness and a screen reader. Every
 * number is served; the one piece of arithmetic is the XP bar, using the shared
 * `XP_PER_LEVEL`.
 */
export function StatsHeader({
  mode,
  showElo,
  stats,
  activity,
  badges = [],
  onChangeMode,
  onToggleElo,
  now = new Date(),
}: {
  mode: TrackingMode;
  showElo: boolean;
  stats: UserStats | null;
  activity: ActivityMetrics | null;
  badges?: EarnedBadge[];
  onChangeMode: (mode: TrackingMode) => void;
  onToggleElo: () => void;
  now?: Date;
}) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  return (
    <View style={styles.wrap}>
      <Text style={styles.date}>
        {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
      </Text>

      <View style={styles.switch} accessibilityRole="tablist" accessibilityLabel="Tracking mode">
        <ModeOption
          label="Activity"
          active={mode === 'metrics'}
          onPress={() => {
            onChangeMode('metrics');
          }}
          styles={styles}
        />
        <ModeOption
          label="Rewards"
          active={mode === 'xp'}
          onPress={() => {
            onChangeMode('xp');
          }}
          styles={styles}
        />
      </View>

      {mode === 'metrics' ? (
        <ActivityPanel
          activity={activity}
          showElo={showElo}
          onToggleElo={onToggleElo}
          styles={styles}
          colors={colors}
        />
      ) : (
        <RewardsPanel stats={stats} badges={badges} styles={styles} colors={colors} />
      )}
    </View>
  );
}

function ModeOption({
  label,
  active,
  onPress,
  styles,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.option, active && styles.optionActive]}
    >
      <Text style={[styles.optionText, active && styles.optionTextActive]}>{label}</Text>
    </Pressable>
  );
}

const DIRECTION_ICON: Record<ActivityDirection, 'arrow-up' | 'remove' | 'arrow-down'> = {
  above: 'arrow-up',
  level: 'remove',
  below: 'arrow-down',
};

function ActivityPanel({
  activity,
  showElo,
  onToggleElo,
  styles,
  colors,
}: {
  activity: ActivityMetrics | null;
  showElo: boolean;
  onToggleElo: () => void;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  const counts = activity?.counts;

  return (
    <View style={styles.card} testID="activity-header">
      <View style={styles.countRow}>
        <Count label="Done today" value={counts?.completedToday} styles={styles} />
        <Count label="This week" value={counts?.completedThisWeek} styles={styles} />
        <Count label="This month" value={counts?.completedThisMonth} styles={styles} />
        <Count label="Pending" value={activity?.pending} styles={styles} />
      </View>

      <View style={styles.compareHead}>
        <Text style={styles.compareTitle}>Against your average</Text>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: showElo }}
          onPress={onToggleElo}
          style={styles.ratingToggle}
        >
          <Text style={styles.ratingToggleText}>{showElo ? 'Hide rating' : 'Show rating'}</Text>
        </Pressable>
      </View>

      <ComparisonRow label="Today" comparison={activity?.day} showElo={showElo} styles={styles} colors={colors} />
      <ComparisonRow label="This week" comparison={activity?.week} showElo={showElo} styles={styles} colors={colors} />
      <ComparisonRow label="This month" comparison={activity?.month} showElo={showElo} styles={styles} colors={colors} />

      {activity ? <Sparkline points={activity.series} styles={styles} colors={colors} /> : null}
    </View>
  );
}

function Count({
  label,
  value,
  styles,
}: {
  label: string;
  value: number | undefined;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.count}>
      <Text style={styles.countLabel}>{label}</Text>
      <Text style={styles.countValue}>{value === undefined ? '—' : String(value)}</Text>
    </View>
  );
}

function ComparisonRow({
  label,
  comparison,
  showElo,
  styles,
  colors,
}: {
  label: string;
  comparison: ActivityComparison | undefined;
  showElo: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  if (!comparison || comparison.status === 'no-data') {
    return (
      <View style={styles.compareRow}>
        <Text style={styles.compareLabel}>{label}</Text>
        <Text style={styles.neutralChip}>No baseline yet</Text>
      </View>
    );
  }

  const tone = eloTone(comparison.direction);
  const toneColor = tone === 'green' ? colors.success : tone === 'amber' ? colors.warning : colors.danger;

  return (
    <View style={styles.compareRow}>
      <Text style={styles.compareLabel}>{label}</Text>
      <View style={[styles.chip, { borderColor: toneColor }]}>
        <Ionicons name={DIRECTION_ICON[comparison.direction]} size={12} color={toneColor} />
        <Text style={[styles.chipText, { color: toneColor }]}>
          {ACTIVITY_DIRECTION_LABELS[comparison.direction]}
          {showElo ? ` · ${String(comparison.current)} vs ${String(comparison.baseline)}` : ''}
        </Text>
      </View>
    </View>
  );
}

function Sparkline({
  points,
  styles,
  colors,
}: {
  points: ActivityMetrics['series'];
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  const max = Math.max(1, ...points.map((point) => point.rating ?? 0));

  const active = points.filter((point) => point.rating !== null).length;

  return (
    <View
      accessible
      style={styles.sparkline}
      accessibilityLabel={`Last 30 days, ${String(active)} active`}
    >
      {points.map((point) => (
        <View
          key={point.date}
          style={[
            styles.sparkBar,
            {
              backgroundColor: point.rating === null ? colors.surfaceMuted : colors.accent,
              height: `${String(Math.max(4, Math.round(((point.rating ?? 0) / max) * 100)))}%` as `${number}%`,
            },
          ]}
        />
      ))}
    </View>
  );
}

function RewardsPanel({
  stats,
  badges,
  styles,
  colors,
}: {
  stats: UserStats | null;
  badges: EarnedBadge[];
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  const intoLevel = stats === null ? 0 : stats.totalXp % XP_PER_LEVEL;

  return (
    <>
      <View style={styles.card} testID="stats-header">
        <View style={styles.levelRow}>
          <Text style={styles.level}>Level {stats === null ? '—' : String(stats.level)}</Text>
          <View style={styles.streakRow}>
            {stats !== null && stats.freezes > 0 ? (
              <View style={styles.freeze} accessibilityLabel={`${String(stats.freezes)} streak freezes`}>
                <Ionicons name="snow-outline" size={14} color={colors.accent} />
                <Text style={styles.freezeText}>{stats.freezes}</Text>
              </View>
            ) : null}
            <View style={styles.streak} accessibilityLabel="Streak">
              <Ionicons name="flame" size={16} color={colors.warning} />
              <Text style={styles.streakText}>
                {stats === null ? '—' : `${String(stats.currentStreak)}d streak`}
              </Text>
            </View>
          </View>
        </View>
        <View
          style={styles.track}
          accessibilityLabel={`${String(intoLevel)} of ${String(XP_PER_LEVEL)} XP to the next level`}
        >
          <View style={[styles.fill, { width: `${String((intoLevel / XP_PER_LEVEL) * 100)}%` as `${number}%` }]} />
        </View>
        <Text style={styles.xp}>
          {stats === null ? '— XP' : `${String(stats.totalXp)} XP · ${String(XP_PER_LEVEL - intoLevel)} to next level`}
        </Text>
      </View>

      {badges.length === 0 ? null : (
        <View style={styles.badges} testID="badges" accessibilityLabel="Badges">
          {badges.map((badge) => (
            <View key={badge.key} style={styles.badge} accessibilityHint={badge.description}>
              <Ionicons name="ribbon-outline" size={12} color={colors.accent} />
              <Text style={styles.badgeText}>{badge.name}</Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { gap: space.md },
    date: { ...typeScale.title, color: colors.text },
    switch: { flexDirection: 'row', gap: space.xs },
    option: {
      borderColor: colors.border,
      justifyContent: 'center',
      minHeight: TAP,
      borderRadius: radius.pill,
      borderWidth: 1,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
    },
    optionActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    optionText: { ...typeScale.label, color: colors.text },
    optionTextActive: { color: colors.surface },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.lg,
      borderWidth: 1,
      gap: space.sm,
      padding: space.lg,
    },
    countRow: { flexDirection: 'row', justifyContent: 'space-between' },
    count: { flex: 1 },
    countLabel: { ...typeScale.caption, color: colors.textMuted },
    countValue: { ...typeScale.heading, color: colors.text, fontVariant: ['tabular-nums'] },
    compareHead: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    compareTitle: { ...typeScale.label, color: colors.textMuted },
    ratingToggle: { justifyContent: 'center', minHeight: TAP },
    ratingToggleText: { ...typeScale.caption, color: colors.accent },
    compareRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    compareLabel: { ...typeScale.small, color: colors.text },
    chip: {
      alignItems: 'center',
      borderRadius: radius.pill,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: space.sm,
      paddingVertical: 2,
    },
    chipText: { ...typeScale.caption, fontWeight: '600' },
    neutralChip: { ...typeScale.caption, color: colors.textMuted },
    sparkline: {
      alignItems: 'flex-end',
      flexDirection: 'row',
      gap: 2,
      height: 48,
      paddingTop: space.sm,
    },
    sparkBar: { borderRadius: 2, flex: 1, minHeight: 2 },
    levelRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    level: { ...typeScale.heading, color: colors.text },
    streakRow: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
    streak: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    freeze: { alignItems: 'center', flexDirection: 'row', gap: 2 },
    freezeText: { ...typeScale.label, color: colors.accent },
    streakText: { ...typeScale.label, color: colors.text },
    track: { backgroundColor: colors.surfaceMuted, borderRadius: radius.pill, height: 8, overflow: 'hidden' },
    fill: { backgroundColor: colors.accent, borderRadius: radius.pill, height: 8 },
    xp: { ...typeScale.small, color: colors.textMuted },
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    badge: {
      alignItems: 'center',
      backgroundColor: colors.accentSoft,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
    },
    badgeText: { ...typeScale.caption, color: colors.accent },
  });
}
