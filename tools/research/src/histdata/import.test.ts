import { buildCandles, type MarketCandle } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { linesOf } from './archive';
import { formatOf, importHistData } from './import';
import { MINUTE, T, barAt, source, stampOf } from './test-data';

const M1 = 'DAT_ASCII_XAUUSD_M1_2023.csv';
const TICKS = 'DAT_ASCII_XAUUSD_T_202301.csv';

const flat = (spread: number) => (): number => spread;

describe('formatOf', () => {
  it('tells bars from ticks by the file name', () => {
    expect(formatOf('DAT_ASCII_XAUUSD_M1_2023.zip')).toBe('M1');
    expect(formatOf('dat_ascii_xauusd_m1_2023.csv')).toBe('M1');
    expect(formatOf('DAT_ASCII_XAUUSD_T_202301.csv')).toBe('TICK');
  });

  it('refuses a name that says neither', () => {
    expect(() => formatOf('xauusd.csv')).toThrow('cannot tell the HistData format of xauusd.csv');
  });
});

describe('importHistData: what it will not take', () => {
  it('needs a file', () => {
    expect(() => importHistData([], { spreadAt: flat(0.2) })).toThrow('no files to import');
  });

  it('takes one format at a time', () => {
    expect(() =>
      importHistData([source(M1, []), source(TICKS, [])], { spreadAt: flat(0.2) }),
    ).toThrow('one import takes one format');
  });
});

