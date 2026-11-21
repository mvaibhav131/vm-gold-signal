import { describe, expect, it } from 'vitest';

import { nextMarketClose, tradingDayStart } from './marketHours';

const utc = (iso: string): number => Date.parse(iso);

describe('nextMarketClose', () => {
  it('is 22:00 UTC in winter and 21:00 UTC in summer (17:00 in New York)', () => {
    expect(nextMarketClose(utc('2026-11-18T10:00:00Z'))).toBe(utc('2026-11-18T22:00:00Z'));
    expect(nextMarketClose(utc('2026-07-14T10:00:00Z'))).toBe(utc('2026-07-14T21:00:00Z'));
  });

  it('is the close of the next day once today has closed, and never the instant itself', () => {
    expect(nextMarketClose(utc('2026-11-18T22:00:00Z') - 1)).toBe(utc('2026-11-18T22:00:00Z'));
    expect(nextMarketClose(utc('2026-11-18T22:00:00Z'))).toBe(utc('2026-11-19T22:00:00Z'));
    expect(nextMarketClose(utc('2026-11-18T23:30:00Z'))).toBe(utc('2026-11-19T22:00:00Z'));
  });

  it('skips the weekend: from Friday 17:00 the next close is on Monday', () => {
    // Friday 20 November 2026
    expect(nextMarketClose(utc('2026-11-20T21:59:00Z'))).toBe(utc('2026-11-20T22:00:00Z'));
    expect(nextMarketClose(utc('2026-11-20T22:30:00Z'))).toBe(utc('2026-11-23T22:00:00Z'));
    expect(nextMarketClose(utc('2026-11-21T11:00:00Z'))).toBe(utc('2026-11-23T22:00:00Z')); // Saturday
    expect(nextMarketClose(utc('2026-11-22T23:30:00Z'))).toBe(utc('2026-11-23T22:00:00Z')); // Sunday night, market open
  });

  it('follows the day the clocks of New York change (the close moves by an hour in UTC, not in New York)', () => {
    // in 2026 the clocks go back on Sunday 1 November: Friday 30 October closes at 21:00 UTC, Monday 2 November at 22:00 UTC
    expect(nextMarketClose(utc('2026-10-30T10:00:00Z'))).toBe(utc('2026-10-30T21:00:00Z'));
    expect(nextMarketClose(utc('2026-10-30T21:30:00Z'))).toBe(utc('2026-11-02T22:00:00Z'));
    // and forward on Sunday 8 March: Friday 6 March closes at 22:00 UTC, Monday 9 March at 21:00 UTC
    expect(nextMarketClose(utc('2026-03-06T10:00:00Z'))).toBe(utc('2026-03-06T22:00:00Z'));
    expect(nextMarketClose(utc('2026-03-06T22:30:00Z'))).toBe(utc('2026-03-09T21:00:00Z'));
  });
});

describe('tradingDayStart', () => {
  it('is the close before it: the day runs from 17:00 New York to 17:00 New York', () => {
    expect(tradingDayStart(utc('2026-11-18T10:00:00Z'))).toBe(utc('2026-11-17T22:00:00Z'));
    expect(tradingDayStart(utc('2026-11-18T21:59:00Z'))).toBe(utc('2026-11-17T22:00:00Z'));
    // the hours after the daily break belong to the day that follows it
    expect(tradingDayStart(utc('2026-11-18T23:30:00Z'))).toBe(utc('2026-11-18T22:00:00Z'));
  });

  it('is the close itself at the instant of the close, and never later than the time given', () => {
    expect(tradingDayStart(utc('2026-11-18T22:00:00Z'))).toBe(utc('2026-11-18T22:00:00Z'));
    expect(tradingDayStart(utc('2026-11-18T22:00:00Z') - 1)).toBe(utc('2026-11-17T22:00:00Z'));
  });

  it('is the Friday close for the weekend and for the Sunday opening', () => {
    expect(tradingDayStart(utc('2026-11-21T11:00:00Z'))).toBe(utc('2026-11-20T22:00:00Z'));
    expect(tradingDayStart(utc('2026-11-22T23:30:00Z'))).toBe(utc('2026-11-20T22:00:00Z'));
    expect(tradingDayStart(utc('2026-11-23T10:00:00Z'))).toBe(utc('2026-11-20T22:00:00Z'));
  });

  it('follows the clocks of New York', () => {
    expect(tradingDayStart(utc('2026-11-02T10:00:00Z'))).toBe(utc('2026-10-30T21:00:00Z'));
    expect(tradingDayStart(utc('2026-03-09T10:00:00Z'))).toBe(utc('2026-03-06T22:00:00Z'));
  });
});
