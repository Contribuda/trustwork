-- PRC-003: the company's private supplier base (handbook docs/engine/procurement-and-supply.md, "The company's
-- supplier base"; data model section 18a; contracts packages/contracts/src/supply/suppliers.ts).
--
-- * external_counterparty: a supplier that is not on the platform, created by the buying company by hand, from an
--   import or from a document. Never published, never counted in directories, no reputation, no outreach: the rows are
--   readable only by members of the owning company. When the company later joins and claims its page, the buyer may
--   link it (claimed_company_id); nothing private moves into the public projection.
-- * supplier_record: the buyer's own entry for a supplier, party_private of the buying company. Exactly one link: a
--   platform company (claimed or verified), a sourced directory record (an unclaimed company row), or an external
--   counterparty of the same owner. One record per supplier and buyer. A link only ever moves forward, from a sourced
--   record or an external counterparty to the claimed company. Status, notes, payment terms and the onboarding
--   checklist never leave the buying company: no policy, function or event shows them to the supplier, to search, to
--   notifications, to reputation, to federation or to hub statistics. A block is never a public signal.
-- * supplier_assessment: periodic criteria-based scores with evidence references. A draft until recorded; recording
--   freezes it. Shared with the supplier only when the buyer chooses so at recording and the record links a platform
--   company; the supplier then sees the assessment (never the record's status or notes) and may answer once.
--   reputation_input is false by constraint: assessments never feed reputation snapshots.
--
-- Entry points (SECURITY DEFINER, pinned search_path), all for the runtime role (trustwork_app):
--   supplier_base_member, supplier_base_may_manage (policy and guard helpers),
--   supplier_base_create_counterparty, supplier_base_update_counterparty,
--   supplier_base_create_record, supplier_base_update_record, supplier_base_link_claimed,
--   supplier_base_draft_assessment, supplier_base_record_assessment,
--   supplier_base_shared_assessments, supplier_base_respond (the supplier's side of a shared assessment).
-- The runtime role reads the three tables under row-level security (members of the owning company only) and writes
-- nothing directly. No function here appends an outbox event: there is no notification path by construction.

-- 1. Authority helpers ------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.supplier_base_active_member(p_company uuid, p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_company IS NOT NULL AND p_person IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.membership m WHERE m.company_id = p_company AND m.person_id = p_person AND m.status = 'active' AND m.valid_from <= now())
$$;

-- procurement.suppliers.manage: company administrators hold every procurement permission; other members hold it
-- through a live company-scoped permission_grant given by someone else who is an administrator or holds
-- company.members.manage in that company (the rule of the procurement permissions, PRC-001).
CREATE FUNCTION trustwork.supplier_base_holds(p_company uuid, p_person uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.supplier_base_active_member(p_company, p_person) AND (
    EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.company_id = p_company AND m.person_id = p_person AND m.status = 'active' AND m.valid_from <= now() AND m.role = 'administrator')
    OR EXISTS (
      SELECT 1 FROM trustwork.permission_grant g
      WHERE g.principal_person_id = p_person AND g.action = p_permission AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
        AND g.scope ->> 'companyId' = p_company::text AND NOT (g.scope ? 'projectId') AND g.granted_by <> p_person
        AND EXISTS (SELECT 1 FROM trustwork.membership gm WHERE gm.person_id = g.granted_by AND gm.company_id = p_company AND gm.status = 'active' AND gm.valid_from <= now()
          AND (gm.role = 'administrator' OR 'company.members.manage' = ANY (gm.permissions)))
    )
  )
$$;

CREATE FUNCTION trustwork.supplier_base_member(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p_company IS NOT NULL AND p_company = trustwork.current_company_id() AND trustwork.supplier_base_active_member(p_company, trustwork.current_person_id())
$$;

CREATE FUNCTION trustwork.supplier_base_may_manage(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p_company IS NOT NULL AND p_company = trustwork.current_company_id() AND trustwork.supplier_base_holds(p_company, trustwork.current_person_id(), 'procurement.suppliers.manage')
$$;

CREATE FUNCTION trustwork.supplier_base_require_manager(p_company uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_company IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.supplier_base_holds(p_company, trustwork.current_person_id(), 'procurement.suppliers.manage') THEN
    RAISE EXCEPTION 'the supplier base is maintained by members holding procurement.suppliers.manage' USING ERRCODE = '42501', HINT = 'supplier_base.not_authorised';
  END IF;
END $$;

-- Shapes of the jsonb columns (SupplierRecordSchema, ExternalCounterpartySchema, SupplierAssessmentSchema).
CREATE FUNCTION trustwork.supplier_base_identifiers_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(p) = 'array' AND jsonb_array_length(p) <= 10 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p) e
    WHERE jsonb_typeof(e) <> 'object' OR NOT (e ?& ARRAY['kind', 'value']) OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 2
      OR jsonb_typeof(e -> 'kind') <> 'string' OR jsonb_typeof(e -> 'value') <> 'string'
      OR NOT (e ->> 'kind' ~ '^[a-z]{2}_[a-z0-9_]{2,40}$') OR length(e ->> 'value') NOT BETWEEN 1 AND 80)
$$;

CREATE FUNCTION trustwork.supplier_base_contacts_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(p) = 'array' AND jsonb_array_length(p) <= 20 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p) e
    WHERE jsonb_typeof(e) <> 'object' OR NOT (e ?& ARRAY['role', 'channel', 'value']) OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 3
      OR jsonb_typeof(e -> 'role') <> 'string' OR jsonb_typeof(e -> 'value') <> 'string'
      OR e ->> 'channel' NOT IN ('email', 'phone', 'postal') OR length(e ->> 'role') NOT BETWEEN 1 AND 80 OR length(e ->> 'value') NOT BETWEEN 1 AND 300)
$$;

CREATE FUNCTION trustwork.supplier_base_onboarding_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(p) = 'array' AND jsonb_array_length(p) <= 50 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p) e
    WHERE jsonb_typeof(e) <> 'object' OR NOT (e ?& ARRAY['key', 'kind', 'documentTypeKey', 'state']) OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 4
      OR NOT (e ->> 'key' ~ '^[a-z0-9][a-z0-9_-]{0,63}$') OR e ->> 'kind' NOT IN ('document', 'screening', 'payee_verification')
      OR NOT (jsonb_typeof(e -> 'documentTypeKey') = 'null' OR (e ->> 'documentTypeKey') ~ '^[a-z0-9_.-]{2,80}$')
      OR e ->> 'state' NOT IN ('missing', 'received', 'in_review', 'complete', 'expired')
      -- Screening is performed by the hub and payee verification by PRC-011: the buyer never marks them done.
      OR (e ->> 'kind' IN ('screening', 'payee_verification') AND e ->> 'state' <> 'missing'))
