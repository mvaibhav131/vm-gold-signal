import { macroProximity, newsStateOf, type MacroProximity } from '../context/macro';
import { newsShockOf, ratioOf } from '../context/newsShock';
import { TIMEFRAME_MS, type Regime, type Side, type VolBucket } from '../domain';
import { buildExplanation } from '../explain/build';
import { decide as decideSetup, evaluateFlags, resolveModes } from '../gates/flags';
import { evaluateGates, storedGates } from '../gates/blocking';
import { nearOpposingLevel } from '../gates/nearLevel';
import type { GateResult, MarketGateInputs } from '../gates/types';
import { qualityStrengths, scoreQuality } from '../scoring/score';
import { sessionAt } from '../time/sessions';
import { TRADED_SYMBOL } from '../symbol';
import { planTrade } from '../trade/plan';
import { roundPrice } from '../trade/round';
import { chartObjectsOf, qualityInputsOf } from './inputs';
import { MarketTracker, type MarketView } from './market';
import { runnerOf, type StrategyRunner } from './strategies';
import {
  type Candidate,
  type DecisionContext,
  type EngineCandle,
  type EngineDecision,
  type EngineSignalDraft,
  type EngineTimeframe,
  type Outcome,
  type Rejection,
  type StrategySpec,
} from './types';
import type { ExplanationEvidence } from '../explain/types';
import type { BucketDims } from '../stats/evidence';

const FIVE_MS = TIMEFRAME_MS['5m'];
const iso = (ms: number): string => new Date(ms).toISOString();
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * The decision step of docs/01 section 5 (steps 1 to 4) as one deterministic object. Feed it every
 * closed candle of the 5m, 15m and 1h in the order they closed (`mergeByClose`); when a 5m candle
 * has closed and its confirming quote has arrived, `decide` answers for each strategy that has a
 * setup: a signal, or a rejection with the codes of what failed. It does no I/O and reads no clock,
 * so the live worker, the backtester and the tests get the same answer from the same candles. The
 * evidence of a kind of setup is the one thing it does not know: `candidates()` lists what is
 * needed, and `decide` takes a lookup for it.
 */
export class DecisionEngine {
  readonly market = new MarketTracker();
  private readonly runners: readonly { spec: StrategySpec; runner: StrategyRunner }[];

  constructor(readonly specs: readonly StrategySpec[]) {
    if (specs.length === 0) throw new RangeError('the engine needs at least one strategy');
    this.runners = specs.map((spec) => ({ spec, runner: runnerOf(spec) }));
  }

  /** How many candles of each timeframe have been fed. */
  get counts(): Readonly<Record<EngineTimeframe, number>> {
    return this.market.counts;
  }

  push(tf: EngineTimeframe, candle: EngineCandle): void {
    this.market.push(tf, candle);
    const levels = tf === '5m' ? this.market.levelsOfNewestFive : [];
    for (const { runner } of this.runners) runner.push(tf, candle, levels);
  }

  /** The market as of the newest 5m candle (null before the first). */
  view(): MarketView | null {
    return this.market.view();
  }

  /** The regime at a past 5m close (null when it was not known or is not remembered). */
  regimeAt(ms: number): Regime | null {
    return this.market.regimeAt(ms);
  }

  /** The 15m and 1h changes of character that closed after `from` and by `until`. */
  changesOfCharacter(from: number, until: number) {
    return this.market.changesOfCharacter(from, until);
  }

  /** The setups that the strategies have on the newest 5m candle, with the key of their evidence. */
  candidates(): Candidate[] {
    const view = this.market.view();
    if (view === null) return [];
    const snapshot = view.regime;
    const regime: Regime = snapshot?.regime ?? 'UNCERTAIN';
    const volBucket: VolBucket = snapshot?.volBucket ?? 'NORMAL';
    const session = sessionAt(view.openTime + FIVE_MS);
    const found: Candidate[] = [];
    for (const { spec, runner } of this.runners) {
      const hit = runner.find(snapshot?.regime ?? null);
      if (hit === null) continue;
      const dims: BucketDims = {
        strategyKey: spec.strategyKey,
        strategyVersion: spec.version,
        side: hit.setup.side,
        session,
        regime,
        volBucket,
      };
      found.push({
        spec,
        setup: hit.setup,
        source: hit.source,
        dims,
        sweptLevelId: hit.sweptLevelId,
        structureTarget: hit.structureTarget,
      });
    }
    return found;
  }

