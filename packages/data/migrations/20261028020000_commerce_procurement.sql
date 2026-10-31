-- COM-001 procurement intake: need / need_line (missing-field clarification), rfq envelope, immutable published
-- rfq_version (digest over {payload}), buyer-private constraint in a separate table, rfq_invitation pinned to the exact
-- rfq_version_id with the stale flag, FORCE RLS keyed on ownership + participation, and the anonymous public lookup.
-- Ownership helpers for the new resource kinds are (re)defined in 20261028030000 once every commercial table exists.

CREATE TABLE trustwork.need (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  project_id uuid NULL REFERENCES trustwork.project (id),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'file', 'email', 'assistant')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'clarifying', 'ready', 'converted')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  missing_fields text[] NOT NULL DEFAULT '{}',
  rfq_id uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT need_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL)),
  CONSTRAINT need_converted_shape CHECK ((status = 'converted') = (rfq_id IS NOT NULL))
);
CREATE INDEX need_owner_person_idx ON trustwork.need (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX need_owner_company_idx ON trustwork.need (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE TRIGGER need_touch BEFORE UPDATE ON trustwork.need FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Lines may be incomplete while clarifying: kind, quantity and unit are nullable and reported in need.missing_fields.
CREATE TABLE trustwork.need_line (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  need_id uuid NOT NULL REFERENCES trustwork.need (id),
  position integer NOT NULL CHECK (position >= 0),
  kind text NULL CHECK (kind IS NULL OR kind IN ('goods', 'works', 'services')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  quantity_value text NULL CHECK (quantity_value IS NULL OR quantity_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$'),
  quantity_unit text NULL CHECK (quantity_unit IS NULL OR quantity_unit ~ '^[a-z][a-z0-9_]{0,15}$'),
  specification jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(specification) = 'object'),
  alternatives_allowed boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT need_line_position_unique UNIQUE (need_id, position)
);
CREATE TRIGGER need_line_touch BEFORE UPDATE ON trustwork.need_line FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.rfq (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  project_id uuid NULL REFERENCES trustwork.project (id),
  creator_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'cancelled', 'expired')),
  current_version integer NULL CHECK (current_version IS NULL OR current_version >= 1),
  current_version_id uuid NULL,
  public_projection_enabled boolean NOT NULL DEFAULT false,
  public_projection_fields text[] NOT NULL DEFAULT '{}' CHECK (public_projection_fields <@ ARRAY['title', 'category', 'region', 'publishedAt', 'openUntil', 'lineSummary']::text[]),
  category text NULL CHECK (category IS NULL OR length(category) BETWEEN 1 AND 100),
  -- Set once by the buyer's acceptance; the envelope revision check and the row lock serialise competing acceptances.
  accepted_agreement_id uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL)),
  CONSTRAINT rfq_current_version_shape CHECK ((current_version IS NULL) = (current_version_id IS NULL)),
  CONSTRAINT rfq_draft_has_no_current CHECK (status <> 'draft' OR current_version IS NULL)
);
CREATE INDEX rfq_owner_person_idx ON trustwork.rfq (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX rfq_owner_company_idx ON trustwork.rfq (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE INDEX rfq_project_idx ON trustwork.rfq (project_id) WHERE project_id IS NOT NULL;
CREATE TRIGGER rfq_touch BEFORE UPDATE ON trustwork.rfq FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
ALTER TABLE trustwork.need ADD CONSTRAINT need_rfq_fk FOREIGN KEY (rfq_id) REFERENCES trustwork.rfq (id);

-- digest = trustwork-digest-1 over { payload } (hex), computed by the server at publish; null only while draft.
CREATE TABLE trustwork.rfq_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  rfq_id uuid NOT NULL REFERENCES trustwork.rfq (id),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  digest text NULL CHECK (digest IS NULL OR digest ~ '^[a-f0-9]{64}$'),
  published_at timestamptz NULL,
  published_by uuid NULL REFERENCES trustwork.person (id),
  superseded_by integer NULL CHECK (superseded_by IS NULL OR superseded_by >= 2),
  amendment_reason text NULL CHECK (amendment_reason IS NULL OR length(amendment_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_version_unique UNIQUE (rfq_id, version),
  CONSTRAINT rfq_version_published_shape CHECK ((status = 'draft') = (digest IS NULL AND published_at IS NULL AND published_by IS NULL)),
  CONSTRAINT rfq_version_superseded_shape CHECK ((status = 'superseded') = (superseded_by IS NOT NULL)),
  CONSTRAINT rfq_version_amendment_reason CHECK (version = 1 OR amendment_reason IS NOT NULL)
);
CREATE TRIGGER rfq_version_touch BEFORE UPDATE ON trustwork.rfq_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
-- Invariant 2 / ADR 008: once published, payload, digest and the publication facts never change and the status never returns to draft.
CREATE TRIGGER rfq_version_frozen BEFORE UPDATE ON trustwork.rfq_version FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'payload', 'digest', 'published_at', 'published_by');
ALTER TABLE trustwork.rfq ADD CONSTRAINT rfq_current_version_fk FOREIGN KEY (current_version_id) REFERENCES trustwork.rfq_version (id);

-- Buyer party_private: budget ceiling, weights, notes, shortlist. Separate table, separate projection, never joined into shared views.
CREATE TABLE trustwork.rfq_private_constraint (
  rfq_id uuid PRIMARY KEY REFERENCES trustwork.rfq (id),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  budget_ceiling jsonb NULL CHECK (budget_ceiling IS NULL OR jsonb_typeof(budget_ceiling) = 'object'),
  evaluation_weights jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evaluation_weights) = 'object'),
  internal_notes text NOT NULL DEFAULT '',
  shortlist jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(shortlist) = 'array'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_private_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL))
);
CREATE TRIGGER rfq_private_constraint_touch BEFORE UPDATE ON trustwork.rfq_private_constraint FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Invitations pin the exact rfq_version_id; staleness is a flag (identity test), never a status.
CREATE TABLE trustwork.rfq_invitation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  rfq_id uuid NOT NULL REFERENCES trustwork.rfq (id),
  rfq_version_id uuid NOT NULL REFERENCES trustwork.rfq_version (id),
  party_person_id uuid NULL REFERENCES trustwork.person (id),
  party_company_id uuid NULL REFERENCES trustwork.company (id),
  channel text NOT NULL CHECK (channel IN ('platform', 'email', 'assistant')),
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'viewed', 'declined', 'responded', 'withdrawn')),
  stale_reason text NULL CHECK (stale_reason IS NULL OR stale_reason IN ('rfq_amended', 'rfq_closed')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  sent_by_mandate_id uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_invitation_party_xor CHECK ((party_person_id IS NULL) <> (party_company_id IS NULL))
);
CREATE INDEX rfq_invitation_rfq_idx ON trustwork.rfq_invitation (rfq_id);
CREATE INDEX rfq_invitation_party_person_idx ON trustwork.rfq_invitation (party_person_id) WHERE party_person_id IS NOT NULL;
CREATE INDEX rfq_invitation_party_company_idx ON trustwork.rfq_invitation (party_company_id) WHERE party_company_id IS NOT NULL;
-- One invitation per (version, party).
CREATE UNIQUE INDEX rfq_invitation_one_per_person ON trustwork.rfq_invitation (rfq_version_id, party_person_id) WHERE party_person_id IS NOT NULL;
CREATE UNIQUE INDEX rfq_invitation_one_per_company ON trustwork.rfq_invitation (rfq_version_id, party_company_id) WHERE party_company_id IS NOT NULL;
CREATE TRIGGER rfq_invitation_touch BEFORE UPDATE ON trustwork.rfq_invitation FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- RFQ ownership for the current principal (person owner or active employer owner); the general owns_resource is
-- extended in the next migration once quotes, agreements and orders exist.
CREATE FUNCTION trustwork.owns_rfq(p_rfq_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.rfq r WHERE r.id = p_rfq_id
      AND (r.owner_person_id = trustwork.current_person_id() OR (r.owner_company_id IS NOT NULL AND r.owner_company_id = trustwork.current_company_id()))
  )
