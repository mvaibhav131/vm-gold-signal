import { describe, expect, it } from 'vitest';

import { checkTelegramHtml } from '../messages/markup';
import { ICON, RESULT_ICON } from '../messages/style';
import { plain } from '../messages/test-html';
import { TELEGRAM_HARD_LIMIT } from '../messages/text';
import type { DisplayOptions } from '../messages/types';
import {
  helpReply,
  linkInvalidReply,
  linkedReply,
  monthReply,
  noClosedReply,
  openReply,
  pauseUsageReply,
  replyOf,
  startReply,
  statusReply,
  todayReply,
  unknownCommandReply,
  type OpenData,
  type PeriodRow,
  type StatusData,
} from './replies';
import { ALERT_WORDS } from './words';

const EN: DisplayOptions = { locale: 'en', displayTz: 'Asia/Kolkata' };
const HI: DisplayOptions = { locale: 'hinglish', displayTz: 'Asia/Kolkata' };
/** 2026-10-23 07:10 UTC, a Friday: 12:40 IST, London is open. */
const AT = Date.UTC(2026, 9, 23, 7, 10, 0);
const MIN = 60_000;

// Most tests here check the words and the numbers, so they read what a reader sees: no tags and
// no picture at the start of a line. The look itself is checked, exactly, in "the look".
const PICTURES = new RegExp(
  `^(?:${[...Object.values(ICON), ...Object.values(RESULT_ICON), '🟡', '🔴', '⚪', '🟢'].join('|')}) `,
  'gmu',
);
const lines = (reply: { text: string }): string[] =>
  plain(reply.text).replace(PICTURES, '').split('\n');

describe('replyOf', () => {
  it('escapes the text as a whole, like every Telegram message', () => {
    expect(replyOf(['a < b & c > d']).text).toBe('a &lt; b &amp; c &gt; d');
  });

  it('refuses a reply that Telegram would not take', () => {
    expect(() => replyOf(['x'.repeat(TELEGRAM_HARD_LIMIT)])).not.toThrow();
    expect(() => replyOf(['x'.repeat(TELEGRAM_HARD_LIMIT + 1)])).toThrow(RangeError);
    // the length of the escaped text counts
    expect(() => replyOf(['&'.repeat(1000)])).toThrow(RangeError);
  });
});

describe('help, start, link and the short replies', () => {
  it('lists every command in both languages', () => {
    expect(lines(helpReply(EN))).toEqual([
      'COMMANDS',
      '/status: feed, engine, session, next event, strategies',
      '/open: open signals with live R',
      '/last: the last closed signal with its review',
      '/today: signals, results and net R of today',
      '/month: this month so far',
      '/pause [minutes]: stop new signals (tracking continues)',
      '/resume: send new signals again',
      '/help: this list',
      'Signals are decision support. You place every order yourself.',
    ]);
    expect(helpReply(HI).text).toContain('/open: khule signals, live R ke saath');
    expect(lines(helpReply(HI))).toHaveLength(10);
  });

  it('says the same things in both languages with different words', () => {
    for (const reply of [
      startReply,
      linkedReply,
      linkInvalidReply,
      pauseUsageReply,
      noClosedReply,
    ]) {
      expect(reply(EN).text, reply.name).not.toBe(reply(HI).text);
    }
    expect(unknownCommandReply('stats', EN).text).toBe('Unknown command /stats. Try /help.');
    expect(unknownCommandReply('stats', HI).text).toBe('/stats command nahi hai. /help dekho.');
    // a command name from the user is escaped
    expect(unknownCommandReply('a&b', EN).text).toBe('Unknown command /a&amp;b. Try /help.');
  });

  it('the link replies say what happened', () => {
    expect(linkedReply(EN).text).toContain('only this chat is served');
    expect(linkInvalidReply(EN).text).toContain('may have expired');
    expect(pauseUsageReply(EN).text).toContain('/pause 30');
  });
});

