import { describe, expect, it } from 'vitest';

import { referenceOutcome } from './reference';
import { TradeTracker } from './tracker';
import { DECIDED_AT, flipPrice, flipSpec, specOf } from './test-data';
import type { QuoteTick, TradeOutcome } from './types';
import type { ExitProfile } from '../domain';

/** A small seeded random source, so that a failure can be replayed from its trial number. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const PROFILES: readonly ExitProfile[] = ['EP1_PARTIAL', 'EP2_SINGLE', 'EP3_STRUCTURE'];

interface Trial {
  readonly label: string;
  readonly side: 'BUY' | 'SELL';
  readonly profile: ExitProfile;
  readonly spec: ReturnType<typeof specOf>;
  readonly ticks: QuoteTick[];
  readonly maxGapMs: number;
}

function makeTrial(index: number): Trial {
  const rand = random(index * 7919 + 13);
  const side = rand() < 0.5 ? 'BUY' : 'SELL';
  const profile = PROFILES[Math.floor(rand() * PROFILES.length)] ?? 'EP1_PARTIAL';
  const risk = 2 + rand() * 10;
  const buy = specOf(
    {
      exitProfile: profile,
      timeStopMin: 3 + Math.floor(rand() * 40),
      commissionUsdPerOz: rand() < 0.5 ? 0 : rand() * 2,
    },
    {
      stopLoss: round3(4017.37 - risk),
      structureTarget: rand() < 0.3 ? null : 4017.37 + rand() * 40,
    },
  );
  const spec = side === 'BUY' ? buy : flipSpec(buy);

  const sigma = 0.1 + rand() * 0.8;
  const drift = (rand() - 0.5) * 0.1;
  const gapChance = rand() < 0.2 ? 0.01 : 0;
  const spread = 0.05 + rand() * 0.35;
  const ticks: QuoteTick[] = [];
  let t = spec.fillAt;
  let price = 4017.37;
  const until = spec.timeStopAt + 120_000;
  while (t < until) {
    const r = rand();
    // mostly a few seconds apart; sometimes exactly 60 s (still fine), sometimes more (a gap)
    if (r < gapChance) t += 61_000 + Math.floor(rand() * 30_000);
    else if (r < gapChance + 0.005) t += 60_000;
    else t += 1000 + Math.floor(rand() * 14_000);
    const step = (rand() + rand() + rand() - 1.5) * 2 * sigma + drift;
    price += rand() < 0.01 ? step * 8 : step;
    const closing = round3(price);
    ticks.push(
      side === 'BUY'
        ? { t, bid: closing, ask: round3(closing + spread) }
        : { t, ask: flipPrice(closing), bid: round3(flipPrice(closing) - spread) },
    );
  }
  return {
    label: `trial ${index} ${side} ${profile}`,
    side,
    profile,
    spec,
    ticks,
    maxGapMs: 60_000,
  };
}

function follow(trial: Trial): TradeOutcome | null {
  const tracker = new TradeTracker(trial.spec);
  for (const tick of trial.ticks) tracker.observeTick(tick);
  return tracker.outcome;
}

const within = (actual: number | null, expected: number | null, tolerance: number): boolean =>
  actual === null || expected === null
    ? actual === expected
    : Math.abs(actual - expected) <= tolerance + 1e-9;

describe('the tracker agrees with a first-passage reference over random tick paths', () => {
  const TRIALS = 4000;
  const counts = new Map<string, number>();

  it('on every trial: result, exit, time, R, excursions and flags', () => {
    for (let index = 0; index < TRIALS; index += 1) {
      const trial = makeTrial(index);
      const { label, spec } = trial;
      const outcome = follow(trial);
      const reference = referenceOutcome(spec, trial.ticks, trial.maxGapMs);

      if (reference === null) {
        expect(outcome, label).toBeNull();
        counts.set('OPEN', (counts.get('OPEN') ?? 0) + 1);
        continue;
      }
      expect(outcome, label).not.toBeNull();
      if (outcome === null) continue;
      const key = `${trial.side}/${trial.profile}/${reference.result}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      counts.set(reference.result, (counts.get(reference.result) ?? 0) + 1);

      expect(outcome.result, label).toBe(reference.result);
      expect(outcome.closedAt, label).toBe(reference.closedAt);
      expect(within(outcome.exitPrice, reference.exitPrice, 0.0005), `${label} exit`).toBe(true);
      expect(within(outcome.realizedRGross, reference.gross, 0.0005), `${label} gross`).toBe(true);
      expect(outcome.costR, label).toBeCloseTo(reference.gross === null ? 0 : spec.costR, 3);
      expect(
        within(
          outcome.realizedRNet,
          reference.gross === null ? null : reference.gross - spec.costR,
          0.0011,
        ),
        `${label} net`,
      ).toBe(true);
      expect(within(outcome.mfeR, reference.mfe, 0.0005), `${label} mfe`).toBe(true);
      expect(within(outcome.maeR, reference.mae, 0.0005), `${label} mae`).toBe(true);
      expect(outcome.tp1Hit, label).toBe(reference.tp1Hit);
      expect(outcome.tp2Hit, label).toBe(reference.tp2Hit);
      expect(outcome.ambiguous, label).toBe(false); // a tick is one price: nothing is ambiguous
      expect(outcome.countsInStats, label).toBe(reference.result !== 'DATA_INVALID');
      expect(outcome.isWin, label).toBe(
        outcome.countsInStats && outcome.realizedRNet !== null && outcome.realizedRNet > 0,
      );
      expect(outcome.mfeR ?? 0, label).toBeGreaterThanOrEqual(0);
      expect(outcome.maeR ?? 0, label).toBeLessThanOrEqual(0);
    }
  });

  it('reaches every kind of ending, on both sides and for every profile', () => {
    const count = (key: string) => counts.get(key) ?? 0;
    for (const result of ['WIN', 'PARTIAL_WIN', 'LOSS', 'TIME_EXIT', 'DATA_INVALID']) {
      expect(count(result), result).toBeGreaterThanOrEqual(30);
    }
    for (const side of ['BUY', 'SELL']) {
      for (const result of ['WIN', 'LOSS', 'TIME_EXIT', 'DATA_INVALID']) {
        for (const profile of PROFILES) {
          expect(
            count(`${side}/${profile}/${result}`),
            `${side} ${profile} ${result}`,
          ).toBeGreaterThanOrEqual(5);
        }
      }
      expect(
        count(`${side}/EP1_PARTIAL/PARTIAL_WIN`),
        `${side} PARTIAL_WIN`,
      ).toBeGreaterThanOrEqual(5);
    }
    expect(count('OPEN')).toBeLessThan(TRIALS / 2);
  });

  it('a path that never ends the trade leaves it open', () => {
    const spec = specOf({ timeStopMin: 60 });
    const tracker = new TradeTracker(spec);
    for (let i = 1; i <= 50; i += 1) {
      tracker.observeTick({ t: DECIDED_AT + i * 30_000, bid: 4017, ask: 4017.12 });
    }
    expect(tracker.outcome).toBeNull();
  });
});
