import { defaultStrategyConfig } from '@vmgs/config';
import { DEFAULT_LATE_TOLERANCE_MS, DEFAULT_MAX_FUTURE_MS, STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_BIQUOTE } from './biquote';
import { DEFAULT_MONITOR } from './monitor';
import { DEFAULT_NORMALIZER } from './normalizer';

// The feed judges "fresh", "skewed" and "wide" before any strategy is loaded. These guards keep
// its defaults on the same numbers as the gates of docs/02 §2, so that the Health tab and the
// gates cannot disagree about the same tick.
describe('the feed defaults follow the strategy gates', () => {
  for (const key of STRATEGY_KEYS) {
    describe(key, () => {
      const { gates } = defaultStrategyConfig(key);

      it('calls a quote stale at the age that the gate refuses', () => {
        expect(DEFAULT_MONITOR.maxTickAgeMs).toBe(gates.maxTickAgeSec * 1000);
      });

      it('calls the clocks apart at the skew that the gate refuses', () => {
        expect(DEFAULT_MONITOR.maxClockSkewMs).toBe(gates.maxClockSkewSec * 1000);
      });

      it('opens a spread incident only above the spread that the gate refuses', () => {
        expect(DEFAULT_MONITOR.spreadSpikeUsd).toBeGreaterThan(gates.maxSpreadUsd);
      });
    });
  }
});

describe('the feed defaults follow the candle builder', () => {
  it('uses the same limit for a quote from the future', () => {
    expect(DEFAULT_NORMALIZER.maxFutureMs).toBe(DEFAULT_MAX_FUTURE_MS);
    expect(DEFAULT_MAX_FUTURE_MS).toBe(300_000);
  });

  it('uses the same limit for a quote that comes late', () => {
    expect(DEFAULT_NORMALIZER.maxLateMs).toBe(DEFAULT_LATE_TOLERANCE_MS);
    expect(DEFAULT_LATE_TOLERANCE_MS).toBe(2_000);
  });
});

describe('the defaults are consistent with each other', () => {
  it('pins the numbers of the live adapter', () => {
    expect(DEFAULT_BIQUOTE).toMatchObject({
      stallResubscribeMs: 30_000,
      stallReconnectMs: 60_000,
      marketPollMs: 30_000,
      healthyAfterMs: 10_000,
    });
    expect(DEFAULT_MONITOR.marketInfoMaxAgeMs).toBe(120_000);
  });

  it('gives a lost feed the time to be noticed before the first resubscribe', () => {
    expect(DEFAULT_MONITOR.maxTickAgeMs).toBeLessThan(DEFAULT_BIQUOTE.stallResubscribeMs);
    expect(DEFAULT_BIQUOTE.stallResubscribeMs).toBeLessThan(DEFAULT_BIQUOTE.stallReconnectMs);
  });

  it('believes what the provider said about the market for longer than it polls', () => {
    expect(DEFAULT_MONITOR.marketInfoMaxAgeMs).toBeGreaterThan(DEFAULT_BIQUOTE.marketPollMs);
  });

  it('keeps the incident grace shorter than the age at which a quote is stale', () => {
    expect(DEFAULT_MONITOR.incidentGraceMs).toBeLessThan(DEFAULT_MONITOR.maxTickAgeMs);
  });

  it('keeps the clock skew limit above the usual lag of a whole-second timestamp', () => {
    // live probe: the receive time minus the stamp is about 1 s for ticks cut to whole seconds
    expect(DEFAULT_MONITOR.maxClockSkewMs).toBeGreaterThan(2_000);
  });
});
