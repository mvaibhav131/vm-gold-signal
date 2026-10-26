-- The backup role (B31).
--
-- The nightly backup connects as vmgs_backup: it may read everything (pg_dump needs that, and the dump has to hold
-- the owner account and the sessions too, or a restore would lose them) and it writes one thing, its own heartbeat
-- (`worker_heartbeats` row `backup`, which the daily digest and the System page read). It can change nothing else.
-- Like the two application roles it is created without a login; the deploy step gives it a password from the .env.
-- This migration changes privileges only; it is not part of docs/03.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vmgs_backup') THEN
    CREATE ROLE vmgs_backup NOLOGIN;
  END IF;
END $$;

GRANT pg_read_all_data TO vmgs_backup;
GRANT USAGE ON SCHEMA public TO vmgs_backup;
GRANT SELECT, INSERT, UPDATE ON worker_heartbeats TO vmgs_backup;
