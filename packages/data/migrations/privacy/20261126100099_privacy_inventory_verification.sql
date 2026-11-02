-- HUB-003: verification records staff identities (who registered providers, drafted and activated recipes, recorded
-- results) and the subjects of checks, so privacy subject plans cover it. The database twin of
-- PRIVACY_MODULE_INVENTORY in packages/contracts/src/privacy.ts now lists verification.
CREATE OR REPLACE FUNCTION trustwork.privacy_module_inventory() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['agent-modules','approval-routes','assistant','assistant-goals','billing','catalogue','communications','connections','consultations',
    'content','directory','execution','files','hubs','identity','jurisdiction','models','payments','pipelines','plans','platform-admin',
    'procurement','profiles','projects','providers','reputation','sales','screening','screening-gates','sources',
    'supplier-base','support','tasks','transactions','trust','verification']::text[]
$$;
