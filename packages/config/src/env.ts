import { FEED_PROVIDERS, TRADED_SYMBOL } from '@vmgs/core';
import { feedSymbolSchema } from '@vmgs/contracts';
import { z } from 'zod';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/** Each process connects with its own least-privilege role (01_HLD section 8). */
function postgresUrl(role: string) {
  return (
    z
      .url({ protocol: /^postgres(ql)?$/ })
      // An unparsable URL is already reported by the format check above, so it passes here.
      .refine(
        (value) => !URL.canParse(value) || new URL(value).username === role,
        `must connect as database role ${role}`,
      )
  );
}

const publicHost = z.hostname();

const telegramBotToken = z
  .string()
  .regex(/^\d{6,12}:[A-Za-z0-9_-]{30,}$/, 'not a Telegram bot token (from @BotFather)');

/** 32 random bytes as base64 (44 characters) or hex (64 characters). */
const encryptionKey = z
  .string()
  .regex(/^([A-Za-z0-9+/]{43}=|[0-9a-fA-F]{64})$/, 'must be 32 random bytes as base64 or hex');

const vapidPublicKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{87}$/, 'VAPID public key (87 base64url characters)');
const vapidPrivateKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'VAPID private key (43 base64url characters)');
const vapidSubject = z
  .string()
  .regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, 'VAPID subject must be mailto: or https:');

const baseShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // 01_HLD section 8: TLS verification is never disabled, not even in development.
  NODE_TLS_REJECT_UNAUTHORIZED: z
    .string()
    .optional()
    .refine((value) => value !== '0', 'TLS verification must not be disabled'),
};

/** Environment of the `api` process. */
export const apiEnvSchema = z.object({
  ...baseShape,
  PUBLIC_HOST: publicHost,
  API_PORT: z.coerce.number().pipe(z.int().min(1).max(65535)).default(3000),
  DATABASE_URL_API: postgresUrl('vmgs_api'),
  APP_ENCRYPTION_KEY: encryptionKey,
  VAPID_PUBLIC_KEY: vapidPublicKey.optional(),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** Environment of the `worker` process. Web Push needs all three VAPID values or none. */
export const workerEnvSchema = z
  .object({
    ...baseShape,
    PUBLIC_HOST: publicHost,
    DATABASE_URL_WORKER: postgresUrl('vmgs_worker'),
    // No default on purpose: a wrong provider would silently turn live data into replay or the reverse.
    FEED_PROVIDER: z.enum(FEED_PROVIDERS),
    FEED_SYMBOLS: z
      .string()
      .default(`${TRADED_SYMBOL},DXY,XAGUSD`)
      .transform((text) => text.split(',').map((symbol) => symbol.trim()))
      .pipe(z.array(feedSymbolSchema).min(1))
      .refine((symbols) => new Set(symbols).size === symbols.length, 'duplicate symbol')
      .refine((symbols) => symbols.includes(TRADED_SYMBOL), `must include ${TRADED_SYMBOL}`),
    TELEGRAM_BOT_TOKEN: telegramBotToken.optional(),
    VAPID_PUBLIC_KEY: vapidPublicKey.optional(),
    VAPID_PRIVATE_KEY: vapidPrivateKey.optional(),
    VAPID_SUBJECT: vapidSubject.optional(),
    HEALTHCHECKS_PING_URL: z.url({ protocol: /^https$/ }).optional(),
  })
  .check((ctx) => {
    const vapid = [
      ctx.value.VAPID_PUBLIC_KEY,
      ctx.value.VAPID_PRIVATE_KEY,
      ctx.value.VAPID_SUBJECT,
    ];
    const present = vapid.filter((value) => value !== undefined).length;
    if (present !== 0 && present !== vapid.length) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together, or none',
        path: ['VAPID_PUBLIC_KEY'],
      });
    }
  });
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Environment of the research tools (`tools/research`): they write history with the rights of the worker role. */
export const researchEnvSchema = z.object({
  ...baseShape,
  DATABASE_URL_WORKER: postgresUrl('vmgs_worker'),
});
export type ResearchEnv = z.infer<typeof researchEnvSchema>;

/** A role password made by `openssl rand -hex 24`: it goes into a URL, so it has no character that needs escaping. */
const rolePassword = z
  .string()
  .regex(/^[A-Za-z0-9_-]{24,128}$/, 'at least 24 letters, digits, _ or - (openssl rand -hex 24)');

/**
 * Environment of the deploy step that migrates the schema and gives the application roles their passwords (B31).
 * It connects as the schema owner, so it is the only process that holds that URL. The password of a role that is
 * not set is not touched, so the api role can be set when the api is deployed.
 */
export const adminEnvSchema = z.object({
  DATABASE_URL_ADMIN: z.url({ protocol: /^postgres(ql)?$/ }),
  DB_PASSWORD_WORKER: rolePassword,
  DB_PASSWORD_API: rolePassword.optional(),
  DB_PASSWORD_BACKUP: rolePassword.optional(),
});
export type AdminEnv = z.infer<typeof adminEnvSchema>;

/** Variables read by the backup scripts; validated by the CLI before a backup runs. */
export const backupEnvSchema = z.object({
  DATABASE_URL_BACKUP: postgresUrl('vmgs_backup'),
  BACKUP_AGE_RECIPIENT: z
    .string()
    .regex(/^age1[a-z0-9]{58}$/, 'must be an age public key (age1...)'),
  BACKUP_RCLONE_REMOTE: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+:\S*$/, 'must look like remote:bucket/path'),
  // Healthchecks.io checks of the backup and of the restore drill (a failed run pings /fail, a missed one alerts).
  HEALTHCHECKS_BACKUP_URL: z.url({ protocol: /^https$/ }).optional(),
  HEALTHCHECKS_DRILL_URL: z.url({ protocol: /^https$/ }).optional(),
});
export type BackupEnv = z.infer<typeof backupEnvSchema>;

export class EnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid environment:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
    this.name = 'EnvError';
    this.problems = problems;
  }
}

/**
 * Validates an environment. Empty values count as unset (a `.env` line like `VAR=`).
 * Problems name the variable and the rule, never the value, so secrets cannot leak into logs.
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Readonly<Record<string, string | undefined>>,
): z.output<S> {
  const filtered = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = schema.safeParse(filtered);
  if (result.success) return result.data;
  throw new EnvError(
    result.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '(env)'}: ${issue.message}`,
    ),
  );
}
