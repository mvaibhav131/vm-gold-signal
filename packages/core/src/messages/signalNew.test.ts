import { describe, expect, it } from 'vitest';

import { buildExplanation } from '../explain/build';
import {
  EVIDENCE_INSUFFICIENT,
  EVIDENCE_NORMAL,
  explanationInputOf,
  flagOf,
} from '../explain/test-data';
import type { ExplanationDoc, ExplanationHeadline } from '../explain/types';
import { DECIDED_AT } from '../trade/test-data';
import { TELEGRAM_SOFT_LIMIT, escapeHtml } from './text';
import { BUY_SIGNAL, EXPLANATION, SELL_EXPLANATION, SELL_SIGNAL, newSignal } from './test-data';
import { SIGNAL_NEW_LEVELS, renderSignalNew, signalNewLines } from './signalNew';
import type { DisplayOptions, SignalRef } from './types';
import { WORDS } from './words';

const IST: DisplayOptions = { locale: 'en', displayTz: 'Asia/Kolkata' };
const HINGLISH: DisplayOptions = { locale: 'hinglish', displayTz: 'Asia/Kolkata' };

const text = (data = newSignal(), options = IST): string => renderSignalNew(data, options).text;
const withDoc = (change: Partial<ExplanationDoc>) =>
  newSignal(BUY_SIGNAL, { ...EXPLANATION, ...change });

