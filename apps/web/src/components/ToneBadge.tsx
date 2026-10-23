import { Badge, type BadgeProps } from '@mantine/core';
import type { ComponentPropsWithoutRef } from 'react';

import type { Tone } from '../format/format';

/** Green and red are for direction and result, amber for warnings, grey for market closed, gold for the brand. */
export const TONE_COLOR: Record<Tone, string> = {
  positive: 'positive',
  negative: 'negative',
  warning: 'warning',
  info: 'info',
  brand: 'gold',
  neutral: 'gray',
};

type ToneBadgeProps = Omit<BadgeProps, 'color'> &
  Omit<ComponentPropsWithoutRef<'div'>, 'color' | keyof BadgeProps> & { tone: Tone };

/** A badge whose meaning is always in its text; the colour only backs it up. */
export function ToneBadge({ tone, children, ...rest }: ToneBadgeProps) {
  return (
    <Badge variant="light" color={TONE_COLOR[tone]} {...rest}>
      {children}
    </Badge>
  );
}
