import { describe, expect, it } from 'vitest';

import type { Result } from '../domain';
import { ICON } from '../messages/style';
import { checkTelegramHtml } from '../messages/markup';
import { plain } from '../messages/test-html';
import type { DisplayOptions } from '../messages/types';
import {
  DAILY_DIGEST_TTL_MS,
  MONTHLY_REPORT_TTL_MS,
  dailyDigestEventKey,
  dailyDigestMessage,
  monthlyReportEventKey,
  monthlyReportMessage,
  type MonthlyReportData,
  type ReportRow,
} from './reports';
import { systemOutboxRows } from './system';

const EN: DisplayOptions = { locale: 'en', displayTz: 'Asia/Kolkata' };
const HI: DisplayOptions = { locale: 'hinglish', displayTz: 'Asia/Kolkata' };
const HOUR = 3_600_000;
/** 2026-10-23 06:10 UTC: a Friday morning of the trading day that ends on the 23rd at 17:00 New York. */
const AT = Date.UTC(2026, 9, 23, 6, 10);

let counter = 0;
function row(
  change: Partial<ReportRow> & { result: Result | null; net?: number | null },
): ReportRow {
  counter += 1;
  const { net, ...rest } = change;
  const counted =
    change.result !== null && change.result !== 'CANCELLED' && change.result !== 'DATA_INVALID';
  return {
    seq: counter,
    side: 'BUY',
    strategyKey: 'trend_pullback',
    generatedAt: AT,
    countsInStats: counted,
    realizedRNet: net === undefined ? (counted ? 1 : null) : net,
    durationS: 600,
    tp1Hit: false,
    tp2Hit: false,
    closedAt: AT + 600_000,
    primaryCause: null,
    session: 'LONDON',
    qualityScore: 78,
    weakGroups: [],
    ...rest,
  };
}

const lines = (text: string): string[] => plain(text).split('\n');

describe('the event keys', () => {
  it('name the report by its day or its month', () => {
    expect(dailyDigestEventKey('2026-10-23')).toBe('report:daily:20261023');
    expect(monthlyReportEventKey(2026, 10)).toBe('report:monthly:202610');
    expect(monthlyReportEventKey(2027, 1)).toBe('report:monthly:202701');
  });

  it('live 12 hours for a day and three days for a month', () => {
    expect(DAILY_DIGEST_TTL_MS).toBe(12 * HOUR);
    expect(MONTHLY_REPORT_TTL_MS).toBe(72 * HOUR);
  });
});

