import { describe, expect, it } from 'vitest';

import { UNFOLD_ALL_UP_TO, chooseAll, isUnfolded } from './foldChoices';

describe('which signal cards are unfolded', () => {
  it('unfolds every card while there are few signals', () => {
    for (let index = 0; index < UNFOLD_ALL_UP_TO; index += 1) {
      expect(isUnfolded({}, `s${String(index)}`, index, UNFOLD_ALL_UP_TO)).toBe(true);
    }
  });

  it('unfolds only the newest card when there are many', () => {
    const count = UNFOLD_ALL_UP_TO + 1;
    expect(isUnfolded({}, 'a', 0, count)).toBe(true);
    expect(isUnfolded({}, 'b', 1, count)).toBe(false);
    expect(isUnfolded({}, 'z', count - 1, count)).toBe(false);
  });

  it('follows what the owner chose for a card, whatever the rule says', () => {
    expect(isUnfolded({ b: true }, 'b', 5, 9)).toBe(true);
    expect(isUnfolded({ a: false }, 'a', 0, 9)).toBe(false);
    expect(isUnfolded({ a: false }, 'a', 0, 1)).toBe(false);
  });

  it('can fold or unfold all the cards at once', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const folded = chooseAll(ids, false);
    expect(ids.map((id, index) => isUnfolded(folded, id, index, ids.length))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    const unfolded = chooseAll(ids, true);
    expect(ids.map((id, index) => isUnfolded(unfolded, id, index, ids.length))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});
