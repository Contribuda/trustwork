-- PAY-001: raw worker SQL is not authenticated provider evidence.
-- A separately provisioned verifier login receives only USAGE on this schema and EXECUTE on
-- payments_receipt(jsonb). No verifier login or publisher is shipped or created by this migration.
-- The trusted adapter ingress uses that separate pool only after authenticating provider evidence.
REVOKE EXECUTE ON FUNCTION trustwork.payments_receipt(jsonb) FROM trustwork_worker;
