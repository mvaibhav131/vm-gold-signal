-- Privileges for the rollups and the maintenance jobs (B26), on top of 0002.
--
-- The worker may remove a row of a rollup table: the nightly reconciliation rewrites the rows that disagree with a
-- full recomputation, and a row that should not exist goes away. It may update the feature snapshot of a signal and
-- nothing else of it (the trigger of 0003 further limits that to replacing the snapshot by a marker, once). It already
-- has DELETE on the tables that have a retention job; the auth tables are pruned by the API, which owns them.

GRANT DELETE ON stats_bucket, stats_monthly, evidence_group_stats, failure_cause_stats TO vmgs_worker;
GRANT UPDATE (feature_snapshot) ON signals TO vmgs_worker;
