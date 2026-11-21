import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VISIBILITY,
  MAX_HIDDEN,
  isDrawn,
  parseVisibility,
  serializeVisibility,
  setShow,
  toggleHidden,
} from './signalVisibility';

describe('the visibility of the signals on the chart', () => {
  it('draws every signal until the owner says otherwise', () => {
    expect(parseVisibility(null)).toEqual(DEFAULT_VISIBILITY);
    expect(isDrawn(DEFAULT_VISIBILITY, 42)).toBe(true);
  });

  it('hides one signal and draws it again', () => {
    const hidden = toggleHidden(DEFAULT_VISIBILITY, 42);
    expect(hidden.hidden).toEqual([42]);
    expect(isDrawn(hidden, 42)).toBe(false);
    expect(isDrawn(hidden, 43)).toBe(true);
    expect(isDrawn(toggleHidden(hidden, 42), 42)).toBe(true);
  });

  it('hides all of them at once, and keeps the single choices for when they are shown again', () => {
    const one = toggleHidden(DEFAULT_VISIBILITY, 42);
    const off = setShow(one, false);
    expect(isDrawn(off, 43)).toBe(false);
    const on = setShow(off, true);
    expect(isDrawn(on, 43)).toBe(true);
    expect(isDrawn(on, 42)).toBe(false);
  });

  it('survives a round trip through the stored text', () => {
    const value = setShow(toggleHidden(toggleHidden(DEFAULT_VISIBILITY, 3), 9), false);
    expect(parseVisibility(serializeVisibility(value))).toEqual(value);
  });

  it('takes nothing but numbers and a boolean from stored text, and falls back on anything else', () => {
    expect(parseVisibility('not json')).toEqual(DEFAULT_VISIBILITY);
    expect(parseVisibility('[1,2]')).toEqual(DEFAULT_VISIBILITY);
    expect(parseVisibility('{"show":false,"hidden":[1,"x",2.5,null,1,7]}')).toEqual({
      show: false,
      hidden: [1, 7],
    });
    expect(parseVisibility('{"hidden":"all"}')).toEqual(DEFAULT_VISIBILITY);
  });

  it('keeps the newest choices when the list is long', () => {
    let value = DEFAULT_VISIBILITY;
    for (let seq = 1; seq <= MAX_HIDDEN + 5; seq += 1) value = toggleHidden(value, seq);
    expect(value.hidden).toHaveLength(MAX_HIDDEN);
    expect(value.hidden.at(-1)).toBe(MAX_HIDDEN + 5);
    expect(value.hidden).not.toContain(1);
  });
});
