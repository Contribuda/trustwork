-- CLM-001 part 4: what a company is on record as: profile, identifiers, registrations, tax registrations and branches.
--
-- `company_identifier` is the expand step for `company.legal_identifiers` (docs/data/migration-plan.md rule 3). The old
-- column stays and its readers keep working: rows are backfilled here, a write to the column reaches the table through
-- a trigger, and the commands below mirror the table back into the column. Dropping the column is the contract step: a
-- later reviewed migration, after the readers moved, with backup and restore evidence.
--
-- Rules the schema holds:
--   * a value proves nothing. No function here writes a verification, a hand-over or the claim status, and a `verified`
--     identifier points at a passing verification check of the same company at the hub;
--   * a value is verified for one company only; several companies may state it;
--   * a verified-level administrator states records; a claimed-level holder edits descriptive fields only;
--   * during the cooling period identifiers and the website cannot change, for any caller;
--   * tax registrations are private: the company's administrators read them; the public and hub staff do not.
--
-- Contractor licences are not here: they are `professional_credential` rows of REP-001 checked through HUB-003 (check
-- type `licence`). Payout details have no company-level record yet (payment bindings are per person), so the cooling
-- lock cannot reach them; `claims_cooling` is granted for the payment module to call when that record exists.

CREATE FUNCTION trustwork.claims_identifier_kind_ok(p_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_kind ~ '^(?:[A-Z]{2}(?:-[A-Z0-9]{2,8}){1,3}|other)$' $$;
CREATE FUNCTION trustwork.claims_jurisdiction_ok(p_code text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_code ~ '^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$' $$;

CREATE TABLE trustwork.company_profile (
  company_id uuid PRIMARY KEY REFERENCES trustwork.company (id),
  legal_form text NULL CHECK (legal_form IS NULL OR legal_form ~ '^[A-Z]{2}-[A-Z0-9-]{2,20}$'),
  website_url text NULL CHECK (website_url IS NULL OR (length(website_url) <= 300 AND website_url ~ '^https?://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/\S*)?$')),
  region_code text NULL CHECK (region_code IS NULL OR trustwork.claims_jurisdiction_ok(region_code)),
  categories text[] NOT NULL DEFAULT '{}' CHECK (cardinality(categories) <= 20),
  public_fields text[] NOT NULL DEFAULT '{}' CHECK (public_fields <@ ARRAY['legal_form', 'website_url', 'region_code', 'categories']::text[]),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by uuid NOT NULL REFERENCES trustwork.person (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trustwork.company_identifier (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  kind text NOT NULL CHECK (trustwork.claims_identifier_kind_ok(kind)),
  jurisdiction text NULL CHECK (jurisdiction IS NULL OR trustwork.claims_jurisdiction_ok(jurisdiction)),
  value text NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 64),
  value_normalized text NOT NULL CHECK (length(value_normalized) BETWEEN 1 AND 64),
  status text NOT NULL CHECK (status IN ('sourced', 'claimed', 'verified')),
  source_ref text NULL CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 200),
  verification_check_id uuid NULL REFERENCES trustwork.verification_check (id),
  created_by uuid NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- `legacy` marks a status copied from the old column, which recorded no check.
  CONSTRAINT company_identifier_verified CHECK (status <> 'verified' OR verification_check_id IS NOT NULL OR source_ref = 'legacy')
);
CREATE UNIQUE INDEX company_identifier_live_uq ON trustwork.company_identifier (company_id, kind, value_normalized) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX company_identifier_verified_uq ON trustwork.company_identifier (kind, value_normalized) WHERE status = 'verified' AND retired_at IS NULL AND verification_check_id IS NOT NULL;

CREATE TABLE trustwork.company_registration (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  jurisdiction text NOT NULL CHECK (trustwork.claims_jurisdiction_ok(jurisdiction)),
  kind text NOT NULL CHECK (kind IN ('formation', 'foreign_qualification', 'dba', 'branch')),
  registered_name text NOT NULL CHECK (length(btrim(registered_name)) BETWEEN 1 AND 300),
  number text NULL CHECK (number IS NULL OR length(btrim(number)) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('active', 'inactive', 'unknown')),
  observed_at timestamptz NULL,
  source_ref text NULL CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 200),
  created_by uuid NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz NULL
);
CREATE INDEX company_registration_company_idx ON trustwork.company_registration (company_id) WHERE retired_at IS NULL;

CREATE TABLE trustwork.tax_registration (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  jurisdiction text NOT NULL CHECK (trustwork.claims_jurisdiction_ok(jurisdiction)),
  kind text NOT NULL CHECK (trustwork.claims_identifier_kind_ok(kind)),
  number text NOT NULL CHECK (length(btrim(number)) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('active', 'inactive', 'unknown')),
  valid_until date NULL,
  created_by uuid NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz NULL
);
CREATE INDEX tax_registration_company_idx ON trustwork.tax_registration (company_id) WHERE retired_at IS NULL;

CREATE TABLE trustwork.company_branch (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  address jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(address) = 'object' AND octet_length(address::text) <= 2000),
  region_code text NULL CHECK (region_code IS NULL OR trustwork.claims_jurisdiction_ok(region_code)),
  public boolean NOT NULL DEFAULT false,
  created_by uuid NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz NULL
);
CREATE INDEX company_branch_company_idx ON trustwork.company_branch (company_id) WHERE retired_at IS NULL;