describe('the entry alert of the example, golden', () => {
  it('in English', () => {
    expect(text()).toBe(
      [
        'FORWARD-TEST (paper) | Manual execution only.',
        'BUY XAUUSD | Trend Pullback v0.1.0 | #S-0042',
        '',
        'Entry  4017.370   (do not chase above 4018.015)',
        'Stop   4010.900   (-6.470)',
        'TP1    4023.840   (1.00R)  close 50%, move stop to entry',
        'TP2    4030.310   (2.00R)  runner',
        'Valid for 3 min (until 11:38 IST). Time stop 2 h (13:35 IST).',
        '',
        'Setup quality 95/100 (Very strong)',
        'WHY THIS SIGNAL',
        '[+] Trend STRONG: 1h EMA 20&gt;50&gt;200; 1h EMA 50 slope (3 h) +0.50 ATR(1h); ADX(1h) 31 (+DI 30 / -DI 10); Supertrend 1h up',
        '[+] Structure STRONG: Structure 15m / 5m up / up; Latest 5m break with the trade; Trendline and zone confluence 2 agree; Pullback 4021.300 → 4012.800, EMA and Fibonacci zone; 5m swing level 4014.200, closed beyond it',
        '[+] Trigger and momentum STRONG: Trigger candle range 1.4 x ATR, closed at 85% of its range; RSI(5m) 38 → 54; MACD histogram rising 3 candles; Displacement candle yes',
        '[+] Volatility STRONG: ATR(5m) 4.3; ATR percentile 62nd; Squeeze none',
        '[+] Execution STRONG: Spread 0.12; Spread percentile 35th; Stop distance 1.5 x ATR',
        '[+] Session and macro STRONG: Session London; High-impact USD event in 4 h 25 min',
        '[+] Reward feasibility STRONG: TP1 distance 1.5 x ATR; Room to the next level 2.3 x the distance to TP1',
        '[~] Weak: none',
        '[?] Research only (not used): DXY 15m -0.2%; Silver 15m +0.3%',
        'Macro: clear. Next high-impact event: CPI m/m at 16:00 IST (in 4 h 25 min).',
        '[!] Warnings:',
        '- FORWARD-TEST: this strategy is not validated yet (paper signal)',
        'News (last 60 min): no headline',
        'Open signals now: none (open risk 0.00R)',
        '',
        'EVIDENCE (same setup type)',
        'Win rate 58%  (n=64, 95% CI 46-69%)  Expectancy +0.31R  PF 1.50',
        'TP1 reached 70%, TP2 reached 40%.',
        'Source: forward paper trades. Match: strategy, side and session. Low sample.',
        'This is a historical frequency, not a guarantee. 1R = 6.470 USD per oz.',
      ].join('\n'),
    );
  });

  it('in Hinglish: the same numbers, other labels', () => {
    expect(text(newSignal(), HINGLISH)).toBe(
      [
        'FORWARD-TEST (paper) | Order aapko khud haath se lagana hai.',
        'BUY XAUUSD | Trend Pullback v0.1.0 | #S-0042',
        '',
        'Entry  4017.370   (4018.015 se upar entry mat lo)',
        'Stop   4010.900   (-6.470)',
        'TP1    4023.840   (1.00R)  50% band karo, stop entry par le aao',
        'TP2    4030.310   (2.00R)  runner (bacha hua hissa)',
        '3 min tak valid (11:38 IST tak). Time stop 2 h (13:35 IST).',
        '',
        'Setup quality 95/100 (Bahut strong)',
        'YE SIGNAL KYUN AAYA',
        '[+] Trend STRONG: 1h EMA 20&gt;50&gt;200; 1h EMA 50 slope (3 h) +0.50 ATR(1h); ADX(1h) 31 (+DI 30 / -DI 10); Supertrend 1h up',
        '[+] Structure STRONG: Structure 15m / 5m up / up; Latest 5m break with the trade; Trendline and zone confluence 2 agree; Pullback 4021.300 → 4012.800, EMA and Fibonacci zone; 5m swing level 4014.200, closed beyond it',
        '[+] Trigger aur momentum STRONG: Trigger candle range 1.4 x ATR, closed at 85% of its range; RSI(5m) 38 → 54; MACD histogram rising 3 candles; Displacement candle yes',
        '[+] Volatility STRONG: ATR(5m) 4.3; ATR percentile 62nd; Squeeze none',
        '[+] Execution STRONG: Spread 0.12; Spread percentile 35th; Stop distance 1.5 x ATR',
        '[+] Session aur macro STRONG: Session London; High-impact USD event in 4 h 25 min',
        '[+] Reward (target kitna door hai) STRONG: TP1 distance 1.5 x ATR; Room to the next level 2.3 x the distance to TP1',
        '[~] Kamzor: koi nahi',
        '[?] Sirf research (signal mein use nahi hua): DXY 15m -0.2%; Silver 15m +0.3%',
        'Macro: clear. Agla bada event: CPI m/m, 16:00 IST (4 h 25 min mein).',
        '[!] Chetavni:',
        '- FORWARD-TEST: this strategy is not validated yet (paper signal)',
        'News (pichhle 60 min): koi headline nahi',
        'Abhi khule signals: koi nahi (khula risk 0.00R)',
        '',
        'EVIDENCE (isi tarah ke setup ka record)',
        'Win rate 58%  (n=64, 95% CI 46-69%)  Expectancy +0.31R  PF 1.50',
        'TP1 tak 70% baar, TP2 tak 40% baar.',
        'Source: forward paper trades. Match: strategy, side and session. Sample kam hai.',
        'Ye pichhle records ki frequency hai, guarantee nahi. 1R = 6.470 USD per oz.',
      ].join('\n'),
    );
  });

  it('is a full message: level 0, nothing left out', () => {
    const message = renderSignalNew(newSignal(), IST);
    expect(message).toMatchObject({ kind: 'SIGNAL_NEW', level: 0, dropped: [] });
  });
});

describe('a SELL', () => {
  it('has its stop above, its targets below and its chase limit below the entry', () => {
    const message = text(newSignal(SELL_SIGNAL, SELL_EXPLANATION));
    expect(message).toContain('SELL XAUUSD | Trend Pullback v0.1.0 | #S-0043');
    expect(message).toContain('Entry  3982.630   (do not chase below 3981.985)');
    expect(message).toContain('Stop   4000.000   (+17.370)');
    expect(message).toContain('TP1    3965.260   (1.00R)  close 50%, move stop to entry');
    expect(message).toContain('TP2    3947.890   (2.00R)  runner');
    expect(message).toContain('1R = 17.370 USD per oz.');
  });

  it('says below in Hinglish too', () => {
    expect(text(newSignal(SELL_SIGNAL, SELL_EXPLANATION), HINGLISH)).toContain(
      'Entry  3982.630   (3981.985 se neeche entry mat lo)',
    );
  });
});

