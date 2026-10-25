import { defaultSettings } from '@vmgs/config';
import {
  DAILY_DIGEST_TTL_MS,
  MONTHLY_REPORT_TTL_MS,
  tradingMsBetween,
  type AlertSettings,
  type ReportRow,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { plain } from '../../../../packages/core/src/messages/test-html';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { MemoryReportStore } from '../testing/memoryReportStore';
import { ReportScheduler } from './scheduler';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const utc = (iso: string): number => Date.parse(`${iso}Z`);

// January 2026: New York is UTC-5, so the trading day of Tuesday 6 January is 5 Jan 22:00 UTC to 6 Jan 22:00 UTC.
const DAY_START = utc('2026-01-05T22:00:00');
const DAY_END = utc('2026-01-06T22:00:00');
const DIGEST_AT = DAY_END + 10 * MINUTE;
// December in Kolkata (UTC+5:30) runs from 30 Nov 18:30 UTC to 31 Dec 18:30 UTC; its report is due 1 Jan 09:00 IST.
const DEC_START = utc('2025-11-30T18:30:00');
const DEC_END = utc('2025-12-31T18:30:00');
const REPORT_AT = utc('2026-01-01T03:30:00');

let seq = 0;
function signal(generatedAt: number, change: Partial<ReportRow> = {}): ReportRow {
  seq += 1;
  return {
    seq,
    side: 'BUY',
    strategyKey: 'trend_pullback',
    session: 'LONDON',
    qualityScore: 80,
    generatedAt,
    result: 'WIN',
    countsInStats: true,
    realizedRNet: 1.5,
    durationS: 600,
    tp1Hit: true,
    tp2Hit: true,
    closedAt: generatedAt + 10 * MINUTE,
    primaryCause: null,
    weakGroups: [],
    ...change,
  };
}

function rig(start: number, initial: AlertSettings = defaultSettings()) {
  const clock = { now: start };
  const state = { settings: initial };
  const store = new MemoryReportStore();
  const outbox = new MemoryOutboxStore();
  const woken = { count: 0 };
  const logs: string[] = [];
  const make = () =>
    new ReportScheduler({
      store,
      outbox,
      settings: () => Promise.resolve(state.settings),
      onQueued: () => {
        woken.count += 1;
      },
      now: () => clock.now,
      tickMs: 5,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
  const ofKind = (kind: string) => outbox.entries().filter((row) => row.kind === kind);
  return { clock, state, store, outbox, woken, logs, scheduler: make(), make, ofKind };
}

const textOf = (entry: { payload: Readonly<Record<string, unknown>> } | undefined): string =>
  plain(String(entry?.payload.text));

describe('ReportScheduler: the daily digest', () => {
  it('is made ten minutes after the trading day ends, not before', async () => {
    const { scheduler, store, clock, outbox } = rig(DAY_END + 10 * MINUTE - 1);
    store.signals.push(signal(utc('2026-01-06T08:00:00')));
    expect(await scheduler.runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(0);

    clock.now = DIGEST_AT;
    expect(await scheduler.runOnce()).toBe(1);
    const [entry] = outbox.entries();
    expect(entry).toMatchObject({
      eventKey: 'report:daily:20260106',
      channel: 'telegram',
      kind: 'DAILY_DIGEST',
      expiresAt: DIGEST_AT + DAILY_DIGEST_TTL_MS,
    });
    expect(textOf(entry)).toContain('DAY SUMMARY 6 Jan: 1 signal, 1 valid result: 1 win +1.50R.');
  });

  it('counts the signals of the trading day: it starts at 17:00 New York and ends at 17:00', async () => {
    const { scheduler, store, outbox } = rig(DIGEST_AT);
    store.signals.push(
      signal(DAY_START - 1),
      signal(DAY_START),
      signal(DAY_END - 1),
      signal(DAY_END),
    );
    await scheduler.runOnce();
    expect(textOf(outbox.entries()[0])).toContain('2 signals, 2 valid results');
  });

  it('sends nothing for a day without a signal, and does not look at that day again', async () => {
    const { scheduler, store, clock, outbox } = rig(DIGEST_AT);
    expect(await scheduler.runOnce()).toBe(0);
    const reads = store.rowReads;
    clock.now += 5 * MINUTE;
    await scheduler.runOnce();
    expect(store.rowReads).toBe(reads);
    expect(outbox.entries()).toHaveLength(0);

    // the next day is a new period
    store.signals.push(signal(utc('2026-01-07T09:00:00')));
    clock.now = DIGEST_AT + 24 * HOUR;
    expect(await scheduler.runOnce()).toBe(1);
    expect(outbox.entries()[0]?.eventKey).toBe('report:daily:20260107');
  });

  it('is queued once: a second look and a restarted worker queue nothing new', async () => {
    const { scheduler, make, store, outbox, woken, clock } = rig(DIGEST_AT);
    store.signals.push(signal(utc('2026-01-06T08:00:00')));
    expect(await scheduler.runOnce()).toBe(1);
    clock.now += HOUR;
    expect(await scheduler.runOnce()).toBe(0);
    expect(await make().runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(1);
    expect(woken.count).toBe(1);
  });

  it('tells the sender only when something was queued', async () => {
    const { scheduler, woken } = rig(DIGEST_AT);
    await scheduler.runOnce();
    expect(woken.count).toBe(0);
  });

  it('says what is still open and what was weak at entry', async () => {
    const { scheduler, store, outbox } = rig(DIGEST_AT);
    store.signals.push(
      signal(utc('2026-01-06T08:00:00'), {
        result: 'LOSS',
        realizedRNet: -1,
        weakGroups: ['trigger'],
      }),
      signal(utc('2026-01-06T10:00:00'), {
        result: null,
        realizedRNet: null,
        countsInStats: false,
      }),
    );
    await scheduler.runOnce();
    const text = textOf(outbox.entries()[0]);
    expect(text).toContain('1 still open.');
    expect(text).toContain('Top weak group today: Trigger and momentum.');
  });

  it('follows the language and the channels of the settings', async () => {
    const base = defaultSettings() as AlertSettings;
    const { scheduler, store, outbox, state } = rig(DIGEST_AT);
    store.signals.push(signal(utc('2026-01-06T08:00:00')));
    state.settings = {
      ...base,
      locale: 'hinglish',
      alerts: {
        telegram: { ...base.alerts.telegram, enabled: false },
        webpush: { enabled: true, minGrade: 'Moderate' },
      },
    };
    await scheduler.runOnce();
    const [entry, ...others] = outbox.entries();
    expect(others).toHaveLength(0);
    expect(entry).toMatchObject({ channel: 'webpush', kind: 'DAILY_DIGEST' });
    expect(entry?.payload.title).toBe('DIN KA SAAR 6 Jan');
  });

  it('respects a Telegram kind that is switched off', async () => {
    const base = defaultSettings() as AlertSettings;
    const { scheduler, store, outbox } = rig(DIGEST_AT, {
      ...base,
      alerts: {
        ...base.alerts,
        telegram: {
          ...base.alerts.telegram,
          kinds: base.alerts.telegram.kinds.filter((kind) => kind !== 'DAILY_DIGEST'),
        },
      },
    });
    store.signals.push(signal(utc('2026-01-06T08:00:00')));
    expect(await scheduler.runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(0);
  });

  it('sends only the day that has just ended after the worker was away for days', async () => {
    const { scheduler, store, outbox } = rig(DIGEST_AT + 3 * 24 * HOUR);
    store.signals.push(signal(utc('2026-01-06T08:00:00')), signal(utc('2026-01-09T08:00:00')));
    await scheduler.runOnce();
    expect(outbox.entries().map((row) => row.eventKey)).toEqual(['report:daily:20260109']);
  });

  it('is still made an hour late, when the worker was away for an hour', async () => {
    const { scheduler, store, outbox } = rig(DIGEST_AT + HOUR);
    store.signals.push(signal(utc('2026-01-06T08:00:00')));
    await scheduler.runOnce();
    expect(outbox.entries().map((row) => row.eventKey)).toEqual(['report:daily:20260106']);
  });
});

describe('ReportScheduler: the monthly report', () => {
  const december = () => [
    signal(utc('2025-12-15T10:00:00')),
    signal(utc('2025-12-20T10:00:00'), { result: 'LOSS', realizedRNet: -1 }),
    // the last second of December and the first of January in Kolkata
    signal(DEC_END - 1, { result: 'LOSS', realizedRNet: -1 }),
    signal(DEC_END),
  ];

  it('is made from 09:00 of the display zone on the 1st, for the month that ended', async () => {
    const { scheduler, store, clock, ofKind } = rig(REPORT_AT - 1);
    store.signals.push(...december());
    await scheduler.runOnce();
    expect(ofKind('MONTHLY_REPORT')).toHaveLength(0);

    clock.now = REPORT_AT;
    await scheduler.runOnce();
    const [entry, ...others] = ofKind('MONTHLY_REPORT');
    expect(others).toHaveLength(0);
    expect(entry).toMatchObject({
      eventKey: 'report:monthly:202512',
      channel: 'telegram',
      expiresAt: REPORT_AT + MONTHLY_REPORT_TTL_MS,
    });
    const text = textOf(entry);
    expect(text).toContain('MONTHLY REPORT December 2025 (FORWARD-TEST)');
    // the second of Kolkata's January is not in the month
    expect(text).toContain('Signals generated: 3');
  });

  it('has the data of the month: the uptime of the feed, the size of the database, the backup', async () => {
    const { scheduler, store, ofKind } = rig(REPORT_AT);
    store.signals.push(...december());
    // 12 hours of December without a feed, on a Wednesday, and an incident that is still open at the end of the month (6 hours)
    store.feed.push(
      { startedAt: utc('2025-12-10T06:00:00'), endedAt: utc('2025-12-10T18:00:00') },
      { startedAt: DEC_END - 6 * HOUR, endedAt: null },
    );
    store.size = 2_340_000_000;
    store.backupAt = REPORT_AT - 5 * HOUR;
    await scheduler.runOnce();
    const uptime = ((1 - (18 * HOUR) / tradingMsBetween(DEC_START, DEC_END)) * 100).toFixed(1);
    expect(textOf(ofKind('MONTHLY_REPORT')[0])).toContain(
      `Data: feed uptime ${uptime}%, 2 incidents. Storage: DB 2.3 GB. Last backup OK.`,
    );
  });

  it('says how old the backup is when it is older than a day and a half', async () => {
    const { scheduler, store, ofKind } = rig(REPORT_AT);
    store.signals.push(...december());
    store.backupAt = REPORT_AT - 40 * HOUR;
    await scheduler.runOnce();
    expect(textOf(ofKind('MONTHLY_REPORT')[0])).toMatch(/Last backup 40 h ago\.$/);
  });

  it('follows the Telegram switch of its own kind, not the one of the digest', async () => {
    const base = defaultSettings() as AlertSettings;
    const without = (kind: 'DAILY_DIGEST' | 'MONTHLY_REPORT'): AlertSettings => ({
      ...base,
      alerts: {
        ...base.alerts,
        telegram: {
          ...base.alerts.telegram,
          kinds: base.alerts.telegram.kinds.filter((item) => item !== kind),
        },
      },
    });
    const digestOff = rig(REPORT_AT, without('DAILY_DIGEST'));
    digestOff.store.signals.push(...december());
    await digestOff.scheduler.runOnce();
    expect(digestOff.ofKind('MONTHLY_REPORT')).toHaveLength(1);

    const reportOff = rig(REPORT_AT, without('MONTHLY_REPORT'));
    reportOff.store.signals.push(...december());
    await reportOff.scheduler.runOnce();
    expect(reportOff.ofKind('MONTHLY_REPORT')).toHaveLength(0);
    expect(reportOff.ofKind('DAILY_DIGEST')).toHaveLength(1);
  });

  it('leaves out the backup when none is known', async () => {
    const { scheduler, store, ofKind } = rig(REPORT_AT);
    store.signals.push(...december());
    await scheduler.runOnce();
    expect(textOf(ofKind('MONTHLY_REPORT')[0])).toMatch(/Data: .*DB 1\.1 GB\.$/);
  });

  it('is queued once, also after a restart, and the month is not read again', async () => {
    const { scheduler, make, store, clock, ofKind } = rig(REPORT_AT);
    store.signals.push(...december());
    await scheduler.runOnce();
    const reads = store.rowReads;
    clock.now += 6 * HOUR;
    await scheduler.runOnce();
    expect(store.rowReads).toBe(reads);
    expect(await make().runOnce()).toBe(0);
    expect(ofKind('MONTHLY_REPORT')).toHaveLength(1);
  });

  it('is made at the first look after 09:00 when the worker was away on the 1st', async () => {
    const { scheduler, store, ofKind } = rig(utc('2026-01-09T12:00:00'));
    store.signals.push(...december());
    await scheduler.runOnce();
    expect(ofKind('MONTHLY_REPORT').map((row) => row.eventKey)).toEqual(['report:monthly:202512']);
  });

  it('is not made for a month that is long past, or one without a signal', async () => {
    const { scheduler, store, ofKind } = rig(utc('2026-03-05T12:00:00'));
    store.signals.push(...december());
    await scheduler.runOnce();
    expect(ofKind('MONTHLY_REPORT')).toHaveLength(0);
  });

  it('is written in the language of the settings', async () => {
    const base = defaultSettings() as AlertSettings;
    const { scheduler, store, ofKind } = rig(REPORT_AT, { ...base, locale: 'hinglish' });
    store.signals.push(...december());
    await scheduler.runOnce();
    expect(textOf(ofKind('MONTHLY_REPORT')[0])).toContain(
      'MAHINE KI REPORT December 2025 (FORWARD-TEST)',
    );
  });

  it('follows the display zone: the month and the hour are those of New York', async () => {
    const base = defaultSettings() as AlertSettings;
    // 1 Jan 09:00 in New York is 14:00 UTC; a signal at 02:00 UTC on 1 Jan is still 31 Dec there
    const { scheduler, store, clock, ofKind } = rig(utc('2026-01-01T13:59:59'), {
      ...base,
      displayTz: 'America/New_York',
    });
    store.signals.push(signal(utc('2026-01-01T02:00:00')));
    await scheduler.runOnce();
    expect(ofKind('MONTHLY_REPORT')).toHaveLength(0);
    clock.now = utc('2026-01-01T14:00:00');
    await scheduler.runOnce();
    expect(textOf(ofKind('MONTHLY_REPORT')[0])).toContain('Signals generated: 1');
  });
});

describe('ReportScheduler: failures and the loop', () => {
  it('logs a failing database, does not queue a half report, and tries again at the next look', async () => {
    const { scheduler, store, outbox, logs } = rig(DIGEST_AT);
    store.signals.push(signal(utc('2026-01-06T08:00:00')));
    store.failNextRows = true;
    expect(await scheduler.runOnce()).toBe(0);
    expect(logs).toEqual(['error: the daily digest could not be made']);
    expect(outbox.entries()).toHaveLength(0);
    expect(await scheduler.runOnce()).toBe(1);
  });

  it('runs on its own loop and stops', async () => {
    const { scheduler, store, clock, outbox, logs } = rig(DIGEST_AT);
    store.signals.push(signal(utc('2026-01-06T08:00:00')));
    store.failNextRows = true;
    scheduler.start();
    scheduler.start();
    await expect.poll(() => outbox.entries().length).toBe(1);
    await scheduler.stop();
    expect(logs[0]).toContain('the daily digest could not be made');

    store.signals.push(signal(utc('2026-01-07T08:00:00')));
    clock.now += 24 * HOUR;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(outbox.entries()).toHaveLength(1);
  });
});
