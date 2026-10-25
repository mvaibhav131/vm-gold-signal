import { describe, expect, it } from 'vitest';

import { DECIDED_AT } from '../trade/test-data';
import {
  RESULT_TTL_SEC,
  messageTtlSec,
  pushCancelled,
  pushClosed,
  pushFinalReview,
  pushNewSignal,
  pushTp1,
  signalEventKey,
} from './push';
import {
  BUY_SIGNAL,
  DATA_INVALID,
  EXPLANATION,
  FINAL_REVIEW,
  LOSS,
  MINUTE,
  PARTIAL,
  SELL_EXPLANATION,
  SELL_SIGNAL,
  SIGNAL_ID,
  TIME_EXIT,
  WIN_TARGET,
  WIN_TP2,
  newSignal,
} from './test-data';
import { cancelledOutcome } from '../trade/tracker';
import type { DisplayOptions } from './types';

const IST: DisplayOptions = { locale: 'en', displayTz: 'Asia/Kolkata' };

describe('the push of a new signal (04 section 5)', () => {
  it('has the direction, the number and the grade in the title, the levels in the body', () => {
    expect(pushNewSignal(newSignal())).toEqual({
      kind: 'SIGNAL_NEW',
      title: 'BUY XAUUSD #S-0042 (Very strong 95)',
      body: 'Entry 4017.370, stop 4010.900, TP1 4023.840, TP2 4030.310',
      url: `/signals/${SIGNAL_ID}`,
      ttlSec: 180,
      urgency: 'high',
      tag: `signal:${SIGNAL_ID}:confirmed`,
    });
  });

  it('has no TP2 for a single target, and the SELL levels as they are', () => {
    const single = { ...BUY_SIGNAL, tp2: null };
    expect(pushNewSignal({ signal: single, explanation: EXPLANATION }).body).toBe(
      'Entry 4017.370, stop 4010.900, TP1 4023.840',
    );
    const sell = pushNewSignal(newSignal(SELL_SIGNAL, SELL_EXPLANATION));
    expect(sell.title).toBe('SELL XAUUSD #S-0043 (Very strong 95)');
    expect(sell.body).toBe('Entry 3982.630, stop 4000.000, TP1 3965.260, TP2 3947.890');
  });

  it('lives as long as the entry is valid, so that a late push never invites a late entry', () => {
    const short = { ...BUY_SIGNAL, entryValidUntil: DECIDED_AT + 90_000 };
    expect(pushNewSignal({ signal: short, explanation: EXPLANATION }).ttlSec).toBe(90);
  });
});

