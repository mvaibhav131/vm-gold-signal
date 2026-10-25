import { describe, expect, it } from 'vitest';

import { cancelledOutcome } from '../trade/tracker';
import { DECIDED_AT } from '../trade/test-data';
import * as formatted from './results';
import { checkTelegramHtml } from './markup';
import { ICON, RESULT_ICON } from './style';
import { plain } from './test-html';
import {
  BUY_SIGNAL,
  DATA_INVALID,
  FINAL_REVIEW,
  LOSS,
  MINUTE,
  PARTIAL,
  PARTIAL_NO_WIN,
  REVIEW,
  SELL_SIGNAL,
  TIME_EXIT,
  WIN_TARGET,
  WIN_TP2,
} from './test-data';
import type { DisplayOptions, ReviewData, SignalRef, TelegramMessage } from './types';

// Most tests here check the words and the numbers, so they read what a reader sees: the message
// without its tags and without the picture at the start of a line. The look itself (tags and
// pictures) is checked, exactly, in "the look" at the end of this file.
const PICTURES = new RegExp(
  `^(?:${[...Object.values(ICON), ...Object.values(RESULT_ICON)].join('|')}) `,
  'gmu',
);
const reader =
  <A extends unknown[]>(render: (...args: A) => TelegramMessage) =>
  (...args: A): TelegramMessage => {
    const message = render(...args);
    return { ...message, text: plain(message.text).replace(PICTURES, '') };
  };
const renderSignalTp1 = reader(formatted.renderSignalTp1);
const renderSignalClosed = reader(formatted.renderSignalClosed);
const renderSignalCancelled = reader(formatted.renderSignalCancelled);
const renderFinalReview = reader(formatted.renderFinalReview);

const IST: DisplayOptions = { locale: 'en', displayTz: 'Asia/Kolkata' };
const HINGLISH: DisplayOptions = { locale: 'hinglish', displayTz: 'Asia/Kolkata' };
const lines = (...parts: string[]): string => parts.join('\n');
const EP2: SignalRef = { ...BUY_SIGNAL, exitProfile: 'EP2_SINGLE', tp1: 4027.075, tp2: null };

describe('TP1 hit, golden', () => {
  const data = { signal: BUY_SIGNAL, at: DECIDED_AT + 6 * MINUTE, price: 4023.84 };

  it('in English', () => {
    expect(renderSignalTp1(data, IST)).toEqual({
      kind: 'SIGNAL_TP1',
      level: 0,
      dropped: [],
      text: lines(
        'FORWARD-TEST (paper)',
        'TP1 HIT #S-0042  +1.00R on 50%',
        'Price 4023.840 at 11:41 IST (6 min after entry).',
        'ACTION: close half, move stop to entry 4017.370.',
        'Runner target TP2 4030.310. Time stop 13:35 IST.',
      ),
    });
  });

  it('in Hinglish', () => {
    expect(renderSignalTp1(data, HINGLISH).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'TP1 HIT #S-0042  +1.00R (50% par)',
        'Price 4023.840, 11:41 IST par (entry ke 6 min baad).',
        'KARO: aadha band karo, stop entry 4017.370 par le aao.',
        'Runner ka target TP2 4030.310. Time stop 13:35 IST.',
      ),
    );
  });

  it('for a SELL names the entry and the targets as they are', () => {
    const sell = renderSignalTp1(
      { signal: SELL_SIGNAL, at: DECIDED_AT + 10 * MINUTE, price: 3965.26 },
      IST,
    ).text;
    expect(sell).toContain('TP1 HIT #S-0043  +1.00R on 50%');
    expect(sell).toContain('move stop to entry 3982.630.');
    expect(sell).toContain('Runner target TP2 3947.890.');
  });

  it('has only one for a trade that has a TP2: the other profiles end at their target', () => {
    expect(() => renderSignalTp1({ ...data, signal: EP2 }, IST)).toThrow(RangeError);
    expect(() => renderSignalTp1({ ...data, signal: { ...BUY_SIGNAL, tp2: null } }, IST)).toThrow(
      RangeError,
    );
    // a second target on another profile is not a TP1 step either
    expect(() =>
      renderSignalTp1({ ...data, signal: { ...BUY_SIGNAL, exitProfile: 'EP2_SINGLE' } }, IST),
    ).toThrow(RangeError);
    expect(() =>
      renderSignalTp1({ ...data, signal: { ...BUY_SIGNAL, exitProfile: 'EP3_STRUCTURE' } }, IST),
    ).toThrow(RangeError);
  });

  it('says SIMULATED for replay data', () => {
    expect(
      renderSignalTp1({ ...data, signal: { ...BUY_SIGNAL, mode: 'SIMULATED' } }, IST).text.split(
        '\n',
      )[0],
    ).toBe('SIMULATED');
  });
});

