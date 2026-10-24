import { describe, expect, it } from 'vitest';

import type { MacroImportance } from '../domain';
import {
  SETTLE_DEFAULTS,
  macroProximity,
  newsStateOf,
  type Calm,
  type MacroEventInput,
  type NewsWindowSpec,
} from './macro';

const NOW = Date.parse('2026-01-14T13:30:00Z');
const MIN = 60_000;

/** The window of the strategy config: 45 minutes before and 20 after a high-impact USD event. */
const SPEC: NewsWindowSpec = { before: 45, after: 20, impact: ['high'], currency: ['USD'] };

/** An event `minutes` after `NOW` (negative: before it). */
function event(
  id: string,
  minutes: number,
  importance: MacroImportance = 'high',
  currency: string | null = 'USD',
): MacroEventInput {
  return { id, scheduledAt: NOW + minutes * MIN, importance, currency };
}

const CALM: Calm = { atrRatio: 1, spreadRatio: 1 };
const proximity = (events: MacroEventInput[], spec = SPEC, calm: Calm = CALM) =>
  macroProximity(events, NOW, spec, calm);

describe('which events count', () => {
  it('none at all: nothing is known and the window is shut', () => {
    expect(proximity([])).toEqual({
      next: null,
      minutesToNext: null,
      last: null,
      minutesSinceLast: null,
      inWindow: false,
      windowEvent: null,
      settling: false,
      windowActive: false,
    });
  });

  it('only the impact of the window: a medium or low event is ignored', () => {
    const events = [event('m', 10, 'medium'), event('l', 10, 'low'), event('h', 90)];
    expect(proximity(events).next?.id).toBe('h');
    expect(proximity(events, { ...SPEC, impact: ['high', 'medium'] }).next?.id).toBe('m');
    expect(proximity([event('m', 10, 'medium')], { ...SPEC, impact: ['medium'] }).inWindow).toBe(
      true,
    );
  });

  it('only the currencies of the window: an event in another currency, or in none, is ignored', () => {
    const events = [event('eur', 10, 'high', 'EUR'), event('none', 20, 'high', null)];
    expect(proximity(events)).toMatchObject({ next: null, inWindow: false });
    expect(proximity(events, { ...SPEC, currency: ['USD', 'EUR'] }).next?.id).toBe('eur');
    expect(proximity(events, { ...SPEC, currency: [] }).next).toBeNull();
  });
});

describe('the next and the last event', () => {
  const events = [event('old', -300), event('last', -90), event('next', 200), event('later', 600)];

  it('the nearest after now and the nearest at or before it, with the minutes between', () => {
    const result = proximity(events);
    expect(result.next?.id).toBe('next');
    expect(result.minutesToNext).toBe(200);
    expect(result.last?.id).toBe('last');
    expect(result.minutesSinceLast).toBe(90);
  });

  it('an event at this very instant is the last one, not the next', () => {
    const result = proximity([event('now', 0), event('after', 60)]);
    expect(result.last?.id).toBe('now');
    expect(result.minutesSinceLast).toBe(0);
    expect(result.next?.id).toBe('after');
  });

  it('counts part of a minute', () => {
    const result = macroProximity(
      [{ ...event('soon', 0), scheduledAt: NOW + 90_000 }],
      NOW,
      SPEC,
      CALM,
    );
    expect(result.minutesToNext).toBe(1.5);
    const past = macroProximity([{ ...event('past', 0), scheduledAt: NOW - 150_000 }], NOW, SPEC);
    expect(past.minutesSinceLast).toBe(2.5);
  });

  it('is the same whatever the order of the list', () => {
    const reversed = [...events].reverse();
    expect(proximity(reversed)).toEqual(proximity(events));
    const shuffled = [events[2], events[0], events[3], events[1]].filter(
      (e): e is MacroEventInput => e !== undefined,
    );
    expect(proximity(shuffled)).toEqual(proximity(events));
  });

  it('two events at the same time: the one with the smaller id is the next, and the one with the larger id the last', () => {
    const a = event('a', 30);
    const b = event('b', 30);
    expect(proximity([b, a]).next?.id).toBe('a');
    expect(proximity([a, b]).next?.id).toBe('a');
    const c = event('c', -30);
    const d = event('d', -30);
    expect(proximity([c, d]).last?.id).toBe('d');
    expect(proximity([d, c]).last?.id).toBe('d');
  });
});

describe('the news window: 45 minutes before to 20 minutes after', () => {
  const windowAt = (minutes: number) => proximity([event('cpi', minutes)]);

  it('opens 45 minutes ahead of the event, and not before', () => {
    expect(windowAt(45).inWindow).toBe(true);
    expect(windowAt(45.01).inWindow).toBe(false);
    expect(windowAt(44).inWindow).toBe(true);
  });

  it('is open at the event itself', () => {
    expect(windowAt(0)).toMatchObject({ inWindow: true, windowActive: true });
    expect(windowAt(0).windowEvent?.id).toBe('cpi');
  });

  it('closes 20 minutes after the event, and not before', () => {
    expect(windowAt(-20).inWindow).toBe(true);
    expect(windowAt(-20.01).inWindow).toBe(false);
    expect(windowAt(-19).inWindow).toBe(true);
  });

  it('takes the minutes from the window: the strategy config sets them', () => {
    const wide = { ...SPEC, before: 120, after: 60 };
    expect(proximity([event('cpi', 100)], wide).inWindow).toBe(true);
    expect(proximity([event('cpi', 100)]).inWindow).toBe(false);
    expect(proximity([event('cpi', -50)], wide).inWindow).toBe(true);
    const none = { ...SPEC, before: 0, after: 0 };
    expect(proximity([event('cpi', 0)], none).inWindow).toBe(true);
    expect(proximity([event('cpi', 1)], none).inWindow).toBe(false);
    expect(proximity([event('cpi', -1)], none).inWindow).toBe(false);
  });

  it('names the event of the window, the nearest one when two windows overlap', () => {
    expect(proximity([event('far', 40), event('near', -10)]).windowEvent?.id).toBe('near');
    expect(proximity([event('near', 5), event('far', -15)]).windowEvent?.id).toBe('near');
  });

  it('two events at the same distance on either side: the earlier one', () => {
    expect(proximity([event('after', 10), event('before', -10)]).windowEvent?.id).toBe('before');
    expect(proximity([event('before', -10), event('after', 10)]).windowEvent?.id).toBe('before');
  });

  it('only events of the right impact and currency open it', () => {
    expect(proximity([event('x', 10, 'medium')]).inWindow).toBe(false);
    expect(proximity([event('x', 10, 'high', 'EUR')]).inWindow).toBe(false);
  });
});