describe('the label in the first line (rules C8 and C9)', () => {
  const first = (signal: SignalRef, options = IST) =>
    renderSignalNew(newSignal(signal, EXPLANATION), options).text.split('\n')[0];

  it('says FORWARD-TEST (paper) until a strategy is validated', () => {
    for (const strategyStatus of [
      'RESEARCH',
      'BACKTESTED',
      'FORWARD_TESTING',
      'PAUSED',
      'DRIFTED',
    ] as const) {
      expect(first({ ...BUY_SIGNAL, strategyStatus }), strategyStatus).toBe(
        'FORWARD-TEST (paper) | Manual execution only.',
      );
    }
  });

  it('says VALIDATED for a validated strategy, and still that the order is placed by hand', () => {
    expect(first({ ...BUY_SIGNAL, strategyStatus: 'VALIDATED' })).toBe(
      'VALIDATED strategy | Manual execution only.',
    );
  });

  it('says SIMULATED for replay and backtest data, whatever the strategy status', () => {
    for (const mode of ['SIMULATED', 'BACKTEST'] as const) {
      expect(first({ ...BUY_SIGNAL, mode }), mode).toBe(
        'SIMULATED | replay data, not the live market',
      );
      expect(first({ ...BUY_SIGNAL, mode, strategyStatus: 'VALIDATED' }, HINGLISH)).toBe(
        'SIMULATED | ye replay data hai, live market nahi',
      );
    }
  });

  it('starts with the paper label in both languages', () => {
    expect(text(newSignal(), IST).startsWith('FORWARD-TEST (paper)')).toBe(true);
    expect(text(newSignal(), HINGLISH).startsWith('FORWARD-TEST (paper)')).toBe(true);
  });
});

describe('the targets of the other exit profiles', () => {
  const messageOf = (profile: SignalRef['exitProfile'], tp1: number, tp2: number | null) => {
    const signal: SignalRef = { ...BUY_SIGNAL, exitProfile: profile, tp1, tp2 };
    const explanation = buildExplanation(
      explanationInputOf({
        plan: {
          entry: signal.entry,
          maxValidEntry: signal.maxValidEntry,
          stopLoss: signal.stopLoss,
          tp1,
          tp2,
          riskDistance: signal.riskDistance,
        },
      }),
    );
    return text(newSignal(signal, explanation));
  };

  it('has no TP2 line and closes everything at the single target', () => {
    const message = messageOf('EP2_SINGLE', 4027.075, null);
    expect(message).toContain('TP1    4027.075   (1.50R)  close all');
    expect(message).not.toMatch(/^TP2 {2}/m);
    expect(message).not.toContain('runner');
  });

  it('words a structure target and shows a distance that is not a round R', () => {
    const message = messageOf('EP3_STRUCTURE', 4026, null);
    expect(message).toContain('TP1    4026.000   (1.33R)  close all (nearest opposing level)');
    expect(message).not.toMatch(/^TP2 {2}/m);
  });
});

describe('times', () => {
  it('shows the day when the time stop falls on the next day of the display zone', () => {
    const generatedAt = Date.UTC(2026, 9, 23, 18, 25); // 23:55 IST
    const signal: SignalRef = {
      ...BUY_SIGNAL,
      generatedAt,
      entryValidUntil: generatedAt + 3 * 60_000,
      timeStopAt: generatedAt + 120 * 60_000,
    };
    const message = text(newSignal(signal, EXPLANATION));
    expect(message).toContain(
      'Valid for 3 min (until 23:58 IST). Time stop 2 h (01:55 IST (24 Oct)).',
    );
  });

  it('shows the times in the display zone', () => {
    expect(text(newSignal(), { locale: 'en', displayTz: 'UTC' })).toContain(
      'Valid for 3 min (until 06:08 UTC). Time stop 2 h (08:05 UTC).',
    );
  });

  it('counts a validity that is not whole minutes', () => {
    const signal = { ...BUY_SIGNAL, entryValidUntil: DECIDED_AT + 45_000 };
    expect(text(newSignal(signal, EXPLANATION))).toContain('Valid for 45 s (until 11:35 IST).');
  });
});

