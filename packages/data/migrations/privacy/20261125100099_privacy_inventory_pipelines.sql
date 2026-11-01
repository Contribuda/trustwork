-- PIPE-001: pipelines records staff identities (who created, drafted, activated, triggered, paused or decided), so
-- privacy subject plans cover it. The database twin of PRIVACY_MODULE_INVENTORY in packages/contracts/src/privacy.ts
-- now lists pipelines.
CREATE OR REPLACE FUNCTION trustwork.privacy_module_inventory() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['agent-modules','approval-routes','assistant','assistant-goals','billing','catalogue','communications','connections','consultations',
    'content','directory','execution','files','hubs','identity','jurisdiction','models','payments','pipelines','plans','platform-admin',
    'procurement','profiles','projects','providers','reputation','sales','screening','screening-gates','sources',
    'supplier-base','support','tasks','transactions','trust']::text[]
$$;
