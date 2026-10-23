// Generated from the migrated database by `pnpm --filter @vmgs/db codegen`. Do not edit by hand.
import type { ColumnType, Generated, GeneratedAlways } from 'kysely';

export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;

export type Numeric = ColumnType<string, number | string, number | string>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonPrimitive = boolean | number | string | null;

/** json and jsonb columns are read as parsed values and written as JSON text. */
export type Json = ColumnType<JsonValue, string, string>;

export interface AppSettings {
  key: string;
  value: Json;
  updated_at: Generated<Timestamp>;
}

export interface AuthOwner {
  id: Generated<number>;
  username: string;
  password_hash: string;
  totp_secret_enc: Buffer | null;
  totp_enabled: Generated<boolean>;
  recovery_code_hashes: Generated<string[]>;
  password_changed_at: Generated<Timestamp>;
  created_at: Generated<Timestamp>;
}

export interface AuthSessions {
  id_hash: string;
  created_at: Generated<Timestamp>;
  last_seen_at: Generated<Timestamp>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  ip_hash: string | null;
  ua_hash: string | null;
}

export interface Candles {
  symbol: string;
  tf: string;
  open_time: Timestamp;
  o: Numeric;
  h: Numeric;
  l: Numeric;
  c: Numeric;
  spread_avg: Numeric | null;
  spread_max: Numeric | null;
  tick_count: Generated<number>;
  complete: boolean;
  source: Generated<string>;
}

export interface EvidenceGroupStats {
  scope: string;
  strategy_key: string;
  group_key: string;
  state: string;
  n: Generated<number>;
  wins: Generated<number>;
  sum_r: Generated<Numeric>;
}

export interface Experiments {
  id: Generated<string>;
  created_at: Generated<Timestamp>;
  git_commit: string;
  strategy_key: string;
  params: Json;
  data_spec: Json;
  split: Json;
  trials_in_family: number;
  cost_model: Json;
  metrics: Json;
  notes: string | null;
}

export interface FailureCauseStats {
  month: string;
  strategy_key: string;
  cause_code: string;
  n: Generated<number>;
  sum_r: Generated<Numeric>;
}

export interface FeedIncidents {
  id: Generated<Int8>;
  kind: string;
  started_at: Timestamp;
  ended_at: Timestamp | null;
  details: Generated<Json>;
}

export interface LoginAttempts {
  id: Generated<Int8>;
  at: Generated<Timestamp>;
  ip_hash: string;
  success: boolean;
}

export interface MacroEvents {
  id: Generated<string>;
  source: string;
  source_event_id: string;
  scheduled_at: Timestamp;
  country_code: string | null;
  currency: string | null;
  name: string;
  importance: string;
  unit: string | null;
  multiplier: string | null;
  actual: Numeric | null;
  forecast: Numeric | null;
  previous: Numeric | null;
  revised_previous: Numeric | null;
  first_seen_at: Generated<Timestamp>;
  actual_first_seen_at: Timestamp | null;
  last_updated_at: Generated<Timestamp>;
  raw: Generated<Json>;
}

export interface MaintenanceRuns {
  id: Generated<Int8>;
  job: string;
  started_at: Timestamp;
  finished_at: Timestamp | null;
  rows_deleted: Generated<Int8>;
  db_size_bytes: Int8 | null;
  details: Generated<Json>;
}

export interface MarketEvents {
  id: Generated<Int8>;
  kind: string;
  detected_at: Timestamp;
  window_s: number;
  move_usd: Numeric;
  move_atr: Numeric;
  spread: Numeric | null;
  headlines: Generated<Json>;
  meta: Generated<Json>;
}

export interface NewsImpactSamples {
  cluster_id: string;
  topics: string[];
  impact: string;
  published_at: Timestamp;
  session: string;
  atr5: Numeric;
  move_2m: Numeric | null;
  move_5m: Numeric | null;
  move_10m: Numeric | null;
  max_abs_10m: Numeric | null;
}

export interface NewsItems {
  id: Generated<string>;
  source_key: string;
  url_hash: string;
  title: string;
  url: string;
  summary: string | null;
  published_at: Timestamp | null;
  first_seen_at: Generated<Timestamp>;
  topics: Generated<string[]>;
  impact: string;
  impact_score: Generated<Numeric>;
  cluster_id: string;
  classifier_version: string;
}

