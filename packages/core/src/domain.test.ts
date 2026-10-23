import { describe, expect, it } from 'vitest';

import * as domain from './domain';

describe('domain vocabularies', () => {
  it('has no duplicate values in any tuple', () => {
    for (const [name, value] of Object.entries(domain)) {
      if (!Array.isArray(value)) continue;
      expect(new Set(value).size, name).toBe(value.length);
    }
  });

  it('has one strategy per doc strategy (A to E)', () => {
    expect(domain.STRATEGY_KEYS).toHaveLength(5);
  });

  it('has the nine blocking gates of the signal engine', () => {
    expect(domain.GATE_CODES).toHaveLength(9);
  });

  it('has the seven quality groups whose weights are defined in the config', () => {
    expect(domain.QUALITY_GROUPS).toHaveLength(7);
  });
});
