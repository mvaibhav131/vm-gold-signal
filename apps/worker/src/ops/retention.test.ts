import { describe, expect, it } from 'vitest';

import { DEFAULT_RETENTION, backupName, backupTime, planBackups } from './retention';

const AT = (iso: string) => Date.parse(iso);

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('backup names', () => {
  it('are the UTC time, so they sort in time order', () => {
    expect(backupName(AT('2026-10-26T02:00:00Z'))).toBe('vmgs-20261026T020000Z.dump.age');
    expect(backupName(AT('2026-10-26T02:00:00Z')) < backupName(AT('2026-11-01T00:00:00Z'))).toBe(
      true,
    );
  });

  it('give their time back', () => {
    const at = AT('2027-02-28T23:59:59Z');
    expect(backupTime(backupName(at))).toBe(at);
  });

  it('are refused when they are not ours or not a real time', () => {
    for (const name of [
      'vmgs-20261026T020000Z.dump',
      'vmgs-20261026T020000Z.dump.age.tmp',
      'other-20261026T020000Z.dump.age',
      'vmgs-20261326T020000Z.dump.age',
      'vmgs-20260230T020000Z.dump.age',
      'vmgs-20261026T250000Z.dump.age',
      '',
    ]) {
      expect(backupTime(name), name).toBeNull();
    }
  });
});

function nightly(from: string, days: number, hour = 2): string[] {
  const start = AT(from);
  return Array.from({ length: days }, (_, i) =>
    backupName(start + i * 86_400_000 + hour * 3_600_000),
  );
}

describe('planBackups', () => {
  it('keeps the last 7 days, 4 weeks and 3 months, and removes the rest', () => {
    // 2026-06-01 to 2026-10-26, one a night. 2026-10-26 is a Monday (ISO week 44).
    const names = nightly('2026-06-01T00:00:00Z', 148);
    expect(backupTime(names.at(-1) ?? '')).toBe(AT('2026-10-26T02:00:00Z'));
    const plan = planBackups(names);
    const dates = plan.keep.map((name) =>
      new Date(backupTime(name) ?? 0).toISOString().slice(0, 10),
    );
    expect(dates.toSorted()).toEqual([
      '2026-08-31', // month: the newest of August
      '2026-09-30', // month: the newest of September
      '2026-10-11', // week 41 (Sunday)
      '2026-10-18', // week 42 (Sunday)
      '2026-10-20', // the last 7 days
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25', // also the newest of week 43
      '2026-10-26', // also the newest of week 44 and of October
    ]);
    expect(plan.keep.length + plan.remove.length).toBe(148);
    expect(plan.ignored).toEqual([]);
  });

  it('keeps only the newest of a day that has several', () => {
    const plan = planBackups([
      'vmgs-20261026T010000Z.dump.age',
      'vmgs-20261026T020000Z.dump.age',
      'vmgs-20261026T030000Z.dump.age',
    ]);
    expect(plan.keep).toEqual(['vmgs-20261026T030000Z.dump.age']);
    expect(plan.remove).toEqual([
      'vmgs-20261026T020000Z.dump.age',
      'vmgs-20261026T010000Z.dump.age',
    ]);
  });

  it('counts days that have a backup, so an outage never deletes the only backups', () => {
    const names = [...nightly('2026-01-01T00:00:00Z', 3), ...nightly('2026-09-01T00:00:00Z', 2)];
    const plan = planBackups(names);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toHaveLength(5);
  });

  it('puts the end of a year in the right ISO week', () => {
    // 2026-12-31 (Thursday) and 2027-01-01 (Friday) are both in ISO week 53 of 2026; 2027-01-04 starts week 1.
    const plan = planBackups(
      ['2026-12-31T02:00:00Z', '2027-01-01T02:00:00Z', '2027-01-04T02:00:00Z'].map((iso) =>
        backupName(AT(iso)),
      ),
      { daily: 1, weekly: 2, monthly: 1 },
    );
    expect(plan.keep.map((name) => backupTime(name))).toEqual([
      AT('2027-01-04T02:00:00Z'),
      AT('2027-01-01T02:00:00Z'),
    ]);
    expect(plan.remove.map((name) => backupTime(name))).toEqual([AT('2026-12-31T02:00:00Z')]);
  });

  it('never touches a name that is not a backup of ours', () => {
    const plan = planBackups([
      'vmgs-20261026T020000Z.dump.age',
      'notes.txt',
      'vmgs-20261026T020000Z.manifest.json',
    ]);
    expect(plan.ignored.toSorted()).toEqual(['notes.txt', 'vmgs-20261026T020000Z.manifest.json']);
    expect(plan.remove).toEqual([]);
  });

  it('plans nothing for nothing', () => {
    expect(planBackups([])).toEqual({ keep: [], remove: [], ignored: [] });
  });

  it('treats a name listed twice as one', () => {
    const name = 'vmgs-20261026T020000Z.dump.age';
    expect(planBackups([name, name])).toEqual({ keep: [name], remove: [], ignored: [] });
  });

  it('is a function of the set of names (random sets, 300 runs)', () => {
    const { daily, weekly, monthly } = DEFAULT_RETENTION;
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = mulberry32(seed);
      const count = 1 + Math.floor(random() * 120);
      const names = Array.from({ length: count }, () =>
        backupName(AT('2026-01-01T00:00:00Z') + Math.floor(random() * 300 * 86_400_000)),
      );
      const plan = planBackups(names);
      const unique = [...new Set(names)];

      // nothing is lost or invented, and nothing is both kept and removed
      expect([...plan.keep, ...plan.remove].toSorted()).toEqual(unique.toSorted());
      expect(plan.keep.filter((name) => plan.remove.includes(name))).toEqual([]);
      // the newest backup is always kept, and the number kept is bounded by the policy
      expect(plan.keep[0]).toBe(unique.toSorted().at(-1));
      expect(plan.keep.length).toBeLessThanOrEqual(daily + weekly + monthly);
      // the order the names arrive in does not matter, and planning the kept names again changes nothing
      expect(planBackups(names.toReversed())).toEqual(plan);
      expect(planBackups(plan.keep).remove).toEqual([]);
    }
  });
});
