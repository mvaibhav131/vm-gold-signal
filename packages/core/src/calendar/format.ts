import { fixedText } from '../explain/format';

const MULTIPLIER_SUFFIX: Readonly<Record<string, string>> = {
  thousands: 'K',
  millions: 'M',
  billions: 'B',
  trillions: 'T',
};

/** How the provider writes a figure: its unit, its multiplier and the decimals it shows. */
export interface ValueUnits {
  readonly unit: string | null;
  readonly multiplier: string | null;
  readonly digits: number | null;
}

const DEFAULT_DIGITS = 2;
const MAX_DIGITS = 6;

/** `0.3%`, `-114.307B`, `0.708M`, `54.9`; `-` when there is no figure (a missing figure is never shown as 0). */
export function valueText(value: number | null, units: ValueUnits): string {
  if (value === null || !Number.isFinite(value)) return '-';
  const digits =
    units.digits !== null && Number.isInteger(units.digits) && units.digits >= 0
      ? Math.min(units.digits, MAX_DIGITS)
      : DEFAULT_DIGITS;
  const suffix = units.unit === 'percent' ? '%' : (MULTIPLIER_SUFFIX[units.multiplier ?? ''] ?? '');
  return `${fixedText(value, digits)}${suffix}`;
}

/** `+2.1 sigma`, `-0.4 sigma`, `0.0 sigma`: the surprise in standard deviations, one decimal, never `-0.0`. */
export function sigmaText(sigma: number): string {
  const text = fixedText(Math.abs(sigma), 1);
  const rounded = Number(fixedText(sigma, 1));
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  return `${sign}${text} sigma`;
}
