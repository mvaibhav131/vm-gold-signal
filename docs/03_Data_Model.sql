-- VM Gold Signal schema v1 (PostgreSQL 17). Hand-written; query types are generated from the migrated database (packages/db/src/codegen.ts).
-- All timestamps are timestamptz (UTC). Prices are numeric(12,3). "R" means multiples of the initial risk distance.

-- ============================================================
-- helpers
-- ============================================================
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME;
END $$;

-- ============================================================
-- market data
-- ============================================================
CREATE TABLE ticks (
  ts      timestamptz   NOT NULL,   -- provider timestamp (1 s resolution)
  rx_at   timestamptz   NOT NULL,   -- worker receive time
  symbol  text          NOT NULL,
  bid     numeric(12,3) NOT NULL,
  ask     numeric(12,3) NOT NULL,
  CHECK (ask >= bid)
) PARTITION BY RANGE (ts);
CREATE INDEX ticks_symbol_ts_idx ON ticks (symbol, ts);

CREATE FUNCTION ensure_tick_partitions(days_ahead integer DEFAULT 2) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  d       date;
  part    text;
  created integer := 0;
  today   date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  FOR d IN SELECT g::date FROM generate_series(today - 1, today + days_ahead, interval '1 day') AS g LOOP
    part := 'ticks_' || to_char(d, 'YYYYMMDD');
    IF to_regclass('public.' || quote_ident(part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF ticks FOR VALUES FROM (%L) TO (%L)',
        part,
        (d::timestamp AT TIME ZONE 'UTC'),
        ((d + 1)::timestamp AT TIME ZONE 'UTC')
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;

CREATE FUNCTION drop_old_tick_partitions(keep_days integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  part    text;
  dropped integer := 0;
  cutoff  date := (now() AT TIME ZONE 'UTC')::date - keep_days;
BEGIN
  FOR part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'ticks'
  LOOP
    IF to_date(substr(part, 7), 'YYYYMMDD') < cutoff THEN
      EXECUTE format('DROP TABLE %I', part);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END $$;

CREATE TABLE candles (
  symbol      text          NOT NULL,
  tf          text          NOT NULL CHECK (tf IN ('1m','5m','15m','1h','4h','1d')),
  open_time   timestamptz   NOT NULL,
  o           numeric(12,3) NOT NULL,   -- mid prices
  h           numeric(12,3) NOT NULL,
  l           numeric(12,3) NOT NULL,
  c           numeric(12,3) NOT NULL,
  spread_avg  numeric(8,3),
  spread_max  numeric(8,3),
  tick_count  integer       NOT NULL DEFAULT 0,
  complete    boolean       NOT NULL,
  source      text          NOT NULL DEFAULT 'live'
              CHECK (source IN ('live','histdata_bootstrap','biquote_ohlc_bootstrap')),
  PRIMARY KEY (symbol, tf, open_time),
  CHECK (h >= l)
);

CREATE TABLE feed_incidents (
  id          bigserial PRIMARY KEY,
  kind        text        NOT NULL CHECK (kind IN ('DISCONNECT','STALE','GAP','CLOCK_SKEW','SPREAD_SPIKE','MARKET_STATE')),
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  details     jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX feed_incidents_time_idx ON feed_incidents (started_at);

-- ============================================================
-- strategies and research registry
-- ============================================================
CREATE TABLE strategy_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_key text        NOT NULL,
  version      text        NOT NULL,
  status       text        NOT NULL DEFAULT 'RESEARCH'
               CHECK (status IN ('RESEARCH','BACKTESTED','FORWARD_TESTING','VALIDATED','PAUSED','DRIFTED')),
  config       jsonb       NOT NULL,
  config_hash  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy_key, version)
);

CREATE FUNCTION strategy_config_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.config IS DISTINCT FROM OLD.config
     OR NEW.config_hash <> OLD.config_hash
     OR NEW.strategy_key <> OLD.strategy_key
     OR NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'strategy version config is immutable; create a new version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER strategy_versions_immutable BEFORE UPDATE ON strategy_versions
  FOR EACH ROW EXECUTE FUNCTION strategy_config_immutable();

CREATE TABLE experiments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  git_commit       text        NOT NULL,
  strategy_key     text        NOT NULL,
  params           jsonb       NOT NULL,
  data_spec        jsonb       NOT NULL,   -- source, symbol, date range
  split            jsonb       NOT NULL,   -- train / validation / test boundaries
  trials_in_family integer     NOT NULL,   -- how many variants were tried (multiple-testing log)
  cost_model       jsonb       NOT NULL,
  metrics          jsonb       NOT NULL,
  notes            text
);

-- ============================================================
-- signals (immutable) and their lifecycle
-- ============================================================
CREATE TABLE signals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                 bigint GENERATED ALWAYS AS IDENTITY,      -- shown as S-0042
  symbol              text          NOT NULL DEFAULT 'XAUUSD',
  side                text          NOT NULL CHECK (side IN ('BUY','SELL')),
  strategy_version_id uuid          NOT NULL REFERENCES strategy_versions(id),
  exit_profile        text          NOT NULL,                  -- e.g. EP1_PARTIAL
  mode                text          NOT NULL CHECK (mode IN ('LIVE','SIMULATED','BACKTEST')),
  generated_at        timestamptz   NOT NULL,                  -- decision time (5m candle close)
  source_at           timestamptz   NOT NULL,                  -- feed timestamp of the confirming tick
  entry               numeric(12,3) NOT NULL,                  -- simulated fill (ask/bid + slippage)
  max_valid_entry     numeric(12,3) NOT NULL,
  entry_valid_until   timestamptz   NOT NULL,
  stop_loss           numeric(12,3) NOT NULL,
  tp1                 numeric(12,3) NOT NULL,
  tp2                 numeric(12,3),
  risk_distance       numeric(12,3) NOT NULL CHECK (risk_distance > 0),
  atr5                numeric(12,3) NOT NULL,
  time_stop_at        timestamptz   NOT NULL,
  regime              text          NOT NULL,
  session             text          NOT NULL,
  vol_bucket          text          NOT NULL,
  news_state          text          NOT NULL,
  setup_key           text          NOT NULL,                  -- the setup instance: pullback leg, sweep, trendline break, pattern
  open_signals_at_entry integer     NOT NULL DEFAULT 0,
  warnings            jsonb         NOT NULL DEFAULT '[]'::jsonb,   -- advisory flags present at creation
  chart_objects       jsonb         NOT NULL DEFAULT '[]'::jsonb,   -- trendlines, zones, patterns with coordinates
  quality_score       numeric(5,2)  NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
  grouped_scores      jsonb         NOT NULL,
  hard_gates          jsonb         NOT NULL,
  feature_snapshot    jsonb         NOT NULL,                  -- every feature, including research-only
  explanation         jsonb         NOT NULL,                  -- structured reasons (see 02_Signal_Engine)
  evidence            jsonb         NOT NULL,                  -- historical stats exactly as shown at creation
  data_latency_ms     integer,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  CHECK ((side = 'BUY' AND stop_loss < entry AND tp1 > entry) OR (side = 'SELL' AND stop_loss > entry AND tp1 < entry))
);
CREATE INDEX signals_generated_idx ON signals (generated_at DESC);
CREATE INDEX signals_strategy_idx  ON signals (strategy_version_id, generated_at DESC);
CREATE UNIQUE INDEX signals_setup_once_idx ON signals (strategy_version_id, side, setup_key);

