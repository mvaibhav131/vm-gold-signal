// Closed vocabularies of the system. Contracts build their Zod enums from these tuples,
// so the engine and the API can never disagree about a value.

export const SIDES = ['BUY', 'SELL'] as const;
export type Side = (typeof SIDES)[number];

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Candle length. 1m to 4h are aligned to UTC; the 1d candle follows the 17:00 New York trading day. */
export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** ROLLOVER (21:45-23:15 UTC) is a session of its own in the status bar (05_UI_Spec section 3). */
export const SESSIONS = ['ASIA', 'LONDON', 'OVERLAP', 'NEW_YORK', 'ROLLOVER'] as const;
export type Session = (typeof SESSIONS)[number];

export const REGIMES = [
  'TREND_UP',
  'TREND_DOWN',
  'RANGE',
  'SQUEEZE',
  'BREAKOUT',
  'HIGH_VOL',
  'UNCERTAIN',
] as const;
export type Regime = (typeof REGIMES)[number];

export const VOL_BUCKETS = ['LOW', 'NORMAL', 'HIGH'] as const;
export type VolBucket = (typeof VOL_BUCKETS)[number];

export const NEWS_STATES = ['CLEAR', 'IN_WINDOW', 'UNKNOWN'] as const;
export type NewsState = (typeof NEWS_STATES)[number];

export const SIGNAL_MODES = ['LIVE', 'SIMULATED', 'BACKTEST'] as const;
export type SignalMode = (typeof SIGNAL_MODES)[number];

export const EXIT_PROFILES = ['EP1_PARTIAL', 'EP2_SINGLE', 'EP3_STRUCTURE'] as const;
export type ExitProfile = (typeof EXIT_PROFILES)[number];

export const STRATEGY_KEYS = [
  'trend_pullback',
  'sweep_reversal',
  'squeeze_retest',
  'trendline_retest',
  'pattern_breakout',
] as const;
export type StrategyKey = (typeof STRATEGY_KEYS)[number];

export const STRATEGY_STATUSES = [
  'RESEARCH',
  'BACKTESTED',
  'FORWARD_TESTING',
  'VALIDATED',
  'PAUSED',
  'DRIFTED',
] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export const GATE_CODES = [
  'DATA_FRESH',
  'WARMUP_OK',
  'CLOCK_OK',
  'SPREAD_OK',
  'GAP_RECOVERY_OK',
  'REGIME_OK',
  'STOP_OK',
  'TARGET_OK',
  'QUALITY_OK',
] as const;
export type GateCode = (typeof GATE_CODES)[number];

export const ADVISORY_FLAGS = [
  'NEWS_WINDOW',
  'NEWS_SHOCK',
  'HEADLINE_RECENT',
  'ROLLOVER',
  'OFF_HOURS',
  'NEAR_LEVEL',
  'OPPOSES_OPEN',
  'UNVALIDATED_STRATEGY',
  'NEWS_UNKNOWN',
] as const;
export type AdvisoryFlag = (typeof ADVISORY_FLAGS)[number];

export const QUALITY_GROUPS = [
  'trend',
  'structure',
  'trigger',
  'volatility',
  'execution',
  'sessionMacro',
  'reward',
] as const;
export type QualityGroup = (typeof QUALITY_GROUPS)[number];

export const GROUP_STATES = ['STRONG', 'OK', 'WEAK', 'FAIL', 'NA'] as const;
export type GroupState = (typeof GROUP_STATES)[number];

export const GRADES = ['Moderate', 'Strong', 'Very strong'] as const;
export type Grade = (typeof GRADES)[number];

export const SIGNAL_STATUSES = ['ACTIVE', 'TP1_HIT', 'CLOSED'] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const SIGNAL_EVENT_TYPES = [
  'CREATED',
  'ALERT_QUEUED',
  'TP1_HIT',
  'STOP_MOVED_TO_ENTRY',
  'TP2_HIT',
  'SL_HIT',
  'TIME_EXIT',
  'CANCELLED',
  'DATA_INVALID',
  'AUTOPSY_PRELIMINARY',
  'AUTOPSY_FINAL',
] as const;
export type SignalEventType = (typeof SIGNAL_EVENT_TYPES)[number];

export const RESULTS = [
  'WIN',
  'PARTIAL_WIN',
  'LOSS',
  'TIME_EXIT',
  'CANCELLED',
  'DATA_INVALID',
] as const;
export type Result = (typeof RESULTS)[number];

