import type {
  FeedState,
  Locale,
  MacroImportance,
  NewsImpact,
  NewsTopic,
  StrategyStatus,
} from '../domain';

// The fixed words of the command replies and of the system messages, in English and in Hinglish
// (Hindi in Latin letters), like `messages/words.ts`: only labels and sentences are translated, the
// numbers, ids and trading terms are the same. Both dictionaries have one type, so a phrase that is
// missing in one of them does not compile.

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export type HelpCommand =
  'status' | 'open' | 'last' | 'today' | 'month' | 'pause' | 'resume' | 'help';

export interface AlertWords {
  // Help, start and link.
  readonly helpTitle: string;
  readonly helpLine: Readonly<Record<HelpCommand, string>>;
  readonly helpNote: string;
  readonly unknownCommand: (name: string) => string;
  readonly startText: string;
  readonly linked: string;
  readonly linkInvalid: string;
  // /status
  readonly statusTitle: (at: string) => string;
  readonly feedStateName: Readonly<Record<FeedState, string>>;
  readonly feedLine: (state: string, detail: string) => string;
  readonly noTickYet: string;
  readonly lastTick: (age: string) => string;
  readonly spreadOf: (spread: string) => string;
  readonly engineRunning: string;
  readonly enginePausedSince: (since: string) => string;
  readonly engineWarming: (percent: string) => string;
  readonly sessionRegime: (session: string, regime: string | null) => string;
  readonly nextHigh: (name: string, at: string, span: string) => string;
  readonly noNextHigh: string;
  readonly openSummary: (count: number, risk: string) => string;
  readonly strategiesTitle: string;
  readonly strategyStatusName: Readonly<Record<StrategyStatus, string>>;
  readonly strategyLine: (name: string, version: string, status: string, alerts: boolean) => string;
  readonly notAvailable: string;
  // /open
  readonly openTitle: (count: number, risk: string) => string;
  readonly noOpen: string;
  readonly waiting: (reasons: string) => string;
  readonly openActive: (
    tag: string,
    side: string,
    strategy: string,
    r: string,
    price: string,
    stop: string,
    tp1: string,
    timeStop: string,
  ) => string;
  readonly openAfterTp1: (
    tag: string,
    side: string,
    strategy: string,
    r: string,
    price: string,
    stop: string,
    target: string,
    timeStop: string,
  ) => string;
  readonly noPrice: string;
  readonly moreSignals: (count: number) => string;
  // /last
  readonly noClosedYet: string;
  // /today and /month
  readonly todayTitle: (date: string, zone: string) => string;
  readonly monthTitle: (month: string, year: string) => string;
  readonly noSignalsToday: string;
  readonly generated: (count: number) => string;
  readonly validResults: (count: number) => string;
  readonly resultCounts: (win: number, partial: number, loss: number, timeExit: number) => string;
  readonly apartCounts: (cancelled: number, invalid: number, open: number) => string;
  readonly netLine: (net: string) => string;
  readonly signalLine: (tag: string, side: string, strategy: string, state: string) => string;
  readonly stateOpen: string;
  readonly stateCancelled: string;
  readonly stateInvalid: string;
  readonly rateLine: (rate: string, wins: number, n: number, interval: string) => string;
  readonly rateHidden: (n: number, minimum: number) => string;
  readonly moneyLine: (net: string, expectancy: string, factor: string, drawdown: string) => string;
  readonly byStrategy: string;
  readonly strategyCount: (name: string, n: number, rate: string | null) => string;
  readonly nTooSmall: string;
  readonly topCauses: string;
  readonly noReviewed: string;
  // /pause and /resume
  readonly pauseUsage: string;
  readonly enginePausedTitle: (at: string) => string;
  readonly pausedBody: string;
  readonly pausedUntil: (until: string, span: string) => string;
  readonly resumeToContinue: string;
  readonly alreadyPaused: (since: string) => string;
  readonly engineResumed: (at: string) => string;
  readonly resumedBody: string;
  readonly notPaused: string;
  // System messages.
  readonly feedStaleTitle: (since: string) => string;
  readonly feedDisconnectedTitle: (since: string) => string;
  readonly silentFor: (span: string) => string;
  readonly newSignalsBlocked: string;
  readonly openTradeNotTracked: (tags: string) => string;
  readonly feedRecoveredTitle: (at: string, span: string) => string;
  readonly signalsResume: (at: string) => string;
  readonly signalsResumeSoon: string;
  readonly storageTitle: (percent: string, budget: string) => string;
  readonly storageRetention: (days: number) => string;
  readonly storageLargest: (table: string, size: string) => string;
  readonly testTitle: (at: string) => string;
  readonly testBody: string;
  // The calendar: an event is coming, an event was released.
  readonly importanceLabel: Readonly<Record<MacroImportance, string>>;
  readonly upcomingTitle: (
    impact: string,
    currency: string,
    minutes: string,
    name: string,
    at: string,
  ) => string;
  readonly forecastPrevious: (forecast: string, previous: string) => string;
  readonly windowNote: (from: string, until: string) => string;
  readonly releasedTitle: (name: string, at: string) => string;
  readonly releasedFigures: (
    actual: string,
    forecast: string,
    previous: string,
    revised: string | null,
    surprise: string | null,
  ) => string;
  readonly goldAfter: (seconds: number, move: string, spread: string | null) => string;
  readonly releasedWindowNote: string;
  readonly calendarUnavailable: string;
  // Headlines, market moves and the headline feeds.
  readonly topicName: Readonly<Record<NewsTopic, string>>;
  readonly impactName: Readonly<Record<NewsImpact, string>>;
  readonly headlineTitle: (impact: string, topics: string) => string;
  readonly headlineSeen: (
    sources: string,
    published: string | null,
    detected: string,
    delay: string | null,
  ) => string;
  readonly goldSince: (move: string, atr: string | null, spread: string | null) => string;
  readonly goldSinceNone: string;
  readonly topicHistory: (
    impact: string,
    topic: string,
    share: string,
    n: number,
    baseline: string | null,
  ) => string;
  readonly topicHistoryNone: string;
  readonly headlineLink: (url: string) => string;
  readonly headlineNote: string;
  readonly moveTitle: (
    direction: 'UP' | 'DOWN',
    move: string,
    span: string,
    multiple: string,
    basis: string,
    spread: string | null,
    at: string,
  ) => string;
  readonly causesTitle: string;
  readonly causeLine: (
    n: number,
    impact: string,
    title: string,
    sources: string,
    at: string,
  ) => string;
  readonly causeUnclassified: (n: number, title: string, sources: string, at: string) => string;
  readonly noCause: string;
  readonly causesUnavailable: string;
  readonly moveOpen: (list: string | null) => string;
  readonly headlineFeedsDownTitle: (since: string) => string;
  readonly headlineFeedsSilent: (span: string) => string;
  readonly headlineFeedsDownBody: string;
  readonly headlineFeedsBackTitle: (at: string, span: string) => string;
  readonly headlineFeedsBackBody: string;
  readonly sampleBanner: string;
  readonly sampleBannerLong: string;
}

