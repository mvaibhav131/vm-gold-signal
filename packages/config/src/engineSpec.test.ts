import { STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { strategySpecOf } from './engineSpec';
import { advisoryModesOf, gateParamsOf, requiredTimeframes } from './gateParams';
import { qualityWeightsOf, riskParamsOf } from './riskParams';
import { defaultStrategyConfig } from './strategy';
import { trendPullbackParamsOf } from './trendPullbackParams';

describe('the spec of a strategy version, as the decision engine reads it', () => {
  it.each(STRATEGY_KEYS)(
    '%s: has the numbers of its config in the shapes the engine reads',
    (key) => {
      const config = defaultStrategyConfig(key);
      const spec = strategySpecOf(config, 'FORWARD_TESTING');
      expect(spec).toMatchObject({
        strategyKey: key,
        version: config.version,
        status: 'FORWARD_TESTING',
        acceptedRegimes: config.acceptedRegimes,
        newsWindow: config.gates.newsWindow,
      });
      expect(spec.gates).toEqual(gateParamsOf(config));
      expect(spec.requiredTimeframes).toEqual(requiredTimeframes(config));
      expect(spec.modes).toEqual(advisoryModesOf(config));
      expect(spec.risk).toEqual(riskParamsOf(config));
      expect(spec.weights).toEqual(qualityWeightsOf(config));
    },
  );

  it('carries the rules of the strategy, converted by its own function', () => {
    const config = defaultStrategyConfig('trend_pullback');
    const spec = strategySpecOf(config, 'VALIDATED');
    expect(spec.status).toBe('VALIDATED');
    expect(spec.params).toEqual(trendPullbackParamsOf(config));
  });

  it('follows the config: a changed number is a changed spec', () => {
    const config = defaultStrategyConfig('pattern_breakout');
    if (config.strategyKey !== 'pattern_breakout') throw new Error('the wrong strategy');
    const changed = { ...config, params: { ...config.params, minMeasuredMoveR: 2.2 } };
    const spec = strategySpecOf(changed, 'RESEARCH');
    expect(spec.strategyKey).toBe('pattern_breakout');
    if (spec.strategyKey === 'pattern_breakout') {
      expect(spec.params.minMeasuredMoveR).toBe(2.2);
    }
  });
});
