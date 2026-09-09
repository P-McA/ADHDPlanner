import type { UserStats } from '@adhd/shared';
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
export function StatsHeader({ stats }: { stats: UserStats | null }) {
  return (
    <View style={styles.row} testID="stats-header">
      <Stat label="Level" value={stats === null ? '—' : String(stats.level)} />
      <Stat label="XP" value={stats === null ? '—' : String(stats.totalXp)} />
      <Stat
        label="Streak"
        value={stats === null ? '—' : `${String(stats.currentStreak)}d`}
      />
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
  row: { backgroundColor: '#f4f4f5', borderRadius: 12, flexDirection: 'row', padding: 16 },
  stat: { alignItems: 'center', flex: 1 },
  value: { fontSize: 20, fontWeight: '700' },
  label: { color: '#666', fontSize: 12, textTransform: 'uppercase' },
});