const STATUS: StatusData = {
  at: AT,
  feed: { state: 'LIVE', tickAgeMs: 1_000, spread: 0.18 },
  engine: { status: 'RUNNING' },
  session: 'LONDON',
  regime: 'TREND_UP',
  nextHigh: { name: 'US CPI m/m', at: Date.UTC(2026, 9, 23, 12, 30) },
  openCount: 2,
  openRiskR: 1,
  strategies: [
    { key: 'trend_pullback', version: '0.1.0', status: 'FORWARD_TESTING', alerts: true },
    { key: 'sweep_reversal', version: '0.1.0', status: 'FORWARD_TESTING', alerts: true },
    { key: 'trendline_retest', version: '0.1.0', status: 'RESEARCH', alerts: false },
  ],
};

describe('statusReply', () => {
  it('shows the feed, the engine, the session, the next event, the open signals and the strategies', () => {
    expect(lines(statusReply(STATUS, EN))).toEqual([
      'STATUS 12:40 IST',
      'Feed: LIVE, last tick 1 s ago, spread 0.180',
      'Engine: RUNNING',
      'Session: London, regime: trend up',
      'Next HIGH-impact event: US CPI m/m, 18:00 IST (in 5 h 20 min)',
      'Open signals: 2, open risk 1.00R',
      'Strategies:',
      'Trend Pullback v0.1.0: FORWARD TESTING, alerts on',
      'Liquidity Sweep Reversal v0.1.0: FORWARD TESTING, alerts on',
      'Trendline Break and Retest v0.1.0: RESEARCH, alerts off (shadow)',
    ]);
  });

  it('is the same in Hinglish except for the labels', () => {
    expect(lines(statusReply(STATUS, HI))).toEqual([
      'STATUS 12:40 IST',
      'Feed: LIVE, aakhri tick 1 s pehle, spread 0.180',
      'Engine: CHAL RAHA HAI',
      'Session: London, regime: trend up',
      'Agla HIGH-impact event: US CPI m/m, 18:00 IST (5 h 20 min mein)',
      'Khule signals: 2, khula risk 1.00R',
      'Strategies:',
      'Trend Pullback v0.1.0: FORWARD TESTING, alerts on',
      'Liquidity Sweep Reversal v0.1.0: FORWARD TESTING, alerts on',
      'Trendline Break and Retest v0.1.0: RESEARCH, alerts off (shadow)',
    ]);
  });

  it('says so when the engine is paused (with or without an end), warming up, or the data is not known', () => {
    const paused = (until: number | null) =>
      lines(
        statusReply(
          {
            ...STATUS,
            engine: { status: 'PAUSED', since: AT - 30 * MIN, until },
            feed: null,
            regime: null,
            nextHigh: null,
          },
          EN,
        ),
      ).slice(1, 6);
    expect(paused(null)).toEqual([
      'Feed: not available',
      'Engine: PAUSED since 12:10 IST',
      'Session: London, regime: not known yet',
      'Next HIGH-impact event: none known',
      'Open signals: 2, open risk 1.00R',
    ]);
    expect(paused(AT + 20 * MIN)[2]).toBe('Paused until 13:00 IST (20 min).');
    expect(
      lines(statusReply({ ...STATUS, engine: { status: 'WARMING_UP', progressPct: 62.4 } }, EN))[2],
    ).toBe('Engine: WARMING UP (62%)');
  });

  it('shows the state of a feed that is down, and a feed with no tick yet', () => {
    const feed = (state: 'STALE' | 'MARKET_CLOSED' | 'DISCONNECTED', tickAgeMs: number | null) =>
      lines(statusReply({ ...STATUS, feed: { state, tickAgeMs, spread: null } }, EN))[1];
    expect(feed('STALE', 18_000)).toBe('Feed: STALE, last tick 18 s ago');
    expect(feed('MARKET_CLOSED', 3 * 3600_000)).toBe('Feed: MARKET CLOSED, last tick 3 h ago');
    expect(feed('DISCONNECTED', null)).toBe('Feed: DISCONNECTED, no tick yet');
  });

  it('shows an event that has just passed as "in 0 s", never a negative span', () => {
    const reply = statusReply({ ...STATUS, nextHigh: { name: 'X', at: AT - 5_000 } }, EN);
    expect(lines(reply)[4]).toBe('Next HIGH-impact event: X, 12:39 IST (in 0 s)');
  });

  it('adds the date to an event on another day', () => {
    const reply = statusReply(
      { ...STATUS, nextHigh: { name: 'NFP', at: Date.UTC(2026, 10, 6, 13, 30) } },
      EN,
    );
    expect(lines(reply)[4]).toBe(
      'Next HIGH-impact event: NFP, 19:00 IST (6 Nov) (in 342 h 20 min)',
    );
  });
});

