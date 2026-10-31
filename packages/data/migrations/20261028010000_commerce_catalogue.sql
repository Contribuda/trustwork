-- COM-001 catalogue: reusable offerings (goods / works / services / bundle) with immutable published versions,
-- bundle components as rows, private commercial knowledge in a separate party-private table, FORCE RLS and an
-- owner-run public projection lookup (published versions only; the service applies the public_fields allowlist).

CREATE TABLE trustwork.offering (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  kind text NOT NULL CHECK (kind IN ('goods', 'works', 'services', 'bundle')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  current_version integer NULL CHECK (current_version IS NULL OR current_version >= 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offering_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL))
);
CREATE INDEX offering_owner_person_idx ON trustwork.offering (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX offering_owner_company_idx ON trustwork.offering (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE TRIGGER offering_touch BEFORE UPDATE ON trustwork.offering FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- payload = OfferingVersionPayload without `components` (rows below); public_fields = allowlist of payload keys.
CREATE TABLE trustwork.offering_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  offering_id uuid NOT NULL REFERENCES trustwork.offering (id),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  public_fields text[] NOT NULL DEFAULT '{}' CHECK (public_fields <@ ARRAY['title', 'description', 'specification', 'unit', 'listPrice', 'options', 'availability']::text[]),
  published_at timestamptz NULL,
  published_by uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offering_version_unique UNIQUE (offering_id, version),
  CONSTRAINT offering_version_published_shape CHECK ((status = 'draft') = (published_at IS NULL AND published_by IS NULL))
);
CREATE TRIGGER offering_version_touch BEFORE UPDATE ON trustwork.offering_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
-- Published versions are immutable (R06): payload and publication facts freeze once the status leaves `draft`.
CREATE TRIGGER offering_version_frozen BEFORE UPDATE ON trustwork.offering_version FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'payload', 'published_at', 'published_by');

-- Mixed bundles: a published version references exact published versions of component offerings.
CREATE TABLE trustwork.bundle_component (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  offering_version_id uuid NOT NULL REFERENCES trustwork.offering_version (id),
  position integer NOT NULL CHECK (position >= 0),
  component_offering_id uuid NOT NULL REFERENCES trustwork.offering (id),
  component_version integer NOT NULL CHECK (component_version >= 1),
  quantity_value text NOT NULL CHECK (quantity_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$'),
  quantity_unit text NOT NULL CHECK (quantity_unit ~ '^[a-z][a-z0-9_]{0,15}$'),
  CONSTRAINT bundle_component_position_unique UNIQUE (offering_version_id, position),
  CONSTRAINT bundle_component_version_fk FOREIGN KEY (component_offering_id, component_version) REFERENCES trustwork.offering_version (offering_id, version)
);
CREATE INDEX bundle_component_version_idx ON trustwork.bundle_component (offering_version_id);

-- Private commercial knowledge (cost basis, margin target, notes): never joined into any public or shared read.
CREATE TABLE trustwork.offering_version_private (
  offering_version_id uuid PRIMARY KEY REFERENCES trustwork.offering_version (id),
  offering_id uuid NOT NULL REFERENCES trustwork.offering (id),
  private_knowledge jsonb NOT NULL DEFAULT '{"costBasis": null, "marginTarget": null, "notes": null}'::jsonb CHECK (jsonb_typeof(private_knowledge) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER offering_version_private_touch BEFORE UPDATE ON trustwork.offering_version_private FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Ownership of an offering for the current principal (person owner or active employer owner).
CREATE FUNCTION trustwork.owns_offering(p_offering_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.offering o WHERE o.id = p_offering_id
      AND (o.owner_person_id = trustwork.current_person_id() OR (o.owner_company_id IS NOT NULL AND o.owner_company_id = trustwork.current_company_id()))
  )
$$;
GRANT EXECUTE ON FUNCTION trustwork.owns_offering(uuid) TO trustwork_app;

ALTER TABLE trustwork.offering ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offering FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offering_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offering_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bundle_component ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bundle_component FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offering_version_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offering_version_private FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.offering AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.offering_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.bundle_component AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.offering_version_private AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Active offerings exist publicly for any identity (the service applies the field allowlist); drafts/archived are owner-only.
CREATE POLICY offering_read ON trustwork.offering FOR SELECT TO trustwork_app
  USING (trustwork.current_person_id() IS NOT NULL AND (status = 'active' OR owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id()));
CREATE POLICY offering_insert ON trustwork.offering FOR INSERT TO trustwork_app
  WITH CHECK (created_by = trustwork.current_person_id() AND (owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id()));
CREATE POLICY offering_update ON trustwork.offering FOR UPDATE TO trustwork_app
  USING (owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id())
  WITH CHECK (owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id());

CREATE POLICY offering_version_read ON trustwork.offering_version FOR SELECT TO trustwork_app
  USING (trustwork.current_person_id() IS NOT NULL AND (status <> 'draft' OR trustwork.owns_offering(offering_id)));
CREATE POLICY offering_version_write ON trustwork.offering_version FOR INSERT TO trustwork_app WITH CHECK (trustwork.owns_offering(offering_id));
CREATE POLICY offering_version_update ON trustwork.offering_version FOR UPDATE TO trustwork_app USING (trustwork.owns_offering(offering_id)) WITH CHECK (trustwork.owns_offering(offering_id));

CREATE POLICY bundle_component_read ON trustwork.bundle_component FOR SELECT TO trustwork_app
  USING (trustwork.current_person_id() IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.offering_version v WHERE v.id = offering_version_id AND (v.status <> 'draft' OR trustwork.owns_offering(v.offering_id))));
CREATE POLICY bundle_component_write ON trustwork.bundle_component FOR INSERT TO trustwork_app
  WITH CHECK (EXISTS (SELECT 1 FROM trustwork.offering_version v WHERE v.id = offering_version_id AND trustwork.owns_offering(v.offering_id)));

CREATE POLICY offering_version_private_own ON trustwork.offering_version_private FOR ALL TO trustwork_app
  USING (trustwork.owns_offering(offering_id)) WITH CHECK (trustwork.owns_offering(offering_id));

GRANT SELECT, INSERT, UPDATE (kind, status, current_version) ON trustwork.offering TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (status, payload, public_fields, published_at, published_by) ON trustwork.offering_version TO trustwork_app;
GRANT SELECT, INSERT ON trustwork.bundle_component TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (private_knowledge) ON trustwork.offering_version_private TO trustwork_app;

-- Anonymous public projection: published versions of active offerings only; the caller still applies public_fields.
CREATE FUNCTION trustwork.public_offering_version_read(p_offering_id uuid, p_version integer)
RETURNS TABLE (offering_id uuid, version integer, payload jsonb, public_fields text[], published_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT v.offering_id, v.version, v.payload, v.public_fields, v.published_at
  FROM trustwork.offering_version v JOIN trustwork.offering o ON o.id = v.offering_id
  WHERE v.offering_id = p_offering_id AND v.status = 'published' AND o.status = 'active'
    AND v.version = coalesce(p_version, o.current_version)
$$;
GRANT EXECUTE ON FUNCTION trustwork.public_offering_version_read(uuid, integer) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