describe('a win, golden', () => {
  it('at TP2, with what worked', () => {
    const closed = {
      signal: BUY_SIGNAL,
      outcome: WIN_TP2,
      review: null,
      worked: ['trend and structure stayed STRONG until the target'],
    };
    expect(renderSignalClosed(closed, IST)).toEqual({
      kind: 'SIGNAL_CLOSED',
      level: 0,
      dropped: [],
      text: lines(
        'FORWARD-TEST (paper)',
        'WIN #S-0042  +1.47R net  (TP2 4030.310 at 12:12 IST, 37 min)',
        'Max favourable +2.10R, max adverse -0.40R.',
        'What worked: trend and structure stayed STRONG until the target.',
      ),
    });
    expect(renderSignalClosed(closed, HINGLISH).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'WIN #S-0042  +1.47R net  (TP2 4030.310, 12:12 IST par, 37 min mein)',
        'Sabse achha move +2.10R, sabse bura move -0.40R.',
        'Kya sahi gaya: trend and structure stayed STRONG until the target.',
      ),
    );
  });

  it('at the single target of another profile, with nothing said about what worked', () => {
    const closed = { signal: EP2, outcome: WIN_TARGET, review: null };
    expect(renderSignalClosed(closed, IST).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'WIN #S-0042  +1.50R net  (target 4027.075 at 12:00 IST, 25 min)',
        'Max favourable +1.60R, max adverse -0.10R.',
      ),
    );
    expect(renderSignalClosed(closed, HINGLISH).text).toContain(
      '(target 4027.075, 12:00 IST par, 25 min mein)',
    );
  });

  it('shows no what-worked line for an empty list', () => {
    const text = renderSignalClosed(
      { signal: BUY_SIGNAL, outcome: WIN_TP2, review: null, worked: [] },
      IST,
    ).text;
    expect(text).not.toContain('What worked');
  });
});

describe('a partial win, golden', () => {
  it('is still a win while the net R is above zero', () => {
    const closed = { signal: BUY_SIGNAL, outcome: PARTIAL, review: null };
    expect(renderSignalClosed(closed, IST).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'PARTIAL WIN #S-0042  +0.46R net  (TP1 hit, then stopped at entry 4017.370 at 12:05 IST, 30 min)',
        'The trade is still a win because TP1 paid +0.50R.',
      ),
    );
    expect(renderSignalClosed(closed, HINGLISH).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'PARTIAL WIN #S-0042  +0.46R net  (TP1 lag chuka tha, phir entry par stop 4017.370, 12:05 IST par, 30 min mein)',
        'Trade phir bhi win hai kyunki TP1 ne +0.50R diya.',
      ),
    );
  });

  it('is not a win when the costs take the net R to zero or below', () => {
    const closed = { signal: BUY_SIGNAL, outcome: PARTIAL_NO_WIN, review: null };
    expect(renderSignalClosed(closed, IST).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'PARTIAL WIN #S-0042  0.00R net  (TP1 hit, then stopped at entry 4017.370 at 12:05 IST, 30 min)',
        'After costs the net R is not above zero, so it does not count as a win.',
      ),
    );
    expect(renderSignalClosed(closed, HINGLISH).text).toContain(
      'Cost ke baad net R zero se upar nahi hai, isliye ye win nahi gina jaata.',
    );
  });

  it('adds the cause of its review when there is one', () => {
    const review: ReviewData = {
      ...REVIEW,
      primaryCause: 'REGIME_SHIFT',
      causes: [{ code: 'REGIME_SHIFT', evidence: { from: 'TREND_UP', to: 'RANGE' } }],
    };
    expect(
      renderSignalClosed({ signal: BUY_SIGNAL, outcome: PARTIAL, review }, IST).text,
    ).toContain('Cause: REGIME_SHIFT (Market event), from TREND_UP, to RANGE.\n');
    expect(
      renderSignalClosed({ signal: BUY_SIGNAL, outcome: PARTIAL, review }, HINGLISH).text,
    ).toContain('Wajah: REGIME_SHIFT (Market event), from TREND_UP, to RANGE.\n');
  });
});

