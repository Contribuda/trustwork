-- COM-001 commerce slice 1: the catalogue (versioned offerings, bundle components, private commercial knowledge), needs
-- with append-only line sets, RFQs with immutable published versions, the buyer-private constraint and invitations
-- pinned to the exact rfq_version_id. Supersedes the unmerged draft of pull request #36 (reviewed and rewritten here).
--
-- Mirrors packages/contracts/src/catalogue.ts, procurement.ts and commerce.ts. Every table is under FORCE RLS; the
-- owner side of an offering is the owner person or members of the owner company holding company.catalogue.edit; the
-- owner side of a need is the owner person or members holding company.deals.manage; the owner side of an RFQ follows
-- the access policy (owner person, owner company members with company.deals.manage, company.publish for `publish`, or
-- a live participation with a party-private or owner-private audience carrying the capability). Invited suppliers
-- read the RFQ envelope, the versions their own invitations pin and their own invitations, never the private
-- constraint, drafts or other invitations. Public reads go through owner-run functions that return allowlisted fields.
--
-- Payment never reaches anything here: no column, function or ordering reads billing, entitlement or sponsorship data.

-- 0. Access helpers ---------------------------------------------------------------------------------------------------
-- Invoker helper (reads no table itself): the principal acts for a party, a company only through members holding the
-- given permission. Permissions outside the commerce vocabulary always deny.
CREATE FUNCTION trustwork.commerce_party_acts(p_person_id uuid, p_company_id uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.current_person_id() IS NOT NULL
    AND p_permission IN ('company.deals.manage', 'company.catalogue.edit', 'company.publish')
    AND (coalesce(p_person_id = trustwork.current_person_id(), false)
         OR (p_company_id IS NOT NULL AND coalesce(p_company_id = trustwork.current_company_id(), false) AND trustwork.current_membership_has(p_permission)))
$$;

-- A place code (`US-CA`, `US-CA:san-diego-county`) is checked against the restricted list; free text is not a code.
CREATE FUNCTION trustwork.commerce_region_restricted(p_region text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_region IS NOT NULL AND p_region ~ '^[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$' AND trustwork.kernel_place_restricted(p_region)
$$;

CREATE FUNCTION trustwork.commerce_retained() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are retained (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
END $$;

-- 1. Catalogue --------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.offering (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  kind text NOT NULL CHECK (kind IN ('goods', 'works', 'services', 'bundle')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  current_version integer NULL CHECK (current_version >= 1),
  current_version_id uuid NULL,
  archived_reason text NULL CHECK (length(archived_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offering_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL)),
  CONSTRAINT offering_current_pair CHECK ((current_version IS NULL) = (current_version_id IS NULL)),
  CONSTRAINT offering_active_has_version CHECK (status <> 'active' OR current_version_id IS NOT NULL),
  CONSTRAINT offering_archived_reason CHECK ((status = 'archived') = (archived_reason IS NOT NULL))
);
CREATE INDEX offering_owner_person_idx ON trustwork.offering (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX offering_owner_company_idx ON trustwork.offering (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE TRIGGER offering_touch BEFORE UPDATE ON trustwork.offering FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- payload: OfferingVersionPayload (components included; they are materialised into bundle_component at publication).
-- public_fields: allowlist of payload keys shown publicly. digest: trustwork-digest-1 over { payload }, set at publication.
CREATE TABLE trustwork.offering_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  offering_id uuid NOT NULL REFERENCES trustwork.offering (id),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'components') = 'array'),
  public_fields text[] NOT NULL DEFAULT '{}' CHECK (public_fields <@ ARRAY['title', 'description', 'specification', 'unit', 'listPrice', 'options', 'availability']::text[]),
  digest text NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  drafted_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  published_at timestamptz NULL,
  published_by_person_id uuid NULL REFERENCES trustwork.person (id),
  published_via text NULL CHECK (published_via IN ('person', 'agent')),
  published_mandate_id text NULL CHECK (published_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  superseded_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offering_version_number UNIQUE (offering_id, version),
  CONSTRAINT offering_version_id_offering UNIQUE (id, offering_id),
  CONSTRAINT offering_version_published_shape CHECK (
    (status = 'draft') = (published_at IS NULL) AND (published_at IS NULL) = (published_by_person_id IS NULL)
    AND (published_at IS NULL) = (digest IS NULL) AND (published_at IS NULL) = (published_via IS NULL)
    AND ((published_via = 'agent') = (published_mandate_id IS NOT NULL))
  ),
  CONSTRAINT offering_version_superseded_shape CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX offering_version_one_draft ON trustwork.offering_version (offering_id) WHERE status = 'draft';
CREATE UNIQUE INDEX offering_version_one_published ON trustwork.offering_version (offering_id) WHERE status = 'published';
CREATE TRIGGER offering_version_touch BEFORE UPDATE ON trustwork.offering_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
-- Published versions are immutable for every role (R06): a catalogue edit opens a new version.
CREATE TRIGGER offering_version_frozen BEFORE UPDATE ON trustwork.offering_version FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'payload', 'public_fields', 'digest', 'published_at', 'published_by_person_id', 'published_via', 'published_mandate_id');
ALTER TABLE trustwork.offering ADD CONSTRAINT offering_current_version FOREIGN KEY (current_version_id, id) REFERENCES trustwork.offering_version (id, offering_id);

-- A bundle component pins an exact published version of another active offering (a kit per building). Rows are
-- materialised from the payload while the bundle version is still a draft and never change afterwards.
CREATE TABLE trustwork.bundle_component (
  offering_version_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  component_offering_id uuid NOT NULL REFERENCES trustwork.offering (id),
  component_version integer NOT NULL CHECK (component_version >= 1),
  component_version_id uuid NOT NULL REFERENCES trustwork.offering_version (id),
  quantity_value text NOT NULL CHECK (quantity_value ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$'),
  quantity_unit text NOT NULL REFERENCES trustwork.unit (code),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (offering_version_id, position),
  CONSTRAINT bundle_component_version FOREIGN KEY (offering_version_id, offering_id) REFERENCES trustwork.offering_version (id, offering_id),
  CONSTRAINT bundle_component_pinned FOREIGN KEY (component_offering_id, component_version) REFERENCES trustwork.offering_version (offering_id, version),
  CONSTRAINT bundle_component_not_self CHECK (component_offering_id <> offering_id)
);
CREATE INDEX bundle_component_offering_idx ON trustwork.bundle_component (offering_id);

-- Private commercial knowledge per version (cost basis, margin target, notes): never in any public or shared read.
CREATE TABLE trustwork.offering_version_private (
  offering_version_id uuid PRIMARY KEY,
  offering_id uuid NOT NULL,
  cost_basis_minor bigint NULL,
  cost_basis_currency text NULL CHECK (cost_basis_currency ~ '^[A-Z]{3}$'),
  margin_target text NULL CHECK (length(margin_target) BETWEEN 1 AND 100),
  notes text NULL CHECK (length(notes) <= 20000),
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offering_version_private_version FOREIGN KEY (offering_version_id, offering_id) REFERENCES trustwork.offering_version (id, offering_id),
  CONSTRAINT offering_version_private_cost CHECK ((cost_basis_minor IS NULL) = (cost_basis_currency IS NULL))
);
CREATE INDEX offering_version_private_offering_idx ON trustwork.offering_version_private (offering_id);
CREATE TRIGGER offering_version_private_touch BEFORE UPDATE ON trustwork.offering_version_private FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Owner-run because policies on the version, component and private tables of an offering must read the offering.
CREATE FUNCTION trustwork.offering_can(p_offering_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.offering o
    WHERE o.id = p_offering_id AND trustwork.commerce_party_acts(o.owner_person_id, o.owner_company_id, 'company.catalogue.edit')
  )
$$;

-- Owner-run: whether an offering version is a published (or superseded) version of an active offering.
CREATE FUNCTION trustwork.catalogue_published_version(p_offering_id uuid, p_version integer) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT v.id FROM trustwork.offering_version v JOIN trustwork.offering o ON o.id = v.offering_id
  WHERE trustwork.current_person_id() IS NOT NULL AND v.offering_id = p_offering_id AND v.version = p_version
    AND v.status IN ('published', 'superseded') AND o.status = 'active'
$$;

CREATE FUNCTION trustwork.offering_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'offerings are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the creator is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.status <> 'draft' OR NEW.current_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'an offering starts as a draft' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id OR NEW.owner_company_id IS DISTINCT FROM OLD.owner_company_id
     OR NEW.created_by_person_id <> OLD.created_by_person_id OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'offering identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF OLD.status = 'archived' AND (NEW.status <> 'archived' OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id) THEN
    RAISE EXCEPTION 'an archived offering stays archived' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status IN ('active', 'archived')) OR (OLD.status = 'active' AND NEW.status = 'archived')) THEN
    RAISE EXCEPTION 'offering transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  -- The current pointer moves only forward, to the published version of this offering.
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    IF NEW.current_version_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM trustwork.offering_version v WHERE v.id = NEW.current_version_id AND v.offering_id = NEW.id AND v.status = 'published' AND v.version = NEW.current_version
    ) OR (OLD.current_version IS NOT NULL AND NEW.current_version <= OLD.current_version) THEN
      RAISE EXCEPTION 'the current version is the latest published version' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
  ELSIF NEW.current_version IS DISTINCT FROM OLD.current_version THEN
    RAISE EXCEPTION 'current version number and id move together' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offering_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.offering FOR EACH ROW EXECUTE FUNCTION trustwork.offering_guard();

CREATE FUNCTION trustwork.offering_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_offering trustwork.offering%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'offering versions are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO v_offering FROM trustwork.offering WHERE id = NEW.offering_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a version starts as a draft' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.drafted_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the drafter is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF v_offering.status = 'archived' THEN
      RAISE EXCEPTION 'an archived offering takes no new versions' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.version <> coalesce((SELECT max(version) FROM trustwork.offering_version WHERE offering_id = NEW.offering_id), 0) + 1 THEN
      RAISE EXCEPTION 'versions are numbered consecutively' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.offering_id <> OLD.offering_id OR NEW.version <> OLD.version OR NEW.drafted_by_person_id <> OLD.drafted_by_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'version identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'supersession changes only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status = 'published') OR (OLD.status = 'published' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'version transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  IF NEW.status = 'published' THEN
    IF NEW.published_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the publisher is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF v_offering.status = 'archived' THEN
      RAISE EXCEPTION 'an archived offering is not published' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trustwork.unit u WHERE u.code = NEW.payload ->> 'unit') THEN
      RAISE EXCEPTION 'the offering unit is not in the unit catalogue' USING ERRCODE = 'check_violation', HINT = 'commerce.unknown_unit';
    END IF;
    IF (v_offering.kind = 'bundle') <> (jsonb_array_length(NEW.payload -> 'components') > 0)
       OR (SELECT count(*) FROM trustwork.bundle_component WHERE offering_version_id = NEW.id) <> jsonb_array_length(NEW.payload -> 'components') THEN
      RAISE EXCEPTION 'bundle components are materialised with the publication' USING ERRCODE = 'check_violation', HINT = 'commerce.parts_missing';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offering_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.offering_version FOR EACH ROW EXECUTE FUNCTION trustwork.offering_version_guard();

-- Components join a version only while it is a draft (FOR SHARE waits for a concurrent publication).
CREATE FUNCTION trustwork.bundle_component_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_version trustwork.offering_version%ROWTYPE;
BEGIN
  SELECT * INTO v_version FROM trustwork.offering_version WHERE id = NEW.offering_version_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown offering version' USING ERRCODE = 'foreign_key_violation', HINT = 'commerce.not_found';
  END IF;
  IF v_version.status <> 'draft' THEN
    RAISE EXCEPTION 'offering version % is frozen', v_version.version USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  NEW.offering_id := v_version.offering_id;
  NEW.component_version_id := trustwork.catalogue_published_version(NEW.component_offering_id, NEW.component_version);
  IF NEW.component_version_id IS NULL THEN
    RAISE EXCEPTION 'a component is a published version of an active offering' USING ERRCODE = 'check_violation', HINT = 'commerce.component_unpublished';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bundle_component_guard BEFORE INSERT ON trustwork.bundle_component FOR EACH ROW EXECUTE FUNCTION trustwork.bundle_component_guard();
CREATE TRIGGER bundle_component_frozen BEFORE UPDATE OR DELETE ON trustwork.bundle_component FOR EACH ROW EXECUTE FUNCTION trustwork.commerce_retained();

CREATE FUNCTION trustwork.offering_version_private_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'private knowledge is retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF NEW.updated_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the updater is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.offering_version_id <> OLD.offering_version_id OR NEW.offering_id <> OLD.offering_id) THEN
    RAISE EXCEPTION 'private knowledge belongs to its version' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offering_version_private_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.offering_version_private FOR EACH ROW EXECUTE FUNCTION trustwork.offering_version_private_guard();

-- Public catalogue: published versions of active offerings, only the allowlisted payload keys (filtered here, so no
-- caller can forget the allowlist). Anonymous callers may use it. Ordered newest first, then by offering id; nothing
-- about payment exists to order by.
CREATE FUNCTION trustwork.catalogue_public_offerings(p_owner_person_id uuid, p_owner_company_id uuid, p_offering_id uuid, p_version integer)
RETURNS TABLE (offering_id uuid, owner_person_id uuid, owner_company_id uuid, kind text, version integer, is_current boolean, published_at timestamptz, fields jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT o.id, o.owner_person_id, o.owner_company_id, o.kind, v.version, v.id = o.current_version_id, v.published_at,
    (SELECT coalesce(jsonb_object_agg(k, v.payload -> k), '{}'::jsonb) FROM unnest(v.public_fields) AS k WHERE v.payload ? k)
  FROM trustwork.offering o
  JOIN trustwork.offering_version v ON v.offering_id = o.id
  WHERE o.status = 'active'
    AND (p_owner_person_id IS NULL OR o.owner_person_id = p_owner_person_id)
    AND (p_owner_company_id IS NULL OR o.owner_company_id = p_owner_company_id)
    AND (p_offering_id IS NULL OR o.id = p_offering_id)
    AND num_nonnulls(p_owner_person_id, p_owner_company_id, p_offering_id) >= 1
    AND (CASE WHEN p_version IS NULL THEN v.id = o.current_version_id ELSE v.version = p_version AND v.status IN ('published', 'superseded') END)
  ORDER BY v.published_at DESC, o.id
$$;

-- 2. Needs ------------------------------------------------------------------------------------------------------------
-- Private intake. Lines are an append-only set per need revision: saving bumps the need revision and inserts the new
-- set tagged with it, so earlier sets stay as history and nothing is ever deleted.
CREATE TABLE trustwork.need (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  project_id uuid NULL REFERENCES trustwork.project (id),
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  source text NOT NULL CHECK (source IN ('manual', 'file', 'email', 'assistant')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'clarifying', 'ready', 'converted')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text NULL CHECK (length(description) <= 20000),
  region text NULL CHECK (length(region) BETWEEN 1 AND 100),
  window_from date NULL,
  window_to date NULL,
  window_time_zone text NULL CHECK (window_time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$' OR window_time_zone = 'UTC'),
  window_to_time_zone text NULL CHECK (window_to_time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$' OR window_to_time_zone = 'UTC'),
  acceptance_criteria text NULL CHECK (length(acceptance_criteria) BETWEEN 1 AND 20000),
  missing_fields text[] NOT NULL DEFAULT '{}' CHECK (cardinality(missing_fields) <= 500),
  rfq_id uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT need_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL)),
  CONSTRAINT need_window CHECK (
    (window_from IS NULL) = (window_to IS NULL) AND (window_from IS NULL) = (window_time_zone IS NULL) AND (window_from IS NULL) = (window_to_time_zone IS NULL)
    AND (window_from IS NULL OR window_from <= window_to)
  ),
  CONSTRAINT need_ready_complete CHECK (status NOT IN ('ready', 'converted') OR cardinality(missing_fields) = 0),
  CONSTRAINT need_clarifying_incomplete CHECK (status <> 'clarifying' OR cardinality(missing_fields) > 0),
  CONSTRAINT need_converted CHECK ((status = 'converted') = (rfq_id IS NOT NULL))
);
CREATE INDEX need_owner_person_idx ON trustwork.need (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX need_owner_company_idx ON trustwork.need (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE TRIGGER need_touch BEFORE UPDATE ON trustwork.need FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.need_line (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  need_id uuid NOT NULL REFERENCES trustwork.need (id),
  need_revision integer NOT NULL CHECK (need_revision >= 1),
  position integer NOT NULL CHECK (position >= 0),
  kind text NULL CHECK (kind IN ('goods', 'works', 'services')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  quantity_value text NULL CHECK (quantity_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$'),
  quantity_unit text NULL REFERENCES trustwork.unit (code),
  specification jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(specification) = 'object'),
  alternatives_allowed boolean NOT NULL DEFAULT false,
  evidence jsonb NULL CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT need_line_position UNIQUE (need_id, need_revision, position),
  CONSTRAINT need_line_quantity CHECK ((quantity_value IS NULL) = (quantity_unit IS NULL))
);
CREATE INDEX need_line_need_idx ON trustwork.need_line (need_id, need_revision);
CREATE TRIGGER need_line_append_only BEFORE UPDATE OR DELETE ON trustwork.need_line FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.need_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'needs are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF trustwork.commerce_region_restricted(NEW.region) THEN
    RAISE EXCEPTION 'restricted place' USING ERRCODE = 'check_violation', HINT = 'commerce.restricted_place';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the creator is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.status = 'converted' OR NEW.rfq_id IS NOT NULL THEN
      RAISE EXCEPTION 'a need is converted only by creating its RFQ' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustwork.project p WHERE p.id = NEW.project_id AND p.owner_person_id IS NOT DISTINCT FROM NEW.owner_person_id AND p.owner_company_id IS NOT DISTINCT FROM NEW.owner_company_id
    ) THEN
      RAISE EXCEPTION 'a need belongs to a project of the same owner' USING ERRCODE = 'check_violation', HINT = 'commerce.project_mismatch';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id OR NEW.owner_company_id IS DISTINCT FROM OLD.owner_company_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.created_by_person_id <> OLD.created_by_person_id OR NEW.source <> OLD.source OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'need identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF OLD.status = 'converted' THEN
    RAISE EXCEPTION 'a converted need is kept as it was' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status = 'converted' AND NOT EXISTS (SELECT 1 FROM trustwork.rfq r WHERE r.id = NEW.rfq_id AND r.need_id = NEW.id) THEN
    RAISE EXCEPTION 'a converted need names the RFQ drafted from it' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER need_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.need FOR EACH ROW EXECUTE FUNCTION trustwork.need_guard();

-- A line set belongs to the need's current revision; a converted need takes no lines.
CREATE FUNCTION trustwork.need_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_need trustwork.need%ROWTYPE;
BEGIN
  SELECT * INTO v_need FROM trustwork.need WHERE id = NEW.need_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown need' USING ERRCODE = 'foreign_key_violation', HINT = 'commerce.not_found';
  END IF;
  IF v_need.status = 'converted' OR NEW.need_revision <> v_need.revision THEN
    RAISE EXCEPTION 'lines join the current revision of an open need' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER need_line_guard BEFORE INSERT ON trustwork.need_line FOR EACH ROW EXECUTE FUNCTION trustwork.need_line_guard();

-- 3. RFQs -------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.rfq (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  project_id uuid NULL REFERENCES trustwork.project (id),
  creator_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  need_id uuid NULL UNIQUE REFERENCES trustwork.need (id),
  plan_project_id uuid NULL REFERENCES trustwork.project (id),
  plan_item_key text NULL CHECK (plan_item_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'cancelled', 'expired')),
  current_version integer NULL CHECK (current_version >= 1),
  current_version_id uuid NULL,
  public_projection_enabled boolean NOT NULL DEFAULT false,
  public_projection_fields text[] NOT NULL DEFAULT '{}' CHECK (public_projection_fields <@ ARRAY['title', 'category', 'region', 'publishedAt', 'openUntil', 'lineSummary']::text[]),
  category text NULL CHECK (length(category) BETWEEN 1 AND 100),
  closed_at timestamptz NULL,
  closed_by_person_id uuid NULL REFERENCES trustwork.person (id),
  closed_reason text NULL CHECK (length(closed_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL)),
  CONSTRAINT rfq_current_pair CHECK ((current_version IS NULL) = (current_version_id IS NULL)),
  CONSTRAINT rfq_current_after_publication CHECK ((status <> 'draft' OR current_version_id IS NULL) AND (status NOT IN ('published', 'closed', 'expired') OR current_version_id IS NOT NULL)),
  CONSTRAINT rfq_plan_item CHECK ((plan_project_id IS NULL) = (plan_item_key IS NULL)),
  CONSTRAINT rfq_closed_facts CHECK ((status IN ('closed', 'cancelled')) = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (closed_by_person_id IS NULL) AND (closed_at IS NULL) = (closed_reason IS NULL))
);
CREATE INDEX rfq_owner_person_idx ON trustwork.rfq (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX rfq_owner_company_idx ON trustwork.rfq (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE INDEX rfq_project_idx ON trustwork.rfq (project_id) WHERE project_id IS NOT NULL;
-- One RFQ per plan item: an item takes one path (the plan's item state records it too).
CREATE UNIQUE INDEX rfq_one_per_plan_item ON trustwork.rfq (plan_project_id, plan_item_key) WHERE plan_project_id IS NOT NULL AND status <> 'cancelled';
CREATE TRIGGER rfq_touch BEFORE UPDATE ON trustwork.rfq FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
ALTER TABLE trustwork.need ADD CONSTRAINT need_rfq FOREIGN KEY (rfq_id) REFERENCES trustwork.rfq (id);

-- payload: RfqVersionPayload. digest: trustwork-digest-1 over { payload }, computed by the server at publication.
CREATE TABLE trustwork.rfq_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  rfq_id uuid NOT NULL REFERENCES trustwork.rfq (id),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'lines') = 'array'),
  digest text NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  drafted_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  published_at timestamptz NULL,
  published_by_person_id uuid NULL REFERENCES trustwork.person (id),
  published_via text NULL CHECK (published_via IN ('person', 'agent')),
  published_mandate_id text NULL CHECK (published_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  superseded_by integer NULL,
  superseded_at timestamptz NULL,
  amendment_reason text NULL CHECK (length(amendment_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_version_number UNIQUE (rfq_id, version),
  CONSTRAINT rfq_version_id_rfq UNIQUE (id, rfq_id),
  CONSTRAINT rfq_version_published_shape CHECK (
    (status = 'draft') = (published_at IS NULL) AND (published_at IS NULL) = (published_by_person_id IS NULL)
    AND (published_at IS NULL) = (digest IS NULL) AND (published_at IS NULL) = (published_via IS NULL)
    AND ((published_via = 'agent') = (published_mandate_id IS NOT NULL))
  ),
  CONSTRAINT rfq_version_superseded_shape CHECK ((status = 'superseded') = (superseded_by IS NOT NULL) AND (superseded_by IS NULL) = (superseded_at IS NULL) AND (superseded_by IS NULL OR superseded_by = version + 1)),
  CONSTRAINT rfq_version_amendment_reason CHECK ((version = 1) = (amendment_reason IS NULL))
);
CREATE UNIQUE INDEX rfq_version_one_draft ON trustwork.rfq_version (rfq_id) WHERE status = 'draft';
CREATE UNIQUE INDEX rfq_version_one_published ON trustwork.rfq_version (rfq_id) WHERE status = 'published';
CREATE TRIGGER rfq_version_touch BEFORE UPDATE ON trustwork.rfq_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
-- Model invariant 2 / ADR 008: once published, the payload, digest, publication facts and amendment reason never change
-- and the status never returns to draft, for every role.
CREATE TRIGGER rfq_version_frozen BEFORE UPDATE ON trustwork.rfq_version FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'payload', 'digest', 'published_at', 'published_by_person_id', 'published_via', 'published_mandate_id', 'amendment_reason');
ALTER TABLE trustwork.rfq ADD CONSTRAINT rfq_current_version FOREIGN KEY (current_version_id, id) REFERENCES trustwork.rfq_version (id, rfq_id);

-- Buyer party_private: a separate record and projection, never joined into a supplier, public or shared read.
CREATE TABLE trustwork.rfq_private_constraint (
  rfq_id uuid PRIMARY KEY REFERENCES trustwork.rfq (id),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  budget_ceiling_minor bigint NULL,
  budget_ceiling_currency text NULL CHECK (budget_ceiling_currency ~ '^[A-Z]{3}$'),
  evaluation_weights jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evaluation_weights) = 'object'),
  internal_notes text NOT NULL DEFAULT '' CHECK (length(internal_notes) <= 20000),
  shortlist jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(shortlist) = 'array'),
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_private_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL)),
  CONSTRAINT rfq_private_budget CHECK ((budget_ceiling_minor IS NULL) = (budget_ceiling_currency IS NULL))
);
CREATE TRIGGER rfq_private_constraint_touch BEFORE UPDATE ON trustwork.rfq_private_constraint FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Invitations pin the exact rfq_version_id; staleness is a flag set once (by an amendment or closing), never cleared:
-- revalidation is a new invitation pinned to the current version.
CREATE TABLE trustwork.rfq_invitation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  rfq_id uuid NOT NULL REFERENCES trustwork.rfq (id),
  rfq_version_id uuid NOT NULL,
  party_person_id uuid NULL REFERENCES trustwork.person (id),
  party_company_id uuid NULL REFERENCES trustwork.company (id),
  channel text NOT NULL CHECK (channel IN ('platform', 'email', 'assistant')),
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'viewed', 'declined', 'responded', 'withdrawn')),
  stale_reason text NULL CHECK (stale_reason IN ('rfq_amended', 'rfq_closed')),
  stale_at timestamptz NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  sent_via text NOT NULL CHECK (sent_via IN ('person', 'agent')),
  sent_by_mandate_id text NULL CHECK (sent_by_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  revalidates_invitation_id uuid NULL REFERENCES trustwork.rfq_invitation (id),
  withdrawn_reason text NULL CHECK (length(withdrawn_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_invitation_version FOREIGN KEY (rfq_version_id, rfq_id) REFERENCES trustwork.rfq_version (id, rfq_id),
  CONSTRAINT rfq_invitation_party_xor CHECK ((party_person_id IS NULL) <> (party_company_id IS NULL)),
  CONSTRAINT rfq_invitation_stale_pair CHECK ((stale_reason IS NULL) = (stale_at IS NULL)),
  CONSTRAINT rfq_invitation_mandate CHECK ((sent_via = 'agent') = (sent_by_mandate_id IS NOT NULL)),
  CONSTRAINT rfq_invitation_withdrawn CHECK ((status = 'withdrawn') = (withdrawn_reason IS NOT NULL))
);
CREATE INDEX rfq_invitation_rfq_idx ON trustwork.rfq_invitation (rfq_id, sent_at);
CREATE INDEX rfq_invitation_person_idx ON trustwork.rfq_invitation (party_person_id) WHERE party_person_id IS NOT NULL;
CREATE INDEX rfq_invitation_company_idx ON trustwork.rfq_invitation (party_company_id) WHERE party_company_id IS NOT NULL;
-- One invitation per (version, party): two concurrent invitations of the same supplier cannot both commit.
CREATE UNIQUE INDEX rfq_invitation_one_per_person ON trustwork.rfq_invitation (rfq_version_id, party_person_id) WHERE party_person_id IS NOT NULL;
CREATE UNIQUE INDEX rfq_invitation_one_per_company ON trustwork.rfq_invitation (rfq_version_id, party_company_id) WHERE party_company_id IS NOT NULL;
CREATE TRIGGER rfq_invitation_touch BEFORE UPDATE ON trustwork.rfq_invitation FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- RFQ authority (the database mirror of the access policy for resource kind `rfq`). Owner-run so that the RFQ, version,
-- private and invitation policies can read the envelope and participations without recursion.
CREATE FUNCTION trustwork.rfq_can(p_rfq_id uuid, p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL
    AND p_capability IN ('read.party_private', 'write.draft', 'publish', 'invite')
    AND (
      EXISTS (
        SELECT 1 FROM trustwork.rfq r
        WHERE r.id = p_rfq_id
          AND trustwork.commerce_party_acts(r.owner_person_id, r.owner_company_id, CASE WHEN p_capability = 'publish' THEN 'company.publish' ELSE 'company.deals.manage' END)
      )
      OR EXISTS (
        SELECT 1 FROM trustwork.object_participation op
        WHERE op.resource_kind = 'rfq' AND op.resource_id = p_rfq_id
          AND op.side <> 'staff' AND op.audience IN ('party_private', 'owner_private')
          AND op.revoked_at IS NULL AND op.valid_from <= now() AND (op.valid_until IS NULL OR op.valid_until > now())
          AND p_capability = ANY (op.capabilities)
          AND trustwork.commerce_party_acts(op.party_person_id, op.party_company_id, CASE WHEN p_capability = 'publish' THEN 'company.publish' ELSE 'company.deals.manage' END)
      )
    )
$$;

-- The principal's party holds an invitation on the RFQ (pinned to the given version when one is named). A withdrawn
-- invitation keeps showing what was sent and that it was withdrawn, nothing newer. A company invitee acts through
-- members holding company.deals.manage.
CREATE FUNCTION trustwork.rfq_invitee(p_rfq_id uuid, p_version_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.rfq_invitation i
    WHERE i.rfq_id = p_rfq_id AND (p_version_id IS NULL OR i.rfq_version_id = p_version_id)
      AND trustwork.commerce_party_acts(i.party_person_id, i.party_company_id, 'company.deals.manage')
  )
$$;

-- Generic ownership helper extended to the commercial kinds that exist in this slice (`rfq`), so an owner may
-- materialise its owner participation row and grant co-buyers; quotes, agreements and orders follow in COM-002.
CREATE OR REPLACE FUNCTION trustwork.owns_resource(p_resource_kind text, p_resource_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND CASE p_resource_kind
    WHEN 'project' THEN EXISTS (
      SELECT 1 FROM trustwork.project p WHERE p.id = p_resource_id
        AND (p.owner_person_id = trustwork.current_person_id() OR (p.owner_company_id IS NOT NULL AND p.owner_company_id = trustwork.current_company_id()))
    )
    WHEN 'rfq' THEN EXISTS (
      SELECT 1 FROM trustwork.rfq r WHERE r.id = p_resource_id
        AND trustwork.commerce_party_acts(r.owner_person_id, r.owner_company_id, 'company.deals.manage')
    )
    ELSE false END
$$;

CREATE FUNCTION trustwork.rfq_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RFQs are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.creator_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the creator is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.status <> 'draft' OR NEW.current_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'an RFQ starts as a draft' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustwork.project p WHERE p.id = NEW.project_id AND p.owner_person_id IS NOT DISTINCT FROM NEW.owner_person_id AND p.owner_company_id IS NOT DISTINCT FROM NEW.owner_company_id
    ) THEN
      RAISE EXCEPTION 'an RFQ belongs to a project of the same owner' USING ERRCODE = 'check_violation', HINT = 'commerce.project_mismatch';
    END IF;
    IF NEW.need_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustwork.need n WHERE n.id = NEW.need_id AND n.status = 'ready' AND n.owner_person_id IS NOT DISTINCT FROM NEW.owner_person_id AND n.owner_company_id IS NOT DISTINCT FROM NEW.owner_company_id
    ) THEN
      RAISE EXCEPTION 'an RFQ is drafted from a ready need of the same owner' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    -- Plan item path (ADR 012 decision 37): only a person's own project; a company buys through requisitions.
    IF NEW.plan_project_id IS NOT NULL AND (NEW.owner_person_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM trustwork.project p WHERE p.id = NEW.plan_project_id AND p.owner_person_id = NEW.owner_person_id
    )) THEN
      RAISE EXCEPTION 'a plan item becomes an RFQ of its own person owner' USING ERRCODE = 'check_violation', HINT = 'commerce.plan_item_path';
    END IF;
    IF NEW.public_projection_enabled AND NOT trustwork.commerce_party_acts(NEW.owner_person_id, NEW.owner_company_id, 'company.publish') THEN
      RAISE EXCEPTION 'a public projection needs publish authority' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id OR NEW.owner_company_id IS DISTINCT FROM OLD.owner_company_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.creator_person_id <> OLD.creator_person_id OR NEW.need_id IS DISTINCT FROM OLD.need_id
     OR NEW.plan_project_id IS DISTINCT FROM OLD.plan_project_id OR NEW.plan_item_key IS DISTINCT FROM OLD.plan_item_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'RFQ identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF OLD.status IN ('closed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'a % RFQ is kept as it was', OLD.status USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('published', 'cancelled')) OR (OLD.status = 'published' AND NEW.status IN ('closed', 'cancelled', 'expired'))) THEN
      RAISE EXCEPTION 'RFQ transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NOT trustwork.rfq_can(NEW.id, 'publish') THEN
      RAISE EXCEPTION 'publishing and closing need publish authority' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.closed_by_person_id IS DISTINCT FROM (CASE WHEN NEW.status IN ('closed', 'cancelled') THEN trustwork.current_person_id() END) THEN
      RAISE EXCEPTION 'the closer is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
  ELSIF NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closed_by_person_id IS DISTINCT FROM OLD.closed_by_person_id OR NEW.closed_reason IS DISTINCT FROM OLD.closed_reason THEN
    RAISE EXCEPTION 'closing facts change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  -- The current pointer moves only forward, to the published version of this RFQ, by a principal holding `publish`.
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    IF NEW.current_version_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM trustwork.rfq_version v WHERE v.id = NEW.current_version_id AND v.rfq_id = NEW.id AND v.status = 'published' AND v.version = NEW.current_version
    ) OR (OLD.current_version IS NOT NULL AND NEW.current_version <= OLD.current_version) OR NOT trustwork.rfq_can(NEW.id, 'publish') THEN
      RAISE EXCEPTION 'the current version is the latest published version' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
  ELSIF NEW.current_version IS DISTINCT FROM OLD.current_version THEN
    RAISE EXCEPTION 'current version number and id move together' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF (NEW.public_projection_enabled IS DISTINCT FROM OLD.public_projection_enabled OR NEW.public_projection_fields IS DISTINCT FROM OLD.public_projection_fields OR NEW.category IS DISTINCT FROM OLD.category)
     AND NOT trustwork.rfq_can(NEW.id, 'publish') THEN
    RAISE EXCEPTION 'the public projection needs publish authority' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rfq_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.rfq FOR EACH ROW EXECUTE FUNCTION trustwork.rfq_guard();

