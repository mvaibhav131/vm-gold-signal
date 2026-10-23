import type { Session } from '../domain';
import { assertCandle, assertInOrder, type StructureCandle } from '../structure/types';
import { sessionAt } from '../time/sessions';
import { tradingDayOf } from '../time/tradingDay';
import { formatCivilDate, utcCivilDate } from '../time/zone';

const DAY_MS = 86_400_000;

/** The high, low, open and close of a stretch of candles. */
export interface PriceRange {
  readonly high: number;
  readonly low: number;
  readonly open: number;
  readonly close: number;
  readonly firstOpenTime: number;
  readonly lastOpenTime: number;
  readonly count: number;
}

/** A trading day (17:00 New York to 17:00 New York). `label` is the New York date on which it ends. */
export interface DayRange extends PriceRange {
  readonly label: string;
}

/** A trading week: its days Monday to Friday. `label` is the label of that Monday. */
export interface WeekRange extends PriceRange {
  readonly label: string;
}

export const RANGE_NAMES = ['ASIA', 'LONDON', 'NEW_YORK'] as const;
export type RangeName = (typeof RANGE_NAMES)[number];

/** One session of one UTC day. `day` is that UTC date. */
export interface SessionRange extends PriceRange {
  readonly name: RangeName;
  readonly day: string;
}

/** The session label of the candle in progress, with its range so far. */
export interface CurrentSession extends PriceRange {
  readonly session: Session;
  readonly day: string;
}

/**
 * The sessions of the liquidity levels. A venue's range covers all the hours it is open, so London
 * includes the overlap with New York and New York includes it too; Asia is the part of the Asian
 * morning before London opens (docs/02 section 2).
 */
const MEMBERS: Readonly<Record<RangeName, readonly Session[]>> = {
  ASIA: ['ASIA'],
  LONDON: ['LONDON', 'OVERLAP'],
  NEW_YORK: ['OVERLAP', 'NEW_YORK'],
};

function start(candle: StructureCandle): PriceRange {
  return {
    high: candle.h,
    low: candle.l,
    open: candle.o,
    close: candle.c,
    firstOpenTime: candle.openTime,
    lastOpenTime: candle.openTime,
    count: 1,
  };
}

function grow<T extends PriceRange>(range: T, candle: StructureCandle): T {
  return {
    ...range,
    high: Math.max(range.high, candle.h),
    low: Math.min(range.low, candle.l),
    close: candle.c,
    lastOpenTime: candle.openTime,
    count: range.count + 1,
  };
}

/** The label of the Monday on or before the date of a trading-day label. */
export function tradingWeekLabel(dayLabel: string): string {
  const [year, month, day] = dayLabel.split('-').map(Number);
  const ms = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  const weekday = new Date(ms).getUTCDay();
  return formatCivilDate(utcCivilDate(ms - ((weekday + 6) % 7) * DAY_MS));
}

/**
 * The previous-day, session and previous-week ranges, built from the candles fed so far
 * (docs/02 sections 2 and 3). Candles belong to a trading day, week and session by their open
 * time, so use a timeframe whose boundaries line up with 17:00 New York and the session edges
 * (15 minutes or less). Only candles that were fed are counted: after a restart, feed the history
 * of the last days first. A day with no candles (a holiday) does not exist, so "previous day" is
 * the last one that had candles.
 */
export class PeriodRanges {
  private day: DayRange | null = null;
  private previous: DayRange | null = null;
  private week: WeekRange | null = null;
  private previousWeekRange: WeekRange | null = null;
  private now: CurrentSession | null = null;
  private readonly inProgressRanges: Record<RangeName, SessionRange | null> = {
    ASIA: null,
    LONDON: null,
    NEW_YORK: null,
  };
  private readonly completedRanges: Record<RangeName, SessionRange | null> = {
    ASIA: null,
    LONDON: null,
    NEW_YORK: null,
  };
  private seen = 0;
  private lastOpenTime: number | null = null;

  get count(): number {
    return this.seen;
  }

  /** The trading day in progress, so far. */
  get today(): DayRange | null {
    return this.day;
  }

  /** The last complete trading day: where PDH, PDL and the daily pivots come from. */
  get previousDay(): DayRange | null {
    return this.previous;
  }

  get thisWeek(): WeekRange | null {
    return this.week;
  }

  /** The last complete trading week: where the weekly pivots come from. */
  get previousWeek(): WeekRange | null {
    return this.previousWeekRange;
  }

  /** The session of the latest candle with its range so far (high and low of "this session"). */
  get session(): CurrentSession | null {
    return this.now;
  }

  /** The Asia, London or New York range that is still going on. */
  inProgress(name: RangeName): SessionRange | null {
    return this.inProgressRanges[name];
  }

  /** The latest Asia, London or New York range that has ended. */
  completed(name: RangeName): SessionRange | null {
    return this.completedRanges[name];
  }

  update(candle: StructureCandle): void {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    this.lastOpenTime = candle.openTime;
    this.seen += 1;

    const dayLabel = tradingDayOf(candle.openTime).label;
    if (this.day?.label === dayLabel) {
      this.day = grow(this.day, candle);
    } else {
      if (this.day) this.previous = this.day;
      this.day = { ...start(candle), label: dayLabel };
    }
    const weekLabel = tradingWeekLabel(dayLabel);
    if (this.week?.label === weekLabel) {
      this.week = grow(this.week, candle);
    } else {
      if (this.week) this.previousWeekRange = this.week;
      this.week = { ...start(candle), label: weekLabel };
    }

    const session = sessionAt(candle.openTime);
    const utcDay = formatCivilDate(utcCivilDate(candle.openTime));
    if (this.now?.session === session && this.now.day === utcDay) {
      this.now = grow(this.now, candle);
    } else {
      this.now = { ...start(candle), session, day: utcDay };
    }

    for (const name of RANGE_NAMES) {
      const open = this.inProgressRanges[name];
      if (MEMBERS[name].includes(session)) {
        if (open?.day === utcDay) {
          this.inProgressRanges[name] = grow(open, candle);
        } else {
          if (open) this.completedRanges[name] = open;
          this.inProgressRanges[name] = { ...start(candle), name, day: utcDay };
        }
      } else if (open) {
        this.completedRanges[name] = open;
        this.inProgressRanges[name] = null;
      }
    }
  }
}
