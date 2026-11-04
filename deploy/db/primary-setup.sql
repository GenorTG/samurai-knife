-- Smart Knife core database — roles and database on the PRIMARY (VPS). Run once as postgres:
--   sudo -u postgres psql -v app_password="'…'" -v owner_password="'…'" -v repl_password="'…'" -f primary-setup.sql
-- Least privilege (docs/DB-DECOUPLING.md §3): knife_owner owns the schema and runs migrations; knife_app reads and writes
-- rows through the tables and the two functions, no DDL, no TRUNCATE; knife_replicator only replicates.
-- The learn-db course database is a different cluster (its own sidecar) and never sees these roles.

CREATE ROLE knife_owner LOGIN PASSWORD :owner_password;
CREATE ROLE knife_app LOGIN PASSWORD :app_password CONNECTION LIMIT 12;
CREATE ROLE knife_replicator LOGIN REPLICATION PASSWORD :repl_password CONNECTION LIMIT 4;
CREATE DATABASE knife OWNER knife_owner ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' TEMPLATE template0;
\connect knife
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO knife_app;
-- Tables and functions created later by knife_owner's migrations (scripts/db-migrate.mjs) get the app's grants:
ALTER DEFAULT PRIVILEGES FOR ROLE knife_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knife_app;
ALTER DEFAULT PRIVILEGES FOR ROLE knife_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO knife_app;
ALTER DEFAULT PRIVILEGES FOR ROLE knife_owner IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO knife_app;
-- Per-role safety nets (the app also sets them on its connections).
ALTER ROLE knife_app SET statement_timeout = '10s';
ALTER ROLE knife_app SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE knife_app SET lock_timeout = '5s';
-- The replica's slot: WAL it has not received is kept (bounded by max_slot_wal_keep_size).
SELECT pg_create_physical_replication_slot('genorbox1_delayed');
