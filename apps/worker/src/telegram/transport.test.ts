import { describe, expect, it } from 'vitest';

import { TelegramApiError } from './client';
import { TelegramTransport } from './transport';

class Clock {
  now = 1_000_000;
  advance(ms: number): void {
    this.now += ms;
  }
}

function setup(minGapMs = 1000) {
  const clock = new Clock();
  const sent: { chatId: number | string; text: string; at: number }[] = [];
  const script: (Error | 'ok')[] = [];
  const client = {
    sendMessage: (chatId: number | string, text: string) => {
      const step = script.shift() ?? 'ok';
      if (step !== 'ok') return Promise.reject(step);
      sent.push({ chatId, text, at: clock.now });
      return Promise.resolve({ messageId: sent.length });
    },
  };
  const slept: number[] = [];
  const transport = new TelegramTransport({
    client,
    minGapMs,
    now: () => clock.now,
    sleep: (ms) => {
      slept.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
  });
  return { clock, sent, script, transport, slept };
}

describe('TelegramTransport', () => {
  it('is ready at first, takes its slot when it sends, and is ready again after the gap', async () => {
    const { clock, sent, transport } = setup();
    expect(transport.waitMs()).toBe(0);
    expect(await transport.send(1, 'a')).toEqual({ messageId: 1 });
    expect(transport.waitMs()).toBe(1000);
    clock.advance(400);
    expect(transport.waitMs()).toBe(600);
    clock.advance(600);
    expect(transport.waitMs()).toBe(0);
    await transport.send(1, 'b');
    expect(sent.map((item) => item.text)).toEqual(['a', 'b']);
  });

  it('the slot is taken before the call goes out, so a second caller sees the wait at once', async () => {
    const clock = new Clock();
    let release: () => void = () => undefined;
    const transport = new TelegramTransport({
      client: {
        sendMessage: () =>
          new Promise((resolve) => {
            release = () => {
              resolve({ messageId: 1 });
            };
          }),
      },
      now: () => clock.now,
    });
    const first = transport.send(1, 'a');
    expect(transport.waitMs()).toBe(1000);
    release();
    await first;
  });

  it('a failed send still counts for the gap, and a 429 closes the transport for the time asked', async () => {
    const { clock, script, transport } = setup();
    script.push(new Error('boom'));
    await expect(transport.send(1, 'a')).rejects.toThrow('boom');
    expect(transport.waitMs()).toBe(1000);
    clock.advance(1000);
    script.push(new TelegramApiError('slow down', 'api', 429, 429, 30));
    await expect(transport.send(1, 'b')).rejects.toThrow('slow down');
    expect(transport.waitMs()).toBe(30_000);
    clock.advance(29_999);
    expect(transport.waitMs()).toBe(1);
    // a 429 without a wait means one second; other API errors do not close it
    clock.advance(1);
    script.push(new TelegramApiError('slow down', 'api', 429, 429, null));
    await expect(transport.send(1, 'c')).rejects.toThrow();
    expect(transport.waitMs()).toBe(1000);
    clock.advance(1000);
    script.push(new TelegramApiError('bad', 'api', 400, 400, null));
    await expect(transport.send(1, 'd')).rejects.toThrow('bad');
    expect(transport.waitMs()).toBe(1000);
  });

  it('a short 429 does not shorten the gap that was already taken', async () => {
    const { script, transport } = setup(5000);
    script.push(new TelegramApiError('slow down', 'api', 429, 429, 1));
    await expect(transport.send(1, 'a')).rejects.toThrow();
    expect(transport.waitMs()).toBe(5000);
  });

  it('sendWhenReady waits for its turn and then sends', async () => {
    const { clock, sent, transport, slept } = setup();
    await transport.send(1, 'first');
    const start = clock.now;
    await transport.sendWhenReady(1, 'second');
    expect(slept).toEqual([1000]);
    expect(sent.map((item) => item.text)).toEqual(['first', 'second']);
    expect(sent[1]?.at).toBe(start + 1000);
    // with no wait it sends at once
    clock.advance(5000);
    await transport.sendWhenReady(1, 'third');
    expect(slept).toEqual([1000]);
  });

  it('a gap of zero never waits, and a bad gap is refused', async () => {
    const { transport, sent } = setup(0);
    await transport.send(1, 'a');
    await transport.send(1, 'b');
    expect(transport.waitMs()).toBe(0);
    expect(sent).toHaveLength(2);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new TelegramTransport({
            client: { sendMessage: () => Promise.resolve({ messageId: 1 }) },
            minGapMs: bad,
          }),
      ).toThrow(RangeError);
    }
  });

  it('uses the real clock and the real sleep by default', async () => {
    const calls: string[] = [];
    const transport = new TelegramTransport({
      client: {
        sendMessage: (_chat, text) => {
          calls.push(text);
          return Promise.resolve({ messageId: 1 });
        },
      },
      minGapMs: 30,
    });
    const started = Date.now();
    await transport.sendWhenReady(1, 'a');
    await transport.sendWhenReady(1, 'b');
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(calls).toEqual(['a', 'b']);
  });
});