const OPEN: OpenData = {
  at: AT,
  waitReasons: [],
  lines: [
    {
      seq: 45,
      side: 'BUY',
      strategyKey: 'trend_pullback',
      status: 'ACTIVE',
      price: 4020.1,
      unrealisedR: 0.4219,
      entry: 4017.37,
      stop: 4010.9,
      tp1: 4023.84,
      tp2: 4030.31,
      timeStopAt: AT + 120 * MIN,
    },
    {
      seq: 46,
      side: 'SELL',
      strategyKey: 'sweep_reversal',
      status: 'TP1_HIT',
      price: 3975.1,
      unrealisedR: 1.1,
      entry: 3982.63,
      stop: 3982.63,
      tp1: 3976.16,
      tp2: 3969.69,
      timeStopAt: AT + 140 * MIN,
    },
  ],
};

describe('openReply', () => {
  it('lists the open signals with their live R, the stop in force and the time stop', () => {
    expect(lines(openReply(OPEN, EN, 1))).toEqual([
      'OPEN SIGNALS (2), open risk 1.00R',
      '#S-0045 BUY Trend Pullback: +0.42R now (price 4020.100). Stop 4010.900, TP1 4023.840. Time stop 14:40 IST.',
      '#S-0046 SELL Liquidity Sweep Reversal: TP1 hit, +1.10R now (price 3975.100). Stop at entry 3982.630, runner to 3969.690. Time stop 15:00 IST.',
    ]);
  });

  it('the same in Hinglish', () => {
    const [title, first] = lines(openReply(OPEN, HI, 1));
    expect(title).toBe('KHULE SIGNALS (2), khula risk 1.00R');
    expect(first).toBe(
      '#S-0045 BUY Trend Pullback: abhi +0.42R (price 4020.100). Stop 4010.900, TP1 4023.840. Time stop 14:40 IST.',
    );
  });

  it('says so when there is no price yet, and for a single-target trade shows TP1 as the runner target', () => {
    const [first, second] = OPEN.lines;
    if (first === undefined || second === undefined) throw new Error('no line');
    const noPrice = openReply(
      { ...OPEN, lines: [{ ...first, price: null, unrealisedR: null }] },
      EN,
      1,
    );
    expect(lines(noPrice)[1]).toBe(
      '#S-0045 BUY Trend Pullback: no price now (price no price). Stop 4010.900, TP1 4023.840. Time stop 14:40 IST.',
    );
    const single = openReply({ ...OPEN, lines: [{ ...second, tp2: null }] }, EN, 0);
    expect(lines(single)[1]).toContain('runner to 3976.160');
  });

  it('with nothing open it says so, and why no signal is coming when it knows', () => {
    expect(lines(openReply({ at: AT, lines: [], waitReasons: [] }, EN, 0))).toEqual([
      'No open signal.',
    ]);
    expect(
      lines(
        openReply({ at: AT, lines: [], waitReasons: ['spread too high', 'news window'] }, EN, 0),
      ),
    ).toEqual(['No open signal.', 'Waiting: spread too high, news window']);
    expect(lines(openReply({ at: AT, lines: [], waitReasons: [] }, HI, 0))).toEqual([
      'Koi signal khula nahi hai.',
    ]);
  });

  it('a long list is cut under the limit with one line that says how many are left', () => {
    const [template] = OPEN.lines;
    if (template === undefined) throw new Error('no line');
    const many = Array.from({ length: 60 }, (_unused, i) => ({ ...template, seq: 100 + i }));
    const reply = openReply({ ...OPEN, lines: many }, EN, 60);
    expect(reply.text.length).toBeLessThanOrEqual(3500);
    const rows = lines(reply);
    expect(rows[0]).toBe('OPEN SIGNALS (60), open risk 60.00R');
    const shown = rows.filter((row) => row.startsWith('#S-')).length;
    expect(shown).toBeGreaterThan(10);
    expect(shown).toBeLessThan(60);
    expect(rows.at(-1)).toBe(`and ${String(60 - shown)} more: see the dashboard.`);
    // and the signals shown are the first ones, in order
    expect(rows[1]).toContain('#S-0100');
  });

  it('cuts by the length of the text that is sent, with its tags, at every length of the list', () => {
    const [template] = OPEN.lines;
    if (template === undefined) throw new Error('no line');
    let cut = 0;
    // `wide` rows are one character longer than the others, so that the whole text is measured at
    // every length around the limit, also at the few characters that the tags add
    for (let count = 22; count <= 34; count += 1) {
      for (let wide = 0; wide <= count; wide += 1) {
        const many = Array.from({ length: count }, (_unused, i) => ({
          ...template,
          seq: 100 + i,
          unrealisedR: i < wide ? 12.34 : 0.4219,
        }));
        const text = openReply({ ...OPEN, lines: many }, EN, count).text;
        expect(text.length, `${String(count)} lines, ${String(wide)} wide`).toBeLessThanOrEqual(
          3500,
        );
        if (text.includes(' more: see the dashboard.')) cut += 1;
      }
    }
    expect(cut).toBeGreaterThan(20);
  });
});

