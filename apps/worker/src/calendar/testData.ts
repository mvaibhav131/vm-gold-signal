import type { ProviderEvent } from './provider';

export const T0 = Date.UTC(2026, 9, 23, 12, 30, 0);

/** An event of the calendar as the provider reads it: CPI m/m, ahead, with a forecast. */
export function providerEvent(change: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    sourceEventId: 'mql5:277492',
    seriesId: 'mql5:840030005',
    scheduledAt: T0,
    countryCode: 'US',
    currency: 'USD',
    name: 'CPI m/m',
    importance: 'high',
    type: 'indicator',
    period: '2026-09-01T00:00:00Z',
    unit: 'percent',
    multiplier: 'none',
    digits: 1,
    actual: null,
    forecast: 0.3,
    previous: 0.4,
    revisedPrevious: null,
    revision: 0,
    timeMode: 'exact',
    origin: 'mql5',
    sourceUrl: 'https://www.bls.gov',
    ...change,
  };
}

/** The JSON row of `/api/Calendar` for an event (what the fake server serves). */
export function rowOf(event: ProviderEvent): Record<string, unknown> {
  return {
    id: event.sourceEventId,
    eventId: event.seriesId,
    time: new Date(event.scheduledAt).toISOString(),
    period: event.period,
    countryCode: event.countryCode,
    currency: event.currency,
    name: event.name,
    importance: event.importance,
    type: event.type,
    sector: 'prices',
    unit: event.unit,
    multiplier: event.multiplier,
    digits: event.digits,
    actual: event.actual,
    forecast: event.forecast,
    previous: event.previous,
    revisedPrevious: event.revisedPrevious,
    revision: event.revision,
    timeMode: event.timeMode,
    sourceUrl: event.sourceUrl,
    source: event.origin,
  };
}
