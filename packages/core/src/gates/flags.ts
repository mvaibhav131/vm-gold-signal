import type { MacroProximity } from '../context/macro';
import type { NewsShockResult } from '../context/newsShock';
import {
  ADVISORY_FLAGS,
  type AdvisoryFlag,
  type GateCode,
  type GateMode,
  type Side,
  type StrategyStatus,
} from '../domain';
import { assertFinite } from '../indicators/types';
import { sessionClockAt } from '../time/sessions';
import type { NearLevel } from './nearLevel';
import type { GateEvaluation } from './types';

const MINUTE_MS = 60_000;

/** The two time windows of the flags (docs/02 section 6). */
export interface FlagParams {
  /** HEADLINE_RECENT: a HIGH headline cluster published at most this many minutes ago. */
  readonly headlineMinutes: number;
  /** OFF_HOURS: every open market closes within this many minutes. */
  readonly offHoursMinutes: number;
}

export const FLAG_DEFAULTS: FlagParams = { headlineMinutes: 30, offHoursMinutes: 30 };

/** The numbers behind a flag that is present, for the warning line and the stored snapshot. Empty when it is not. */
export type FlagDetail = Readonly<
  Record<string, string | number | boolean | null | readonly string[]>
>;

export interface FlagResult {
  readonly flag: AdvisoryFlag;
  readonly present: boolean;
  readonly detail: FlagDetail;
}

/** The flags that do not depend on a setup. */
export interface FlagMarketInputs {
  /** The decision time, epoch milliseconds. */
  readonly now: number;
  /** The news window and the next event; null when the calendar feed is unavailable. */
  readonly calendar: MacroProximity | null;
  /** NEWS_SHOCK, null while it cannot be judged. */
  readonly newsShock: NewsShockResult | null;
  /** When the newest HIGH-impact headline cluster was published, null if there is none. */
  readonly lastHighHeadlineAt: number | null;
}

/** The flags that look at the setup. */
export interface FlagSetupInputs {
  readonly side: Side;
  readonly strategyStatus: StrategyStatus;
  /** `nearOpposingLevel` for this entry. */
  readonly nearLevel: NearLevel | null;
  /** The open signals, with their sides. */
  readonly openSignals: readonly { readonly id: string; readonly side: Side }[];
}

const NONE: FlagDetail = {};

/**
 * All nine advisory flags (docs/02 section 6), in the order of `ADVISORY_FLAGS`. Without a setup
 * the three flags that look at one (NEAR_LEVEL, OPPOSES_OPEN, UNVALIDATED_STRATEGY) are not present.
 * A flag only describes a condition: whether it blocks is the owner's switch (`decide`).
 */
export function evaluateFlags(
  market: FlagMarketInputs,
  setup: FlagSetupInputs | null,
  params: FlagParams = FLAG_DEFAULTS,
): FlagResult[] {
  assertFinite(market.now, 'now');
  const clock = sessionClockAt(market.now);
  const venues = [clock.london, clock.newYork].filter((venue) => venue !== null);
  const lastMinutes =
    venues.length > 0 && venues.every((venue) => venue.minutesToClose <= params.offHoursMinutes);
  const calendar = market.calendar;
  const headlineAge =
    market.lastHighHeadlineAt === null
      ? null
      : (market.now - market.lastHighHeadlineAt) / MINUTE_MS;
  const opposing =
    setup === null ? [] : setup.openSignals.filter((signal) => signal.side !== setup.side);

  const present: Record<AdvisoryFlag, FlagDetail | null> = {
    NEWS_WINDOW:
      calendar?.windowActive === true
        ? {
            eventId: calendar.windowEvent?.id ?? calendar.last?.id ?? null,
            minutesToEvent:
              calendar.windowEvent === null
                ? null
                : (calendar.windowEvent.scheduledAt - market.now) / MINUTE_MS,
            settling: calendar.settling,
          }
        : null,
    NEWS_SHOCK:
      market.newsShock?.active === true
        ? { atrRatio: market.newsShock.atrRatio, spreadRatio: market.newsShock.spreadRatio }
        : null,
    HEADLINE_RECENT:
      headlineAge !== null && headlineAge <= params.headlineMinutes
        ? { minutesAgo: Math.max(0, headlineAge) }
        : null,
    ROLLOVER: clock.session === 'ROLLOVER' ? { session: clock.session } : null,
    OFF_HOURS:
      clock.session === 'ASIA' || lastMinutes
        ? {
            session: clock.session,
            minutesToClose:
              venues.length === 0 ? null : Math.max(...venues.map((v) => v.minutesToClose)),
          }
        : null,
    NEAR_LEVEL: setup?.nearLevel
      ? {
          levelId: setup.nearLevel.id,
          kind: setup.nearLevel.kind,
          price: setup.nearLevel.price,
          distanceAtr: setup.nearLevel.distanceAtr,
        }
      : null,
    OPPOSES_OPEN: opposing.length > 0 ? { signalIds: opposing.map((signal) => signal.id) } : null,
    UNVALIDATED_STRATEGY:
      setup !== null && setup.strategyStatus !== 'VALIDATED'
        ? { status: setup.strategyStatus }
        : null,
    NEWS_UNKNOWN: calendar === null ? { reason: 'calendar feed unavailable' } : null,
  };
  return ADVISORY_FLAGS.map((flag) => {
    const detail = present[flag];
    return { flag, present: detail !== null, detail: detail ?? NONE };
  });
}

