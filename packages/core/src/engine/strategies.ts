import type { Regime, StrategyKey } from '../domain';
import type { SetupSource } from '../explain/setupFacts';
import { ConfluenceStrategy } from '../strategies/confluence/tracker';
import { HourlyTrendStrategy } from '../strategies/hourlyTrend/tracker';
import { PatternBreakoutStrategy } from '../strategies/patternBreakout/tracker';
import { SqueezeRetestStrategy } from '../strategies/squeezeRetest/tracker';
import { SweepReversalStrategy } from '../strategies/sweepReversal/tracker';
import { TrendPullbackStrategy } from '../strategies/trendPullback/tracker';
import { TrendlineRetestStrategy } from '../strategies/trendlineRetest/tracker';
import type { StrategySetup } from '../strategies/types';
import type { LiquidityLevel } from '../structure/sweeps';
import type { EngineCandle, EngineTimeframe, StrategySpec } from './types';

/** What a strategy found on the newest 5m candle. */
export interface Found {
  readonly setup: StrategySetup;
  readonly source: SetupSource;
  readonly sweptLevelId: string | null;
  readonly structureTarget: number | null;
}

/** A strategy and the way the engine feeds it: every strategy reads the timeframes it needs and ignores the others. */
export interface StrategyRunner {
  readonly key: StrategyKey;
  /** `levels` are the liquidity levels that apply to a 5m candle (only strategy B reads them). */
  push(tf: EngineTimeframe, candle: EngineCandle, levels: readonly LiquidityLevel[]): void;
  find(regime: Regime | null): Found | null;
}

/** The strategy of a spec, as a runner. */
export function runnerOf(spec: StrategySpec): StrategyRunner {
  switch (spec.strategyKey) {
    case 'trend_pullback': {
      const strategy = new TrendPullbackStrategy(spec.params);
      return {
        key: spec.strategyKey,
        push: (tf, candle) => {
          strategy.update(tf, candle);
        },
        find: () => {
          const setup = strategy.evaluate()?.setup ?? null;
          return setup === null
            ? null
            : {
                setup,
                source: { strategyKey: 'trend_pullback', facts: setup.facts },
                sweptLevelId: null,
                structureTarget: null,
              };
        },
      };
    }
    case 'sweep_reversal': {
      const strategy = new SweepReversalStrategy(spec.params);
      return {
        key: spec.strategyKey,
        push: (tf, candle, levels) => {
          if (tf === '15m') strategy.updateQuarter(candle);
          else if (tf === '5m') strategy.updateFive(candle, levels);
        },
        find: (regime) => {
          const setup = strategy.evaluate(regime)?.setup ?? null;
          return setup === null
            ? null
            : {
                setup,
                source: { strategyKey: 'sweep_reversal', facts: setup.facts },
                sweptLevelId: setup.facts.levelId,
                structureTarget: null,
              };
        },
      };
    }
    case 'squeeze_retest': {
      const strategy = new SqueezeRetestStrategy(spec.params);
      return {
        key: spec.strategyKey,
        push: (tf, candle) => {
          if (tf === '15m') strategy.updateQuarter(candle);
          else if (tf === '5m') strategy.updateFive(candle);
        },
        find: () => {
          const setup = strategy.evaluate()?.setup ?? null;
          return setup === null
            ? null
            : {
                setup,
                source: { strategyKey: 'squeeze_retest', facts: setup.facts },
                sweptLevelId: null,
                structureTarget: null,
              };
        },
      };
    }
    case 'trendline_retest': {
      const strategy = new TrendlineRetestStrategy(spec.params);
      return {
        key: spec.strategyKey,
        push: (tf, candle) => {
          if (tf === '1h') strategy.updateHour(candle);
          else if (tf === '15m') strategy.updateQuarter(candle);
          else strategy.updateFive(candle);
        },
        find: () => {
          const setup = strategy.evaluate()?.setup ?? null;
          return setup === null
            ? null
            : {
                setup,
                source: { strategyKey: 'trendline_retest', facts: setup.facts },
                sweptLevelId: null,
                structureTarget: null,
              };
        },
      };
    }
    case 'pattern_breakout': {
      const strategy = new PatternBreakoutStrategy(spec.params);
      return {
        key: spec.strategyKey,
        push: (tf, candle) => {
          if (tf === '15m') strategy.updateQuarter(candle);
          else if (tf === '5m') strategy.updateFive(candle);
        },
        find: () => {
          const setup = strategy.evaluate()?.setup ?? null;
          return setup === null
            ? null
            : {
                setup,
                source: { strategyKey: 'pattern_breakout', facts: setup.facts },
                sweptLevelId: null,
                structureTarget: setup.facts.target,
              };
        },
      };
    }
    case 'hourly_trend': {
      const strategy = new HourlyTrendStrategy(spec.params);
      return {
        key: spec.strategyKey,
        push: (tf, candle) => {
          if (tf !== '15m') strategy.update(tf, candle);
        },
        find: () => {
          const setup = strategy.evaluate()?.setup ?? null;
          return setup === null
            ? null
            : {
                setup,
                source: { strategyKey: 'hourly_trend', facts: setup.facts },
                sweptLevelId: null,
                structureTarget: null,
              };
        },
      };
    }
    case 'confluence': {
      const strategy = new ConfluenceStrategy(spec.params);
      return {
        key: spec.strategyKey,
        push: (tf, candle) => {
          strategy.update(tf, candle);
        },
        find: () => {
          const setup = strategy.evaluate()?.setup ?? null;
          return setup === null
            ? null
            : {
                setup,
                source: { strategyKey: 'confluence', facts: setup.facts },
                sweptLevelId: null,
                structureTarget: null,
              };
        },
      };
    }
  }
}