$$;

CREATE FUNCTION trustwork.supplier_base_scores_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(p) = 'array' AND jsonb_array_length(p) BETWEEN 1 AND 30 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p) e
    WHERE jsonb_typeof(e) <> 'object' OR NOT (e ?& ARRAY['criterion', 'value', 'evidenceRefs']) OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 3
      OR NOT (e ->> 'criterion' ~ '^[a-z0-9][a-z0-9_-]{0,63}$') OR jsonb_typeof(e -> 'value') <> 'number' OR (e ->> 'value') !~ '^[0-5]$'
      OR jsonb_typeof(e -> 'evidenceRefs') <> 'array' OR jsonb_array_length(e -> 'evidenceRefs') > 100)
$$;

-- 2. External counterparties -----------------------------------------------------------------------------------------
CREATE TABLE trustwork.external_counterparty (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_company_id uuid NOT NULL REFERENCES trustwork.company (id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200 AND name = btrim(name)),
  -- Normalized name: one counterparty per name in a company's base (imports skip names already listed).
  name_key text GENERATED ALWAYS AS (lower(regexp_replace(name, '\s+', ' ', 'g'))) STORED,
  identifiers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (trustwork.supplier_base_identifiers_ok(identifiers)),
  contacts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (trustwork.supplier_base_contacts_ok(contacts)),
  source text NOT NULL CHECK (source IN ('manual', 'import', 'document')),
  claimed_company_id uuid NULL REFERENCES trustwork.company (id),
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_counterparty_not_self CHECK (claimed_company_id IS DISTINCT FROM owner_company_id)
);
CREATE UNIQUE INDEX external_counterparty_name_unique ON trustwork.external_counterparty (owner_company_id, name_key);

