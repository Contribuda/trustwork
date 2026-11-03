-- AGT-023: the registry records staff identities (who drafted, approved, asked for a run, changed a status), so privacy
-- subject plans cover it. The database twin of PRIVACY_MODULE_INVENTORY in packages/contracts/src/privacy.ts now lists it.
CREATE OR REPLACE FUNCTION trustwork.privacy_module_inventory() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['agent-extensions','agent-modules','approval-routes','assistant','assistant-goals','billing','catalogue','communications','connections','consultations',
    'content','datasets','directory','execution','files','hubs','identity','jurisdiction','models','payments','pipelines','plans','platform-admin',
    'procurement','profiles','projects','providers','registers','reputation','sales','screening','screening-gates','sources',
    'supplier-base','support','tasks','transactions','trust','verification']::text[]
$$;
