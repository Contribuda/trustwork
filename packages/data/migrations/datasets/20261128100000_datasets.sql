-- MINE-001 local data mining, first slice: datasets, operator dataset licences, records with per-record provenance, the
-- do-not-collect list, retention and licence-expiry deletion with tombstones (docs/engine/hub-console/data-mining.md;
-- docs/engine/discovery-and-outreach.md section 1; ADR 012 decision 4; ADR 026). Contract: DatasetSchema in
-- packages/contracts/src/hub.ts (vocabularies tested against this file).
--
-- Rules the schema holds:
--   * reputation is never an output (the output vocabulary has no such value);
--   * people datasets use consent or public professional data only and never display publicly; court, debt and people
--     datasets need an impact assessment; court and debt records about natural persons serve only as verification
--     evidence and are never displayed;
--   * activation is a person's decision; a dataset with personal data needs a second person
--     (`pipelines.activate_personal_data_dataset`), and a court or debt dataset, off by default, needs one too
--     (`datasets.activate_court_or_debt`); a dataset under a contract needs a current operator licence;
--   * every record carries its provenance (source, URL, observed time, licence snapshot, method); a record matching the
--     do-not-collect list is dropped before storage; contact use is off by default, set only by a person, and only where
--     the dataset permits contact use;
--   * records past retention, and all records of a dataset whose licence has ended, are deleted and leave tombstones
--     that keep only a digest of the record key.
--
-- Authority model (DATA-002): every mutation is a SECURITY DEFINER command that resolves the caller's permission at the
-- hub, requires a live elevation and writes an admin_audit_event; the runtime role reads under row-level security
-- (staff of the hub with a datasets permission) and writes nothing directly; the worker ingests and sweeps through
-- its own functions.

-- 0. Vocabularies (tested against packages/contracts/src/hub.ts) ------------------------------------------------------
CREATE FUNCTION trustwork.datasets_subjects() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['companies', 'licences_permits', 'court_cases', 'debts_tax_arrears', 'procurement_notices', 'events', 'articles', 'people']::text[]
$$;
CREATE FUNCTION trustwork.datasets_outputs() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['directory_sourced_records', 'verification_evidence', 'matching_eligibility', 'knowledge_base', 'opportunities_board', 'events_calendar', 'news_desk']::text[]
$$;
CREATE FUNCTION trustwork.datasets_legal_bases() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['statutory_public_register', 'open_licence', 'contract', 'consent', 'legitimate_interest_assessed', 'public_professional_data']::text[]
$$;
CREATE FUNCTION trustwork.datasets_personal_categories() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['name', 'professional_role', 'licence_number', 'business_contact', 'court_party', 'debt_record']::text[]
$$;
CREATE FUNCTION trustwork.datasets_reader_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.datasets.read', 'admin.datasets.edit', 'admin.datasets.activate', 'admin.links.decide']::text[]
$$;
CREATE FUNCTION trustwork.datasets_distinct(p_values text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT cardinality(p_values) = (SELECT count(DISTINCT v) FROM unnest(p_values) v) $$;
-- Uses an operator licence may grant (discovery-and-outreach section 1).
CREATE FUNCTION trustwork.datasets_licence_uses_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(p) = 'object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) = ARRAY['contactUse', 'display', 'enrich', 'syndicate']
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) e WHERE jsonb_typeof(e.value) <> 'boolean')
$$;
-- Identifier values compare without case, spaces, dots, slashes or dashes (normaliseIdentifier in sourced-facts.ts).
CREATE FUNCTION trustwork.datasets_norm(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT upper(regexp_replace(p_value, '[\s./-]', '', 'g')) $$;
-- Do-not-collect keys are digests of a kind and a normalised value; the list never holds the values themselves.
CREATE FUNCTION trustwork.datasets_dnc_digest(p_kind text, p_value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT encode(sha256(convert_to('dataset-dnc:' || p_kind || ':' || CASE WHEN p_kind = 'identifier' THEN trustwork.datasets_norm(p_value) ELSE lower(btrim(p_value)) END, 'UTF8')), 'hex')
$$;

-- 1. Datasets ---------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.dataset (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  subject text NOT NULL CHECK (subject = ANY (trustwork.datasets_subjects())),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  source_ids uuid[] NOT NULL CHECK (cardinality(source_ids) BETWEEN 1 AND 20),
  purpose text NOT NULL CHECK (length(btrim(purpose)) BETWEEN 10 AND 500),
  legal_basis text NOT NULL CHECK (legal_basis = ANY (trustwork.datasets_legal_bases())),
  personal_present boolean NOT NULL,
  natural_persons boolean NOT NULL,
  personal_categories text[] NOT NULL DEFAULT '{}' CHECK (personal_categories <@ trustwork.datasets_personal_categories() AND trustwork.datasets_distinct(personal_categories)),
  impact_assessment_ref uuid NULL,
  retention_class text NOT NULL CHECK (retention_class ~ '^[a-z][a-z0-9_]{1,40}$'),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  outputs text[] NOT NULL CHECK (cardinality(outputs) BETWEEN 1 AND 7 AND outputs <@ trustwork.datasets_outputs() AND trustwork.datasets_distinct(outputs)),
  public_display boolean NOT NULL,
  subject_notice boolean NOT NULL,
  contact_use_allowed boolean NOT NULL DEFAULT false,
  refresh_schedule_id uuid NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'paused', 'retired')),
  proposed_by uuid NOT NULL REFERENCES trustwork.person (id),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dataset_people CHECK (subject <> 'people' OR (legal_basis IN ('consent', 'public_professional_data') AND NOT public_display)),
  CONSTRAINT dataset_assessment CHECK (subject NOT IN ('court_cases', 'debts_tax_arrears', 'people') OR impact_assessment_ref IS NOT NULL),
  CONSTRAINT dataset_court_debt_persons CHECK (NOT (subject IN ('court_cases', 'debts_tax_arrears') AND natural_persons)
    OR (NOT public_display AND outputs = ARRAY['verification_evidence'])),
  CONSTRAINT dataset_eligibility CHECK (NOT ('matching_eligibility' = ANY (outputs)) OR subject IN ('companies', 'licences_permits')),
  CONSTRAINT dataset_personal_categories CHECK (NOT personal_present OR cardinality(personal_categories) > 0),
  CONSTRAINT dataset_natural_persons CHECK (NOT natural_persons OR personal_present),
  CONSTRAINT dataset_activation CHECK (status NOT IN ('active', 'paused') OR (activated_by IS NOT NULL AND activated_at IS NOT NULL)),
  CONSTRAINT dataset_second_person CHECK (status NOT IN ('active', 'paused') OR ((NOT personal_present AND subject NOT IN ('court_cases', 'debts_tax_arrears')) OR approval_id IS NOT NULL)),
  -- Contact use only where outreach is possible at all: never for court, debt or people data.
  CONSTRAINT dataset_contact_use CHECK (NOT contact_use_allowed OR subject IN ('companies', 'licences_permits', 'events'))
);
CREATE INDEX dataset_hub_idx ON trustwork.dataset (hub_id, status, created_at);