CREATE FUNCTION trustwork.external_counterparty_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'counterparties are kept as history' USING ERRCODE = '23514', HINT = 'supplier_base.record_permanent';
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_company_id <> OLD.owner_company_id OR NEW.source <> OLD.source OR NEW.created_by_person_id <> OLD.created_by_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a counterparty keeps its owner and origin' USING ERRCODE = '23514', HINT = 'supplier_base.frozen';
  END IF;
  IF OLD.claimed_company_id IS NOT NULL AND NEW.claimed_company_id IS DISTINCT FROM OLD.claimed_company_id THEN
    RAISE EXCEPTION 'a counterparty is linked to its claimed company once' USING ERRCODE = '23514', HINT = 'supplier_base.frozen';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER external_counterparty_guard BEFORE UPDATE OR DELETE ON trustwork.external_counterparty FOR EACH ROW EXECUTE FUNCTION trustwork.external_counterparty_guard();
CREATE TRIGGER external_counterparty_no_truncate BEFORE TRUNCATE ON trustwork.external_counterparty FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Supplier records ------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.supplier_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_company_id uuid NOT NULL REFERENCES trustwork.company (id),
  linked_company_id uuid NULL REFERENCES trustwork.company (id),
  linked_sourced_company_id uuid NULL REFERENCES trustwork.company (id),
  external_counterparty_id uuid NULL REFERENCES trustwork.external_counterparty (id),
  status text NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect', 'approved', 'preferred', 'on_hold', 'blocked', 'archived')),
  categories text[] NOT NULL DEFAULT '{}' CHECK (cardinality(categories) <= 50 AND array_position(categories, NULL) IS NULL),
  regions text[] NOT NULL DEFAULT '{}' CHECK (cardinality(regions) <= 50 AND array_position(regions, NULL) IS NULL),
  internal_notes text NULL CHECK (internal_notes IS NULL OR length(internal_notes) <= 20000),
  default_payment_terms text NULL CHECK (default_payment_terms IS NULL OR length(default_payment_terms) BETWEEN 1 AND 500),
  onboarding jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (trustwork.supplier_base_onboarding_ok(onboarding)),
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_record_one_link CHECK (num_nonnulls(linked_company_id, linked_sourced_company_id, external_counterparty_id) = 1),
  CONSTRAINT supplier_record_not_self CHECK (linked_company_id IS DISTINCT FROM owner_company_id AND linked_sourced_company_id IS DISTINCT FROM owner_company_id)
);
CREATE UNIQUE INDEX supplier_record_company_unique ON trustwork.supplier_record (owner_company_id, linked_company_id) WHERE linked_company_id IS NOT NULL;
CREATE UNIQUE INDEX supplier_record_sourced_unique ON trustwork.supplier_record (owner_company_id, linked_sourced_company_id) WHERE linked_sourced_company_id IS NOT NULL;
CREATE UNIQUE INDEX supplier_record_counterparty_unique ON trustwork.supplier_record (external_counterparty_id) WHERE external_counterparty_id IS NOT NULL;
CREATE INDEX supplier_record_owner_idx ON trustwork.supplier_record (owner_company_id, created_at DESC, id DESC);

