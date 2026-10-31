-- OPS-001: the API readiness probe (`GET /health/ready`) verifies the migration ledger with the restricted runtime
-- role. The ledger holds migration file names, checksums, timestamps, durations and the migrator role name: no
-- personal or business data. Read-only; the runtime role still cannot change the ledger.
GRANT SELECT ON trustwork.migration_ledger TO trustwork_app;