describe('a loss, golden', () => {
  it('with its review, in English', () => {
    expect(
      renderSignalClosed({ signal: BUY_SIGNAL, outcome: LOSS, review: REVIEW }, IST).text,
    ).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'LOSS #S-0042  -1.04R net  (stop 4010.900 hit 11:50 IST, 15 min after entry)',
        'WHY IT FAILED (automatic review, preliminary)',
        'Primary: NO_FOLLOW_THROUGH (Setup failure) - max favourable R 0.2',
        'Meaning: Price never moved 0.3R in favour before the close.',
        'Also: HTF_STRUCTURE_BREAK (Setup failure) - level 4012.1, tf 15m',
        'Weak at entry: Trigger and momentum (WEAK)',
        'Final review in 60 min (checks whether price reached TP1 later).',
        'Attribution is heuristic. Judge the strategy by the statistics in Analytics.',
      ),
    );
  });

  it('with its review, in Hinglish', () => {
    expect(
      renderSignalClosed({ signal: BUY_SIGNAL, outcome: LOSS, review: REVIEW }, HINGLISH).text,
    ).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'LOSS #S-0042  -1.04R net  (stop 4010.900 11:50 IST par laga, entry ke 15 min baad)',
        'KYUN FAIL HUA (automatic review, preliminary)',
        'Mukhya wajah: NO_FOLLOW_THROUGH (Setup ki kami) - max favourable R 0.2',
        'Matlab: Close se pehle price kabhi 0.3R bhi trade ke favour mein nahi gayi.',
        'Saath mein: HTF_STRUCTURE_BREAK (Setup ki kami) - level 4012.1, tf 15m',
        'Entry par kamzor: Trigger aur momentum (WEAK)',
        'Final review 60 min mein aayega (dekhega ki price baad mein TP1 tak gaya ya nahi).',
        'Ye wajah sirf anuman hai. Strategy ko Analytics ke statistics se parkho.',
      ),
    );
  });

  it('without a review is the result alone', () => {
    expect(renderSignalClosed({ signal: BUY_SIGNAL, outcome: LOSS, review: null }, IST).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'LOSS #S-0042  -1.04R net  (stop 4010.900 hit 11:50 IST, 15 min after entry)',
      ),
    );
  });

  it('with a final review has the counterfactual and no promise of a later review', () => {
    const text = renderSignalClosed(
      { signal: BUY_SIGNAL, outcome: LOSS, review: FINAL_REVIEW },
      IST,
    ).text;
    expect(text).toContain('WHY IT FAILED (automatic review, final)');
    expect(text).toContain('Primary: STOP_HUNT_REVERSAL (Setup failure)\n');
    expect(text).toContain('Price reached TP1 4023.840 7 5m candles after the stop.');
    expect(text).not.toContain('Final review in 60 min');
  });

  it('says a gap through the stop as it was filled', () => {
    const gapped = { ...LOSS, exitPrice: 4008, realizedRNet: -1.45 };
    expect(
      renderSignalClosed({ signal: BUY_SIGNAL, outcome: gapped, review: null }, IST).text,
    ).toContain('LOSS #S-0042  -1.45R net  (stop 4008.000 hit 11:50 IST, 15 min after entry)');
  });

  it('lists every weak group and every other cause', () => {
    const review: ReviewData = {
      ...REVIEW,
      causes: [
        { code: 'NO_FOLLOW_THROUGH', evidence: {} },
        {
          code: 'NEWS_SHOCK',
          evidence: { moveAtr: 2.456, headline: true, topics: ['FED_RATES', 'USD_DOLLAR'] },
        },
        { code: 'SPREAD_COST', evidence: { costShare: 0.3, nested: { a: 1 } } },
      ],
      weakGroupsAtEntry: [
        { group: 'trigger', state: 'WEAK' },
        { group: 'reward', state: 'FAIL' },
      ],
    };
    const text = renderSignalClosed({ signal: BUY_SIGNAL, outcome: LOSS, review }, IST).text;
    expect(text).toContain('Primary: NO_FOLLOW_THROUGH (Setup failure)\n');
    expect(text).toContain(
      'Also: NEWS_SHOCK (Market event) - move ATR 2.46, headline yes, topics FED_RATES, USD_DOLLAR\n',
    );
    expect(text).toContain('Also: SPREAD_COST (Execution) - cost share 0.3\n');
    expect(text).toContain(
      'Weak at entry: Trigger and momentum (WEAK), Reward feasibility (FAIL)\n',
    );
  });

  it('leaves out the weak-at-entry line when no group was weak', () => {
    const review = { ...REVIEW, weakGroupsAtEntry: [] };
    expect(
      renderSignalClosed({ signal: BUY_SIGNAL, outcome: LOSS, review }, IST).text,
    ).not.toContain('Weak at entry');
  });
});

