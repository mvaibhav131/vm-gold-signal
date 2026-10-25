import {
  COURSE_CANDLE_MS,
  type CourseCandle,
  type ReviewedTrade,
  type TradeOutcome,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { MemoryLifecycleStore } from '../testing/memoryLifecycleStore';
import { DatabaseCourseSource, NO_CONTEXT, type ContextSource } from './course';
import { FILL_AT, MINUTE } from './test-data';

const trade: ReviewedTrade = {
  side: 'BUY',
  fill: 4017.37,
  fillAt: FILL_AT,
  riskDistance: 6.47,
  tp1: 4023.84,
  tp2: 4030.31,
  atr5: 4.3,
  spreadAtEntry: 0.12,
  slippageUsd: 0.05,
  regime: 'TREND_UP',
  groups: [],
};

const outcome = (closedAt: number): TradeOutcome => ({
  result: 'LOSS',
  countsInStats: true,
  closedAt,
  exitPrice: 4010.9,
  exitReason: 'STOP',
  realizedRGross: -1,
  costR: 0,
  realizedRNet: -1,
  durationS: 0,
  mfeR: 0,
  maeR: -1,
  tp1Hit: false,
  tp2Hit: false,
  ambiguous: false,
  isWin: false,
});

const FIRST = FILL_AT - 320 * COURSE_CANDLE_MS;
const candle = (index: number, range: number): CourseCandle => ({
  openTime: FIRST + index * COURSE_CANDLE_MS,
  o: 4000,
  h: 4000 + range / 2,
  l: 4000 - range / 2,
  c: 4000,
});

/** 320 calm candles (true range 2) up to the one that opens at the fill, then wild ones. */
function candles(wild: readonly number[]): CourseCandle[] {
  const calm = Array.from({ length: 321 }, (_unused, i) => candle(i, 2));
  const afterwards = wild.map((range, i) => candle(321 + i, range));
  return [...calm, ...afterwards];
}

describe('DatabaseCourseSource: what happened while the trade was open, from what is stored', () => {
  it('takes the HIGH-impact events and headlines inside the trade, both ends included', async () => {
    const store = new MemoryLifecycleStore();
    const closedAt = FILL_AT + 30 * MINUTE;
    store.highImpactItems = [
      { kind: 'EVENT', name: 'before', at: FILL_AT - 1 },
      { kind: 'EVENT', name: 'at the fill', at: FILL_AT },
      { kind: 'HEADLINE', name: 'inside', at: FILL_AT + 10 * MINUTE },
      { kind: 'EVENT', name: 'at the close', at: closedAt },
      { kind: 'EVENT', name: 'after', at: closedAt + 1 },
    ];
    const course = await new DatabaseCourseSource(store).courseOf(trade, outcome(closedAt));
    expect(course.highImpact.map((item) => item.name)).toEqual([
      'at the fill',
      'inside',
      'at the close',
    ]);
  });

  it('has no regime and no structure break without a context, and takes them from the context when there is one', async () => {
    const store = new MemoryLifecycleStore();
    const none = await new DatabaseCourseSource(store).courseOf(trade, outcome(FILL_AT + MINUTE));
    expect(none).toEqual({
      regimeAtClose: null,
      structureBreaks: [],
      highImpact: [],
      atrRatioMax: null,
    });
    expect(await NO_CONTEXT.contextOf(trade, FILL_AT)).toEqual({
      regimeAtClose: null,
      structureBreaks: [],
    });

    const seen: number[] = [];
    const context: ContextSource = {
      contextOf: (given, closedAt) => {
        seen.push(closedAt, given.fillAt);
        return Promise.resolve({
          regimeAtClose: 'RANGE',
          structureBreaks: [{ tf: '15m', direction: 'DOWN', at: FILL_AT + MINUTE, level: 4012.1 }],
        });
      },
    };
    const closedAt = FILL_AT + 20 * MINUTE;
    const course = await new DatabaseCourseSource(store, context).courseOf(
      trade,
      outcome(closedAt),
    );
    expect(course.regimeAtClose).toBe('RANGE');
    expect(course.structureBreaks).toHaveLength(1);
    expect(seen).toEqual([closedAt, FILL_AT]);
  });

  it('computes the highest ATR over its median from the candles that ended before the exit', async () => {
    const store = new MemoryLifecycleStore();
    // the candle that holds the fill is index 321; three wild candles follow it
    store.candles = candles([20, 20, 20]);
    // the exit is inside candle 322, so candle 321 (the fill) has ended and 322 has not
    const closedAt = FIRST + 322 * COURSE_CANDLE_MS + 2 * MINUTE;
    const fillAt = FIRST + 321 * COURSE_CANDLE_MS + MINUTE;
    const course = await new DatabaseCourseSource(store).courseOf(
      { ...trade, fillAt },
      outcome(closedAt),
    );
    // only candle 321 counts: the ATR after its first wild range of 20 over a median of 2
    expect(course.atrRatioMax).toBeCloseTo((2 * 13 + 20) / 14 / 2, 9);
  });

  it('gives the preliminary and the final review the same market: later candles change nothing', async () => {
    const store = new MemoryLifecycleStore();
    store.candles = candles([20, 20, 20]);
    const closedAt = FIRST + 322 * COURSE_CANDLE_MS + 2 * MINUTE;
    const fillAt = FIRST + 321 * COURSE_CANDLE_MS + MINUTE;
    const source = new DatabaseCourseSource(store);
    const atClose = await source.courseOf({ ...trade, fillAt }, outcome(closedAt));
    store.candles = [...store.candles, candle(324, 40), candle(325, 40)];
    const later = await source.courseOf({ ...trade, fillAt }, outcome(closedAt));
    expect(later).toEqual(atClose);
  });

  it('does not know the ATR ratio without enough candles before the trade', async () => {
    const store = new MemoryLifecycleStore();
    store.candles = candles([20]).slice(200);
    const course = await new DatabaseCourseSource(store).courseOf(
      { ...trade, fillAt: FIRST + 321 * COURSE_CANDLE_MS + MINUTE },
      outcome(FIRST + 323 * COURSE_CANDLE_MS),
    );
    expect(course.atrRatioMax).toBeNull();
  });
});