CREATE FUNCTION trustwork.supplier_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier records are archived, never deleted' USING ERRCODE = '23514', HINT = 'supplier_base.record_permanent';
  END IF;
  IF NEW.external_counterparty_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM trustwork.external_counterparty c WHERE c.id = NEW.external_counterparty_id AND c.owner_company_id = NEW.owner_company_id) THEN
    RAISE EXCEPTION 'the counterparty belongs to another company' USING ERRCODE = '23514', HINT = 'supplier_base.not_found';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_company_id <> OLD.owner_company_id OR NEW.created_by_person_id <> OLD.created_by_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a supplier record keeps its owner' USING ERRCODE = '23514', HINT = 'supplier_base.frozen';
  END IF;
  -- A link moves only forward: from a sourced record or an external counterparty to the claimed platform company.
  IF NEW.linked_company_id IS DISTINCT FROM OLD.linked_company_id OR NEW.linked_sourced_company_id IS DISTINCT FROM OLD.linked_sourced_company_id
     OR NEW.external_counterparty_id IS DISTINCT FROM OLD.external_counterparty_id THEN
    IF OLD.linked_company_id IS NOT NULL OR NEW.linked_company_id IS NULL OR NEW.linked_sourced_company_id IS NOT NULL OR NEW.external_counterparty_id IS NOT NULL THEN
      RAISE EXCEPTION 'a link only moves to the claimed company' USING ERRCODE = '23514', HINT = 'supplier_base.invalid_link';
    END IF;
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_record_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.supplier_record FOR EACH ROW EXECUTE FUNCTION trustwork.supplier_record_guard();
CREATE TRIGGER supplier_record_no_truncate BEFORE TRUNCATE ON trustwork.supplier_record FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Assessments -----------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.supplier_assessment (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  supplier_record_id uuid NOT NULL REFERENCES trustwork.supplier_record (id),
  owner_company_id uuid NOT NULL REFERENCES trustwork.company (id),
  period_from date NOT NULL,
  period_to date NOT NULL,
  criteria_version integer NOT NULL CHECK (criteria_version >= 1),
  scores jsonb NOT NULL CHECK (trustwork.supplier_base_scores_ok(scores)),
  assessed_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'recorded')),
  shared_with_supplier boolean NOT NULL DEFAULT false,
  -- The platform company the recorded assessment was shared with (frozen at recording).
  shared_company_id uuid NULL REFERENCES trustwork.company (id),
  supplier_response text NULL CHECK (supplier_response IS NULL OR length(supplier_response) BETWEEN 1 AND 2000),
  responded_by_person_id uuid NULL REFERENCES trustwork.person (id),
  responded_at timestamptz NULL,
  -- Assessments never feed reputation snapshots; only a review tied to a real agreement does, through the review rules.
  reputation_input boolean NOT NULL DEFAULT false CHECK (reputation_input = false),
  assessed_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_assessment_period CHECK (period_to >= period_from),
  CONSTRAINT supplier_assessment_recorded_shape CHECK ((status = 'recorded') = (assessed_at IS NOT NULL)),
  CONSTRAINT supplier_assessment_shared_shape CHECK (shared_with_supplier = (shared_company_id IS NOT NULL) AND (NOT shared_with_supplier OR status = 'recorded')),
  CONSTRAINT supplier_assessment_response_shape CHECK ((shared_with_supplier OR supplier_response IS NULL)
    AND (supplier_response IS NULL) = (responded_at IS NULL) AND (responded_at IS NULL) = (responded_by_person_id IS NULL))
);
CREATE INDEX supplier_assessment_record_idx ON trustwork.supplier_assessment (supplier_record_id, created_at DESC);
CREATE INDEX supplier_assessment_shared_idx ON trustwork.supplier_assessment (shared_company_id, assessed_at DESC) WHERE shared_with_supplier;

CREATE FUNCTION trustwork.supplier_assessment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assessments are kept as history' USING ERRCODE = '23514', HINT = 'supplier_base.record_permanent';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.shared_with_supplier OR NEW.supplier_response IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM trustwork.supplier_record r WHERE r.id = NEW.supplier_record_id AND r.owner_company_id = NEW.owner_company_id) THEN
      RAISE EXCEPTION 'an assessment starts as a draft of the record owner' USING ERRCODE = '23514', HINT = 'supplier_base.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.supplier_record_id <> OLD.supplier_record_id OR NEW.owner_company_id <> OLD.owner_company_id OR NEW.created_at <> OLD.created_at
     OR NEW.assessed_by_person_id <> OLD.assessed_by_person_id THEN
    RAISE EXCEPTION 'an assessment keeps its subject and author' USING ERRCODE = '23514', HINT = 'supplier_base.frozen';
  END IF;
  IF OLD.status = 'recorded' AND (NEW.status <> 'recorded' OR NEW.period_from <> OLD.period_from OR NEW.period_to <> OLD.period_to OR NEW.criteria_version <> OLD.criteria_version
     OR NEW.scores <> OLD.scores OR NEW.assessed_at IS DISTINCT FROM OLD.assessed_at OR NEW.shared_with_supplier <> OLD.shared_with_supplier
     OR NEW.shared_company_id IS DISTINCT FROM OLD.shared_company_id) THEN
    RAISE EXCEPTION 'a recorded assessment is frozen' USING ERRCODE = '23514', HINT = 'supplier_base.frozen';
  END IF;
  IF OLD.supplier_response IS NOT NULL AND (NEW.supplier_response IS DISTINCT FROM OLD.supplier_response OR NEW.responded_at IS DISTINCT FROM OLD.responded_at) THEN
    RAISE EXCEPTION 'the supplier answers once' USING ERRCODE = '23514', HINT = 'supplier_base.already_answered';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_assessment_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.supplier_assessment FOR EACH ROW EXECUTE FUNCTION trustwork.supplier_assessment_guard();
