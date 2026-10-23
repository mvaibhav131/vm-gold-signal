import { z } from 'zod';

import { timestampSchema } from '../primitives';

export const loginRequestSchema = z.strictObject({
  username: z.string().min(1).max(100),
  // The upper bound keeps an oversized body from reaching the password hash.
  password: z.string().min(1).max(1024),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export const meResponseSchema = z.strictObject({
  username: z.string().min(1),
  totpEnabled: z.boolean(),
  sessionExpiresAt: timestampSchema,
});

export const passwordChangeRequestSchema = z.strictObject({
  current: z.string().min(1).max(1024),
  next: z.string().min(12).max(1024),
});

export const sessionInfoSchema = z.strictObject({
  id: z.string().min(1),
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema,
  expiresAt: timestampSchema,
  current: z.boolean(),
});