CREATE TRIGGER signals_append_only BEFORE UPDATE OR DELETE ON signals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER signals_no_truncate BEFORE TRUNCATE ON signals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Mutable working state of an open signal. Deleted only together with its outcome being written.
CREATE TABLE signal_state (
  signal_id          uuid PRIMARY KEY REFERENCES signals(id),
  status             text          NOT NULL CHECK (status IN ('ACTIVE','TP1_HIT','CLOSED')),
  stop_loss_current  numeric(12,3) NOT NULL,
  tp1_hit_at         timestamptz,
  mfe_r              numeric(8,3)  NOT NULL DEFAULT 0,
  mae_r              numeric(8,3)  NOT NULL DEFAULT 0,
  updated_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE signal_events (
  id          bigserial PRIMARY KEY,
  signal_id   uuid        NOT NULL REFERENCES signals(id),
  event_type  text        NOT NULL CHECK (event_type IN
              ('CREATED','ALERT_QUEUED','TP1_HIT','STOP_MOVED_TO_ENTRY','TP2_HIT','SL_HIT','TIME_EXIT',
               'CANCELLED','DATA_INVALID','AUTOPSY_PRELIMINARY','AUTOPSY_FINAL')),
  event_at    timestamptz NOT NULL,
  price       numeric(12,3),
  meta        jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX signal_events_signal_idx ON signal_events (signal_id, event_at);
CREATE TRIGGER signal_events_append_only BEFORE UPDATE OR DELETE ON signal_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER signal_events_no_truncate BEFORE TRUNCATE ON signal_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE signal_outcomes (
  signal_id        uuid PRIMARY KEY REFERENCES signals(id),
  result           text          NOT NULL CHECK (result IN
                   ('WIN','PARTIAL_WIN','LOSS','TIME_EXIT','CANCELLED','DATA_INVALID')),
  counts_in_stats  boolean       NOT NULL,
  closed_at        timestamptz   NOT NULL,
  exit_price       numeric(12,3),
  exit_reason      text          NOT NULL,
  realized_r_gross numeric(8,3),
  cost_r           numeric(8,3)  NOT NULL DEFAULT 0,
  realized_r_net   numeric(8,3),
  duration_s       integer       NOT NULL,
  mfe_r            numeric(8,3),
  mae_r            numeric(8,3),
  tp1_hit          boolean       NOT NULL DEFAULT false,
  tp2_hit          boolean       NOT NULL DEFAULT false,
  ambiguous        boolean       NOT NULL DEFAULT false,
  is_win           boolean GENERATED ALWAYS AS (counts_in_stats AND realized_r_net > 0) STORED,
  meta             jsonb         NOT NULL DEFAULT '{}'::jsonb,
  CHECK (counts_in_stats = false OR realized_r_net IS NOT NULL)
);
CREATE INDEX signal_outcomes_closed_idx ON signal_outcomes (closed_at DESC);
CREATE TRIGGER signal_outcomes_append_only BEFORE UPDATE OR DELETE ON signal_outcomes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER signal_outcomes_no_truncate BEFORE TRUNCATE ON signal_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Analysis, not canonical: allowed to move from PRELIMINARY to FINAL.
CREATE TABLE signal_autopsies (
  signal_id            uuid PRIMARY KEY REFERENCES signals(id),
  status               text        NOT NULL CHECK (status IN ('PRELIMINARY','FINAL')),
  primary_cause        text        NOT NULL,
  causes               jsonb       NOT NULL,     -- [{code, evidence:{...}}]
  weak_groups_at_entry jsonb       NOT NULL,
  counterfactual       jsonb,                    -- e.g. {"reachedTp1": true, "candlesToTp1": 7}
  computed_at          timestamptz NOT NULL,
  finalized_at         timestamptz
);

-- Setups that failed only because of a gate. Short retention, feeds "WAIT: reason" on the dashboard.
CREATE TABLE rejections (
  id             bigserial PRIMARY KEY,
  at             timestamptz  NOT NULL,
  strategy_key   text         NOT NULL,
  side           text         NOT NULL CHECK (side IN ('BUY','SELL')),
  failed_gates   text[]       NOT NULL,
  quality_score  numeric(5,2),
  detail         jsonb        NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX rejections_at_idx ON rejections (at DESC);

-- ============================================================
-- statistics rollups (maintained at signal close, reconciled nightly)
-- ============================================================
CREATE TABLE stats_bucket (
  scope        text        NOT NULL CHECK (scope IN ('FORWARD','BACKTEST_OOS')),
  level        smallint    NOT NULL CHECK (level BETWEEN 0 AND 4),   -- 0 exact bucket ... 4 strategy+side only
  bucket_key   text        NOT NULL,
  n            integer     NOT NULL DEFAULT 0,
  wins         integer     NOT NULL DEFAULT 0,
  partials     integer     NOT NULL DEFAULT 0,
  losses       integer     NOT NULL DEFAULT 0,
  time_exits   integer     NOT NULL DEFAULT 0,
  tp1_hits     integer     NOT NULL DEFAULT 0,
  tp2_hits     integer     NOT NULL DEFAULT 0,
  sum_r        numeric     NOT NULL DEFAULT 0,
  sum_win_r    numeric     NOT NULL DEFAULT 0,
  sum_loss_r   numeric     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, level, bucket_key)
);

CREATE TABLE stats_monthly (
  month          date        NOT NULL,                 -- first day of the month (UTC)
  strategy_key   text        NOT NULL DEFAULT '*',      -- '*' means all strategies
  generated      integer     NOT NULL DEFAULT 0,
  resolved_valid integer     NOT NULL DEFAULT 0,
  wins           integer     NOT NULL DEFAULT 0,
  partials       integer     NOT NULL DEFAULT 0,
  losses         integer     NOT NULL DEFAULT 0,
  time_exits     integer     NOT NULL DEFAULT 0,
  cancelled      integer     NOT NULL DEFAULT 0,
  data_invalid   integer     NOT NULL DEFAULT 0,
  net_r          numeric     NOT NULL DEFAULT 0,
  sum_win_r      numeric     NOT NULL DEFAULT 0,
  sum_loss_r     numeric     NOT NULL DEFAULT 0,
  PRIMARY KEY (month, strategy_key)
);

CREATE TABLE evidence_group_stats (
  scope        text    NOT NULL CHECK (scope IN ('FORWARD','BACKTEST_OOS')),
  strategy_key text    NOT NULL,
  group_key    text    NOT NULL,
  state        text    NOT NULL CHECK (state IN ('STRONG','OK','WEAK','FAIL','NA')),
  n            integer NOT NULL DEFAULT 0,
  wins         integer NOT NULL DEFAULT 0,
  sum_r        numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, strategy_key, group_key, state)
);

CREATE TABLE failure_cause_stats (
  month        date    NOT NULL,
  strategy_key text    NOT NULL,
  cause_code   text    NOT NULL,
  n            integer NOT NULL DEFAULT 0,
  sum_r        numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (month, strategy_key, cause_code)
);

-- ============================================================
-- notifications
-- ============================================================
CREATE TABLE notification_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key           text        NOT NULL,            -- e.g. signal:<id>:confirmed
  channel             text        NOT NULL CHECK (channel IN ('telegram','webpush')),
  kind                text        NOT NULL,
  signal_id           uuid REFERENCES signals(id),
  payload             jsonb       NOT NULL,
  status              text        NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','SENDING','SENT','FAILED','DEAD','EXPIRED')),
  attempts            integer     NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,                     -- stale alerts are dropped, not sent late
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  provider_message_id text,
  last_error          text,
  UNIQUE (event_key, channel)
);
CREATE INDEX outbox_due_idx ON notification_outbox (next_attempt_at) WHERE status IN ('PENDING','FAILED');

CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint    text        NOT NULL UNIQUE,
  p256dh      text        NOT NULL,
  auth        text        NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz
);

-- ============================================================
-- macro calendar
-- ============================================================
CREATE TABLE macro_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source               text        NOT NULL,
  source_event_id      text        NOT NULL,           -- instance id from the provider
  scheduled_at         timestamptz NOT NULL,
  country_code         text,
  currency             text,
  name                 text        NOT NULL,
  importance           text        NOT NULL CHECK (importance IN ('low','medium','high')),
  unit                 text,
  multiplier           text,
  actual               numeric,
  forecast             numeric,
  previous             numeric,
  revised_previous     numeric,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  actual_first_seen_at timestamptz,                    -- when we first saw the released value
  last_updated_at      timestamptz NOT NULL DEFAULT now(),
  raw                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source, source_event_id)
);
CREATE INDEX macro_events_time_idx ON macro_events (scheduled_at);

-- Unscheduled headlines: title, link and a short summary only, never full article text.
CREATE TABLE news_sources (
  key         text PRIMARY KEY,
  name        text        NOT NULL,
  tier        smallint    NOT NULL CHECK (tier BETWEEN 1 AND 3),   -- 1 official, 2 major outlet, 3 aggregator
  enabled     boolean     NOT NULL DEFAULT true,
  last_ok_at  timestamptz,
  last_error  text
);

