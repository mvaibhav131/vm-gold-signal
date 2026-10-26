-- The API may read which migrations were applied (B30).
--
-- GET /health/ready answers "ok" only when the database is at the version this build expects, and that is the one thing
-- the API cannot know without reading `schema_migrations`. It is a table of version numbers, names and checksums:
-- nothing in it is private. The roles still cannot change it.
-- This migration changes privileges only; it is not part of docs/03.

GRANT SELECT ON schema_migrations TO vmgs_api;
