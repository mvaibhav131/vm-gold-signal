import { describe, expect, it } from 'vitest';

import type { TickPoint } from '../calendar/gold';
import { ALERT_WORDS } from '../alerts/words';
import { plain } from '../messages/test-html';
import { marketMoveMessage } from './alerts';
import { classify } from './classifier';
import { frozenHeadline, type HeadlineCluster } from './context';
import { impactSampleOf, moveSince } from './impact';
import { detectMove } from './move';
import { ordinaryWindows, type StatCandle } from './stats';

// Edges that the first tests of each file did not reach: found by changing the code on purpose (B25b mutation check).

const NOW = Date.UTC(2026, 9, 23, 16, 17, 0);
const SEC = 1000;
const MIN = 60_000;

/** A tick `secondsAgo` before now, with this mid price and a spread of 0.2. */
const ago = (secondsAgo: number, mid: number): TickPoint => ({
  ts: NOW - secondsAgo * SEC,
  bid: Math.round((mid - 0.1) * 1000) / 1000,
  ask: Math.round((mid + 0.1) * 1000) / 1000,
});

/** One tick a second from `from` to `to` seconds ago, the mid price going linearly from `start` to `end`. */
function between(from: number, to: number, start: number, end: number): TickPoint[] {
  const ticks: TickPoint[] = [];
  for (let s = from; s >= to; s -= 1) {
    ticks.push(ago(s, from === to ? end : start + ((end - start) * (from - s)) / (from - to)));
  }
  return ticks;
}

describe('the classifier: a keyword is a whole word', () => {
  it('does not find "war" at the end of another word', () => {
    expect(classify({ title: 'Prewar housing boom', tier: 2, ageMs: 0 })).toBeNull();
    expect(classify({ title: 'Pre-war housing boom', tier: 2, ageMs: 0 })?.primary).toBe(
      'GEOPOLITICS_WAR',
    );
  });
});

describe('detectMove: the edges', () => {
  it('counts a tick exactly 5 minutes before the latest one as inside the window', () => {
    // the only low is that tick: 4005 - 3999 = 6 = 2 x ATR(5m)
    const ticks = [ago(300, 3999), ...between(299, 1, 4000, 4000), ago(0, 4005)];
    expect(detectMove(ticks, NOW, 3, null)).toMatchObject({
      kind: 'SPIKE_UP',
      moveUsd: 6,
      windowS: 300,
    });
  });

  it('measures a fall from the latest of equal highs, and a rise from the latest of equal lows', () => {
    const fall = [...between(100, 51, 4000, 4000), ...between(50, 0, 4000, 3994)];
    expect(detectMove(fall, NOW, 3, null)).toMatchObject({
      kind: 'SPIKE_DOWN',
      moveUsd: 6,
      windowS: 50,
    });
    const rise = [...between(100, 51, 4000, 4000), ...between(50, 0, 4000, 4006)];
    expect(detectMove(rise, NOW, 3, null)).toMatchObject({
      kind: 'SPIKE_UP',
      moveUsd: 6,
      windowS: 50,
    });
  });

  it('calls a move up when the rise from the low and the fall from the high are the same', () => {
    // 4000 up to 4010 and back to 4005: 5 up from the low, 5 down from the high
    const ticks = [...between(100, 50, 4000, 4010), ...between(49, 0, 4009.8, 4005)];
    expect(detectMove(ticks, NOW, 2.5, null)).toMatchObject({
      kind: 'SPIKE_UP',
      moveUsd: 5,
      moveAtr: 2,
      windowS: 100,
    });
  });

  it('is not missed by float noise: 0.6 over an ATR of 0.2 is 3 times, though 0.6 / 0.2 is 2.9999999999999996', () => {
    expect(0.6 / 0.2).toBeLessThan(3);
    expect(detectMove(between(40, 0, 4000, 4000.6), NOW, null, 0.2)).toMatchObject({
      basis: '1m',
      moveUsd: 0.6,
      moveAtr: 3,
    });
  });

  it('gives the time from the extreme to the latest tick in whole seconds, rounded', () => {
    const ticks = [{ ...ago(0, 4000), ts: NOW - 4600 }, ago(0, 4010)];
    expect(detectMove(ticks, NOW, 3, null)).toMatchObject({ moveUsd: 10, windowS: 5 });
  });
});

describe('impactSampleOf and moveSince: the edges', () => {
  const AT = Date.UTC(2026, 9, 23, 16, 12, 0);
  const tick = (offset: number, mid: number): TickPoint => ({
    ts: AT + offset * SEC,
    bid: mid - 0.1,
    ask: mid + 0.1,
  });

  it('takes the later of two ticks with the same time as the price at that time', () => {
    const ticks = [tick(0, 4000), tick(0, 4001), tick(600, 4011)];
    expect(impactSampleOf(ticks, AT)).toMatchObject({ move10m: 10 });
  });

  it('leaves a horizon empty when the last tick before it is the one at the time itself', () => {
    // with a tolerance of 200 s that tick is near enough to be the tick at 2 minutes
    expect(impactSampleOf([tick(0, 4000), tick(600, 4010)], AT, 200 * SEC)).toEqual({
      move2m: null,
      move5m: null,
      move10m: 10,
      maxAbs10m: 10,
    });
  });

  it('does not count a tick at the time itself in the excursion that follows', () => {
    const ticks = [tick(0, 3990), tick(0, 4000), tick(600, 4001)];
    expect(impactSampleOf(ticks, AT)).toMatchObject({ move10m: 1, maxAbs10m: 1 });
  });

  it('has no move since the story when the tick at the story and the tick now are the same tick', () => {
    expect(moveSince([tick(-10, 4000)], AT, AT + 5 * SEC, 3)).toBeNull();
    expect(moveSince([tick(-10, 4000), tick(2, 4001)], AT, AT + 5 * SEC, 3)).toMatchObject({
      usd: 1,
    });
  });
});

describe('ordinaryWindows: ten minutes, all of them', () => {
  it('leaves out a window whose last minute is missing', () => {
    const candles: StatCandle[] = Array.from({ length: 10 }, (_, i) => ({
      openTime: NOW - (NOW % (5 * MIN)) + i * MIN,
      o: 4000,
      h: 4000.2,
      l: 3999.8,
      c: 4000,
    })).filter((_, i) => i !== 9);
    expect(ordinaryWindows(candles, () => 2, [])).toEqual([]);
  });
});

describe('MARKET_MOVE: a headline that is said to be classified but has no impact', () => {
  it('is listed as unclassified, and does not break the message', () => {
    const cluster: HeadlineCluster = {
      id: 'x',
      title: 'Odd headline',
      url: 'https://example.com/x',
      sources: [{ key: 'bbc', name: 'BBC News' }],
      topics: [],
      impact: 'LOW',
      publishedAt: NOW - 5 * MIN,
      firstSeenAt: NOW - 4 * MIN,
    };
    const odd = { ...frozenHeadline(cluster), impact: null };
    const message = marketMoveMessage(
      {
        detection: {
          kind: 'SPIKE_UP',
          windowS: 240,
          moveUsd: 9,
          moveAtr: 3,
          basis: '5m',
          atr: 3,
          at: NOW,
        },
        spread: null,
        causes: [{ headline: odd, at: NOW - 5 * MIN }],
        feed: 'AVAILABLE',
        open: [],
      },
      { locale: 'en', displayTz: 'Asia/Kolkata' },
    );
    expect(plain(message.telegram.text)).toContain(
      ALERT_WORDS.en.causeUnclassified(1, 'Odd headline', 'BBC News', '21:42 IST'),
    );
  });
});
