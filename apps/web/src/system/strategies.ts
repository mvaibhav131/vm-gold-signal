import type { Evidence } from '@vmgs/contracts';
import type { StrategyStatus } from '@vmgs/core';

import type { Tone } from '../format/format';
import { formatInterval, formatPercent, scopeText } from '../format/signal';

export const STATUS_LABELS: Readonly<Record<StrategyStatus, string>> = {
  RESEARCH: 'Research',
  BACKTESTED: 'Backtested',
  FORWARD_TESTING: 'Forward testing',
  VALIDATED: 'Validated',
  PAUSED: 'Paused',
  DRIFTED: 'Drifted',
};

export const STATUS_TONE: Readonly<Record<StrategyStatus, Tone>> = {
  RESEARCH: 'neutral',
  BACKTESTED: 'info',
  FORWARD_TESTING: 'brand',
  VALIDATED: 'positive',
  PAUSED: 'warning',
  DRIFTED: 'warning',
};

/**
 * What a strategy knows about its own track record, in one line. A win rate only from 30
 * results (rule C6): below that the count and the words "insufficient evidence".
 */
export function evidenceLine(evidence: Evidence | null): string {
  if (evidence === null) return 'No evidence yet';
  const source = scopeText(evidence.scope);
  if (evidence.winRate === null || evidence.ci === null) {
    return `n=${String(evidence.n)}, insufficient evidence (${source})`;
  }
  const low = evidence.sampleLabel === 'LOW_SAMPLE' ? ', low sample' : '';
  return `${formatPercent(evidence.winRate)} win rate (95% CI ${formatInterval(evidence.ci)}), n=${String(evidence.n)}, ${source}${low}`;
}
