-- The fallback of 0005 (see MigrationFile.fallbackSql): it runs only when `GRANT pg_read_all_data` is refused with 42501,
-- which is what a managed Postgres (a database admin that is not a superuser and has no ADMIN OPTION on that predefined
-- role) answers. 0005 itself is never edited. The same right is given table by table, which is all that pg_dump needs:
-- the tables and the sequences that exist now, and (by default privileges) the ones that the admin creates later.
-- The role itself and the heartbeat right are the same as in 0005.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vmgs_backup') THEN
    CREATE ROLE vmgs_backup NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO vmgs_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vmgs_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO vmgs_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO vmgs_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO vmgs_backup;
GRANT SELECT, INSERT, UPDATE ON worker_heartbeats TO vmgs_backup;