describe('DAILY_DIGEST', () => {
  const day = [
    row({ result: 'WIN', net: 1.47, seq: 42 }),
    row({
      result: 'LOSS',
      net: -1.04,
      seq: 43,
      side: 'SELL',
      primaryCause: 'NO_FOLLOW_THROUGH',
      weakGroups: ['trigger'],
    }),
    row({ result: null, seq: 44 }),
  ];

  it('says the signals, the valid results with their R, what is open, the net and the weakest group', () => {
    const message = dailyDigestMessage({ label: '2026-10-23', rows: day }, EN);
    expect(message.kind).toBe('DAILY_DIGEST');
    expect(lines(message.telegram.text)).toEqual([
      `${ICON.today} DAY SUMMARY 23 Oct: 3 signals, 2 valid results: 1 win +1.47R, 1 loss -1.04R. 1 still open.`,
      'Net +0.43R',
      'Top weak group today: Trigger and momentum.',
    ]);
    expect(message.push).toEqual({
      title: 'DAY SUMMARY 23 Oct',
      body: '2 valid results, net +0.43R.',
      urgency: 'normal',
      url: '/analytics',
    });
  });

  it('is written in Hinglish too, with the same numbers', () => {
    const text = lines(dailyDigestMessage({ label: '2026-10-23', rows: day }, HI).telegram.text);
    expect(text).toEqual([
      `${ICON.today} DIN KA SAAR 23 Oct: 3 signals, 2 valid results: 1 win +1.47R, 1 loss -1.04R. 1 abhi khula hai.`,
      'Net +0.43R',
      'Aaj sabse kamzor group: Trigger and momentum.',
    ]);
  });

  it('has every kind of valid result in the order of win, partial win, loss and time exit', () => {
    const rows = [
      row({ result: 'TIME_EXIT', net: -0.2 }),
      row({ result: 'LOSS', net: -1.0 }),
      row({ result: 'PARTIAL_WIN', net: 0.5 }),
      row({ result: 'LOSS', net: -0.9 }),
      row({ result: 'WIN', net: 2 }),
    ];
    const [first] = lines(dailyDigestMessage({ label: '2026-01-05', rows }, EN).telegram.text);
    expect(first).toContain(
      '5 signals, 5 valid results: 1 win +2.00R, 1 partial win +0.50R, 2 loss -1.90R, 1 time exit -0.20R.',
    );
    expect(first).toContain('DAY SUMMARY 5 Jan:');
    expect(first).not.toContain('still open');
  });

  it('says what was not counted, and has no net line when nothing counted', () => {
    const rows = [
      row({ result: 'CANCELLED' }),
      row({ result: 'DATA_INVALID' }),
      row({ result: null }),
    ];
    expect(lines(dailyDigestMessage({ label: '2026-10-23', rows }, EN).telegram.text)).toEqual([
      `${ICON.today} DAY SUMMARY 23 Oct: 3 signals, 0 valid results. 1 still open.`,
      'Not counted: 1 cancelled, 1 data invalid.',
    ]);
  });

  it('says "1 signal" and "1 valid result" for one, with the net of that one', () => {
    const [first, ...rest] = lines(
      dailyDigestMessage({ label: '2026-10-23', rows: [row({ result: 'WIN', net: 1 })] }, EN)
        .telegram.text,
    );
    expect(first).toContain('1 signal, 1 valid result: 1 win +1.00R.');
    expect(rest).toEqual(['Net +1.00R']);
  });

  it('says what was not counted when only one of the two kinds is there', () => {
    const only = (result: 'CANCELLED' | 'DATA_INVALID') =>
      lines(
        dailyDigestMessage({ label: '2026-10-23', rows: [row({ result })] }, EN).telegram.text,
      ).at(-1);
    expect(only('CANCELLED')).toBe('Not counted: 1 cancelled, 0 data invalid.');
    expect(only('DATA_INVALID')).toBe('Not counted: 0 cancelled, 1 data invalid.');
  });

  it('names the weak group that came up most, and the first of the groups when two tie', () => {
    const rows = [
      row({ result: 'LOSS', net: -1, weakGroups: ['volatility', 'execution'] }),
      row({ result: 'LOSS', net: -1, weakGroups: ['execution'] }),
      row({ result: 'LOSS', net: -1, weakGroups: ['trend'] }),
    ];
    expect(lines(dailyDigestMessage({ label: '2026-10-23', rows }, EN).telegram.text).at(-1)).toBe(
      'Top weak group today: Execution.',
    );
    const tie = [
      row({ result: 'LOSS', net: -1, weakGroups: ['reward'] }),
      row({ result: 'LOSS', net: -1, weakGroups: ['structure'] }),
    ];
    expect(
      lines(dailyDigestMessage({ label: '2026-10-23', rows: tie }, EN).telegram.text).at(-1),
    ).toBe('Top weak group today: Structure.');
  });

  it('is Telegram HTML that Telegram takes, with the title in bold', () => {
    for (const options of [EN, HI]) {
      const { text } = dailyDigestMessage({ label: '2026-10-23', rows: day }, options).telegram;
      expect(checkTelegramHtml(text)).toBeNull();
      expect(text).toContain('<b>');
    }
  });

  it('goes to the outbox under its key, for 12 hours', () => {
    const message = dailyDigestMessage({ label: '2026-10-23', rows: day }, EN);
    const [entry] = systemOutboxRows(
      message,
      dailyDigestEventKey('2026-10-23'),
      ['telegram'],
      AT,
      DAILY_DIGEST_TTL_MS,
    );
    expect(entry).toMatchObject({
      eventKey: 'report:daily:20261023',
      kind: 'DAILY_DIGEST',
      expiresAt: AT + 12 * HOUR,
    });
  });
});

