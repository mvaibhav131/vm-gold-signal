import { describe, expect, it } from 'vitest';

import {
  autopsySchema,
  outcomeSchema,
  signalDraftSchema,
  signalEventSchema,
  signalSchema,
  signalStateSchema,
} from './signal';
import {
  SIGNAL_ID,
  autopsy,
  explanation,
  outcome,
  signal,
  signalDraft,
  signalState,
} from './test-fixtures';

function ok(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) {
  return schema.safeParse(value).success;
}

describe('signalSchema', () => {
  it('round-trips a stored signal through JSON', () => {
    const parsed = signalSchema.parse(signal());
    expect(signalSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(signal());
  });

  it('accepts the draft the worker writes', () => {
    expect(signalDraftSchema.safeParse(signalDraft()).success).toBe(true);
  });

  it('rejects unknown fields (the API never leaks extra data)', () => {
    expect(ok(signalSchema, { ...signal(), extra: 1 })).toBe(false);
    expect(ok(signalSchema, { ...signal(), featureSnapshot: {} })).toBe(false);
  });

  it('rejects another symbol, side or id', () => {
    expect(ok(signalSchema, { ...signal(), symbol: 'EURUSD' })).toBe(false);
    expect(ok(signalSchema, { ...signal(), side: 'HOLD' })).toBe(false);
    expect(ok(signalSchema, { ...signal(), id: 'S-0042' })).toBe(false);
  });

  describe('trade maths', () => {
    it('rejects a BUY whose stop is above entry', () => {
      expect(ok(signalDraftSchema, { ...signalDraft(), stopLoss: 4020, riskDistance: 2.63 })).toBe(
        false,
      );
    });

    it('rejects a BUY whose tp1 is below entry', () => {
      expect(
        ok(signalDraftSchema, {
          ...signalDraft(),
          tp1: 4017,
          tp2: null,
          exitProfile: 'EP2_SINGLE',
        }),
      ).toBe(false);
    });

    it('accepts the mirrored SELL', () => {
      const d = signalDraft();
      const sell = {
        ...d,
        side: 'SELL',
        entry: 4017.2,
        maxValidEntry: 4017.02,
        stopLoss: 4023.67,
        tp1: 4010.73,
        tp2: 4004.26,
        riskDistance: 6.47,
        explanation: {
          ...d.explanation,
          levels: {
            entry: 4017.2,
            maxValidEntry: 4017.02,
            stop: 4023.67,
            tp1: 4010.73,
            tp2: 4004.26,
            riskUsd: 6.47,
          },
        },
      };
      expect(signalDraftSchema.safeParse(sell).success).toBe(true);
    });

    it('rejects a SELL with BUY-side levels', () => {
      expect(ok(signalDraftSchema, { ...signalDraft(), side: 'SELL' })).toBe(false);
    });

    it('rejects a maxValidEntry on the safe side of entry', () => {
      const d = signalDraft();
      expect(
        ok(signalDraftSchema, {
          ...d,
          maxValidEntry: 4017.0,
          explanation: {
            ...d.explanation,
            levels: { ...d.explanation.levels, maxValidEntry: 4017.0 },
          },
        }),
      ).toBe(false);
    });

    it('rejects a riskDistance that differs from |entry - stop|', () => {
      const d = signalDraft();
      expect(
        ok(signalDraftSchema, {
          ...d,
          riskDistance: 5,
          explanation: { ...d.explanation, levels: { ...d.explanation.levels, riskUsd: 5 } },
        }),
      ).toBe(false);
    });

    it('rejects a tp2 before tp1 and a missing tp2 for EP1', () => {
      expect(ok(signalDraftSchema, { ...signalDraft(), tp2: 4020 })).toBe(false);
      expect(ok(signalDraftSchema, { ...signalDraft(), tp2: null })).toBe(false);
    });

    it('rejects a second target on a single-target profile', () => {
      expect(ok(signalDraftSchema, { ...signalDraft(), exitProfile: 'EP2_SINGLE' })).toBe(false);
    });

    it('rejects validity windows that end before the decision', () => {
      expect(
        ok(signalDraftSchema, { ...signalDraft(), entryValidUntil: '2026-10-23T06:09:00Z' }),
      ).toBe(false);
      expect(ok(signalDraftSchema, { ...signalDraft(), timeStopAt: '2026-10-23T06:00:00Z' })).toBe(
        false,
      );
    });
  });

  describe('gates and quality', () => {
    it('rejects a signal while a blocking gate failed', () => {
      const d = signalDraft();
      const hardGates = d.hardGates.map((g) =>
        g.code === 'SPREAD_OK' ? { ...g, passed: false } : g,
      );
      expect(ok(signalDraftSchema, { ...d, hardGates })).toBe(false);
    });

    it('rejects a signal that skipped a gate', () => {
      const d = signalDraft();
      expect(ok(signalDraftSchema, { ...d, hardGates: d.hardGates.slice(1) })).toBe(false);
    });

    it('rejects a signal that skipped a quality group', () => {
      const d = signalDraft();
      expect(ok(signalDraftSchema, { ...d, groupedScores: d.groupedScores.slice(1) })).toBe(false);
    });

    it('rejects a group state that does not match its strength', () => {
      const d = signalDraft();
      const groupedScores = d.groupedScores.map((g, i) => (i === 0 ? { ...g, state: 'FAIL' } : g));
      expect(ok(signalDraftSchema, { ...d, groupedScores })).toBe(false);
    });

    it('rejects a quality score below the lowest grade', () => {
      const d = signalDraft();
      expect(
        ok(signalDraftSchema, {
          ...d,
          qualityScore: 60,
          explanation: { ...d.explanation, quality: { score: 60, grade: 'Moderate' } },
        }),
      ).toBe(false);
    });

    it('rejects an explanation that disagrees with the signal', () => {
      const d = signalDraft();
      expect(
        ok(signalDraftSchema, {
          ...d,
          explanation: { ...explanation(), levels: { ...explanation().levels, stop: 4010 } },
        }),
      ).toBe(false);
      expect(
        ok(signalDraftSchema, {
          ...d,
          explanation: { ...explanation(), quality: { score: 78, grade: 'Very strong' } },
        }),
      ).toBe(false);
    });
  });
});

describe('signalStateSchema', () => {
  it('round-trips', () => {
    expect(signalStateSchema.parse(JSON.parse(JSON.stringify(signalState())))).toEqual(
      signalState(),
    );
  });

  it('ties the TP1 time to the status', () => {
    expect(ok(signalStateSchema, { ...signalState(), tp1HitAt: '2026-10-23T06:15:00Z' })).toBe(
      false,
    );
    expect(ok(signalStateSchema, { ...signalState(), status: 'TP1_HIT' })).toBe(false);
    expect(
      ok(signalStateSchema, {
        ...signalState(),
        status: 'TP1_HIT',
        tp1HitAt: '2026-10-23T06:15:00Z',
      }),
    ).toBe(true);
  });

  it('keeps MFE non-negative and MAE non-positive', () => {
    expect(ok(signalStateSchema, { ...signalState(), mfeR: -0.1 })).toBe(false);
    expect(ok(signalStateSchema, { ...signalState(), maeR: 0.1 })).toBe(false);
  });
});

describe('signalEventSchema', () => {
  it('accepts a known event and rejects an unknown type', () => {
    const e = {
      id: 1,
      signalId: SIGNAL_ID,
      eventType: 'CREATED',
      eventAt: '2026-10-23T06:10:00Z',
      price: null,
      meta: {},
    };
    expect(ok(signalEventSchema, e)).toBe(true);
    expect(ok(signalEventSchema, { ...e, eventType: 'REPAINTED' })).toBe(false);
  });
});

describe('outcomeSchema', () => {
  it('round-trips a win', () => {
    expect(outcomeSchema.parse(JSON.parse(JSON.stringify(outcome())))).toEqual(outcome());
  });

  it('keeps cancelled and invalid outcomes out of the statistics', () => {
    const cancelled = {
      ...outcome(),
      result: 'CANCELLED',
      countsInStats: false,
      realizedRNet: null,
      realizedRGross: null,
      isWin: false,
    };
    expect(ok(outcomeSchema, cancelled)).toBe(true);
    expect(ok(outcomeSchema, { ...cancelled, countsInStats: true })).toBe(false);
    expect(ok(outcomeSchema, { ...outcome(), result: 'DATA_INVALID' })).toBe(false);
  });

  it('requires net R for a counted outcome', () => {
    expect(ok(outcomeSchema, { ...outcome(), realizedRNet: null, isWin: false })).toBe(false);
  });

  it('derives isWin from the sign of net R', () => {
    const loss = {
      ...outcome(),
      result: 'LOSS',
      realizedRNet: -1.04,
      realizedRGross: -1,
      isWin: false,
    };
    expect(ok(outcomeSchema, loss)).toBe(true);
    expect(ok(outcomeSchema, { ...loss, isWin: true })).toBe(false);
    const flatTimeExit = { ...outcome(), result: 'TIME_EXIT', realizedRNet: 0, isWin: false };
    expect(ok(outcomeSchema, flatTimeExit)).toBe(true);
    expect(ok(outcomeSchema, { ...flatTimeExit, isWin: true })).toBe(false);
  });

  it('rejects TP2 without TP1', () => {
    expect(ok(outcomeSchema, { ...outcome(), tp1Hit: false })).toBe(false);
  });
});

describe('autopsySchema', () => {
  it('round-trips a preliminary review', () => {
    expect(autopsySchema.parse(JSON.parse(JSON.stringify(autopsy())))).toEqual(autopsy());
  });

  it('ties finalizedAt to the status', () => {
    expect(ok(autopsySchema, { ...autopsy(), finalizedAt: '2026-10-23T07:30:00Z' })).toBe(false);
    expect(ok(autopsySchema, { ...autopsy(), status: 'FINAL' })).toBe(false);
    expect(
      ok(autopsySchema, { ...autopsy(), status: 'FINAL', finalizedAt: '2026-10-23T07:30:00Z' }),
    ).toBe(true);
  });

  it('requires the primary cause to be one of the causes', () => {
    expect(ok(autopsySchema, { ...autopsy(), primaryCause: 'SPREAD_COST' })).toBe(false);
    expect(ok(autopsySchema, { ...autopsy(), primaryCause: 'BAD_LUCK' })).toBe(false);
  });
});

function reasons(value: unknown): string[] {
  const result = signalDraftSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('signal rejection reasons (each rule fires for its own reason)', () => {
  it('has no reasons for the valid draft', () => {
    expect(reasons(signalDraft())).toEqual([]);
  });

  it('names the stop rule', () => {
    expect(reasons({ ...signalDraft(), stopLoss: 4020, riskDistance: 2.63 })).toContain(
      'stop must be on the losing side of entry',
    );
  });

  it('names the tp1, tp2 and EP rules', () => {
    expect(reasons({ ...signalDraft(), tp1: 4017 })).toContain(
      'tp1 must be on the winning side of entry',
    );
    expect(reasons({ ...signalDraft(), tp2: 4020 })).toContain('tp2 must lie beyond tp1');
    expect(reasons({ ...signalDraft(), tp2: null })).toContain('EP1_PARTIAL needs tp2');
    expect(reasons({ ...signalDraft(), exitProfile: 'EP2_SINGLE' })).toContain(
      'EP2_SINGLE has a single target',
    );
  });

  it('names the riskDistance rule', () => {
    expect(reasons({ ...signalDraft(), riskDistance: 5 })).toContain(
      'riskDistance must equal |entry - stop|',
    );
  });

  it('names the gate rules', () => {
    const d = signalDraft();
    expect(reasons({ ...d, hardGates: d.hardGates.slice(1) })).toContain(
      'every blocking gate must be recorded exactly once',
    );
    const failed = d.hardGates.map((g) => (g.code === 'DATA_FRESH' ? { ...g, passed: false } : g));
    expect(reasons({ ...d, hardGates: failed })).toEqual([
      'a signal cannot exist while a blocking gate failed',
    ]);
  });

  it('names the quality and explanation rules', () => {
    const d = signalDraft();
    expect(reasons({ ...d, qualityScore: 60 })).toContain(
      'quality score is below the lowest grade',
    );
    expect(reasons({ ...d, qualityScore: 80 })).toEqual([
      'explanation quality must equal the signal quality',
    ]);
    expect(
      reasons({
        ...d,
        explanation: { ...d.explanation, levels: { ...d.explanation.levels, tp1: 1 } },
      }),
    ).toEqual(['explanation levels must equal the signal levels']);
  });
});
