import {
  displayOptionsOf,
  systemChannels,
  systemOutboxRows,
  testEventKey,
  testMessage,
  type AlertSettings,
} from '@vmgs/core';

import type { OutboxStore } from '../alerts/store';
import type { BotStore } from '../telegram/botStore';
import type { TelegramClient } from '../telegram/client';
import { formatLinkCode, issueLink, LINK_MAX_ATTEMPTS, newLinkCode } from '../telegram/link';

export interface LinkCommandDeps {
  readonly store: Pick<BotStore, 'setPendingLink'>;
  readonly client: Pick<TelegramClient, 'getMe'>;
  readonly now: number;
  readonly print: (line: string) => void;
  /** A fixed code, for tests. */
  readonly code?: string;
}

/**
 * `pnpm cli telegram:link`: asks Telegram who the bot is (so a wrong token is found now, not after
 * ten minutes), keeps a hash of a new one-time code, and prints the code and what to send.
 * Returns the code.
 */
export async function telegramLink(deps: LinkCommandDeps): Promise<string> {
  const me = await deps.client.getMe();
  const code = deps.code ?? newLinkCode();
  await deps.store.setPendingLink(issueLink(code, deps.now));
  const shown = formatLinkCode(code);
  deps.print(`One-time code: ${shown}`);
  deps.print(
    `It works once, for 10 minutes, and after ${String(LINK_MAX_ATTEMPTS)} wrong tries it is void.`,
  );
  deps.print(
    me.username === null
      ? `Open your bot in Telegram and send: /link ${shown}`
      : `Open https://t.me/${me.username} and send: /link ${shown}`,
  );
  return code;
}

export interface TestCommandDeps {
  readonly outbox: Pick<OutboxStore, 'enqueue'>;
  readonly settings: AlertSettings;
  readonly now: number;
  readonly id: string;
  readonly print: (line: string) => void;
}

/**
 * `pnpm cli telegram:test`: queues the TEST message in the outbox, so it goes the whole way a
 * signal goes: the running worker sends it. Returns how many channels it was queued for.
 */
export async function telegramTest(deps: TestCommandDeps): Promise<number> {
  const channels = systemChannels(deps.settings, 'TEST');
  if (channels.length === 0) {
    deps.print('No channel is switched on in the settings, so nothing was queued.');
    return 0;
  }
  const rows = systemOutboxRows(
    testMessage(deps.now, displayOptionsOf(deps.settings)),
    testEventKey(deps.id),
    channels,
    deps.now,
  );
  await deps.outbox.enqueue(rows, deps.now);
  deps.print(
    `Test message queued for ${channels.join(' and ')}. The worker sends it within a few seconds (it must be running).`,
  );
  return channels.length;
}