const en: AlertWords = {
  helpTitle: 'COMMANDS',
  helpLine: {
    status: '/status: feed, engine, session, next event, strategies',
    open: '/open: open signals with live R',
    last: '/last: the last closed signal with its review',
    today: '/today: signals, results and net R of today',
    month: '/month: this month so far',
    pause: '/pause [minutes]: stop new signals (tracking continues)',
    resume: '/resume: send new signals again',
    help: '/help: this list',
  },
  helpNote: 'Signals are decision support. You place every order yourself.',
  unknownCommand: (name) => `Unknown command /${name}. Try /help.`,
  startText: 'VM Gold Signal. This chat gets the alerts. Try /help for the commands.',
  linked: 'Linked. This chat now gets the alerts, and only this chat is served. Try /help.',
  linkInvalid: 'That code is not valid (it may have expired). Make a new one on the server.',
  statusTitle: (at) => `STATUS ${at}`,
  feedStateName: {
    LIVE: 'LIVE',
    STALE: 'STALE',
    DISCONNECTED: 'DISCONNECTED',
    MARKET_CLOSED: 'MARKET CLOSED',
    WARMING_UP: 'WARMING UP',
  },
  feedLine: (state, detail) => `Feed: ${state}${detail === '' ? '' : `, ${detail}`}`,
  noTickYet: 'no tick yet',
  lastTick: (age) => `last tick ${age} ago`,
  spreadOf: (spread) => `spread ${spread}`,
  engineRunning: 'Engine: RUNNING',
  enginePausedSince: (since) => `Engine: PAUSED since ${since}`,
  engineWarming: (percent) => `Engine: WARMING UP (${percent}%)`,
  sessionRegime: (session, regime) => `Session: ${session}, regime: ${regime ?? 'not known yet'}`,
  nextHigh: (name, at, span) => `Next HIGH-impact event: ${name}, ${at} (in ${span})`,
  noNextHigh: 'Next HIGH-impact event: none known',
  openSummary: (count, risk) => `Open signals: ${String(count)}, open risk ${risk}`,
  strategiesTitle: 'Strategies:',
  strategyStatusName: {
    RESEARCH: 'RESEARCH',
    BACKTESTED: 'BACKTESTED',
    FORWARD_TESTING: 'FORWARD TESTING',
    VALIDATED: 'VALIDATED',
    PAUSED: 'PAUSED',
    DRIFTED: 'DRIFTED',
  },
  strategyLine: (name, version, status, alerts) =>
    `${name} v${version}: ${status}, alerts ${alerts ? 'on' : 'off (shadow)'}`,
  notAvailable: 'not available',
  openTitle: (count, risk) => `OPEN SIGNALS (${String(count)}), open risk ${risk}`,
  noOpen: 'No open signal.',
  waiting: (reasons) => `Waiting: ${reasons}`,
  openActive: (tag, side, strategy, r, price, stop, tp1, timeStop) =>
    `${tag} ${side} ${strategy}: ${r} now (price ${price}). Stop ${stop}, TP1 ${tp1}. Time stop ${timeStop}.`,
  openAfterTp1: (tag, side, strategy, r, price, stop, target, timeStop) =>
    `${tag} ${side} ${strategy}: TP1 hit, ${r} now (price ${price}). Stop at entry ${stop}, runner to ${target}. Time stop ${timeStop}.`,
  noPrice: 'no price',
  moreSignals: (count) => `and ${String(count)} more: see the dashboard.`,
  noClosedYet: 'No signal has closed yet.',
  todayTitle: (date, zone) => `TODAY ${date} (${zone})`,
  monthTitle: (month, year) => `MONTH SO FAR ${month} ${year} (FORWARD-TEST)`,
  noSignalsToday: 'No signals today.',
  generated: (count) => `Signals generated: ${String(count)}`,
  validResults: (count) => `Valid results: ${String(count)}`,
  resultCounts: (win, partial, loss, timeExit) =>
    `Results: win ${String(win)}, partial win ${String(partial)}, loss ${String(loss)}, time exit ${String(timeExit)}`,
  apartCounts: (cancelled, invalid, open) =>
    `Cancelled: ${String(cancelled)}   Data invalid: ${String(invalid)}   Still open: ${String(open)}`,
  netLine: (net) => `Net ${net}`,
  signalLine: (tag, side, strategy, state) => `${tag} ${side} ${strategy}: ${state}`,
  stateOpen: 'still open',
  stateCancelled: 'CANCELLED (not counted)',
  stateInvalid: 'DATA INVALID (not counted)',
  rateLine: (rate, wins, n, interval) =>
    `Win rate ${rate} (${String(wins)} of ${String(n)})  95% CI ${interval}`,
  rateHidden: (n, minimum) =>
    `Win rate: not shown below ${String(minimum)} valid results (n=${String(n)})`,
  moneyLine: (net, expectancy, factor, drawdown) =>
    `Net ${net}   Expectancy ${expectancy}   PF ${factor}   Max drawdown ${drawdown}`,
  byStrategy: 'By strategy:',
  strategyCount: (name, n, rate) =>
    `${name} ${String(n)}${rate === null ? ' (n too small)' : ` (${rate})`}`,
  nTooSmall: 'n too small',
  topCauses: 'Top failure causes:',
  noReviewed: 'Top failure causes: no reviewed result yet',
  pauseUsage:
    'Use /pause to stop new signals until /resume, or /pause 30 for 30 minutes (up to 10080).',
  enginePausedTitle: (at) => `ENGINE PAUSED by you at ${at}.`,
  pausedBody: 'New signals are not sent. Data recording and tracking of open signals continue.',
  pausedUntil: (until, span) => `Paused until ${until} (${span}).`,
  resumeToContinue: '/resume to continue.',
  alreadyPaused: (since) => `The engine is already paused since ${since}.`,
  engineResumed: (at) => `ENGINE RESUMED at ${at}.`,
  resumedBody: 'New signals are sent again.',
  notPaused: 'The engine was not paused.',
  feedStaleTitle: (since) => `FEED STALE since ${since}`,
  feedDisconnectedTitle: (since) => `FEED DISCONNECTED since ${since}`,
  silentFor: (span) => `(no tick for ${span})`,
  newSignalsBlocked: 'New signals are blocked.',
  openTradeNotTracked: (tags) => `Open trade ${tags} cannot be tracked.`,
  feedRecoveredTitle: (at, span) => `FEED RECOVERED ${at} after ${span}.`,
  signalsResume: (at) => `New signals resume at about ${at}, after the warm-up.`,
  signalsResumeSoon: 'New signals resume once the engine has warmed up again.',
  storageTitle: (percent, budget) => `STORAGE ${percent} of the ${budget} budget.`,
  storageRetention: (days) => `Tick retention shortened to ${String(days)} days.`,
  storageLargest: (table, size) => `Largest table: ${table} (${size}).`,
  testTitle: (at) => `TEST MESSAGE ${at}`,
  testBody: 'If you can read this, delivery works. Nothing here is a signal.',
  importanceLabel: { high: 'HIGH-IMPACT', medium: 'MEDIUM-IMPACT', low: 'LOW-IMPACT' },
  upcomingTitle: (impact, currency, minutes, name, at) =>
    `${impact}${currency === '' ? '' : ` ${currency}`} EVENT in ${minutes}: ${name} (${at})`,
  forecastPrevious: (forecast, previous) => `Forecast ${forecast}  Previous ${previous}.`,
  windowNote: (from, until) =>
    `Signals are still sent, but from ${from} until volatility normalises after ${until} they carry a NEWS WINDOW warning.`,
  releasedTitle: (name, at) => `${name} released ${at}`,
  releasedFigures: (actual, forecast, previous, revised, surprise) =>
    `Actual ${actual}, forecast ${forecast}, previous ${previous}${revised === null ? '' : ` (revised ${revised})`}${surprise === null ? '' : ` (surprise ${surprise})`}.`,
  goldAfter: (seconds, move, spread) =>
    `Gold ${String(seconds)} s after: ${move} USD${spread === null ? '' : `, spread ${spread}`}.`,
  releasedWindowNote:
    'Signals in this window carry a NEWS WINDOW warning until spread and ATR normalise.',
  calendarUnavailable: 'Next HIGH-impact event: unknown (the calendar feed is unavailable)',
  topicName: {
    FED_RATES: 'Fed and rates',
    USD_DOLLAR: 'US dollar',
    INFLATION_JOBS: 'Inflation and jobs',
    GEOPOLITICS_WAR: 'Geopolitics',
    TRUMP_POLICY: 'Trump policy',
    CENTRAL_BANK_GOLD: 'Central-bank gold',
    GOLD_DIRECT: 'Gold',
    RISK_OFF: 'Risk-off',
  },
  impactName: { HIGH: 'HIGH', MEDIUM: 'MED', LOW: 'LOW' },
  headlineTitle: (impact, topics) => `HEADLINE (${impact}) | ${topics}`,
  headlineSeen: (sources, published, detected, delay) =>
    published === null || delay === null
      ? `Seen in: ${sources}. No publication time given, detected ${detected}.`
      : `Seen in: ${sources}. Published ${published}, detected ${detected} (${delay} later).`,
  goldSince: (move, atr, spread) =>
    `Gold since publication: ${move} USD${atr === null ? '' : ` (${atr} x ATR 5m)`}${spread === null ? '' : `, spread ${spread}`}.`,
  goldSinceNone: 'Gold since publication: not measured (no recent tick).',
  topicHistory: (impact, topic, share, n, baseline) =>
    `Topic history: ${impact} ${topic} headlines moved gold by 1 ATR or more in ${share} of cases (n=${String(n)}${baseline === null ? '' : `, normal ${baseline}`}).`,
  topicHistoryNone: 'Topic history: not enough data yet.',
  headlineLink: (url) => `Link: ${url}`,
  headlineNote: 'This is context, not a signal. Whether the headline caused the move is not known.',
  moveTitle: (direction, move, span, multiple, basis, spread, at) =>
    `GOLD SPIKE ${direction} ${move} USD in ${span} (${multiple} x ATR ${basis})${spread === null ? '' : `, spread ${spread}`} at ${at}.`,
  causesTitle: 'Possible causes, not confirmed (headlines in the previous 30 min, by impact):',
  causeLine: (n, impact, title, sources, at) =>
    `${String(n)}. ${impact}  "${title}" (${sources}, ${at})`,
  causeUnclassified: (n, title, sources, at) =>
    `${String(n)}. (unclassified, timing only) "${title}" (${sources}, ${at})`,
  noCause:
    'No matching headline found in the free feeds. The move may be technical, flow-driven, or the news may not be in these feeds yet.',
  causesUnavailable:
    'The headline feeds are unavailable, so possible causes could not be checked. The move may be technical, flow-driven, or news.',
  moveOpen: (list) => (list === null ? 'Open signals: none.' : `Open signals: ${list}.`),
  headlineFeedsDownTitle: (since) => `HEADLINE FEEDS DOWN since ${since}`,
  headlineFeedsSilent: (span) => `(no feed answered for ${span})`,
  headlineFeedsDownBody:
    'Headline alerts and the news line of new signals are unavailable. The price feed, the calendar and open signals are not affected.',
  headlineFeedsBackTitle: (at, span) => `HEADLINE FEEDS BACK ${at} after ${span}.`,
  headlineFeedsBackBody: 'Headline alerts and the news line of signals work again.',
  sampleBanner: 'SAMPLE, not a real signal',
  sampleBannerLong: 'SAMPLE MESSAGE for review: made-up numbers, not a signal, nothing to trade.',
};

