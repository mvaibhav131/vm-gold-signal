import { z } from 'zod';

import { addIssue, epochMs, timestampSchema } from '../primitives';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** RFC 9457 problem details with a stable machine `code` such as `rate_limited` or `snapshot_pruned`. */
export const problemSchema = z.strictObject({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.int().min(400).max(599),
  code: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case code'),
  detail: z.string(),
});
export type Problem = z.infer<typeof problemSchema>;

/** Cursor pagination: `limit` (default 50, max 200) and an opaque `cursor`. */
export const pageQueryShape = {
  limit: z.coerce.number().pipe(z.int().min(1).max(200)).default(50),
  cursor: z.string().min(1).max(512).optional(),
};

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item), nextCursor: z.string().min(1).nullable() });
}

/** A list that is not paginated. */
export function listSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item) });
}

export const rangeShape = {
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
};

export function checkRange(
  ctx: z.core.ParsePayload<{ from?: string | undefined; to?: string | undefined }>,
) {
  const { from, to } = ctx.value;
  if (from !== undefined && to !== undefined && epochMs(from) > epochMs(to)) {
    addIssue(ctx, 'from must not be after to', ['from']);
  }
}

/** A comma separated query value (`overlays=ema20,ema50`) that becomes a list of known values. */
export function csvEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z
    .string()
    .transform((text) => (text === '' ? [] : text.split(',')))
    .pipe(z.array(z.enum(values)));
}
