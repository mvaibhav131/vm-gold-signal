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
import { TELEGRAM_SOFT_LIMIT } from './text';
import { checkTelegramHtml, renderHtml } from './markup';
import { ICON, STATE_ICON } from './style';
import { plain } from './test-html';
import { BUY_SIGNAL, EXPLANATION, SELL_EXPLANATION, SELL_SIGNAL, newSignal } from './test-data';
import { SIGNAL_NEW_LEVELS, renderSignalNew, signalNewLines } from './signalNew';
import type { DisplayOptions, SignalRef } from './types';
import { WORDS } from './words';

const IST: DisplayOptions = { locale: 'en', displayTz: 'Asia/Kolkata' };
const HINGLISH: DisplayOptions = { locale: 'hinglish', displayTz: 'Asia/Kolkata' };

/** The message as Telegram receives it (HTML), and as a reader sees it (`text`: no tags). */
const html = (data = newSignal(), options = IST): string => renderSignalNew(data, options).text;
const text = (data = newSignal(), options = IST): string => plain(html(data, options));
const withDoc = (change: Partial<ExplanationDoc>) =>
  newSignal(BUY_SIGNAL, { ...EXPLANATION, ...change });

const SIDE = `${ICON.buy} <b>BUY XAUUSD</b>  #S-0042`;
const GROUPS_EN = [
  `${ICON.strong} <b>Trend STRONG</b>: 1h EMA 20&gt;50&gt;200; 1h EMA 50 slope (3 h) +0.50 ATR(1h); ADX(1h) 31 (+DI 30 / -DI 10); Supertrend 1h up`,
  `${ICON.strong} <b>Structure STRONG</b>: Structure 15m / 5m up / up; Latest 5m break with the trade; Trendline and zone confluence 2 agree; Pullback 4021.300 → 4012.800, EMA and Fibonacci zone; 5m swing level 4014.200, closed beyond it`,
  `${ICON.strong} <b>Trigger and momentum STRONG</b>: Trigger candle range 1.4 x ATR, closed at 85% of its range; RSI(5m) 38 → 54; MACD histogram rising 3 candles; Displacement candle yes`,
  `${ICON.strong} <b>Volatility STRONG</b>: ATR(5m) 4.3; ATR percentile 62nd; Squeeze none`,
  `${ICON.strong} <b>Execution STRONG</b>: Spread 0.12; Spread percentile 35th; Stop distance 1.5 x ATR`,
  `${ICON.strong} <b>Session and macro STRONG</b>: Session London; High-impact USD event in 4 h 25 min`,
  `${ICON.strong} <b>Reward feasibility STRONG</b>: TP1 distance 1.5 x ATR; Room to the next level 2.3 x the distance to TP1`,
];
const GROUPS_HI = [
  GROUPS_EN[0],
  GROUPS_EN[1],
  `${ICON.strong} <b>Trigger aur momentum STRONG</b>: Trigger candle range 1.4 x ATR, closed at 85% of its range; RSI(5m) 38 → 54; MACD histogram rising 3 candles; Displacement candle yes`,
  GROUPS_EN[3],
  GROUPS_EN[4],
  `${ICON.strong} <b>Session aur macro STRONG</b>: Session London; High-impact USD event in 4 h 25 min`,
  `${ICON.strong} <b>Reward (target kitna door hai) STRONG</b>: TP1 distance 1.5 x ATR; Room to the next level 2.3 x the distance to TP1`,
];

