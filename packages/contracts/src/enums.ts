import {
  ADVISORY_FLAGS,
  AUTOPSY_STATUSES,
  CANDLE_SOURCES,
  CAUSE_CATEGORIES,
  CAUSE_CODES,
  ENGINE_STATUSES,
  EXIT_PROFILES,
  FEED_STATES,
  GATE_CODES,
  GATE_MODES,
  GRADES,
  GROUP_STATES,
  LOCALES,
  MACRO_IMPORTANCE,
  MARKET_EVENT_KINDS,
  NEWS_IMPACTS,
  NEWS_STATES,
  NEWS_TOPICS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  QUALITY_GROUPS,
  REGIMES,
  RESULTS,
  SAMPLE_LABELS,
  SESSIONS,
  SIDES,
  SIGNAL_EVENT_TYPES,
  SIGNAL_MODES,
  SIGNAL_STATUSES,
  STATS_SCOPES,
  STRATEGY_KEYS,
  STRATEGY_STATUSES,
  TIMEFRAMES,
  VOL_BUCKETS,
} from '@vmgs/core';
import { z } from 'zod';

export const sideSchema = z.enum(SIDES);
export const timeframeSchema = z.enum(TIMEFRAMES);
export const sessionSchema = z.enum(SESSIONS);
export const regimeSchema = z.enum(REGIMES);
export const volBucketSchema = z.enum(VOL_BUCKETS);
export const newsStateSchema = z.enum(NEWS_STATES);
export const signalModeSchema = z.enum(SIGNAL_MODES);
export const exitProfileSchema = z.enum(EXIT_PROFILES);
export const strategyKeySchema = z.enum(STRATEGY_KEYS);
export const strategyStatusSchema = z.enum(STRATEGY_STATUSES);
export const gateCodeSchema = z.enum(GATE_CODES);
export const advisoryFlagSchema = z.enum(ADVISORY_FLAGS);
export const qualityGroupSchema = z.enum(QUALITY_GROUPS);
export const groupStateSchema = z.enum(GROUP_STATES);
export const gradeSchema = z.enum(GRADES);
export const signalStatusSchema = z.enum(SIGNAL_STATUSES);
export const signalEventTypeSchema = z.enum(SIGNAL_EVENT_TYPES);
export const resultSchema = z.enum(RESULTS);
export const causeCodeSchema = z.enum(CAUSE_CODES);
export const causeCategorySchema = z.enum(CAUSE_CATEGORIES);
export const autopsyStatusSchema = z.enum(AUTOPSY_STATUSES);
export const statsScopeSchema = z.enum(STATS_SCOPES);
export const candleSourceSchema = z.enum(CANDLE_SOURCES);
export const feedStateSchema = z.enum(FEED_STATES);
export const engineStatusSchema = z.enum(ENGINE_STATUSES);
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export const newsTopicSchema = z.enum(NEWS_TOPICS);
export const newsImpactSchema = z.enum(NEWS_IMPACTS);
export const macroImportanceSchema = z.enum(MACRO_IMPORTANCE);
export const marketEventKindSchema = z.enum(MARKET_EVENT_KINDS);
export const localeSchema = z.enum(LOCALES);
export const gateModeSchema = z.enum(GATE_MODES);
export const sampleLabelSchema = z.enum(SAMPLE_LABELS);