  /** The decision for the newest 5m candle on its confirming quote; null before the first candle. */
  decide(
    ctx: DecisionContext,
    evidenceOf: (dims: BucketDims) => ExplanationEvidence,
  ): EngineDecision | null {
    const view = this.market.view();
    if (view === null) return null;
    const decidedAt = view.openTime + FIVE_MS;
    const session = sessionAt(decidedAt);
    const spread = round3(ctx.quote.ask - ctx.quote.bid);
    const calendar = ctx.calendar;

    const proximityOf = (spec: StrategySpec): MacroProximity | null =>
      calendar.available
        ? macroProximity(calendar.events, decidedAt, spec.newsWindow, {
            atrRatio: ratioOf(view.atr5, view.atrBaseline),
            spreadRatio: ratioOf(spread, view.spreadBaseline),
          })
        : null;
    const marketInputs = (spec: StrategySpec): MarketGateInputs => ({
      feed: ctx.feed,
      candles: this.market.counts,
      requiredTimeframes: spec.requiredTimeframes,
      clockSkewMs: ctx.clockSkewMs,
      spread,
      fiveMinuteOpenTimes: view.fiveOpenTimes,
      decisionOpenTime: view.openTime,
    });

    const first = this.runners[0]?.spec;
    const reportProximity = first === undefined ? null : proximityOf(first);
    const marketGates: GateResult[] =
      first === undefined ? [] : [...evaluateGates(marketInputs(first), null, first.gates).results];

    const found = this.candidates();
    const outcomes: Outcome[] = [];
    // A signal made earlier in this pass is open for the next one.
    const open = [...ctx.open];
    for (const candidate of found) {
      const outcome = this.decideOne(candidate, ctx, view, {
        decidedAt,
        session,
        spread,
        open,
        proximity: proximityOf(candidate.spec),
        marketInputs: marketInputs(candidate.spec),
        evidence: evidenceOf(candidate.dims),
      });
      outcomes.push(outcome);
      if (outcome.kind === 'SIGNAL') {
        open.push({ id: `new:${candidate.setup.setupKey}`, side: candidate.setup.side, riskR: 1 });
      }
    }

    return {
      report: {
        openTime: view.openTime,
        decidedAt,
        regime: view.regime?.regime ?? null,
        volBucket: view.regime?.volBucket ?? null,
        session,
        newsState: newsStateOf(reportProximity?.windowActive ?? false, calendar.available),
        atr5: view.atr5,
        counts: this.market.counts,
        marketGates,
        candidates: found.length,
      },
      outcomes,
    };
  }

