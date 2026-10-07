import type { EarnedBadge, UserStats } from '@adhd/shared';
import { StyleSheet, Text, View } from 'react-native';

/**
 * XP, level and streak.
 *
 * Every number is served, never derived here. The level is 100 XP a level and
 * the streak turns over at midnight *in the user's timezone*, both of which the
 * API already knows and a phone in an airport does not. Recomputing either on
 * the client would produce a display that disagrees with the server for hours
 * at a time, which is worse than a stale one.
 */
export function StatsHeader({
  stats,
  badges = [],
}: {
  stats: UserStats | null;
  badges?: EarnedBadge[];
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.row} testID="stats-header">
        <Stat label="Level" value={stats === null ? '—' : String(stats.level)} />
        <Stat label="XP" value={stats === null ? '—' : String(stats.totalXp)} />
        <Stat label="Streak" value={stats === null ? '—' : `${String(stats.currentStreak)}d`} />
      </View>
      {badges.length === 0 ? null : (
        <View style={styles.badges} testID="badges" accessibilityLabel="Badges">
          {badges.map((badge) => (
            <Text key={badge.key} style={styles.badge} accessibilityHint={badge.description}>
              {badge.name}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: {
    backgroundColor: '#ede9fe',
    borderRadius: 999,
    color: '#5b21b6',
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  row: { backgroundColor: '#f4f4f5', borderRadius: 12, flexDirection: 'row', padding: 16 },
  stat: { alignItems: 'center', flex: 1 },
  value: { fontSize: 20, fontWeight: '700' },
  label: { color: '#666', fontSize: 12, textTransform: 'uppercase' },
});
