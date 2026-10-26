import { describe, expect, it } from 'vitest';

import { problemSchema } from '@vmgs/contracts';

import { makeHarness } from '../testing/harness';
import { registerEngineRoutes } from './routes';
import type { EngineControlStore, PauseOutcome, ResumeOutcome } from './store';

class FakeStore implements EngineControlStore {
  pauses: { minutes: number | null; at: number }[] = [];
  resumes: number[] = [];
  pauseResult: PauseOutcome = { outcome: 'PAUSED', since: 0, until: null };
  resumeResult: ResumeOutcome = 'RESUMED';

  pause(minutes: number | null, at: number): Promise<PauseOutcome> {
    this.pauses.push({ minutes, at });
    return Promise.resolve(this.pauseResult);
  }

  resume(at: number): Promise<ResumeOutcome> {
    this.resumes.push(at);
    return Promise.resolve(this.resumeResult);
  }
}

async function setup() {
  const store = new FakeStore();
  let changed = 0;
  const h = await makeHarness({
    routes: (app, clock) => {
      registerEngineRoutes(app, {
        store,
        now: () => clock.now,
        onChanged: () => {
          changed += 1;
        },
      });
    },
  });
  return { h, store, cookie: await h.login(), changed: () => changed };
}

const PAUSE = '/api/v1/engine/pause';
const RESUME = '/api/v1/engine/resume';

describe('POST /engine/pause', () => {
  it('pauses until the owner resumes when there is no body, an empty body or an empty object', async () => {
    const { h, store, cookie, changed } = await setup();
    for (const body of [undefined, {}]) {
      const reply = await h.send({ method: 'POST', url: PAUSE, body, cookie });
      expect(reply.status).toBe(204);
      expect(reply.res.body).toBe('');
    }
    expect(store.pauses.map((pause) => pause.minutes)).toEqual([null, null]);
    expect(changed()).toBe(2);
  });

  it('pauses for the minutes it is given, at the time of the clock', async () => {
    const { h, store, cookie } = await setup();
    h.clock.advance(12_345);
    expect((await h.send({ url: PAUSE, body: { minutes: 30 }, cookie })).status).toBe(204);
    expect(store.pauses).toEqual([{ minutes: 30, at: h.clock.now }]);
  });

  it('takes one minute to a week, and nothing outside it or of another kind', async () => {
    const { h, store, cookie } = await setup();
    for (const minutes of [1, 10_080]) {
      expect(
        (await h.send({ url: PAUSE, body: { minutes }, cookie })).status,
        String(minutes),
      ).toBe(204);
    }
    for (const body of [
      { minutes: 0 },
      { minutes: 10_081 },
      { minutes: 1.5 },
      { minutes: '30' },
      { minutes: null },
      { until: 5 },
    ]) {
      const reply = await h.send({ url: PAUSE, body, cookie });
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(problemSchema.parse(reply.json()).code).toBe('invalid_request');
    }
    expect(store.pauses).toHaveLength(2);
  });

  it('is 409 when the engine is paused already, and tells nobody it changed', async () => {
    const { h, store, cookie, changed } = await setup();
    store.pauseResult = { outcome: 'ALREADY_PAUSED', since: 5 };
    const reply = await h.send({ url: PAUSE, body: {}, cookie });
    expect(reply.status).toBe(409);
    expect(problemSchema.parse(reply.json())).toMatchObject({ code: 'already_paused' });
    expect(changed()).toBe(0);
  });

  it('is refused without a session and without the Origin of the site', async () => {
    const { h, store, cookie } = await setup();
    expect((await h.send({ url: PAUSE, body: {} })).status).toBe(401);
    expect((await h.send({ url: PAUSE, body: {}, cookie, sameSite: false })).status).toBe(403);
    expect(store.pauses).toEqual([]);
  });
});

describe('POST /engine/resume', () => {
  it('resumes and answers 204', async () => {
    const { h, store, cookie, changed } = await setup();
    h.clock.advance(1000);
    const reply = await h.send({ method: 'POST', url: RESUME, cookie });
    expect(reply.status).toBe(204);
    expect(store.resumes).toEqual([h.clock.now]);
    expect(changed()).toBe(1);
  });

  it('is 409 when the engine is not paused', async () => {
    const { h, store, cookie, changed } = await setup();
    store.resumeResult = 'NOT_PAUSED';
    const reply = await h.send({ method: 'POST', url: RESUME, cookie });
    expect(reply.status).toBe(409);
    expect(problemSchema.parse(reply.json())).toMatchObject({ code: 'not_paused' });
    expect(changed()).toBe(0);
  });

  it('is refused without a session and without the Origin of the site', async () => {
    const { h, store, cookie } = await setup();
    expect((await h.send({ method: 'POST', url: RESUME })).status).toBe(401);
    expect((await h.send({ method: 'POST', url: RESUME, cookie, sameSite: false })).status).toBe(
      403,
    );
    expect(store.resumes).toEqual([]);
  });
});