function row(change: Partial<PeriodRow> & Pick<PeriodRow, 'seq'>): PeriodRow {
  return {
    side: 'BUY',
    strategyKey: 'trend_pullback',
    generatedAt: AT - 120 * MIN,
    result: 'WIN',
    countsInStats: true,
    realizedRNet: 1.47,
    durationS: 2200,
    tp1Hit: true,
    tp2Hit: true,
    closedAt: AT - 80 * MIN + change.seq * 1000,
    primaryCause: null,
    ...change,
  };
}

describe('todayReply', () => {
  const rows: PeriodRow[] = [
    row({ seq: 44 }),
    row({ seq: 45, result: 'LOSS', realizedRNet: -1.04, tp1Hit: false, tp2Hit: false }),
    row({ seq: 46, side: 'SELL', strategyKey: 'sweep_reversal', result: null, realizedRNet: null }),
    row({ seq: 47, result: 'CANCELLED', countsInStats: false, realizedRNet: null }),
  ];

  it('counts the signals and the results of the day, and lists every signal', () => {
    expect(lines(todayReply({ at: AT, rows }, EN))).toEqual([
      'TODAY 23 Oct (IST)',
      'Signals generated: 4',
      'Valid results: 2. Results: win 1, partial win 0, loss 1, time exit 0',
      'Cancelled: 1   Data invalid: 0   Still open: 1',
      '#S-0044 BUY Trend Pullback: WIN +1.47R',
      '#S-0045 BUY Trend Pullback: LOSS -1.04R',
      '#S-0046 SELL Liquidity Sweep Reversal: still open',
      '#S-0047 BUY Trend Pullback: CANCELLED (not counted)',
      'Net +0.43R',
    ]);
  });

  it('is the same in Hinglish', () => {
    const text = lines(todayReply({ at: AT, rows }, HI));
    expect(text[0]).toBe('AAJ 23 Oct (IST)');
    expect(text[1]).toBe('Signals bane: 4');
    expect(text[6]).toBe('#S-0046 SELL Liquidity Sweep Reversal: abhi khula hai');
  });

  it('says so on a day without a signal, and shows a data-invalid signal as not counted', () => {
    expect(lines(todayReply({ at: AT, rows: [] }, EN))).toEqual([
      'TODAY 23 Oct (IST)',
      'No signals today.',
    ]);
    const invalid = lines(
      todayReply(
        {
          at: AT,
          rows: [row({ seq: 9, result: 'DATA_INVALID', countsInStats: false, realizedRNet: null })],
        },
        EN,
      ),
    );
    expect(invalid).toContain('#S-0009 BUY Trend Pullback: DATA INVALID (not counted)');
    expect(invalid).toContain('Cancelled: 0   Data invalid: 1   Still open: 0');
  });

  it('names a partial win and a time exit with their R, and puts the signals in the order of their numbers', () => {
    const out = lines(
      todayReply(
        {
          at: AT,
          rows: [
            row({ seq: 12, result: 'TIME_EXIT', realizedRNet: -0.18 }),
            row({ seq: 11, result: 'PARTIAL_WIN', realizedRNet: 0.46 }),
          ],
        },
        EN,
      ),
    );
    expect(out.slice(4)).toEqual([
      '#S-0011 BUY Trend Pullback: PARTIAL WIN +0.46R',
      '#S-0012 BUY Trend Pullback: TIME EXIT -0.18R',
      'Net +0.28R',
    ]);
  });

  it('uses the day of the display zone: 23:30 IST on the 22nd is still the 22nd', () => {
    const late = Date.UTC(2026, 9, 22, 18, 0, 0);
    expect(lines(todayReply({ at: late, rows: [] }, EN))[0]).toBe('TODAY 22 Oct (IST)');
    expect(lines(todayReply({ at: Date.UTC(2026, 9, 22, 19, 0, 0), rows: [] }, EN))[0]).toBe(
      'TODAY 23 Oct (IST)',
    );
  });
});

