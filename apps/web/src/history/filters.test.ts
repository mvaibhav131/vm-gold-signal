import { describe, expect, it } from 'vitest';

import { DEFAULT_SORT, filtersFromParams, withParam, withSort, withoutFilters } from './filters';

const parse = (query: string, timeZone = 'Asia/Kolkata') =>
  filtersFromParams(new URLSearchParams(query), timeZone);

describe('the filters of the address bar', () => {
  it('start empty', () => {
    const parsed = parse('');
    expect(parsed.filters).toEqual({});
    expect(parsed.active).toBe(0);
    expect(parsed.dateError).toBe(false);
    expect(parsed.values.result).toBe('');
  });

  it('read every choice, the sort and how many filters are set', () => {
    const parsed = parse(
      'result=LOSS&strategy=sweep_reversal&side=SELL&session=LONDON&regime=RANGE&cause=NEWS_SHOCK&grade=Strong&sort=durationS&order=asc',
    );
    expect(parsed.filters).toEqual({
      result: 'LOSS',
      strategy: 'sweep_reversal',
      side: 'SELL',
      session: 'LONDON',
      regime: 'RANGE',
      cause: 'NEWS_SHOCK',
      grade: 'Strong',
      sort: 'durationS',
      order: 'asc',
    });
    expect(parsed.active).toBe(7);
    expect(parsed.values.cause).toBe('NEWS_SHOCK');
  });

  it('ignore a value that is not valid, and a sort that is not a column', () => {
    const parsed = parse('result=MAYBE&side=buy&sort=entry&order=up&grade=Excellent&cause=');
    expect(parsed.filters).toEqual({});
    expect(parsed.active).toBe(0);
    expect(parsed.values.side).toBe('');
  });

  it('turn dates into the start of the day and the end of the day in the display time zone', () => {
    // IST is UTC+5:30: 2026-10-20 starts at 18:30 UTC on the 19th, and the "to" day ends where the next one starts
    const parsed = parse('from=2026-10-20&to=2026-10-22');
    expect(parsed.filters.from).toBe('2026-10-19T18:30:00.000Z');
    expect(parsed.filters.to).toBe('2026-10-22T18:30:00.000Z');
    expect(parsed.active).toBe(2);
    const utc = parse('from=2026-10-20&to=2026-10-20', 'UTC');
    expect(utc.filters).toEqual({
      from: '2026-10-20T00:00:00.000Z',
      to: '2026-10-21T00:00:00.000Z',
    });
  });

  it('keep the day of the display time zone across a month end and a daylight-saving change', () => {
    expect(parse('to=2026-10-31', 'UTC').filters.to).toBe('2026-11-01T00:00:00.000Z');
    // New York leaves daylight saving time on 2026-11-01: that day is 25 hours long
    const newYork = parse('from=2026-11-01&to=2026-11-01', 'America/New_York');
    expect(newYork.filters.from).toBe('2026-11-01T04:00:00.000Z');
    expect(newYork.filters.to).toBe('2026-11-02T05:00:00.000Z');
  });

  it('ignore a date that does not exist', () => {
    expect(parse('from=2026-13-45').filters).toEqual({});
    expect(parse('from=2026-02-30&to=2026-02-31').filters).toEqual({});
    expect(parse('from=yesterday').values.from).toBe('');
  });

  it('apply neither date when the end is before the start, and say so', () => {
    const parsed = parse('from=2026-10-20&to=2026-10-10');
    expect(parsed.dateError).toBe(true);
    expect(parsed.filters).toEqual({});
    expect(parsed.active).toBe(0);
    // the controls still show what was typed, so it can be corrected
    expect(parsed.values.from).toBe('2026-10-20');
    expect(parsed.values.to).toBe('2026-10-10');
  });

  it('accept the same day for both ends', () => {
    expect(parse('from=2026-10-20&to=2026-10-20').dateError).toBe(false);
  });
});

describe('changing the address bar', () => {
  it('sets and removes one value and keeps the others', () => {
    const base = new URLSearchParams('result=LOSS&side=BUY');
    expect(withParam(base, 'strategy', 'trend_pullback').toString()).toBe(
      'result=LOSS&side=BUY&strategy=trend_pullback',
    );
    expect(withParam(base, 'result', null).toString()).toBe('side=BUY');
    expect(withParam(base, 'side', '').toString()).toBe('result=LOSS');
    expect(withParam(base, 'result', 'WIN').toString()).toBe('result=WIN&side=BUY');
    // the original is not changed
    expect(base.toString()).toBe('result=LOSS&side=BUY');
  });

  it('writes a sort, and leaves the default (newest first) out', () => {
    const base = new URLSearchParams('result=LOSS');
    expect(withSort(base, 'realizedRNet', 'asc').toString()).toBe(
      'result=LOSS&sort=realizedRNet&order=asc',
    );
    expect(withSort(base, DEFAULT_SORT.sort, DEFAULT_SORT.order).toString()).toBe('result=LOSS');
    expect(
      withSort(new URLSearchParams('sort=durationS&order=asc'), 'generatedAt', 'desc').toString(),
    ).toBe('');
    expect(
      withSort(new URLSearchParams('sort=durationS&order=asc'), 'generatedAt', 'asc').toString(),
    ).toBe('sort=generatedAt&order=asc');
  });

  it('clears the filters and keeps the sort', () => {
    expect(
      withoutFilters(
        new URLSearchParams('result=LOSS&from=2026-10-01&sort=durationS&order=asc'),
      ).toString(),
    ).toBe('sort=durationS&order=asc');
    expect(withoutFilters(new URLSearchParams('result=LOSS')).toString()).toBe('');
  });
});