describe('the groups', () => {
  const marks = (change: Partial<ExplanationDoc['groups'][number]>[]) => {
    const groups = EXPLANATION.groups.map((group, index) => ({
      ...group,
      ...(change[index] ?? {}),
    }));
    return text(withDoc({ groups }))
      .split('\n')
      .filter((line) => /^\[(\+|~|-|n\/a)\] /.test(line));
  };

  it('marks every state: + for strong and OK, ~ for weak, - for failed, n/a for no data', () => {
    const lines = marks([
      { state: 'OK' },
      { state: 'WEAK' },
      { state: 'FAIL' },
      { state: 'NA', facts: [] },
    ]);
    expect(lines.map((line) => line.split(' ')[0])).toEqual([
      '[+]', // OK
      '[~]', // WEAK
      '[-]', // FAIL
      '[n/a]', // NA
      '[+]',
      '[+]',
      '[+]',
      '[~]', // the weak line itself
    ]);
    expect(lines[0]).toContain('Trend OK: ');
    expect(lines[3]).toBe('[n/a] Volatility NA: no data');
  });

  it('shows a group with no facts as its state only', () => {
    const lines = marks([{ state: 'FAIL', facts: [] }]);
    expect(lines[0]).toBe('[-] Trend FAIL');
  });

  it('lists the weak points and says none when there are none', () => {
    const message = text(
      withDoc({ weak: ['the 1h Supertrend is against the trade', 'a squeeze is still on'] }),
    );
    expect(message).toContain(
      '[~] Weak: the 1h Supertrend is against the trade; a squeeze is still on',
    );
    expect(text()).toContain('[~] Weak: none');
  });

  it('leaves out the research-only line when there is none', () => {
    expect(text(withDoc({ researchOnly: [] }))).not.toContain('Research only');
  });
});

describe('macro, warnings and open signals', () => {
  it('says the calendar state, and the next event only when there is one', () => {
    expect(text(withDoc({ macro: { state: 'CLEAR', next: null } }))).toContain(
      'Macro: clear. No high-impact event is known ahead.',
    );
    expect(text(withDoc({ macro: { state: 'IN_WINDOW', next: null } }))).toContain(
      'Macro: inside a news window.\n',
    );
    expect(text(withDoc({ macro: { state: 'UNKNOWN', next: null } }))).toContain(
      'Macro: calendar unavailable.\n',
    );
  });

  it('shows the next event on the next day with its date', () => {
    const next = { name: 'NFP', at: '2026-10-24T12:30:00.000Z' };
    expect(text(withDoc({ macro: { state: 'CLEAR', next } }))).toContain(
      'Next high-impact event: NFP at 18:00 IST (24 Oct) (in 30 h 25 min).',
    );
  });

  it('lists every warning on its own line, and says none when there are none', () => {
    const warnings: ExplanationDoc['warnings'] = [
      { code: 'NEWS_WINDOW', text: 'News window: CPI m/m in 22 min' },
      { code: 'OPPOSES_OPEN', text: 'Opposes open signal #S-0041' },
    ];
    const message = text(withDoc({ warnings }));
    expect(message).toContain(
      '[!] Warnings:\n- News window: CPI m/m in 22 min\n- Opposes open signal #S-0041\n',
    );
    expect(text(withDoc({ warnings: [] }))).toContain('[!] Warnings: none');
  });

  it('shows the open signals and their risk', () => {
    expect(text(withDoc({ open: { count: 2, riskR: 2 } }))).toContain(
      'Open signals now: 2 (open risk 2.00R)',
    );
    expect(text(withDoc({ open: { count: 1, riskR: 0.5 } }), HINGLISH)).toContain(
      'Abhi khule signals: 1 (khula risk 0.50R)',
    );
  });
});