  private decideOne(
    candidate: Candidate,
    ctx: DecisionContext,
    view: MarketView,
    now: {
      decidedAt: number;
      session: ReturnType<typeof sessionAt>;
      spread: number;
      open: readonly { id: string; side: Side; riskR: number }[];
      proximity: MacroProximity | null;
      marketInputs: MarketGateInputs;
      evidence: ExplanationEvidence;
    },
  ): Outcome {
    const { spec, setup } = candidate;
    const side = setup.side;
    const atr5 = view.atr5;
    const regime: Regime = view.regime?.regime ?? 'UNCERTAIN';
    const volBucket: VolBucket = view.regime?.volBucket ?? 'NORMAL';
    const available = ctx.calendar.available;
    const newsState = newsStateOf(now.proximity?.windowActive ?? false, available);
    const reject = (
      codes: readonly string[],
      qualityScore: number | null,
      detail: Rejection['detail'],
    ): Outcome => ({
      kind: 'REJECTED',
      candidate,
      rejection: {
        strategyKey: spec.strategyKey,
        side,
        setupKey: setup.setupKey,
        codes,
        qualityScore,
        detail,
      },
    });

    // A market without an ATR cannot be planned: the gates say why.
    if (atr5 === null || !(atr5 > 0)) {
      const gates = evaluateGates(now.marketInputs, null, spec.gates);
      return reject([...gates.failed, 'STOP_OK'], null, { reason: 'NO_ATR' });
    }

    const planned = planTrade(
      {
        side,
        decidedAt: now.decidedAt,
        quote: ctx.quote,
        stopLoss: setup.stopLoss,
        atr5,
        structureTarget: candidate.structureTarget,
        minMeasuredMoveR:
          spec.strategyKey === 'pattern_breakout' ? spec.params.minMeasuredMoveR : null,
      },
      spec.risk,
    );
    if (!planned.ok) {
      const gates = evaluateGates(now.marketInputs, null, spec.gates);
      // a target that is too close for the measured move, or that has no time to be reached before the market closes, is a TARGET_OK failure
      const code = planned.reason === 'STOP_NOT_BEYOND_ENTRY' ? 'STOP_OK' : 'TARGET_OK';
      return reject([...gates.failed, code], null, { reason: planned.reason });
    }
    const plan = planned.plan;
    const tp1Distance = Math.abs(plan.tp1 - plan.entry);

    const inputs = qualityInputsOf({
      candidate,
      side,
      view,
      plan,
      session: now.session,
      proximity: now.proximity,
      newsState,
      spread: now.spread,
    });
    const quality = scoreQuality(qualityStrengths(side, inputs), spec.weights);
    const gates = evaluateGates(
      now.marketInputs,
      {
        regime,
        acceptedRegimes: spec.acceptedRegimes,
        atr5,
        stopDistance: plan.riskDistance,
        tp1Distance,
        qualityScore: quality.score,
        qualityCoverage: quality.coverage,
      },
      spec.gates,
    );

    const nearLevel = nearOpposingLevel({
      side,
      entry: plan.entry,
      atr5,
      liquidity: view.liquidity,
      zones: view.zones().map((zone) => ({
        id: zone.id,
        bottom: zone.bottom,
        top: zone.top,
        touches: zone.touches,
      })),
      ...(candidate.sweptLevelId === null ? {} : { sweptLevelId: candidate.sweptLevelId }),
    });
    const flags = evaluateFlags(
      {
        now: now.decidedAt,
        calendar: now.proximity,
        newsShock: newsShockOf({
          inWindow: now.proximity?.windowActive ?? false,
          atr5m: atr5,
          atrBaseline: view.atrBaseline,
          spread: now.spread,
          spreadBaseline: view.spreadBaseline,
        }),
        lastHighHeadlineAt: ctx.news.lastHighHeadlineAt,
      },
      { side, strategyStatus: spec.status, nearLevel, openSignals: now.open },
    );
    const modes = resolveModes(spec.modes, ctx.modes);
    const verdict = decideSetup(gates, flags, modes);

    if (!verdict.allowed) {
      return reject(verdict.rejectionCodes, quality.score, {
        gates: storedGates(gates.results),
        blockedBy: verdict.blockedBy,
        regime,
        session: now.session,
      });
    }

    const eventName = (id: string | undefined): string | null =>
      id === undefined ? null : (ctx.calendar.names?.[id] ?? null);
    const next = now.proximity?.next ?? null;
    const explanation = buildExplanation({
      side,
      strategyVersion: spec.version,
      setup: candidate.source,
      plan,
      quality,
      inputs,
      market: { atr5, spread: now.spread },
      macro: {
        state: newsState,
        next:
          next === null
            ? null
            : { name: eventName(next.id) ?? 'High-impact event', at: next.scheduledAt },
      },
      news: { feed: ctx.news.feed, headlines: [...ctx.news.headlines] },
      flags: flags.filter((flag) => verdict.warnings.includes(flag.flag)),
      warningContext: {
        eventName: eventName(now.proximity?.windowEvent?.id),
        ...(ctx.openLabels === undefined ? {} : { openLabels: ctx.openLabels }),
      },
      open: {
        count: now.open.length,
        riskR: now.open.reduce((sum, item) => sum + item.riskR, 0),
      },
      evidence: now.evidence,
    });

    const draft: EngineSignalDraft = {
      symbol: TRADED_SYMBOL,
      side,
      strategyKey: spec.strategyKey,
      strategyVersion: spec.version,
      exitProfile: plan.exitProfile,
      mode: ctx.mode,
      generatedAt: iso(now.decidedAt),
      sourceAt: iso(ctx.quote.t),
      entry: plan.entry,
      maxValidEntry: plan.maxValidEntry,
      entryValidUntil: iso(plan.entryValidUntil),
      stopLoss: plan.stopLoss,
      tp1: plan.tp1,
      tp2: plan.tp2,
      riskDistance: plan.riskDistance,
      atr5: roundPrice(atr5),
      timeStopAt: iso(plan.timeStopAt),
      regime,
      session: now.session,
      volBucket,
      newsState,
      setupKey: setup.setupKey,
      openSignalsAtEntry: now.open.length,
      warnings: verdict.warnings,
      chartObjects: chartObjectsOf(candidate, plan.entry, view),
      qualityScore: quality.score ?? 0,
      groupedScores: quality.groups.map((group) => ({
        key: group.key,
        state: group.state,
        strength: group.strength,
      })),
      hardGates: storedGates(gates.results),
      explanation,
      evidence: now.evidence,
      dataLatencyMs: ctx.dataLatencyMs,
      featureSnapshot: featureSnapshotOf(view, now.spread, now.proximity),
    };
    return { kind: 'SIGNAL', candidate, draft, plan };
  }
}

/** The numbers behind a decision, kept with the signal for the research phases (docs/02 section 3). `spread` is read back by the review. */
function featureSnapshotOf(
  view: MarketView,
  spread: number,
  proximity: MacroProximity | null,
): Record<string, unknown> {
  const inputs = view.regime?.inputs ?? null;
  return {
    spread,
    close: view.close,
    atr5: view.atr5,
    atr15: view.atr15,
    ema20_1h: view.trend.ema20,
    ema50_1h: view.trend.ema50,
    ema200_1h: view.trend.ema200,
    ema50SlopeAtr1h: view.trend.ema50SlopeAtr,
    adx1h: view.trend.adx,
    plusDI1h: view.trend.plusDI,
    minusDI1h: view.trend.minusDI,
    supertrend1h: view.trend.supertrend,
    rsi5: view.rsi.now,
    macdRun5: view.macdRun,
    state5: view.state5,
    state15: view.state15,
    atrPercentile15: inputs?.atrPercentile15m ?? null,
    squeezeDuration15: inputs?.squeezeDuration ?? null,
    efficiency1h: inputs?.efficiency1h ?? null,
    atrBaseline5: view.atrBaseline,
    spreadBaseline5: view.spreadBaseline,
    spreadPercentile: view.spreadPercentile(spread),
    minutesToNextEvent: proximity?.minutesToNext ?? null,
    minutesSinceLastEvent: proximity?.minutesSinceLast ?? null,
  };
}
