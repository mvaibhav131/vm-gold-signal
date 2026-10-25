import {
  CAUSE_CODES,
  GROUP_NAMES,
  QUALITY_GROUPS,
  STATS_SCOPES,
  STRATEGY_KEYS,
  STRATEGY_NAMES,
  WORDS,
  humanizeKey,
  matchLevelText as coreMatchLevelText,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  CATEGORY_LABELS,
  CAUSE_RULES,
  GROUP_LABELS,
  STRATEGY_LABELS,
  humanizeKey as webHumanizeKey,
  matchLevelText,
  scopeText,
} from './signal';

// The dashboard and the Telegram messages use the same words (UI spec: "exactly as sent to Telegram").
// The dashboard keeps its own copy for the screens; these tests keep the two from drifting apart.

describe('the words of the dashboard are the words of the messages', () => {
  it('the names of the strategies', () => {
    for (const key of STRATEGY_KEYS) expect(STRATEGY_LABELS[key], key).toBe(STRATEGY_NAMES[key]);
  });

  it('the names of the seven groups', () => {
    for (const group of QUALITY_GROUPS) expect(GROUP_LABELS[group], group).toBe(GROUP_NAMES[group]);
    expect(WORDS.en.groupName).toEqual(GROUP_LABELS);
  });

  it('the rule behind each cause and the category names', () => {
    for (const code of CAUSE_CODES) expect(CAUSE_RULES[code], code).toBe(WORDS.en.causeRule[code]);
    expect(CATEGORY_LABELS).toEqual(WORDS.en.categoryName);
  });

  it('the bucket of the evidence and its source', () => {
    for (const level of [0, 1, 2, 3, 4, 7]) {
      expect(matchLevelText(level), String(level)).toBe(coreMatchLevelText(level));
    }
    for (const scope of STATS_SCOPES) expect(scopeText(scope), scope).toBe(WORDS.en.scope[scope]);
  });

  it('the words made of a key of the review', () => {
    for (const key of [
      'maxFavourableR',
      'candlesToTp1AfterStop',
      'adverseMoveAtr',
      'shareOfRisk',
      'limit',
      'htfBreakAt',
      'usdMove',
    ]) {
      expect(webHumanizeKey(key), key).toBe(humanizeKey(key));
    }
  });
});
