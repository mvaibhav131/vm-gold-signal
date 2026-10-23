import {
  Anchor,
  createTheme,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from '@mantine/core';

// Visual tokens of 05_UI_Spec section 10. Gold is the brand accent only; green and red are used
// for direction and result, amber for warnings, grey for market closed.
const TOKENS = {
  background: '#0B0F14',
  surface1: '#121821',
  surface2: '#18212C',
  border: '#263241',
  textPrimary: '#F5F7FA',
  textMuted: '#9EACBA',
  gold: '#D9A441',
  positive: '#25B678',
  negative: '#E45D5D',
  warning: '#E0A33A',
  info: '#5AA9E6',
} as const;

function channel(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function mix(hex: string, towards: number, amount: number): string {
  const part = (index: number) =>
    Math.round(channel(hex, index) + (towards - channel(hex, index)) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${part(0)}${part(1)}${part(2)}`;
}

/** Ten shades around a base colour: lighter below index 6, the base at 6, darker above. */
export function shades(base: string): MantineColorsTuple {
  return [
    mix(base, 255, 0.92),
    mix(base, 255, 0.8),
    mix(base, 255, 0.64),
    mix(base, 255, 0.48),
    mix(base, 255, 0.28),
    mix(base, 255, 0.12),
    base,
    mix(base, 0, 0.16),
    mix(base, 0, 0.32),
    mix(base, 0, 0.5),
  ];
}

const dark: MantineColorsTuple = [
  TOKENS.textPrimary,
  '#C9D2DB',
  TOKENS.textMuted,
  '#7B8998',
  TOKENS.border,
  TOKENS.surface2,
  TOKENS.surface1,
  TOKENS.background,
  '#080B0F',
  '#05070A',
];

export const theme = createTheme({
  primaryColor: 'gold',
  primaryShade: 6,
  autoContrast: true,
  defaultRadius: 'md',
  // System fonts only: nothing is downloaded, the app works offline and costs nothing.
  fontFamily:
    'Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
  headings: { fontWeight: '650' },
  // Links are always underlined: they never rely on colour alone to be recognised.
  components: { Anchor: Anchor.extend({ defaultProps: { underline: 'always' } }) },
  colors: {
    dark,
    gold: shades(TOKENS.gold),
    positive: shades(TOKENS.positive),
    negative: shades(TOKENS.negative),
    warning: shades(TOKENS.warning),
    info: shades(TOKENS.info),
  },
});

const SEMANTIC_COLORS = ['gold', 'positive', 'negative', 'warning', 'info'] as const;

/**
 * Light theme contrast. The palettes put the bright token colour at index 6, which suits the dark
 * theme. On white, text and outlines need the darker shades, and the muted text needs more weight.
 */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  dark: {},
  light: {
    '--mantine-color-dimmed': 'var(--mantine-color-gray-7)',
    '--mantine-color-anchor': 'var(--mantine-color-gold-9)',
    ...Object.fromEntries(
      SEMANTIC_COLORS.flatMap((name) => [
        [`--mantine-color-${name}-light-color`, `var(--mantine-color-${name}-9)`],
        [`--mantine-color-${name}-outline`, `var(--mantine-color-${name}-8)`],
      ]),
    ),
  },
});

export { TOKENS };