describe('the entry alert of the example, golden', () => {
  it('in English', () => {
    expect(html()).toBe(
      [
        '<b>FORWARD-TEST (paper)</b> | Manual execution only.',
        SIDE,
        '<i>Trend Pullback v0.1.0</i>',
        `${ICON.style} <b>INTRADAY</b>: a trade of a few hours. Plan to stay up to 2 h (until 13:35 IST); it is closed then if it has not worked.`,
        `${ICON.quality} <b>Setup quality 95/100 (Very strong)</b>`,
        '',
        `${ICON.entry} <b>Entry</b>  <code>4017.370</code>  (do not chase above 4018.015)`,
        `${ICON.stop} <b>Stop</b>  <code>4010.900</code>  (-6.470)`,
        `${ICON.tp1} <b>TP1</b>  <code>4023.840</code>  (+6.470, 1.00R)  close 50%, move stop to entry`,
        `${ICON.tp2} <b>TP2</b>  <code>4030.310</code>  (+12.940, 2.00R)  runner`,
        `${ICON.time} Valid for 3 min (until 11:38 IST).`,
        '',
        `${ICON.warning} <b>Warnings</b>:`,
        '- FORWARD-TEST: this strategy is not validated yet (paper signal)',
        '',
        `${ICON.evidence} Track record of this setup: 58% wins (n=64), +0.31R per trade.`,
        '<i>This is a historical frequency, not a guarantee. 1R = 6.470 USD per 0.01 lot (1 oz).</i>',
        '',
        `<blockquote expandable><b>DETAILS (tap to open)</b>`,
        `${ICON.warning} <b>Warnings</b>:`,
        '- FORWARD-TEST: this strategy is not validated yet (paper signal)',
        `${ICON.macro} <b>Macro</b>: clear. Next high-impact event: CPI m/m at 16:00 IST (in 4 h 25 min).`,
        `${ICON.news} <b>News (last 60 min)</b>: no headline`,
        `${ICON.open} <b>Open signals now</b>: none (open risk 0.00R)`,
        '',
        `${ICON.evidence} <b>EVIDENCE (same setup type)</b>`,
        'Win rate 58%  (n=64, 95% CI 46-69%)  Expectancy +0.31R  PF 1.50',
        'TP1 reached 70%, TP2 reached 40%.',
        'Source: forward paper trades. Match: strategy, side and session. Low sample.',
        '',
        '<b>WHY THIS SIGNAL</b>',
        ...GROUPS_EN,
        `${ICON.weak} <b>Weak</b>: none`,
        `${ICON.research} <b>Research only (not used)</b>: DXY 15m -0.2%; Silver 15m +0.3%</blockquote>`,
      ].join('\n'),
    );
  });

  it('in Hinglish: the same numbers, other labels', () => {
    expect(html(newSignal(), HINGLISH)).toBe(
      [
        '<b>FORWARD-TEST (paper)</b> | Order aapko khud haath se lagana hai.',
        SIDE,
        '<i>Trend Pullback v0.1.0</i>',
        `${ICON.style} <b>INTRADAY</b>: kuch ghante ka trade. Zyada se zyada 2 h rukna hai (13:35 IST tak); tab tak na chale to band ho jata hai.`,
        `${ICON.quality} <b>Setup quality 95/100 (Bahut strong)</b>`,
        '',
        `${ICON.entry} <b>Entry</b>  <code>4017.370</code>  (4018.015 se upar entry mat lo)`,
        `${ICON.stop} <b>Stop</b>  <code>4010.900</code>  (-6.470)`,
        `${ICON.tp1} <b>TP1</b>  <code>4023.840</code>  (+6.470, 1.00R)  50% band karo, stop entry par le aao`,
        `${ICON.tp2} <b>TP2</b>  <code>4030.310</code>  (+12.940, 2.00R)  runner (bacha hua hissa)`,
        `${ICON.time} 3 min tak valid (11:38 IST tak).`,
        '',
        `${ICON.warning} <b>Chetavni</b>:`,
        '- FORWARD-TEST: this strategy is not validated yet (paper signal)',
        '',
        `${ICON.evidence} Is setup ka record: 58% jeet (n=64), +0.31R per trade.`,
        '<i>Ye pichhle records ki frequency hai, guarantee nahi. 1R = 6.470 USD per 0.01 lot (1 oz).</i>',
        '',
        `<blockquote expandable><b>DETAIL (kholne ke liye dabao)</b>`,
        `${ICON.warning} <b>Chetavni</b>:`,
        '- FORWARD-TEST: this strategy is not validated yet (paper signal)',
        `${ICON.macro} <b>Macro</b>: clear. Agla bada event: CPI m/m, 16:00 IST (4 h 25 min mein).`,
        `${ICON.news} <b>News (pichhle 60 min)</b>: koi headline nahi`,
        `${ICON.open} <b>Abhi khule signals</b>: koi nahi (khula risk 0.00R)`,
        '',
        `${ICON.evidence} <b>EVIDENCE (isi tarah ke setup ka record)</b>`,
        'Win rate 58%  (n=64, 95% CI 46-69%)  Expectancy +0.31R  PF 1.50',
        'TP1 tak 70% baar, TP2 tak 40% baar.',
        'Source: forward paper trades. Match: strategy, side and session. Sample kam hai.',
        '',
        '<b>YE SIGNAL KYUN AAYA</b>',
        ...GROUPS_HI,
        `${ICON.weak} <b>Kamzor</b>: koi nahi`,
        `${ICON.research} <b>Sirf research (signal mein use nahi hua)</b>: DXY 15m -0.2%; Silver 15m +0.3%</blockquote>`,
      ].join('\n'),
    );
  });

  it('is a full message: level 0, nothing left out', () => {
    const message = renderSignalNew(newSignal(), IST);
    expect(message).toMatchObject({ kind: 'SIGNAL_NEW', level: 0, dropped: [] });
  });

  it('is valid Telegram HTML, with the real tags and not the plain-text fallback', () => {
    for (const options of [IST, HINGLISH]) {
      for (const data of [newSignal(), newSignal(SELL_SIGNAL, SELL_EXPLANATION)]) {
        const message = html(data, options);
        expect(checkTelegramHtml(message)).toBeNull();
        expect(message).toContain('<b>');
        expect(message).toContain('<code>');
        expect(message).toContain('<blockquote expandable>');
        expect(message).not.toMatch(/[\uE000-\uE00F]/);
      }
    }
  });
});