-- Expand: what the old column holds today.
INSERT INTO trustwork.company_identifier (company_id, kind, value, value_normalized, status, source_ref)
SELECT DISTINCT ON (c.id, i ->> 'kind', trustwork.registers_norm(i ->> 'value')) c.id, i ->> 'kind', i ->> 'value', trustwork.registers_norm(i ->> 'value'), coalesce(i ->> 'status', 'sourced'), 'legacy'
  FROM trustwork.company c, jsonb_array_elements(c.legal_identifiers) i
 WHERE trustwork.claims_identifier_kind_ok(i ->> 'kind') AND length(btrim(i ->> 'value')) BETWEEN 1 AND 64 AND length(trustwork.registers_norm(i ->> 'value')) BETWEEN 1 AND 64;

-- A write to the old column reaches the table; values gone from it retire. Rows the commands already mirrored match, so
-- nothing happens for them.
CREATE FUNCTION trustwork.claims_legacy_identifiers() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  INSERT INTO trustwork.company_identifier (company_id, kind, value, value_normalized, status, source_ref)
  SELECT DISTINCT ON (i ->> 'kind', trustwork.registers_norm(i ->> 'value')) NEW.id, i ->> 'kind', i ->> 'value', trustwork.registers_norm(i ->> 'value'), coalesce(i ->> 'status', 'sourced'), 'legacy'
    FROM jsonb_array_elements(NEW.legal_identifiers) i
   WHERE trustwork.claims_identifier_kind_ok(i ->> 'kind') AND length(btrim(i ->> 'value')) BETWEEN 1 AND 64 AND length(trustwork.registers_norm(i ->> 'value')) BETWEEN 1 AND 64
     -- Rows already live are skipped here, not by the conflict clause: an upsert would fire the cooling guard for them.
     AND NOT EXISTS (SELECT 1 FROM trustwork.company_identifier r WHERE r.company_id = NEW.id AND r.kind = i ->> 'kind' AND r.value_normalized = trustwork.registers_norm(i ->> 'value') AND r.retired_at IS NULL)
  ON CONFLICT (company_id, kind, value_normalized) WHERE retired_at IS NULL DO NOTHING;
  UPDATE trustwork.company_identifier r SET retired_at = now(), revision = r.revision + 1
   WHERE r.company_id = NEW.id AND r.retired_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.legal_identifiers) i WHERE i ->> 'kind' = r.kind AND trustwork.registers_norm(i ->> 'value') = r.value_normalized);
  RETURN NULL;
END $$;
CREATE TRIGGER company_legacy_identifiers AFTER INSERT OR UPDATE OF legal_identifiers ON trustwork.company FOR EACH ROW EXECUTE FUNCTION trustwork.claims_legacy_identifiers();

