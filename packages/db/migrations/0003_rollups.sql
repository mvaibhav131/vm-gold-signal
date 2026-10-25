-- ============================================================
-- migration 0003 (B26, rollups and maintenance): changes to the schema above
-- ============================================================

-- Statistics rollups. A row is filed under the month (UTC) of the decision time of its signal. The number of
-- winners (net R above zero) of a bucket and of a month cannot be rebuilt from the counts by result: a time exit is a
-- winner by the sign of its net R and a partial win whose costs bring it to zero is not (02_Signal_Engine 13.1).
-- `wins` stays the number of WIN results. `sum_win_r` is never negative and `sum_loss_r` never positive, so that
-- sum_r = sum_win_r + sum_loss_r. The rollups are written by the transaction that creates or closes a signal, and the
-- nightly reconciliation holds them to a full recomputation from signals and outcomes (mode LIVE, scope FORWARD).
ALTER TABLE stats_bucket  ADD COLUMN winners integer NOT NULL DEFAULT 0;
ALTER TABLE stats_monthly ADD COLUMN winners integer NOT NULL DEFAULT 0;
ALTER TABLE stats_bucket  ADD CONSTRAINT stats_bucket_r_signs  CHECK (sum_win_r >= 0 AND sum_loss_r <= 0);
ALTER TABLE stats_monthly ADD CONSTRAINT stats_monthly_r_signs CHECK (sum_win_r >= 0 AND sum_loss_r <= 0);

-- Retention of the feature snapshot (01_HLD section 7): after 365 days it is replaced by a small marker
-- `{"pruned": true, "prunedAt": ..., "spread": ...}`. That is the only change a signal may undergo: every other
-- column must stay as it is, the snapshot may only become a marker, and a marker is final. DELETE stays forbidden.
CREATE FUNCTION signals_allow_snapshot_pruning() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND to_jsonb(NEW) - 'feature_snapshot' = to_jsonb(OLD) - 'feature_snapshot'
     AND COALESCE(NEW.feature_snapshot ->> 'pruned', '') = 'true'
     AND COALESCE(OLD.feature_snapshot ->> 'pruned', '') <> 'true'
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME;
END $$;
DROP TRIGGER signals_append_only ON signals;
CREATE TRIGGER signals_append_only BEFORE UPDATE OR DELETE ON signals
  FOR EACH ROW EXECUTE FUNCTION signals_allow_snapshot_pruning();