$$;
GRANT EXECUTE ON FUNCTION trustwork.owns_rfq(uuid) TO trustwork_app;

ALTER TABLE trustwork.need ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.need FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.need_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.need_line FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.rfq ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.rfq FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.rfq_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.rfq_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.rfq_private_constraint ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.rfq_private_constraint FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.rfq_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.rfq_invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.need AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.need_line AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.rfq AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.rfq_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.rfq_private_constraint AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.rfq_invitation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Needs are owner-only (intake is private until an RFQ version is published).
CREATE POLICY need_own ON trustwork.need FOR ALL TO trustwork_app
  USING (owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id())
  WITH CHECK (created_by = trustwork.current_person_id() AND (owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id()));
CREATE POLICY need_line_own ON trustwork.need_line FOR ALL TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.need n WHERE n.id = need_id AND (n.owner_person_id = trustwork.current_person_id() OR n.owner_company_id = trustwork.current_company_id())))
  WITH CHECK (EXISTS (SELECT 1 FROM trustwork.need n WHERE n.id = need_id AND (n.owner_person_id = trustwork.current_person_id() OR n.owner_company_id = trustwork.current_company_id())));

-- RFQ envelope: the owner party, and any party with a live participation row (invited suppliers get read.shared).
CREATE POLICY rfq_read ON trustwork.rfq FOR SELECT TO trustwork_app
  USING (trustwork.owns_rfq(id) OR trustwork.participates_in_resource('rfq', id));
