import { useColorScheme } from 'react-native';

/**
 * The app's one set of design tokens (owner ruling 2026-10-09: "calm &
 * focused").
 *
 * Warm neutral backgrounds, one accent, and a separate violet kept only for
 * AI suggestions, so "the model proposed this" is recognisable at a glance and
 * never mistaken for the user's own work. Everything else is quiet on
 * purpose: the screen should point at one next thing, not compete for
 * attention.
 *
 * Both palettes name exactly the same colours (pinned by the theme test), and
 * text, muted text and accent buttons all keep WCAG AA contrast on the
 * surfaces they sit on.
 */
export const lightColors = {
  background: '#f5f4f0',
  surface: '#ffffff',
  surfaceMuted: '#eeece6',
  border: '#e2dfd8',
  text: '#1e2126',
  textMuted: '#5e636b',
  accent: '#4652c9',
  accentSoft: '#e9ebfa',
  onAccent: '#ffffff',
  success: '#2f7d4f',
  warning: '#9a6a12',
  danger: '#b3261e',
  draft: '#6e4fb0',
  draftSoft: '#f0ebf9',
};

export type ThemeColors = typeof lightColors;

export const darkColors: ThemeColors = {
  background: '#111316',
  surface: '#1a1d21',
  surfaceMuted: '#23272c',
  border: '#2d3137',
  text: '#ecedee',
  textMuted: '#a3a9b0',
  accent: '#9aa3ff',
  accentSoft: '#262b4d',
  onAccent: '#111316',
  success: '#6cc58f',
  warning: '#e0b260',
  danger: '#f2786d',
  draft: '#b9a3ee',
  draftSoft: '#2b2540',
};

/** A small fixed spacing scale; nothing in the app uses a value off it. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

export const type = {
  title: { fontSize: 26, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 17, fontWeight: '700' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  label: { fontSize: 14, fontWeight: '600' as const },
  small: { fontSize: 13, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '600' as const, letterSpacing: 0.4 },
};

/** The smallest comfortable tap target, in points (Apple HIG / Material). */
export const TAP = 44;

export interface Theme {
  mode: 'light' | 'dark';
  colors: ThemeColors;
}

/** The phone's light/dark setting, as tokens. No preference means light. */
export function useTheme(): Theme {
  const mode = useColorScheme() === 'dark' ? 'dark' : 'light';

  return { mode, colors: mode === 'dark' ? darkColors : lightColors };
}