-- The commands' way back: the old column shows the live rows.
CREATE FUNCTION trustwork.claims_mirror_identifiers(p_company uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
BEGIN
  UPDATE trustwork.company c SET legal_identifiers = coalesce((
    SELECT jsonb_agg(jsonb_build_object('kind', r.kind, 'value', r.value, 'status', r.status) ORDER BY r.created_at, r.id)
      FROM trustwork.company_identifier r WHERE r.company_id = p_company AND r.retired_at IS NULL), '[]'::jsonb)
   WHERE c.id = p_company;
END $$;

-- Cooling: the values are locked, not the status a reviewer records about them.
CREATE FUNCTION trustwork.claims_identifier_values(p jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(array_agg((i ->> 'kind') || ':' || (i ->> 'value') ORDER BY i ->> 'kind', i ->> 'value'), ARRAY[]::text[]) FROM jsonb_array_elements(p) i $$;

CREATE OR REPLACE FUNCTION trustwork.claims_company_cooling_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF (NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.verified_domains IS DISTINCT FROM OLD.verified_domains
      OR trustwork.claims_identifier_values(NEW.legal_identifiers) IS DISTINCT FROM trustwork.claims_identifier_values(OLD.legal_identifiers))
     AND trustwork.claims_cooling(NEW.id) THEN
    RAISE EXCEPTION 'sensitive company details are locked during the cooling period' USING ERRCODE = 'check_violation', HINT = 'claims.cooling_period';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION trustwork.claims_identifier_cooling_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR (NEW.kind, NEW.value, NEW.retired_at) IS DISTINCT FROM (OLD.kind, OLD.value, OLD.retired_at)) AND trustwork.claims_cooling(NEW.company_id) THEN
    RAISE EXCEPTION 'identifiers are locked during the cooling period' USING ERRCODE = 'check_violation', HINT = 'claims.cooling_period';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_identifier_cooling BEFORE INSERT OR UPDATE ON trustwork.company_identifier FOR EACH ROW EXECUTE FUNCTION trustwork.claims_identifier_cooling_guard();

CREATE FUNCTION trustwork.claims_profile_cooling_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  -- The stored row, not OLD: an upsert fires this as an INSERT before it becomes an UPDATE.
  IF NEW.website_url IS DISTINCT FROM (SELECT f.website_url FROM trustwork.company_profile f WHERE f.company_id = NEW.company_id) AND trustwork.claims_cooling(NEW.company_id) THEN
    RAISE EXCEPTION 'the website is locked during the cooling period' USING ERRCODE = 'check_violation', HINT = 'claims.cooling_period';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_profile_cooling BEFORE INSERT OR UPDATE ON trustwork.company_profile FOR EACH ROW EXECUTE FUNCTION trustwork.claims_profile_cooling_guard();

-- Who speaks for a page.
CREATE FUNCTION trustwork.claims_is_administrator(p_company uuid, p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.membership WHERE company_id = p_company AND person_id = p_person AND status = 'active' AND role = 'administrator')
$$;
CREATE FUNCTION trustwork.claims_require_company(p_company uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM 1 FROM trustwork.company WHERE id = p_company FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such page' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
END $$;

-- One record of a kind from its payload. Status and source come from the caller, never from the payload.
CREATE FUNCTION trustwork.claims_record_insert(p_company uuid, p_kind text, p jsonb, p_status text, p_source text, p_actor uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_kind = 'identifier' THEN
    INSERT INTO trustwork.company_identifier (company_id, kind, jurisdiction, value, value_normalized, status, source_ref, created_by)
    VALUES (p_company, p ->> 'identifierKind', p ->> 'jurisdiction', btrim(p ->> 'value'), trustwork.registers_norm(p ->> 'value'), p_status, p_source, p_actor) RETURNING id INTO v_id;
    PERFORM trustwork.claims_mirror_identifiers(p_company);
  ELSIF p_kind = 'registration' THEN
    INSERT INTO trustwork.company_registration (company_id, jurisdiction, kind, registered_name, number, status, observed_at, source_ref, created_by)
    VALUES (p_company, p ->> 'jurisdiction', p ->> 'registrationKind', p ->> 'registeredName', p ->> 'number', coalesce(p ->> 'status', 'unknown'), (p ->> 'observedAt')::timestamptz, p_source, p_actor) RETURNING id INTO v_id;
  ELSIF p_kind = 'tax_registration' THEN
    INSERT INTO trustwork.tax_registration (company_id, jurisdiction, kind, number, status, valid_until, created_by)
    VALUES (p_company, p ->> 'jurisdiction', p ->> 'taxKind', p ->> 'number', coalesce(p ->> 'status', 'unknown'), (p ->> 'validUntil')::date, p_actor) RETURNING id INTO v_id;
  ELSIF p_kind = 'branch' THEN
    INSERT INTO trustwork.company_branch (company_id, hub_id, name, address, region_code, public, created_by)
    VALUES (p_company, (p ->> 'hubId')::uuid, p ->> 'name', coalesce(p -> 'address', '{}'::jsonb), p ->> 'regionCode', coalesce((p ->> 'public')::boolean, false), p_actor) RETURNING id INTO v_id;
  ELSE
    RAISE EXCEPTION 'no such record kind' USING ERRCODE = 'check_violation', HINT = 'claims.invalid_record';
  END IF;
  RETURN v_id;
END $$;

-- A company administrator states a record. Nothing here touches a verification, a hand-over or the claim status.
CREATE FUNCTION trustwork.claims_record_add(p_company uuid, p_kind text, p_payload jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_id uuid;
BEGIN
  PERFORM trustwork.claims_require_company(p_company);
  IF v_person IS NULL OR NOT trustwork.claims_is_administrator(p_company, v_person) THEN
    RAISE EXCEPTION 'a company administrator states records' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.administrator_required';
  END IF;
  v_id := trustwork.claims_record_insert(p_company, p_kind, p_payload, 'claimed', NULL, v_person);
  INSERT INTO trustwork.audit_event (actor_person_id, action, object_kind, object_id, basis) VALUES (v_person, 'claims.record_added', 'company', p_company::text, jsonb_build_object('recordKind', p_kind, 'recordId', v_id));
  RETURN v_id;
END $$;

CREATE FUNCTION trustwork.claims_record_retire(p_company uuid, p_kind text, p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
BEGIN
  PERFORM trustwork.claims_require_company(p_company);
  IF v_person IS NULL OR NOT trustwork.claims_is_administrator(p_company, v_person) THEN
    RAISE EXCEPTION 'a company administrator retires records' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.administrator_required';
  END IF;
  IF p_kind = 'identifier' THEN
    UPDATE trustwork.company_identifier SET retired_at = now(), revision = revision + 1 WHERE id = p_record AND company_id = p_company AND retired_at IS NULL;
  ELSIF p_kind = 'registration' THEN
    UPDATE trustwork.company_registration SET retired_at = now() WHERE id = p_record AND company_id = p_company AND retired_at IS NULL;
  ELSIF p_kind = 'tax_registration' THEN
    UPDATE trustwork.tax_registration SET retired_at = now() WHERE id = p_record AND company_id = p_company AND retired_at IS NULL;
  ELSIF p_kind = 'branch' THEN
    UPDATE trustwork.company_branch SET retired_at = now() WHERE id = p_record AND company_id = p_company AND retired_at IS NULL;
  ELSE
    RAISE EXCEPTION 'no such record kind' USING ERRCODE = 'check_violation', HINT = 'claims.invalid_record';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such record' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  IF p_kind = 'identifier' THEN
    PERFORM trustwork.claims_mirror_identifiers(p_company);
  END IF;
  INSERT INTO trustwork.audit_event (actor_person_id, action, object_kind, object_id, basis) VALUES (v_person, 'claims.record_retired', 'company', p_company::text, jsonb_build_object('recordKind', p_kind, 'recordId', p_record));
END $$;

-- Descriptive fields: a holder of any active hand-over or an administrator. The legal form and the website are not
-- descriptive: only an administrator changes them.
CREATE FUNCTION trustwork.claims_set_profile(p_company uuid, p jsonb) RETURNS trustwork.company_profile
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_admin boolean;
  v_before trustwork.company_profile%ROWTYPE;
  v_row trustwork.company_profile%ROWTYPE;
BEGIN
  PERFORM trustwork.claims_require_company(p_company);
  v_admin := v_person IS NOT NULL AND trustwork.claims_is_administrator(p_company, v_person);
  IF NOT v_admin AND NOT EXISTS (SELECT 1 FROM trustwork.company_handover WHERE company_id = p_company AND person_id = v_person AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'only the people who run a page edit it' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.administrator_required';
  END IF;
  SELECT * INTO v_before FROM trustwork.company_profile WHERE company_id = p_company;
  IF NOT v_admin AND ((p ->> 'legalForm') IS DISTINCT FROM v_before.legal_form OR (p ->> 'websiteUrl') IS DISTINCT FROM v_before.website_url) THEN
    RAISE EXCEPTION 'the legal form and the website need a company administrator' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.administrator_required';
  END IF;
  INSERT INTO trustwork.company_profile (company_id, legal_form, website_url, region_code, categories, public_fields, updated_by)
  VALUES (p_company, p ->> 'legalForm', p ->> 'websiteUrl', p ->> 'regionCode', ARRAY(SELECT jsonb_array_elements_text(p -> 'categories')), ARRAY(SELECT jsonb_array_elements_text(p -> 'publicFields')), v_person)
  ON CONFLICT (company_id) DO UPDATE SET legal_form = EXCLUDED.legal_form, website_url = EXCLUDED.website_url, region_code = EXCLUDED.region_code, categories = EXCLUDED.categories,
    public_fields = EXCLUDED.public_fields, updated_by = EXCLUDED.updated_by, revision = company_profile.revision + 1, updated_at = now()
  RETURNING * INTO v_row;
  IF p ? 'description' THEN
    UPDATE trustwork.company SET public_description = NULLIF(btrim(coalesce(p ->> 'description', '')), '') WHERE id = p_company;
  END IF;
  INSERT INTO trustwork.audit_event (actor_person_id, action, object_kind, object_id, basis) VALUES (v_person, 'claims.profile_set', 'company', p_company::text, jsonb_build_object('revision', v_row.revision));
  RETURN v_row;
END $$;

-- Staff record what a source says: an identifier or a registration, labelled `sourced`, with where it came from.
CREATE FUNCTION trustwork.claims_staff_record_add(p_ctx jsonb, p_hub uuid, p_company uuid, p_kind text, p_payload jsonb, p_source text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], p_hub);
  v_id uuid;
BEGIN
  PERFORM trustwork.claims_require_company(p_company);
  IF p_kind NOT IN ('identifier', 'registration') OR p_source IS NULL THEN
    RAISE EXCEPTION 'staff record identifiers and registrations with their source' USING ERRCODE = 'check_violation', HINT = 'claims.invalid_record';
  END IF;
  v_id := trustwork.claims_record_insert(p_company, p_kind, p_payload, 'sourced', p_source, v_actor.person_id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'claims.record_sourced', 'company', p_company, NULL, jsonb_build_object('recordKind', p_kind, 'recordId', v_id));
  RETURN v_id;
END $$;

-- A reviewer ties an identifier to a passing check of the company at this hub. The label on the identifier is all that
-- changes: the badge comes only from a claim decision.
CREATE FUNCTION trustwork.claims_verify_identifier(p_ctx jsonb, p_hub uuid, p_identifier uuid, p_expected_revision integer, p_check uuid) RETURNS trustwork.company_identifier
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], p_hub);
  v_before trustwork.company_identifier%ROWTYPE;
  v_row trustwork.company_identifier%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.company_identifier WHERE id = p_identifier AND retired_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such identifier' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  PERFORM trustwork.claims_require_company(v_before.company_id);
  SELECT * INTO v_before FROM trustwork.company_identifier WHERE id = p_identifier FOR UPDATE;
  PERFORM trustwork.claims_check_revision(v_before.revision, p_expected_revision);
  IF NOT EXISTS (SELECT 1 FROM trustwork.verification_check c WHERE c.id = p_check AND c.hub_id = p_hub AND c.subject_company_id = v_before.company_id AND c.result = 'pass' AND c.expires_at > now()
                  AND c.check_type IN ('register_match', 'officer_match', 'tax_status', 'licence')) THEN
    RAISE EXCEPTION 'an identifier is verified by a passing check of the company' USING ERRCODE = 'check_violation', HINT = 'claims.check_mismatch';
  END IF;
  UPDATE trustwork.company_identifier SET status = 'verified', verification_check_id = p_check, revision = revision + 1 WHERE id = p_identifier RETURNING * INTO v_row;
  PERFORM trustwork.claims_mirror_identifiers(v_row.company_id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'claims.identifier_verified', 'company_identifier', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Reads. The tables have no runtime grant: every reader goes through one of these three projections.
CREATE FUNCTION trustwork.claims_records_json(p_company uuid, p_public boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object(
    'identifiers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'jurisdiction', r.jurisdiction, 'value', r.value, 'status', r.status, 'revision', r.revision) ORDER BY r.created_at, r.id)
      FROM trustwork.company_identifier r WHERE r.company_id = p_company AND r.retired_at IS NULL), '[]'::jsonb),
    'registrations', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'jurisdiction', r.jurisdiction, 'kind', r.kind, 'registeredName', r.registered_name, 'number', r.number, 'status', r.status, 'observedAt', r.observed_at) ORDER BY r.created_at, r.id)
      FROM trustwork.company_registration r WHERE r.company_id = p_company AND r.retired_at IS NULL), '[]'::jsonb),
    'branches', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'hubId', r.hub_id, 'name', r.name, 'address', r.address, 'regionCode', r.region_code, 'public', r.public) ORDER BY r.created_at, r.id)
      FROM trustwork.company_branch r WHERE r.company_id = p_company AND r.retired_at IS NULL AND (r.public OR NOT p_public)), '[]'::jsonb),
    'profile', (SELECT CASE WHEN p_public THEN
        jsonb_strip_nulls(jsonb_build_object(
          'legalForm', CASE WHEN 'legal_form' = ANY (f.public_fields) THEN f.legal_form END, 'websiteUrl', CASE WHEN 'website_url' = ANY (f.public_fields) THEN f.website_url END,
          'regionCode', CASE WHEN 'region_code' = ANY (f.public_fields) THEN f.region_code END, 'categories', CASE WHEN 'categories' = ANY (f.public_fields) THEN to_jsonb(f.categories) END))
      ELSE jsonb_build_object('legalForm', f.legal_form, 'websiteUrl', f.website_url, 'regionCode', f.region_code, 'categories', to_jsonb(f.categories), 'publicFields', to_jsonb(f.public_fields), 'revision', f.revision) END
      FROM trustwork.company_profile f WHERE f.company_id = p_company))