describe('monthReply', () => {
  const MONTH = Date.UTC(2026, 9, 1, 0, 0, 0) - 5.5 * 3600_000;

  function monthRows(): PeriodRow[] {
    const rows: PeriodRow[] = [];
    let seq = 1;
    const add = (change: Partial<PeriodRow>) => rows.push(row({ seq: seq++, ...change }));
    for (let i = 0; i < 18; i += 1) add({ realizedRNet: 1.5 });
    for (let i = 0; i < 12; i += 1) {
      add({
        result: 'LOSS',
        realizedRNet: -1,
        primaryCause:
          i < 5 ? 'NORMAL_LOSS' : i < 8 ? 'NO_FOLLOW_THROUGH' : i < 10 ? 'NEWS_SHOCK' : null,
      });
    }
    for (let i = 0; i < 2; i += 1) add({ strategyKey: 'sweep_reversal', realizedRNet: 1.5 });
    for (let i = 0; i < 2; i += 1)
      add({ strategyKey: 'sweep_reversal', result: 'LOSS', realizedRNet: -1 });
    add({ result: 'CANCELLED', countsInStats: false, realizedRNet: null });
    add({ result: null, realizedRNet: null });
    // the wins closed first, then the losses: the deepest fall is all the losses
    return rows.map((r, i) => ({ ...r, closedAt: r.result === 'WIN' ? 1_000 + i : 100_000 + i }));
  }

  it('summarises the month with the rate and its interval from 30 valid results, and the strategies and the causes', () => {
    expect(lines(monthReply({ monthStart: MONTH, rows: monthRows() }, EN))).toEqual([
      'MONTH SO FAR October 2026 (FORWARD-TEST)',
      'Signals generated: 36',
      'Cancelled: 1   Data invalid: 0   Still open: 1',
      'Valid results: 34',
      'Results: win 20, partial win 0, loss 14, time exit 0',
      'Win rate 58.8% (20 of 34)  95% CI 42-74%',
      'Net +16.00R   Expectancy +0.47R   PF 2.14   Max drawdown -14.00R',
      'By strategy:',
      'Trend Pullback 30 (60.0%)',
      'Liquidity Sweep Reversal 4 (n too small)',
      'Top failure causes: NORMAL_LOSS 5, NO_FOLLOW_THROUGH 3, NEWS_SHOCK 2',
    ]);
  });

  it('shows no win rate below 30 valid results (rule C6) but still the money figures', () => {
    const few = monthRows().slice(0, 12);
    const text = lines(monthReply({ monthStart: MONTH, rows: few }, EN));
    expect(text).toContain('Win rate: not shown below 30 valid results (n=12)');
    expect(text.join('\n')).not.toContain('95% CI');
    expect(text).toContain('Trend Pullback 12 (n too small)');
    expect(text.at(-1)).toBe('Top failure causes: no reviewed result yet');
  });

  it('a month with nothing to count says only what it has', () => {
    expect(lines(monthReply({ monthStart: MONTH, rows: [] }, EN))).toEqual([
      'MONTH SO FAR October 2026 (FORWARD-TEST)',
      'Signals generated: 0',
      'Cancelled: 0   Data invalid: 0   Still open: 0',
      'Valid results: 0',
    ]);
  });

  it('the same in Hinglish, with the numbers unchanged', () => {
    const text = lines(monthReply({ monthStart: MONTH, rows: monthRows() }, HI));
    expect(text[0]).toBe('IS MAHINE AB TAK October 2026 (FORWARD-TEST)');
    expect(text[5]).toBe('Win rate 58.8% (34 mein se 20)  95% CI 42-74%');
    expect(text[6]).toBe('Net +16.00R   Expectancy +0.47R   PF 2.14   Max drawdown -14.00R');
    expect(text[9]).toBe('Liquidity Sweep Reversal 4 (n bahut chhota)');
  });

  it('a profit factor needs a loss, and a month without a fall shows a drawdown of 0', () => {
    const wins = Array.from({ length: 3 }, (_unused, i) => row({ seq: i + 1, realizedRNet: 1.5 }));
    const text = lines(monthReply({ monthStart: MONTH, rows: wins }, EN));
    expect(text).toContain('Net +4.50R   Expectancy +1.50R   PF -   Max drawdown 0.00R');
  });
});