/** The owner's switches (`advisoryGates` of the settings): only these four flags can be set to block. */
export const ADVISORY_SWITCHES = ['newsWindow', 'rollover', 'offHours', 'nearLevel'] as const;
export type AdvisorySwitch = (typeof ADVISORY_SWITCHES)[number];
export type AdvisoryModes = Readonly<Record<AdvisorySwitch, GateMode>>;

/** Which switch belongs to which flag. The other five flags have none: they always warn. */
export const FLAG_SWITCH = {
  NEWS_WINDOW: 'newsWindow',
  ROLLOVER: 'rollover',
  OFF_HOURS: 'offHours',
  NEAR_LEVEL: 'nearLevel',
} as const satisfies Partial<Record<AdvisoryFlag, AdvisorySwitch>>;

/** By default every flag only warns. */
export const DEFAULT_MODES: AdvisoryModes = {
  newsWindow: 'warn',
  rollover: 'warn',
  offHours: 'warn',
  nearLevel: 'warn',
};

/** The modes in force: the owner's settings over the defaults of the strategy config. */
export function resolveModes(
  defaults: AdvisoryModes,
  overrides: Partial<AdvisoryModes> = {},
): AdvisoryModes {
  return {
    newsWindow: overrides.newsWindow ?? defaults.newsWindow,
    rollover: overrides.rollover ?? defaults.rollover,
    offHours: overrides.offHours ?? defaults.offHours,
    nearLevel: overrides.nearLevel ?? defaults.nearLevel,
  };
}

/** `warn` for every flag that has no switch, the switch's mode for the others. */
export function modeOf(flag: AdvisoryFlag, modes: AdvisoryModes): GateMode {
  const switchOf: AdvisorySwitch | undefined = (
    FLAG_SWITCH as Partial<Record<AdvisoryFlag, AdvisorySwitch>>
  )[flag];
  return switchOf === undefined ? 'warn' : modes[switchOf];
}

export interface Decision {
  /** A signal may be made: every gate passed and no present flag is switched to block. */
  readonly allowed: boolean;
  /** The blocking gates that failed. */
  readonly failedGates: readonly GateCode[];
  /** The present flags that the owner switched to block. */
  readonly blockedBy: readonly AdvisoryFlag[];
  /** The present flags that stay warnings: they are stored on the signal (`warnings`). */
  readonly warnings: readonly AdvisoryFlag[];
  /** What a rejection records (`rejections.failed_gates`): the failed gates, then the blocking flags. */
  readonly rejectionCodes: readonly (GateCode | AdvisoryFlag)[];
}

/**
 * The verdict on a setup. Only a failed gate or a flag that the owner switched to block stops it;
 * every other present flag becomes a warning. All nine gates must have been evaluated.
 */
export function decide(
  gates: GateEvaluation,
  flags: readonly FlagResult[],
  modes: AdvisoryModes,
): Decision {
  if (!gates.complete) throw new RangeError('a decision needs all nine blocking gates');
  const present = flags.filter((result) => result.present).map((result) => result.flag);
  const blockedBy = present.filter((flag) => modeOf(flag, modes) === 'block');
  const warnings = present.filter((flag) => modeOf(flag, modes) === 'warn');
  return {
    allowed: gates.passed && blockedBy.length === 0,
    failedGates: gates.failed,
    blockedBy,
    warnings,
    rejectionCodes: [...gates.failed, ...blockedBy],
  };
}
