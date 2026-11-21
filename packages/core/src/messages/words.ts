import type {
  CauseCategory,
  CauseCode,
  ExitProfile,
  Grade,
  Locale,
  NewsState,
  QualityGroup,
  Side,
  StatsScope,
} from '../domain';
import type { ExitReason } from '../trade/types';
import type { TradeStyle } from '../trade/style';

// The fixed words of the messages, in English and in Hinglish (Hindi in Latin letters). Only labels
// and sentences are translated: numbers, levels, ids, trading terms and the facts of an explanation
// are the same in both (04_API_and_Notifications section 4, "Locale"). Both dictionaries have the
// same type, so a phrase missing in one of them does not compile.

export interface Words {
  /** The first line of every message about a paper strategy. It is the same in both languages. */
  readonly paperLabel: string;
  readonly simulatedLabel: string;
  readonly validatedLabel: string;
  readonly simulatedNote: string;
  readonly manualOnly: string;
  readonly entry: string;
  readonly stop: string;
  readonly tp1: string;
  readonly tp2: string;
  readonly doNotChase: (side: Side, level: string) => string;
  readonly tp1Note: Readonly<Record<ExitProfile, string>>;
  readonly runner: string;
  readonly validFor: (span: string, until: string) => string;
  readonly style: Readonly<Record<TradeStyle, string>>;
  /** What the style means for the owner: how long the trade may take, in one line. */
  readonly styleLine: (hint: string, span: string, at: string) => string;
  readonly styleHint: Readonly<Record<TradeStyle, string>>;
  readonly detailsHeader: string;
  readonly trackShort: (rate: string, n: number, expectancy: string | null) => string;
  readonly trackNone: (n: number) => string;
  readonly quality: (score: string, grade: string) => string;
  readonly grade: Readonly<Record<Grade, string>>;
  readonly whyHeader: string;
  readonly groupName: Readonly<Record<QualityGroup, string>>;
  readonly noData: string;
  readonly weak: string;
  readonly researchOnly: string;
  readonly warnings: string;
  readonly none: string;
  readonly macro: string;
  readonly macroState: Readonly<Record<NewsState, string>>;
  readonly nextEvent: (name: string, at: string, span: string) => string;
  readonly noNextEvent: string;
  readonly newsTitle: string;
  readonly newsNone: string;
  readonly newsUnavailable: string;
  readonly newsCount: (count: number) => string;
  readonly newsContext: string;
  readonly openSignals: string;
  readonly openRisk: (risk: string) => string;
  readonly evidenceTitle: string;
  readonly winRate: (rate: string, n: number, interval: string) => string;
  readonly expectancy: string;
  readonly profitFactor: string;
  readonly tp1Reached: (rate: string) => string;
  readonly tp2Reached: (rate: string) => string;
  readonly insufficient: (n: number, wins: number, minimum: number) => string;
  readonly source: (scope: string, match: string) => string;
  readonly scope: Readonly<Record<StatsScope, string>>;
  readonly lowSample: string;
  readonly disclaimer: string;
  readonly oneR: (usd: string) => string;
  // Results.
  readonly tp1HitTitle: (label: string, gain: string, share: string) => string;
  readonly priceAt: (price: string, at: string, since: string) => string;
  readonly tp1Action: (entry: string) => string;
  readonly runnerLine: (tp2: string, timeStopAt: string) => string;
  readonly net: string;
  readonly exitName: Readonly<Record<ExitReason, (price: string) => string>>;
  readonly closedDetail: (exit: string, at: string, span: string) => string;
  readonly afterTp1: (exit: string) => string;
  readonly stoppedDetail: (exit: string, at: string, span: string) => string;
  readonly timeExitDetail: (span: string, price: string) => string;
  readonly mfeMae: (favourable: string, adverse: string) => string;
  readonly worked: string;
  readonly partialPaid: (gain: string) => string;
  readonly partialNotWin: string;
  readonly timeExitNone: string;
  readonly timeExitAfterTp1: string;
  readonly cause: string;
  readonly reviewTitle: (status: 'PRELIMINARY' | 'FINAL') => string;
  readonly primary: string;
  readonly also: string;
  readonly weakAtEntry: string;
  readonly meaning: string;
  readonly finalComing: string;
  readonly heuristic: string;
  readonly categoryName: Readonly<Record<CauseCategory, string>>;
  readonly causeRule: Readonly<Record<CauseCode, string>>;
  readonly cancelledTitle: (label: string) => string;
  readonly cancelledReason: (seconds: number | null, validMinutes: string) => string;
  readonly manageManually: string;
  readonly dataInvalidTitle: (label: string) => string;
  readonly dataInvalidBody: string;
  readonly finalTitle: (label: string) => string;
  readonly causeUpdated: (code: string, category: string, was: string) => string;
  readonly causeConfirmed: (code: string, category: string) => string;
  readonly reachedTp1: (tp1: string, candles: number) => string;
  readonly notReachedTp1: string;
  readonly tracked: (count: number) => string;
}