describe('importHistData: M1 bars', () => {
  it('adds the whole spread to the bid prices to get the mid, half of it up', () => {
    const { minutes } = importHistData([source(M1, [barAt(0, 1000, 1001, 999, 1000.5)])], {
      spreadAt: flat(0.2),
    });
    expect(minutes).toEqual([
      {
        symbol: 'XAUUSD',
        tf: '1m',
        openTime: T,
        o: 1000.1,
        h: 1001.1,
        l: 999.1,
        c: 1000.6,
        spreadAvg: null,
        spreadMax: null,
        tickCount: 0,
        complete: true,
        source: 'histdata_bootstrap',
      },
    ]);
  });

  it('rounds the half spread up when the spread has an odd thousandth', () => {
    const { minutes } = importHistData([source(M1, [barAt(0, 1000)])], { spreadAt: flat(0.123) });
    expect(minutes[0]?.o).toBe(1000.062);
  });

  it('asks the model for the spread of the minute, so every hour has its own', () => {
    const asked: number[] = [];
    const { minutes } = importHistData([source(M1, [barAt(0, 1000), barAt(60, 1000)])], {
      spreadAt: (ms) => {
        asked.push(ms);
        return new Date(ms).getUTCHours() === 14 ? 0.4 : 0.2;
      },
    });
    expect(asked).toEqual([T, T + 60 * MINUTE]);
    expect(minutes.map((minute) => minute.o)).toEqual([1000.2, 1000.1]);
  });

  it('builds the higher timeframes from the minutes, and only those whose time has fully passed', () => {
    const lines = Array.from({ length: 120 }, (_, i) => barAt(i, 1000 + i));
    const { candles, report } = importHistData([source(M1, lines)], { spreadAt: flat(0) });
    expect(report.candles).toMatchObject({ '5m': 24, '15m': 8, '1h': 2 });
    const first = candles.find((candle) => candle.tf === '5m');
    expect(first).toMatchObject({ openTime: T, o: 1000, h: 1005, l: 999, c: 1004 });
    expect(candles.every((candle) => candle.source === 'histdata_bootstrap')).toBe(true);
    expect(candles.every((candle) => candle.complete)).toBe(true);
  });

  it('leaves a bucket that has not ended open: ten minutes make two 5m candles and no 15m one', () => {
    const lines = Array.from({ length: 10 }, (_, i) => barAt(i, 1000));
    const { candles } = importHistData([source(M1, lines)], { spreadAt: flat(0) });
    expect(candles.map((candle) => `${candle.tf}@${String(candle.openTime)}`)).toEqual([
      `5m@${String(T)}`,
      `5m@${String(T + 5 * MINUTE)}`,
    ]);
  });

  it('counts what it refuses, by reason, and shows where the first ones are', () => {
    const lines = [
      barAt(0, 1000),
      barAt(1, 1000),
      barAt(1, 1000),
      'garbage',
      `${stampOf(T + 5 * MINUTE)};1000;999;1001;1000;0`,
      '',
      barAt(2, 1000),
    ];
    const { report, minutes } = importHistData([source(M1, lines)], { spreadAt: flat(0) });
    expect(minutes).toHaveLength(3);
    expect(report).toMatchObject({
      format: 'M1',
      files: [M1],
      rows: 6,
      accepted: 3,
      reordered: 0,
      rejected: { DUPLICATE: 1, MALFORMED: 1, BAD_OHLC: 1 },
      firstAt: T,
      lastAt: T + 2 * MINUTE,
      minutes: 3,
    });
    expect(report.samples.map((sample) => [sample.line, sample.reason])).toEqual([
      [3, 'DUPLICATE'],
      [4, 'MALFORMED'],
      [5, 'BAD_OHLC'],
    ]);
    expect(report.samples[1]).toMatchObject({ file: M1, text: 'garbage' });
  });
  it('keeps only the first ten rejected lines as examples, and counts them all', () => {
    const lines = Array.from({ length: 25 }, () => 'garbage');
    const { report } = importHistData([source(M1, lines)], { spreadAt: flat(0) });
    expect(report.rejected).toEqual({ MALFORMED: 25 });
    expect(report.samples).toHaveLength(10);
    expect(report.accepted).toBe(0);
    expect(report.firstAt).toBeNull();
    expect(report.lastAt).toBeNull();
  });

  it('shortens a very long bad line in the examples', () => {
    const { report } = importHistData([source(M1, ['x'.repeat(500)])], { spreadAt: flat(0) });
    expect(report.samples[0]?.text).toHaveLength(120);
  });

  it('joins the files in the order given: a 5m candle that spans two files has minutes of both', () => {
    const first = Array.from({ length: 3 }, (_, i) => barAt(i, 1000 + i));
    const second = Array.from({ length: 7 }, (_, i) => barAt(i + 3, 1000 + i + 3));
    const { candles, report } = importHistData(
      [source(M1, first), source('DAT_ASCII_XAUUSD_M1_2024.csv', second)],
      { spreadAt: flat(0) },
    );
    expect(report.files).toEqual([M1, 'DAT_ASCII_XAUUSD_M1_2024.csv']);
    expect(candles[0]).toMatchObject({ tf: '5m', openTime: T, o: 1000, h: 1005, l: 999, c: 1004 });
  });

  describe('a minute that is written more than once', () => {
    // the bars of the minute 0, with a wide and a narrow range
    const wide = barAt(0, 1000, 1004, 996, 1001);
    const narrow = barAt(0, 1001, 1001.5, 1000.5, 1001);
    const flatRow = barAt(0, 1000.5, 1000.5, 1000.5, 1000.5);
    const first = (lines: readonly string[]) => {
      const { minutes, report } = importHistData([source(M1, lines)], { spreadAt: flat(0) });
      return { minutes, report };
    };

    it('keeps the row with the widest range, whichever comes first: a forming minute is inside the finished one', () => {
      for (const lines of [
        [flatRow, wide],
        [wide, flatRow],
        [narrow, wide, flatRow],
      ]) {
        const { minutes, report } = first(lines);
        expect(minutes).toHaveLength(1);
        expect(minutes[0]).toMatchObject({ o: 1000, h: 1004, l: 996, c: 1001 });
        expect(report).toMatchObject({ rows: lines.length, accepted: 1 });
        expect(report.rejected).toEqual({ DUPLICATE: lines.length - 1 });
      }
    });

    it('keeps the first of two rows with the same range, and counts the other', () => {
      const a = barAt(0, 1000, 1002, 998, 1001);
      const b = barAt(0, 1001, 1003, 999, 1002);
      const { minutes, report } = first([a, b]);
      expect(minutes[0]).toMatchObject({ o: 1000, h: 1002 });
      expect(report.rejected).toEqual({ DUPLICATE: 1 });
    });

    it('shows the row that was dropped, in UTC, with its place in the file, even when it was the first one', () => {
      const { report } = first([flatRow, wide]);
      expect(report.samples).toEqual([
        {
          file: M1,
          line: 1,
          reason: 'DUPLICATE',
          text: '2023-01-04T14:00Z o=1000.5 h=1000.5 l=1000.5 c=1000.5',
        },
      ]);
      const later = first([wide, flatRow]);
      expect(later.report.samples[0]).toMatchObject({ line: 2 });
    });

    it('takes an hour that is written twice, as at the end of daylight saving, once', () => {
      const hour = Array.from({ length: 60 }, (_, i) => barAt(i, 1000 + i));
      const lines = [...hour, ...hour, barAt(60, 1060)];
      const { minutes, report } = first(lines);
      expect(minutes).toHaveLength(61);
      expect(report).toMatchObject({ rows: 121, accepted: 61, reordered: 0 });
      expect(report.rejected).toEqual({ DUPLICATE: 60 });
    });

    it('takes the pattern of the real files: the forming minute, a stale restatement, then the finished one', () => {
      const lines = [
        barAt(0, 1000, 1001, 999, 1000),
        barAt(1, 1000, 1000, 1000, 1000),
        barAt(0, 1000.2, 1000.3, 1000.2, 1000.3),
        barAt(1, 1000, 1000.5, 990, 991),
        barAt(2, 991, 992, 990, 991.5),
      ];
      const { minutes, report } = first(lines);
      expect(minutes.map((m) => [m.o, m.h, m.l, m.c])).toEqual([
        [1000, 1001, 999, 1000],
        [1000, 1000.5, 990, 991],
        [991, 992, 990, 991.5],
      ]);
      expect(report.rejected).toEqual({ DUPLICATE: 2 });
      expect(report.reordered).toBe(0);
    });

    it('decides across files too: a month that repeats a minute of the one before', () => {
      const { minutes, report } = importHistData(
        [source(M1, [flatRow]), source('DAT_ASCII_XAUUSD_M1_2024.csv', [wide])],
        { spreadAt: flat(0) },
      );
      expect(minutes[0]).toMatchObject({ h: 1004 });
      expect(report.samples[0]).toMatchObject({ file: M1, line: 1 });
    });
  });

  describe('minutes that are not in order', () => {
    it('puts a minute that comes late in its place, and says how many', () => {
      const lines = [
        barAt(0, 1000),
        barAt(1, 1001),
        barAt(3, 1003),
        barAt(2, 1002),
        barAt(4, 1004),
      ];
      const { minutes, report } = importHistData([source(M1, lines)], { spreadAt: flat(0) });
      expect(minutes.map((m) => m.openTime)).toEqual([0, 1, 2, 3, 4].map((i) => T + i * MINUTE));
      expect(minutes.map((m) => m.o)).toEqual([1000, 1001, 1002, 1003, 1004]);
      expect(report).toMatchObject({ accepted: 5, reordered: 1, rejected: {} });
    });

    it('puts the minutes of a later file that come before the end of an earlier one in their place', () => {
      const { minutes, report } = importHistData(
        [
          source(M1, [barAt(5, 1005)]),
          source('DAT_ASCII_XAUUSD_M1_2024.csv', [barAt(2, 1002), barAt(6, 1006)]),
        ],
        { spreadAt: flat(0) },
      );
      expect(minutes.map((m) => m.o)).toEqual([1002, 1005, 1006]);
      expect(report).toMatchObject({ accepted: 3, reordered: 1 });
    });

    it('does not call the winner of a duplicate late when it arrived at the front', () => {
      const lines = [
        barAt(0, 1000),
        barAt(1, 1000.5, 1000.5, 1000.5, 1000.5),
        barAt(1, 1000, 1002, 998, 1001),
      ];
      const { report } = importHistData([source(M1, lines)], { spreadAt: flat(0) });
      expect(report.reordered).toBe(0);
    });

    it('counts a late winner as late', () => {
      const lines = [
        barAt(2, 1002),
        barAt(1, 1000.5, 1000.5, 1000.5, 1000.5),
        barAt(1, 1000, 1002, 998, 1001),
      ];
      const { report, minutes } = importHistData([source(M1, lines)], { spreadAt: flat(0) });
      expect(minutes.map((m) => m.openTime)).toEqual([T + MINUTE, T + 2 * MINUTE]);
      expect(report.reordered).toBe(1);
    });
  });
  it('reads a CRLF file from a zip reader', () => {
    const text = `${barAt(0, 1000)}\r\n${barAt(1, 1000)}\r\n`;
    const lines = linesOf(new TextEncoder().encode(text));
    const { report } = importHistData([source(M1, [...lines])], { spreadAt: flat(0) });
    expect(report).toMatchObject({ rows: 2, accepted: 2, reordered: 0 });
  });
});