describe('a time exit, golden', () => {
  it('with the cause of its review', () => {
    const review: ReviewData = {
      ...REVIEW,
      primaryCause: 'TIME_DECAY',
      causes: [{ code: 'TIME_DECAY', evidence: { maxFavourableR: 0.5 } }],
    };
    const closed = { signal: BUY_SIGNAL, outcome: TIME_EXIT, review };
    expect(renderSignalClosed(closed, IST).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'TIME EXIT #S-0042  -0.18R net  (2 h, price 4015.400)',
        'No stop or target was reached.',
        'Cause: TIME_DECAY (Setup failure), max favourable R 0.5.',
      ),
    );
    expect(renderSignalClosed(closed, HINGLISH).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'TIME EXIT #S-0042  -0.18R net  (2 h, price 4015.400)',
        'Na stop laga, na target mila.',
        'Wajah: TIME_DECAY (Setup ki kami), max favourable R 0.5.',
      ),
    );
  });

  it('says that TP1 was reached earlier when it was', () => {
    const closed = { signal: BUY_SIGNAL, outcome: { ...TIME_EXIT, tp1Hit: true }, review: null };
    expect(renderSignalClosed(closed, IST).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'TIME EXIT #S-0042  -0.18R net  (2 h, price 4015.400)',
        'TP1 was reached earlier; the rest was closed at the time stop.',
      ),
    );
    expect(renderSignalClosed(closed, HINGLISH).text).toContain(
      'TP1 pehle mil chuka tha; bacha hissa time stop par band hua.',
    );
  });
});

describe('data invalid, golden', () => {
  it('is not counted and asks the owner to manage the trade', () => {
    const closed = { signal: BUY_SIGNAL, outcome: DATA_INVALID, review: null };
    expect(renderSignalClosed(closed, IST).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'DATA INVALID #S-0042 (not counted in win rate)',
        'The feed had a gap of more than 60 s during the trade, so the result cannot be trusted. If you are still in the trade, manage it manually.',
      ),
    );
    expect(renderSignalClosed(closed, HINGLISH).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'DATA INVALID #S-0042 (win rate mein nahi ginta)',
        'Trade ke dauraan feed mein 60 s se zyada gap tha, isliye result par bharosa nahi kar sakte. Agar aap abhi trade mein ho to khud sambhalo.',
      ),
    );
  });
});