describe('MONTHLY_REPORT', () => {
  /** 2026-10-01 00:00 IST. */
  const MONTH_START = Date.UTC(2026, 8, 30, 18, 30);

  /** A month: 12 results in London (7 winners), 9 in Asia (3 winners), 1 cancelled, 1 invalid, 1 open. */
  function month(): ReportRow[] {
    const rows: ReportRow[] = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push(
        row({
          result: i < 7 ? 'WIN' : 'LOSS',
          net: i < 7 ? 1.5 : -1,
          session: 'LONDON',
          qualityScore: i < 8 ? 80 : 70,
          primaryCause: i < 7 ? null : 'NORMAL_LOSS',
        }),
      );
    }
    for (let i = 0; i < 9; i += 1) {
      rows.push(
        row({
          result: i < 3 ? 'WIN' : 'LOSS',
          net: i < 3 ? 1.2 : -1,
          session: 'ASIA',
          qualityScore: 70,
          strategyKey: 'sweep_reversal',
          primaryCause: i < 3 ? null : 'NO_FOLLOW_THROUGH',
        }),
      );
    }
    rows.push(row({ result: 'CANCELLED' }), row({ result: 'DATA_INVALID' }), row({ result: null }));
    return rows;
  }

  const data = (change: Partial<MonthlyReportData> = {}): MonthlyReportData => ({
    monthStart: MONTH_START,
    rows: month(),
    feed: { incidents: 3, uptime: 0.992 },
    dbSizeBytes: 1_140_000_000,
    lastBackupAgeMs: 5 * HOUR,
    ...change,
  });

  it('has the lines of /month, then the sessions, the score check and the data', () => {
    const message = monthlyReportMessage(data(), EN);
    expect(message.kind).toBe('MONTHLY_REPORT');
    const text = lines(message.telegram.text);
    expect(text[0]).toBe(`${ICON.month} MONTHLY REPORT October 2026 (FORWARD-TEST)`);
    expect(text).toContain('Signals generated: 24');
    expect(text).toContain('Valid results: 21');
    expect(text).toContain('Cancelled: 1   Data invalid: 1   Still open: 1');
    expect(text.slice(-3)).toEqual([
      'Best session: London 58.3% (n=12, low sample). Worst: Asia 33.3% (n=9, low sample).',
      'Score check: quality 75+ won 87.5% (n=8); quality 65-74 won 23.1% (n=13).',
      'Data: feed uptime 99.2%, 3 incidents. Storage: DB 1.1 GB. Last backup OK.',
    ]);
    expect(message.push).toEqual({
      title: 'MONTHLY REPORT October 2026',
      body: '21 valid results, net +3.10R.',
      urgency: 'normal',
      url: '/analytics',
    });
  });

  it('is written in Hinglish too', () => {
    const text = lines(monthlyReportMessage(data(), HI).telegram.text);
    expect(text[0]).toBe(`${ICON.month} MAHINE KI REPORT October 2026 (FORWARD-TEST)`);
    expect(text.slice(-3)).toEqual([
      'Sabse achha session: London 58.3% (n=12, sample kam). Sabse kamzor: Asia 33.3% (n=9, sample kam).',
      'Score check: quality 75+ ne 87.5% jeeta (n=8); quality 65-74 ne 23.1% jeeta (n=13).',
      'Data: feed uptime 99.2%, 3 incidents. Storage: DB 1.1 GB. Last backup OK.',
    ]);
  });

  it('shows a session that has 30 results without the low sample label', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row({ result: i < 20 ? 'WIN' : 'LOSS', net: i < 20 ? 1 : -1, session: 'NEW_YORK' }),
    );
    const text = lines(monthlyReportMessage(data({ rows }), EN).telegram.text);
    expect(text).toContain('Best session: New York 66.7% (n=30).');
  });

  it('names one session when there is one, and the one that is worst when two have the same rate', () => {
    const one = lines(
      monthlyReportMessage(data({ rows: [row({ result: 'WIN', net: 1 })] }), EN).telegram.text,
    );
    expect(one.find((line) => line.startsWith('Best session'))).toBe(
      'Best session: London 100.0% (n=1, low sample).',
    );
    const level = [
      row({ result: 'WIN', net: 1, session: 'LONDON' }),
      row({ result: 'WIN', net: 1, session: 'ASIA' }),
      row({ result: 'WIN', net: 1, session: 'ASIA' }),
    ];
    const text = lines(monthlyReportMessage(data({ rows: level }), EN).telegram.text);
    expect(text.find((line) => line.startsWith('Best session'))).toBe(
      'Best session: Asia 100.0% (n=2, low sample).',
    );
  });

  it('has only the data line for a month without a valid result', () => {
    const rows = [row({ result: 'CANCELLED' }), row({ result: null })];
    const text = lines(monthlyReportMessage(data({ rows }), EN).telegram.text);
    expect(text).toEqual([
      `${ICON.month} MONTHLY REPORT October 2026 (FORWARD-TEST)`,
      'Signals generated: 2',
      'Cancelled: 1   Data invalid: 0   Still open: 1',
      'Valid results: 0',
      'Data: feed uptime 99.2%, 3 incidents. Storage: DB 1.1 GB. Last backup OK.',
    ]);
  });

  it('leaves out what it does not know: the uptime, the size of the database, the backup', () => {
    const text = lines(
      monthlyReportMessage(
        data({ feed: { incidents: 1, uptime: null }, dbSizeBytes: null, lastBackupAgeMs: null }),
        EN,
      ).telegram.text,
    );
    expect(text.at(-1)).toBe('Data: 1 incident.');
  });

  it('says how old a backup is when it is older than a day and a half', () => {
    const at = (age: number) =>
      lines(monthlyReportMessage(data({ lastBackupAgeMs: age }), EN).telegram.text).at(-1);
    expect(at(36 * HOUR)).toContain('Last backup OK.');
    expect(at(36 * HOUR + 60_000)).toMatch(/Last backup 36 h 1 min ago\.$/);
    expect(at(41 * HOUR)).toMatch(/Last backup 41 h ago\.$/);
  });

  it('puts a score below 65 in a band of its own', () => {
    const rows = [
      row({ result: 'WIN', net: 1, qualityScore: 60 }),
      row({ result: 'LOSS', net: -1, qualityScore: 80 }),
    ];
    const text = lines(monthlyReportMessage(data({ rows }), EN).telegram.text);
    expect(text).toContain(
      'Score check: quality 75+ won 0.0% (n=1); quality under 65 won 100.0% (n=1).',
    );
  });

  it('puts a score of exactly 75 in the top band and 65 in the middle one, and 74.9 and 64.9 one band lower', () => {
    const win = (qualityScore: number) => row({ result: 'WIN', net: 1, qualityScore });
    const loss = (qualityScore: number) => row({ result: 'LOSS', net: -1, qualityScore });
    const check = (rows: ReportRow[]) =>
      lines(monthlyReportMessage(data({ rows }), EN).telegram.text).find((line) =>
        line.startsWith('Score check'),
      );
    expect(check([win(75), loss(74.9)])).toBe(
      'Score check: quality 75+ won 100.0% (n=1); quality 65-74 won 0.0% (n=1).',
    );
    expect(check([win(65), loss(64.9)])).toBe(
      'Score check: quality 65-74 won 100.0% (n=1); quality under 65 won 0.0% (n=1).',
    );
  });

  it('counts a result of zero R as no winner in the sessions and the score check', () => {
    const rows = [
      row({ result: 'PARTIAL_WIN', net: 0, session: 'LONDON' }),
      row({ result: 'WIN', net: 1, session: 'LONDON' }),
    ];
    const text = lines(monthlyReportMessage(data({ rows }), EN).telegram.text);
    expect(text).toContain('Best session: London 50.0% (n=2, low sample).');
    expect(text).toContain('Score check: quality 75+ won 50.0% (n=2).');
  });

  it('is Telegram HTML that Telegram takes, in both languages, and short enough', () => {
    for (const options of [EN, HI]) {
      const { text, level, dropped } = monthlyReportMessage(data(), options).telegram;
      expect(checkTelegramHtml(text)).toBeNull();
      expect(text.length).toBeLessThan(3500);
      expect([level, dropped]).toEqual([0, []]);
    }
  });

  it('goes to the outbox under its key, for three days', () => {
    const message = monthlyReportMessage(data(), EN);
    const [entry] = systemOutboxRows(
      message,
      monthlyReportEventKey(2026, 10),
      ['telegram'],
      AT,
      MONTHLY_REPORT_TTL_MS,
    );
    expect(entry).toMatchObject({
      eventKey: 'report:monthly:202610',
      kind: 'MONTHLY_REPORT',
      expiresAt: AT + 72 * HOUR,
    });
  });
});
