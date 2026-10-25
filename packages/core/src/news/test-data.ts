import { NEWS_TOPICS, type NewsTopic } from '../domain';
import type { AlertSettings } from '../lifecycle/alerts';

/** Every headline topic switched on or off. */
export function topicSwitches(state: 'on' | 'off'): Record<NewsTopic, 'on' | 'off'> {
  return Object.fromEntries(NEWS_TOPICS.map((topic) => [topic, state])) as Record<
    NewsTopic,
    'on' | 'off'
  >;
}

/** The news alerts of a fresh system: from HIGH impact, every topic on, move alerts on. */
export const NEWS_ALERTS: AlertSettings['newsAlerts'] = {
  minImpact: 'HIGH',
  topics: topicSwitches('on'),
  marketMoves: 'on',
};