describe('news', () => {
  const headline = (change: Partial<ExplanationHeadline> = {}): ExplanationHeadline => ({
    title: 'Fed holds rates steady',
    sources: ['BBC', 'CNBC'],
    publishedAt: '2026-10-23T05:42:00.000Z',
    impact: 'HIGH',
    topics: ['FED_RATES'],
    url: 'https://example.com/a',
    classified: true,
    ...change,
  });

  it('says that the feed is unavailable, which is not the same as no news', () => {
    expect(text(withDoc({ news: { feed: 'UNAVAILABLE', headlines: [] } }))).toContain(
      'News (last 60 min): headline feed unavailable (this is not the same as no news)',
    );
  });

  it('lists the headlines with their impact, sources and time, and says they are context', () => {
    const message = text(
      withDoc({
        news: {
          feed: 'AVAILABLE',
          headlines: [
            headline(),
            headline({
              title: 'Gold edges higher',
              sources: ['Al Jazeera'],
              publishedAt: null,
              impact: null,
              topics: [],
              classified: false,
            }),
          ],
        },
      }),
    );
    expect(message).toContain(
      [
        'News (last 60 min):',
        '- [HIGH] Fed holds rates steady (BBC, CNBC, 11:12 IST)',
        '- [unclassified] Gold edges higher (Al Jazeera)',
        'Context only, not a reason for the trade.',
      ].join('\n'),
    );
  });

  it('escapes what a headline says, so that it cannot add a tag', () => {
    const message = text(
      withDoc({
        news: {
          feed: 'AVAILABLE',
          headlines: [headline({ title: 'Gold <b>spikes</b> & "falls" > 1%' })],
        },
      }),
    );
    expect(message).toContain('- [HIGH] Gold &lt;b&gt;spikes&lt;/b&gt; &amp; "falls" &gt; 1% (BBC');
    expect(message).not.toContain('<b>');
  });
});

describe('evidence', () => {
  it('says that there is not enough evidence, with the counts and no percentage (rule C6)', () => {
    const message = text(withDoc({ evidence: EVIDENCE_INSUFFICIENT }));
    expect(message).toContain(
      [
        'EVIDENCE (same setup type)',
        'Insufficient evidence: 12 resolved trades of this setup type so far (7 wins). A win rate is shown from 30 trades.',
        'Source: forward paper trades. Match: strategy and side, all versions.',
      ].join('\n'),
    );
    expect(message).not.toContain('Win rate');
    expect(text(withDoc({ evidence: EVIDENCE_INSUFFICIENT }), HINGLISH)).toContain(
      'Evidence abhi kaafi nahi hai: is setup ke 12 resolved trades hue (7 win). Win rate 30 trades se dikhta hai.',
    );
  });

  it('does not show a win rate that has no interval, even if the label says otherwise', () => {
    const odd = { ...EVIDENCE_NORMAL, winRate: null };
    expect(text(withDoc({ evidence: odd }))).toContain('Insufficient evidence');
  });

  it('has no low-sample note from 100 trades, and names the backtest', () => {
    const message = text(withDoc({ evidence: EVIDENCE_NORMAL }));
    expect(message).toContain('Win rate 55%  (n=240, 95% CI 48-61%)  Expectancy +0.31R  PF 1.50');
    expect(message).toContain(
      'Source: out-of-sample backtest. Match: strategy, side, session, regime and volatility.\n',
    );
    expect(message).not.toContain('Low sample');
  });

  it('shows only the figures that exist', () => {
    const message = text(
      withDoc({
        evidence: {
          ...EVIDENCE_NORMAL,
          expectancyR: null,
          profitFactor: null,
          tp1Rate: 0.62,
          tp2Rate: null,
        },
      }),
    );
    expect(message).toContain('Win rate 55%  (n=240, 95% CI 48-61%)\nTP1 reached 62%.\nSource:');
    expect(message).not.toContain('Expectancy');
    expect(message).not.toContain('PF');
  });

  it('always ends with the statement that this is not a guarantee, and the size of 1R', () => {
    for (const options of [IST, HINGLISH]) {
      const lines = text(newSignal(), options).split('\n');
      expect(lines.at(-1)).toMatch(/guarantee/);
      expect(lines.at(-1)).toContain('1R = 6.470 USD per oz.');
    }
  });
});

