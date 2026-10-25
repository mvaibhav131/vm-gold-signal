import { COST_SCENARIOS, EVIDENCE_MIN_SAMPLE, type StrategyKey } from '@vmgs/core';

import type { GateVerdict } from './gate';
import type { BacktestRun, MetricRow } from './run';
import { SPLIT_KEYS, periodsThrough } from './splits';
import { SCENARIO_KEYS, type ScenarioKey } from './types';

export interface ReportMeta {
  readonly runId: string;
  readonly createdAt: string;
  readonly git: { readonly commit: string; readonly dirty: boolean };
  readonly files: readonly string[];
  readonly notes: string | null;
}

export const num = (value: number | null, decimals = 2): string =>
  value === null ? '-' : value.toFixed(decimals);
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const VERDICT_TEXT: Record<GateVerdict, string> = {
  PASS: 'PASS: positive net expectancy in A, B and C',
  COST_FRAGILE: 'COST FRAGILE: positive in A only, or too few trades left in B or C',
  FAIL: 'FAIL: expectancy is not positive in A',
  INSUFFICIENT: `INSUFFICIENT: fewer than ${String(EVIDENCE_MIN_SAMPLE)} trades in A`,
};

export function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

const rowOf = (
  run: BacktestRun,
  strategyKey: StrategyKey | 'ALL',
  period: string,
  scenario: ScenarioKey,
): MetricRow | undefined =>
  run.rows.find(
    (row) => row.strategyKey === strategyKey && row.period === period && row.scenario === scenario,
  );

function periodTable(run: BacktestRun, period: string): string[] {
  const keys: (StrategyKey | 'ALL')[] = [...run.strategies.map((s) => s.strategyKey), 'ALL'];
  const rows = keys.map((key) => {
    const [a, b, c] = SCENARIO_KEYS.map((scenario) => rowOf(run, key, period, scenario));
    const s = a?.stats;
    const win =
      s?.winRate == null || s.ci95 === null
        ? '-'
        : `${(s.winRate * 100).toFixed(1)}% (${(s.ci95[0] * 100).toFixed(0)}-${(s.ci95[1] * 100).toFixed(0)})`;
    const skipped = (row: MetricRow | undefined): string =>
      String(Object.values(row?.skipped ?? {}).reduce((sum, count) => sum + count, 0));
    return [
      key,
      String(a?.signals ?? 0),
      String(s?.n ?? 0),
      win,
      num(s?.expectancyR ?? null, 3),
      `${num(b?.stats.expectancyR ?? null, 3)} (n ${String(b?.stats.n ?? 0)})`,
      `${num(c?.stats.expectancyR ?? null, 3)} (n ${String(c?.stats.n ?? 0)})`,
      num(s?.profitFactor ?? null),
      num(s?.maxDrawdownR ?? null),
      `${skipped(b)} / ${skipped(c)}`,
    ];
  });
  return table(
    [
      'Strategy',
      'Signals',
      'Trades A',
      'Win rate A (95% CI)',
      'Exp. A (R)',
      'Exp. B',
      'Exp. C',
      'PF A',
      'Max DD A (R)',
      'Skipped B / C',
    ],
    rows,
  );
}

