import net from 'node:net';

import { describe, expect, it } from 'vitest';

import { makeHarness, type Harness } from '../testing/harness';
import { isEvent, listenOnFreePort, openStream } from '../testing/sseClient';
import { EventHub } from './hub';
import { registerStreamRoutes, type StreamDeps } from './routes';

const ID_A = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10';

async function setup(deps: Partial<StreamDeps> = {}) {
  const hub = new EventHub('boot');
  const h: Harness = await makeHarness({
    routes: (app) => {
      registerStreamRoutes(app, { hub, heartbeatMs: 40, revalidateMs: 40, ...deps });
    },
  });
  const port = await listenOnFreePort(h.app);
  const cookie = await h.login();
  return { h, hub, port, cookie };
}

const publish = (hub: EventHub, id = ID_A) => hub.publish({ event: 'signal', data: { id } });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GET /stream', () => {
  it('is refused without a session, as problem+json, like every route', async () => {
    const { h, port } = await setup();
    const none = await openStream(port);
    expect(none.status).toBe(401);
    expect(String(none.headers['content-type'])).toContain('application/problem+json');
    const bad = await openStream(port, { cookie: 'x'.repeat(43) });
    expect(bad.status).toBe(401);
    await h.app.close();
  });

  it('opens an event stream with the headers a proxy needs, and tells the browser when to come back', async () => {
    const { h, port, cookie } = await setup();
    const stream = await openStream(port, { cookie });
    expect(stream.status).toBe(200);
    expect(String(stream.headers['content-type'])).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers['cache-control']).toBe('no-store');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    // the headers of every answer are on this one too
    expect(stream.headers['x-content-type-options']).toBe('nosniff');
    expect(stream.headers['access-control-allow-origin']).toBeUndefined();
    const first = await stream.next();
    expect(first.retry).toBe(3000);
    stream.close();
    await h.app.close();
  });

  it('sends what happens, with ids, and the quotes without', async () => {
    const { h, hub, port, cookie } = await setup();
    const stream = await openStream(port, { cookie });
    await stream.next((frame) => frame.retry !== null);
    publish(hub);
    hub.quote({
      event: 'quote',
      data: { bid: 4017.3, ask: 4017.5, spread: 0.2, ageMs: 400, feedState: 'LIVE' },
    });
    hub.publish({
      event: 'engine',
      data: { status: 'PAUSED', waitReasons: [], regime: 'RANGE', session: 'ASIA' },
    });
    const signal = await stream.next(isEvent('signal'));
    expect(signal).toMatchObject({ id: 'boot:1', event: 'signal', data: `{"id":"${ID_A}"}` });
    const quote = await stream.next(isEvent('quote'));
    expect(quote.id).toBeNull();
    const engine = await stream.next(isEvent('engine'));
    expect(engine.id).toBe('boot:2');
    stream.close();
    await h.app.close();
  });

  it('takes an empty Last-Event-ID for none: the client is not told to reload', async () => {
    const { h, hub, port, cookie } = await setup();
    publish(hub);
    const stream = await openStream(port, { cookie, lastEventId: '' });
    await stream.next((frame) => frame.retry !== null);
    await wait(60);
    expect(stream.events()).toEqual([]);
    stream.close();
    await h.app.close();
  });

  it('catches a client up with what it missed, and says resync to one it cannot catch up', async () => {
    const { h, hub, port, cookie } = await setup();
    publish(hub);
    publish(hub);
    publish(hub);
    const back = await openStream(port, { cookie, lastEventId: 'boot:1' });
    await back.next((frame) => frame.retry !== null);
    const missed = [await back.next(isEvent('signal')), await back.next(isEvent('signal'))];
    expect(missed.map((frame) => frame.id)).toEqual(['boot:2', 'boot:3']);
    publish(hub);
    expect((await back.next(isEvent('signal'))).id).toBe('boot:4');

    const lost = await openStream(port, { cookie, lastEventId: 'another-boot:9' });
    const resync = await lost.next(isEvent('resync'));
    expect(resync).toMatchObject({ id: 'boot:4', data: '{}' });
    expect(lost.events().filter((event) => event.event === 'signal')).toEqual([]);

    const fresh = await openStream(port, { cookie });
    await wait(60);
    expect(fresh.events()).toEqual([]);
    back.close();
    lost.close();
    fresh.close();
    await h.app.close();
  });

  it('sends a comment line now and then, so that a quiet stream is not closed by a proxy', async () => {
    const { h, port, cookie } = await setup();
    const stream = await openStream(port, { cookie });
    const beat = await stream.next((frame) => frame.comment === 'hb');
    expect(beat.event).toBeNull();
    await stream.next((frame) => frame.comment === 'hb');
    stream.close();
    await h.app.close();
  });

  it('ends when the session is revoked, and not before', async () => {
    const { h, hub, port, cookie } = await setup();
    const stream = await openStream(port, { cookie });
    await stream.next((frame) => frame.comment === 'hb');
    expect(hub.subscribers).toBe(1);
    await h.service.endToken(cookie);
    await Promise.race([
      stream.closed,
      wait(1500).then(() => Promise.reject(new Error('the stream stayed open'))),
    ]);
    await wait(10);
    expect(hub.subscribers).toBe(0);
    await h.app.close();
  });

  it('does not use the session up by asking about it: it is not extended by an open stream', async () => {
    const { h, port, cookie } = await setup();
    const stream = await openStream(port, { cookie });
    await stream.next((frame) => frame.comment === 'hb');
    const before = await h.store.sessions(h.clock.now);
    h.clock.advance(60 * 60_000);
    await wait(120);
    const after = await h.store.sessions(h.clock.now);
    expect(after[0]?.expiresAt).toBe(before[0]?.expiresAt);
    expect(after[0]?.lastSeenAt).toBe(before[0]?.lastSeenAt);
    stream.close();
    await h.app.close();
  });

  it('gives up its place when the client goes away', async () => {
    const { h, hub, port, cookie } = await setup();
    const stream = await openStream(port, { cookie });
    await stream.next((frame) => frame.retry !== null);
    expect(hub.subscribers).toBe(1);
    stream.close();
    await wait(80);
    expect(hub.subscribers).toBe(0);
    await h.app.close();
  });

  it('refuses a stream over the limit with 429, and takes one again when a place is free', async () => {
    const { h, port, cookie } = await setup({ maxConnections: 2 });
    const a = await openStream(port, { cookie });
    const b = await openStream(port, { cookie });
    await a.next((frame) => frame.retry !== null);
    await b.next((frame) => frame.retry !== null);
    const third = await openStream(port, { cookie });
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBe('10');
    expect(String(third.headers['content-type'])).toContain('application/problem+json');
    third.close();
    a.close();
    await wait(80);
    const again = await openStream(port, { cookie });
    expect(again.status).toBe(200);
    b.close();
    again.close();
    await h.app.close();
  });

  it('is ended by the server when it closes, so that a stop never waits for a stream', async () => {
    const { h, port, cookie } = await setup();
    const stream = await openStream(port, { cookie });
    await stream.next((frame) => frame.retry !== null);
    const closing = h.app.close();
    await Promise.race([
      closing,
      wait(2000).then(() => Promise.reject(new Error('close waited for the stream'))),
    ]);
    await stream.closed;
  });

  it('drops a client that does not read, so that it cannot make the server hold what it never takes', async () => {
    const { h, hub, port, cookie } = await setup({ maxBufferedBytes: 4000 });
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.on('connect', resolve));
    socket.pause();
    socket.write(
      `GET /api/v1/stream HTTP/1.1\r\nHost: x\r\nCookie: __Host-vmgs_session=${cookie}\r\n\r\n`,
    );
    for (let i = 0; i < 40 && hub.subscribers === 0; i += 1) await wait(10);
    expect(hub.subscribers).toBe(1);
    const label = 'x'.repeat(30_000);
    for (let i = 0; i < 400 && hub.subscribers > 0; i += 1) {
      hub.publish({
        event: 'engine',
        data: {
          status: 'RUNNING',
          waitReasons: [{ code: 'X', label }],
          regime: 'RANGE',
          session: 'ASIA',
        },
      });
      if (i % 20 === 19) await wait(5);
    }
    expect(hub.subscribers).toBe(0);
    socket.destroy();
    await h.app.close();
  });
});
