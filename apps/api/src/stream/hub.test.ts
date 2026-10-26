import { describe, expect, it } from 'vitest';

import { sseEventIdSchema, type SseEvent } from '@vmgs/contracts';

import { HEARTBEAT_FRAME, EventHub, frameOf, type Stamped } from './hub';

const ID_A = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10';
const ID_B = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e11';

const signal = (id = ID_A): Extract<SseEvent, { event: 'signal' }> => ({
  event: 'signal',
  data: { id },
});
const update = (
  id: string,
  unrealisedR: number,
): Extract<SseEvent, { event: 'signal_update' }> => ({
  event: 'signal_update',
  data: { id, status: 'ACTIVE', unrealisedR, stop: 4010.9 },
});
const engine = (status: 'RUNNING' | 'PAUSED'): Extract<SseEvent, { event: 'engine' }> => ({
  event: 'engine',
  data: { status, waitReasons: [], regime: 'RANGE', session: 'LONDON' },
});
const quote = (bid: number): Extract<SseEvent, { event: 'quote' }> => ({
  event: 'quote',
  data: { bid, ask: bid + 0.2, spread: 0.2, ageMs: 500, feedState: 'LIVE' },
});

function listen(hub: EventHub, lastEventId?: string) {
  const got: Stamped[] = [];
  const subscription = hub.subscribe((stamped) => got.push(stamped), lastEventId);
  return { got, subscription };
}

describe('EventHub: ids', () => {
  it('gives the events ids `<bootId>:<n>` that grow by one, and the quotes none', () => {
    const hub = new EventHub('boot1');
    const { got } = listen(hub);
    hub.publish(signal());
    hub.quote(quote(4017.3));
    hub.publish(engine('PAUSED'));
    expect(got.map((stamped) => stamped.id)).toEqual(['boot1:1', null, 'boot1:2']);
    expect(hub.lastId).toBe('boot1:2');
    for (const stamped of got) {
      if (stamped.id !== null) expect(sseEventIdSchema.safeParse(stamped.id).success).toBe(true);
    }
  });

  it('starts at `<bootId>:0`', () => {
    expect(new EventHub('b').lastId).toBe('b:0');
  });

  it('refuses an event that does not match the contract, and gives it no id', () => {
    const hub = new EventHub('b');
    expect(() =>
      hub.publish({ event: 'signal', data: { id: 'not-a-uuid' } } as unknown as SseEvent as never),
    ).toThrow();
    expect(() =>
      hub.publish({ event: 'engine', data: { status: 'RUNNING' } } as unknown as SseEvent as never),
    ).toThrow();
    expect(() => {
      hub.quote({ event: 'quote', data: { bid: 1 } } as unknown as SseEvent as never);
    }).toThrow();
    expect(hub.lastId).toBe('b:0');
  });
});

describe('EventHub: listeners', () => {
  it('sends everything to every listener, and nothing after it has left', () => {
    const hub = new EventHub('b');
    const first = listen(hub);
    const second = listen(hub);
    expect(hub.subscribers).toBe(2);
    hub.publish(signal());
    first.subscription.unsubscribe();
    hub.publish(signal(ID_B));
    hub.quote(quote(1));
    expect(first.got).toHaveLength(1);
    expect(second.got).toHaveLength(3);
    expect(hub.subscribers).toBe(1);
    first.subscription.unsubscribe();
    expect(hub.subscribers).toBe(1);
  });

  it('drops a listener that fails, and the others still get the event', () => {
    const hub = new EventHub('b');
    hub.subscribe(() => {
      throw new Error('the connection is gone');
    });
    const healthy = listen(hub);
    expect(() => hub.publish(signal())).not.toThrow();
    expect(healthy.got).toHaveLength(1);
    expect(hub.subscribers).toBe(1);
  });

  it('tells every listener to reload when asked, under the newest id', () => {
    const hub = new EventHub('b');
    hub.publish(signal());
    const a = listen(hub);
    hub.resyncAll();
    expect(a.got).toEqual([{ id: 'b:1', event: { event: 'resync', data: {} } }]);
    expect(hub.lastId).toBe('b:1');
  });
});