CREATE TABLE news_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key         text         NOT NULL REFERENCES news_sources(key),
  url_hash           text         NOT NULL,
  title              text         NOT NULL,
  url                text         NOT NULL,
  summary            text         CHECK (summary IS NULL OR length(summary) <= 300),
  published_at       timestamptz,
  first_seen_at      timestamptz  NOT NULL DEFAULT now(),
  topics             text[]       NOT NULL DEFAULT '{}',
  impact             text         NOT NULL CHECK (impact IN ('LOW','MEDIUM','HIGH')),
  impact_score       numeric(5,2) NOT NULL DEFAULT 0,
  cluster_id         uuid         NOT NULL,                        -- same story from several outlets
  classifier_version text         NOT NULL,
  UNIQUE (source_key, url_hash)
);
CREATE INDEX news_items_seen_idx    ON news_items (first_seen_at DESC);
CREATE INDEX news_items_cluster_idx ON news_items (cluster_id);

-- Sudden gold moves with the headlines that were visible at that moment (frozen copy, survives pruning).
CREATE TABLE market_events (
  id          bigserial PRIMARY KEY,
  kind        text         NOT NULL CHECK (kind IN ('SPIKE_UP','SPIKE_DOWN')),
  detected_at timestamptz  NOT NULL,
  window_s    integer      NOT NULL,
  move_usd    numeric(8,3) NOT NULL,
  move_atr    numeric(6,2) NOT NULL,
  spread      numeric(8,3),
  headlines   jsonb        NOT NULL DEFAULT '[]'::jsonb,
  meta        jsonb        NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX market_events_time_idx ON market_events (detected_at DESC);

-- Evidence behind the impact labels: what gold actually did after each stored headline cluster.
CREATE TABLE news_impact_samples (
  cluster_id    uuid          PRIMARY KEY,
  topics        text[]        NOT NULL,
  impact        text          NOT NULL CHECK (impact IN ('LOW','MEDIUM','HIGH')),
  published_at  timestamptz   NOT NULL,
  session       text          NOT NULL,
  atr5          numeric(12,3) NOT NULL,
  move_2m       numeric(8,3),             -- signed USD move after publication
  move_5m       numeric(8,3),
  move_10m      numeric(8,3),
  max_abs_10m   numeric(8,3)              -- largest excursion within 10 minutes
);
CREATE INDEX news_impact_samples_time_idx ON news_impact_samples (published_at DESC);

CREATE TABLE news_topic_stats (
  topic                     text        NOT NULL,
  impact                    text        NOT NULL CHECK (impact IN ('LOW','MEDIUM','HIGH')),
  n                         integer     NOT NULL DEFAULT 0,
  moved_1atr                integer     NOT NULL DEFAULT 0,   -- max_abs_10m >= 1 x ATR(5m)
  sum_abs_atr_10m           numeric     NOT NULL DEFAULT 0,
  sum_signed_atr_10m        numeric     NOT NULL DEFAULT 0,
  baseline_moved_1atr_share numeric,                          -- same statistic over ordinary windows
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic, impact)
);

