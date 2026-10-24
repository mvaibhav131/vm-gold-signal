import { TRADED_SYMBOL } from '@vmgs/core';
import { Feed, SimulatedProvider } from '@vmgs/feed';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { MemoryRecorderStore } from './testing/memoryRecorderStore';
import { RecorderWorker } from './recorder';

const START_AT = Date.parse('2026-10-21T12:00:00Z');

export interface SoakReport {
  readonly simulatedSeconds: number;
  readonly elapsedMs: number;
  readonly providerQuotes: number;
  readonly normalizedTicks: number;
  readonly rejectedQuotes: number;
  readonly candleLateTicks: number;
  readonly persistedTicks: number;
  readonly persistedCandles: number;
  readonly persistedGaps: number;
  readonly feedState: string | null;
  readonly queuedFrames: number;
}

export async function runSoak(): Promise<SoakReport> {
  const startedAt = performance.now();
  const provider = new SimulatedProvider({
    speed: 'max',
    simulation: {
      seed: 123,
      startAt: START_AT,
      durationS: 600,
      ticksPerSecond: 2.4,
      faults: [
        { type: 'badTick', atS: 5, kind: 'crossed' },
        { type: 'stall', atS: 120, forS: 70 },
        { type: 'disconnect', atS: 300, forS: 20 },
      ],
    },
  });
  const store = new MemoryRecorderStore();
  const feed = new Feed({
    provider,
    symbols: [TRADED_SYMBOL],
    monitor: { isScheduledClosed: () => false },
  });
  const worker = new RecorderWorker({
    feed,
    store,
    symbols: [TRADED_SYMBOL],
    providerName: provider.name,
    batchSize: 500,
    maxQueuedFrames: 10_000,
    flushEveryMs: 60_000,
    heartbeatEveryMs: 60_000,
    partitionCheckEveryMs: 60_000,
    now: () => provider.clock.now(),
    onFatalError: (error) => {
      throw error;
    },
  });

  await worker.start();
  await provider.finished;
  await worker.stop();

  const stats = worker.stats;
  const rejectedQuotes = Object.values(stats.feed.rejected).reduce((sum, count) => sum + count, 0);
  const report: SoakReport = {
    simulatedSeconds: 600,
    elapsedMs: Math.round(performance.now() - startedAt),
    providerQuotes: stats.feed.received,
    normalizedTicks: stats.feed.accepted,
    rejectedQuotes,
    candleLateTicks: stats.lateByBuilders,
    persistedTicks: stats.persisted.ticks,
    persistedCandles: stats.persisted.candles,
    persistedGaps: store.gaps.size,
    feedState: stats.currentFeedState,
    queuedFrames: stats.queuedFrames,
  };
  if (
    report.providerQuotes <= 1_000 ||
    report.rejectedQuotes === 0 ||
    report.persistedTicks !== report.normalizedTicks ||
    report.persistedCandles === 0 ||
    report.persistedGaps === 0 ||
    report.candleLateTicks !== 0 ||
    report.queuedFrames !== 0
  ) {
    throw new Error(`recording soak did not meet its assertions: ${JSON.stringify(report)}`);
  }
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSoak()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
