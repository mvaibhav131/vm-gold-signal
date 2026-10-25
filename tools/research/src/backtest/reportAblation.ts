import type { BacktestRun } from './run';
import type { VariantResult } from './command';
import { num, table, type ReportMeta } from './report';
import { SCENARIO_KEYS } from './types';

const rowOf = (run: BacktestRun, strategyKey: string, period: string, scenario: string) =>
  run.rows.find(
    (row) => row.strategyKey === strategyKey && row.period === period && row.scenario === scenario,
  );

/** One line for the result of a variant on a strategy. */
function resultText(verdict: VariantResult['verdicts'][number]): string {
  if (verdict.admitted) return 'ADMITTED';
  if (verdict.meetsCriteria) return 'better in sample (a tuning look, not an admission)';
  return `no: ${verdict.reasons[0] ?? 'not better'}`;
}

/**
 * The report of an ablation: the baseline and each variant on the same bars. On the training a variant that
 * meets the criteria is only a candidate; the admission needs a run through the validation (`02` section 15.1).
 */
export function renderAblation(
  baseline: BacktestRun,
  variants: readonly VariantResult[],
  meta: ReportMeta,
): string {
  const period = baseline.gate.period;
  const out: string[] = [
    `# Ablation ${meta.runId}`,
    '',
    `Made ${meta.createdAt} on commit ${meta.git.commit}${meta.git.dirty ? ' (with uncommitted changes)' : ''}. Compared on the **${period}** period; the runs went through ${baseline.through}.`,
    '',
    baseline.gate.outOfSample
      ? 'This period is out of sample: a variant that meets every criterion on it is admitted.'
      : 'This period is the training: a variant that is better here is a candidate to check on the validation, never an admission. Nothing after the end of the training was read.',
    '',
    `Strategies: ${baseline.strategies.map((s) => s.strategyKey).join(', ')}. Variants tried in this run: ${String(variants.length)}; every one is a trial of every strategy in the registry (\`trialsInFamily\`), and a result that rests on many trials is weaker than one that rests on one.`,
    '',
  ];

  variants.forEach((variant, index) => {
    out.push(
      `## Variant ${String(index + 1)}: ${variant.assignments.map((a) => `\`${a}\``).join(', ')}`,
      '',
      ...table(
        [
          'Strategy',
          'Baseline n A',
          'Baseline exp. A (R)',
          'Variant n A / B / C',
          'Variant exp. A / B / C (R)',
          'PF A (baseline to variant)',
          'Result',
        ],
        variant.verdicts.map((verdict) => {
          const [a, b, c] = verdict.rows;
          return [
            verdict.strategyKey,
            String(a?.baseline.n ?? 0),
            num(a?.baseline.expectancyR ?? null, 3),
            [a, b, c].map((row) => String(row?.variant.n ?? 0)).join(' / '),
            [a, b, c].map((row) => num(row?.variant.expectancyR ?? null, 3)).join(' / '),
            `${num(a?.baseline.profitFactor ?? null)} to ${num(a?.variant.profitFactor ?? null)}`,
            resultText(verdict),
          ];
        }),
      ),
      '',
    );
    const all = (run: BacktestRun, scenario: 'A' | 'B' | 'C') =>
      rowOf(run, 'ALL', period, scenario);
    out.push(
      `All strategies together on ${period}: baseline ${String(all(baseline, 'A')?.stats.n ?? 0)} trades, variant ${SCENARIO_KEYS.map((s) => `${s} ${String(all(variant.run, s)?.stats.n ?? 0)} trades at ${num(all(variant.run, s)?.stats.expectancyR ?? null, 3)} R`).join(', ')}.`,
      '',
    );
  });

  const halves = baseline.periods.filter((p) => /^\d{4}H[12]$/.test(p.key));
  if (halves.length > 0) {
    out.push(
      '## Signals per half year (all strategies, scenario A)',
      '',
      ...table(
        ['Half year', 'Baseline', ...variants.map((_, i) => `Variant ${String(i + 1)}`)],
        halves.map((half) => [
          half.key,
          String(rowOf(baseline, 'ALL', half.key, 'A')?.signals ?? 0),
          ...variants.map((variant) =>
            String(rowOf(variant.run, 'ALL', half.key, 'A')?.signals ?? 0),
          ),
        ]),
      ),
      '',
    );
  }
  if (meta.notes !== null) out.push('## Notes', '', meta.notes, '');
  return out.join('\n');
}
