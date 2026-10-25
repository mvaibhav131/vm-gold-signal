import type { Side } from '../domain';
import { GROUP_STATE_THRESHOLDS } from '../quality';
import { COMPONENT_KEYS, type ComponentKey, type QualityInputs } from '../scoring/groups';
import { qualityComponents } from '../scoring/score';
import { chartStateText, signedTwoText, wholeText } from './facts';
import { atrText, countText, ordinalText, percentText, plainRText, spanText } from './format';
import { SESSION_NAMES } from './names';

/** At most this many weak points go on a signal: the weakest first. */
export const WEAK_LIMIT = 5;

/** What is wrong, in a few words, for one component of the score that is below the "OK" line. */
function weakText(key: ComponentKey, side: Side, inputs: QualityInputs): string {
  const s = side === 'BUY' ? 1 : -1;
  const { trend, structure, trigger, volatility, execution, sessionMacro, reward } = inputs;
  switch (key) {
    case 'emaOrder':
      return 'the 1h EMAs are not all in the order of the trade';
    case 'emaSlope': {
      const slope = trend.ema50SlopeAtr ?? 0;
      if (s * slope > 0)
        return `the 1h EMA 50 slope is shallow (${signedTwoText(slope)} ATR(1h) in 3 h)`;
      return s * slope === 0 ? 'the 1h EMA 50 is flat' : 'the 1h EMA 50 slopes against the trade';
    }
    case 'adx': {
      const against =
        trend.plusDI !== null && trend.minusDI !== null && s * (trend.plusDI - trend.minusDI) < 0;
      return against
        ? 'the 1h DI points against the trade'
        : `ADX(1h) is low (${wholeText(trend.adx ?? 0)})`;
    }
    case 'supertrend':
      return 'the 1h Supertrend is against the trade';
    case 'alignment':
      return `15m and 5m structure do not agree with the trade (${chartStateText(structure.state15m)} / ${chartStateText(structure.state5m)})`;
    case 'breakEvent':
      return 'the latest 5m break is against the trade';
    case 'sweep':
      return 'the sweep is shallow or its wick is short';
    case 'confluence':
      return `few trendlines or zones agree (${countText(structure.confluence ?? 0)})`;
    case 'pattern':
      return `the measured move is small (${plainRText(structure.patternMoveR ?? 0)})`;
    case 'candleSize':
      return `the trigger candle is small (${atrText(trigger.rangeAtr ?? 0)})`;
    case 'closeLocation':
      return `the trigger candle closed far from its extreme (at ${percentText(trigger.closeLocation ?? 0)} of its range)`;
    case 'rsiReset':
      return 'the RSI has barely reset from its pullback extreme';
    case 'macd':
      return 'the MACD histogram does not support the trade';
    case 'atrPercentile': {
      const rank = volatility.atrPercentile ?? 0;
      return `volatility is unusually ${rank < 50 ? 'low' : 'high'} (ATR at the ${ordinalText(rank)} percentile)`;
    }
    case 'squeeze':
      return 'a squeeze is still on';
    case 'spread':
      return `the spread is wide (${ordinalText(execution.spreadPercentile ?? 0)} percentile)`;
    case 'stopSize': {
      const stop = execution.stopAtr ?? 0;
      return `the stop is ${stop < 1.4 ? 'tight' : 'wide'} (${atrText(stop)})`;
    }
    case 'session':
      return `the ${SESSION_NAMES[sessionMacro.session ?? 'ROLLOVER']} session is a weaker time for this trade`;
    case 'news': {
      const news = sessionMacro.news;
      if (news?.state === 'IN_WINDOW') return 'a high-impact event window is open';
      return `a high-impact event is only ${spanText((news?.minutesToNext ?? 0) * 60_000)} away`;
    }
    case 'tp1Distance':
      return `the first target is far (${atrText(reward.tp1Atr ?? 0)})`;
    case 'levelRoom':
      return 'an opposing level sits close to the first target';
  }
}

/**
 * The weak points of a setup (the `weak` list of the explanation): the components of the score that
 * are below the "OK" line, weakest first, at most `WEAK_LIMIT`. Equal ones keep the order of the score.
 */
export function weakItems(side: Side, inputs: QualityInputs): string[] {
  const groups = qualityComponents(side, inputs);
  return Object.values(groups)
    .flat()
    .filter((component) => component.strength < GROUP_STATE_THRESHOLDS.ok)
    .map((component, order) => ({ ...component, order }))
    .sort(
      (a, b) =>
        a.strength - b.strength ||
        COMPONENT_KEYS.indexOf(a.key) - COMPONENT_KEYS.indexOf(b.key) ||
        a.order - b.order,
    )
    .slice(0, WEAK_LIMIT)
    .map((component) => weakText(component.key, side, inputs));
}