CREATE TRIGGER supplier_assessment_no_truncate BEFORE TRUNCATE ON trustwork.supplier_assessment FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 5. Commands --------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.supplier_base_check_regions(p_regions text[]) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_regions, '{}'::text[])) r WHERE r !~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$') THEN
    RAISE EXCEPTION 'regions are ISO 3166 codes' USING ERRCODE = '22023', HINT = 'supplier_base.invalid_region';
  END IF;
  -- Restricted places are never offered (an unsynced list restricts everything: fail closed).
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_regions, '{}'::text[])) r WHERE trustwork.kernel_place_restricted(r)) THEN
    RAISE EXCEPTION 'a restricted place cannot be a supplier region' USING ERRCODE = '22023', HINT = 'supplier_base.restricted_place';
  END IF;
END $$;

CREATE FUNCTION trustwork.supplier_base_lock_counterparty(p_id uuid, p_expected integer) RETURNS trustwork.external_counterparty
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.external_counterparty%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.external_counterparty WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.owner_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.supplier_base_active_member(v_row.owner_company_id, trustwork.current_person_id()) THEN
    RAISE EXCEPTION 'counterparty not found' USING ERRCODE = 'P0002', HINT = 'supplier_base.not_found';
  END IF;
  PERFORM trustwork.supplier_base_require_manager(v_row.owner_company_id);
  IF p_expected IS NOT NULL AND v_row.revision <> p_expected THEN
    RAISE EXCEPTION 'the counterparty changed meanwhile' USING ERRCODE = '40001', HINT = 'supplier_base.revision_conflict';
  END IF;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.supplier_base_lock_record(p_id uuid, p_expected integer) RETURNS trustwork.supplier_record
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.supplier_record%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.supplier_record WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.owner_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.supplier_base_active_member(v_row.owner_company_id, trustwork.current_person_id()) THEN
    RAISE EXCEPTION 'supplier record not found' USING ERRCODE = 'P0002', HINT = 'supplier_base.not_found';
  END IF;
  PERFORM trustwork.supplier_base_require_manager(v_row.owner_company_id);
  IF p_expected IS NOT NULL AND v_row.revision <> p_expected THEN
    RAISE EXCEPTION 'the supplier record changed meanwhile' USING ERRCODE = '40001', HINT = 'supplier_base.revision_conflict';
  END IF;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.supplier_base_create_counterparty(p_company uuid, p_name text, p_identifiers jsonb, p_contacts jsonb, p_source text)
RETURNS trustwork.external_counterparty
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.external_counterparty%ROWTYPE;
BEGIN
  PERFORM trustwork.supplier_base_require_manager(p_company);
  IF p_source NOT IN ('manual', 'import', 'document') THEN
    RAISE EXCEPTION 'unknown counterparty source' USING ERRCODE = '22023', HINT = 'supplier_base.invalid_input';
  END IF;
  INSERT INTO trustwork.external_counterparty (owner_company_id, name, identifiers, contacts, source, created_by_person_id)
  VALUES (p_company, btrim(p_name), coalesce(p_identifiers, '[]'::jsonb), coalesce(p_contacts, '[]'::jsonb), p_source, trustwork.current_person_id())
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.supplier_base_update_counterparty(p_id uuid, p_name text, p_identifiers jsonb, p_contacts jsonb, p_expected integer)
RETURNS trustwork.external_counterparty
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.external_counterparty%ROWTYPE;
BEGIN
  v_row := trustwork.supplier_base_lock_counterparty(p_id, p_expected);
  UPDATE trustwork.external_counterparty SET name = btrim(p_name), identifiers = coalesce(p_identifiers, '[]'::jsonb), contacts = coalesce(p_contacts, '[]'::jsonb)
  WHERE id = p_id RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Linking reads only what the public projection already shows: the company row's claim status. A platform company
-- link needs a claimed or verified company; a sourced link needs an unclaimed one; a counterparty must be the
-- caller's own. Nothing is written to the linked company and no event is appended.
CREATE FUNCTION trustwork.supplier_base_create_record(p_company uuid, p_link_kind text, p_link_id uuid, p_status text, p_categories text[], p_regions text[],
  p_notes text, p_terms text, p_onboarding jsonb)