CREATE POLICY rfq_insert ON trustwork.rfq FOR INSERT TO trustwork_app
  WITH CHECK (creator_person_id = trustwork.current_person_id() AND (owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id()));
CREATE POLICY rfq_update ON trustwork.rfq FOR UPDATE TO trustwork_app USING (trustwork.owns_rfq(id)) WITH CHECK (trustwork.owns_rfq(id));

-- Versions: drafts are owner-only; published/superseded versions are shared with participants.
CREATE POLICY rfq_version_read ON trustwork.rfq_version FOR SELECT TO trustwork_app
  USING (trustwork.owns_rfq(rfq_id) OR (status <> 'draft' AND trustwork.participates_in_resource('rfq', rfq_id)));
CREATE POLICY rfq_version_write ON trustwork.rfq_version FOR INSERT TO trustwork_app WITH CHECK (trustwork.owns_rfq(rfq_id));
CREATE POLICY rfq_version_update ON trustwork.rfq_version FOR UPDATE TO trustwork_app USING (trustwork.owns_rfq(rfq_id)) WITH CHECK (trustwork.owns_rfq(rfq_id));

CREATE POLICY rfq_private_constraint_own ON trustwork.rfq_private_constraint FOR ALL TO trustwork_app
  USING (trustwork.owns_rfq(rfq_id)) WITH CHECK (trustwork.owns_rfq(rfq_id));

-- Invitations: the owner sees all of them; an invited party sees only its own (never the other invitations).
CREATE POLICY rfq_invitation_read ON trustwork.rfq_invitation FOR SELECT TO trustwork_app
  USING (trustwork.owns_rfq(rfq_id) OR party_person_id = trustwork.current_person_id() OR party_company_id = trustwork.current_company_id());
CREATE POLICY rfq_invitation_write ON trustwork.rfq_invitation FOR INSERT TO trustwork_app
  WITH CHECK (sent_by_person_id = trustwork.current_person_id() AND trustwork.owns_rfq(rfq_id));
CREATE POLICY rfq_invitation_update ON trustwork.rfq_invitation FOR UPDATE TO trustwork_app
  USING (trustwork.owns_rfq(rfq_id) OR party_person_id = trustwork.current_person_id() OR party_company_id = trustwork.current_company_id())
  WITH CHECK (trustwork.owns_rfq(rfq_id) OR party_person_id = trustwork.current_person_id() OR party_company_id = trustwork.current_company_id());

GRANT SELECT, INSERT, UPDATE (source, status, title, missing_fields, rfq_id, project_id) ON trustwork.need TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (kind, description, quantity_value, quantity_unit, specification, alternatives_allowed) ON trustwork.need_line TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (status, current_version, current_version_id, public_projection_enabled, public_projection_fields, category, accepted_agreement_id, project_id) ON trustwork.rfq TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (status, payload, digest, published_at, published_by, superseded_by, amendment_reason) ON trustwork.rfq_version TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (budget_ceiling, evaluation_weights, internal_notes, shortlist) ON trustwork.rfq_private_constraint TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (status, stale_reason) ON trustwork.rfq_invitation TO trustwork_app;

-- Anonymous public projection: envelope + current published version of a published RFQ with the projection enabled.
-- The service applies the public_projection_fields allowlist (toPublicRfq); nothing for other ids (not found).
CREATE FUNCTION trustwork.public_rfq_read(p_id uuid)
RETURNS TABLE (id uuid, category text, public_projection_fields text[], version_id uuid, version integer, payload jsonb, digest text, published_at timestamptz, revision integer, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r.id, r.category, r.public_projection_fields, v.id, v.version, v.payload, v.digest, v.published_at, r.revision, r.created_at
  FROM trustwork.rfq r JOIN trustwork.rfq_version v ON v.id = r.current_version_id
  WHERE r.id = p_id AND r.status = 'published' AND r.public_projection_enabled AND v.status = 'published'
$$;
GRANT EXECUTE ON FUNCTION trustwork.public_rfq_read(uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
