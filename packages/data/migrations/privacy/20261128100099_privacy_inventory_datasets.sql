-- MINE-001: datasets record staff identities (who proposed, activated, licensed, marked contact use, added to the
-- do-not-collect list) and records that may concern natural persons, so privacy subject plans cover them. The database
-- twin of PRIVACY_MODULE_INVENTORY in packages/contracts/src/privacy.ts now lists datasets.
CREATE OR REPLACE FUNCTION trustwork.privacy_module_inventory() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['agent-modules','approval-routes','assistant','assistant-goals','billing','catalogue','communications','connections','consultations',
    'content','datasets','directory','execution','files','hubs','identity','jurisdiction','models','payments','pipelines','plans','platform-admin',
    'procurement','profiles','projects','providers','registers','reputation','sales','screening','screening-gates','sources',
    'supplier-base','support','tasks','transactions','trust','verification']::text[]
$$;
