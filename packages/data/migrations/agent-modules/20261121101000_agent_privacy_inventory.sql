-- AGT-003: the agent module registry holds personal data (mandates, occurrences, invocations), so privacy subject
-- plans must cover it. The plan snapshot inventory (PRV-001) is the database twin of PRIVACY_MODULE_INVENTORY in
-- packages/contracts/src/privacy.ts; both now list agent-modules first.
CREATE OR REPLACE FUNCTION trustwork.privacy_module_inventory() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['agent-modules','approval-routes','assistant','assistant-goals','billing','catalogue','communications','connections','consultations',
    'content','directory','execution','files','hubs','identity','jurisdiction','models','plans','platform-admin',
    'procurement','profiles','projects','providers','reputation','sales','screening','screening-gates','sources',
    'supplier-base','support','tasks','transactions','trust']::text[]
$$;
