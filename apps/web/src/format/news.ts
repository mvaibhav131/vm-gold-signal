import type { NewsImpact, NewsTopic } from '@vmgs/core';

export const TOPIC_LABELS: Readonly<Record<NewsTopic, string>> = {
  FED_RATES: 'Fed and interest rates',
  USD_DOLLAR: 'US dollar',
  INFLATION_JOBS: 'Inflation and jobs',
  GEOPOLITICS_WAR: 'Geopolitics and war',
  TRUMP_POLICY: 'Trump policy',
  CENTRAL_BANK_GOLD: 'Central-bank gold buying',
  GOLD_DIRECT: 'Gold directly',
  RISK_OFF: 'Risk-off moves',
};

export const IMPACT_LABELS: Readonly<Record<NewsImpact, string>> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
};
