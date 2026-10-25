import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryMaintenanceStore } from '../testing/memoryMaintenanceStore';
import { MaintenanceRunner } from './runner';
import type { JobResult, MaintenanceJob } from './store';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** 2026-10-25 02:00 UTC: before the time of the night's jobs. */
const T0 = Date.UTC(2026, 9, 25, 2, 0, 0);
const ONE_NIGHT = (day: number, hour: number, minute = 0): number =>
  Date.UTC(2026, 9, day, hour, minute, 0);

class FakeJob implements MaintenanceJob {
  runs: number[] = [];
  result: JobResult = { ok: true, rowsDeleted: 5, record: true, details: { fake: true } };
  failure: Error | null = null;
  constructor(readonly name: string) {}
  run(now: number): Promise<JobResult> {
    this.runs.push(now);
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(this.result);
  }
}

function rig(
  options: {
    nightly?: FakeJob[];
    hourly?: FakeJob[];
    nightlyAtUtc?: { hour: number; minute: number };
  } = {},
) {
  const clock = { now: T0 };
  const runs = new MemoryMaintenanceStore();
  const reconcile = new FakeJob('rollup_reconcile');
  const retention = new FakeJob('retention');
  const nightly = options.nightly ?? [reconcile, retention];
  const hourly = options.hourly ?? [new FakeJob('size_guard')];
  const logs: string[] = [];
  const runner = new MaintenanceRunner({
    nightly,
    hourly,
    runs,
    now: () => clock.now,
    tickMs: 5,
    ...(options.nightlyAtUtc === undefined ? {} : { nightlyAtUtc: options.nightlyAtUtc }),
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  return { clock, runs, nightly, hourly, logs, runner, reconcile, retention };
}

describe('MaintenanceRunner: when the nightly jobs are due', () => {
  it('is 03:30 UTC of today from that time on, and of yesterday before it', () => {
    const { runner } = rig();
    expect(runner.nightlyDueAt(ONE_NIGHT(25, 3, 29))).toBe(ONE_NIGHT(24, 3, 30));
    expect(runner.nightlyDueAt(ONE_NIGHT(25, 3, 30))).toBe(ONE_NIGHT(25, 3, 30));
    expect(runner.nightlyDueAt(ONE_NIGHT(25, 23, 59))).toBe(ONE_NIGHT(25, 3, 30));
    expect(runner.nightlyDueAt(ONE_NIGHT(26, 0, 0))).toBe(ONE_NIGHT(25, 3, 30));
    expect(runner.nightlyDueAt(Date.UTC(2026, 11, 31, 23, 0))).toBe(Date.UTC(2026, 11, 31, 3, 30));
    expect(runner.nightlyDueAt(Date.UTC(2027, 0, 1, 1, 0))).toBe(Date.UTC(2026, 11, 31, 3, 30));
  });

  it('can be set to another time of night', () => {
    const { runner } = rig({ nightlyAtUtc: { hour: 1, minute: 5 } });
    expect(runner.nightlyDueAt(ONE_NIGHT(25, 1, 4))).toBe(ONE_NIGHT(24, 1, 5));
    expect(runner.nightlyDueAt(ONE_NIGHT(25, 1, 5))).toBe(ONE_NIGHT(25, 1, 5));
  });
});

describe('MaintenanceRunner.runDue', () => {
  it('runs the nightly jobs in order the first time it looks (a worker that was down catches up), and the guard', async () => {
    const { runner, runs, nightly, hourly, clock } = rig();
    expect(await runner.runDue()).toEqual(['rollup_reconcile', 'retention', 'size_guard']);
    expect(nightly.map((job) => job.runs)).toEqual([[T0], [T0]]);
    expect(hourly[0]?.runs).toEqual([T0]);
    expect(
      runs.runs.map((run) => [run.job, run.startedAt, run.finishedAt, run.rowsDeleted]),
    ).toEqual([
      ['rollup_reconcile', T0, clock.now, 5],
      ['retention', T0, clock.now, 5],
      ['size_guard', T0, clock.now, 5],
    ]);
    expect(runs.runs[0]?.details).toEqual({ fake: true });
  });

  it('does not run a job again in the same night, also not after a restart (the log says it finished)', async () => {
    const { runner, clock, runs, nightly } = rig();
    await runner.runDue();
    clock.now = T0 + 20 * 60_000;
    expect(await runner.runDue()).toEqual([]);
    const restarted = new MaintenanceRunner({
      nightly,
      hourly: [],
      runs,
      now: () => clock.now,
    });
    expect(await restarted.runDue()).toEqual([]);
    expect(nightly.map((job) => job.runs.length)).toEqual([1, 1]);
  });

  it('runs them again once the night after has begun, and not a minute before', async () => {
    const { runner, clock, nightly } = rig();
    await runner.runDue();
    clock.now = ONE_NIGHT(25, 3, 29);
    expect(await runner.runDue()).toEqual(['size_guard']);
    clock.now = ONE_NIGHT(25, 3, 30);
    // the jobs finished at 02:00 today: before 03:30, so they are due again
    expect(await runner.runDue()).toEqual(['rollup_reconcile', 'retention']);
    clock.now = ONE_NIGHT(26, 3, 29);
    expect(await runner.runDue()).toEqual(['size_guard']);
    clock.now = ONE_NIGHT(26, 3, 30);
    expect(await runner.runDue()).toEqual(['rollup_reconcile', 'retention']);
    expect(nightly[1]?.runs).toEqual([T0, ONE_NIGHT(25, 3, 30), ONE_NIGHT(26, 3, 30)]);
  });

  it('runs the guard when it starts and then every hour', async () => {
    const { runner, clock, hourly } = rig({ nightly: [] });
    await runner.runDue();
    clock.now += HOUR - 1;
    await runner.runDue();
    expect(hourly[0]?.runs).toHaveLength(1);
    clock.now += 1;
    await runner.runDue();
    clock.now += HOUR;
    await runner.runDue();
    expect(hourly[0]?.runs).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR]);
  });

  it('records a run of the guard only when it says it did something', async () => {
    const guard = new FakeJob('size_guard');
    guard.result = { ok: true, rowsDeleted: 0, record: false, details: {} };
    const { runner, runs, clock } = rig({ nightly: [], hourly: [guard] });
    await runner.runDue();
    expect(runs.runs).toEqual([]);
    guard.result = {
      ok: true,
      rowsDeleted: 0,
      record: true,
      dbSizeBytes: 42,
      details: { acted: true },
    };
    clock.now += HOUR;
    await runner.runDue();
    expect(runs.runs).toEqual([
      {
        job: 'size_guard',
        startedAt: clock.now,
        finishedAt: clock.now,
        rowsDeleted: 0,
        dbSizeBytes: 42,
        details: { acted: true },
      },
    ]);
  });

  it('records a job that throws as a failed run, goes on with the others, and tries it again after half an hour', async () => {
    const { runner, runs, reconcile, clock, logs } = rig();
    reconcile.failure = new Error('the database is down');
    expect(await runner.runDue()).toEqual(['rollup_reconcile', 'retention', 'size_guard']);
    expect(runs.runs[0]).toEqual({
      job: 'rollup_reconcile',
      startedAt: T0,
      finishedAt: null,
      rowsDeleted: 0,
      dbSizeBytes: null,
      details: { error: 'the database is down' },
    });
    expect(runs.runs[1]).toMatchObject({ job: 'retention', finishedAt: T0 });
    expect(logs).toEqual(['error: a maintenance job failed']);

    clock.now = T0 + 29 * 60_000;
    expect(await runner.runDue()).toEqual([]);
    reconcile.failure = null;
    clock.now = T0 + 30 * 60_000;
    expect(await runner.runDue()).toEqual(['rollup_reconcile']);
    expect(
      runs.runs.filter((run) => run.job === 'rollup_reconcile').map((run) => run.finishedAt),
    ).toEqual([null, T0 + 30 * 60_000]);
    clock.now = T0 + 31 * 60_000;
    expect(await runner.runDue()).toEqual([]);
  });

  it('records a job that did not finish all its steps as a failure too, and tries it again', async () => {
    const { runner, runs, retention, clock } = rig();
    retention.result = {
      ok: false,
      rowsDeleted: 3,
      record: true,
      details: { errors: [{ step: 'candles1m' }] },
    };
    await runner.runDue();
    expect(runs.runs[1]).toMatchObject({ job: 'retention', finishedAt: null, rowsDeleted: 3 });
    expect(await runner.runDue()).toEqual([]);
    retention.result = { ok: true, rowsDeleted: 9, record: true, details: {} };
    clock.now = T0 + 30 * 60_000;
    expect(await runner.runDue()).toEqual(['retention']);
    expect(await runner.runDue()).toEqual([]);
  });

  it('records a job that did not finish all its steps as a failure even when it says it is not worth a row', async () => {
    const { runner, runs, retention } = rig();
    retention.result = { ok: false, rowsDeleted: 0, record: false, details: { errors: [] } };
    await runner.runDue();
    expect(runs.runs.filter((run) => run.job === 'retention')).toEqual([
      expect.objectContaining({ finishedAt: null }),
    ]);
  });

  it('survives a log that cannot be read or written', async () => {
    const { runner, runs, nightly, logs } = rig();
    runs.logFails = true;
    expect(await runner.runDue()).toEqual(['size_guard']);
    expect(nightly.map((job) => job.runs.length)).toEqual([0, 0]);
    expect(logs).toContain('error: the maintenance log could not be read');
    expect(logs).toContain('error: a maintenance run could not be recorded');
  });
});

