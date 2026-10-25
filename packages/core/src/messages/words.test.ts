import { describe, expect, it } from 'vitest';

import {
  CAUSE_CODES,
  EXIT_PROFILES,
  GRADES,
  NEWS_STATES,
  QUALITY_GROUPS,
  STATS_SCOPES,
} from '../domain';
import { EXIT_REASONS } from '../trade/types';
import { causeText, evidenceText, humanizeKey, labelLine, rewardR, signalTag } from './common';
import { BUY_SIGNAL, SELL_SIGNAL } from './test-data';
import { WORDS, type Words } from './words';

const en = WORDS.en;
const hinglish = WORDS.hinglish;

/** Every text that a dictionary can make, from sample arguments. */
function everyText(w: Words): string[] {
  const texts: string[] = [];
  const add = (value: string) => texts.push(value);
  for (const [key, entry] of Object.entries(w)) {
    if (typeof entry === 'string') add(entry);
    else if (typeof entry !== 'function') {
      for (const inner of Object.values(entry as Record<string, unknown>)) {
        if (typeof inner === 'string') add(inner);
        else if (typeof inner === 'function')
          add((inner as (...args: string[]) => string)('4017.370'));
        else throw new Error(`unexpected entry in ${key}`);
      }
    }
  }
  add(w.doNotChase('BUY', '4018.015'));
  add(w.doNotChase('SELL', '3981.985'));
  add(w.validFor('3 min', '11:38 IST'));
  add(w.timeStop('2 h', '13:35 IST'));
  add(w.quality('78', 'Strong'));
  add(w.nextEvent('CPI m/m', '16:00 IST', '4 h'));
  add(w.newsCount(1));
  add(w.newsCount(3));
  add(w.openRisk('0.00R'));
  add(w.winRate('58%', 64, '46-69%'));
  add(w.tp1Reached('70%'));
  add(w.tp2Reached('40%'));
  add(w.insufficient(12, 7, 30));
  add(w.source('forward paper trades', 'strategy and side'));
  add(w.oneR('6.470'));
  add(w.tp1HitTitle('#S-0042', '+1.00R', '50%'));
  add(w.priceAt('4023.840', '11:41 IST', '6 min'));
  add(w.tp1Action('4017.370'));
  add(w.runnerLine('4030.310', '13:35 IST'));
  add(w.closedDetail('TP2 4030.310', '12:12 IST', '37 min'));
  add(w.afterTp1('stopped at entry'));
  add(w.stoppedDetail('stop 4010.900', '11:50 IST', '15 min'));
  add(w.timeExitDetail('2 h', '4015.400'));
  add(w.mfeMae('+2.10R', '-0.40R'));
  add(w.partialPaid('+0.50R'));
  add(w.reviewTitle('PRELIMINARY'));
  add(w.reviewTitle('FINAL'));
  add(w.cancelledTitle('#S-0042'));
  add(w.cancelledReason(40, '3 min'));
  add(w.cancelledReason(null, '3 min'));
  add(w.dataInvalidTitle('#S-0042'));
  add(w.finalTitle('#S-0042'));
  add(w.causeUpdated('A', 'B', 'C'));
  add(w.causeConfirmed('A', 'B'));
  add(w.reachedTp1('4023.840', 1));
  add(w.reachedTp1('4023.840', 7));
  add(w.tracked(9));
  return texts;
}

describe('both languages have every word', () => {
  it('has the same entries in English and in Hinglish', () => {
    expect(Object.keys(hinglish).sort()).toEqual(Object.keys(en).sort());
  });

  it('has a word for every group, grade, news state, scope, cause, exit profile and exit reason', () => {
    for (const w of [en, hinglish]) {
      expect(Object.keys(w.groupName).sort()).toEqual([...QUALITY_GROUPS].sort());
      expect(Object.keys(w.grade).sort()).toEqual([...GRADES].sort());
      expect(Object.keys(w.macroState).sort()).toEqual([...NEWS_STATES].sort());
      expect(Object.keys(w.scope).sort()).toEqual([...STATS_SCOPES].sort());
      expect(Object.keys(w.causeRule).sort()).toEqual([...CAUSE_CODES].sort());
      expect(Object.keys(w.tp1Note).sort()).toEqual([...EXIT_PROFILES].sort());
      expect(Object.keys(w.exitName).sort()).toEqual([...EXIT_REASONS].sort());
      expect(Object.keys(w.categoryName)).toHaveLength(4);
    }
  });

  it('makes only non-empty texts', () => {
    for (const w of [en, hinglish]) {
      for (const text of everyText(w)) expect(text.trim().length, text).toBeGreaterThan(0);
    }
  });

  it('never says guaranteed, sure, certain or risk-free (honest wording, UI spec section 1)', () => {
    for (const w of [en, hinglish]) {
      for (const text of everyText(w)) {
        expect(text, text).not.toMatch(/\b(guaranteed|sure|certain|risk[- ]free|pakka)\b/i);
      }
    }
  });

  it('says that a rate is not a guarantee in both languages', () => {
    expect(en.disclaimer).toBe('This is a historical frequency, not a guarantee.');
    expect(hinglish.disclaimer).toBe('Ye pichhle records ki frequency hai, guarantee nahi.');
  });
});

