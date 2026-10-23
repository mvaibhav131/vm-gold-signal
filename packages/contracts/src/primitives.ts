import { TRADED_SYMBOL } from '@vmgs/core';
import { z } from 'zod';

const DECIMAL_TOLERANCE = 1e-6;

export function hasAtMostDecimals(value: number, decimals: number): boolean {
  const scale = 10 ** decimals;
  return Math.abs(value * scale - Math.round(value * scale)) < DECIMAL_TOLERANCE;
}

function decimalNumber(decimals: number) {
  return z
    .number()
    .refine((value) => hasAtMostDecimals(value, decimals), `at most ${String(decimals)} decimals`);
}

/** Records a validation problem from inside `.check()`. */
export function addIssue(ctx: z.core.ParsePayload, message: string, path: PropertyKey[] = []) {
  ctx.issues.push({ code: 'custom', input: ctx.value, message, path });
}

/** ISO 8601 in UTC (`...Z`). Offsets are rejected on purpose: everything is stored and sent in UTC. */
export const timestampSchema = z.iso.datetime();

export const uuidSchema = z.uuid();

export const symbolSchema = z.literal(TRADED_SYMBOL);

/** Any symbol the feed subscribes to (XAUUSD plus cross-asset context such as DXY). */
export const feedSymbolSchema = z.string().regex(/^[A-Z0-9]{3,12}$/, 'upper-case symbol');

/** Prices have at most 3 decimals (numeric(12,3) in the database). */
export const priceSchema = decimalNumber(3).pipe(z.number().positive());

export const spreadSchema = decimalNumber(3).pipe(z.number().nonnegative());

/** R multiples in API payloads: 2 decimals. */
export const r2Schema = decimalNumber(2);

/** R multiples as stored (numeric(8,3)). */
export const r3Schema = decimalNumber(3);

/** Quality score, 0 to 100 with 2 decimals (numeric(5,2)). */
export const scoreSchema = decimalNumber(2).pipe(z.number().min(0).max(100));

/** A share between 0 and 1 (win rate, TP rate). */
export const fractionSchema = z.number().min(0).max(1);

export const countSchema = z.int().nonnegative();

export const ci95Schema = z
  .tuple([fractionSchema, fractionSchema])
  .refine(([low, high]) => low <= high, 'interval bounds are ordered');

export const jsonRecordSchema = z.record(z.string(), z.json());

export const setupKeySchema = z.string().min(1).max(200);

export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'x.y.z version');

export function epochMs(timestamp: string): number {
  return Date.parse(timestamp);
}