describe('what a closed message refuses', () => {
  it('a cancelled signal has its own message', () => {
    expect(() =>
      renderSignalClosed(
        { signal: BUY_SIGNAL, outcome: cancelledOutcome(DECIDED_AT + MINUTE), review: null },
        IST,
      ),
    ).toThrow(RangeError);
  });

  it('a counted result needs its net R and its exit price', () => {
    expect(() =>
      renderSignalClosed(
        { signal: BUY_SIGNAL, outcome: { ...WIN_TP2, realizedRNet: null }, review: null },
        IST,
      ),
    ).toThrow(RangeError);
    expect(() =>
      renderSignalClosed(
        { signal: BUY_SIGNAL, outcome: { ...LOSS, exitPrice: null }, review: null },
        IST,
      ),
    ).toThrow(RangeError);
  });

  it('shows the day when a trade closes on the next day of the display zone', () => {
    const signal: SignalRef = { ...BUY_SIGNAL, generatedAt: Date.UTC(2026, 9, 23, 18, 25) };
    const closed = {
      signal,
      outcome: { ...TIME_EXIT, closedAt: signal.generatedAt + 120 * MINUTE },
      review: null,
    };
    // the time exit line has no clock time; a win at that moment has one
    const win = { ...WIN_TP2, closedAt: signal.generatedAt + 120 * MINUTE, durationS: 7200 };
    expect(renderSignalClosed({ signal, outcome: win, review: null }, IST).text).toContain(
      'at 01:55 IST (24 Oct), 2 h)',
    );
    expect(renderSignalClosed(closed, IST).text).toContain('TIME EXIT #S-0042');
  });
});

describe('a cancelled signal, golden', () => {
  it('says for how long the data was stale', () => {
    const cancelled = { signal: BUY_SIGNAL, staleSeconds: 40 };
    expect(renderSignalCancelled(cancelled, IST)).toEqual({
      kind: 'SIGNAL_CANCELLED',
      level: 0,
      dropped: [],
      text: lines(
        'FORWARD-TEST (paper)',
        'CANCELLED #S-0042 (not counted in win rate)',
        'Reason: market data went stale for 40 s during the 3 min entry window.',
        'If you already entered, manage the trade manually.',
      ),
    });
    expect(renderSignalCancelled(cancelled, HINGLISH).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'CANCELLED #S-0042 (win rate mein nahi ginta)',
        'Wajah: 3 min ke entry window mein market data 40 s tak stale raha.',
        'Agar aap entry le chuke ho to trade khud sambhalo.',
      ),
    );
  });

  it('does not need the number of seconds', () => {
    const cancelled = { signal: BUY_SIGNAL, staleSeconds: null };
    expect(renderSignalCancelled(cancelled, IST).text).toContain(
      'Reason: market data went stale during the 3 min entry window.',
    );
    expect(renderSignalCancelled(cancelled, HINGLISH).text).toContain(
      'Wajah: 3 min ke entry window mein market data stale ho gaya.',
    );
  });
});