RETURNS trustwork.supplier_record
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.supplier_record%ROWTYPE;
  v_claim text;
BEGIN
  PERFORM trustwork.supplier_base_require_manager(p_company);
  PERFORM trustwork.supplier_base_check_regions(p_regions);
  IF p_link_kind IN ('company', 'sourced_company') THEN
    SELECT claim_status INTO v_claim FROM trustwork.company WHERE id = p_link_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'linked company not found' USING ERRCODE = 'P0002', HINT = 'supplier_base.not_found';
    END IF;
    IF p_link_id = p_company THEN
      RAISE EXCEPTION 'a company is not its own supplier' USING ERRCODE = '22023', HINT = 'supplier_base.invalid_link';
    END IF;
    IF (p_link_kind = 'company' AND v_claim NOT IN ('claimed', 'verified')) OR (p_link_kind = 'sourced_company' AND v_claim <> 'unclaimed') THEN
      RAISE EXCEPTION 'link kind does not match the company status' USING ERRCODE = '22023', HINT = 'supplier_base.invalid_link';
    END IF;
  ELSIF p_link_kind = 'external_counterparty' THEN
    IF NOT EXISTS (SELECT 1 FROM trustwork.external_counterparty c WHERE c.id = p_link_id AND c.owner_company_id = p_company) THEN
      RAISE EXCEPTION 'counterparty not found' USING ERRCODE = 'P0002', HINT = 'supplier_base.not_found';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown link kind' USING ERRCODE = '22023', HINT = 'supplier_base.invalid_link';
  END IF;
  BEGIN
    INSERT INTO trustwork.supplier_record (owner_company_id, linked_company_id, linked_sourced_company_id, external_counterparty_id, status, categories, regions,
      internal_notes, default_payment_terms, onboarding, created_by_person_id)
    VALUES (p_company, CASE WHEN p_link_kind = 'company' THEN p_link_id END, CASE WHEN p_link_kind = 'sourced_company' THEN p_link_id END,
      CASE WHEN p_link_kind = 'external_counterparty' THEN p_link_id END, coalesce(p_status, 'prospect'), coalesce(p_categories, '{}'::text[]), coalesce(p_regions, '{}'::text[]),
      p_notes, p_terms, coalesce(p_onboarding, '[]'::jsonb), trustwork.current_person_id())
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'this supplier is already in the base' USING ERRCODE = '23505', HINT = 'supplier_base.already_listed';
  END;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.supplier_base_update_record(p_id uuid, p_status text, p_categories text[], p_regions text[], p_notes text, p_terms text, p_onboarding jsonb, p_expected integer)
RETURNS trustwork.supplier_record
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.supplier_record%ROWTYPE;
BEGIN
  v_row := trustwork.supplier_base_lock_record(p_id, p_expected);
  PERFORM trustwork.supplier_base_check_regions(p_regions);
  UPDATE trustwork.supplier_record
  SET status = p_status, categories = coalesce(p_categories, '{}'::text[]), regions = coalesce(p_regions, '{}'::text[]), internal_notes = p_notes,
      default_payment_terms = p_terms, onboarding = coalesce(p_onboarding, '[]'::jsonb)
  WHERE id = p_id RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- The supplier joined and claimed its page: the record moves from the sourced record or the external counterparty to
-- the claimed company. A sourced record moves only to its own (now claimed) company row; a counterparty may move to
-- any claimed or verified company the buyer chooses and remembers it in claimed_company_id. Nothing private moves into
-- the public projection and the company learns nothing.
CREATE FUNCTION trustwork.supplier_base_link_claimed(p_id uuid, p_company uuid, p_expected integer)
RETURNS trustwork.supplier_record
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.supplier_record%ROWTYPE;
  v_claim text;