const en: Words = {
  paperLabel: 'FORWARD-TEST (paper)',
  simulatedLabel: 'SIMULATED',
  validatedLabel: 'VALIDATED strategy',
  simulatedNote: 'replay data, not the live market',
  manualOnly: 'Manual execution only.',
  entry: 'Entry',
  stop: 'Stop',
  tp1: 'TP1',
  tp2: 'TP2',
  doNotChase: (side, level) => `do not chase ${side === 'BUY' ? 'above' : 'below'} ${level}`,
  tp1Note: {
    EP1_PARTIAL: 'close 50%, move stop to entry',
    EP2_SINGLE: 'close all',
    EP3_STRUCTURE: 'close all (nearest opposing level)',
  },
  runner: 'runner',
  validFor: (span, until) => `Valid for ${span} (until ${until}).`,
  style: { SCALP: 'SCALP', INTRADAY: 'INTRADAY', SWING: 'SWING' },
  styleHint: {
    SCALP: 'a quick trade',
    INTRADAY: 'a trade of a few hours',
    SWING: 'a long trade, over the day',
  },
  styleLine: (hint, span, at) =>
    `${hint}. Plan to stay up to ${span} (until ${at}); it is closed then if it has not worked.`,
  detailsHeader: 'DETAILS (tap to open)',
  trackShort: (rate, n, expectancy) =>
    `Track record of this setup: ${rate} wins (n=${String(n)})${expectancy === null ? '' : `, ${expectancy} per trade`}.`,
  trackNone: (n) => `Track record of this setup: not enough trades yet (n=${String(n)}).`,
  quality: (score, grade) => `Setup quality ${score}/100 (${grade})`,
  grade: { Moderate: 'Moderate', Strong: 'Strong', 'Very strong': 'Very strong' },
  whyHeader: 'WHY THIS SIGNAL',
  groupName: {
    trend: 'Trend',
    structure: 'Structure',
    trigger: 'Trigger and momentum',
    volatility: 'Volatility',
    execution: 'Execution',
    sessionMacro: 'Session and macro',
    reward: 'Reward feasibility',
  },
  noData: 'no data',
  weak: 'Weak',
  researchOnly: 'Research only (not used)',
  warnings: 'Warnings',
  none: 'none',
  macro: 'Macro',
  macroState: {
    CLEAR: 'clear',
    IN_WINDOW: 'inside a news window',
    UNKNOWN: 'calendar unavailable',
  },
  nextEvent: (name, at, span) => `Next high-impact event: ${name} at ${at} (in ${span}).`,
  noNextEvent: 'No high-impact event is known ahead.',
  newsTitle: 'News (last 60 min)',
  newsNone: 'no headline',
  newsUnavailable: 'headline feed unavailable (this is not the same as no news)',
  newsCount: (count) =>
    `${String(count)} headline${count === 1 ? '' : 's'} in the last 60 min, see the dashboard`,
  newsContext: 'Context only, not a reason for the trade.',
  openSignals: 'Open signals now',
  openRisk: (risk) => `open risk ${risk}`,
  evidenceTitle: 'EVIDENCE (same setup type)',
  winRate: (rate, n, interval) => `Win rate ${rate}  (n=${String(n)}, 95% CI ${interval})`,
  expectancy: 'Expectancy',
  profitFactor: 'PF',
  tp1Reached: (rate) => `TP1 reached ${rate}`,
  tp2Reached: (rate) => `TP2 reached ${rate}`,
  insufficient: (n, wins, minimum) =>
    `Insufficient evidence: ${String(n)} resolved trades of this setup type so far (${String(wins)} wins). A win rate is shown from ${String(minimum)} trades.`,
  source: (scope, match) => `Source: ${scope}. Match: ${match}.`,
  scope: { FORWARD: 'forward paper trades', BACKTEST_OOS: 'out-of-sample backtest' },
  lowSample: 'Low sample.',
  disclaimer: 'This is a historical frequency, not a guarantee.',
  oneR: (usd) => `1R = ${usd} USD per 0.01 lot (1 oz).`,
  tp1HitTitle: (label, gain, share) => `TP1 HIT ${label}  ${gain} on ${share}`,
  priceAt: (price, at, since) => `Price ${price} at ${at} (${since} after entry).`,
  tp1Action: (entry) => `ACTION: close half, move stop to entry ${entry}.`,
  runnerLine: (tp2, timeStopAt) => `Runner target TP2 ${tp2}. Time stop ${timeStopAt}.`,
  net: 'net',
  exitName: {
    STOP: (price) => `stop ${price}`,
    STOP_AT_ENTRY: (price) => `stopped at entry ${price}`,
    TARGET: (price) => `target ${price}`,
    TP2: (price) => `TP2 ${price}`,
    TIME_STOP: (price) => `time stop, price ${price}`,
    DATA_GAP: () => 'feed gap',
    STALE_BEFORE_ENTRY: () => 'data stale before entry',
  },
  closedDetail: (exit, at, span) => `${exit} at ${at}, ${span}`,
  afterTp1: (exit) => `TP1 hit, then ${exit}`,
  stoppedDetail: (exit, at, span) => `${exit} hit ${at}, ${span} after entry`,
  timeExitDetail: (span, price) => `${span}, price ${price}`,
  mfeMae: (favourable, adverse) => `Max favourable ${favourable}, max adverse ${adverse}.`,
  worked: 'What worked',
  partialPaid: (gain) => `The trade is still a win because TP1 paid ${gain}.`,
  partialNotWin: 'After costs the net R is not above zero, so it does not count as a win.',
  timeExitNone: 'No stop or target was reached.',
  timeExitAfterTp1: 'TP1 was reached earlier; the rest was closed at the time stop.',
  cause: 'Cause',
  reviewTitle: (status) =>
    `WHY IT FAILED (automatic review, ${status === 'FINAL' ? 'final' : 'preliminary'})`,
  primary: 'Primary',
  also: 'Also',
  weakAtEntry: 'Weak at entry',
  meaning: 'Meaning',
  finalComing: 'Final review in 60 min (checks whether price reached TP1 later).',
  heuristic: 'Attribution is heuristic. Judge the strategy by the statistics in Analytics.',
  categoryName: {
    SETUP_FAILURE: 'Setup failure',
    MARKET_EVENT: 'Market event',
    EXECUTION: 'Execution',
    DATA: 'Data',
  },
  causeRule: {
    NO_FOLLOW_THROUGH: 'Price never moved 0.3R in favour before the close.',
    STOP_HUNT_REVERSAL: 'After the stop-out, price reached the TP1 level within 12 candles of 5m.',
    NEWS_SHOCK:
      'A high-impact event or headline appeared during the trade, or volatility jumped, with a large move against the position.',
    HTF_STRUCTURE_BREAK: 'The 15m or 1h structure broke against the position before the stop.',
    REGIME_SHIFT: 'The market regime at the close differed from the one at entry.',
    LIQUIDITY_DROP: 'The loss came in the last 30 minutes of a session or during rollover.',
    SPREAD_COST: 'Spread and slippage cost at least 25% of the risk distance.',
    TIME_DECAY: 'The trade ran to the time stop without a profit.',
    NORMAL_LOSS:
      'None of the other causes applies: the loss is within the expected loss frequency.',
  },
  cancelledTitle: (label) => `CANCELLED ${label} (not counted in win rate)`,
  cancelledReason: (seconds, validMinutes) =>
    seconds === null
      ? `Reason: market data went stale during the ${validMinutes} entry window.`
      : `Reason: market data went stale for ${String(seconds)} s during the ${validMinutes} entry window.`,
  manageManually: 'If you already entered, manage the trade manually.',
  dataInvalidTitle: (label) => `DATA INVALID ${label} (not counted in win rate)`,
  dataInvalidBody:
    'The feed had a gap of more than 60 s during the trade, so the result cannot be trusted. If you are still in the trade, manage it manually.',
  finalTitle: (label) => `FINAL REVIEW ${label}`,
  causeUpdated: (code, category, was) => `Cause updated: ${code} (${category}), was ${was}.`,
  causeConfirmed: (code, category) => `Cause confirmed: ${code} (${category}).`,
  reachedTp1: (tp1, candles) =>
    `Price reached TP1 ${tp1} ${String(candles)} 5m candle${candles === 1 ? '' : 's'} after the stop.`,
  notReachedTp1: 'Price did not reach TP1 afterwards.',
  tracked: (count) => `Tracked in Analytics (n=${String(count)} this month).`,
};

