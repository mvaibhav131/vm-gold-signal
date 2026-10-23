-- Roles and privileges (01_HLD section 8 and the roles note at the end of 0001).
--
-- Two application roles, least privilege:
--   vmgs_worker  writes market and signal data. It never touches the auth_* tables.
--   vmgs_api     reads everything except the auth_* tables, and writes auth, settings, push
--                subscriptions, the security audit and test notifications. It cannot insert signals,
--                events or outcomes.
-- The roles are created without a password and without LOGIN. The deploy script gives each one a
-- password from the root-owned .env (ALTER ROLE ... LOGIN PASSWORD ...), so no secret lives in git.
--
-- Every new table needs a decision here (or in a later migration): the roles test fails for a table
-- that has no entry in its privilege matrix.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vmgs_worker') THEN
    CREATE ROLE vmgs_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vmgs_api') THEN
    CREATE ROLE vmgs_api NOLOGIN;
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vmgs_worker, vmgs_api;

-- Partition maintenance runs DDL. The functions run with the owner's rights, so the worker can
-- create and drop tick partitions without any CREATE right on the schema. Nobody else may call them.
ALTER FUNCTION ensure_tick_partitions(integer) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION drop_old_tick_partitions(integer) SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION ensure_tick_partitions(integer), drop_old_tick_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_tick_partitions(integer), drop_old_tick_partitions(integer) TO vmgs_worker;

-- ============================================================
-- vmgs_worker
-- ============================================================
-- Immutable tables (signals, signal_events, signal_outcomes) get no UPDATE or DELETE grant at all;
-- the append-only triggers stay as the second line of defence.
GRANT SELECT, INSERT ON ticks, signals, signal_events, signal_outcomes TO vmgs_worker;
GRANT SELECT ON experiments, signal_history_v, storage_usage_v TO vmgs_worker;
GRANT SELECT, INSERT, UPDATE ON strategy_versions, signal_autopsies TO vmgs_worker;
GRANT SELECT, INSERT, UPDATE ON stats_bucket, stats_monthly, evidence_group_stats, failure_cause_stats TO vmgs_worker;
GRANT SELECT, INSERT, UPDATE ON macro_events, news_sources, news_impact_samples, news_topic_stats TO vmgs_worker;
GRANT SELECT, INSERT, UPDATE ON app_settings, worker_heartbeats TO vmgs_worker;
-- Tables with retention jobs or a working state also need DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON candles, feed_incidents, signal_state, notification_outbox TO vmgs_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_items, maintenance_runs TO vmgs_worker;
GRANT SELECT, INSERT, DELETE ON rejections, market_events TO vmgs_worker;
-- The worker reads subscriptions to send Web Push, and removes the ones the push service has dropped.
GRANT SELECT, UPDATE, DELETE ON push_subscriptions TO vmgs_worker;

-- ============================================================
-- vmgs_api
-- ============================================================
GRANT SELECT ON
  ticks, candles, feed_incidents, strategy_versions, experiments,
  signals, signal_state, signal_events, signal_outcomes, signal_autopsies, rejections,
  stats_bucket, stats_monthly, evidence_group_stats, failure_cause_stats,
  macro_events, news_sources, news_items, market_events, news_impact_samples, news_topic_stats,
  worker_heartbeats, maintenance_runs, signal_history_v, storage_usage_v
  TO vmgs_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  auth_owner, auth_sessions, login_attempts, security_audit_events,
  app_settings, push_subscriptions
  TO vmgs_api;
-- "Send test message" queues an outbox row; the worker sends it.
GRANT SELECT, INSERT ON notification_outbox TO vmgs_api;

-- Identity and serial columns need USAGE on their sequences for every role that may INSERT.
GRANT USAGE ON SEQUENCE
  signals_seq_seq, signal_events_id_seq, feed_incidents_id_seq, rejections_id_seq,
  market_events_id_seq, maintenance_runs_id_seq
  TO vmgs_worker;
GRANT USAGE ON SEQUENCE login_attempts_id_seq, security_audit_events_id_seq TO vmgs_api;
