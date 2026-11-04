-- CLM-001, audit follow-up. `directory_correct_company_country` asks for `admin.claims.authority.decide`, and no role held
-- it: company country corrections could not run, and a claim on a company with no country waited for one for ever.
--
-- The founding `node-operator` takes it. It is the one role the setup wizard releases, so without this a new node has
-- nobody who can hold the permission, and it already holds the other place authority (`admin.hub.country.edit`,
-- `admin.hub.jurisdiction.edit`). It holds no `admin.claims.decide`, so whoever corrects a country this way cannot also
-- hand the company over, on top of `claims_refuse_own_correction`.
--
-- This changes what setup releases from now on. A node that already released version 1 keeps it: definitions and
-- assignments are immutable, so its operator releases a new version and assigns it with a second person.
CREATE OR REPLACE FUNCTION trustwork.setup_founding_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.audit.read', 'admin.claims.authority.decide', 'admin.config.edit', 'admin.hub.country.edit', 'admin.hub.identity.edit', 'admin.hub.jurisdiction.edit', 'admin.hub.launch.check',
    'admin.hub.legal.edit', 'admin.hub.lifecycle.request', 'admin.hub.modes.edit', 'admin.hub.read', 'admin.hub.residency.edit', 'admin.node.hubs.manage',
    'admin.observability.read', 'admin.providers.connection.edit', 'admin.providers.read', 'admin.session.elevate', 'admin.staff.assign', 'admin.staff.read']::text[]
$$;