BEGIN
  v_row := trustwork.supplier_base_lock_record(p_id, p_expected);
  IF v_row.linked_company_id IS NOT NULL THEN
    RAISE EXCEPTION 'the record already links a platform company' USING ERRCODE = '22023', HINT = 'supplier_base.invalid_link';
  END IF;
  SELECT claim_status INTO v_claim FROM trustwork.company WHERE id = p_company;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'company not found' USING ERRCODE = 'P0002', HINT = 'supplier_base.not_found';
  END IF;
  IF v_claim NOT IN ('claimed', 'verified') OR p_company = v_row.owner_company_id
     OR (v_row.linked_sourced_company_id IS NOT NULL AND v_row.linked_sourced_company_id <> p_company) THEN
    RAISE EXCEPTION 'only the claimed company can be linked' USING ERRCODE = '22023', HINT = 'supplier_base.invalid_link';
  END IF;
  IF v_row.external_counterparty_id IS NOT NULL THEN
    UPDATE trustwork.external_counterparty SET claimed_company_id = p_company WHERE id = v_row.external_counterparty_id;
  END IF;
  BEGIN
    UPDATE trustwork.supplier_record SET linked_company_id = p_company, linked_sourced_company_id = NULL, external_counterparty_id = NULL
    WHERE id = p_id RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'this company is already in the base' USING ERRCODE = '23505', HINT = 'supplier_base.already_listed';
  END;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.supplier_base_draft_assessment(p_record uuid, p_from date, p_to date, p_criteria integer, p_scores jsonb)
RETURNS trustwork.supplier_assessment
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_record trustwork.supplier_record%ROWTYPE;
  v_row trustwork.supplier_assessment%ROWTYPE;
BEGIN
  v_record := trustwork.supplier_base_lock_record(p_record, NULL);
  INSERT INTO trustwork.supplier_assessment (supplier_record_id, owner_company_id, period_from, period_to, criteria_version, scores, assessed_by_person_id)
  VALUES (p_record, v_record.owner_company_id, p_from, p_to, p_criteria, p_scores, trustwork.current_person_id())
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Recording freezes the draft. Sharing is the buyer's explicit choice and needs a record linked to a platform company
-- (claimed or verified): a sourced record or an external counterparty has nobody on the platform to share with.
CREATE FUNCTION trustwork.supplier_base_record_assessment(p_id uuid, p_share boolean, p_expected integer)
RETURNS trustwork.supplier_assessment
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.supplier_assessment%ROWTYPE;
  v_record trustwork.supplier_record%ROWTYPE;
  v_claim text;
BEGIN
  SELECT * INTO v_row FROM trustwork.supplier_assessment WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT trustwork.supplier_base_member(v_row.owner_company_id) THEN
    RAISE EXCEPTION 'assessment not found' USING ERRCODE = 'P0002', HINT = 'supplier_base.not_found';
  END IF;
  v_record := trustwork.supplier_base_lock_record(v_row.supplier_record_id, NULL);
  IF v_row.revision <> p_expected THEN
    RAISE EXCEPTION 'the assessment changed meanwhile' USING ERRCODE = '40001', HINT = 'supplier_base.revision_conflict';
  END IF;
  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'the assessment is already recorded' USING ERRCODE = '23514', HINT = 'supplier_base.invalid_transition';
  END IF;
  IF p_share THEN
    SELECT claim_status INTO v_claim FROM trustwork.company WHERE id = v_record.linked_company_id;
    IF v_record.linked_company_id IS NULL OR v_claim NOT IN ('claimed', 'verified') THEN
      RAISE EXCEPTION 'only a platform company can receive a shared assessment' USING ERRCODE = '22023', HINT = 'supplier_base.not_shareable';
    END IF;
  END IF;
  UPDATE trustwork.supplier_assessment
  SET status = 'recorded', assessed_at = clock_timestamp(), shared_with_supplier = coalesce(p_share, false), shared_company_id = CASE WHEN p_share THEN v_record.linked_company_id END
  WHERE id = p_id RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- The supplier's side: assessments shared with the caller's company. Only the assessment itself (period, criteria,
-- scores, evidence references, the answer) and the buying company's id; never the record, its status, notes, terms,
-- onboarding or anything about other suppliers. Members of the supplier company read; the answer is given by an
-- administrator or a member holding company.deals.manage.
CREATE FUNCTION trustwork.supplier_base_shared_assessments(p_limit integer)
RETURNS TABLE (id uuid, buyer_company_id uuid, period_from date, period_to date, criteria_version integer, scores jsonb, supplier_response text, responded_at timestamptz,
  assessed_at timestamptz, revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT a.id, a.owner_company_id, a.period_from, a.period_to, a.criteria_version, a.scores, a.supplier_response, a.responded_at, a.assessed_at, a.revision
  FROM trustwork.supplier_assessment a
  WHERE a.shared_with_supplier AND a.shared_company_id = trustwork.current_company_id()
    AND trustwork.supplier_base_active_member(a.shared_company_id, trustwork.current_person_id())
  ORDER BY a.assessed_at DESC, a.id DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 100)