const hinglish: Words = {
  paperLabel: 'FORWARD-TEST (paper)',
  simulatedLabel: 'SIMULATED',
  validatedLabel: 'VALIDATED strategy',
  simulatedNote: 'ye replay data hai, live market nahi',
  manualOnly: 'Order aapko khud haath se lagana hai.',
  entry: 'Entry',
  stop: 'Stop',
  tp1: 'TP1',
  tp2: 'TP2',
  doNotChase: (side, level) => `${level} se ${side === 'BUY' ? 'upar' : 'neeche'} entry mat lo`,
  tp1Note: {
    EP1_PARTIAL: '50% band karo, stop entry par le aao',
    EP2_SINGLE: 'poora band karo',
    EP3_STRUCTURE: 'poora band karo (agla opposing level)',
  },
  runner: 'runner (bacha hua hissa)',
  validFor: (span, until) => `${span} tak valid (${until} tak).`,
  style: { SCALP: 'SCALP', INTRADAY: 'INTRADAY', SWING: 'SWING' },
  styleHint: {
    SCALP: 'jaldi ka trade',
    INTRADAY: 'kuch ghante ka trade',
    SWING: 'lamba trade, poore din se zyada',
  },
  styleLine: (hint, span, at) =>
    `${hint}. Zyada se zyada ${span} rukna hai (${at} tak); tab tak na chale to band ho jata hai.`,
  detailsHeader: 'DETAIL (kholne ke liye dabao)',
  trackShort: (rate, n, expectancy) =>
    `Is setup ka record: ${rate} jeet (n=${String(n)})${expectancy === null ? '' : `, ${expectancy} per trade`}.`,
  trackNone: (n) => `Is setup ka record: abhi kaafi trades nahi (n=${String(n)}).`,
  quality: (score, grade) => `Setup quality ${score}/100 (${grade})`,
  grade: { Moderate: 'Moderate', Strong: 'Strong', 'Very strong': 'Bahut strong' },
  whyHeader: 'YE SIGNAL KYUN AAYA',
  groupName: {
    trend: 'Trend',
    structure: 'Structure',
    trigger: 'Trigger aur momentum',
    volatility: 'Volatility',
    execution: 'Execution',
    sessionMacro: 'Session aur macro',
    reward: 'Reward (target kitna door hai)',
  },
  noData: 'data nahi mila',
  weak: 'Kamzor',
  researchOnly: 'Sirf research (signal mein use nahi hua)',
  warnings: 'Chetavni',
  none: 'koi nahi',
  macro: 'Macro',
  macroState: {
    CLEAR: 'clear',
    IN_WINDOW: 'news window ke andar',
    UNKNOWN: 'calendar available nahi',
  },
  nextEvent: (name, at, span) => `Agla bada event: ${name}, ${at} (${span} mein).`,
  noNextEvent: 'Aage koi bada event pata nahi.',
  newsTitle: 'News (pichhle 60 min)',
  newsNone: 'koi headline nahi',
  newsUnavailable: 'headline feed available nahi (iska matlab "koi news nahi" nahi hai)',
  newsCount: (count) => `pichhle 60 min mein ${String(count)} headline, dashboard dekho`,
  newsContext: 'Ye sirf context hai, trade ka reason nahi.',
  openSignals: 'Abhi khule signals',
  openRisk: (risk) => `khula risk ${risk}`,
  evidenceTitle: 'EVIDENCE (isi tarah ke setup ka record)',
  winRate: (rate, n, interval) => `Win rate ${rate}  (n=${String(n)}, 95% CI ${interval})`,
  expectancy: 'Expectancy',
  profitFactor: 'PF',
  tp1Reached: (rate) => `TP1 tak ${rate} baar`,
  tp2Reached: (rate) => `TP2 tak ${rate} baar`,
  insufficient: (n, wins, minimum) =>
    `Evidence abhi kaafi nahi hai: is setup ke ${String(n)} resolved trades hue (${String(wins)} win). Win rate ${String(minimum)} trades se dikhta hai.`,
  source: (scope, match) => `Source: ${scope}. Match: ${match}.`,
  scope: { FORWARD: 'forward paper trades', BACKTEST_OOS: 'out-of-sample backtest' },
  lowSample: 'Sample kam hai.',
  disclaimer: 'Ye pichhle records ki frequency hai, guarantee nahi.',
  oneR: (usd) => `1R = ${usd} USD per 0.01 lot (1 oz).`,
  tp1HitTitle: (label, gain, share) => `TP1 HIT ${label}  ${gain} (${share} par)`,
  priceAt: (price, at, since) => `Price ${price}, ${at} par (entry ke ${since} baad).`,
  tp1Action: (entry) => `KARO: aadha band karo, stop entry ${entry} par le aao.`,
  runnerLine: (tp2, timeStopAt) => `Runner ka target TP2 ${tp2}. Time stop ${timeStopAt}.`,
  net: 'net',
  exitName: {
    STOP: (price) => `stop ${price}`,
    STOP_AT_ENTRY: (price) => `entry par stop ${price}`,
    TARGET: (price) => `target ${price}`,
    TP2: (price) => `TP2 ${price}`,
    TIME_STOP: (price) => `time stop, price ${price}`,
    DATA_GAP: () => 'feed gap',
    STALE_BEFORE_ENTRY: () => 'entry se pehle data stale',
  },
  closedDetail: (exit, at, span) => `${exit}, ${at} par, ${span} mein`,
  afterTp1: (exit) => `TP1 lag chuka tha, phir ${exit}`,
  stoppedDetail: (exit, at, span) => `${exit} ${at} par laga, entry ke ${span} baad`,
  timeExitDetail: (span, price) => `${span}, price ${price}`,
  mfeMae: (favourable, adverse) => `Sabse achha move ${favourable}, sabse bura move ${adverse}.`,
  worked: 'Kya sahi gaya',
  partialPaid: (gain) => `Trade phir bhi win hai kyunki TP1 ne ${gain} diya.`,
  partialNotWin: 'Cost ke baad net R zero se upar nahi hai, isliye ye win nahi gina jaata.',
  timeExitNone: 'Na stop laga, na target mila.',
  timeExitAfterTp1: 'TP1 pehle mil chuka tha; bacha hissa time stop par band hua.',
  cause: 'Wajah',
  reviewTitle: (status) =>
    `KYUN FAIL HUA (automatic review, ${status === 'FINAL' ? 'final' : 'preliminary'})`,
  primary: 'Mukhya wajah',
  also: 'Saath mein',
  weakAtEntry: 'Entry par kamzor',
  meaning: 'Matlab',
  finalComing: 'Final review 60 min mein aayega (dekhega ki price baad mein TP1 tak gaya ya nahi).',
  heuristic: 'Ye wajah sirf anuman hai. Strategy ko Analytics ke statistics se parkho.',
  categoryName: {
    SETUP_FAILURE: 'Setup ki kami',
    MARKET_EVENT: 'Market event',
    EXECUTION: 'Execution',
    DATA: 'Data',
  },
  causeRule: {
    NO_FOLLOW_THROUGH: 'Close se pehle price kabhi 0.3R bhi trade ke favour mein nahi gayi.',
    STOP_HUNT_REVERSAL:
      'Stop lagne ke baad price 5m ke 12 candles ke andar TP1 level tak pahunch gayi.',
    NEWS_SHOCK:
      'Trade ke dauraan bada event ya headline aaya, ya volatility kood gayi, aur position ke khilaf bada move hua.',
    HTF_STRUCTURE_BREAK: 'Stop se pehle 15m ya 1h structure position ke khilaf toot gaya.',
    REGIME_SHIFT: 'Close par market regime entry ke regime se alag tha.',
    LIQUIDITY_DROP: 'Loss session ke aakhri 30 minute mein ya rollover ke dauraan hua.',
    SPREAD_COST: 'Spread aur slippage ka cost risk distance ka kam se kam 25% tha.',
    TIME_DECAY: 'Trade bina profit ke time stop tak chala.',
    NORMAL_LOSS: 'Baaki koi wajah nahi mili: ye loss expected loss frequency ke andar hai.',
  },
  cancelledTitle: (label) => `CANCELLED ${label} (win rate mein nahi ginta)`,
  cancelledReason: (seconds, validMinutes) =>
    seconds === null
      ? `Wajah: ${validMinutes} ke entry window mein market data stale ho gaya.`
      : `Wajah: ${validMinutes} ke entry window mein market data ${String(seconds)} s tak stale raha.`,
  manageManually: 'Agar aap entry le chuke ho to trade khud sambhalo.',
  dataInvalidTitle: (label) => `DATA INVALID ${label} (win rate mein nahi ginta)`,
  dataInvalidBody:
    'Trade ke dauraan feed mein 60 s se zyada gap tha, isliye result par bharosa nahi kar sakte. Agar aap abhi trade mein ho to khud sambhalo.',
  finalTitle: (label) => `FINAL REVIEW ${label}`,
  causeUpdated: (code, category, was) => `Wajah badli: ${code} (${category}), pehle ${was} thi.`,
  causeConfirmed: (code, category) => `Wajah pakki hui: ${code} (${category}).`,
  reachedTp1: (tp1, candles) =>
    `Stop ke ${String(candles)} 5m candle baad price TP1 ${tp1} par pahunch gayi.`,
  notReachedTp1: 'Uske baad price TP1 tak nahi pahunchi.',
  tracked: (count) => `Analytics mein track ho raha hai (is mahine n=${String(count)}).`,
};

export const WORDS: Readonly<Record<Locale, Words>> = { en, hinglish };