-- ============================================================
-- auth, settings, audit, health
-- ============================================================
CREATE TABLE auth_owner (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- exactly one owner
  username           text        NOT NULL,
  password_hash      text        NOT NULL,
  totp_secret_enc    bytea,
  totp_enabled       boolean     NOT NULL DEFAULT false,
  recovery_code_hashes text[]    NOT NULL DEFAULT '{}',
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id_hash      text PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip_hash      text,
  ua_hash      text
);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE login_attempts (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  ip_hash  text        NOT NULL,
  success  boolean     NOT NULL
);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip_hash, at DESC);

CREATE TABLE security_audit_events (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  event_type text        NOT NULL,
  success    boolean     NOT NULL,
  ip_hash    text,
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE app_settings (
  -- keys: displayTz, locale, alerts, advisoryGates, strategyAlerts, engine (owner pause state)
  key         text PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE worker_heartbeats (
  worker_name  text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE maintenance_runs (
  id            bigserial PRIMARY KEY,
  job           text        NOT NULL,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz,
  rows_deleted  bigint      NOT NULL DEFAULT 0,
  db_size_bytes bigint,
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- ============================================================
-- views
-- ============================================================
CREATE VIEW signal_history_v AS
SELECT
  s.id AS signal_id,
  s.seq,
  s.generated_at,
  s.side,
  s.mode,
  sv.strategy_key,
  sv.version AS strategy_version,
  sv.status  AS strategy_status,
  s.exit_profile,
  s.entry, s.stop_loss, s.tp1, s.tp2, s.risk_distance,
  s.regime, s.session, s.vol_bucket, s.news_state, s.quality_score,
  s.open_signals_at_entry, s.warnings,
  (s.evidence ->> 'winRate')::numeric AS evidence_win_rate,
  (s.evidence ->> 'n')::integer       AS evidence_n,
  COALESCE(st.status, 'CLOSED')       AS state,
  o.result, o.counts_in_stats, o.is_win,
  o.closed_at, o.exit_price, o.exit_reason,
  o.realized_r_net, o.mfe_r, o.mae_r, o.duration_s, o.tp1_hit, o.tp2_hit, o.ambiguous,
  a.primary_cause, a.status AS autopsy_status
FROM signals s
JOIN strategy_versions sv ON sv.id = s.strategy_version_id
LEFT JOIN signal_state st ON st.signal_id = s.id AND st.status <> 'CLOSED'
LEFT JOIN signal_outcomes o ON o.signal_id = s.id
LEFT JOIN signal_autopsies a ON a.signal_id = s.id;

CREATE VIEW storage_usage_v AS
SELECT c.relname AS table_name,
       pg_total_relation_size(c.oid) AS total_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
ORDER BY total_bytes DESC;

-- ============================================================
-- roles (created by the deploy script; shown here as the intended privilege split)
-- vmgs_worker: SELECT/INSERT/UPDATE on market, signal, stats, outbox, calendar, health tables; no access to auth_*.
-- vmgs_api:    SELECT on everything except auth_*; full access to auth_*, app_settings,
--              push_subscriptions, security_audit_events; no INSERT on signals or outcomes.
-- ============================================================
