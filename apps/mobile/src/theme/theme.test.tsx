import { render, screen } from '@testing-library/react-native';
import { Text, useColorScheme } from 'react-native';

import { darkColors, lightColors, radius, space, useTheme } from './theme';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const scheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;

function Probe() {
  const theme = useTheme();

  return <Text testID="probe">{`${theme.mode}:${theme.colors.background}`}</Text>;
}

/**
 * One set of tokens, two palettes. What is pinned: the phone's setting picks
 * the palette (and "no preference" is light), every palette names the same
 * colours so a component can never ask for one that only exists in light, and
 * text keeps enough contrast on its background to read — the whole point of a
 * calm theme is lost if muted means illegible.
 */
describe('theme', () => {
  it.each([
    ['dark', 'dark', darkColors.background],
    ['light', 'light', lightColors.background],
    ['unspecified', 'light', lightColors.background],
  ] as const)('follows the phone: %s → %s', async (setting, mode, background) => {
    scheme.mockReturnValue(setting);

    await render(<Probe />);

    expect(screen.getByTestId('probe')).toHaveTextContent(`${mode}:${background}`);
  });

  it('gives both palettes exactly the same colour names', () => {
    expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
  });

  it.each([
    ['light', lightColors],
    ['dark', darkColors],
  ] as const)('keeps body and muted text readable on the %s background (WCAG AA)', (_name, colors) => {
    expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.text, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.textMuted, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('spaces and rounds on a small fixed scale', () => {
    expect(Object.values(space)).toEqual([4, 8, 12, 16, 24, 32]);
    expect(radius.pill).toBeGreaterThan(radius.lg);
  });
});

/** WCAG 2 contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;

      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });

    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return (hi! + 0.05) / (lo! + 0.05);
}