describe('every required field, in both languages (04 section 4.1)', () => {
  it.each([
    ['en', IST],
    ['hinglish', HINGLISH],
  ] as const)('%s', (_name, options) => {
    const message = text(newSignal(), options);
    const w = WORDS[options.locale];
    const required = [
      'BUY XAUUSD', // direction
      'Trend Pullback v0.1.0', // strategy and version
      '#S-0042', // id
      w.paperLabel, // paper-test label
      '4017.370', // entry
      '4018.015', // the do-not-chase level
      '4010.900', // stop
      '(-6.470)', // stop distance
      '4023.840', // TP1
      '(1.00R)',
      w.tp1Note.EP1_PARTIAL, // the partial-exit instruction
      '4030.310', // TP2
      '(2.00R)',
      '11:38 IST', // validity
      '13:35 IST', // time stop
      'Setup quality 95/100', // quality
      w.grade['Very strong'],
      w.whyHeader,
      ...Object.values(w.groupName), // one line per group
      w.weak,
      w.researchOnly,
      w.macro,
      w.warnings,
      w.newsTitle,
      w.openSignals,
      w.evidenceTitle,
      'n=64',
      '46-69%',
      w.disclaimer,
      w.oneR('6.470'),
    ];
    for (const part of required) expect(message, part).toContain(part);
  });
});

describe('the explanation and the signal must agree', () => {
  it('refuses a message whose explanation has other levels', () => {
    const other = { ...EXPLANATION, levels: { ...EXPLANATION.levels, tp1: 4024 } };
    expect(() => renderSignalNew(newSignal(BUY_SIGNAL, other), IST)).toThrow(RangeError);
    const stop = { ...EXPLANATION, levels: { ...EXPLANATION.levels, stop: 4010.8 } };
    expect(() => renderSignalNew(newSignal(BUY_SIGNAL, stop), IST)).toThrow(RangeError);
    const risk = { ...EXPLANATION, levels: { ...EXPLANATION.levels, riskUsd: 6.4 } };
    expect(() => renderSignalNew(newSignal(BUY_SIGNAL, risk), IST)).toThrow(RangeError);
    const maxValid = { ...EXPLANATION, levels: { ...EXPLANATION.levels, maxValidEntry: 4018 } };
    expect(() => renderSignalNew(newSignal(BUY_SIGNAL, maxValid), IST)).toThrow(RangeError);
    const entry = { ...EXPLANATION, levels: { ...EXPLANATION.levels, entry: 4017.4 } };
    expect(() => renderSignalNew(newSignal(BUY_SIGNAL, entry), IST)).toThrow(RangeError);
    const tp2 = { ...EXPLANATION, levels: { ...EXPLANATION.levels, tp2: null } };
    expect(() => renderSignalNew(newSignal(BUY_SIGNAL, tp2), IST)).toThrow(RangeError);
  });
});

/** An explanation as long as the sliders say: facts per group, research-only readings, headlines. */
function bigExplanation(
  facts: number,
  research: number,
  titleLength: number,
  valueLength = 35,
): ExplanationDoc {
  const filler = (index: number) => `${'x'.repeat(valueLength)}${String(index)}`;
  const headlines: ExplanationHeadline[] = [1, 2, 3].map((n) => ({
    title: `${'h'.repeat(titleLength)}${String(n)}`,
    sources: ['BBC', 'CNBC'],
    publishedAt: '2026-10-23T05:42:00.000Z',
    impact: 'HIGH',
    topics: ['FED_RATES'],
    url: 'https://example.com/a',
    classified: true,
  }));
  return {
    ...EXPLANATION,
    groups: EXPLANATION.groups.map((group, g) => ({
      ...group,
      facts: Array.from({ length: facts }, (_unused, index) => ({
        label: `Fact ${String(g)}-${String(index)}`,
        value: filler(index),
      })),
    })),
    weak: ['the spread is wide (95th percentile)', 'a squeeze is still on'],
    researchOnly: Array.from({ length: research }, (_unused, index) => ({
      label: `Reading ${String(index)}`,
      value: filler(index),
    })),
    news: { feed: 'AVAILABLE', headlines },
  };
}

