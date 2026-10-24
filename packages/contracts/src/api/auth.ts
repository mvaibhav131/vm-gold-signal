import { z } from 'zod';

import { addIssue, timestampSchema } from '../primitives';
import { listSchema } from './common';

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

/** The new password needs at least 12 characters; the API never says which of the two was wrong. */
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

/** GET /auth/sessions: the sessions that are valid now, the current one first. */
export const sessionsResponseSchema = listSchema(sessionInfoSchema).check((ctx) => {
  if (ctx.value.items.filter((session) => session.current).length > 1) {
    addIssue(ctx, 'only one session is the current one', ['items']);
  }
});

/** POST /auth/totp/setup: the secret is shown once, with the link that an authenticator app reads. */
export const totpSetupResponseSchema = z.strictObject({
  secret: z.string().regex(/^[A-Z2-7]{16,64}$/, 'base32 secret'),
  otpauthUrl: z.string().regex(/^otpauth:\/\/totp\//, 'otpauth link'),
});

/** POST /auth/totp/enable and /disable: the code of the authenticator app. */
export const totpCodeRequestSchema = z.strictObject({ code: z.string().regex(/^\d{6}$/) });

/** POST /auth/totp/enable answers with the recovery codes, shown once (only their hashes are stored). */
export const totpEnableResponseSchema = z.strictObject({
  recoveryCodes: z.array(z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/)).length(8),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;
export type TotpCodeRequest = z.infer<typeof totpCodeRequestSchema>;
export type TotpEnableResponse = z.infer<typeof totpEnableResponseSchema>;