describe('the pushes of the results', () => {
  it('TP1 asks for the action', () => {
    const push = pushTp1({ signal: BUY_SIGNAL, at: DECIDED_AT + 6 * MINUTE, price: 4023.84 }, IST);
    expect(push).toEqual({
      kind: 'SIGNAL_TP1',
      title: 'TP1 HIT #S-0042 +1.00R',
      body: 'Price 4023.840 at 11:41 IST. Close half, move stop to entry 4017.370',
      url: `/signals/${SIGNAL_ID}`,
      ttlSec: RESULT_TTL_SEC,
      urgency: 'high',
      tag: `signal:${SIGNAL_ID}:tp1`,
    });
  });

  it('a win, a partial win, a loss and a time exit have the result and the net R in the title', () => {
    const closed = (outcome: Parameters<typeof pushClosed>[0]['outcome'], signal = BUY_SIGNAL) =>
      pushClosed({ signal, outcome, review: null }, IST);
    expect(closed(WIN_TP2)).toEqual({
      kind: 'SIGNAL_CLOSED',
      title: 'WIN #S-0042 +1.47R',
      body: 'TP2 4030.310 at 12:12 IST, 37 min',
      url: `/signals/${SIGNAL_ID}`,
      ttlSec: RESULT_TTL_SEC,
      urgency: 'normal',
      tag: `signal:${SIGNAL_ID}:closed`,
    });
    expect(closed(WIN_TARGET).body).toBe('target 4027.075 at 12:00 IST, 25 min');
    expect(closed(PARTIAL)).toMatchObject({
      title: 'PARTIAL WIN #S-0042 +0.46R',
      body: 'stopped at entry 4017.370 at 12:05 IST, 30 min',
    });
    expect(closed(LOSS)).toMatchObject({
      title: 'LOSS #S-0042 -1.04R',
      body: 'stop 4010.900 at 11:50 IST, 15 min',
    });
    expect(closed(TIME_EXIT)).toMatchObject({
      title: 'TIME EXIT #S-0042 -0.18R',
      body: 'time stop, price 4015.400 at 13:35 IST, 2 h',
    });
  });

  it('a data gap is not counted and asks the owner to manage the trade', () => {
    expect(
      pushClosed({ signal: BUY_SIGNAL, outcome: DATA_INVALID, review: null }, IST),
    ).toMatchObject({
      title: 'DATA INVALID #S-0042',
      body: 'Feed gap during the trade: not counted. Manage it manually if you are still in.',
      tag: `signal:${SIGNAL_ID}:closed`,
    });
    // whatever else the record carries, a data gap is a data gap
    const odd = { ...DATA_INVALID, realizedRNet: -0.5, exitPrice: 4010 };
    expect(pushClosed({ signal: BUY_SIGNAL, outcome: odd, review: null }, IST).title).toBe(
      'DATA INVALID #S-0042',
    );
  });

  it('refuses a counted result that has no net R or no exit price', () => {
    expect(() =>
      pushClosed(
        { signal: BUY_SIGNAL, outcome: { ...LOSS, realizedRNet: null }, review: null },
        IST,
      ),
    ).toThrow(RangeError);
    expect(() =>
      pushClosed({ signal: BUY_SIGNAL, outcome: { ...LOSS, exitPrice: null }, review: null }, IST),
    ).toThrow(RangeError);
  });

  it('a cancelled signal has its own push', () => {
    expect(() =>
      pushClosed(
        { signal: BUY_SIGNAL, outcome: cancelledOutcome(DECIDED_AT + MINUTE), review: null },
        IST,
      ),
    ).toThrow(RangeError);
    expect(pushCancelled({ signal: BUY_SIGNAL, staleSeconds: 40 })).toEqual({
      kind: 'SIGNAL_CANCELLED',
      title: 'CANCELLED #S-0042',
      body: 'Market data went stale before the entry. Not counted. Manage it manually if you entered.',
      url: `/signals/${SIGNAL_ID}`,
      ttlSec: RESULT_TTL_SEC,
      urgency: 'normal',
      tag: `signal:${SIGNAL_ID}:closed`,
    });
  });

  it('the final review names the cause', () => {
    expect(
      pushFinalReview({
        signal: BUY_SIGNAL,
        review: FINAL_REVIEW,
        previousPrimary: null,
        trackedThisMonth: null,
      }),
    ).toEqual({
      kind: 'SIGNAL_REVIEW_FINAL',
      title: 'FINAL REVIEW #S-0042',
      body: 'Cause: STOP_HUNT_REVERSAL (Setup failure)',
      url: `/signals/${SIGNAL_ID}`,
      ttlSec: RESULT_TTL_SEC,
      urgency: 'normal',
      tag: `signal:${SIGNAL_ID}:review`,
    });
  });
});

describe('event keys and lifetimes (04 sections 4 and 6)', () => {
  it('builds the key of each step of a signal', () => {
    expect(signalEventKey('abc', 'confirmed')).toBe('signal:abc:confirmed');
    expect(signalEventKey('abc', 'tp1')).toBe('signal:abc:tp1');
    expect(signalEventKey('abc', 'closed')).toBe('signal:abc:closed');
    expect(signalEventKey('abc', 'review')).toBe('signal:abc:review');
  });

  it('keeps an entry alert for the entry validity and the others for 6 hours', () => {
    expect(RESULT_TTL_SEC).toBe(21_600);
    expect(messageTtlSec('SIGNAL_NEW', 180)).toBe(180);
    expect(messageTtlSec('SIGNAL_NEW', 45)).toBe(45);
    for (const kind of [
      'SIGNAL_TP1',
      'SIGNAL_CLOSED',
      'SIGNAL_CANCELLED',
      'SIGNAL_REVIEW_FINAL',
    ] as const) {
      expect(messageTtlSec(kind, 180), kind).toBe(21_600);
    }
  });
});
