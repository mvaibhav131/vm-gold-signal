import { describe, expect, it } from 'vitest';

import {
  HISTDATA_UTC_OFFSET_MS,
  PRICE_BOUNDS,
  parseBarLine,
  parseTickLine,
  type Parsed,
  type RejectReason,
} from './format';

const bar = (line: string) => parseBarLine(line);
const tick = (line: string) => parseTickLine(line);
const reason = (parsed: Parsed<unknown> | null): RejectReason | 'OK' | 'BLANK' => {
  if (parsed === null) return 'BLANK';
  return parsed.ok ? 'OK' : parsed.reason;
};

describe('the time of HistData: UTC-5 all year, no daylight saving', () => {
  it('is five hours behind UTC in winter', () => {
    const parsed = bar('20230102 180000;1823.39;1824.25;1823.39;1824.25;0');
    expect(parsed?.ok && parsed.value.ts).toBe(Date.UTC(2023, 0, 2, 23, 0, 0));
  });

  it('is five hours behind UTC in summer too, when New York is only four behind', () => {
    const parsed = bar('20230703 120000;1900.1;1900.2;1900;1900.15;0');
    expect(parsed?.ok && parsed.value.ts).toBe(Date.UTC(2023, 6, 3, 17, 0, 0));
    expect(HISTDATA_UTC_OFFSET_MS).toBe(5 * 3_600_000);
  });

  it('rolls into the next UTC day and year when the stamp is late in the evening', () => {
    const parsed = bar('20221231 235900;1800;1801;1799;1800.5;0');
    expect(parsed?.ok && parsed.value.ts).toBe(Date.UTC(2023, 0, 1, 4, 59, 0));
  });

  it('keeps the milliseconds of a tick', () => {
    const parsed = tick('20230102 180000123,1823.39,1824.25,0');
    expect(parsed?.ok && parsed.value.ts).toBe(Date.UTC(2023, 0, 2, 23, 0, 0, 123));
  });
});

describe('an M1 line', () => {
  it('gives the bid prices of the minute, whatever the number of decimals of the file', () => {
    expect(bar('20230102 180000;1823.390000;1824.250000;1823.390000;1824.250000;0')).toEqual({
      ok: true,
      value: { ts: Date.UTC(2023, 0, 2, 23), o: 1823.39, h: 1824.25, l: 1823.39, c: 1824.25 },
    });
  });

  it('rounds a price to the three decimals of the tables', () => {
    const parsed = bar('20230102 180000;1823.3904;1824.2506;1823.3904;1824.2506;0');
    expect(parsed?.ok && [parsed.value.o, parsed.value.h]).toEqual([1823.39, 1824.251]);
  });

  it('skips a blank line and ignores the carriage return of a Windows file', () => {
    expect(bar('')).toBeNull();
    expect(bar('   \r')).toBeNull();
    expect(reason(bar('20230102 180000;1823.39;1824.25;1823.39;1824.25;0\r'))).toBe('OK');
  });

  it.each([
    ['too few fields', '20230102 180000;1823.39;1824.25;1823.39;1824.25'],
    ['a tick line', '20230102 180000123,1823.39,1824.25,0'],
    ['text', 'not a quote'],
    ['too many fields', '20230102 180000;1;2;3;4;0;9'],
  ])('refuses %s as MALFORMED', (_name, line) => {
    expect(reason(bar(line))).toBe('MALFORMED');
  });

  it.each([
    ['31 February', '20230231 120000'],
    ['the 24th hour', '20230102 240000'],
    ['minute 60', '20230102 126000'],
    ['month 13', '20231301 120000'],
    ['seconds in a minute bar', '20230102 120030'],
    ['milliseconds in a minute bar', '20230102 120000123'],
    ['a stamp with no time', '20230102'],
  ])('refuses %s as BAD_TIME', (_name, stamp) => {
    expect(reason(bar(`${stamp};1800;1801;1799;1800.5;0`))).toBe('BAD_TIME');
  });

  it.each([
    ['a word', 'abc'],
    ['an empty price', ''],
    ['a negative price', '-1800'],
    ['an exponent', '1.8e3'],
    ['a price of a currency pair', '1.0852'],
    ['a zero', '0'],
    ['a price with a missing decimal point', '1800000'],
    ['a price with a comma', '1800,5'],
  ])('refuses %s as BAD_PRICE', (_name, price) => {
    expect(reason(bar(`20230102 120000;${price};1801;1799;1800.5;0`))).toBe('BAD_PRICE');
  });

  it('holds prices to the bounds, the edges in', () => {
    const line = (price: number) =>
      `20230102 120000;${String(price)};${String(price)};${String(price)};${String(price)};0`;
    expect(reason(bar(line(PRICE_BOUNDS.min)))).toBe('OK');
    expect(reason(bar(line(PRICE_BOUNDS.min - 0.001)))).toBe('BAD_PRICE');
    expect(reason(bar(line(PRICE_BOUNDS.max)))).toBe('OK');
    expect(reason(bar(line(PRICE_BOUNDS.max + 0.001)))).toBe('BAD_PRICE');
  });

  it.each([
    ['a high below the low', '1800;1799;1801;1800'],
    ['a high below the close', '1800;1800.5;1799;1801'],
    ['a high below the open', '1802;1801;1799;1800'],
    ['a low above the open', '1798;1801;1799;1800'],
    ['a low above the close', '1800;1801;1799;1798.5'],
  ])('refuses %s as BAD_OHLC', (_name, prices) => {
    expect(reason(bar(`20230102 120000;${prices.replaceAll(';', ';')};0`))).toBe('BAD_OHLC');
  });

  it('accepts a flat minute and a minute whose open and close touch the high and the low', () => {
    expect(reason(bar('20230102 120000;1800;1800;1800;1800;0'))).toBe('OK');
    expect(reason(bar('20230102 120000;1799;1801;1799;1801;0'))).toBe('OK');
  });
});

describe('a tick line', () => {
  it('gives the bid and the ask', () => {
    expect(tick('20230102 180000123,1823.39,1824.25,0')).toEqual({
      ok: true,
      value: { ts: Date.UTC(2023, 0, 2, 23, 0, 0, 123), bid: 1823.39, ask: 1824.25 },
    });
  });

  it('takes a zero spread, and refuses an ask below the bid', () => {
    expect(reason(tick('20230102 180000123,1823.39,1823.39,0'))).toBe('OK');
    expect(reason(tick('20230102 180000123,1823.40,1823.39,0'))).toBe('ASK_BELOW_BID');
  });

  it.each([
    ['a stamp without milliseconds', '20230102 180000,1823.39,1824.25,0', 'BAD_TIME'],
    ['an impossible day', '20230230 180000123,1823.39,1824.25,0', 'BAD_TIME'],
    ['a bad bid', '20230102 180000123,x,1824.25,0', 'BAD_PRICE'],
    ['a bad ask', '20230102 180000123,1823.39,0,0', 'BAD_PRICE'],
    ['a bar line', '20230102 180000;1823.39;1824.25;1823.39;1824.25;0', 'MALFORMED'],
    ['three fields', '20230102 180000123,1823.39,1824.25', 'MALFORMED'],
  ] as const)('refuses %s as %s', (_name, line, expected) => {
    expect(reason(tick(line))).toBe(expected);
  });

  it('skips a blank line', () => {
    expect(tick(' \r')).toBeNull();
  });
});