describe('length (04 section 4: under 3500 characters, optional parts go first)', () => {
  const sweep = [
    [2, 2, 40, 35],
    [4, 8, 120, 35],
    [4, 14, 200, 35],
    [8, 14, 200, 35],
    [10, 20, 250, 35],
    [14, 20, 250, 35],
    [20, 20, 250, 35],
    [30, 25, 300, 35],
    [3, 2, 40, 200],
    [4, 4, 100, 200],
    [3, 2, 40, 600],
  ] as const;

  it('chooses the first level of detail whose text is within the limit', () => {
    const levels = new Set<number>();
    for (const [facts, research, title, value] of sweep) {
      const data = newSignal(BUY_SIGNAL, bigExplanation(facts, research, title, value));
      const chosen = renderSignalNew(data, IST);
      levels.add(chosen.level);
      const lengths = Array.from(
        { length: SIGNAL_NEW_LEVELS },
        (_unused, level) => escapeHtml(signalNewLines(data, IST, level).lines.join('\n')).length,
      );
      const firstFit = lengths.findIndex((length) => length <= TELEGRAM_SOFT_LIMIT);
      expect(chosen.level, JSON.stringify([facts, research, title, value, lengths])).toBe(
        firstFit === -1 ? SIGNAL_NEW_LEVELS - 1 : firstFit,
      );
      expect(chosen.text).toBe(
        escapeHtml(signalNewLines(data, IST, chosen.level).lines.join('\n')),
      );
    }
    expect([...levels].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('never trims the levels, the stop, the targets, the quality, the warnings or the evidence', () => {
    for (const [facts, research, title, value] of sweep) {
      const data = newSignal(BUY_SIGNAL, bigExplanation(facts, research, title, value));
      for (let level = 0; level < SIGNAL_NEW_LEVELS; level += 1) {
        const message = signalNewLines(data, IST, level).lines.join('\n');
        for (const part of [
          'FORWARD-TEST (paper)',
          'Entry  4017.370   (do not chase above 4018.015)',
          'Stop   4010.900   (-6.470)',
          'TP1    4023.840',
          'TP2    4030.310',
          'Valid for 3 min',
          'Setup quality 95/100 (Very strong)',
          '[!] Warnings:',
          'Open signals now: none',
          'EVIDENCE (same setup type)',
          'Win rate 58%  (n=64, 95% CI 46-69%)',
          'This is a historical frequency, not a guarantee. 1R = 6.470 USD per oz.',
        ]) {
          expect(message, `level ${String(level)}: ${part}`).toContain(part);
        }
        // every group keeps its line with its state
        expect(message.match(/^\[\+\] .* STRONG/gm)).toHaveLength(7);
      }
    }
  });

  it('leaves out research-only lines first, then headlines and facts, and says what', () => {
    const data = newSignal(BUY_SIGNAL, bigExplanation(4, 14, 200));
    const at = (level: number) => signalNewLines(data, IST, level);
    expect(at(0).dropped).toEqual([]);
    expect(at(1).dropped).toEqual(['research only']);
    expect(at(2).dropped).toEqual(['research only', 'headlines', 'facts beyond 3 per group']);
    expect(at(3).dropped).toEqual([
      'research only',
      'headlines',
      'facts beyond 1 per group',
      'weak beyond 3',
    ]);
    expect(at(4).dropped).toEqual(['research only', 'headlines', 'all facts', 'weak beyond 1']);

    expect(at(0).lines.join('\n')).toContain('Research only');
    expect(at(1).lines.join('\n')).not.toContain('Research only');
    expect(at(1).lines.join('\n')).toContain('- [HIGH] ');
    expect(at(2).lines.join('\n')).toContain(
      'News (last 60 min): 3 headlines in the last 60 min, see the dashboard',
    );
    expect(at(2).lines.join('\n')).not.toContain('- [HIGH] ');
    expect(at(2).lines.join('\n')).toContain('Fact 0-2');
    expect(at(2).lines.join('\n')).not.toContain('Fact 0-3');
    expect(at(3).lines.join('\n')).toContain('Fact 0-0');
    expect(at(3).lines.join('\n')).not.toContain('Fact 0-1');
    expect(at(4).lines.join('\n')).not.toContain('Fact 0-0');
    expect(at(4).lines.join('\n')).toContain('[+] Trend STRONG\n');
  });

  it('keeps fewer weak points at the lower levels', () => {
    const many = {
      ...bigExplanation(4, 2, 40),
      weak: ['one', 'two', 'three', 'four', 'five'],
    };
    const weak = (level: number) =>
      signalNewLines(newSignal(BUY_SIGNAL, many), IST, level).lines.find((line) =>
        line.startsWith('[~] Weak'),
      );
    expect(weak(0)).toBe('[~] Weak: one; two; three; four; five');
    expect(weak(2)).toBe('[~] Weak: one; two; three; four; five');
    expect(weak(3)).toBe('[~] Weak: one; two; three');
    expect(weak(4)).toBe('[~] Weak: one');
  });

  it('refuses a message that is longer than Telegram accepts even at the lowest level', () => {
    const huge = withDoc({
      warnings: Array.from({ length: 6 }, (_unused, index) => ({
        code: 'NEWS_WINDOW' as const,
        text: `${'w'.repeat(900)}${String(index)}`,
      })),
    });
    expect(() => renderSignalNew(huge, IST)).toThrow(RangeError);
  });

  it('counts the length of the escaped text, which is what Telegram counts', () => {
    let found = false;
    for (let research = 1; research <= 80 && !found; research += 1) {
      const doc: ExplanationDoc = {
        ...bigExplanation(2, 0, 40),
        researchOnly: Array.from({ length: research }, (_unused, index) => ({
          label: `Reading ${String(index)}`,
          value: '>'.repeat(40),
        })),
      };
      const data = newSignal(BUY_SIGNAL, doc);
      const raw = signalNewLines(data, IST, 0).lines.join('\n');
      if (raw.length > TELEGRAM_SOFT_LIMIT || escapeHtml(raw).length <= TELEGRAM_SOFT_LIMIT)
        continue;
      // the raw text fits and the escaped one does not: the escaped one is what counts
      found = true;
      const message = renderSignalNew(data, IST);
      expect(message.level).toBeGreaterThan(0);
      expect(message.text.length).toBeLessThanOrEqual(TELEGRAM_SOFT_LIMIT);
      expect(message.dropped).toContain('research only');
    }
    expect(found).toBe(true);
  });

  it('writes the angle brackets of a fact as entities', () => {
    const doc = { ...EXPLANATION, weak: ['spread > 2 & rising'] };
    expect(text(newSignal(BUY_SIGNAL, doc))).toContain('[~] Weak: spread &gt; 2 &amp; rising');
  });
});

describe('what the flags say reaches the message', () => {
  it('shows the quality score as a whole number, rounded', () => {
    const quality = (score: number) => text(withDoc({ quality: { score, grade: 'Moderate' } }));
    expect(quality(72.6)).toContain('Setup quality 73/100 (Moderate)');
    expect(quality(72.4)).toContain('Setup quality 72/100 (Moderate)');
  });
  it('shows the warnings that the explanation was built with', () => {
    const doc = buildExplanation(
      explanationInputOf({
        flags: [
          flagOf('ROLLOVER', { session: 'ROLLOVER' }),
          flagOf('UNVALIDATED_STRATEGY', { status: 'FORWARD_TESTING' }),
        ],
      }),
    );
    expect(text(newSignal(BUY_SIGNAL, doc))).toContain(
      '[!] Warnings:\n- Rollover hours: liquidity is thin and spreads can be wide\n- FORWARD-TEST: this strategy is not validated yet (paper signal)\n',
    );
  });
});