describe('the words', () => {
  it('both dictionaries have the same phrases (the type enforces it)', () => {
    expect(Object.keys(ALERT_WORDS.en).sort()).toEqual(Object.keys(ALERT_WORDS.hinglish).sort());
  });
});

describe('the look: tags and pictures, exactly', () => {
  const first = (reply: { text: string }): string => reply.text.split('\n')[0] ?? '';
  const MONTH = Date.UTC(2026, 9, 1);

  it('the title of every reply is bold behind its picture', () => {
    expect(first(helpReply(EN))).toBe(`${ICON.help} <b>COMMANDS</b>`);
    expect(first(statusReply(STATUS, EN))).toBe(`${ICON.status} <b>STATUS 12:40 IST</b>`);
    expect(first(openReply(OPEN, EN, 1))).toMatch(new RegExp(`^${ICON.open} <b>OPEN SIGNALS`));
    expect(first(todayReply({ at: AT, rows: [row({ seq: 1 })] }, EN))).toMatch(
      new RegExp(`^${ICON.today} <b>TODAY 23 Oct`),
    );
    expect(first(monthReply({ monthStart: MONTH, rows: [row({ seq: 1 })] }, EN))).toMatch(
      new RegExp(`^${ICON.month} <b>.*October 2026`),
    );
  });

  it('the status colours the feed, the engine and the next event', () => {
    const text = statusReply(STATUS, EN).text.split('\n');
    expect(text[1]).toBe(`${ICON.strong} Feed: LIVE, last tick 1 s ago, spread 0.180`);
    expect(text[2]).toBe(`${ICON.running} Engine: RUNNING`);
    expect(text[4]).toBe(
      `${ICON.macro} Next HIGH-impact event: US CPI m/m, 18:00 IST (in 5 h 20 min)`,
    );
    expect(text[6]).toBe('<b>Strategies:</b>');
    const down = (state: 'STALE' | 'DISCONNECTED' | 'MARKET_CLOSED') =>
      statusReply({ ...STATUS, feed: { state, tickAgeMs: 5000, spread: null } }, EN).text.split(
        '\n',
      )[1];
    expect(down('STALE')).toMatch(new RegExp(`^${ICON.weak} Feed: STALE`));
    expect(down('DISCONNECTED')).toMatch(new RegExp(`^${ICON.fail} Feed: DISCONNECTED`));
    expect(down('MARKET_CLOSED')).toMatch(new RegExp(`^${ICON.noData} Feed: MARKET CLOSED`));
    const paused = statusReply(
      { ...STATUS, engine: { status: 'PAUSED', since: AT - MIN, until: null } },
      EN,
    ).text.split('\n')[2];
    expect(paused).toBe(`${ICON.paused} Engine: PAUSED since 12:39 IST`);
  });

  it('every open signal starts with the colour of its side', () => {
    const sells = OPEN.lines.map((line) => ({ ...line, seq: 46, side: 'SELL' as const }));
    const text = openReply({ ...OPEN, lines: [...OPEN.lines, ...sells] }, EN, 2).text.split('\n');
    expect(text[1]).toMatch(new RegExp(`^${ICON.buy} #S-0045 BUY`));
    expect(text[text.length - 1]).toMatch(new RegExp(`^${ICON.sell} #S-0046 SELL`));
  });

  it('today marks every signal with its result, and the net result is bold', () => {
    const text = todayReply(
      {
        at: AT,
        rows: [
          row({ seq: 1, result: 'WIN', realizedRNet: 1.5 }),
          row({ seq: 2, result: 'LOSS', realizedRNet: -1 }),
          row({ seq: 3, result: null, countsInStats: false, realizedRNet: null }),
          row({ seq: 4, result: 'CANCELLED', countsInStats: false, realizedRNet: null }),
        ],
      },
      EN,
    ).text.split('\n');
    const rows = text.filter((line) => line.includes('#S-000'));
    expect(rows.map((line) => line.split(' ')[0])).toEqual([
      RESULT_ICON.WIN,
      RESULT_ICON.LOSS,
      RESULT_ICON.PENDING,
      RESULT_ICON.CANCELLED,
    ]);
    expect(text.at(-1)).toBe('<b>Net +0.50R</b>');
  });

  it('every reply is valid Telegram HTML in both languages, and not the plain fallback', () => {
    for (const options of [EN, HI]) {
      const replies = [
        helpReply(options),
        statusReply(STATUS, options),
        statusReply({ ...STATUS, feed: null, nextHigh: null, regime: null }, options),
        openReply(OPEN, options, 1),
        openReply({ ...OPEN, lines: [] }, options, 0),
        todayReply({ at: AT, rows: [row({ seq: 1 }), row({ seq: 2, result: null })] }, options),
        monthReply({ monthStart: MONTH, rows: [row({ seq: 1 }), row({ seq: 2 })] }, options),
      ];
      for (const reply of replies) {
        expect(checkTelegramHtml(reply.text), reply.text).toBeNull();
        expect(reply.text).not.toMatch(/[\uE000-\uE00F]/);
      }
      expect(statusReply(STATUS, options).text).toContain('<b>');
    }
  });

  it('text from outside, like the name of an event, cannot add a tag', () => {
    const reply = statusReply(
      { ...STATUS, nextHigh: { name: 'CPI \uE001forged\uE002 <b>x</b>', at: AT + 60 * MIN } },
      EN,
    );
    expect(reply.text).toContain('CPI forged &lt;b&gt;x&lt;/b&gt;, ');
    expect(reply.text).not.toContain('<b>forged');
    expect(checkTelegramHtml(reply.text)).toBeNull();
  });
});
