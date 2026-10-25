import { defaultStrategyConfig } from '@vmgs/config';
import { describe, expect, it } from 'vitest';

import { parseAssignment, variantOf } from './variant';

const BASE = defaultStrategyConfig('trend_pullback');

describe('parseAssignment', () => {
  it('reads a number, a boolean, a list and plain text as what they are', () => {
    expect(parseAssignment('quality.min=70')).toEqual({ path: ['quality', 'min'], value: 70 });
    expect(parseAssignment('a.b=true').value).toBe(true);
    expect(parseAssignment('gates.stopAtr=[1,2]').value).toEqual([1, 2]);
    expect(parseAssignment('exitProfile=EP2_SINGLE').value).toBe('EP2_SINGLE');
  });

  it('reads a list without quotes: words stay words, numbers become numbers, and an empty list is empty', () => {
    expect(parseAssignment('acceptedRegimes=[TREND_UP, RANGE]').value).toEqual([
      'TREND_UP',
      'RANGE',
    ]);
    expect(parseAssignment('gates.stopAtr=[0.8, 3.5]').value).toEqual([0.8, 3.5]);
    expect(parseAssignment('x=[]').value).toEqual([]);
    expect(parseAssignment('x=[a,[b]').value).toEqual(['a', '[b']);
  });

  it('keeps an equals sign that belongs to the value', () => {
    expect(parseAssignment('note=a=b')).toEqual({ path: ['note'], value: 'a=b' });
  });

  it.each(['quality.min', '=3', 'a..b=1', '__proto__.x=1', 'a.constructor=1'])(
    'refuses "%s"',
    (text) => {
      expect(() => parseAssignment(text)).toThrow();
    },
  );
});

describe('variantOf', () => {
  it('is a copy with the value changed and a version of its own, and leaves the original alone', () => {
    const before = JSON.stringify(BASE);
    const variant = variantOf(BASE, ['quality.min=70'], 1);
    expect(variant.quality.min).toBe(70);
    expect(variant.version).toBe('0.1.1001');
    expect(JSON.stringify(BASE)).toBe(before);
    expect(variant.strategyKey).toBe('trend_pullback');
  });

  it('sets a value several levels down, and several values', () => {
    const variant = variantOf(BASE, ['gates.maxSpreadToStop=0.2', 'gates.stopAtr=[1,3]'], 2);
    expect(variant.gates.maxSpreadToStop).toBe(0.2);
    expect(variant.gates.stopAtr).toEqual([1, 3]);
  });

  it('needs a change to make, and a name that exists', () => {
    expect(() => variantOf(BASE, [], 1)).toThrow('at least one');
    expect(() => variantOf(BASE, ['quality.nope=1'], 1)).toThrow('no "quality.nope"');
    expect(() => variantOf(BASE, ['nothing.here=1'], 1)).toThrow('no "nothing"');
    expect(() => variantOf(BASE, ['quality.min.deeper=1'], 1)).toThrow();
  });

  it('is checked by the config schema: a threshold below the lowest grade is refused', () => {
    expect(() => variantOf(BASE, ['quality.min=10'], 1)).toThrow();
    expect(() => variantOf(BASE, ['gates.maxSpreadToStop=5'], 1)).toThrow();
  });
});
