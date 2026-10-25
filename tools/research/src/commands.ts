import { GATE_DEFAULTS, type HigherTimeframe } from '@vmgs/core';

import { planBootstrap } from './bootstrap/plan';
import type { BootstrapStore } from './bootstrap/store';
import type { HistSource } from './histdata/archive';
import { gapReport, type GapReport } from './histdata/gaps';
import { importHistData, type ImportReport, type ImportResult } from './histdata/import';
import { SpreadModel } from './spread/model';

export type Print = (line: string) => void;

/** The spread model rests on the recorded spreads of this many days. */
export const SPREAD_WINDOW_DAYS = 90;

const DAY_MS = 86_400_000;
/** More than this many trading hours between the history and the live data is a jump the indicators will feel. */
const JUNCTION_WARNING_HOURS = 24;
/** A hole inside the history of more than this many hours of open market (five days; a holiday is shorter) is a missing month. */
const HOLE_WARNING_HOURS = 120;

const stamp = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;

export function reportLines(report: ImportReport, gaps: GapReport): string[] {
  const lines = [
    `${report.format === 'M1' ? 'M1 bars (bid only: mid = bid + the spread model)' : 'ticks (bid and ask)'} from ${String(report.files.length)} file(s)`,
    `rows ${String(report.rows)}, accepted ${String(report.accepted)}`,
  ];
  if (report.reordered > 0) {
    lines.push(
      `${String(report.reordered)} accepted rows came behind a later minute and were put in their place`,
    );
  }
  const rejected = Object.entries(report.rejected);
  if (rejected.length > 0) {
    lines.push(
      `rejected: ${rejected.map(([reason, count]) => `${reason} ${String(count)}`).join(', ')}`,
    );
    for (const sample of report.samples) {
      lines.push(`  ${sample.file}:${String(sample.line)} ${sample.reason}: ${sample.text}`);
    }
  }
  if (report.firstAt !== null && report.lastAt !== null) {
    lines.push(
      `from ${stamp(report.firstAt)} to ${stamp(report.lastAt)}: ${String(report.minutes)} minutes, ` +
        (Object.entries(report.candles) as [HigherTimeframe, number][])
          .map(([tf, count]) => `${tf} ${String(count)}`)
          .join(', '),
    );
  }
  lines.push(
    `gaps: ${String(gaps.weekend)} weekend, ${String(gaps.dailyBreak)} daily break, ` +
      `${String(gaps.feed)} other (${String(gaps.missingFeedMinutes)} minutes missing), coverage ${gaps.coveragePct.toFixed(2)}%`,
  );
  for (const gap of gaps.longest) {
    lines.push(`  ${stamp(gap.startMs)} to ${stamp(gap.endMs)}: ${String(gap.minutes)} minutes`);
  }
  for (const gap of gaps.longest) {
    const hours = gap.minutes / 60;
    if (hours <= HOLE_WARNING_HOURS) continue;
    lines.push(
      `WARNING: a hole of ${(hours / 24).toFixed(1)} trading days from ${stamp(gap.startMs)} to ${stamp(gap.endMs)}: ` +
        'the indicators will see it as one jump. Download the missing months of HistData and import them together with the others.',
    );
  }
  return lines;
}

function summary(result: ImportResult): string[] {
  return reportLines(result.report, gapReport(result.minutes));
}

/** Reads the files and tells what is in them, with no database. Returns false when nothing could be read. */
export function checkCommand(sources: readonly HistSource[], print: Print): boolean {
  const model = SpreadModel.from([]);
  const result = importHistData(sources, { spreadAt: (ms) => model.spreadAt(ms) });
  for (const line of summary(result)) print(line);
  return result.report.accepted > 0;
}

export interface ImportCommand {
  readonly sources: readonly HistSource[];
  readonly store: BootstrapStore;
  readonly dryRun: boolean;
  readonly now: number;
  readonly print: Print;
}

/** Imports the history into the candle tables, before the first live minute, and says whether it is enough for the warm-up. */
export async function importCommand(command: ImportCommand): Promise<boolean> {
  const { store, print } = command;
  const model = SpreadModel.from(await store.spreadRows(command.now - SPREAD_WINDOW_DAYS * DAY_MS));
  const result = importHistData(command.sources, { spreadAt: (ms) => model.spreadAt(ms) });
  for (const line of summary(result)) print(line);
  if (result.report.accepted === 0) return false;

  const plan = planBootstrap(result.candles, await store.liveFrom());
  if (plan.overlapsLive > 0) {
    print(`${String(plan.overlapsLive)} candles overlap the live data and are left out`);
  }
  if (command.dryRun) {
    print(`dry run: ${String(plan.write.length)} candles would be written`);
  } else {
    const added = await store.write(plan.write);
    print(
      `written ${String(added)} new candles (${String(plan.write.length - added)} were already there)`,
    );
  }

  const have = (tf: HigherTimeframe): number =>
    plan.write.filter((candle) => candle.tf === tf).length;
  const need = GATE_DEFAULTS.warmupCandles;
  const enough = (['5m', '15m', '1h'] as const).every((tf) => have(tf) >= (need[tf] ?? 0));
  print(
    `warm-up needs ${String(need['5m'])} 5m, ${String(need['15m'])} 15m and ${String(need['1h'])} 1h candles; ` +
      `the history has ${String(have('5m'))}, ${String(have('15m'))} and ${String(have('1h'))}: ` +
      (enough ? 'enough' : 'not enough on its own (live candles add to it)'),
  );
  if (plan.junction !== null && plan.junction.tradingHours > JUNCTION_WARNING_HOURS) {
    print(
      `WARNING: ${plan.junction.tradingHours.toFixed(0)} trading hours lie between the end of this history ` +
        `(${stamp(plan.junction.fromMs)}) and the first live candle (${stamp(plan.junction.toMs)}); the ` +
        'indicators will see that hole as one jump. Import a newer month or wait until the live data fills it.',
    );
  }
  return true;
}

export interface SpreadCommand {
  readonly store: BootstrapStore;
  readonly now: number;
  readonly print: Print;
}

/** Prints the spread model as the database gives it. */
export async function spreadCommand(command: SpreadCommand): Promise<void> {
  const rows = await command.store.spreadRows(command.now - SPREAD_WINDOW_DAYS * DAY_MS);
  const model = SpreadModel.from(rows);
  command.print(
    `spread by UTC hour from ${String(rows.reduce((sum, row) => sum + row.n, 0))} recorded 5m candles ` +
      `of the last ${String(SPREAD_WINDOW_DAYS)} days (default ${model.fallback.toFixed(3)} where nothing is recorded)`,
  );
  for (const line of model.describe()) command.print(line);
}