$$;

CREATE FUNCTION trustwork.supplier_base_respond(p_id uuid, p_response text, p_expected integer)
RETURNS TABLE (id uuid, buyer_company_id uuid, period_from date, period_to date, criteria_version integer, scores jsonb, supplier_response text, responded_at timestamptz,
  assessed_at timestamptz, revision integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.supplier_assessment%ROWTYPE;
  v_person uuid := trustwork.current_person_id();
BEGIN
  SELECT * INTO v_row FROM trustwork.supplier_assessment a WHERE a.id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT v_row.shared_with_supplier OR v_row.shared_company_id IS DISTINCT FROM trustwork.current_company_id()
     OR NOT trustwork.supplier_base_active_member(v_row.shared_company_id, v_person) THEN
    RAISE EXCEPTION 'assessment not found' USING ERRCODE = 'P0002', HINT = 'supplier_base.not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.company_id = v_row.shared_company_id AND m.person_id = v_person AND m.status = 'active'
                 AND (m.role = 'administrator' OR 'company.deals.manage' = ANY (m.permissions))) THEN
    RAISE EXCEPTION 'answering needs company.deals.manage' USING ERRCODE = '42501', HINT = 'supplier_base.not_authorised';
  END IF;
  IF v_row.revision <> p_expected THEN
    RAISE EXCEPTION 'the assessment changed meanwhile' USING ERRCODE = '40001', HINT = 'supplier_base.revision_conflict';
  END IF;
  IF v_row.supplier_response IS NOT NULL THEN
    RAISE EXCEPTION 'the supplier answers once' USING ERRCODE = '23514', HINT = 'supplier_base.already_answered';
  END IF;
  UPDATE trustwork.supplier_assessment a SET supplier_response = p_response, responded_by_person_id = v_person, responded_at = clock_timestamp() WHERE a.id = p_id RETURNING * INTO v_row;
  RETURN QUERY SELECT v_row.id, v_row.owner_company_id, v_row.period_from, v_row.period_to, v_row.criteria_version, v_row.scores, v_row.supplier_response, v_row.responded_at,
    v_row.assessed_at, v_row.revision;
END $$;

-- 6. Row-level security ----------------------------------------------------------------------------------------------
ALTER TABLE trustwork.external_counterparty ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.external_counterparty FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.supplier_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.supplier_record FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.supplier_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.supplier_assessment FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.external_counterparty AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.supplier_record AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.supplier_assessment AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Members of the buying company only. The linked supplier, other buyers, anonymous callers and staff without a
-- maintenance session see nothing; there is no write policy (writes go through the commands above).
CREATE POLICY external_counterparty_owner ON trustwork.external_counterparty FOR SELECT TO trustwork_app USING (trustwork.supplier_base_member(owner_company_id));
CREATE POLICY supplier_record_owner ON trustwork.supplier_record FOR SELECT TO trustwork_app USING (trustwork.supplier_base_member(owner_company_id));
CREATE POLICY supplier_assessment_owner ON trustwork.supplier_assessment FOR SELECT TO trustwork_app USING (trustwork.supplier_base_member(owner_company_id));

GRANT SELECT ON trustwork.external_counterparty, trustwork.supplier_record, trustwork.supplier_assessment TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.supplier_base_member(uuid), trustwork.supplier_base_may_manage(uuid),
  trustwork.supplier_base_create_counterparty(uuid, text, jsonb, jsonb, text), trustwork.supplier_base_update_counterparty(uuid, text, jsonb, jsonb, integer),
  trustwork.supplier_base_create_record(uuid, text, uuid, text, text[], text[], text, text, jsonb),
  trustwork.supplier_base_update_record(uuid, text, text[], text[], text, text, jsonb, integer), trustwork.supplier_base_link_claimed(uuid, uuid, integer),
  trustwork.supplier_base_draft_assessment(uuid, date, date, integer, jsonb), trustwork.supplier_base_record_assessment(uuid, boolean, integer),
  trustwork.supplier_base_shared_assessments(integer), trustwork.supplier_base_respond(uuid, text, integer) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