describe('importHistData: ticks', () => {
  /** Two ticks in each of the minutes `from` to `to`. */
  function tickLines(from: number, to: number): string[] {
    const lines: string[] = [];
    for (let m = from; m <= to; m += 1) {
      lines.push(
        `${stampOf(T + m * MINUTE + 1_000, true)},${String(1000 + m)}.00,${String(1000 + m)}.20,0`,
      );
      lines.push(
        `${stampOf(T + m * MINUTE + 30_000, true)},${String(1000 + m)}.50,${String(1000 + m)}.80,0`,
      );
    }
    return lines;
  }

  it('takes the mid and the spread of the quotes themselves', () => {
    const { minutes, report } = importHistData([source(TICKS, tickLines(0, 6))], {
      spreadAt: flat(9),
    });
    expect(report).toMatchObject({ format: 'TICK', rows: 14, accepted: 14, minutes: 7 });
    expect(minutes[0]).toEqual({
      symbol: 'XAUUSD',
      tf: '1m',
      openTime: T,
      o: 1000.1,
      h: 1000.65,
      l: 1000.1,
      c: 1000.65,
      spreadAvg: 0.25,
      spreadMax: 0.3,
      tickCount: 2,
      complete: true,
      source: 'histdata_bootstrap',
    });
  });

  it('seals the last minutes at the end of the data', () => {
    const { minutes, candles } = importHistData([source(TICKS, tickLines(0, 6))], {
      spreadAt: flat(0),
    });
    expect(minutes.at(-1)?.openTime).toBe(T + 6 * MINUTE);
    expect(candles.filter((candle) => candle.tf === '5m')).toHaveLength(1);
  });

  it('gives the candles the live worker would have built from the same ticks', () => {
    const lines = tickLines(0, 12);
    const result = importHistData([source(TICKS, lines)], { spreadAt: flat(0) });
    const ticks = lines.map((line) => {
      const [stamp = '', bid = '', ask = ''] = line.split(',');
      const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
      const ts = Date.parse(iso) + 5 * 3_600_000;
      return { ts, rxAt: ts, symbol: 'XAUUSD', bid: Number(bid), ask: Number(ask) };
    });
    const end = Math.max(...ticks.map((item) => item.ts)) + 120_000;
    const live = buildCandles({ symbol: 'XAUUSD' }, ticks, end).candles;
    const asBootstrap = (candle: MarketCandle): MarketCandle => ({
      ...candle,
      source: 'histdata_bootstrap',
    });
    expect(
      [...result.minutes, ...result.candles].sort(
        (a, b) => a.openTime - b.openTime || a.tf.localeCompare(b.tf),
      ),
    ).toEqual(
      live.map(asBootstrap).sort((a, b) => a.openTime - b.openTime || a.tf.localeCompare(b.tf)),
    );
  });

  it('counts an ask below the bid, and a tick that comes after its minute was sealed', () => {
    const lines = [
      ...tickLines(0, 6),
      `${stampOf(T + 7 * MINUTE, true)},1000.50,1000.40,0`,
      `${stampOf(T + 30_000, true)},1000.00,1000.20,0`,
    ];
    const { report } = importHistData([source(TICKS, lines)], { spreadAt: flat(0) });
    expect(report.rejected).toEqual({ ASK_BELOW_BID: 1, OUT_OF_ORDER: 1 });
    expect(report.accepted).toBe(14);
  });

  it.each([0, 500, 1_999])(
    'keeps the last minute when its only tick came %i ms into it: the builder seals a minute two seconds after its end',
    (offset) => {
      const lines = [
        ...tickLines(0, 3),
        `${stampOf(T + 4 * MINUTE + offset, true)},1004.00,1004.20,0`,
      ];
      const { minutes, report } = importHistData([source(TICKS, lines)], { spreadAt: flat(0) });
      expect(minutes.at(-1)).toMatchObject({ openTime: T + 4 * MINUTE, tickCount: 1, o: 1004.1 });
      expect(report).toMatchObject({ accepted: 9, minutes: 5, lastAt: T + 4 * MINUTE });
    },
  );

  it('builds a 5m candle across two monthly files', () => {
    const { candles } = importHistData(
      [source(TICKS, tickLines(0, 2)), source('DAT_ASCII_XAUUSD_T_202302.csv', tickLines(3, 9))],
      { spreadAt: flat(0) },
    );
    expect(candles.find((candle) => candle.tf === '5m')).toMatchObject({ openTime: T, o: 1000.1 });
  });
});
