import type { MarketCandle } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import type { BootstrapStore } from './bootstrap/store';
import { SPREAD_WINDOW_DAYS, checkCommand, importCommand, spreadCommand } from './commands';
import { MINUTE, T, barAt, flatBars, source } from './histdata/test-data';
import type { HourSpread } from './spread/model';

const M1 = 'DAT_ASCII_XAUUSD_M1_2023.csv';
const DAY = 86_400_000;
const NOW = Date.UTC(2023, 0, 20, 12, 0, 0);

class MemoryStore implements BootstrapStore {
  liveFromAt: number | null = null;
  rows: HourSpread[] = [];
  readonly written = new Map<string, MarketCandle>();
  readonly sinceAsked: number[] = [];
  liveFromCalls = 0;

  liveFrom(): Promise<number | null> {
    this.liveFromCalls += 1;
    return Promise.resolve(this.liveFromAt);
  }

  spreadRows(since: number): Promise<HourSpread[]> {
    this.sinceAsked.push(since);
    return Promise.resolve(this.rows);
  }

  write(candles: readonly MarketCandle[]): Promise<number> {
    let added = 0;
    for (const candle of candles) {
      const key = `${candle.tf}@${String(candle.openTime)}`;
      if (this.written.has(key)) continue;
      this.written.set(key, candle);
      added += 1;
    }
    return Promise.resolve(added);
  }
}