describe('MaintenanceRunner, running', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('looks at the clock again and again, runs what falls due, and stops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const guard = new FakeJob('size_guard');
    const runs = new MemoryMaintenanceStore();
    const runner = new MaintenanceRunner({
      nightly: [],
      hourly: [guard],
      runs,
      tickMs: 60_000,
      log: () => undefined,
    });
    runner.start();
    runner.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(guard.runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HOUR + 60_000);
    expect(guard.runs).toHaveLength(2);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(guard.runs).toHaveLength(2);
  });

  it('stops at once, also while a job is running', async () => {
    const slow = new FakeJob('slow');
    let release: () => void = () => undefined;
    slow.run = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ ok: true, rowsDeleted: 0, record: false, details: {} });
        };
      });
    const runner = new MaintenanceRunner({
      nightly: [],
      hourly: [slow],
      runs: new MemoryMaintenanceStore(),
      tickMs: 5,
    });
    runner.start();
    await vi.waitFor(() => {
      expect(release).not.toBe(undefined);
    });
    const stopping = runner.stop();
    release();
    await stopping;
  });

  it('logs a look that fails and goes on', async () => {
    const logs: string[] = [];
    const broken = new MemoryMaintenanceStore();
    const runner = new MaintenanceRunner({
      nightly: [],
      hourly: [{ name: 'x', run: () => Promise.reject(new Error('boom')) }],
      runs: broken,
      tickMs: 5,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
    runner.start();
    await vi.waitFor(() => {
      expect(logs).toContain('error: a maintenance job failed');
    });
    await runner.stop();
    expect(DAY).toBe(86_400_000);
  });
});
