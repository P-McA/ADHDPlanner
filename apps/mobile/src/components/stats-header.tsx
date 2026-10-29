import { type EarnedBadge, type UserStats, XP_PER_LEVEL } from '@adhd/shared';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { radius, space, type ThemeColors, type as typeScale, useTheme } from '../theme/theme';

/**
 * Today's date, then level, progress to the next level, and streak — small,
 * so the tasks below stay the main thing on the screen.
 *
 * Every number is served, never derived here: level and streak come from the
 * API, which knows the user's time zone and a phone in an airport does not.
 * The progress bar is the one piece of arithmetic, and it is the shared rule
 * (`XP_PER_LEVEL`) applied to the served total, not a second copy of it.
 */
export function StatsHeader({
  stats,
  badges = [],
  now = new Date(),
}: {
  stats: UserStats | null;
  badges?: EarnedBadge[];
  now?: Date;
}) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const intoLevel = stats === null ? 0 : stats.totalXp % XP_PER_LEVEL;

  return (
    <View style={styles.wrap}>
      <Text style={styles.date}>
        {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
      </Text>

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
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { gap: space.md },
    date: { ...typeScale.title, color: colors.text },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.lg,
      borderWidth: 1,
      gap: space.sm,
      padding: space.lg,
    },
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