$$;

CREATE FUNCTION trustwork.claims_public_records(p_company uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$ SELECT trustwork.claims_records_json(p_company, true) $$;

-- The company's own people; only administrators see tax registrations.
CREATE FUNCTION trustwork.claims_company_records(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_out jsonb;
BEGIN
  IF v_person IS NULL OR NOT (EXISTS (SELECT 1 FROM trustwork.membership WHERE company_id = p_company AND person_id = v_person AND status = 'active')
       OR EXISTS (SELECT 1 FROM trustwork.company_handover WHERE company_id = p_company AND person_id = v_person AND revoked_at IS NULL)) THEN
    RAISE EXCEPTION 'no such page' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  v_out := trustwork.claims_records_json(p_company, false);
  IF trustwork.claims_is_administrator(p_company, v_person) THEN
    v_out := v_out || jsonb_build_object('taxRegistrations', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'jurisdiction', r.jurisdiction, 'kind', r.kind, 'number', r.number, 'status', r.status, 'validUntil', r.valid_until) ORDER BY r.created_at, r.id)
      FROM trustwork.tax_registration r WHERE r.company_id = p_company AND r.retired_at IS NULL), '[]'::jsonb));
  END IF;
  RETURN v_out;
END $$;

-- Staff of the hub; tax registrations are not theirs to read without a case grant.
CREATE FUNCTION trustwork.claims_staff_records(p_hub uuid, p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.claims_staff_reader(p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN trustwork.claims_records_json(p_company, false);
END $$;

ALTER TABLE trustwork.company_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_identifier ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_identifier FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_registration FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.tax_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.tax_registration FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_branch ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_branch FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.company_profile AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.company_identifier AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.company_registration AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.tax_registration AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.company_branch AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trustwork.claims_record_add(uuid, text, jsonb), trustwork.claims_record_retire(uuid, text, uuid), trustwork.claims_set_profile(uuid, jsonb),
  trustwork.claims_staff_record_add(jsonb, uuid, uuid, text, jsonb, text), trustwork.claims_verify_identifier(jsonb, uuid, uuid, integer, uuid),
  trustwork.claims_public_records(uuid), trustwork.claims_company_records(uuid), trustwork.claims_staff_records(uuid, uuid)
TO trustwork_app;