describe('EventHub: catching a client up', () => {
  it('gives a new client nothing: it loads its state over REST', () => {
    const hub = new EventHub('b');
    hub.publish(signal());
    const { subscription } = listen(hub);
    expect(subscription.backlog).toEqual([]);
    expect(subscription.resync).toBeNull();
  });

  it('gives what came after the id the client saw, in order, and nothing when it saw the newest', () => {
    const hub = new EventHub('b');
    hub.publish(signal(ID_A));
    hub.publish(signal(ID_B));
    hub.publish(engine('PAUSED'));
    const missed = listen(hub, 'b:1').subscription;
    expect(missed.resync).toBeNull();
    expect(missed.backlog.map((stamped) => stamped.id)).toEqual(['b:2', 'b:3']);
    expect(listen(hub, 'b:3').subscription.backlog).toEqual([]);
    expect(listen(hub, 'b:3').subscription.resync).toBeNull(); // caught up is not lost
    expect(listen(hub, 'b:0').subscription.backlog.map((stamped) => stamped.id)).toEqual([
      'b:1',
      'b:2',
      'b:3',
    ]);
  });

  it('puts the backlog and the live events in one order with no gap and no repeat', () => {
    const hub = new EventHub('b');
    hub.publish(signal(ID_A));
    const { got, subscription } = listen(hub, 'b:0');
    hub.publish(signal(ID_B));
    expect(subscription.backlog.map((stamped) => stamped.id)).toEqual(['b:1']);
    expect(got.map((stamped) => stamped.id)).toEqual(['b:2']);
  });

  it('says resync for an id of another boot, of nobody, from the future, or that is no id', () => {
    const hub = new EventHub('b');
    hub.publish(signal());
    hub.publish(signal(ID_B));
    for (const id of ['other:1', 'b:99', 'b:', 'b', 'b:-1', ':1', 'b:1x', 'a b:1', '']) {
      const { subscription } = listen(hub, id);
      expect(subscription.resync, id).toEqual({ id: 'b:2', event: { event: 'resync', data: {} } });
      expect(subscription.backlog, id).toEqual([]);
    }
  });

  it('keeps the last 200 events, and says resync to a client for which one of them is gone', () => {
    const hub = new EventHub('b');
    for (let i = 0; i < 205; i += 1) hub.publish(signal());
    // 1..5 are gone: a client that saw 5 needs 6, which is there; one that saw 4 needs 5, which is not
    expect(listen(hub, 'b:5').subscription.resync).toBeNull();
    expect(listen(hub, 'b:5').subscription.backlog).toHaveLength(200);
    expect(listen(hub, 'b:4').subscription.resync).not.toBeNull();
    expect(listen(hub, 'b:0').subscription.resync).not.toBeNull();
    expect(listen(hub, 'b:205').subscription.backlog).toEqual([]);
  });

  it('keeps a buffer of the size it is given, also none: then only a client that saw the newest is caught up', () => {
    const none = new EventHub('b', 0);
    none.publish(signal());
    none.publish(signal());
    expect(listen(none, 'b:2').subscription.resync).toBeNull();
    expect(listen(none, 'b:1').subscription.resync).not.toBeNull();

    const hub = new EventHub('b', 2);
    hub.publish(signal());
    hub.publish(signal());
    hub.publish(signal());
    expect(listen(hub, 'b:1').subscription.backlog.map((stamped) => stamped.id)).toEqual([
      'b:2',
      'b:3',
    ]);
    expect(listen(hub, 'b:0').subscription.resync).not.toBeNull();
  });

  it('never replays a quote', () => {
    const hub = new EventHub('b');
    hub.publish(signal());
    hub.quote(quote(4017.3));
    hub.quote(quote(4017.4));
    expect(listen(hub, 'b:0').subscription.backlog).toHaveLength(1);
  });

  it('gives only the newest of the events that say how things are, and every event that is something that happened', () => {
    const hub = new EventHub('b');
    hub.publish(update(ID_A, 0.1));
    hub.publish(update(ID_B, 0.5));
    hub.publish(signal(ID_A));
    hub.publish(update(ID_A, 0.3));
    hub.publish(engine('PAUSED'));
    hub.publish(engine('RUNNING'));
    hub.publish({ event: 'health', data: { feed: 'OK' } });
    hub.publish({ event: 'health', data: { feed: 'DEGRADED' } });
    hub.publish({ event: 'news', data: { state: 'CLEAR', next: null } });
    hub.publish({ event: 'news', data: { state: 'IN_WINDOW', next: null } });
    const { backlog } = listen(hub, 'b:0').subscription;
    expect(backlog.map((stamped) => stamped.id)).toEqual([
      'b:2',
      'b:3',
      'b:4',
      'b:6',
      'b:8',
      'b:10',
    ]);
    expect(backlog[2]?.event).toMatchObject({ event: 'signal_update', data: { unrealisedR: 0.3 } });
    expect(backlog[3]?.event).toMatchObject({ event: 'engine', data: { status: 'RUNNING' } });
    expect(backlog[5]?.event).toMatchObject({ event: 'news', data: { state: 'IN_WINDOW' } });
  });
});

describe('frames', () => {
  it('writes id, event and one line of data, and no id for a quote', () => {
    expect(frameOf({ id: 'b:7', event: signal() })).toBe(
      `id: b:7\nevent: signal\ndata: {"id":"${ID_A}"}\n\n`,
    );
    expect(frameOf({ id: null, event: quote(4017.3) })).toBe(
      'event: quote\ndata: {"bid":4017.3,"ask":4017.5,"spread":0.2,"ageMs":500,"feedState":"LIVE"}\n\n',
    );
    expect(frameOf({ id: 'b:1', event: { event: 'resync', data: {} } })).toBe(
      'id: b:1\nevent: resync\ndata: {}\n\n',
    );
  });

  it('keeps text with a line break inside one line of data', () => {
    const frame = frameOf({
      id: 'b:1',
      event: {
        event: 'engine',
        data: {
          status: 'RUNNING',
          waitReasons: [{ code: 'X', label: 'a\nb' }],
          regime: 'RANGE',
          session: 'LONDON',
        },
      },
    });
    expect(frame.split('\n').filter((line) => line.startsWith('data:'))).toHaveLength(1);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('has a heartbeat that is a comment line', () => {
    expect(HEARTBEAT_FRAME).toBe(': hb\n\n');
  });
});
