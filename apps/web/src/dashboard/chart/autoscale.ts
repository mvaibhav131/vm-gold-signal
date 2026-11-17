import type { AutoscaleInfoProvider } from 'lightweight-charts';

/**
 * For the lines that are not the price (the averages, the bands, the trendlines, the patterns, the drawings): they do not
 * stretch the price scale. The scale fits the candles, as on a trading platform, and a line that is far from the price just
 * runs off the edge instead of squeezing the candles into a strip.
 */
export const NO_AUTOSCALE: AutoscaleInfoProvider = () => null;