/** The written report of a backtest run (the first one is the evidence for the decision gate of `06`). */
export function renderReport(run: BacktestRun, meta: ReportMeta): string {
  const { replay, gate } = run;
  const out: string[] = [
    `# Backtest report ${meta.runId}`,
    '',
    `Made ${meta.createdAt} on commit ${meta.git.commit}${meta.git.dirty ? ' (with uncommitted changes)' : ''}. Data: HistData XAUUSD M1 bid bars, ${meta.files.join(', ')}, ${replay.firstAt === null ? 'no bars' : `${day(replay.firstAt)} to ${day(replay.lastAt ?? replay.firstAt)}`}, ${String(replay.bars)} bars.`,
    '',
    '## Decision gate',
    '',
    `Judged on the **${gate.period}** period${gate.outOfSample ? '' : ' (training: where parameters are chosen, so this is a description and no gate)'}${run.holdout ? ' (the test period was opened for this run)' : ' (the test period was not read)'}, in the three execution cost scenarios.`,
    '',
    ...table(
      ['Strategy', 'Verdict', 'Trades A / B / C', 'Expectancy A / B / C (R)'],
      gate.strategies.map((row) => [
        row.strategyKey,
        VERDICT_TEXT[row.verdict],
        SCENARIO_KEYS.map((key) => String(row.n[key])).join(' / '),
        SCENARIO_KEYS.map((key) => num(row.expectancyR[key], 3)).join(' / '),
      ]),
    ),
    '',
    gate.overall === 'PASS'
      ? `**Result: PASS.** ${gate.passed.join(', ')} show a positive net expectancy after costs in A, B and C on the ${gate.period} period. This is a first test on data that parameters were not tuned on; it is not proof of an edge: the forward test decides (\`02\` section 15). Five strategies were tried, which makes one good result more likely by chance.`
      : `**Result: no strategy shows a positive net expectancy after costs on the ${gate.period} period, in A, B and C.** ${gate.strategies.every((row) => row.verdict === 'INSUFFICIENT') ? 'Every strategy has too few trades to say anything either way; the numbers below are descriptions, not evidence.' : 'See the verdicts above.'} We decide together what to do (\`06\` section 1, "Decision gate after B28").`,
    '',
    '## What was run',
    '',
    `- Strategies: ${run.strategies.map((s) => `${s.strategyKey} ${s.version}`).join(', ')}.`,
    `- The engine of the live worker (\`DecisionEngine\`), fed the candles built from the minutes in the order they closed; the decision on the first bar at or after each 5m close; one signal for each setup, strategy and side.`,
    `- Spread: ${run.spreadUsd.toFixed(3)} USD, always (there are no recorded spreads for the past). The bars have bid prices; the ask is the bid plus the spread, and a SELL is followed on the ask.`,
    `- Split: ${SPLIT_KEYS.map((key) => `${key} ${day(run.split[key].from)} to ${key === 'TEST' ? 'the end' : day(run.split[key].until)}`).join('; ')}. The run went through ${run.through}${run.holdout ? ': the test period was opened for this run.' : `: no bar from ${day(run.split[run.through].until)} on was read.`}`,
    '',
    ...table(
      ['Scenario', 'Slippage (USD)', 'Delay (s)'],
      SCENARIO_KEYS.map((key) => [
        key,
        String(COST_SCENARIOS[key].simSlippageUsd),
        String(COST_SCENARIOS[key].execDelaySec),
      ]),
    ),
    '',
    'Limits of this test (bars, not ticks):',
    '- A stop and a target in the same minute: the stop is taken and the trade is flagged ambiguous.',
    '- A delayed fill (C) takes the price to have moved from the open of its minute towards the worst extreme by the share of the minute that has passed; a trade whose delayed price is beyond the maximum valid entry is skipped and counted.',
    '- No calendar, headline or feed state exists for the past: the news state is unknown (the quality score leaves that part out), no window is blocked, and the feed is taken to be healthy.',
    '- The spread percentile has no history (the quality score leaves it out); the evidence of a signal is always "insufficient".',
    '- A trade that meets five minutes without a bar closes as data invalid and is in no rate; a trade still open at the end of the data is in none either.',
    '- The open signals that a decision sees are those of scenario A that are still open.',
    '',
  ];

  for (const key of [...periodsThrough(run.split, run.through).map((p) => p.key), 'ALL']) {
    out.push(`## Results: ${key}`, '', ...periodTable(run, key), '');
  }

  const halves = run.periods.filter((period) => /^\d{4}H[12]$/.test(period.key));
  if (halves.length > 0) {
    out.push(
      '## Stability by half year (scenario A: trades, expectancy in R)',
      '',
      ...table(
        ['Half year', ...run.strategies.map((s) => s.strategyKey), 'ALL'],
        halves.map((period) => [
          period.key,
          ...[
            ...run.strategies.map((s) => s.strategyKey as StrategyKey | 'ALL'),
            'ALL' as const,
          ].map((key) => {
            const s = rowOf(run, key, period.key, 'A')?.stats;
            return s === undefined || s.n === 0 ? '-' : `${String(s.n)}, ${num(s.expectancyR, 2)}`;
          }),
        ]),
      ),
      '',
    );
  }

  const rejected = Object.entries(replay.rejectedBy).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  out.push(
    '## Why setups did not become signals',
    '',
    `The strategies found ${String(replay.setups)} setups on ${String(replay.closes)} closed 5m candles. ${String(replay.decisions)} were decided, ${String(replay.rejectedSetups)} setups were rejected, ${String(replay.duplicates)} were a repeat of a setup that already had a signal, ${String(replay.noQuote)} had no bar to decide on, and ${String(replay.signals.length)} became signals.`,
    '',
    ...(rejected.length === 0
      ? ['No setup was rejected.']
      : [
          'A setup can fail several gates, so the counts add up to more than the rejected setups.',
          '',
          ...table(
            ['Gate', 'Setups'],
            rejected.map(([code, count]) => [code, String(count)]),
          ),
        ]),
    '',
  );
  if (meta.notes !== null) out.push('## Notes', '', meta.notes, '');
  return out.join('\n');
}
