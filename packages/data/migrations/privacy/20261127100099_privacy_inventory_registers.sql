-- REG-001: register facts record staff identities (who bound adapters, ran fake adapters, linked records) and identifiers
-- that may belong to sole proprietors, so privacy subject plans cover them. The database twin of
-- PRIVACY_MODULE_INVENTORY in packages/contracts/src/privacy.ts now lists registers.
CREATE OR REPLACE FUNCTION trustwork.privacy_module_inventory() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['agent-modules','approval-routes','assistant','assistant-goals','billing','catalogue','communications','connections','consultations',
    'content','directory','execution','files','hubs','identity','jurisdiction','models','payments','pipelines','plans','platform-admin',
    'procurement','profiles','projects','providers','registers','reputation','sales','screening','screening-gates','sources',
    'supplier-base','support','tasks','transactions','trust','verification']::text[]
$$;