export interface NewsSources {
  key: string;
  name: string;
  tier: number;
  enabled: Generated<boolean>;
  last_ok_at: Timestamp | null;
  last_error: string | null;
}

export interface NewsTopicStats {
  topic: string;
  impact: string;
  n: Generated<number>;
  moved_1atr: Generated<number>;
  sum_abs_atr_10m: Generated<Numeric>;
  sum_signed_atr_10m: Generated<Numeric>;
  baseline_moved_1atr_share: Numeric | null;
  updated_at: Generated<Timestamp>;
}

export interface NotificationOutbox {
  id: Generated<string>;
  event_key: string;
  channel: string;
  kind: string;
  signal_id: string | null;
  payload: Json;
  status: Generated<string>;
  attempts: Generated<number>;
  next_attempt_at: Generated<Timestamp>;
  expires_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  sent_at: Timestamp | null;
  provider_message_id: string | null;
  last_error: string | null;
}

export interface PushSubscriptions {
  id: Generated<string>;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: Generated<Timestamp>;
  last_ok_at: Timestamp | null;
}

export interface Rejections {
  id: Generated<Int8>;
  at: Timestamp;
  strategy_key: string;
  side: string;
  failed_gates: string[];
  quality_score: Numeric | null;
  detail: Generated<Json>;
}

export interface SecurityAuditEvents {
  id: Generated<Int8>;
  at: Generated<Timestamp>;
  event_type: string;
  success: boolean;
  ip_hash: string | null;
  detail: Generated<Json>;
}

export interface SignalAutopsies {
  signal_id: string;
  status: string;
  primary_cause: string;
  causes: Json;
  weak_groups_at_entry: Json;
  counterfactual: Json | null;
  computed_at: Timestamp;
  finalized_at: Timestamp | null;
}

export interface SignalEvents {
  id: Generated<Int8>;
  signal_id: string;
  event_type: string;
  event_at: Timestamp;
  price: Numeric | null;
  meta: Generated<Json>;
}

export interface SignalHistoryV {
  signal_id: string | null;
  seq: Int8 | null;
  generated_at: Timestamp | null;
  side: string | null;
  mode: string | null;
  strategy_key: string | null;
  strategy_version: string | null;
  strategy_status: string | null;
  exit_profile: string | null;
  entry: Numeric | null;
  stop_loss: Numeric | null;
  tp1: Numeric | null;
  tp2: Numeric | null;
  risk_distance: Numeric | null;
  regime: string | null;
  session: string | null;
  vol_bucket: string | null;
  news_state: string | null;
  quality_score: Numeric | null;
  open_signals_at_entry: number | null;
  warnings: Json | null;
  evidence_win_rate: Numeric | null;
  evidence_n: number | null;
  state: string | null;
  result: string | null;
  counts_in_stats: boolean | null;
  is_win: boolean | null;
  closed_at: Timestamp | null;
  exit_price: Numeric | null;
  exit_reason: string | null;
  realized_r_net: Numeric | null;
  mfe_r: Numeric | null;
  mae_r: Numeric | null;
  duration_s: number | null;
  tp1_hit: boolean | null;
  tp2_hit: boolean | null;
  ambiguous: boolean | null;
  primary_cause: string | null;
  autopsy_status: string | null;
}

export interface SignalOutcomes {
  signal_id: string;
  result: string;
  counts_in_stats: boolean;
  closed_at: Timestamp;
  exit_price: Numeric | null;
  exit_reason: string;
  realized_r_gross: Numeric | null;
  cost_r: Generated<Numeric>;
  realized_r_net: Numeric | null;
  duration_s: number;
  mfe_r: Numeric | null;
  mae_r: Numeric | null;
  tp1_hit: Generated<boolean>;
  tp2_hit: Generated<boolean>;
  ambiguous: Generated<boolean>;
  is_win: GeneratedAlways<boolean | null>;
  meta: Generated<Json>;
}