CREATE FUNCTION trustwork.datasets_activation_digest(p_dataset uuid, p_revision integer) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT encode(sha256(convert_to('datasets.activate:' || p_dataset::text || ':' || p_revision::text, 'UTF8')), 'hex')
$$;

-- 2. Operator dataset licences (append-only; the newest valid one counts) ----------------------------------------------
CREATE TABLE trustwork.dataset_licence (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  dataset_id uuid NOT NULL REFERENCES trustwork.dataset (id),
  supplier text NOT NULL CHECK (length(btrim(supplier)) BETWEEN 1 AND 200),
  agreement_digest text NOT NULL CHECK (agreement_digest ~ '^[a-f0-9]{64}$'),
  agreement_ref text NOT NULL CHECK (agreement_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$'),
  purposes text[] NOT NULL CHECK (cardinality(purposes) BETWEEN 1 AND 7 AND purposes <@ trustwork.datasets_outputs() AND trustwork.datasets_distinct(purposes)),
  uses jsonb NOT NULL CHECK (trustwork.datasets_licence_uses_ok(uses)),
  valid_from date NOT NULL,
  valid_until date NOT NULL,
  recorded_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dataset_licence_period CHECK (valid_until >= valid_from)
);
CREATE INDEX dataset_licence_dataset_idx ON trustwork.dataset_licence (dataset_id, valid_until DESC);
CREATE TRIGGER dataset_licence_append_only BEFORE UPDATE OR DELETE ON trustwork.dataset_licence FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- The licence in force for a dataset at a date (NULL when none).
CREATE FUNCTION trustwork.datasets_licence_at(p_dataset uuid, p_on date) RETURNS trustwork.dataset_licence
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT * FROM trustwork.dataset_licence WHERE dataset_id = p_dataset AND p_on BETWEEN valid_from AND valid_until ORDER BY created_at DESC, id DESC LIMIT 1
$$;

-- 3. Do-not-collect list (digests only) ---------------------------------------------------------------------------------
CREATE TABLE trustwork.dataset_do_not_collect (
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  key_kind text NOT NULL CHECK (key_kind IN ('identifier', 'domain', 'email')),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (reason IN ('objection', 'erasure', 'legal_demand', 'operator_decision')),
  added_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hub_id, key_kind, digest)
);
CREATE TRIGGER dataset_do_not_collect_permanent BEFORE UPDATE OR DELETE ON trustwork.dataset_do_not_collect FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Records with per-record provenance --------------------------------------------------------------------------------
-- Fields: an object of up to 40 short string values with plain field names; nothing that ranks.
CREATE FUNCTION trustwork.datasets_fields_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(p) = 'object' AND (SELECT count(*) FROM jsonb_object_keys(p)) <= 40
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) e
      WHERE e.key !~ '^[a-z][a-zA-Z0-9_]{0,60}$' OR e.key ~* '(score|(^|[^e])rank|badge|weight|boost|promot|priorit|reputation|rating)'
         OR jsonb_typeof(e.value) <> 'string' OR length(e.value #>> '{}') > 2000)
$$;
-- Provenance: {sourceUrl, observedAt, method, licenceSnapshot} with an https URL and the source's allowed uses.
CREATE FUNCTION trustwork.datasets_provenance_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_typeof(p) = 'object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) = ARRAY['licenceSnapshot', 'method', 'observedAt', 'sourceUrl']
    AND (p ->> 'sourceUrl') ~ '^https://[^\s]+$' AND length(p ->> 'sourceUrl') <= 2000
    AND (p ->> 'observedAt') ~ '^\d{4}-\d{2}-\d{2}T'
    AND (p ->> 'method') IN ('register_api', 'structured_feed', 'page_markup', 'model_extraction', 'manual', 'operator_file')
    AND trustwork.sources_uses_ok(p -> 'licenceSnapshot')
$$;

CREATE TABLE trustwork.dataset_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  dataset_id uuid NOT NULL REFERENCES trustwork.dataset (id),
  source_id uuid NOT NULL REFERENCES trustwork.source (id),
  external_key text NOT NULL CHECK (external_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$'),
  identifier_kind text NULL CHECK (identifier_kind ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?-[A-Z][A-Z0-9]{1,11}$'),
  identifier_value text NULL CHECK (identifier_value ~ '^[A-Za-z0-9][A-Za-z0-9 ./-]{0,63}$'),
  identifier_norm text GENERATED ALWAYS AS (trustwork.datasets_norm(identifier_value)) STORED,
  natural_person boolean NOT NULL,
  fields jsonb NOT NULL CHECK (trustwork.datasets_fields_ok(fields)),
  provenance jsonb NOT NULL CHECK (trustwork.datasets_provenance_ok(provenance)),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  contact_use boolean NOT NULL DEFAULT false,
  contact_use_by uuid NULL REFERENCES trustwork.person (id),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dataset_record_key UNIQUE (dataset_id, external_key),
  CONSTRAINT dataset_record_identifier CHECK ((identifier_kind IS NULL) = (identifier_value IS NULL)),
  CONSTRAINT dataset_record_contact CHECK (contact_use = (contact_use_by IS NOT NULL)),
  -- Contact points never concern natural persons here (named contacts belong to OUTR-002's own gates).
  CONSTRAINT dataset_record_contact_person CHECK (NOT contact_use OR NOT natural_person),
  CONSTRAINT dataset_record_expiry CHECK (expires_at > observed_at)
);
CREATE INDEX dataset_record_identifier_idx ON trustwork.dataset_record (hub_id, identifier_kind, identifier_norm);
CREATE INDEX dataset_record_expiry_idx ON trustwork.dataset_record (expires_at);

-- 5. Tombstones ---------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.dataset_tombstone (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  dataset_id uuid NOT NULL REFERENCES trustwork.dataset (id),
  record_id uuid NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (reason IN ('retention', 'licence_ended', 'do_not_collect', 'dataset_retired')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dataset_tombstone_dataset_idx ON trustwork.dataset_tombstone (dataset_id, created_at);
CREATE TRIGGER dataset_tombstone_append_only BEFORE UPDATE OR DELETE ON trustwork.dataset_tombstone FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 6. Helpers ------------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.datasets_require_hub(p_hub uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_hub IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.hub WHERE id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
END $$;
CREATE FUNCTION trustwork.datasets_staff(p_ctx jsonb, p_permissions text[], p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM trustwork.datasets_require_hub(p_hub);
  RETURN trustwork.admin_authorize(p_ctx, p_permissions, NULL, p_hub);
END $$;
CREATE FUNCTION trustwork.datasets_check_revision(p_actual integer, p_expected integer) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_expected IS NULL OR p_actual <> p_expected THEN
    RAISE EXCEPTION 'the record changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'datasets.revision_conflict';
  END IF;
END $$;
CREATE FUNCTION trustwork.datasets_locked(p_dataset uuid) RETURNS trustwork.dataset
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.dataset%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.dataset WHERE id = p_dataset FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such dataset' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN v_row;
END $$;

-- Deletes a record and leaves a tombstone with a digest of its key.
CREATE FUNCTION trustwork.datasets_bury(p_record trustwork.dataset_record, p_reason text) RETURNS void
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  INSERT INTO trustwork.dataset_tombstone (hub_id, dataset_id, record_id, key_digest, reason)
  VALUES (p_record.hub_id, p_record.dataset_id, p_record.id, encode(sha256(convert_to('dataset-record:' || p_record.dataset_id::text || ':' || p_record.external_key, 'UTF8')), 'hex'), p_reason);
  DELETE FROM trustwork.dataset_record WHERE id = p_record.id;
$$;

-- Whether an incoming record matches the hub's do-not-collect list (identifier, website domain or e-mail field).
CREATE FUNCTION trustwork.datasets_blocked(p_hub uuid, p_record jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.dataset_do_not_collect d
     WHERE d.hub_id = p_hub AND (
       (d.key_kind = 'identifier' AND p_record ? 'identifierValue' AND jsonb_typeof(p_record -> 'identifierValue') = 'string'
          AND d.digest = trustwork.datasets_dnc_digest('identifier', p_record ->> 'identifierValue'))
       OR (d.key_kind = 'domain' AND jsonb_typeof(p_record #> '{fields,website}') = 'string'
          AND d.digest = trustwork.datasets_dnc_digest('domain', regexp_replace(lower(p_record #>> '{fields,website}'), '^https?://(www\.)?([^/:]+).*$', '\2')))
       OR (d.key_kind = 'email' AND jsonb_typeof(p_record #> '{fields,email}') = 'string'
          AND d.digest = trustwork.datasets_dnc_digest('email', p_record #>> '{fields,email}'))))
$$;

-- Stores a batch of records for an active dataset: the do-not-collect list is consulted first (blocked records are
-- dropped, and an already stored one is buried); unchanged records only refresh their expiry. Returns counts.
CREATE FUNCTION trustwork.datasets_store(p_dataset trustwork.dataset, p_records jsonb, p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_rec jsonb;
  v_source trustwork.source%ROWTYPE;
  v_digest text;
  v_existing trustwork.dataset_record%ROWTYPE;
  v_licence trustwork.dataset_licence%ROWTYPE;
  v_stored integer := 0;
  v_unchanged integer := 0;
  v_dropped integer := 0;
BEGIN
  IF p_dataset.status <> 'active' THEN
    RAISE EXCEPTION 'records arrive only for an active dataset' USING ERRCODE = 'check_violation', HINT = 'datasets.not_active';
  END IF;
  IF p_dataset.legal_basis = 'contract' THEN
    v_licence := trustwork.datasets_licence_at(p_dataset.id, (p_now AT TIME ZONE 'UTC')::date);
    IF v_licence.id IS NULL THEN
      RAISE EXCEPTION 'the dataset licence is not in force' USING ERRCODE = 'check_violation', HINT = 'datasets.licence_required';
    END IF;
  END IF;
  IF jsonb_typeof(p_records) <> 'array' OR jsonb_array_length(p_records) > 5000 THEN
    RAISE EXCEPTION 'at most 5000 records' USING ERRCODE = 'check_violation', HINT = 'datasets.invalid_record';
  END IF;
  FOR v_rec IN SELECT e FROM jsonb_array_elements(p_records) e LOOP
    IF jsonb_typeof(v_rec) <> 'object' OR NOT ((v_rec ->> 'sourceId')::uuid = ANY (p_dataset.source_ids)) THEN
      RAISE EXCEPTION 'a record comes from a source of the dataset' USING ERRCODE = 'check_violation', HINT = 'datasets.source_not_in_dataset';
    END IF;
    SELECT * INTO v_existing FROM trustwork.dataset_record WHERE dataset_id = p_dataset.id AND external_key = v_rec ->> 'externalKey' FOR UPDATE;
    IF trustwork.datasets_blocked(p_dataset.hub_id, v_rec) THEN
      IF v_existing.id IS NOT NULL THEN PERFORM trustwork.datasets_bury(v_existing, 'do_not_collect'); END IF;
      v_dropped := v_dropped + 1;
      CONTINUE;
    END IF;
    SELECT * INTO v_source FROM trustwork.source WHERE id = (v_rec ->> 'sourceId')::uuid;
    IF v_source.status <> 'active' THEN
      RAISE EXCEPTION 'the source is %', v_source.status USING ERRCODE = 'check_violation', HINT = 'datasets.source_not_active';
    END IF;
    v_digest := encode(sha256(convert_to(coalesce(v_rec ->> 'identifierKind', '') || '|' || coalesce(v_rec ->> 'identifierValue', '') || '|' || (v_rec -> 'fields')::text
      || '|' || coalesce(v_rec ->> 'naturalPerson', ''), 'UTF8')), 'hex');
    IF v_existing.id IS NOT NULL AND v_existing.content_digest = v_digest THEN
      UPDATE trustwork.dataset_record SET expires_at = greatest(expires_at, p_now + make_interval(days => p_dataset.retention_days)), updated_at = now() WHERE id = v_existing.id;
      v_unchanged := v_unchanged + 1;
      CONTINUE;
    END IF;
    INSERT INTO trustwork.dataset_record (hub_id, dataset_id, source_id, external_key, identifier_kind, identifier_value, natural_person, fields, provenance, content_digest,
      observed_at, expires_at)
    VALUES (p_dataset.hub_id, p_dataset.id, v_source.id, v_rec ->> 'externalKey', v_rec ->> 'identifierKind', v_rec ->> 'identifierValue',
      coalesce((v_rec ->> 'naturalPerson')::boolean, true), coalesce(v_rec -> 'fields', '{}'::jsonb),
      jsonb_build_object('sourceUrl', v_rec ->> 'sourceUrl', 'observedAt', to_char(p_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'method', coalesce(v_rec ->> 'method', 'structured_feed'), 'licenceSnapshot', v_source.allowed_uses),
      v_digest, p_now, p_now + make_interval(days => p_dataset.retention_days))
    ON CONFLICT (dataset_id, external_key) DO UPDATE SET identifier_kind = EXCLUDED.identifier_kind, identifier_value = EXCLUDED.identifier_value,
      natural_person = EXCLUDED.natural_person, fields = EXCLUDED.fields, provenance = EXCLUDED.provenance, content_digest = EXCLUDED.content_digest,
      observed_at = EXCLUDED.observed_at, expires_at = EXCLUDED.expires_at, updated_at = now(),
      -- A changed record loses its contact decision: a person decides again on what is actually stored.
      contact_use = false, contact_use_by = NULL;
    v_stored := v_stored + 1;
  END LOOP;
  RETURN jsonb_build_object('stored', v_stored, 'unchanged', v_unchanged, 'droppedDoNotCollect', v_dropped);
END $$;

-- 7. Commands -------------------------------------------------------------------------------------------------------------
-- Every command takes DATA-002's command context p_ctx ({elevationId, requestId, reasonCode, reasonText}).

-- A dataset proposal; every source must be a source of the hub.
CREATE FUNCTION trustwork.datasets_propose(p_ctx jsonb, p_hub uuid, p_input jsonb) RETURNS trustwork.dataset
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.datasets.edit'], p_hub);
  v_sources uuid[];
  v_row trustwork.dataset%ROWTYPE;
BEGIN
  v_sources := ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_input -> 'sourceIds') = 'array' THEN p_input -> 'sourceIds' ELSE '[]'::jsonb END)::uuid);
  IF cardinality(v_sources) = 0 OR EXISTS (SELECT 1 FROM unnest(v_sources) s WHERE NOT EXISTS (SELECT 1 FROM trustwork.source x WHERE x.id = s AND x.hub_id = p_hub)) THEN
    RAISE EXCEPTION 'a dataset draws on sources of the hub' USING ERRCODE = 'check_violation', HINT = 'datasets.source_not_in_hub';
  END IF;
  IF jsonb_typeof(p_input -> 'outputs') = 'array' AND (p_input -> 'outputs') ? 'reputation' THEN
    RAISE EXCEPTION 'reputation is never a dataset output' USING ERRCODE = 'check_violation', HINT = 'datasets.reputation_not_an_output';
  END IF;
  INSERT INTO trustwork.dataset (hub_id, subject, name, source_ids, purpose, legal_basis, personal_present, natural_persons, personal_categories, impact_assessment_ref,
    retention_class, retention_days, outputs, public_display, subject_notice, refresh_schedule_id, proposed_by)
  VALUES (p_hub, p_input ->> 'subject', p_input ->> 'name', v_sources, p_input ->> 'purpose', p_input ->> 'legalBasis',
    (p_input #>> '{personalData,present}')::boolean, (p_input #>> '{personalData,naturalPersons}')::boolean,
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_input #> '{personalData,categories}', '[]'::jsonb))), NULLIF(p_input ->> 'impactAssessmentRef', '')::uuid,
    p_input #>> '{retention,className}', (p_input #>> '{retention,days}')::integer, ARRAY(SELECT jsonb_array_elements_text(p_input -> 'outputs')),
    (p_input ->> 'publicDisplay')::boolean, (p_input ->> 'subjectNotice')::boolean, NULLIF(p_input ->> 'refreshScheduleId', '')::uuid, v_actor.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'datasets.proposed', 'dataset', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Activation by a person other than the proposer. Personal data, court and debt datasets consume a second person's
-- approval of exactly this dataset revision; a dataset under a contract needs a licence in force.
CREATE FUNCTION trustwork.datasets_activate(p_ctx jsonb, p_dataset uuid, p_expected_revision integer, p_approval uuid) RETURNS trustwork.dataset
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.dataset%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.dataset%ROWTYPE;
  v_action text;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_before := trustwork.datasets_locked(p_dataset);
  v_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.datasets.activate'], v_before.hub_id);
  PERFORM trustwork.datasets_check_revision(v_before.revision, p_expected_revision);
  IF v_before.status NOT IN ('proposed', 'paused') THEN
    RAISE EXCEPTION 'a % dataset is not activated', v_before.status USING ERRCODE = 'check_violation', HINT = 'datasets.invalid_transition';
  END IF;
  IF v_actor.person_id = v_before.proposed_by THEN
    RAISE EXCEPTION 'the proposer does not activate their own dataset' USING ERRCODE = 'insufficient_privilege', HINT = 'datasets.self_activation';
  END IF;
  IF v_before.legal_basis = 'contract' AND (trustwork.datasets_licence_at(v_before.id, current_date)).id IS NULL THEN
    RAISE EXCEPTION 'a dataset under a contract needs a licence in force' USING ERRCODE = 'check_violation', HINT = 'datasets.licence_required';
  END IF;
  v_action := CASE WHEN v_before.subject IN ('court_cases', 'debts_tax_arrears') THEN 'datasets.activate_court_or_debt'
                   WHEN v_before.personal_present THEN 'pipelines.activate_personal_data_dataset' END;
  IF v_action IS NOT NULL THEN
    IF p_approval IS NULL THEN
      RAISE EXCEPTION 'this dataset needs a second person' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    PERFORM trustwork.admin_consume_approval(p_approval, v_action, 'hub', NULL, v_before.hub_id, trustwork.datasets_activation_digest(v_before.id, v_before.revision), v_before.id);
  END IF;
  UPDATE trustwork.dataset SET status = 'active', activated_by = v_actor.person_id, activated_at = now(), approval_id = CASE WHEN v_action IS NULL THEN NULL ELSE p_approval END,
         revision = revision + 1, updated_at = now()
   WHERE id = p_dataset RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'datasets.activated', 'dataset', v_row.id, to_jsonb(v_before), to_jsonb(v_row), NULL, p_approval);
  RETURN v_row;
END $$;

-- Pause or retire. Retiring buries every record of the dataset.
CREATE FUNCTION trustwork.datasets_set_status(p_ctx jsonb, p_dataset uuid, p_expected_revision integer, p_to text) RETURNS trustwork.dataset
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.dataset%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.dataset%ROWTYPE;
  v_record trustwork.dataset_record%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_before := trustwork.datasets_locked(p_dataset);
  v_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.datasets.edit'], v_before.hub_id);
  PERFORM trustwork.datasets_check_revision(v_before.revision, p_expected_revision);
  IF NOT ((p_to = 'paused' AND v_before.status = 'active') OR (p_to = 'retired' AND v_before.status <> 'retired')) THEN
    RAISE EXCEPTION 'a % dataset does not move to %', v_before.status, p_to USING ERRCODE = 'check_violation', HINT = 'datasets.invalid_transition';
  END IF;
  IF p_to = 'retired' THEN
    FOR v_record IN SELECT * FROM trustwork.dataset_record WHERE dataset_id = p_dataset FOR UPDATE LOOP
      PERFORM trustwork.datasets_bury(v_record, 'dataset_retired');
    END LOOP;
  END IF;
  UPDATE trustwork.dataset SET status = p_to, revision = revision + 1, updated_at = now() WHERE id = p_dataset RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'datasets.' || p_to, 'dataset', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- An operator dataset licence: supplier, agreement evidence (digest and reference), purposes and uses, period.
CREATE FUNCTION trustwork.datasets_record_licence(p_ctx jsonb, p_dataset uuid, p_input jsonb) RETURNS trustwork.dataset_licence
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_dataset trustwork.dataset%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.dataset_licence%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_dataset := trustwork.datasets_locked(p_dataset);
  v_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.datasets.edit'], v_dataset.hub_id);
  INSERT INTO trustwork.dataset_licence (hub_id, dataset_id, supplier, agreement_digest, agreement_ref, purposes, uses, valid_from, valid_until, recorded_by)
  VALUES (v_dataset.hub_id, v_dataset.id, p_input ->> 'supplier', p_input ->> 'agreementDigest', p_input ->> 'agreementRef',
    ARRAY(SELECT jsonb_array_elements_text(p_input -> 'purposes')), p_input -> 'uses', (p_input ->> 'validFrom')::date, (p_input ->> 'validUntil')::date, v_actor.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_dataset.hub_id, 'datasets.licence_recorded', 'dataset_licence', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Contact use for a dataset: set only by a person; never for court, debt or people data; under a contract only when
-- the licence in force grants contact use.
CREATE FUNCTION trustwork.datasets_set_contact_use(p_ctx jsonb, p_dataset uuid, p_expected_revision integer, p_allowed boolean) RETURNS trustwork.dataset
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.dataset%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.dataset%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_before := trustwork.datasets_locked(p_dataset);
  v_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.datasets.edit'], v_before.hub_id);
  PERFORM trustwork.datasets_check_revision(v_before.revision, p_expected_revision);
  IF p_allowed AND v_before.legal_basis = 'contract'
     AND NOT coalesce(((trustwork.datasets_licence_at(v_before.id, current_date)).uses ->> 'contactUse')::boolean, false) THEN
    RAISE EXCEPTION 'the dataset licence does not grant contact use' USING ERRCODE = 'check_violation', HINT = 'datasets.licence_forbids_contact';
  END IF;
  UPDATE trustwork.dataset SET contact_use_allowed = p_allowed, revision = revision + 1, updated_at = now() WHERE id = p_dataset RETURNING * INTO v_row;
  IF NOT p_allowed THEN
    UPDATE trustwork.dataset_record SET contact_use = false, contact_use_by = NULL, updated_at = now() WHERE dataset_id = p_dataset AND contact_use;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'datasets.contact_use_set', 'dataset', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- A person marks one stored record as usable as a contact point (organisation records of a dataset that allows it).
CREATE FUNCTION trustwork.datasets_mark_contact(p_ctx jsonb, p_record uuid, p_allowed boolean) RETURNS trustwork.dataset_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_record trustwork.dataset_record%ROWTYPE;
  v_dataset trustwork.dataset%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.dataset_record%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_record FROM trustwork.dataset_record WHERE id = p_record FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such record' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT * INTO v_dataset FROM trustwork.dataset WHERE id = v_record.dataset_id;
  v_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.datasets.edit'], v_record.hub_id);
  IF p_allowed AND (NOT v_dataset.contact_use_allowed OR v_record.natural_person) THEN
    RAISE EXCEPTION 'this record cannot be a contact point' USING ERRCODE = 'check_violation', HINT = 'datasets.contact_not_allowed';
  END IF;
  UPDATE trustwork.dataset_record SET contact_use = p_allowed, contact_use_by = CASE WHEN p_allowed THEN v_actor.person_id END, updated_at = now()
   WHERE id = p_record RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'datasets.contact_marked', 'dataset_record', v_row.id, NULL,
    jsonb_build_object('contactUse', p_allowed));
  RETURN v_row;
END $$;

-- Adds an entry to the do-not-collect list (the value is hashed here and never stored) and buries matching records.
CREATE FUNCTION trustwork.datasets_add_do_not_collect(p_ctx jsonb, p_hub uuid, p_kind text, p_value text, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.datasets.edit', 'admin.privacy.request.read'], p_hub);
  v_digest text;
  v_record trustwork.dataset_record%ROWTYPE;
  v_buried integer := 0;
BEGIN
  IF p_kind NOT IN ('identifier', 'domain', 'email') OR p_value IS NULL OR length(btrim(p_value)) NOT BETWEEN 1 AND 320 THEN
    RAISE EXCEPTION 'a do-not-collect entry is an identifier, a domain or an e-mail' USING ERRCODE = 'check_violation', HINT = 'datasets.invalid_entry';
  END IF;
  v_digest := trustwork.datasets_dnc_digest(p_kind, p_value);
  INSERT INTO trustwork.dataset_do_not_collect (hub_id, key_kind, digest, reason, added_by) VALUES (p_hub, p_kind, v_digest, p_reason, v_actor.person_id)
  ON CONFLICT DO NOTHING;
  FOR v_record IN SELECT * FROM trustwork.dataset_record r WHERE r.hub_id = p_hub
      AND trustwork.datasets_blocked(p_hub, jsonb_build_object('identifierValue', r.identifier_value, 'fields', r.fields)) FOR UPDATE LOOP
    PERFORM trustwork.datasets_bury(v_record, 'do_not_collect');
    v_buried := v_buried + 1;
  END LOOP;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'datasets.do_not_collect_added', 'dataset_do_not_collect', trustwork.new_uuid(), NULL,
    jsonb_build_object('kind', p_kind, 'reason', p_reason, 'buried', v_buried));
  RETURN v_buried;
END $$;

-- A staff run with records (fake adapters and operator files go through here; live refresh goes through the worker).
CREATE FUNCTION trustwork.datasets_ingest(p_ctx jsonb, p_dataset uuid, p_records jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_dataset trustwork.dataset%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_counts jsonb;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_dataset := trustwork.datasets_locked(p_dataset);
  v_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.datasets.edit'], v_dataset.hub_id);
  v_counts := trustwork.datasets_store(v_dataset, p_records, now());
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_dataset.hub_id, 'datasets.ingested', 'dataset', v_dataset.id, NULL, v_counts);
  RETURN v_counts;
END $$;

-- 8. Reads -----------------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.datasets_staff_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND p_hub IS NOT NULL AND trustwork.admin_has_any_permission(trustwork.datasets_reader_permissions(), NULL, p_hub)
$$;

-- Contact points for outreach (OUTR-002 reads these): organisation records a person marked, of a dataset that allows
-- contact use, with their provenance. Staff of the hub only.
CREATE FUNCTION trustwork.datasets_contact_points(p_hub uuid, p_dataset uuid)
RETURNS TABLE (record_id uuid, external_key text, identifier_kind text, identifier_value text, fields jsonb, provenance jsonb, observed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.datasets_staff_reader(p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN QUERY SELECT r.id, r.external_key, r.identifier_kind, r.identifier_value, r.fields, r.provenance, r.observed_at
    FROM trustwork.dataset_record r JOIN trustwork.dataset d ON d.id = r.dataset_id
   WHERE r.hub_id = p_hub AND r.dataset_id = p_dataset AND r.contact_use AND NOT r.natural_person AND d.contact_use_allowed AND d.status = 'active'
     AND trustwork.datasets_provenance_ok(r.provenance)
   ORDER BY r.external_key;
END $$;

-- 9. Worker ----------------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.datasets_worker_ingest(p_dataset uuid, p_records jsonb, p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  RETURN trustwork.datasets_store(trustwork.datasets_locked(p_dataset), p_records, p_now);
END $$;

-- Retention and licence expiry at p_now: records past expires_at are buried ('retention'); every record of a contract
-- dataset without a licence in force is buried ('licence_ended'). Returns the counts.
CREATE FUNCTION trustwork.datasets_sweep(p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_record trustwork.dataset_record%ROWTYPE;
  v_retention integer := 0;
  v_licence integer := 0;
BEGIN
  FOR v_record IN SELECT r.* FROM trustwork.dataset_record r JOIN trustwork.dataset d ON d.id = r.dataset_id
      WHERE d.legal_basis = 'contract' AND (trustwork.datasets_licence_at(d.id, (p_now AT TIME ZONE 'UTC')::date)).id IS NULL
      ORDER BY r.id LIMIT 10000 FOR UPDATE OF r SKIP LOCKED LOOP
    PERFORM trustwork.datasets_bury(v_record, 'licence_ended');
    v_licence := v_licence + 1;
  END LOOP;
  FOR v_record IN SELECT * FROM trustwork.dataset_record WHERE expires_at <= p_now ORDER BY expires_at, id LIMIT 10000 FOR UPDATE SKIP LOCKED LOOP
    PERFORM trustwork.datasets_bury(v_record, 'retention');
    v_retention := v_retention + 1;
  END LOOP;
  RETURN jsonb_build_object('retention', v_retention, 'licenceEnded', v_licence);
END $$;

-- 10. Access ------------------------------------------------------------------------------------------------------------------
ALTER TABLE trustwork.dataset ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.dataset FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.dataset_licence ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.dataset_licence FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.dataset_do_not_collect ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.dataset_do_not_collect FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.dataset_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.dataset_record FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.dataset_tombstone ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.dataset_tombstone FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.dataset AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.dataset_licence AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.dataset_do_not_collect AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.dataset_record AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.dataset_tombstone AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY dataset_read ON trustwork.dataset FOR SELECT TO trustwork_app USING (trustwork.datasets_staff_reader(hub_id));
CREATE POLICY dataset_licence_read ON trustwork.dataset_licence FOR SELECT TO trustwork_app USING (trustwork.datasets_staff_reader(hub_id));
CREATE POLICY dataset_record_read ON trustwork.dataset_record FOR SELECT TO trustwork_app USING (trustwork.datasets_staff_reader(hub_id));
CREATE POLICY dataset_tombstone_read ON trustwork.dataset_tombstone FOR SELECT TO trustwork_app USING (trustwork.datasets_staff_reader(hub_id));
-- The do-not-collect list is never read back by the runtime role (digests only, checked inside the commands).

GRANT SELECT ON trustwork.dataset, trustwork.dataset_licence, trustwork.dataset_record, trustwork.dataset_tombstone TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.datasets_propose(jsonb, uuid, jsonb), trustwork.datasets_activate(jsonb, uuid, integer, uuid), trustwork.datasets_set_status(jsonb, uuid, integer, text),
  trustwork.datasets_record_licence(jsonb, uuid, jsonb), trustwork.datasets_set_contact_use(jsonb, uuid, integer, boolean), trustwork.datasets_mark_contact(jsonb, uuid, boolean),
  trustwork.datasets_add_do_not_collect(jsonb, uuid, text, text, text), trustwork.datasets_ingest(jsonb, uuid, jsonb),
  trustwork.datasets_staff_reader(uuid), trustwork.datasets_contact_points(uuid, uuid),
  trustwork.datasets_subjects(), trustwork.datasets_outputs(), trustwork.datasets_legal_bases(), trustwork.datasets_personal_categories(), trustwork.datasets_reader_permissions(),
  trustwork.datasets_distinct(text[]), trustwork.datasets_licence_uses_ok(jsonb), trustwork.datasets_norm(text), trustwork.datasets_dnc_digest(text, text),
  trustwork.datasets_fields_ok(jsonb), trustwork.datasets_provenance_ok(jsonb), trustwork.datasets_activation_digest(uuid, integer)
TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.datasets_worker_ingest(uuid, jsonb, timestamptz), trustwork.datasets_sweep(timestamptz) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