describe('the final review, golden', () => {
  const final = {
    signal: BUY_SIGNAL,
    review: FINAL_REVIEW,
    previousPrimary: 'NO_FOLLOW_THROUGH' as const,
    trackedThisMonth: 9,
  };

  it('says that the cause was updated, and where price went afterwards', () => {
    expect(renderFinalReview(final, IST)).toEqual({
      kind: 'SIGNAL_REVIEW_FINAL',
      level: 0,
      dropped: [],
      text: lines(
        'FORWARD-TEST (paper)',
        'FINAL REVIEW #S-0042',
        'Cause updated: STOP_HUNT_REVERSAL (Setup failure), was NO_FOLLOW_THROUGH.',
        'Price reached TP1 4023.840 7 5m candles after the stop.',
        'Meaning: After the stop-out, price reached the TP1 level within 12 candles of 5m.',
        'Tracked in Analytics (n=9 this month).',
        'Attribution is heuristic. Judge the strategy by the statistics in Analytics.',
      ),
    });
    expect(renderFinalReview(final, HINGLISH).text).toBe(
      lines(
        'FORWARD-TEST (paper)',
        'FINAL REVIEW #S-0042',
        'Wajah badli: STOP_HUNT_REVERSAL (Setup ki kami), pehle NO_FOLLOW_THROUGH thi.',
        'Stop ke 7 5m candle baad price TP1 4023.840 par pahunch gayi.',
        'Matlab: Stop lagne ke baad price 5m ke 12 candles ke andar TP1 level tak pahunch gayi.',
        'Analytics mein track ho raha hai (is mahine n=9).',
        'Ye wajah sirf anuman hai. Strategy ko Analytics ke statistics se parkho.',
      ),
    );
  });

  it('says that the cause was confirmed when it did not change, and when price never reached TP1', () => {
    const same = {
      ...final,
      review: { ...FINAL_REVIEW, counterfactual: { reachedTp1: false, candlesToTp1: null } },
      previousPrimary: 'STOP_HUNT_REVERSAL' as const,
      trackedThisMonth: null,
    };
    const text = renderFinalReview(same, IST).text;
    expect(text).toContain('Cause confirmed: STOP_HUNT_REVERSAL (Setup failure).');
    expect(text).toContain('Price did not reach TP1 afterwards.');
    expect(text).not.toContain('Tracked in Analytics');
    const first = renderFinalReview({ ...same, previousPrimary: null }, HINGLISH).text;
    expect(first).toContain('Wajah pakki hui: STOP_HUNT_REVERSAL (Setup ki kami).');
    expect(first).toContain('Uske baad price TP1 tak nahi pahunchi.');
  });

  it('has no counterfactual line when there is no counterfactual', () => {
    const none = { ...final, review: { ...FINAL_REVIEW, counterfactual: null } };
    const text = renderFinalReview(none, IST).text;
    expect(text).not.toContain('Price reached TP1');
    expect(text).not.toContain('did not reach TP1');
  });

  it('says a single candle in the singular', () => {
    const one = {
      ...final,
      review: { ...FINAL_REVIEW, counterfactual: { reachedTp1: true, candlesToTp1: 1 } },
    };
    expect(renderFinalReview(one, IST).text).toContain('4023.840 1 5m candle after the stop.');
  });

  it('only says that price reached TP1 when it did and the candles are known', () => {
    const lineFor = (counterfactual: { reachedTp1: boolean; candlesToTp1: number | null }) =>
      renderFinalReview({ ...final, review: { ...FINAL_REVIEW, counterfactual } }, IST).text;
    expect(lineFor({ reachedTp1: true, candlesToTp1: null })).toContain(
      'Price did not reach TP1 afterwards.',
    );
    expect(lineFor({ reachedTp1: false, candlesToTp1: 5 })).toContain(
      'Price did not reach TP1 afterwards.',
    );
  });
});

describe('the counterfactual in a closed message', () => {
  const closed = (review: ReviewData) =>
    renderSignalClosed({ signal: BUY_SIGNAL, outcome: LOSS, review }, IST).text;

  it('is only shown by a final review', () => {
    const preliminary = {
      ...REVIEW,
      counterfactual: { reachedTp1: true, candlesToTp1: 4 },
    };
    expect(closed(preliminary)).not.toContain('Price reached TP1');
    expect(closed(preliminary)).toContain('Final review in 60 min');
  });

  it('is only shown when price reached TP1 and the candles are known', () => {
    const final = (counterfactual: { reachedTp1: boolean; candlesToTp1: number | null }) =>
      closed({ ...FINAL_REVIEW, counterfactual });
    expect(final({ reachedTp1: true, candlesToTp1: null })).toContain(
      'Price did not reach TP1 afterwards.',
    );
    expect(final({ reachedTp1: false, candlesToTp1: 5 })).toContain(
      'Price did not reach TP1 afterwards.',
    );
    expect(final({ reachedTp1: true, candlesToTp1: 4 })).toContain(
      '4023.840 4 5m candles after the stop.',
    );
  });

  it('is left out of a final review that has none', () => {
    const text = closed({ ...FINAL_REVIEW, counterfactual: null });
    expect(text).not.toContain('Price reached TP1');
    expect(text).not.toContain('did not reach TP1');
  });
});