export interface SignalState {
  signal_id: string;
  status: string;
  stop_loss_current: Numeric;
  tp1_hit_at: Timestamp | null;
  mfe_r: Generated<Numeric>;
  mae_r: Generated<Numeric>;
  updated_at: Generated<Timestamp>;
}

export interface Signals {
  id: Generated<string>;
  seq: GeneratedAlways<Int8>;
  symbol: Generated<string>;
  side: string;
  strategy_version_id: string;
  exit_profile: string;
  mode: string;
  generated_at: Timestamp;
  source_at: Timestamp;
  entry: Numeric;
  max_valid_entry: Numeric;
  entry_valid_until: Timestamp;
  stop_loss: Numeric;
  tp1: Numeric;
  tp2: Numeric | null;
  risk_distance: Numeric;
  atr5: Numeric;
  time_stop_at: Timestamp;
  regime: string;
  session: string;
  vol_bucket: string;
  news_state: string;
  setup_key: string;
  open_signals_at_entry: Generated<number>;
  warnings: Generated<Json>;
  chart_objects: Generated<Json>;
  quality_score: Numeric;
  grouped_scores: Json;
  hard_gates: Json;
  feature_snapshot: Json;
  explanation: Json;
  evidence: Json;
  data_latency_ms: number | null;
  created_at: Generated<Timestamp>;
}

export interface StatsBucket {
  scope: string;
  level: number;
  bucket_key: string;
  n: Generated<number>;
  wins: Generated<number>;
  partials: Generated<number>;
  losses: Generated<number>;
  time_exits: Generated<number>;
  tp1_hits: Generated<number>;
  tp2_hits: Generated<number>;
  sum_r: Generated<Numeric>;
  sum_win_r: Generated<Numeric>;
  sum_loss_r: Generated<Numeric>;
  updated_at: Generated<Timestamp>;
}

export interface StatsMonthly {
  month: string;
  strategy_key: Generated<string>;
  generated: Generated<number>;
  resolved_valid: Generated<number>;
  wins: Generated<number>;
  partials: Generated<number>;
  losses: Generated<number>;
  time_exits: Generated<number>;
  cancelled: Generated<number>;
  data_invalid: Generated<number>;
  net_r: Generated<Numeric>;
  sum_win_r: Generated<Numeric>;
  sum_loss_r: Generated<Numeric>;
}

export interface StorageUsageV {
  table_name: string | null;
  total_bytes: Int8 | null;
}

export interface StrategyVersions {
  id: Generated<string>;
  strategy_key: string;
  version: string;
  status: Generated<string>;
  config: Json;
  config_hash: string;
  created_at: Generated<Timestamp>;
}

export interface Ticks {
  ts: Timestamp;
  rx_at: Timestamp;
  symbol: string;
  bid: Numeric;
  ask: Numeric;
}

export interface WorkerHeartbeats {
  worker_name: string;
  heartbeat_at: Timestamp;
  metadata: Generated<Json>;
}

export interface DB {
  app_settings: AppSettings;
  auth_owner: AuthOwner;
  auth_sessions: AuthSessions;
  candles: Candles;
  evidence_group_stats: EvidenceGroupStats;
  experiments: Experiments;
  failure_cause_stats: FailureCauseStats;
  feed_incidents: FeedIncidents;
  login_attempts: LoginAttempts;
  macro_events: MacroEvents;
  maintenance_runs: MaintenanceRuns;
  market_events: MarketEvents;
  news_impact_samples: NewsImpactSamples;
  news_items: NewsItems;
  news_sources: NewsSources;
  news_topic_stats: NewsTopicStats;
  notification_outbox: NotificationOutbox;
  push_subscriptions: PushSubscriptions;
  rejections: Rejections;
  security_audit_events: SecurityAuditEvents;
  signal_autopsies: SignalAutopsies;
  signal_events: SignalEvents;
  signal_history_v: SignalHistoryV;
  signal_outcomes: SignalOutcomes;
  signal_state: SignalState;
  signals: Signals;
  stats_bucket: StatsBucket;
  stats_monthly: StatsMonthly;
  storage_usage_v: StorageUsageV;
  strategy_versions: StrategyVersions;
  ticks: Ticks;
  worker_heartbeats: WorkerHeartbeats;
}
