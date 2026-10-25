import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import sample from './fixtures/calendar-sample.json';
import { FakeCalendar } from '../testing/fakeCalendar';
import { BiquoteCalendarClient, CalendarError, parseCalendarRow } from './provider';
import { providerEvent, rowOf } from './testData';

const rows = sample as unknown as Record<string, unknown>[];
const rowNamed = (id: string): Record<string, unknown> => {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no fixture row ${id}`);
  return row;
};

describe('parseCalendarRow (rows of the real service)', () => {
  it('reads a released event with all its figures', () => {
    expect(parseCalendarRow(rowNamed('mql5:277492'))).toEqual({
      sourceEventId: 'mql5:277492',
      seriesId: 'mql5:840030005',
      scheduledAt: Date.parse('2026-10-14T12:30:00Z'),
      countryCode: 'US',
      currency: 'USD',
      name: 'CPI m/m',
      importance: 'high',
      type: 'indicator',
      period: '2026-09-01T00:00:00Z',
      unit: 'percent',
      multiplier: 'none',
      digits: 1,
      actual: 0.6,
      forecast: 0.6,
      previous: 0.4,
      revisedPrevious: null,
      revision: 0,
      timeMode: 'exact',
      origin: 'mql5',
      sourceUrl: 'https://www.bls.gov',
    });
  });

  it('reads a revised previous value, a multiplier, and a row with no forecast or no actual', () => {
    expect(parseCalendarRow(rowNamed('mql5:317675'))).toMatchObject({
      name: 'Initial Jobless Claims',
      actual: 197,
      forecast: 190,
      previous: 197,
      revisedPrevious: 199,
      multiplier: 'thousands',
      digits: 0,
    });
    expect(parseCalendarRow(rowNamed('fxempire:418202'))).toMatchObject({
      forecast: null,
      actual: null,
      previous: 3.321,
      origin: 'fxempire',
      multiplier: null,
    });
    expect(parseCalendarRow(rowNamed('mql5:270438'))).toMatchObject({ revision: 1, actual: null });
  });

  it('reads a tentative time as it is', () => {
    expect(parseCalendarRow(rowNamed('mql5:317613'))).toMatchObject({ timeMode: 'tentative' });
  });

  it('skips a holiday, which has no importance', () => {
    expect(parseCalendarRow(rowNamed('mql5:248898'))).toBe('skip');
  });

  it('takes an unknown or missing time mode as tentative, the cautious reading', () => {
    expect(parseCalendarRow({ ...rowNamed('mql5:277492'), timeMode: 'sometime' })).toMatchObject({
      timeMode: 'tentative',
    });
    expect(parseCalendarRow({ ...rowNamed('mql5:277492'), timeMode: undefined })).toMatchObject({
      timeMode: 'tentative',
    });
  });

  it('reads a row without the details it does not need, and trims the text', () => {
    const minimal = {
      id: ' x ',
      time: '2026-10-14T12:30:00Z',
      name: ' CPI ',
      importance: 'medium',
    };
    expect(parseCalendarRow(minimal)).toMatchObject({
      sourceEventId: 'x',
      name: 'CPI',
      importance: 'medium',
      seriesId: null,
      currency: null,
      actual: null,
      digits: null,
      timeMode: 'tentative',
    });
  });

  it('cannot read what has no id, name or time, an importance it does not know, or a figure that is not a number', () => {
    const base = rowNamed('mql5:277492');
    for (const bad of [
      null,
      'text',
      [],
      { ...base, id: '' },
      { ...base, id: 5 },
      { ...base, name: ' ' },
      { ...base, time: 'soon' },
      { ...base, time: 17 },
      { ...base, importance: 'urgent' },
      { ...base, importance: undefined },
      { ...base, actual: '0.5' },
      { ...base, forecast: Number.NaN },
      { ...base, previous: 'n/a' },
      { ...base, revisedPrevious: true },
      { ...base, digits: '1' },
      { ...base, revision: {} },
    ]) {
      expect(parseCalendarRow(bad)).toBeNull();
    }
  });
});

describe('BiquoteCalendarClient', () => {
  const fake = new FakeCalendar();
  let client: BiquoteCalendarClient;

  beforeAll(async () => {
    await fake.start();
  });
  afterAll(async () => {
    await fake.stop();
  });
  beforeEach(() => {
    fake.rows = rows;
    fake.history.clear();
    fake.requests.length = 0;
    client = new BiquoteCalendarClient({ baseUrl: fake.baseUrl, timeoutMs: 400 });
  });

  const FROM = Date.parse('2026-10-13T00:00:00Z');
  const TO = Date.parse('2026-10-28T00:00:00Z');

  it('asks for the window and the countries, and reads the answer', async () => {
    const result = await client.fetchRange(FROM, TO);
    expect(fake.readings).toHaveLength(1);
    const query = fake.readings[0]?.query;
    expect(query?.get('from')).toBe('2026-10-13T00:00:00.000Z');
    expect(query?.get('to')).toBe('2026-10-28T00:00:00.000Z');
    expect(query?.get('countries')).toBe('US');
    expect(query?.get('limit')).toBe('500');
    expect(result.events.map((event) => event.sourceEventId)).toEqual([
      'mql5:277492',
      'mql5:277504',
      'mql5:270438',
      'mql5:270320',
    ]);
    expect(result).toMatchObject({ skipped: 0, invalid: 0, truncated: false });
  });

  it('counts the holidays it skips and the rows it cannot read, and keeps the rest', async () => {
    const wide = Date.parse('2026-10-01T00:00:00Z');
    fake.rows = [
      ...rows,
      { id: 'broken', countryCode: 'US', time: '2026-10-14T12:30:00Z' },
      { ...rowNamed('mql5:277492'), id: 'bad', actual: 'x' },
    ];
    const all = new BiquoteCalendarClient({
      baseUrl: fake.baseUrl,
      countries: 'US,NZ,IL,BE,FR',
      timeoutMs: 400,
    });
    const result = await all.fetchRange(wide, TO);
    expect(result.events).toHaveLength(8);
    expect(result.skipped).toBe(1);
    expect(result.invalid).toBe(2);
  });

  it('says when the answer is as long as the limit asked for, because the window may have been cut', async () => {
    const small = new BiquoteCalendarClient({ baseUrl: fake.baseUrl, limit: 4, timeoutMs: 400 });
    const result = await small.fetchRange(FROM, TO);
    expect(result.events).toHaveLength(4);
    expect(result.truncated).toBe(true);
    expect(fake.readings[0]?.query.get('limit')).toBe('4');
  });

  it('has an empty window as no events, not as an error', async () => {
    fake.rows = [];
    expect(await client.fetchRange(FROM, TO)).toEqual({
      events: [],
      skipped: 0,
      invalid: 0,
      truncated: false,
    });
  });

  it('has a list in which nothing can be read as a failure: the format changed, the calendar is not known', async () => {
    fake.rows = [
      { id: 'a', countryCode: 'US', time: '2026-10-14T12:30:00Z' },
      { id: 'b', countryCode: 'US', time: '2026-10-14T13:30:00Z', name: 5 },
    ];
    await expect(client.fetchRange(FROM, TO)).rejects.toMatchObject({ kind: 'format' });
  });

  it('is a failure when the answer is not a list, or not JSON', async () => {
    fake.next({ type: 'object' });
    await expect(client.fetchRange(FROM, TO)).rejects.toMatchObject({
      kind: 'format',
      status: null,
    });
    fake.next({ type: 'garbage' });
    await expect(client.fetchRange(FROM, TO)).rejects.toMatchObject({
      kind: 'format',
      status: 200,
    });
  });

  it('is a failure on an HTTP error, with its status', async () => {
    fake.next({ type: 'status', status: 503 });
    const error = await client.fetchRange(FROM, TO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CalendarError);
    expect(error).toMatchObject({
      kind: 'http',
      status: 503,
      message: 'the calendar answered 503',
    });
  });

  it('is a failure when it takes too long, and when the connection is cut', async () => {
    fake.next({ type: 'hang' });
    await expect(client.fetchRange(FROM, TO)).rejects.toMatchObject({ kind: 'timeout' });
    fake.next({ type: 'drop' });
    await expect(client.fetchRange(FROM, TO)).rejects.toMatchObject({ kind: 'network' });
  });

  it('is a failure when nothing listens', async () => {
    const lost = new BiquoteCalendarClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 400 });
    await expect(lost.fetchRange(FROM, TO)).rejects.toMatchObject({ kind: 'network' });
  });

  it('reads the history of a series, with the id of the series in the path, as the service wants it', async () => {
    const history = [
      rowOf(providerEvent({ sourceEventId: 'h1', actual: 0.4, forecast: 0.3 })),
      rowOf(providerEvent({ sourceEventId: 'h2', actual: null })),
    ];
    fake.history.set('mql5:840030005', history);
    const events = await client.fetchHistory('mql5:840030005');
    expect(events.map((event) => event.sourceEventId)).toEqual(['h1', 'h2']);
    const request = fake.requests[0];
    expect(request?.path).toBe('/api/Calendar/mql5%3A840030005/history');
    expect(request?.query.get('limit')).toBe('24');
  });

  it('is a failure for a series the service does not know', async () => {
    await expect(client.fetchHistory('mql5:0')).rejects.toMatchObject({
      kind: 'http',
      status: 404,
    });
  });
});
