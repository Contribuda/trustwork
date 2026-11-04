-- PRC-004: sourcing records name the people who prepared sheets and proposed awards, and a person can own an RFQ or
-- receive an outcome notice, so privacy subject plans cover the module. The database twin of PRIVACY_MODULE_INVENTORY in
-- packages/contracts/src/privacy.ts now lists sourcing.
CREATE OR REPLACE FUNCTION trustwork.privacy_module_inventory() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['agent-extensions','agent-modules','approval-routes','assistant','assistant-goals','billing','catalogue','communications','connections','consultations',
    'content','datasets','directory','execution','federation','files','hubs','identity','jurisdiction','models','payments','pipelines','plans','platform-admin',
    'procurement','profiles','projects','providers','registers','reputation','sales','screening','screening-gates','sources','sourcing',
    'supplier-base','support','tasks','transactions','trust','verification']::text[]
$$;
