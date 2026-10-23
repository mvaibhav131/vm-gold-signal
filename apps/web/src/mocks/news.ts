import {
  headlinesResponseSchema,
  newsStateResponseSchema,
  type HeadlinesResponse,
  type NewsStateResponse,
} from '@vmgs/contracts';

const MINUTE_MS = 60_000;

function eventId(n: number): string {
  return `00000000-0000-4000-8000-${(0xe000 + n).toString(16).padStart(12, '0')}`;
}

/** `IN_WINDOW` puts the next event 22 minutes away (inside the news window), `CLEAR` four hours. */
export function newsStateAt(state: 'CLEAR' | 'IN_WINDOW', nowMs: number): NewsStateResponse {
  const minutesToNext = state === 'IN_WINDOW' ? 22 : 240;
  return newsStateResponseSchema.parse({
    state,
    next: {
      id: eventId(1),
      name: 'US CPI (simulated)',
      scheduledAt: new Date(nowMs + minutesToNext * MINUTE_MS).toISOString(),
      importance: 'high',
      currency: 'USD',
      unit: '%',
      actual: null,
      forecast: 0.3,
      previous: 0.4,
      revisedPrevious: null,
    },
    last: null,
    sourceAgeS: 45,
  });
}

/** Headlines are made up and say so; they exist only to show the layout of the real feed. */
export function headlinesAt(nowMs: number, limit: number): HeadlinesResponse {
  const items = [
    {
      id: eventId(11),
      title: 'Simulated headline: central bank speaker comments on the rate path',
      sources: [{ key: 'sim-a', name: 'Simulated feed A' }],
      publishedAt: new Date(nowMs - 12 * MINUTE_MS).toISOString(),
      firstSeenAt: new Date(nowMs - 10 * MINUTE_MS).toISOString(),
      delayS: 120,
      topics: ['FED_RATES'],
      impact: 'MEDIUM',
      url: 'https://example.com/simulated-1',
      goldMoveSincePublish: { usd: 1.2, atr: 0.3 },
    },
    {
      id: eventId(12),
      title: 'Simulated headline: dollar index edges lower before US data',
      sources: [
        { key: 'sim-a', name: 'Simulated feed A' },
        { key: 'sim-b', name: 'Simulated feed B' },
      ],
      publishedAt: new Date(nowMs - 35 * MINUTE_MS).toISOString(),
      firstSeenAt: new Date(nowMs - 34 * MINUTE_MS).toISOString(),
      delayS: 60,
      topics: ['USD_DOLLAR'],
      impact: 'LOW',
      url: 'https://example.com/simulated-2',
      goldMoveSincePublish: { usd: -0.4, atr: -0.1 },
    },
    {
      id: eventId(13),
      title: 'Simulated headline: geopolitical tension lifts demand for safe assets',
      sources: [{ key: 'sim-b', name: 'Simulated feed B' }],
      publishedAt: new Date(nowMs - 80 * MINUTE_MS).toISOString(),
      firstSeenAt: new Date(nowMs - 77 * MINUTE_MS).toISOString(),
      delayS: 180,
      topics: ['GEOPOLITICS_WAR', 'RISK_OFF'],
      impact: 'HIGH',
      url: 'https://example.com/simulated-3',
      goldMoveSincePublish: { usd: 3.1, atr: 0.7 },
    },
  ];
  return headlinesResponseSchema.parse({
    items: items.slice(0, limit),
    nextCursor: null,
    sources: [
      {
        key: 'sim-a',
        name: 'Simulated feed A',
        enabled: true,
        lastOkAt: new Date(nowMs - MINUTE_MS).toISOString(),
        lastError: null,
      },
      {
        key: 'sim-b',
        name: 'Simulated feed B',
        enabled: true,
        lastOkAt: new Date(nowMs - 2 * MINUTE_MS).toISOString(),
        lastError: null,
      },
    ],
  });
}
