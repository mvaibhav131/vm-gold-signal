import { describe, expect, it } from 'vitest';

import {
  candleRefetchDelayMs,
  formatCountdown,
  formingStep,
  msToNextCandle,
  serverClockOffsetMs,
} from './forming';

const MIN = 60_000;
// 2026-11-16 10:07:30 UTC: inside the 5m candle that opened at 10:05:00
const AT = Date.UTC(2026, 10, 16, 10, 7, 30);
const START_5M = Date.UTC(2026, 10, 16, 10, 5, 0);

describe('formingStep', () => {
  it('opens at the close of the last closed candle when that is the candle just before', () => {
    const forming = formingStep(null, '5m', AT, 4018.2, { startMs: START_5M - 5 * MIN, c: 4017.9 });
    expect(forming).toEqual({ startMs: START_5M, o: 4017.9, h: 4018.2, l: 4017.9, c: 4018.2 });
  });

  it('opens at the first quote seen when the last closed candle is older (the page was opened late or there is a gap)', () => {
    const forming = formingStep(null, '5m', AT, 4018.2, {
      startMs: START_5M - 20 * MIN,
      c: 4017.9,
    });
    expect(forming).toEqual({ startMs: START_5M, o: 4018.2, h: 4018.2, l: 4018.2, c: 4018.2 });
    expect(formingStep(null, '5m', AT, 4018.2, null).o).toBe(4018.2);
  });

  it('a quote inside the candle moves the high, the low and the close and keeps the open', () => {
    let forming = formingStep(null, '5m', AT, 4018.2, null);
    forming = formingStep(forming, '5m', AT + 10_000, 4019.5, null);
    forming = formingStep(forming, '5m', AT + 20_000, 4017.1, null);
    forming = formingStep(forming, '5m', AT + 30_000, 4017.8, null);
    expect(forming).toEqual({ startMs: START_5M, o: 4018.2, h: 4019.5, l: 4017.1, c: 4017.8 });
  });

  it('the first quote of the next candle starts a new one that opens at the last price of the one before', () => {
    let forming = formingStep(null, '5m', AT, 4018.2, null);
    forming = formingStep(forming, '5m', AT + 100_000, 4019.0, null);
    const next = formingStep(forming, '5m', START_5M + 5 * MIN + 1000, 4019.4, null);
    expect(next).toEqual({
      startMs: START_5M + 5 * MIN,
      o: 4019.0,
      h: 4019.4,
      l: 4019.0,
      c: 4019.4,
    });
  });

  it('after a gap of whole candles the new candle opens at its own first price', () => {
    const forming = formingStep(null, '5m', AT, 4018.2, null);
    const later = formingStep(forming, '5m', START_5M + 30 * MIN + 1000, 4025, null);
    expect(later).toMatchObject({ startMs: START_5M + 30 * MIN, o: 4025, h: 4025, l: 4025 });
  });

  it('a quote older than the candle in hand changes nothing', () => {
    const forming = formingStep(null, '5m', AT, 4018.2, null);
    expect(formingStep(forming, '5m', AT - 10 * MIN, 3000, null)).toBe(forming);
  });

  it('follows the size of every timeframe', () => {
    const hour = Date.UTC(2026, 10, 16, 10, 0, 0);
    expect(formingStep(null, '1h', AT, 1, null).startMs).toBe(hour);
    expect(formingStep(null, '4h', AT, 1, null).startMs).toBe(Date.UTC(2026, 10, 16, 8, 0, 0));
    expect(formingStep(null, '1m', AT, 1, null).startMs).toBe(Date.UTC(2026, 10, 16, 10, 7, 0));
    expect(formingStep(null, '15m', AT, 1, null).startMs).toBe(Date.UTC(2026, 10, 16, 10, 0, 0));
  });
});

describe('serverClockOffsetMs', () => {
  const snapshot = { receivedAt: '2026-11-16T10:07:29.000Z', ageMs: 1000 };

  it('is the server time of the snapshot minus the time at which this PC fetched it', () => {
    // the server says "10:07:30 now"; this PC's clock said 10:06:30 when the answer came: the PC is a minute behind
    expect(serverClockOffsetMs(snapshot, Date.UTC(2026, 10, 16, 10, 6, 30))).toBe(60_000);
    expect(serverClockOffsetMs(snapshot, Date.UTC(2026, 10, 16, 10, 8, 30))).toBe(-60_000);
    expect(serverClockOffsetMs(snapshot, Date.UTC(2026, 10, 16, 10, 7, 30))).toBe(0);
  });

  it('is 0 without a snapshot, without a fetch time or with a time that does not parse', () => {
    expect(serverClockOffsetMs(undefined, AT)).toBe(0);
    expect(serverClockOffsetMs(snapshot, 0)).toBe(0);
    expect(serverClockOffsetMs({ receivedAt: 'nonsense', ageMs: 5 }, AT)).toBe(0);
  });
});

describe('formatCountdown', () => {
  it('shows minutes and seconds, and hours only from one hour on', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(4000)).toBe('00:04');
    expect(formatCountdown(2 * MIN + 30_000)).toBe('02:30');
    expect(formatCountdown(59 * MIN + 59_000)).toBe('59:59');
    expect(formatCountdown(60 * MIN)).toBe('1:00:00');
    expect(formatCountdown(3 * 60 * MIN + 5 * MIN + 9000)).toBe('3:05:09');
  });

  it('rounds up to the second and never goes below zero', () => {
    expect(formatCountdown(1)).toBe('00:01');
    expect(formatCountdown(59_001)).toBe('01:00');
    expect(formatCountdown(-500)).toBe('00:00');
  });
});

describe('when to ask for the candles again', () => {
  it('counts the time to the next candle', () => {
    expect(msToNextCandle('5m', AT)).toBe(2 * MIN + 30_000);
    expect(msToNextCandle('1m', AT)).toBe(30_000);
    expect(msToNextCandle('1h', AT)).toBe(52 * MIN + 30_000);
  });

  it('waits for the close plus 4 seconds, never less than 5 seconds and never more than 5 minutes', () => {
    expect(candleRefetchDelayMs('1m', AT)).toBe(34_000);
    expect(candleRefetchDelayMs('5m', AT)).toBe(2 * MIN + 34_000);
    // 100 ms before the close: the wait is the 4 s after it, but at least 5 s
    expect(candleRefetchDelayMs('1m', START_5M + 59_900)).toBe(5000);
    expect(candleRefetchDelayMs('4h', AT)).toBe(300_000);
  });
});
