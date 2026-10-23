import { describe, expect, it } from 'vitest';

import type { Session } from '../domain';
import { sessionAt, sessionSegments, sessionWindowAt } from './sessions';

const utc = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;

function expectSessions(date: string, table: readonly (readonly [string, Session])[]) {
  for (const [time, expected] of table) {
    expect(sessionAt(utc(`${date}T${time}:00Z`)), `${date} ${time} UTC`).toBe(expected);
  }
}

describe('sessionAt', () => {
  it('winter (London on GMT, New York on EST): overlap 13:00-16:30 UTC', () => {
    expectSessions('2026-01-14', [
      ['00:00', 'ASIA'],
      ['07:59', 'ASIA'],
      ['08:00', 'LONDON'],
      ['12:59', 'LONDON'],
      ['13:00', 'OVERLAP'],
      ['16:29', 'OVERLAP'],
      ['16:30', 'NEW_YORK'],
      ['21:44', 'NEW_YORK'],
      ['21:45', 'ROLLOVER'], // wins over the last 15 minutes of New York (closes 22:00 UTC)
      ['22:30', 'ROLLOVER'],
      ['23:14', 'ROLLOVER'],
      ['23:15', 'ROLLOVER'], // between 23:15 and midnight no regular session is open
      ['23:59', 'ROLLOVER'],
    ]);
  });

  it('summer (London on BST, New York on EDT): overlap 12:00-15:30 UTC, London wins over Asia at 07:00', () => {
    expectSessions('2026-07-15', [
      ['00:00', 'ASIA'],
      ['06:59', 'ASIA'],
      ['07:00', 'LONDON'],
      ['07:59', 'LONDON'],
      ['11:59', 'LONDON'],
      ['12:00', 'OVERLAP'],
      ['15:29', 'OVERLAP'],
      ['15:30', 'NEW_YORK'],
      ['20:59', 'NEW_YORK'],
      ['21:00', 'ROLLOVER'], // New York closed at 17:00 EDT, the rollover window starts at 21:45
      ['21:44', 'ROLLOVER'],
      ['21:45', 'ROLLOVER'],
    ]);
  });

  it('the weeks when only one of the two zones has changed its clocks', () => {
    // 2026-03-17: New York on EDT since 8 March, London still on GMT until 29 March.
    // 2026-10-27: London back on GMT since 25 October, New York still on EDT until 1 November.
    for (const date of ['2026-03-17', '2026-10-27']) {
      expectSessions(date, [
        ['07:59', 'ASIA'],
        ['08:00', 'LONDON'],
        ['11:59', 'LONDON'],
        ['12:00', 'OVERLAP'],
        ['16:29', 'OVERLAP'],
        ['16:30', 'NEW_YORK'],
        ['20:59', 'NEW_YORK'],
        ['21:00', 'ROLLOVER'],
      ]);
    }
  });

  it('follows the local clock on the days the zones change', () => {
    // Monday after the UK clocks go forward (29 March): London opens at 07:00 UTC.
    expectSessions('2026-03-30', [
      ['06:59', 'ASIA'],
      ['07:00', 'LONDON'],
    ]);
    // Monday after the US clocks go back (1 November): New York opens at 13:00 UTC.
    expectSessions('2026-11-02', [
      ['12:59', 'LONDON'],
      ['13:00', 'OVERLAP'],
    ]);
  });

  it('has no London or New York session on weekends', () => {
    // Saturday 14:00 UTC and Sunday 14:00 UTC.
    expect(sessionAt(utc('2026-10-24T14:00:00Z'))).toBe('ROLLOVER');
    expect(sessionAt(utc('2026-10-25T14:00:00Z'))).toBe('ROLLOVER');
    // The Friday evening after New York has closed.
    expect(sessionAt(utc('2026-01-16T22:30:00Z'))).toBe('ROLLOVER');
  });

  it('classifies the Sunday evening reopening as rollover until the Asian day starts', () => {
    // Sunday 17:00 New York in winter is 22:00 UTC.
    expect(sessionAt(utc('2026-11-01T22:00:00Z'))).toBe('ROLLOVER');
    expect(sessionAt(utc('2026-11-02T00:00:00Z'))).toBe('ASIA');
  });
});

describe('sessionSegments', () => {
  const days = [
    '2026-01-14', // winter
    '2026-03-08', // US clocks go forward (Sunday)
    '2026-03-09',
    '2026-03-17', // US on summer time, UK not yet
    '2026-03-29', // UK clocks go forward (Sunday)
    '2026-03-30',
    '2026-07-15', // summer
    '2026-10-24', // Saturday
    '2026-10-25', // UK clocks go back (Sunday)
    '2026-10-27', // UK on winter time, US not yet
    '2026-11-01', // US clocks go back (Sunday)
    '2026-11-02',
  ];

  it.each(days)(
    '%s: covers the UTC day exactly, without overlaps or neighbours with the same label',
    (day) => {
      const start = utc(`${day}T00:00:00Z`);
      const segments = sessionSegments(start);
      expect(segments[0]?.startMs).toBe(start);
      expect(segments.at(-1)?.endMs).toBe(start + DAY);
      segments.forEach((segment, index) => {
        expect(segment.endMs).toBeGreaterThan(segment.startMs);
        const next = segments[index + 1];
        if (next) {
          expect(next.startMs).toBe(segment.endMs);
          expect(next.session).not.toBe(segment.session);
        }
      });
    },
  );

  it.each(days)('%s: agrees with sessionAt on every minute of the day', (day) => {
    const start = utc(`${day}T00:00:00Z`);
    const segments = sessionSegments(start);
    for (let minute = 0; minute < 1440; minute += 1) {
      const ms = start + minute * 60_000;
      const segment = segments.find((s) => ms >= s.startMs && ms < s.endMs);
      expect(segment?.session, `${day} minute ${String(minute)}`).toBe(sessionAt(ms));
    }
  });

  it('rejects an instant that is not midnight UTC', () => {
    expect(() => sessionSegments(utc('2026-01-14T00:00:01Z'))).toThrow(RangeError);
  });

  it('lists the winter day as the documented sequence', () => {
    const labels = sessionSegments(utc('2026-01-14T00:00:00Z')).map((s) => s.session);
    expect(labels).toEqual(['ASIA', 'LONDON', 'OVERLAP', 'NEW_YORK', 'ROLLOVER']);
  });
});

describe('sessionWindowAt', () => {
  it('gives the start and end of the current session', () => {
    const window = sessionWindowAt(utc('2026-01-14T14:00:00Z'));
    expect(window.session).toBe('OVERLAP');
    expect(new Date(window.startMs).toISOString()).toBe('2026-01-14T13:00:00.000Z');
    expect(new Date(window.endMs).toISOString()).toBe('2026-01-14T16:30:00.000Z');
  });

  it('moves the overlap one hour earlier in summer', () => {
    const window = sessionWindowAt(utc('2026-07-15T14:00:00Z'));
    expect(new Date(window.startMs).toISOString()).toBe('2026-07-15T12:00:00.000Z');
    expect(new Date(window.endMs).toISOString()).toBe('2026-07-15T15:30:00.000Z');
  });

  it('starts a session at its first instant and ends it exclusively', () => {
    const open = utc('2026-01-14T08:00:00Z');
    expect(sessionWindowAt(open).startMs).toBe(open);
    expect(sessionWindowAt(open - 1).session).toBe('ASIA');
    expect(sessionWindowAt(open - 1).endMs).toBe(open);
  });
});