describe('all result messages start with the label of the signal (rules C8 and C9)', () => {
  const live = BUY_SIGNAL;
  const messages = (signal: SignalRef, options: DisplayOptions) => [
    renderSignalTp1({ signal, at: DECIDED_AT + MINUTE, price: 4023.84 }, options).text,
    renderSignalClosed({ signal, outcome: LOSS, review: null }, options).text,
    renderSignalClosed({ signal, outcome: DATA_INVALID, review: null }, options).text,
    renderSignalCancelled({ signal, staleSeconds: 10 }, options).text,
    renderFinalReview(
      { signal, review: FINAL_REVIEW, previousPrimary: null, trackedThisMonth: null },
      options,
    ).text,
  ];

  it('paper strategies say FORWARD-TEST (paper) in both languages', () => {
    for (const options of [IST, HINGLISH]) {
      for (const text of messages(live, options)) {
        expect(text.startsWith('FORWARD-TEST (paper)\n')).toBe(true);
      }
    }
  });

  it('replay and backtest data say SIMULATED, a validated strategy says VALIDATED strategy', () => {
    for (const text of messages({ ...live, mode: 'SIMULATED' }, IST)) {
      expect(text.startsWith('SIMULATED\n')).toBe(true);
    }
    for (const text of messages({ ...live, mode: 'BACKTEST' }, HINGLISH)) {
      expect(text.startsWith('SIMULATED\n')).toBe(true);
    }
    for (const text of messages({ ...live, strategyStatus: 'VALIDATED' }, IST)) {
      expect(text.startsWith('VALIDATED strategy\n')).toBe(true);
    }
  });
});

