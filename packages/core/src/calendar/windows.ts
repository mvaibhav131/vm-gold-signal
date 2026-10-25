import type { MacroEventInput, NewsWindowSpec } from '../context/macro';

/**
 * One window out of the `gates.newsWindow` of several strategies: the longest time before and
 * after, and every impact and currency that any of them counts. The alerts and the polling have
 * to cover all of them, not only the first.
 */
export function mergeNewsWindows(specs: readonly NewsWindowSpec[]): NewsWindowSpec {
  if (specs.length === 0) throw new RangeError('at least one news window is needed');
  return {
    before: Math.max(...specs.map((spec) => spec.before)),
    after: Math.max(...specs.map((spec) => spec.after)),
    impact: [...new Set(specs.flatMap((spec) => spec.impact))],
    currency: [...new Set(specs.flatMap((spec) => spec.currency))],
  };
}

/** The event is of an impact and a currency that opens this news window. */
export function opensWindow(event: MacroEventInput, spec: NewsWindowSpec): boolean {
  return (
    spec.impact.includes(event.importance) &&
    event.currency !== null &&
    spec.currency.includes(event.currency)
  );
}
