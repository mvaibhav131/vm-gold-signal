/** The pictures of the messages, in one place so that the look can be changed without touching a formatter. */
export const ICON = {
  buy: '🟢',
  sell: '🔴',
  entry: '📍',
  stop: '🛑',
  tp1: '🎯',
  tp2: '🏁',
  time: '⏱',
  quality: '📊',
  macro: '🗓',
  warning: '⚠️',
  news: '📰',
  open: '📂',
  evidence: '📈',
  research: '🔬',
  review: '🔍',
  action: '👉',
  released: '📣',
  strong: '🟢',
  weak: '🟡',
  fail: '🔴',
  noData: '⚪',
  win: '✅',
  partial: '🟡',
  loss: '❌',
  invalid: '⚪',
  cancelled: '🚫',
  feedDown: '🔴',
  feedUp: '🟢',
  paused: '⏸',
  running: '▶️',
  test: '🧪',
  storage: '🗄',
  status: '📋',
  help: '💬',
  link: '🔗',
  today: '📅',
  month: '🗓',
} as const;

/** The colour of the state of the feed. */
export const FEED_ICON = {
  LIVE: ICON.strong,
  STALE: ICON.weak,
  DISCONNECTED: ICON.fail,
  MARKET_CLOSED: ICON.noData,
  WARMING_UP: ICON.weak,
} as const;

/** The colour of the side of a trade. */
export const sideIcon = (side: 'BUY' | 'SELL'): string => (side === 'BUY' ? ICON.buy : ICON.sell);

/** The mark of the result of a signal, and of a signal that has none yet. */
export const RESULT_ICON = {
  WIN: ICON.win,
  PARTIAL_WIN: ICON.partial,
  LOSS: ICON.loss,
  TIME_EXIT: ICON.time,
  CANCELLED: ICON.cancelled,
  DATA_INVALID: ICON.invalid,
  PENDING: '⏳',
} as const;

/** The colour of the state of a group of the quality score. */
export const STATE_ICON = {
  STRONG: ICON.strong,
  OK: ICON.strong,
  WEAK: ICON.weak,
  FAIL: ICON.fail,
  NA: ICON.noData,
} as const;