-- Staleness is decided by version identity, in the same transaction as the change that causes it: an amendment flags
-- every invitation pinned to an earlier version `rfq_amended`; closing, cancelling or expiring flags the rest
-- `rfq_closed`. The flag is never cleared (COM-002 extends this to quotes). Owner-run so that every invitation is
-- flagged whatever the publisher may read; it runs only as the trigger of an update the guards already allowed.
CREATE FUNCTION trustwork.rfq_flag_stale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND OLD.current_version_id IS NOT NULL THEN
    UPDATE trustwork.rfq_invitation SET stale_reason = 'rfq_amended', stale_at = now()
    WHERE rfq_id = NEW.id AND rfq_version_id <> NEW.current_version_id AND stale_reason IS NULL;
  END IF;
  IF NEW.status <> OLD.status AND NEW.status IN ('closed', 'cancelled', 'expired') THEN
    UPDATE trustwork.rfq_invitation SET stale_reason = 'rfq_closed', stale_at = now() WHERE rfq_id = NEW.id AND stale_reason IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER rfq_flag_stale AFTER UPDATE ON trustwork.rfq FOR EACH ROW EXECUTE FUNCTION trustwork.rfq_flag_stale();

CREATE FUNCTION trustwork.rfq_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_rfq trustwork.rfq%ROWTYPE;
  v_unit text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RFQ versions are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO v_rfq FROM trustwork.rfq WHERE id = NEW.rfq_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a version starts as a draft' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.drafted_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the drafter is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    -- Version 1 is drafted with the RFQ; an amendment is drafted only on a published RFQ, as the next number.
    IF NOT ((NEW.version = 1 AND v_rfq.status = 'draft' AND NOT EXISTS (SELECT 1 FROM trustwork.rfq_version WHERE rfq_id = NEW.rfq_id))
            OR (NEW.version > 1 AND v_rfq.status = 'published' AND NEW.version = v_rfq.current_version + 1)) THEN
      RAISE EXCEPTION 'an amendment is the next version of a published RFQ' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.rfq_id <> OLD.rfq_id OR NEW.version <> OLD.version OR NEW.drafted_by_person_id <> OLD.drafted_by_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'version identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'supersession changes only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
    IF OLD.status = 'draft' AND (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.amendment_reason IS DISTINCT FROM OLD.amendment_reason) AND NOT trustwork.rfq_can(NEW.rfq_id, 'write.draft') THEN
      RAISE EXCEPTION 'editing a draft needs write.draft' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status = 'published') OR (OLD.status = 'published' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'version transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  IF NOT trustwork.rfq_can(NEW.rfq_id, 'publish') THEN
    RAISE EXCEPTION 'publishing needs publish authority' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF NEW.status = 'published' THEN
    IF NEW.published_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the publisher is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF v_rfq.status NOT IN ('draft', 'published') THEN
      RAISE EXCEPTION 'a % RFQ is not published again', v_rfq.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF jsonb_array_length(NEW.payload -> 'lines') = 0 THEN
      RAISE EXCEPTION 'an RFQ version has lines' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    -- Explicit units: every line quantity names a unit of the catalogue (goods, works and services alike).
    SELECT l -> 'quantity' ->> 'unit' INTO v_unit FROM jsonb_array_elements(NEW.payload -> 'lines') AS l
    WHERE NOT EXISTS (SELECT 1 FROM trustwork.unit u WHERE u.code = l -> 'quantity' ->> 'unit') LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'unit % is not in the unit catalogue', coalesce(v_unit, 'null') USING ERRCODE = 'check_violation', HINT = 'commerce.unknown_unit';
    END IF;
    IF trustwork.commerce_region_restricted(NEW.payload -> 'deliveryTerms' -> 'location' ->> 'region') THEN
      RAISE EXCEPTION 'restricted place' USING ERRCODE = 'check_violation', HINT = 'commerce.restricted_place';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rfq_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.rfq_version FOR EACH ROW EXECUTE FUNCTION trustwork.rfq_version_guard();

CREATE FUNCTION trustwork.rfq_private_constraint_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'private constraints are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF NEW.updated_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the updater is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.rfq r WHERE r.id = NEW.rfq_id AND r.owner_person_id IS NOT DISTINCT FROM NEW.owner_person_id AND r.owner_company_id IS NOT DISTINCT FROM NEW.owner_company_id) THEN
    RAISE EXCEPTION 'the private constraint belongs to the RFQ owner' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rfq_private_constraint_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.rfq_private_constraint FOR EACH ROW EXECUTE FUNCTION trustwork.rfq_private_constraint_guard();

-- Invitations: pinned to the current published version at insert (the envelope is locked FOR SHARE, so a concurrent
-- publication either waits for this insert and then flags it stale, or commits first and this insert is refused);
-- never the owner itself; identity, pin and sender never change; the stale flag only once and only when true;
-- the invitee records viewed and declined, the owner side withdraws.
CREATE FUNCTION trustwork.rfq_invitation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_rfq trustwork.rfq%ROWTYPE;
  v_previous trustwork.rfq_invitation%ROWTYPE;
  v_invitee boolean;
  v_owner_side boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invitations are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT trustwork.rfq_can(NEW.rfq_id, 'invite') THEN
      RAISE EXCEPTION 'inviting needs invite authority' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    SELECT * INTO v_rfq FROM trustwork.rfq WHERE id = NEW.rfq_id FOR SHARE;
    IF NEW.sent_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the sender is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.status <> 'sent' OR NEW.stale_reason IS NOT NULL THEN
      RAISE EXCEPTION 'an invitation starts as sent and current' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF v_rfq.status <> 'published' OR v_rfq.current_version_id IS DISTINCT FROM NEW.rfq_version_id THEN
      RAISE EXCEPTION 'invitations pin the current published version' USING ERRCODE = 'check_violation', HINT = 'commerce.rfq_version_not_current';
    END IF;
    IF NEW.party_person_id IS NOT DISTINCT FROM v_rfq.owner_person_id AND NEW.party_company_id IS NOT DISTINCT FROM v_rfq.owner_company_id THEN
      RAISE EXCEPTION 'the buyer does not invite itself' USING ERRCODE = 'check_violation', HINT = 'commerce.self_invitation';
    END IF;
    IF NEW.revalidates_invitation_id IS NOT NULL THEN
      SELECT * INTO v_previous FROM trustwork.rfq_invitation WHERE id = NEW.revalidates_invitation_id;
      IF NOT FOUND OR v_previous.rfq_id <> NEW.rfq_id OR v_previous.stale_reason IS DISTINCT FROM 'rfq_amended'
         OR v_previous.party_person_id IS DISTINCT FROM NEW.party_person_id OR v_previous.party_company_id IS DISTINCT FROM NEW.party_company_id THEN
        RAISE EXCEPTION 'revalidation replaces a stale invitation of the same party' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.rfq_id <> OLD.rfq_id OR NEW.rfq_version_id <> OLD.rfq_version_id OR NEW.party_person_id IS DISTINCT FROM OLD.party_person_id
     OR NEW.party_company_id IS DISTINCT FROM OLD.party_company_id OR NEW.channel <> OLD.channel OR NEW.sent_at <> OLD.sent_at
     OR NEW.sent_by_person_id <> OLD.sent_by_person_id OR NEW.sent_via <> OLD.sent_via OR NEW.sent_by_mandate_id IS DISTINCT FROM OLD.sent_by_mandate_id
     OR NEW.revalidates_invitation_id IS DISTINCT FROM OLD.revalidates_invitation_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an invitation is pinned for ever' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.stale_reason IS DISTINCT FROM OLD.stale_reason OR NEW.stale_at IS DISTINCT FROM OLD.stale_at THEN
    SELECT * INTO v_rfq FROM trustwork.rfq WHERE id = NEW.rfq_id;
    IF OLD.stale_reason IS NOT NULL
       OR (NEW.stale_reason = 'rfq_amended' AND v_rfq.current_version_id IS NOT DISTINCT FROM NEW.rfq_version_id)
       OR (NEW.stale_reason = 'rfq_closed' AND v_rfq.status NOT IN ('closed', 'cancelled', 'expired')) THEN
      RAISE EXCEPTION 'staleness is set once and only when true' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.stale_immutable';
    END IF;
  END IF;
  IF NEW.status <> OLD.status OR NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason THEN
    v_invitee := trustwork.commerce_party_acts(OLD.party_person_id, OLD.party_company_id, 'company.deals.manage');
    v_owner_side := trustwork.rfq_can(OLD.rfq_id, 'invite');
    IF NOT ((OLD.status = 'sent' AND NEW.status IN ('viewed', 'declined', 'responded', 'withdrawn'))
            OR (OLD.status = 'viewed' AND NEW.status IN ('declined', 'responded', 'withdrawn'))
            OR (OLD.status = 'responded' AND NEW.status = 'withdrawn')) THEN
      RAISE EXCEPTION 'invitation transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF (NEW.status IN ('viewed', 'declined', 'responded') AND NOT v_invitee) OR (NEW.status = 'withdrawn' AND NOT v_owner_side) THEN
      RAISE EXCEPTION 'the invitee answers, the buyer withdraws' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.status IN ('viewed', 'declined', 'responded') AND OLD.stale_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a stale invitation is answered only after revalidation' USING ERRCODE = 'check_violation', HINT = 'commerce.rfq_version_not_current';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rfq_invitation_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.rfq_invitation FOR EACH ROW EXECUTE FUNCTION trustwork.rfq_invitation_guard();

-- Public RFQ projection: only a published RFQ whose owner enabled it, with its current published version; the
-- serializer applies the field allowlist (toPublicRfq). Nothing for drafts, private or unknown ids.
CREATE FUNCTION trustwork.rfq_public_read(p_rfq_id uuid)
RETURNS TABLE (id uuid, status text, category text, public_projection_enabled boolean, public_projection_fields text[], version_id uuid, version integer, version_status text, payload jsonb, published_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r.id, r.status, r.category, r.public_projection_enabled, r.public_projection_fields, v.id, v.version, v.status, v.payload, v.published_at
  FROM trustwork.rfq r JOIN trustwork.rfq_version v ON v.id = r.current_version_id
  WHERE r.id = p_rfq_id AND r.status = 'published' AND r.public_projection_enabled AND v.status = 'published'
$$;

-- 4. Row-level security -----------------------------------------------------------------------------------------------
ALTER TABLE trustwork.offering ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offering FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offering_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offering_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bundle_component ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bundle_component FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offering_version_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offering_version_private FORCE ROW LEVEL SECURITY;
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

CREATE POLICY maintenance_all ON trustwork.offering AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.offering_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.bundle_component AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.offering_version_private AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.need AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.need_line AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.rfq AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.rfq_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.rfq_private_constraint AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.rfq_invitation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Catalogue: the owner side only; the public reads published fields through catalogue_public_offerings.
CREATE POLICY offering_read ON trustwork.offering FOR SELECT TO trustwork_app USING (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.catalogue.edit'));
CREATE POLICY offering_insert ON trustwork.offering FOR INSERT TO trustwork_app
  WITH CHECK (created_by_person_id = trustwork.current_person_id() AND trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.catalogue.edit'));
CREATE POLICY offering_update ON trustwork.offering FOR UPDATE TO trustwork_app
  USING (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.catalogue.edit'))
  WITH CHECK (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.catalogue.edit'));
CREATE POLICY offering_version_read ON trustwork.offering_version FOR SELECT TO trustwork_app USING (trustwork.offering_can(offering_id));
CREATE POLICY offering_version_insert ON trustwork.offering_version FOR INSERT TO trustwork_app WITH CHECK (trustwork.offering_can(offering_id));
CREATE POLICY offering_version_update ON trustwork.offering_version FOR UPDATE TO trustwork_app USING (trustwork.offering_can(offering_id)) WITH CHECK (trustwork.offering_can(offering_id));
CREATE POLICY bundle_component_read ON trustwork.bundle_component FOR SELECT TO trustwork_app USING (trustwork.offering_can(offering_id));
CREATE POLICY bundle_component_insert ON trustwork.bundle_component FOR INSERT TO trustwork_app WITH CHECK (trustwork.offering_can(offering_id));
CREATE POLICY offering_version_private_read ON trustwork.offering_version_private FOR SELECT TO trustwork_app USING (trustwork.offering_can(offering_id));
CREATE POLICY offering_version_private_insert ON trustwork.offering_version_private FOR INSERT TO trustwork_app WITH CHECK (trustwork.offering_can(offering_id));
CREATE POLICY offering_version_private_update ON trustwork.offering_version_private FOR UPDATE TO trustwork_app USING (trustwork.offering_can(offering_id)) WITH CHECK (trustwork.offering_can(offering_id));

-- Needs: owner side only.
CREATE POLICY need_read ON trustwork.need FOR SELECT TO trustwork_app USING (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.deals.manage'));
CREATE POLICY need_insert ON trustwork.need FOR INSERT TO trustwork_app
  WITH CHECK (created_by_person_id = trustwork.current_person_id() AND trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.deals.manage'));
CREATE POLICY need_update ON trustwork.need FOR UPDATE TO trustwork_app
  USING (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.deals.manage'))
  WITH CHECK (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.deals.manage'));
CREATE POLICY need_line_read ON trustwork.need_line FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.need n WHERE n.id = need_id));
CREATE POLICY need_line_insert ON trustwork.need_line FOR INSERT TO trustwork_app WITH CHECK (EXISTS (SELECT 1 FROM trustwork.need n WHERE n.id = need_id));

-- RFQs: the owner side (rfq_can) and invited parties (rfq_invitee) read the envelope; drafts and the private
-- constraint stay on the owner side; an invitee reads only the versions its own invitations pin and its own rows.
-- The direct owner check also covers INSERT ... RETURNING, where the owner-run helpers cannot see the new row yet.
CREATE POLICY rfq_read ON trustwork.rfq FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.deals.manage') OR trustwork.rfq_can(id, 'read.party_private') OR trustwork.rfq_invitee(id, NULL));
CREATE POLICY rfq_insert ON trustwork.rfq FOR INSERT TO trustwork_app
  WITH CHECK (creator_person_id = trustwork.current_person_id() AND trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.deals.manage'));
CREATE POLICY rfq_update ON trustwork.rfq FOR UPDATE TO trustwork_app
  USING (trustwork.rfq_can(id, 'write.draft') OR trustwork.rfq_can(id, 'publish') OR trustwork.rfq_can(id, 'invite'))
  WITH CHECK (trustwork.rfq_can(id, 'write.draft') OR trustwork.rfq_can(id, 'publish') OR trustwork.rfq_can(id, 'invite'));
CREATE POLICY rfq_version_read ON trustwork.rfq_version FOR SELECT TO trustwork_app
  USING (trustwork.rfq_can(rfq_id, 'read.party_private') OR (status <> 'draft' AND trustwork.rfq_invitee(rfq_id, id)));
CREATE POLICY rfq_version_insert ON trustwork.rfq_version FOR INSERT TO trustwork_app WITH CHECK (trustwork.rfq_can(rfq_id, 'write.draft'));
CREATE POLICY rfq_version_update ON trustwork.rfq_version FOR UPDATE TO trustwork_app
  USING (trustwork.rfq_can(rfq_id, 'write.draft') OR trustwork.rfq_can(rfq_id, 'publish'))
  WITH CHECK (trustwork.rfq_can(rfq_id, 'write.draft') OR trustwork.rfq_can(rfq_id, 'publish'));
CREATE POLICY rfq_private_constraint_read ON trustwork.rfq_private_constraint FOR SELECT TO trustwork_app USING (trustwork.rfq_can(rfq_id, 'read.party_private'));
CREATE POLICY rfq_private_constraint_insert ON trustwork.rfq_private_constraint FOR INSERT TO trustwork_app WITH CHECK (trustwork.rfq_can(rfq_id, 'write.draft'));
CREATE POLICY rfq_private_constraint_update ON trustwork.rfq_private_constraint FOR UPDATE TO trustwork_app
  USING (trustwork.rfq_can(rfq_id, 'write.draft')) WITH CHECK (trustwork.rfq_can(rfq_id, 'write.draft'));
CREATE POLICY rfq_invitation_read ON trustwork.rfq_invitation FOR SELECT TO trustwork_app
  USING (trustwork.rfq_can(rfq_id, 'read.party_private') OR trustwork.commerce_party_acts(party_person_id, party_company_id, 'company.deals.manage'));
CREATE POLICY rfq_invitation_insert ON trustwork.rfq_invitation FOR INSERT TO trustwork_app WITH CHECK (trustwork.rfq_can(rfq_id, 'invite'));
CREATE POLICY rfq_invitation_update ON trustwork.rfq_invitation FOR UPDATE TO trustwork_app
  USING (trustwork.rfq_can(rfq_id, 'invite') OR trustwork.rfq_can(rfq_id, 'publish') OR trustwork.commerce_party_acts(party_person_id, party_company_id, 'company.deals.manage'))
  WITH CHECK (trustwork.rfq_can(rfq_id, 'invite') OR trustwork.rfq_can(rfq_id, 'publish') OR trustwork.commerce_party_acts(party_person_id, party_company_id, 'company.deals.manage'));

-- 5. Grants -----------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON trustwork.offering, trustwork.offering_version, trustwork.bundle_component, trustwork.offering_version_private,
  trustwork.need, trustwork.need_line, trustwork.rfq, trustwork.rfq_version, trustwork.rfq_private_constraint, trustwork.rfq_invitation TO trustwork_app;
GRANT UPDATE (status, current_version, current_version_id, archived_reason) ON trustwork.offering TO trustwork_app;
GRANT UPDATE (status, payload, public_fields, digest, published_at, published_by_person_id, published_via, published_mandate_id, superseded_at) ON trustwork.offering_version TO trustwork_app;
GRANT UPDATE (cost_basis_minor, cost_basis_currency, margin_target, notes, updated_by_person_id) ON trustwork.offering_version_private TO trustwork_app;
GRANT UPDATE (status, title, description, region, window_from, window_to, window_time_zone, window_to_time_zone, acceptance_criteria, missing_fields, rfq_id) ON trustwork.need TO trustwork_app;
GRANT UPDATE (status, current_version, current_version_id, public_projection_enabled, public_projection_fields, category, closed_at, closed_by_person_id, closed_reason) ON trustwork.rfq TO trustwork_app;
GRANT UPDATE (status, payload, digest, published_at, published_by_person_id, published_via, published_mandate_id, superseded_by, superseded_at, amendment_reason) ON trustwork.rfq_version TO trustwork_app;
GRANT UPDATE (budget_ceiling_minor, budget_ceiling_currency, evaluation_weights, internal_notes, shortlist, updated_by_person_id) ON trustwork.rfq_private_constraint TO trustwork_app;
GRANT UPDATE (status, stale_reason, stale_at, withdrawn_reason) ON trustwork.rfq_invitation TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.commerce_party_acts(uuid, uuid, text), trustwork.commerce_region_restricted(text), trustwork.offering_can(uuid), trustwork.rfq_can(uuid, text),
  trustwork.rfq_invitee(uuid, uuid), trustwork.catalogue_published_version(uuid, integer), trustwork.catalogue_public_offerings(uuid, uuid, uuid, integer), trustwork.rfq_public_read(uuid), trustwork.rfq_flag_stale() TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