describe('what is the same in both languages', () => {
  it('has the same label for a paper strategy, a replay and a validated strategy', () => {
    expect(hinglish.paperLabel).toBe(en.paperLabel);
    expect(hinglish.simulatedLabel).toBe(en.simulatedLabel);
    expect(hinglish.validatedLabel).toBe(en.validatedLabel);
    expect(en.paperLabel).toBe('FORWARD-TEST (paper)');
  });

  it('has the same labels for the levels', () => {
    for (const key of ['entry', 'stop', 'tp1', 'tp2'] as const) expect(hinglish[key]).toBe(en[key]);
  });

  it('has other words for the sentences', () => {
    expect(hinglish.whyHeader).not.toBe(en.whyHeader);
    expect(hinglish.manualOnly).not.toBe(en.manualOnly);
    expect(hinglish.weak).not.toBe(en.weak);
    expect(hinglish.tp1Action('1')).not.toBe(en.tp1Action('1'));
  });
});

describe('common helpers', () => {
  it('writes the public number of a signal', () => {
    expect(signalTag(42)).toBe('#S-0042');
    expect(signalTag(7)).toBe('#S-0007');
    expect(signalTag(12345)).toBe('#S-12345');
  });

  it('reads the reward of a level in R from the entry, for either side', () => {
    expect(rewardR(BUY_SIGNAL, 4023.84)).toBeCloseTo(1, 9);
    expect(rewardR(BUY_SIGNAL, 4030.31)).toBeCloseTo(2, 9);
    expect(rewardR(SELL_SIGNAL, 3965.26)).toBeCloseTo(1, 9);
    expect(rewardR(SELL_SIGNAL, 3947.89)).toBeCloseTo(2, 9);
  });

  it('puts the category in words after the code of a cause', () => {
    expect(causeText('NO_FOLLOW_THROUGH', en)).toBe('NO_FOLLOW_THROUGH (Setup failure)');
    expect(causeText('NEWS_SHOCK', en)).toBe('NEWS_SHOCK (Market event)');
    expect(causeText('SPREAD_COST', en)).toBe('SPREAD_COST (Execution)');
    expect(causeText('NORMAL_LOSS', hinglish)).toBe('NORMAL_LOSS (Setup ki kami)');
  });

  it('writes the numbers behind a cause as one line', () => {
    expect(evidenceText({})).toBe('');
    expect(evidenceText({ maxFavourableR: 0.2 })).toBe('max favourable R 0.2');
    expect(evidenceText({ costShareOfRisk: 0.3333, flag: true, off: false })).toBe(
      'cost share of risk 0.33, flag yes, off no',
    );
    expect(evidenceText({ topics: ['A', 'B'], empty: [], nested: { a: 1 }, nothing: null })).toBe(
      'topics A, B',
    );
    expect(evidenceText({ bad: Number.NaN, usdMove: 3.1 })).toBe('USD move 3.1');
  });

  it('turns a key of the review into words, as the dashboard does', () => {
    expect(humanizeKey('maxFavourableR')).toBe('max favourable R');
    expect(humanizeKey('atrRatio')).toBe('ATR ratio');
    expect(humanizeKey('tp1Reached')).toBe('TP1 reached');
    expect(humanizeKey('htfBreakAt')).toBe('HTF break at');
    expect(humanizeKey('spread')).toBe('spread');
  });

  it('writes the label line of a paper, a simulated and a validated signal', () => {
    expect(labelLine(BUY_SIGNAL, en, false)).toBe('FORWARD-TEST (paper)');
    expect(labelLine({ ...BUY_SIGNAL, mode: 'SIMULATED' }, en, true)).toBe(
      'SIMULATED | replay data, not the live market',
    );
    expect(labelLine({ ...BUY_SIGNAL, strategyStatus: 'VALIDATED' }, hinglish, true)).toBe(
      'VALIDATED strategy | Order aapko khud haath se lagana hai.',
    );
  });
});
