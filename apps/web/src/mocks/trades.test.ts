import { bucketStart, CAUSE_CODES, type CauseCode, type Result } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  CHART_CONTEXT_CANDLES,
  FRESH_LOSS_SEQ,
  REVIEW_FINAL_AFTER_MS,
  buildFreshLoss,
  buildTrades,
  detailOfTrade,
  rowOfTrade,
  snapshotOfSignal,
  tradeCandles,
  tradeForWindow,
  type Trade,
} from './trades';

// The preview started on a Friday at 12:00 UTC.
const ANCHOR = Date.parse('2026-10-23T12:00:00Z');
const FAR = ANCHOR + 400 * 86_400_000;
const CANDLE_MS = 300_000;
const trades = buildTrades(ANCHOR);

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture');
  return value;
}

const countBy = <T>(items: readonly T[], key: (item: T) => string) => {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
};

describe('the simulated history', () => {
  it('has the 41 signals of the monthly report example, with every result', () => {
    expect(trades).toHaveLength(41);
    expect(countBy(trades, (t) => t.result)).toEqual({
      WIN: 14,
      PARTIAL_WIN: 6,
      LOSS: 15,
      TIME_EXIT: 4,
      CANCELLED: 1,
      DATA_INVALID: 1,
    } satisfies Record<Result, number>);
    // 39 valid results, 21 of them above zero: the 53.8% of the example
    const valid = trades.filter((t) => t.outcome.countsInStats);
    expect(valid).toHaveLength(39);
    expect(valid.filter((t) => t.outcome.isWin)).toHaveLength(21);
    expect(countBy(valid, (t) => t.signal.strategyKey)).toEqual({
      trend_pullback: 24,
      sweep_reversal: 11,
      squeeze_retest: 4,
    });
    expect(trades.filter((t) => t.outcome.result === 'TIME_EXIT' && t.outcome.isWin)).toHaveLength(
      1,
    );
  });

  it('marks exactly one result as ambiguous (signal 17: stop and target crossed in the same tick)', () => {
    expect(trades.filter((t) => t.outcome.ambiguous).map((t) => t.seq)).toEqual([17]);
  });

  it('has a review with a cause for every result except a win, a cancelled and a data-invalid signal', () => {
    for (const t of trades) {
      const reviewed = !['WIN', 'CANCELLED', 'DATA_INVALID'].includes(t.result);
      expect(t.causes !== null, `seq ${String(t.seq)}`).toBe(reviewed);
    }
    const causes = new Set(trades.flatMap((t) => t.causes?.map((c) => c.code) ?? []));
    expect([...causes].sort()).toEqual([...CAUSE_CODES].sort());
    // a loss with too little follow-through has a maximum favourable excursion under 0.3R (the rule of the cause)
    for (const t of trades.filter((x) => x.causes?.[0]?.code === 'NO_FOLLOW_THROUGH')) {
      expect(t.outcome.mfeR ?? 1).toBeLessThan(0.3);
    }
  });

  it('keeps the signals the dashboard has always listed as finished (39 to 41)', () => {
    const [s39, s40, s41] = [39, 40, 41].map((seq) => trades[seq - 1]);
    expect(s41?.signal).toMatchObject({
      side: 'BUY',
      strategyKey: 'trend_pullback',
      entry: 4009.1,
    });
    expect(s41?.outcome).toMatchObject({ result: 'WIN', realizedRNet: 1.47 });
    expect(s40?.signal).toMatchObject({
      side: 'SELL',
      strategyKey: 'sweep_reversal',
      entry: 4021.6,
    });
    expect(s40?.outcome).toMatchObject({ result: 'LOSS', realizedRNet: -1.04 });
    expect(s39?.signal).toMatchObject({
      side: 'BUY',
      strategyKey: 'squeeze_retest',
      entry: 4004.3,
    });
    expect(s39?.outcome).toMatchObject({ result: 'PARTIAL_WIN', realizedRNet: 0.47 });
    expect(Date.parse(s41?.signal.generatedAt ?? '')).toBe(ANCHOR - 3 * 3_600_000);
    expect(Date.parse(s40?.signal.generatedAt ?? '')).toBe(ANCHOR - 30 * 3_600_000);
    expect(Date.parse(s39?.signal.generatedAt ?? '')).toBe(ANCHOR - 52 * 3_600_000);
  });

  it('spreads the signals over about three months on weekdays, far enough apart that their chart windows never overlap', () => {
    const times = trades.map((t) => t.generatedMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const days = (ANCHOR - (times[0] ?? 0)) / 86_400_000;
    expect(days).toBeGreaterThan(70);
    expect(days).toBeLessThan(120);
    for (const t of trades.slice(0, 38)) {
      const day = new Date(t.generatedMs).getUTCDay();
      expect([0, 6], `seq ${String(t.seq)}`).not.toContain(day);
    }
    for (let i = 1; i < trades.length; i += 1) {
      const a = trades[i - 1];
      const b = trades[i];
      if (!a || !b) continue;
      const windowEnd = bucketStart('5m', a.closedMs) + (CHART_CONTEXT_CANDLES + 1) * CANDLE_MS;
      const windowStart = bucketStart('5m', b.generatedMs) - CHART_CONTEXT_CANDLES * CANDLE_MS;
      expect(windowEnd, `seq ${String(a.seq)} and ${String(b.seq)}`).toBeLessThanOrEqual(
        windowStart,
      );
    }
  });

  it('is the same on every run for the same anchor', () => {
    expect(JSON.stringify(buildTrades(ANCHOR))).toBe(JSON.stringify(trades));
  });

  it('gives every signal a valid grade, and shows the sweep reversals as weak against the 1h trend', () => {
    for (const t of trades)
      expect(t.signal.qualityScore, `seq ${String(t.seq)}`).toBeGreaterThanOrEqual(65);
    const sweep = trades.find((t) => t.signal.strategyKey === 'sweep_reversal');
    expect(sweep?.weakGroups.map((g) => g.group)).toContain('trend');
    expect(sweep?.signal.explanation.weak.length).toBeGreaterThan(0);
  });
});

describe('what the API says about a finished signal over time', () => {
  const loss = must(trades[39]); // seq 40: a loss with NO_FOLLOW_THROUGH, closed long ago

  it('has a preliminary review at the close and a final one 60 minutes later, with the counterfactual only in the final one', () => {
    const fresh = buildFreshLoss(ANCHOR);
    expect(fresh.seq).toBe(FRESH_LOSS_SEQ);
    // closed 35 minutes before the anchor: preliminary now, final 25 minutes later
    expect(fresh.closedMs).toBe(ANCHOR - 35 * 60_000);
    const early = detailOfTrade(fresh, ANCHOR);
    expect(early.autopsy).toMatchObject({
      status: 'PRELIMINARY',
      counterfactual: null,
      finalizedAt: null,
    });
    expect(early.events.map((e) => e.eventType)).toEqual([
      'CREATED',
      'ALERT_QUEUED',
      'SL_HIT',
      'AUTOPSY_PRELIMINARY',
    ]);
    expect(rowOfTrade(fresh, ANCHOR).autopsyStatus).toBe('PRELIMINARY');

    const justBefore = fresh.closedMs + REVIEW_FINAL_AFTER_MS - 1;
    expect(detailOfTrade(fresh, justBefore).autopsy?.status).toBe('PRELIMINARY');
    const late = detailOfTrade(fresh, fresh.closedMs + REVIEW_FINAL_AFTER_MS);
    expect(late.autopsy).toMatchObject({ status: 'FINAL' });
    expect(late.autopsy?.counterfactual).toMatchObject({ reachedTp1: false, candlesToTp1: null });
    expect(late.autopsy?.finalizedAt).toBe(
      new Date(fresh.closedMs + REVIEW_FINAL_AFTER_MS).toISOString(),
    );
    expect(late.events.map((e) => e.eventType).at(-1)).toBe('AUTOPSY_FINAL');
    expect(rowOfTrade(fresh, late.autopsy ? ANCHOR + 3_600_000 : ANCHOR).autopsyStatus).toBe(
      'FINAL',
    );
  });

  it('lists the events of every trade in time order and in the order of the story', () => {
    for (const t of trades) {
      const detail = detailOfTrade(t, FAR);
      const times = detail.events.map((e) => Date.parse(e.eventAt));
      expect(
        [...times].sort((a, b) => a - b),
        `seq ${String(t.seq)}`,
      ).toEqual(times);
      const types = detail.events.map((e) => e.eventType);
      expect(types.slice(0, 2)).toEqual(['CREATED', 'ALERT_QUEUED']);
      const exit: Partial<Record<Result, string>> = {
        WIN: 'TP2_HIT',
        PARTIAL_WIN: 'SL_HIT',
        LOSS: 'SL_HIT',
        TIME_EXIT: 'TIME_EXIT',
        CANCELLED: 'CANCELLED',
        DATA_INVALID: 'DATA_INVALID',
      };
      expect(types).toContain(exit[t.result]);
      expect(types.includes('TP1_HIT'), `seq ${String(t.seq)}`).toBe(
        t.result === 'WIN' || t.result === 'PARTIAL_WIN',
      );
      if (types.includes('TP1_HIT')) {
        expect(types.indexOf('STOP_MOVED_TO_ENTRY')).toBe(types.indexOf('TP1_HIT') + 1);
      }
    }
  });

  it('gives a loss its review with the numbers behind the cause, the weak groups and a counterfactual', () => {
    const detail = detailOfTrade(loss, FAR);
    expect(detail.state).toBeNull();
    expect(detail.outcome).toMatchObject({ result: 'LOSS', exitReason: 'SL', realizedRNet: -1.04 });
    expect(detail.autopsy?.primaryCause).toBe('NO_FOLLOW_THROUGH');
    expect(detail.autopsy?.causes[0]?.evidence).toMatchObject({ limitR: 0.3 });
    expect(detail.autopsy?.weakGroupsAtEntry.map((g) => g.group)).toContain('trigger');
    expect(detail.autopsy?.counterfactual).not.toBeNull();
  });

  it('marks the oldest snapshot as removed by retention, and no other', () => {
    expect(
      trades.filter((t) => !detailOfTrade(t, FAR).snapshotAvailable).map((t) => t.seq),
    ).toEqual([1]);
    expect(snapshotOfSignal(must(trades[0]).signal, true)).toBeNull();
    const snapshot = snapshotOfSignal(must(trades[1]).signal, false);
    expect(snapshot?.signalId).toBe(must(trades[1]).signal.id);
    expect(snapshot?.features).toHaveProperty('indicators');
  });

  it('describes the cancelled and the data-invalid signal without a result in R and without a review', () => {
    for (const result of ['CANCELLED', 'DATA_INVALID'] as const) {
      const t = must(trades.find((x) => x.result === result));
      const detail = detailOfTrade(t, FAR);
      expect(detail.autopsy).toBeNull();
      expect(detail.outcome).toMatchObject({
        countsInStats: false,
        realizedRNet: null,
        exitPrice: null,
      });
      expect(rowOfTrade(t, FAR).primaryCause).toBeNull();
    }
  });
});

describe('the chart around a trade', () => {
  const dirOf = (t: Trade) => (t.signal.side === 'BUY' ? 1 : -1);
  /** The highest and lowest point of a candle in R (entry 0, stop -1, TP1 +1, TP2 +2). */
  const rOf = (t: Trade, price: number) =>
    (dirOf(t) * (price - t.signal.entry)) / t.signal.riskDistance;
  const span = (t: Trade, candle: { h: number; l: number }) => {
    const a = rOf(t, candle.h);
    const b = rOf(t, candle.l);
    return { hi: Math.max(a, b), lo: Math.min(a, b) };
  };

  it('has 60 candles before the signal and 60 after the exit, on the 5-minute grid, all well formed', () => {
    for (const t of trades) {
      const candles = tradeCandles(t, FAR);
      const missing = t.result === 'DATA_INVALID' ? 2 : 0;
      const first = bucketStart('5m', t.generatedMs) - CHART_CONTEXT_CANDLES * CANDLE_MS;
      const last = bucketStart('5m', t.closedMs) + CHART_CONTEXT_CANDLES * CANDLE_MS;
      expect(candles.length, `seq ${String(t.seq)}`).toBe((last - first) / CANDLE_MS + 1 - missing);
      expect(Date.parse(candles[0]?.t ?? '')).toBe(first);
      expect(Date.parse(candles.at(-1)?.t ?? '')).toBe(last);
      for (const c of candles) {
        expect(c.h, `seq ${String(t.seq)}`).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
        expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
        expect(c.l).toBeGreaterThan(0);
        expect(Date.parse(c.t) % CANDLE_MS).toBe(0);
      }
    }
  });

  it('leaves a hole in the data of the signal that was marked data invalid', () => {
    const t = must(trades.find((x) => x.result === 'DATA_INVALID'));
    const times = tradeCandles(t, FAR).map((c) => Date.parse(c.t));
    const gaps = times.slice(1).filter((ms, i) => ms - (times[i] ?? 0) > CANDLE_MS);
    expect(gaps).toHaveLength(1);
  });

  it('touches each level only at the event that the result tells about', () => {
    for (const t of trades) {
      if (t.result === 'CANCELLED' || t.result === 'DATA_INVALID') continue;
      const candles = tradeCandles(t, FAR);
      const genCandle = bucketStart('5m', t.generatedMs);
      const exitCandle = bucketStart('5m', t.closedMs);
      const tp1Candle = t.tp1Ms === null ? null : bucketStart('5m', t.tp1Ms);
      const tag = `seq ${String(t.seq)} ${t.result}`;
      for (const c of candles) {
        const start = Date.parse(c.t);
        if (start < genCandle || start > exitCandle) continue;
        const { hi, lo } = span(t, c);
        const exiting = start === exitCandle;
        const hitTp1 = tp1Candle !== null && start >= tp1Candle;
        // TP1 is first reached by the candle of the TP1 event
        if (!hitTp1) expect(hi, tag).toBeLessThan(1);
        if (start === tp1Candle) expect(hi, tag).toBeCloseTo(1, 2);
        // TP2 is reached only by the exit candle of a win
        if (!(exiting && t.result === 'WIN')) expect(hi, tag).toBeLessThan(2);
        if (exiting && t.result === 'WIN') expect(hi, tag).toBeCloseTo(2, 2);
        // the stop: -1 before TP1, entry after it
        const stopR = hitTp1 && start !== tp1Candle ? 0 : -1;
        if (!exiting) expect(lo, tag).toBeGreaterThan(stopR - 0.0001);
        if (exiting && t.result === 'LOSS') expect(lo, tag).toBeCloseTo(-1, 2);
        if (exiting && t.result === 'PARTIAL_WIN') expect(lo, tag).toBeCloseTo(0, 2);
        if (exiting && t.result === 'WIN') expect(lo, tag).toBeGreaterThan(-0.0001);
      }
    }
  });

  it('shows what the final review says about the hour after the close', () => {
    for (const t of trades) {
      if (t.causes === null) continue;
      const exitCandle = bucketStart('5m', t.closedMs);
      const after = tradeCandles(t, FAR).filter((c) => {
        const start = Date.parse(c.t);
        return start > exitCandle && start <= exitCandle + 12 * CANDLE_MS;
      });
      const reached = after.findIndex((c) => span(t, c).hi >= 1 - 0.0001);
      const tag = `seq ${String(t.seq)} ${t.result}`;
      if (t.candlesToTp1After === null) {
        // a win ended above TP1 long ago; for the others TP1 is not reached within the hour
        if (t.result !== 'WIN') expect(reached, tag).toBe(-1);
      } else {
        expect(reached + 1, tag).toBe(t.candlesToTp1After);
      }
    }
  });

  it('shows only closed candles: nothing after the current time', () => {
    const t = must(trades[40]); // seq 41 closed 2 h 14 min before the anchor
    const candles = tradeCandles(t, ANCHOR);
    const last = Date.parse(candles.at(-1)?.t ?? '');
    expect(last + CANDLE_MS).toBeLessThanOrEqual(ANCHOR);
    expect(last + CANDLE_MS).toBeGreaterThan(ANCHOR - CANDLE_MS);
  });

  it('finds the trade for a chart window and nothing for other times', () => {
    const t = must(trades[10]);
    const end = bucketStart('5m', t.closedMs) + (CHART_CONTEXT_CANDLES + 1) * CANDLE_MS;
    expect(tradeForWindow(trades, end)?.seq).toBe(t.seq);
    expect(tradeForWindow(trades, t.generatedMs + 60_000)?.seq).toBe(t.seq);
    expect(tradeForWindow(trades, end + 24 * 3_600_000)).toBeUndefined();
    expect(tradeForWindow(trades, ANCHOR + 86_400_000)).toBeUndefined();
  });

  it('draws the story of each result: a win ends at TP2, a loss at the stop', () => {
    for (const result of ['WIN', 'LOSS'] as const) {
      const t = must(trades.find((x) => x.result === result && x.seq > 1));
      const exitCandle = bucketStart('5m', t.closedMs);
      const candle = tradeCandles(t, FAR).find((c) => Date.parse(c.t) === exitCandle);
      const price = result === 'WIN' ? t.signal.tp2 : t.signal.stopLoss;
      expect(candle).toBeDefined();
      expect(Math.abs(rOf(t, candle?.c ?? 0) - (result === 'WIN' ? 2 : -1))).toBeLessThan(0.01);
      expect([candle?.h, candle?.l]).toContain(price);
    }
  });
});

describe('causes', () => {
  it('lists the cause codes that a loss can have', () => {
    const codes: CauseCode[] = trades.flatMap((t) =>
      t.result === 'LOSS' ? [t.causes?.[0]?.code ?? 'NORMAL_LOSS'] : [],
    );
    expect(countBy(codes, (c) => c)).toMatchObject({
      NORMAL_LOSS: 5,
      NO_FOLLOW_THROUGH: 3,
      HTF_STRUCTURE_BREAK: 2,
      NEWS_SHOCK: 2,
      STOP_HUNT_REVERSAL: 2,
      REGIME_SHIFT: 1,
    });
  });
});
