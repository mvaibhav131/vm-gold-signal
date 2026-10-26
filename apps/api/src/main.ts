import { apiEnvSchema, parseEnv, siteOriginOf } from '@vmgs/config';
import { createPool, loadMigrations } from '@vmgs/db';

import { buildApp } from './app';
import { SecretHasher, PRODUCTION_ARGON } from './auth/hasher';
import { deriveKeys, parseMasterKey } from './auth/keys';
import { Limiter } from './auth/limiter';
import { PostgresAuthStore } from './auth/postgresStore';
import { AuthPurge } from './auth/purge';
import { AuthService } from './auth/service';
import { apiLoggerOptions } from './logging';
import { registerApiRoutes } from './routes';

type Level = 'info' | 'error';

function log(level: Level, message: string, details: Record<string, unknown> = {}): void {
  const output = level === 'error' ? process.stderr : process.stdout;
  output.write(`${JSON.stringify({ at: new Date().toISOString(), level, message, ...details })}\n`);
}

async function main(): Promise<void> {
  const env = parseEnv(apiEnvSchema, process.env);
  // one connection always listens to the worker (the stream); the rest serve the requests, the stream's looks and the auth
  const pool = createPool(env.DATABASE_URL_API, { max: 10 });
  const store = new PostgresAuthStore(pool);
  const service = new AuthService({
    store,
    // two password checks at a time and eight waiting: more would need more memory than the VM can spare
    hasher: new SecretHasher(PRODUCTION_ARGON, new Limiter(2, 8)),
    keys: deriveKeys(parseMasterKey(env.APP_ENCRYPTION_KEY)),
    now: Date.now,
  });

  const expectedMigration = (await loadMigrations()).length;

  const app = await buildApp({
    service,
    siteOrigin: siteOriginOf(env),
    trustedProxyHops: env.API_TRUSTED_PROXY_HOPS,
    routes: (instance) => {
      registerApiRoutes(instance, { pool, now: Date.now, expectedMigration, log });
    },
    logger: apiLoggerOptions(env.LOG_LEVEL),
  });
  const purge = new AuthPurge({ store, log });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log('info', 'the api is stopping', { signal });
    purge.stop();
    void app
      .close()
      .then(() => pool.end())
      .then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          log('error', 'the api did not stop cleanly', {
            error: error instanceof Error ? error.message : String(error),
          });
          process.exitCode = 1;
        },
      );
  };
  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });

  if ((await store.owner()) === null) {
    log(
      'info',
      'there is no owner yet: make one on the server with `pnpm api:cli owner:create <name>`',
    );
  }
  // the hash that a login for an unknown user is checked against: ready before the first request
  await service.warmUp();
  await app.listen({ host: '0.0.0.0', port: env.API_PORT });
  purge.start();
  log('info', 'the api is listening', {
    port: env.API_PORT,
    siteOrigin: siteOriginOf(env),
    trustedProxyHops: env.API_TRUSTED_PROXY_HOPS,
  });
}

void main().catch((error: unknown) => {
  log('error', 'the api could not start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
