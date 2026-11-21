import { describe, expect, it } from 'vitest';

import { distanceNote, styleOf } from './tradeStyle';

const T = '2026-11-23T10:00:00.000Z';
const after = (minutes: number): string => new Date(Date.parse(T) + minutes * 60_000).toISOString();

describe('the style of a trade on the screen', () => {
  it('names the style from the time stop, with the longest time the trade may take', () => {
    expect(styleOf({ generatedAt: T, timeStopAt: after(30) })).toEqual({
      style: 'SCALP',
      holdText: '30 min',
      label: 'SCALP, up to 30 min',
    });
    expect(styleOf({ generatedAt: T, timeStopAt: after(120) }).label).toBe('INTRADAY, up to 2 h');
    expect(styleOf({ generatedAt: T, timeStopAt: after(600) }).label).toBe('SWING, up to 10 h');
  });

  it('is the same rule as the Telegram message: 45 minutes and 6 hours are the edges', () => {
    expect(styleOf({ generatedAt: T, timeStopAt: after(45) }).style).toBe('SCALP');
    expect(styleOf({ generatedAt: T, timeStopAt: after(46) }).style).toBe('INTRADAY');
    expect(styleOf({ generatedAt: T, timeStopAt: after(360) }).style).toBe('INTRADAY');
    expect(styleOf({ generatedAt: T, timeStopAt: after(361) }).style).toBe('SWING');
  });
});

describe('the distance of a target', () => {
  it('is in dollars with 3 decimals and in times the risk with one, the same for a SELL', () => {
    expect(distanceNote(4017.37, 4023.84, 6.47)).toBe('6.470 USD, 1.0R');
    expect(distanceNote(4017.37, 4030.31, 6.47)).toBe('12.940 USD, 2.0R');
    expect(distanceNote(3982.63, 3969.69, 6.47)).toBe('12.940 USD, 2.0R');
    expect(distanceNote(4017, 4026, 6.76)).toBe('9.000 USD, 1.3R');
  });
});
