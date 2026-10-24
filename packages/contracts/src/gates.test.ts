import {
  ADVISORY_FLAGS,
  ADVISORY_SWITCHES,
  GATE_CODES,
  evaluateGates,
  gateWaitReasons,
  storedGates,
  warmupProgress,
  type MarketGateInputs,
  type SetupGateInputs,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { engineSnapshotSchema, settingsSchema, waitReasonSchema } from './api';
import { advisoryFlagSchema } from './enums';
import { gateResultSchema } from './signal';

const NOW = Date.UTC(2026, 0, 14, 14, 0);

const market: MarketGateInputs = {
  feed: { connected: true, tickAgeMs: 2_000, providerStale: false, marketState: 'OPEN' },
  candles: { '5m': 900, '15m': 1440, '1h': 600 },
  requiredTimeframes: ['5m', '15m', '1h'],
  clockSkewMs: 900,
  spread: 0.2,
  fiveMinuteOpenTimes: Array.from({ length: 20 }, (_, i) => NOW - (19 - i) * 300_000),
  decisionOpenTime: NOW,
};

const setup: SetupGateInputs = {
  regime: 'TREND_UP',
  acceptedRegimes: ['TREND_UP'],
  atr5: 2,
  stopDistance: 3,
  tp1Distance: 3,
  qualityScore: 72,
  qualityCoverage: 1,
};

describe('what the gates of core hand to the contracts', () => {
  it('the stored gates of a passing signal are valid gate results, one for each code', () => {
    const stored = storedGates(evaluateGates(market, setup).results);
    const parsed = z.array(gateResultSchema).parse(stored);
    expect(parsed.map((g) => g.code).sort()).toEqual([...GATE_CODES].sort());
  });

  it('the stored gates of a failed gate are valid too: the extra detail is left out', () => {
    const failed = evaluateGates(
      { ...market, candles: { '5m': 10, '15m': 1440, '1h': 600 } },
      setup,
    );
    const warmup = storedGates(failed.results).find((g) => g.code === 'WARMUP_OK');
    expect(gateResultSchema.parse(warmup)).toEqual({
      code: 'WARMUP_OK',
      passed: false,
      value: 67,
      limit: 100,
    });
  });

  it('the warm-up progress is the warm-up block of the engine snapshot', () => {
    const progress = warmupProgress({ '5m': 450, '15m': 0, '1h': 600 }, ['5m', '15m', '1h']);
    const block = engineSnapshotSchema.shape.warmup.parse(progress);
    expect(block).toEqual({ ready: false, progressPct: 50, missingTimeframes: ['5m', '15m'] });
  });

  it('the wait reasons of the failed gates are wait reasons of the engine snapshot', () => {
    const failed = evaluateGates({ ...market, spread: 0.9 }, { ...setup, regime: 'RANGE' });
    const reasons = gateWaitReasons(failed.results, { regime: 'RANGE' });
    expect(reasons).toHaveLength(2);
    expect(z.array(waitReasonSchema).parse(reasons)).toEqual(reasons);
  });

  it('the owner switches are the keys of the advisory gates of the settings', () => {
    expect(Object.keys(settingsSchema.shape.advisoryGates.shape)).toEqual([...ADVISORY_SWITCHES]);
  });

  it('every advisory flag of core is a flag of the contract', () => {
    for (const flag of ADVISORY_FLAGS) expect(advisoryFlagSchema.parse(flag)).toBe(flag);
  });
});
