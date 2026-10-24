import { DivergenceTracker } from '../../divergence/tracker';
import type { Regime } from '../../domain';
import { computeSeries } from '../../indicators/types';
import { Atr } from '../../indicators/volatility';
import { StructureTracker } from '../../structure/breaks';
import { displacementOf } from '../../structure/displacement';
import { MarketStructure } from '../../structure/marketStructure';
import { SweepTracker, type SweepReclaim } from '../../structure/sweeps';
import { STRUCTURE_DEFAULTS, type StructureCandle } from '../../structure/types';
import { chooseSweep, judgeSweep, sweepStop } from './rules';
import { FIVE_MS, QUARTER_MS, type Scenario } from './test-data';
import type { SweepCandidate, SweepChecks, SweepInputs, SweepReversalParams } from './types';

export interface ReferenceAnswer {
  readonly checks: SweepChecks;
  readonly stop: number | null;
  readonly sweep: SweepCandidate | null;
  readonly inputs: SweepInputs;
}

/**
 * The BUY answer for 5m candle `index`, worked out from scratch from the candles that had closed
 * by then: whole arrays, fresh primitives for every call, plain loops, no streaming state kept by
 * the strategy. It checks everything that the strategy assembles around the primitives (which
 * have tests of their own): which sweeps are alive, the lowest low since the sweep, the break and
 * the displacement of the newest candle, the 15m change of character and the divergence.
 */
export function reference(
  scene: Scenario,
  params: SweepReversalParams,
  regime: Regime | null,
  index: number,
): ReferenceAnswer {
  const five = scene.five.slice(0, index + 1);
  const newest = five[index];
  if (newest === undefined) throw new Error('no such candle');
  const decision = newest.openTime + FIVE_MS;
  const quarter = scene.quarter.filter((c: StructureCandle) => c.openTime + QUARTER_MS <= decision);
  const lows = scene.levels.filter((level) => level.side === 'LOW');

  const atrs = computeSeries(new Atr(params.atrPeriod), five);
  const sweeps = new SweepTracker();
  const found: SweepReclaim[] = [];
  five.forEach((candle, j) => {
    found.push(...sweeps.update(candle, atrs[j] ?? null, lows));
  });

  const structure = new MarketStructure(STRUCTURE_DEFAULTS, params.atrPeriod);
  const divergence = new DivergenceTracker('5m');
  const divergences = five.flatMap((candle) => {
    structure.update(candle, lows);
    return divergence.update(candle, structure);
  });

  const alive: SweepCandidate[] = found
    .filter((sweep) => sweep.direction === 'UP')
    .map((sweep) => ({
      levelId: sweep.levelId,
      level: sweep.level,
      sweepOpenTime: sweep.sweepOpenTime,
      reclaimOpenTime: sweep.reclaimOpenTime,
      candlesSinceReclaim: index - sweep.reclaimIndex,
      lowest: Math.min(...five.slice(sweep.sweepIndex).map((c) => c.l)),
      depthAtr: sweep.depthAtr,
      wickRatio: sweep.wickRatio,
      divergence: divergences.some(
        (d) =>
          d.source === 'RSI' &&
          d.kind === 'REGULAR' &&
          d.direction === 'UP' &&
          d.second.index >= sweep.sweepIndex &&
          d.second.index <= sweep.reclaimIndex,
      ),
    }));

  const breaks = new StructureTracker();
  let last = breaks.update(five[0] ?? newest);
  for (const candle of five.slice(1)) last = breaks.update(candle);
  const choch = last.breaks.find((b) => b.type === 'CHOCH' && b.direction === 'UP');
  const displacement = displacementOf(newest, atrs[index] ?? null);

  const quarterBreaks = new StructureTracker();
  for (const candle of quarter) quarterBreaks.update(candle);
  const quarterChoch = quarterBreaks.lastChoch;

  const sweep = chooseSweep(alive, params);
  const inputs: SweepInputs = {
    regime,
    sweep,
    chochLevel: choch?.level ?? null,
    displacementAtr: displacement?.direction === 'UP' ? displacement.rangeAtr : null,
    choch15mClosedAt: quarterChoch?.direction === 'UP' ? quarterChoch.openTime + QUARTER_MS : null,
  };
  return {
    checks: judgeSweep(inputs, params),
    stop: sweepStop(sweep?.lowest ?? null, atrs[index] ?? null, params),
    sweep,
    inputs,
  };
}