describe('a SELL', () => {
  it('has its stop above, its targets below and its chase limit below the entry', () => {
    const message = text(newSignal(SELL_SIGNAL, SELL_EXPLANATION));
    expect(message).toContain(`${ICON.sell} SELL XAUUSD  #S-0043`);
    expect(message).toContain(`${ICON.entry} Entry  3982.630  (do not chase below 3981.985)`);
    expect(message).toContain(`${ICON.stop} Stop  4000.000  (+17.370)`);
    expect(message).toContain(
      `${ICON.tp1} TP1  3965.260  (+17.370, 1.00R)  close 50%, move stop to entry`,
    );
    expect(message).toContain(`${ICON.tp2} TP2  3947.890  (+34.740, 2.00R)  runner`);
    expect(message).toContain('1R = 17.370 USD per 0.01 lot (1 oz).');
  });

  it('says below in Hinglish too', () => {
    expect(text(newSignal(SELL_SIGNAL, SELL_EXPLANATION), HINGLISH)).toContain(
      `${ICON.entry} Entry  3982.630  (3981.985 se neeche entry mat lo)`,
    );
  });

  it('puts every price in its own span, outside bold, so that one tap copies it', () => {
    const message = html(newSignal(SELL_SIGNAL, SELL_EXPLANATION));
    for (const price of ['3982.630', '4000.000', '3965.260', '3947.890']) {
      expect(message).toContain(`<code>${price}</code>`);
    }
    expect(message).not.toMatch(/<b>[^<]*<code>/);
  });
});

