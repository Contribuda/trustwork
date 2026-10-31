-- Local compose stack only (OPS-002): the operations step that production performs once per cluster before the
-- first migration (packages/data/README.md, "Roles"; apps/worker/README.md). Run by the db-roles service as the local
-- superuser. Creates the stack database, the NOLOGIN groups exactly as the migration bootstrap would, the migrator
-- login (member of trustwork_owner with SET, never a runtime group) and one login per runtime process. Role names are
-- prefixed trustwork_stack_ so the stack never touches roles of development seeds or test runs on a shared cluster.
-- Passwords come from the environment of the db-roles service; the defaults in compose.yaml are local-only values.
\set ON_ERROR_STOP on
\getenv migrator_password TRUSTWORK_STACK_MIGRATOR_PASSWORD
\getenv api_password TRUSTWORK_STACK_API_PASSWORD
\getenv worker_password TRUSTWORK_STACK_WORKER_PASSWORD

SELECT 'CREATE DATABASE trustwork_stack' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'trustwork_stack') \gexec

-- Same attributes as bootstrap() in packages/data/src/migrate/runner.ts, which skips roles that already exist.
SELECT 'CREATE ROLE trustwork_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustwork_owner') \gexec
SELECT 'CREATE ROLE trustwork_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustwork_app') \gexec
SELECT 'CREATE ROLE trustwork_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustwork_worker') \gexec
-- Only a superuser can grant this; the migrator's bootstrap then finds it present.
GRANT SET ON PARAMETER trustwork.maintenance TO trustwork_owner;

-- Migrator: CREATEROLE for future bootstrap groups; member of the owner role with SET (migrations run under SET ROLE)
-- and INHERIT (the runner reads the ledger in the owner's schema before switching); CREATE on the stack database.
SELECT format('CREATE ROLE trustwork_stack_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE INHERIT PASSWORD %L', :'migrator_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustwork_stack_migrator') \gexec
SELECT format('ALTER ROLE trustwork_stack_migrator PASSWORD %L', :'migrator_password') \gexec
GRANT trustwork_owner TO trustwork_stack_migrator WITH SET TRUE, INHERIT TRUE;
GRANT CREATE ON DATABASE trustwork_stack TO trustwork_stack_migrator;

-- Runtime logins: the API is a member of trustwork_app only, the worker of trustwork_worker only.
SELECT format('CREATE ROLE trustwork_stack_api LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT IN ROLE trustwork_app PASSWORD %L', :'api_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustwork_stack_api') \gexec
SELECT format('ALTER ROLE trustwork_stack_api PASSWORD %L', :'api_password') \gexec
SELECT format('CREATE ROLE trustwork_stack_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT IN ROLE trustwork_worker PASSWORD %L', :'worker_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustwork_stack_worker') \gexec
SELECT format('ALTER ROLE trustwork_stack_worker PASSWORD %L', :'worker_password') \gexec