function printer() {
  const lines: string[] = [];
  return { lines, print: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

const run = (store: MemoryStore, lines: readonly string[], dryRun = false) => {
  const out = printer();
  const done = importCommand({
    sources: [source(M1, lines)],
    store,
    dryRun,
    now: NOW,
    print: out.print,
  });
  return { out, done };
};

describe('checkCommand', () => {
  it('reads the files and reports what is in them, without a database', () => {
    const out = printer();
    const ok = checkCommand([source(M1, [...flatBars(120), 'garbage'])], out.print);
    expect(ok).toBe(true);
    expect(out.lines[0]).toBe('M1 bars (bid only: mid = bid + the spread model) from 1 file(s)');
    expect(out.text()).toContain('rows 121, accepted 120');
    expect(out.text()).toContain('rejected: MALFORMED 1');
    expect(out.text()).toContain(`${M1}:121 MALFORMED: garbage`);
    expect(out.text()).toContain(
      'from 2023-01-04 14:00Z to 2023-01-04 15:59Z: 120 minutes, 5m 24, 15m 8, 1h 2',
    );
    expect(out.text()).toContain(
      'gaps: 0 weekend, 0 daily break, 0 other (0 minutes missing), coverage 100.00%',
    );
  });

  it('says it found nothing to use', () => {
    const out = printer();
    expect(checkCommand([source(M1, ['garbage'])], out.print)).toBe(false);
  });

  it('lists the longest holes with their times', () => {
    const out = printer();
    checkCommand([source(M1, [...flatBars(10), ...flatBars(10, 40)])], out.print);
    expect(out.text()).toContain('gaps: 0 weekend, 0 daily break, 1 other (30 minutes missing)');
    expect(out.text()).toContain('  2023-01-04 14:10Z to 2023-01-04 14:40Z: 30 minutes');
  });

  it('says how many rows were put in their place, and only when there were some', () => {
    const late = [barAt(0, 1000), barAt(2, 1000), barAt(1, 1000)];
    const out = printer();
    checkCommand([source(M1, late)], out.print);
    expect(out.text()).toContain(
      '1 accepted rows came behind a later minute and were put in their place',
    );
    const quiet = printer();
    checkCommand([source(M1, flatBars(5))], quiet.print);
    expect(quiet.text()).not.toContain('came behind');
  });

  describe('a hole in the history', () => {
    // five minutes from Wednesday 14:00 UTC, then the data starts again `hole` minutes after they end; a hole of
    // seven days has one weekend closure in it, so exactly five days (7200 minutes) of the market are open
    const withHole = (hole: number) => [...flatBars(5), ...flatBars(5, 5 + hole)];
    const SEVEN_DAYS = 7 * 24 * 60;

    it('warns about a hole of more than five days of open market, with the days and the dates', () => {
      const out = printer();
      checkCommand([source(M1, withHole(SEVEN_DAYS + 1))], out.print);
      expect(out.text()).toContain('WARNING: a hole of 5.0 trading days from 2023-01-04 14:05Z');
      expect(out.text()).toContain('to 2023-01-11 14:06Z');
      expect(out.text()).toContain('Download the missing months of HistData');
    });

    it('is silent at exactly five days of open market, and for the hole of a holiday', () => {
      const out = printer();
      checkCommand([source(M1, withHole(SEVEN_DAYS))], out.print);
      expect(out.text()).toContain('7200 minutes');
      expect(out.text()).not.toContain('WARNING');
      const holiday = printer();
      checkCommand([source(M1, withHole(28 * 60))], holiday.print);
      expect(holiday.text()).not.toContain('WARNING');
    });

    it('warns for each hole that is too long, not only for the longest', () => {
      const out = printer();
      const lines = [...flatBars(5), ...flatBars(5, 5 + SEVEN_DAYS + 1)];
      const later = 5 + SEVEN_DAYS + 1 + 5 + SEVEN_DAYS + 1;
      checkCommand([source(M1, [...lines, ...flatBars(5, later)])], out.print);
      expect(out.lines.filter((line) => line.startsWith('WARNING'))).toHaveLength(2);
    });
  });
  it('describes ticks as bid and ask', () => {
    const out = printer();
    checkCommand(
      [source('DAT_ASCII_XAUUSD_T_202301.csv', ['20230104 090000123,1000.00,1000.20,0'])],
      out.print,
    );
    expect(out.lines[0]).toBe('ticks (bid and ask) from 1 file(s)');
  });
});

describe('importCommand', () => {
  it('writes the candles, and says so', async () => {
    const store = new MemoryStore();
    const { out, done } = run(store, flatBars(120));
    expect(await done).toBe(true);
    expect(store.written.size).toBe(35);
    expect(out.text()).toContain('written 35 new candles (0 were already there)');
  });

  it('asks the database for the spreads of the last 90 days', async () => {
    const store = new MemoryStore();
    await run(store, flatBars(10)).done;
    expect(SPREAD_WINDOW_DAYS).toBe(90);
    expect(store.sinceAsked).toEqual([NOW - 90 * DAY]);
  });

  it('turns the bid into a mid with the spread the database gives for the hour', async () => {
    const store = new MemoryStore();
    store.rows = [{ hour: 14, median: 0.5, p90: 1, n: 100 }];
    await run(store, flatBars(10)).done;
    const first = store.written.get(`5m@${String(T)}`);
    expect(first).toMatchObject({ o: 1000.25, h: 1001.25, l: 999.25, c: 1000.25 });
  });

  it('adds the default spread when nothing was recorded', async () => {
    const store = new MemoryStore();
    await run(store, flatBars(10)).done;
    expect(store.written.get(`5m@${String(T)}`)?.o).toBe(1000.1);
  });

  it('writes nothing on a dry run, and says what it would do', async () => {
    const store = new MemoryStore();
    const { out, done } = run(store, flatBars(120), true);
    await done;
    expect(store.written.size).toBe(0);
    expect(out.text()).toContain('dry run: 35 candles would be written');
    expect(out.text()).not.toContain('written 35');
  });

  it('writes a second import of the same file as nothing new', async () => {
    const store = new MemoryStore();
    await run(store, flatBars(120)).done;
    const { out, done } = run(store, flatBars(120));
    await done;
    expect(store.written.size).toBe(35);
    expect(out.text()).toContain('written 0 new candles (35 were already there)');
  });

  it('leaves out what overlaps the live data, and says how many', async () => {
    const store = new MemoryStore();
    store.liveFromAt = T + 60 * MINUTE;
    const { out, done } = run(store, flatBars(120));
    await done;
    // the second hour: 12 of the 5m, 4 of the 15m, the 1h and the 4h candle end after the first live minute
    expect(out.text()).toContain('18 candles overlap the live data and are left out');
    expect(store.written.size).toBe(17);
    expect([...store.written.values()].every((c) => c.openTime < T + 60 * MINUTE)).toBe(true);
  });

  it('refuses to go on when no line could be read, and writes nothing', async () => {
    const store = new MemoryStore();
    const { out, done } = run(store, ['garbage']);
    expect(await done).toBe(false);
    expect(store.written.size).toBe(0);
    expect(store.liveFromCalls).toBe(0);
    expect(out.text()).toContain('rejected: MALFORMED 1');
  });

  it('says that a short history is not enough for the warm-up on its own', async () => {
    const store = new MemoryStore();
    const { out, done } = run(store, flatBars(120));
    await done;
    expect(out.text()).toContain(
      'warm-up needs 900 5m, 1440 15m and 600 1h candles; the history has 24, 8 and 2: not enough on its own (live candles add to it)',
    );
  });

  it('says it is enough when the history holds the candles the warm-up needs', async () => {
    const store = new MemoryStore();
    const { out, done } = run(store, flatBars(36_100));
    await done;
    expect(out.text()).toContain('the history has 7220, 2406 and 601: enough');
  });

  describe('the hole between the history and the live data', () => {
    // 120 minutes from 14:00 end at 16:00 UTC on a Wednesday
    const END = T + 120 * MINUTE;

    it('warns when more than a day of the open market lies in it', async () => {
      const store = new MemoryStore();
      store.liveFromAt = END + 24 * 60 * MINUTE + MINUTE;
      const { out, done } = run(store, flatBars(120));
      await done;
      expect(out.text()).toContain(
        'WARNING: 24 trading hours lie between the end of this history (2023-01-04 16:00Z) and the first live candle (2023-01-05 16:01Z)',
      );
    });

    it('is silent at exactly a day', async () => {
      const store = new MemoryStore();
      store.liveFromAt = END + 24 * 60 * MINUTE;
      const { out, done } = run(store, flatBars(120));
      await done;
      expect(out.text()).not.toContain('WARNING');
    });

    it('is silent when there is no live data yet', async () => {
      const store = new MemoryStore();
      const { out, done } = run(store, flatBars(120));
      await done;
      expect(out.text()).not.toContain('WARNING');
    });
  });

  it('does not invent candles for the minutes of a gap', async () => {
    const store = new MemoryStore();
    await run(store, [...flatBars(5), barAt(20, 1000)]).done;
    expect(
      [...store.written.values()].map((c) => `${c.tf}@${String((c.openTime - T) / MINUTE)}`),
    ).toEqual(['5m@0', '15m@0']);
  });
});

describe('spreadCommand', () => {
  it('prints the model by hour, with the number of candles it rests on', async () => {
    const store = new MemoryStore();
    store.rows = [
      { hour: 8, median: 0.15, p90: 0.3, n: 120 },
      { hour: 9, median: 0.2, p90: 0.4, n: 30 },
    ];
    const out = printer();
    await spreadCommand({ store, now: NOW, print: out.print });
    expect(out.lines[0]).toBe(
      'spread by UTC hour from 150 recorded 5m candles of the last 90 days (default 0.200 where nothing is recorded)',
    );
    expect(out.lines).toHaveLength(25);
    expect(out.lines[9]).toBe('08:00 UTC  median 0.150  p90 0.300  (n=120)');
    expect(store.sinceAsked).toEqual([NOW - 90 * DAY]);
  });
});
