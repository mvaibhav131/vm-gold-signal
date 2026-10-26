import type { SecretHasher } from '../auth/hasher';
import { SECRET_MIN_LENGTH } from '../auth/hasher';
import type { AuthStore } from '../auth/store';

export const CLI_USAGE = [
  'usage: pnpm api:cli <command>',
  '  owner:create <username>   make the owner (asks for the password twice; there is exactly one owner)',
  '  owner:password            set a new password (ends every session)',
  '  owner:totp-off            turn the second step off (lost phone and recovery codes; ends every session)',
  '  owner:status              the user name, whether the second step is on, how many sessions are open',
  '  sessions:revoke-all       end every session',
  '  throttle:reset            forget the failed tries of everybody (lifts a lockout; log in at once from the new place)',
].join('\n');

export interface CliDeps {
  readonly store: AuthStore;
  readonly hasher: SecretHasher;
  readonly now: () => number;
  readonly print: (line: string) => void;
  /** Asks for the password: without an echo at a terminal, the first line of a pipe otherwise. */
  readonly readSecret: (prompt: string) => Promise<string>;
  /** At a terminal the password is asked for twice. */
  readonly interactive: boolean;
}

const USERNAME = /^[A-Za-z0-9._-]{1,100}$/;
const SECRET_MAX_LENGTH = 1024;

/** A password that is long enough, and (at a terminal) typed the same twice. Null when it is not: the reason was printed. */
async function askNewSecret(deps: CliDeps): Promise<string | null> {
  const first = await deps.readSecret('New password: ');
  if (first.length < SECRET_MIN_LENGTH || first.length > SECRET_MAX_LENGTH) {
    deps.print(
      `The password needs ${String(SECRET_MIN_LENGTH)} to ${String(SECRET_MAX_LENGTH)} characters.`,
    );
    return null;
  }
  if (deps.interactive) {
    const second = await deps.readSecret('Again: ');
    if (second !== first) {
      deps.print('The two passwords are not the same.');
      return null;
    }
  }
  return first;
}

/**
 * The commands that are run on the server by whoever has the server (06 section 4): they are the only way to make the
 * owner or to get back in, because the API has no registration and no "forgot password". Nothing here prints a password,
 * a hash or a secret. Returns the exit code: 0 done, 1 not possible in this state, 2 wrong use.
 */
export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = args;
  const now = deps.now();

  switch (command) {
    case 'owner:create': {
      const [username] = rest;
      if (username === undefined || rest.length !== 1 || !USERNAME.test(username)) {
        deps.print('owner:create needs one user name of letters, digits, . _ - (at most 100).');
        return 2;
      }
      if ((await deps.store.owner()) !== null) {
        deps.print('There is an owner already. Use owner:password to set a new password.');
        return 1;
      }
      const secret = await askNewSecret(deps);
      if (secret === null) return 2;
      const created = await deps.store.createOwner(username, await deps.hasher.hash(secret), now);
      if (!created) {
        deps.print('There is an owner already. Use owner:password to set a new password.');
        return 1;
      }
      await deps.store.audit(
        { type: 'OWNER_CREATED', success: true, ipHash: null, detail: { via: 'cli' } },
        now,
      );
      deps.print(`The owner "${username}" was made.`);
      return 0;
    }

    case 'owner:password': {
      if ((await deps.store.owner()) === null) {
        deps.print('There is no owner yet. Use owner:create first.');
        return 1;
      }
      const secret = await askNewSecret(deps);
      if (secret === null) return 2;
      await deps.store.setPasswordHash(await deps.hasher.hash(secret), now);
      const ended = await deps.store.revokeAllExcept(null, now);
      await deps.store.audit(
        {
          type: 'PASSWORD_CHANGED',
          success: true,
          ipHash: null,
          detail: { via: 'cli', sessionsEnded: ended },
        },
        now,
      );
      deps.print(`The password was changed. ${String(ended)} session(s) ended.`);
      return 0;
    }

    case 'owner:totp-off': {
      const owner = await deps.store.owner();
      if (owner === null) {
        deps.print('There is no owner yet.');
        return 1;
      }
      await deps.store.disableTotp();
      const ended = await deps.store.revokeAllExcept(null, now);
      await deps.store.audit(
        {
          type: 'TOTP_DISABLED',
          success: true,
          ipHash: null,
          detail: { via: 'cli', sessionsEnded: ended },
        },
        now,
      );
      deps.print(`The second step is off. ${String(ended)} session(s) ended.`);
      return 0;
    }

    case 'owner:status': {
      const owner = await deps.store.owner();
      if (owner === null) {
        deps.print('There is no owner yet. Use owner:create <username>.');
        return 1;
      }
      const open = await deps.store.sessions(now);
      deps.print(`owner: ${owner.username}`);
      deps.print(`second step: ${owner.totpEnabled ? 'on' : 'off'}`);
      deps.print(`recovery codes left: ${String(owner.recoveryCodeHashes.length)}`);
      deps.print(`sessions open: ${String(open.length)}`);
      return 0;
    }

    case 'sessions:revoke-all': {
      const ended = await deps.store.revokeAllExcept(null, now);
      await deps.store.audit(
        {
          type: 'SESSIONS_REVOKED_ALL',
          success: true,
          ipHash: null,
          detail: { via: 'cli', sessionsEnded: ended },
        },
        now,
      );
      deps.print(`${String(ended)} session(s) ended.`);
      return 0;
    }

    case 'throttle:reset': {
      // The way back in when somebody keeps the global failure limit full on purpose and the owner is at a place that
      // has never got in (a new phone, a new network). Only the failed tries are forgotten: the clients that got in stay
      // known. The first login from the new place makes it known, and then the limit no longer applies to it.
      const cleared = await deps.store.clearFailures();
      await deps.store.audit(
        { type: 'THROTTLE_RESET', success: true, ipHash: null, detail: { via: 'cli', cleared } },
        now,
      );
      deps.print(`${String(cleared)} failed try(s) forgotten. Log in now.`);
      return 0;
    }

    case undefined:
    default:
      deps.print(CLI_USAGE);
      return 2;
  }
}