export const CAUSE_CODES = [
  'NO_FOLLOW_THROUGH',
  'STOP_HUNT_REVERSAL',
  'NEWS_SHOCK',
  'HTF_STRUCTURE_BREAK',
  'REGIME_SHIFT',
  'LIQUIDITY_DROP',
  'SPREAD_COST',
  'TIME_DECAY',
  'NORMAL_LOSS',
] as const;
export type CauseCode = (typeof CAUSE_CODES)[number];

export const CAUSE_CATEGORIES = ['SETUP_FAILURE', 'MARKET_EVENT', 'EXECUTION', 'DATA'] as const;
export type CauseCategory = (typeof CAUSE_CATEGORIES)[number];

export const AUTOPSY_STATUSES = ['PRELIMINARY', 'FINAL'] as const;
export type AutopsyStatus = (typeof AUTOPSY_STATUSES)[number];

export const STATS_SCOPES = ['FORWARD', 'BACKTEST_OOS'] as const;
export type StatsScope = (typeof STATS_SCOPES)[number];

export const CANDLE_SOURCES = ['live', 'histdata_bootstrap', 'biquote_ohlc_bootstrap'] as const;
export type CandleSource = (typeof CANDLE_SOURCES)[number];

export const FEED_STATES = [
  'LIVE',
  'STALE',
  'DISCONNECTED',
  'MARKET_CLOSED',
  'WARMING_UP',
] as const;
export type FeedState = (typeof FEED_STATES)[number];

export const ENGINE_STATUSES = ['RUNNING', 'PAUSED'] as const;
export type EngineStatus = (typeof ENGINE_STATUSES)[number];

export const FEED_PROVIDERS = ['biquote', 'replay'] as const;
export type FeedProvider = (typeof FEED_PROVIDERS)[number];

export const NOTIFICATION_CHANNELS = ['telegram', 'webpush'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = [
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
  'DEAD',
  'EXPIRED',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const FEED_INCIDENT_KINDS = [
  'DISCONNECT',
  'STALE',
  'GAP',
  'CLOCK_SKEW',
  'SPREAD_SPIKE',
  'MARKET_STATE',
] as const;
export type FeedIncidentKind = (typeof FEED_INCIDENT_KINDS)[number];

export const NOTIFICATION_KINDS = [
  'SIGNAL_NEW',
  'SIGNAL_TP1',
  'SIGNAL_CLOSED',
  'SIGNAL_CANCELLED',
  'SIGNAL_REVIEW_FINAL',
  'NEWS_UPCOMING',
  'NEWS_RELEASED',
  'NEWS_HEADLINE',
  'MARKET_MOVE',
  'SYSTEM_DEGRADED',
  'SYSTEM_RECOVERED',
  'ENGINE_PAUSED',
  'STORAGE_WARNING',
  'DAILY_DIGEST',
  'MONTHLY_REPORT',
  'TEST',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NEWS_TOPICS = [
  'FED_RATES',
  'USD_DOLLAR',
  'INFLATION_JOBS',
  'GEOPOLITICS_WAR',
  'TRUMP_POLICY',
  'CENTRAL_BANK_GOLD',
  'GOLD_DIRECT',
  'RISK_OFF',
] as const;
export type NewsTopic = (typeof NEWS_TOPICS)[number];

export const NEWS_IMPACTS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type NewsImpact = (typeof NEWS_IMPACTS)[number];

/** "Headline feed unavailable" must look different from "no headlines" (02_Signal_Engine section 16). */
export const NEWS_FEED_STATES = ['AVAILABLE', 'UNAVAILABLE'] as const;
export type NewsFeedState = (typeof NEWS_FEED_STATES)[number];

export const MARKET_EVENT_KINDS = ['SPIKE_UP', 'SPIKE_DOWN'] as const;
export type MarketEventKind = (typeof MARKET_EVENT_KINDS)[number];

export const MACRO_IMPORTANCE = ['low', 'medium', 'high'] as const;
export type MacroImportance = (typeof MACRO_IMPORTANCE)[number];

export const LOCALES = ['en', 'hinglish'] as const;
export type Locale = (typeof LOCALES)[number];

/** Owner switch for an advisory flag: it only warns, or it blocks the signal. */
export const GATE_MODES = ['warn', 'block'] as const;
export type GateMode = (typeof GATE_MODES)[number];
