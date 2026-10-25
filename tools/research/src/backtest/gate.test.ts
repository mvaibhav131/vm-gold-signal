import { describe, expect, it } from 'vitest';

import { evaluateGate, verdictOf } from './gate';
import { DEFAULT_SPLIT } from './splits';
import { signalOf } from './test-data';

const exp = (a: number | null, b: number | null, c: number | null) => ({ A: a, B: b, C: c });
const n = (a: number, b: number, c: number) => ({ A: a, B: b, C: c });

describe('verdictOf', () => {
  it('has nothing to say below 30 trades in A, whatever the numbers', () => {
    expect(verdictOf(n(29, 29, 29), exp(2, 2, 2))).toBe('INSUFFICIENT');
    expect(verdictOf(n(0, 0, 0), exp(null, null, null))).toBe('INSUFFICIENT');
  });

  it('passes with a positive expectancy in A, B and C on 30 trades each', () => {
    expect(verdictOf(n(30, 30, 30), exp(0.1, 0.05, 0.01))).toBe('PASS');
  });

  it('fails when A is not positive: zero is not positive', () => {
    expect(verdictOf(n(40, 40, 40), exp(0, 0.3, 0.3))).toBe('FAIL');
    expect(verdictOf(n(40, 40, 40), exp(-0.2, 0.3, 0.3))).toBe('FAIL');
  });

  it('is cost fragile when B or C is not positive', () => {
    expect(verdictOf(n(40, 40, 40), exp(0.2, 0, 0.3))).toBe('COST_FRAGILE');
    expect(verdictOf(n(40, 40, 40), exp(0.2, 0.3, -0.01))).toBe('COST_FRAGILE');
  });

  it('is cost fragile when the costs of B or C leave fewer than 30 trades', () => {
    expect(verdictOf(n(40, 29, 40), exp(0.2, 0.3, 0.3))).toBe('COST_FRAGILE');
    expect(verdictOf(n(40, 40, 29), exp(0.2, 0.3, 0.3))).toBe('COST_FRAGILE');
    expect(verdictOf(n(40, 0, 0), exp(0.2, null, null))).toBe('COST_FRAGILE');
  });
});

describe('evaluateGate', () => {
  const inValidation = Date.UTC(2025, 5, 1);
  const inTest = Date.UTC(2026, 5, 1);
  const many = (
    count: number,
    nets: [number, number, number],
    decidedAt: number,
    strategyKey: 'trend_pullback' | 'sweep_reversal' = 'trend_pullback',
  ) =>
    Array.from({ length: count }, (_, i) => signalOf(nets, { id: i + 1, decidedAt, strategyKey }));

  it('judges the validation period, by strategy, and passes when one strategy passes', () => {
    const signals = [
      ...many(30, [0.2, 0.1, 0.1], inValidation),
      ...many(30, [-0.2, -0.1, -0.1], inValidation, 'sweep_reversal'),
    ];
    const gate = evaluateGate(signals, DEFAULT_SPLIT, 'VALIDATION', [
      'trend_pullback',
      'sweep_reversal',
    ]);
    expect(gate.period).toBe('VALIDATION');
    expect(gate.outOfSample).toBe(true);
    expect(gate.strategies.map((row) => [row.strategyKey, row.verdict])).toEqual([
      ['trend_pullback', 'PASS'],
      ['sweep_reversal', 'FAIL'],
    ]);
    expect(gate).toMatchObject({ overall: 'PASS', passed: ['trend_pullback'] });
    expect(gate.strategies[0]).toMatchObject({
      n: { A: 30, B: 30, C: 30 },
      expectancyR: { A: 0.2, B: 0.1, C: 0.1 },
    });
  });

  it('says there is no edge when nothing passes', () => {
    const gate = evaluateGate(
      many(30, [0.2, -0.1, 0.1], inValidation),
      DEFAULT_SPLIT,
      'VALIDATION',
      ['trend_pullback'],
    );
    expect(gate).toMatchObject({ overall: 'NO_EDGE', passed: [] });
    expect(gate.strategies[0]?.verdict).toBe('COST_FRAGILE');
  });

  it('does not look at the training or the test period when the run goes through the validation', () => {
    const signals = [
      ...many(30, [0.2, 0.1, 0.1], Date.UTC(2023, 5, 1)),
      ...many(30, [0.2, 0.1, 0.1], inTest),
    ];
    const gate = evaluateGate(signals, DEFAULT_SPLIT, 'VALIDATION', ['trend_pullback']);
    expect(gate.strategies[0]?.n.A).toBe(0);
    expect(gate.strategies[0]?.verdict).toBe('INSUFFICIENT');
  });

  it('judges the test period, and only it, when the holdout is open', () => {
    const signals = [
      ...many(30, [0.2, 0.1, 0.1], inValidation),
      ...many(30, [-0.2, -0.1, -0.1], inTest),
    ];
    const gate = evaluateGate(signals, DEFAULT_SPLIT, 'TEST', ['trend_pullback']);
    expect(gate.period).toBe('TEST');
    expect(gate.strategies[0]?.verdict).toBe('FAIL');
  });

  it('is no gate on the training: it is in sample, and the verdicts are only a description', () => {
    const gate = evaluateGate(
      many(30, [0.2, 0.1, 0.1], Date.UTC(2023, 5, 1)),
      DEFAULT_SPLIT,
      'TRAIN',
      ['trend_pullback'],
    );
    expect(gate).toMatchObject({ period: 'TRAIN', outOfSample: false });
    expect(gate.strategies[0]?.n.A).toBe(30);
  });
});