describe('the label in the first line (rules C8 and C9)', () => {
  const first = (signal: SignalRef, options = IST) =>
    plain(renderSignalNew(newSignal(signal, EXPLANATION), options).text.split('\n')[0] ?? '');

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
    expect(message).toContain(`${ICON.tp1} TP1  4027.075  (+9.705, 1.50R)  close all`);
    expect(message).not.toContain(ICON.tp2);
    expect(message).not.toContain('runner');
  });

  it('words a structure target and shows a distance that is not a round R', () => {
    const message = messageOf('EP3_STRUCTURE', 4026, null);
    expect(message).toContain(
      `${ICON.tp1} TP1  4026.000  (+8.630, 1.33R)  close all (nearest opposing level)`,
    );
    expect(message).not.toContain(ICON.tp2);
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
    expect(message).toContain('Valid for 3 min (until 23:58 IST).');
    expect(message).toContain('Plan to stay up to 2 h (until 01:55 IST (24 Oct))');
  });

  it('shows the times in the display zone', () => {
    const message = text(newSignal(), { locale: 'en', displayTz: 'UTC' });
    expect(message).toContain('Valid for 3 min (until 06:08 UTC).');
    expect(message).toContain('Plan to stay up to 2 h (until 08:05 UTC)');
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
    const lines = text(withDoc({ groups })).split('\n');
    const why = lines.indexOf(WORDS.en.whyHeader);
    return lines.slice(why + 1).filter((line) => /^[🟢🟡🔴⚪] /u.test(line));
  };

  it('colours every state: green for strong and OK, yellow for weak, red for failed, white for no data', () => {
    const lines = marks([
      { state: 'OK' },
      { state: 'WEAK' },
      { state: 'FAIL' },
      { state: 'NA', facts: [] },
    ]);
    expect(lines.map((line) => line.split(' ')[0])).toEqual([
      STATE_ICON.OK,
      STATE_ICON.WEAK,
      STATE_ICON.FAIL,
      STATE_ICON.NA,
      STATE_ICON.STRONG,
      STATE_ICON.STRONG,
      STATE_ICON.STRONG,
      ICON.weak, // the weak line itself
    ]);
    expect(lines[0]).toContain('Trend OK: ');
    expect(lines[3]).toBe(`${STATE_ICON.NA} Volatility NA: no data`);
  });

  it('shows a group with no facts as its state only', () => {
    const lines = marks([{ state: 'FAIL', facts: [] }]);
    expect(lines[0]).toBe(`${STATE_ICON.FAIL} Trend FAIL`);
  });

  it('lists the weak points and says none when there are none', () => {
    const message = text(
      withDoc({ weak: ['the 1h Supertrend is against the trade', 'a squeeze is still on'] }),
    );
    expect(message).toContain(
      `${ICON.weak} Weak: the 1h Supertrend is against the trade; a squeeze is still on`,
    );
    expect(text()).toContain(`${ICON.weak} Weak: none`);
  });

  it('leaves out the research-only line when there is none', () => {
    expect(text(withDoc({ researchOnly: [] }))).not.toContain('Research only');
  });

  it('folds everything that explains the signal into one block at the end, and nothing else', () => {
    const message = html();
    const start = message.indexOf('<blockquote expandable>');
    expect(start).toBeGreaterThan(0);
    expect(message.endsWith('</blockquote>')).toBe(true);
    const plainPart = message.slice(0, start);
    const folded = message.slice(start);
    expect(plainPart).not.toContain('STRONG');
    expect(plainPart).toContain('Entry');
    expect(plainPart).toContain('TP1');
    expect(plainPart).toContain('INTRADAY');
    for (const heavy of ['Macro', 'News (', 'Open signals now', 'EVIDENCE', 'Win rate', 'Weak']) {
      expect(plainPart, heavy).not.toContain(heavy);
      expect(folded, heavy).toContain(heavy);
    }
    expect(folded).toContain('Trend STRONG');
  });

  it('says in one plain line how much is known of this setup, and the full figures are folded', () => {
    const start = html().indexOf('<blockquote expandable>');
    expect(html().slice(0, start)).toContain(
      'Track record of this setup: 58% wins (n=64), +0.31R per trade.',
    );
    const none = html(withDoc({ evidence: EVIDENCE_INSUFFICIENT }));
    expect(none.slice(0, none.indexOf('<blockquote expandable>'))).toMatch(
      /Track record of this setup: not enough trades yet \(n=\d+\)\./,
    );
  });

  it('names the style from the time stop: a scalp, an intraday trade or a swing', () => {
    const styled = (minutes: number) =>
      text(
        newSignal(
          { ...BUY_SIGNAL, timeStopAt: BUY_SIGNAL.generatedAt + minutes * 60_000 },
          EXPLANATION,
        ),
      );
    expect(styled(30)).toContain(`${ICON.style} SCALP: a quick trade. Plan to stay up to 30 min`);
    expect(styled(120)).toContain(`${ICON.style} INTRADAY: a trade of a few hours.`);
    expect(styled(600)).toContain(`${ICON.style} SWING: a long trade, over the day.`);
    expect(
      text(
        newSignal({ ...BUY_SIGNAL, timeStopAt: BUY_SIGNAL.generatedAt + 30 * 60_000 }, EXPLANATION),
        HINGLISH,
      ),
    ).toContain(`${ICON.style} SCALP: jaldi ka trade. Zyada se zyada 30 min rukna hai`);
  });

  it('shows the warnings in plain view only when there are some', () => {
    const plainPartOf = (doc: ReturnType<typeof withDoc>): string => {
      const message = html(doc);
      return message.slice(0, message.indexOf('<blockquote expandable>'));
    };
    const warnings: ExplanationDoc['warnings'] = [
      { code: 'NEWS_WINDOW', text: 'News window: CPI m/m in 22 min' },
    ];
    expect(plainPartOf(withDoc({ warnings }))).toContain('News window: CPI m/m in 22 min');
    expect(plainPartOf(withDoc({ warnings: [] }))).not.toContain('Warnings');
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
      `${ICON.warning} Warnings:\n- News window: CPI m/m in 22 min\n- Opposes open signal #S-0041\n`,
    );
    expect(text(withDoc({ warnings: [] }))).toContain(`${ICON.warning} Warnings: none`);
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
    const message = html(
      withDoc({
        news: {
          feed: 'AVAILABLE',
          headlines: [headline({ title: 'Gold <b>spikes</b> & "falls" > 1%' })],
        },
      }),
    );
    expect(message).toContain('- [HIGH] Gold &lt;b&gt;spikes&lt;/b&gt; &amp; "falls" &gt; 1% (BBC');
    expect(message).not.toContain('<b>spikes');
    expect(checkTelegramHtml(message)).toBeNull();
  });

  it('removes the marker characters of the markup from what comes from outside', () => {
    const forged = '\uE001forged\uE002 \uE009hidden\uE00A';
    const message = html(
      withDoc({
        news: {
          feed: 'AVAILABLE',
          headlines: [headline({ title: forged, sources: [`Wire${forged}`] })],
        },
        macro: { state: 'CLEAR', next: { name: `CPI${forged}`, at: '2026-10-23T10:30:00.000Z' } },
      }),
    );
    expect(message).toContain('- [HIGH] forged hidden (Wireforged hidden');
    expect(message).toContain('CPIforged hidden at');
    expect(message).not.toMatch(/[\uE000-\uE00F]/);
    expect(message.match(/<blockquote expandable>/g)).toHaveLength(1);
    expect(checkTelegramHtml(message)).toBeNull();
    // the same text sent through the renderer by itself would have made tags
    expect(renderHtml(forged)).toBe('<b>forged</b> <blockquote expandable>hidden</blockquote>');
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

  it('always says that this is not a guarantee, with the size of 1R, in italics', () => {
    for (const options of [IST, HINGLISH]) {
      const line = html(newSignal(), options)
        .split('\n')
        .find((candidate) => candidate.includes('1R = '));
      expect(line).toMatch(/^<i>.*guarantee.*<\/i>$/);
      expect(line).toContain('1R = 6.470 USD per 0.01 lot (1 oz).');
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
      '(+6.470, 1.00R)',
      w.tp1Note.EP1_PARTIAL, // the partial-exit instruction
      '4030.310', // TP2
      '(+12.940, 2.00R)',
      '11:38 IST', // validity
      '13:35 IST', // time stop
      w.style.INTRADAY, // style of the trade
      w.styleHint.INTRADAY,
      'Setup quality 95/100', // quality
      w.grade['Very strong'],
      w.detailsHeader,
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
  /** What a reader sees of the lines of one level. */
  const viewOf = (data: ReturnType<typeof newSignal>, level: number): string =>
    plain(renderHtml(signalNewLines(data, IST, level).lines.join('\n')));

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
        (_unused, level) => renderHtml(signalNewLines(data, IST, level).lines.join('\n')).length,
      );
      const firstFit = lengths.findIndex((length) => length <= TELEGRAM_SOFT_LIMIT);
      expect(chosen.level, JSON.stringify([facts, research, title, value, lengths])).toBe(
        firstFit === -1 ? SIGNAL_NEW_LEVELS - 1 : firstFit,
      );
      expect(chosen.text).toBe(
        renderHtml(signalNewLines(data, IST, chosen.level).lines.join('\n')),
      );
    }
    expect([...levels].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('never trims the levels, the stop, the targets, the quality, the warnings or the evidence', () => {
    for (const [facts, research, title, value] of sweep) {
      const data = newSignal(BUY_SIGNAL, bigExplanation(facts, research, title, value));
      for (let level = 0; level < SIGNAL_NEW_LEVELS; level += 1) {
        const message = viewOf(data, level);
        for (const part of [
          'FORWARD-TEST (paper)',
          `${ICON.entry} Entry  4017.370  (do not chase above 4018.015)`,
          `${ICON.stop} Stop  4010.900  (-6.470)`,
          'TP1  4023.840',
          'TP2  4030.310',
          'Valid for 3 min',
          'Setup quality 95/100 (Very strong)',
          `${ICON.warning} Warnings:`,
          'Open signals now: none',
          'EVIDENCE (same setup type)',
          'Win rate 58%  (n=64, 95% CI 46-69%)',
          'This is a historical frequency, not a guarantee. 1R = 6.470 USD per 0.01 lot (1 oz).',
        ]) {
          expect(message, `level ${String(level)}: ${part}`).toContain(part);
        }
        // every group keeps its line with its state
        expect(message.match(new RegExp(`^${ICON.strong} .* STRONG`, 'gm'))).toHaveLength(7);
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

    expect(viewOf(data, 0)).toContain('Research only');
    expect(viewOf(data, 1)).not.toContain('Research only');
    expect(viewOf(data, 1)).toContain('- [HIGH] ');
    expect(viewOf(data, 2)).toContain(
      'News (last 60 min): 3 headlines in the last 60 min, see the dashboard',
    );
    expect(viewOf(data, 2)).not.toContain('- [HIGH] ');
    expect(viewOf(data, 2)).toContain('Fact 0-2');
    expect(viewOf(data, 2)).not.toContain('Fact 0-3');
    expect(viewOf(data, 3)).toContain('Fact 0-0');
    expect(viewOf(data, 3)).not.toContain('Fact 0-1');
    expect(viewOf(data, 4)).not.toContain('Fact 0-0');
    expect(viewOf(data, 4)).toContain(`${ICON.strong} Trend STRONG\n`);
  });

  it('keeps fewer weak points at the lower levels', () => {
    const many = {
      ...bigExplanation(4, 2, 40),
      weak: ['one', 'two', 'three', 'four', 'five'],
    };
    const weak = (level: number) =>
      viewOf(newSignal(BUY_SIGNAL, many), level)
        .split('\n')
        .find((line) => line.startsWith(`${ICON.weak} Weak`));
    expect(weak(0)).toBe(`${ICON.weak} Weak: one; two; three; four; five`);
    expect(weak(2)).toBe(`${ICON.weak} Weak: one; two; three; four; five`);
    expect(weak(3)).toBe(`${ICON.weak} Weak: one; two; three`);
    expect(weak(4)).toBe(`${ICON.weak} Weak: one`);
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

  it('counts the length of the text that is sent (escaped, with its tags), not of the lines', () => {
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
      if (raw.length > TELEGRAM_SOFT_LIMIT || renderHtml(raw).length <= TELEGRAM_SOFT_LIMIT)
        continue;
      // the lines fit and the text that is sent does not: the text that is sent is what counts
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
    expect(html(newSignal(BUY_SIGNAL, doc))).toContain(
      `${ICON.weak} <b>Weak</b>: spread &gt; 2 &amp; rising`,
    );
  });

  it('is valid Telegram HTML at every level of detail', () => {
    for (const [facts, research, title, value] of sweep) {
      const data = newSignal(BUY_SIGNAL, bigExplanation(facts, research, title, value));
      for (let level = 0; level < SIGNAL_NEW_LEVELS; level += 1) {
        const rendered = renderHtml(signalNewLines(data, IST, level).lines.join('\n'));
        expect(checkTelegramHtml(rendered), `level ${String(level)}`).toBeNull();
        expect(rendered).toContain('<blockquote expandable>');
      }
    }
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
      `${ICON.warning} Warnings:\n- Rollover hours: liquidity is thin and spreads can be wide\n- FORWARD-TEST: this strategy is not validated yet (paper signal)\n`,
    );
  });
});