describe('the window stays open while spread or ATR have not settled', () => {
  const after = (minutes: number, calm: Calm) => proximity([event('nfp', -minutes)], SPEC, calm);

  it('keeps it open after the 20 minutes when ATR(5m) is still 1.5 times its median or more', () => {
    const result = after(30, { atrRatio: 1.5, spreadRatio: 1 });
    expect(result).toMatchObject({ inWindow: false, settling: true, windowActive: true });
    expect(after(30, { atrRatio: 1.49, spreadRatio: 1 })).toMatchObject({
      settling: false,
      windowActive: false,
    });
  });

  it('or when the spread is still 1.5 times its median or more', () => {
    expect(after(30, { atrRatio: 1, spreadRatio: 1.5 }).settling).toBe(true);
    expect(after(30, { atrRatio: 1, spreadRatio: 1.49 }).settling).toBe(false);
  });

  it('closes when both are back under 1.5 times', () => {
    expect(after(30, { atrRatio: 1.2, spreadRatio: 1.4 }).windowActive).toBe(false);
  });

  it('cannot be kept open by a ratio that is not known, but one known ratio is enough', () => {
    expect(after(30, { atrRatio: null, spreadRatio: null }).settling).toBe(false);
    expect(after(30, { atrRatio: null, spreadRatio: 2 }).settling).toBe(true);
    expect(after(30, { atrRatio: 2, spreadRatio: null }).settling).toBe(true);
    expect(after(30, { atrRatio: null, spreadRatio: 1 }).settling).toBe(false);
  });

  it('ends at the latest 120 minutes after the event', () => {
    const wild: Calm = { atrRatio: 5, spreadRatio: 5 };
    expect(after(120, wild).settling).toBe(true);
    expect(after(120.01, wild).settling).toBe(false);
    expect(after(200, wild).windowActive).toBe(false);
  });

  it('needs an event before: nothing to settle after', () => {
    const wild: Calm = { atrRatio: 5, spreadRatio: 5 };
    expect(proximity([], SPEC, wild).settling).toBe(false);
    expect(proximity([event('later', 300)], SPEC, wild)).toMatchObject({
      settling: false,
      windowActive: false,
    });
  });

  it('is not "settling" inside the scheduled window: it is simply in the window', () => {
    const wild: Calm = { atrRatio: 5, spreadRatio: 5 };
    expect(after(10, wild)).toMatchObject({ inWindow: true, settling: false, windowActive: true });
  });

  it('only the last event can keep it open, and only if it is a matching one', () => {
    const wild: Calm = { atrRatio: 5, spreadRatio: 5 };
    expect(proximity([event('eur', -30, 'high', 'EUR')], SPEC, wild).settling).toBe(false);
    expect(proximity([event('old', -300), event('recent', -40)], SPEC, wild).settling).toBe(true);
  });

  it('works without any calm numbers: then nothing is settling', () => {
    expect(macroProximity([event('nfp', -30)], NOW, SPEC).settling).toBe(false);
  });

  it('takes its limits from the parameters', () => {
    const relaxed = { ratio: 3, maxMinutes: 60 };
    const run = (minutes: number, ratio: number) =>
      macroProximity(
        [event('nfp', -minutes)],
        NOW,
        SPEC,
        { atrRatio: ratio, spreadRatio: null },
        relaxed,
      ).settling;
    expect(run(30, 3)).toBe(true);
    expect(run(30, 2.9)).toBe(false);
    expect(run(60, 3)).toBe(true);
    expect(run(61, 3)).toBe(false);
  });

  it('has the defaults of docs/02 section 6, and a cap of two hours that is a decision of section 5.1', () => {
    expect(SETTLE_DEFAULTS).toEqual({ ratio: 1.5, maxMinutes: 120 });
  });
});

describe('newsStateOf', () => {
  it('UNKNOWN when the calendar is not available, never guessed as CLEAR', () => {
    expect(newsStateOf(false, false)).toBe('UNKNOWN');
    expect(newsStateOf(true, false)).toBe('UNKNOWN');
  });

  it('IN_WINDOW while the window is active, otherwise CLEAR', () => {
    expect(newsStateOf(true, true)).toBe('IN_WINDOW');
    expect(newsStateOf(false, true)).toBe('CLEAR');
  });
});

describe('bad input', () => {
  it('a time that is not a number', () => {
    expect(() => macroProximity([], Number.NaN, SPEC)).toThrow(RangeError);
  });
});