describe('the look: tags and pictures, exactly', () => {
  const tag = '#S-0042';
  const html = formatted;

  it('TP1: the title and the action in bold, the label in bold', () => {
    const data = { signal: BUY_SIGNAL, at: DECIDED_AT + 6 * MINUTE, price: 4023.84 };
    expect(html.renderSignalTp1(data, IST).text).toBe(
      lines(
        '<b>FORWARD-TEST (paper)</b>',
        `${ICON.tp1} <b>TP1 HIT ${tag}  +1.00R on 50%</b>`,
        'Price 4023.840 at 11:41 IST (6 min after entry).',
        `${ICON.action} <b>ACTION: close half, move stop to entry 4017.370.</b>`,
        'Runner target TP2 4030.310. Time stop 13:35 IST.',
      ),
    );
  });

  it('a win, a partial win and a time exit: the result in bold behind its picture', () => {
    const at = (outcome: Parameters<typeof html.renderSignalClosed>[0]['outcome']) =>
      html
        .renderSignalClosed({ signal: BUY_SIGNAL, outcome, review: null }, IST)
        .text.split('\n')[1];
    expect(at(WIN_TP2)).toBe(
      `${ICON.win} <b>WIN ${tag}  +1.47R net</b>  (TP2 4030.310 at 12:12 IST, 37 min)`,
    );
    expect(at(PARTIAL)).toBe(
      `${ICON.partial} <b>PARTIAL WIN ${tag}  +0.46R net</b>  (TP1 hit, then stopped at entry 4017.370 at 12:05 IST, 30 min)`,
    );
    expect(at(TIME_EXIT)).toBe(
      `${ICON.time} <b>TIME EXIT ${tag}  -0.18R net</b>  (2 h, price 4015.400)`,
    );
  });

  it('a loss: the result, then the title of the review, then the reasons in a quote', () => {
    expect(
      html.renderSignalClosed({ signal: BUY_SIGNAL, outcome: LOSS, review: REVIEW }, IST).text,
    ).toBe(
      lines(
        '<b>FORWARD-TEST (paper)</b>',
        `${ICON.loss} <b>LOSS ${tag}  -1.04R net</b>  (stop 4010.900 hit 11:50 IST, 15 min after entry)`,
        `${ICON.review} <b>WHY IT FAILED (automatic review, preliminary)</b>`,
        '<blockquote>Primary: NO_FOLLOW_THROUGH (Setup failure) - max favourable R 0.2',
        'Meaning: Price never moved 0.3R in favour before the close.',
        'Also: HTF_STRUCTURE_BREAK (Setup failure) - level 4012.1, tf 15m',
        'Weak at entry: Trigger and momentum (WEAK)',
        'Final review in 60 min (checks whether price reached TP1 later).',
        'Attribution is heuristic. Judge the strategy by the statistics in Analytics.</blockquote>',
      ),
    );
  });

  it('data invalid, cancelled and the final review', () => {
    expect(
      html
        .renderSignalClosed({ signal: BUY_SIGNAL, outcome: DATA_INVALID, review: null }, IST)
        .text.split('\n')[1],
    ).toMatch(new RegExp(`^${ICON.invalid} <b>.*${tag}.*</b>$`));
    expect(html.renderSignalCancelled({ signal: BUY_SIGNAL, staleSeconds: 40 }, IST).text).toBe(
      lines(
        '<b>FORWARD-TEST (paper)</b>',
        `${ICON.cancelled} <b>CANCELLED ${tag} (not counted in win rate)</b>`,
        'Reason: market data went stale for 40 s during the 3 min entry window.',
        'If you already entered, manage the trade manually.',
      ),
    );
    const final = html.renderFinalReview(
      {
        signal: BUY_SIGNAL,
        review: FINAL_REVIEW,
        previousPrimary: 'NO_FOLLOW_THROUGH',
        trackedThisMonth: 9,
      },
      IST,
    ).text;
    expect(final.split('\n').slice(0, 3)).toEqual([
      '<b>FORWARD-TEST (paper)</b>',
      `${ICON.review} <b>FINAL REVIEW ${tag}</b>`,
      'Cause updated: STOP_HUNT_REVERSAL (Setup failure), was NO_FOLLOW_THROUGH.',
    ]);
  });

  it('every message is valid Telegram HTML in both languages, and is not the plain fallback', () => {
    const review = { signal: BUY_SIGNAL, review: FINAL_REVIEW, previousPrimary: null };
    for (const options of [IST, HINGLISH]) {
      const texts = [
        html.renderSignalTp1({ signal: BUY_SIGNAL, at: DECIDED_AT, price: 4023.84 }, options),
        html.renderSignalClosed({ signal: BUY_SIGNAL, outcome: WIN_TP2, review: null }, options),
        html.renderSignalClosed({ signal: BUY_SIGNAL, outcome: PARTIAL, review: REVIEW }, options),
        html.renderSignalClosed({ signal: BUY_SIGNAL, outcome: LOSS, review: REVIEW }, options),
        html.renderSignalClosed({ signal: BUY_SIGNAL, outcome: TIME_EXIT, review: null }, options),
        html.renderSignalClosed(
          { signal: BUY_SIGNAL, outcome: DATA_INVALID, review: null },
          options,
        ),
        html.renderSignalCancelled({ signal: BUY_SIGNAL, staleSeconds: null }, options),
        html.renderFinalReview({ ...review, trackedThisMonth: 3 }, options),
      ].map((message) => message.text);
      for (const text of texts) {
        expect(checkTelegramHtml(text), text).toBeNull();
        expect(text).toContain('<b>');
        expect(text).not.toMatch(/[\uE000-\uE00F]/);
      }
    }
  });
});