const hinglish: AlertWords = {
  helpTitle: 'COMMANDS',
  helpLine: {
    status: '/status: feed, engine, session, agla event, strategies',
    open: '/open: khule signals, live R ke saath',
    last: '/last: aakhri band signal aur uska review',
    today: '/today: aaj ke signals, results aur net R',
    month: '/month: is mahine ab tak',
    pause: '/pause [minutes]: naye signals band (tracking chalti rahegi)',
    resume: '/resume: naye signals dobara bhejo',
    help: '/help: ye list',
  },
  helpNote: 'Signals sirf madad hain. Har order aap khud lagate ho.',
  unknownCommand: (name) => `/${name} command nahi hai. /help dekho.`,
  startText: 'VM Gold Signal. Is chat par alerts aayenge. Commands ke liye /help.',
  linked:
    'Link ho gaya. Ab alerts is chat par aayenge, aur sirf yahi chat suni jaayegi. /help dekho.',
  linkInvalid: 'Ye code sahi nahi hai (expire ho gaya hoga). Server par naya banao.',
  statusTitle: (at) => `STATUS ${at}`,
  feedStateName: {
    LIVE: 'LIVE',
    STALE: 'STALE (ruka hua)',
    DISCONNECTED: 'DISCONNECTED (juda nahi)',
    MARKET_CLOSED: 'MARKET BAND',
    WARMING_UP: 'WARMING UP',
  },
  feedLine: (state, detail) => `Feed: ${state}${detail === '' ? '' : `, ${detail}`}`,
  noTickYet: 'abhi tak koi tick nahi',
  lastTick: (age) => `aakhri tick ${age} pehle`,
  spreadOf: (spread) => `spread ${spread}`,
  engineRunning: 'Engine: CHAL RAHA HAI',
  enginePausedSince: (since) => `Engine: PAUSE hai, ${since} se`,
  engineWarming: (percent) => `Engine: WARMING UP (${percent}%)`,
  sessionRegime: (session, regime) => `Session: ${session}, regime: ${regime ?? 'abhi pata nahi'}`,
  nextHigh: (name, at, span) => `Agla HIGH-impact event: ${name}, ${at} (${span} mein)`,
  noNextHigh: 'Agla HIGH-impact event: koi pata nahi',
  openSummary: (count, risk) => `Khule signals: ${String(count)}, khula risk ${risk}`,
  strategiesTitle: 'Strategies:',
  strategyStatusName: {
    RESEARCH: 'RESEARCH',
    BACKTESTED: 'BACKTESTED',
    FORWARD_TESTING: 'FORWARD TESTING',
    VALIDATED: 'VALIDATED',
    PAUSED: 'PAUSED',
    DRIFTED: 'DRIFTED',
  },
  strategyLine: (name, version, status, alerts) =>
    `${name} v${version}: ${status}, alerts ${alerts ? 'on' : 'off (shadow)'}`,
  notAvailable: 'available nahi',
  openTitle: (count, risk) => `KHULE SIGNALS (${String(count)}), khula risk ${risk}`,
  noOpen: 'Koi signal khula nahi hai.',
  waiting: (reasons) => `Ruke hain: ${reasons}`,
  openActive: (tag, side, strategy, r, price, stop, tp1, timeStop) =>
    `${tag} ${side} ${strategy}: abhi ${r} (price ${price}). Stop ${stop}, TP1 ${tp1}. Time stop ${timeStop}.`,
  openAfterTp1: (tag, side, strategy, r, price, stop, target, timeStop) =>
    `${tag} ${side} ${strategy}: TP1 lag chuka, abhi ${r} (price ${price}). Stop entry par ${stop}, runner ${target} tak. Time stop ${timeStop}.`,
  noPrice: 'price nahi',
  moreSignals: (count) => `aur ${String(count)} signals: dashboard dekho.`,
  noClosedYet: 'Abhi tak koi signal band nahi hua.',
  todayTitle: (date, zone) => `AAJ ${date} (${zone})`,
  monthTitle: (month, year) => `IS MAHINE AB TAK ${month} ${year} (FORWARD-TEST)`,
  noSignalsToday: 'Aaj koi signal nahi aaya.',
  generated: (count) => `Signals bane: ${String(count)}`,
  validResults: (count) => `Valid results: ${String(count)}`,
  resultCounts: (win, partial, loss, timeExit) =>
    `Results: win ${String(win)}, partial win ${String(partial)}, loss ${String(loss)}, time exit ${String(timeExit)}`,
  apartCounts: (cancelled, invalid, open) =>
    `Cancelled: ${String(cancelled)}   Data invalid: ${String(invalid)}   Abhi khule: ${String(open)}`,
  netLine: (net) => `Net ${net}`,
  signalLine: (tag, side, strategy, state) => `${tag} ${side} ${strategy}: ${state}`,
  stateOpen: 'abhi khula hai',
  stateCancelled: 'CANCELLED (ginti mein nahi)',
  stateInvalid: 'DATA INVALID (ginti mein nahi)',
  rateLine: (rate, wins, n, interval) =>
    `Win rate ${rate} (${String(n)} mein se ${String(wins)})  95% CI ${interval}`,
  rateHidden: (n, minimum) =>
    `Win rate ${String(minimum)} valid results se pehle nahi dikhta (n=${String(n)})`,
  moneyLine: (net, expectancy, factor, drawdown) =>
    `Net ${net}   Expectancy ${expectancy}   PF ${factor}   Max drawdown ${drawdown}`,
  byStrategy: 'Strategy ke hisaab se:',
  strategyCount: (name, n, rate) =>
    `${name} ${String(n)}${rate === null ? ' (n bahut chhota)' : ` (${rate})`}`,
  nTooSmall: 'n bahut chhota',
  topCauses: 'Sabse zyada failure causes:',
  noReviewed: 'Sabse zyada failure causes: abhi koi reviewed result nahi',
  pauseUsage:
    '/pause se naye signals /resume tak band, ya /pause 30 se 30 minute ke liye (10080 tak).',
  enginePausedTitle: (at) => `ENGINE PAUSE kiya aapne, ${at} par.`,
  pausedBody:
    'Naye signals nahi bheje jaayenge. Data recording aur khule signals ki tracking chalti rahegi.',
  pausedUntil: (until, span) => `${until} tak pause (${span}).`,
  resumeToContinue: 'Chalu karne ke liye /resume.',
  alreadyPaused: (since) => `Engine pehle se pause hai, ${since} se.`,
  engineResumed: (at) => `ENGINE DOBARA CHALU, ${at} par.`,
  resumedBody: 'Naye signals phir se bheje jaayenge.',
  notPaused: 'Engine pause mein nahi tha.',
  feedStaleTitle: (since) => `FEED STALE, ${since} se`,
  feedDisconnectedTitle: (since) => `FEED DISCONNECTED, ${since} se`,
  silentFor: (span) => `(${span} se koi tick nahi)`,
  newSignalsBlocked: 'Naye signals band hain.',
  openTradeNotTracked: (tags) => `Khula trade ${tags} track nahi ho sakta.`,
  feedRecoveredTitle: (at, span) => `FEED WAPAS ${at}, ${span} baad.`,
  signalsResume: (at) => `Naye signals lagbhag ${at} se phir shuru, warm-up ke baad.`,
  signalsResumeSoon: 'Engine dobara warm up hote hi naye signals shuru honge.',
  storageTitle: (percent, budget) => `STORAGE ${budget} ke budget ka ${percent}.`,
  storageRetention: (days) => `Tick retention ghata kar ${String(days)} din kiya.`,
  storageLargest: (table, size) => `Sabse badi table: ${table} (${size}).`,
  testTitle: (at) => `TEST MESSAGE ${at}`,
  testBody: 'Ye padh paa rahe ho to delivery sahi chal rahi hai. Ye koi signal nahi hai.',
  importanceLabel: { high: 'HIGH-IMPACT', medium: 'MEDIUM-IMPACT', low: 'LOW-IMPACT' },
  upcomingTitle: (impact, currency, minutes, name, at) =>
    `${impact}${currency === '' ? '' : ` ${currency}`} EVENT ${minutes} mein: ${name} (${at})`,
  forecastPrevious: (forecast, previous) => `Forecast ${forecast}  Pichhla ${previous}.`,
  windowNote: (from, until) =>
    `Signals bheje jaate rahenge, par ${from} se ${until} ke baad volatility normal hone tak un par NEWS WINDOW chetavni rahegi.`,
  releasedTitle: (name, at) => `${name} aa gaya, ${at}`,
  releasedFigures: (actual, forecast, previous, revised, surprise) =>
    `Actual ${actual}, forecast ${forecast}, pichhla ${previous}${revised === null ? '' : ` (badal kar ${revised})`}${surprise === null ? '' : ` (surprise ${surprise})`}.`,
  goldAfter: (seconds, move, spread) =>
    `Gold ${String(seconds)} s baad: ${move} USD${spread === null ? '' : `, spread ${spread}`}.`,
  releasedWindowNote:
    'Is window ke signals par NEWS WINDOW chetavni rahegi jab tak spread aur ATR normal nahi hote.',
  calendarUnavailable: 'Agla HIGH-impact event: pata nahi (calendar feed available nahi hai)',
  topicName: {
    FED_RATES: 'Fed aur rates',
    USD_DOLLAR: 'US dollar',
    INFLATION_JOBS: 'Inflation aur jobs',
    GEOPOLITICS_WAR: 'Geopolitics',
    TRUMP_POLICY: 'Trump policy',
    CENTRAL_BANK_GOLD: 'Central bank gold',
    GOLD_DIRECT: 'Gold',
    RISK_OFF: 'Risk-off',
  },
  impactName: { HIGH: 'HIGH', MEDIUM: 'MED', LOW: 'LOW' },
  headlineTitle: (impact, topics) => `HEADLINE (${impact}) | ${topics}`,
  headlineSeen: (sources, published, detected, delay) =>
    published === null || delay === null
      ? `Dikhi: ${sources}. Publication time nahi diya, detect hui ${detected}.`
      : `Dikhi: ${sources}. Published ${published}, detect hui ${detected} (${delay} baad).`,
  goldSince: (move, atr, spread) =>
    `Publication ke baad gold: ${move} USD${atr === null ? '' : ` (${atr} x ATR 5m)`}${spread === null ? '' : `, spread ${spread}`}.`,
  goldSinceNone: 'Publication ke baad gold: naapa nahi gaya (haal ka tick nahi).',
  topicHistory: (impact, topic, share, n, baseline) =>
    `Topic ka record: ${impact} ${topic} headlines ke baad gold ${share} baar 1 ATR ya zyada hila (n=${String(n)}${baseline === null ? '' : `, normal ${baseline}`}).`,
  topicHistoryNone: 'Topic ka record: abhi kaafi data nahi.',
  headlineLink: (url) => `Link: ${url}`,
  headlineNote: 'Ye context hai, signal nahi. Headline se move hua ya nahi, ye pata nahi.',
  moveTitle: (direction, move, span, multiple, basis, spread, at) =>
    `GOLD SPIKE ${direction} ${move} USD ${span} mein (${multiple} x ATR ${basis})${spread === null ? '' : `, spread ${spread}`}, ${at} par.`,
  causesTitle: 'Possible causes, confirm nahi (pichhle 30 min ki headlines, impact ke hisaab se):',
  causeLine: (n, impact, title, sources, at) =>
    `${String(n)}. ${impact}  "${title}" (${sources}, ${at})`,
  causeUnclassified: (n, title, sources, at) =>
    `${String(n)}. (unclassified, sirf timing) "${title}" (${sources}, ${at})`,
  noCause:
    'Free feeds mein koi matching headline nahi mili. Move technical ya flow se ho sakta hai, ya news in feeds mein abhi aayi nahi.',
  causesUnavailable:
    'Headline feeds available nahi hain, isliye possible causes check nahi ho sake. Move technical, flow ya news se ho sakta hai.',
  moveOpen: (list) => (list === null ? 'Khule signals: koi nahi.' : `Khule signals: ${list}.`),
  headlineFeedsDownTitle: (since) => `HEADLINE FEEDS BAND, ${since} se`,
  headlineFeedsSilent: (span) => `(${span} se kisi feed ne jawab nahi diya)`,
  headlineFeedsDownBody:
    'Headline alerts aur naye signals ki news line available nahi hain. Price feed, calendar aur khule signals par asar nahi.',
  headlineFeedsBackTitle: (at, span) => `HEADLINE FEEDS WAPAS ${at}, ${span} baad.`,
  headlineFeedsBackBody: 'Headline alerts aur signals ki news line phir chal rahi hain.',
  sampleBanner: 'SAMPLE, asli signal nahi',
  sampleBannerLong:
    'SAMPLE MESSAGE review ke liye: banaye hue numbers, signal nahi, trade karne ke liye kuch nahi.',
};

export const ALERT_WORDS: Readonly<Record<Locale, AlertWords>> = { en, hinglish };
