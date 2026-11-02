-- HUB-003 counterparty verification, first slice (docs/engine/hub-administration.md "Verification": providers and
-- modes, recipes, reference recipes; ADR 014 for sanctions; ADR 026 decision 6 for people). Contracts:
-- packages/contracts/src/verification.ts.
--
-- Providers run a check type in one of three modes: fake (deterministic, tests and demos), manual (a reviewer looks the
-- record up and records the result with an evidence reference) and live (an adapter with a KEYS-001 credential
-- reference). Live mode consumes a second person's approval (`providers.enable_non_fake`) of exactly that provider
-- version. A recipe combines checks for a subject and a moment; every recipe carries `sanctions_screening` as a
-- required step and no version can drop it. Check results are append-only evidence records with an expiry from the
-- recipe's re-check period; documents are never stored, only references. The sanctions check never keeps lists or
-- decides matches: it records a reference to the SANC-003 subject state and passes only when screening is available
-- and the subject is neither held nor suspended. A possible match or an unavailable screening store blocks every
-- hand-over (verification_evaluate.handoverBlocked), whatever the other checks say.
--
-- Authority model (DATA-002): every mutation is a SECURITY DEFINER command that resolves the caller's permission at the
-- hub, requires a live elevation and writes an admin_audit_event in the same transaction; the runtime role reads under
-- row-level security (staff of the hub with a claims permission) and writes nothing directly.

-- 0. Vocabularies (tested against packages/contracts/src/verification.ts) --------------------------------------------
CREATE FUNCTION trustwork.verification_check_types() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['register_match', 'officer_match', 'tax_status', 'licence', 'qualification', 'ownership', 'sanctions_screening', 'domain_confirmed', 'signed_authority',
    'callback_confirmed']::text[]
$$;
CREATE FUNCTION trustwork.verification_triggers() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['claim_claimed', 'claim_verified', 'seller_onboarding', 'regulated_category', 'professional_qualification']::text[]
$$;
CREATE FUNCTION trustwork.verification_reader_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.claims.read', 'admin.claims.decide', 'admin.claims.policy.edit', 'admin.claims.revoke']::text[]
$$;

-- Steps: a non-empty array of {"check": <type>, "required": <boolean>} or {"anyOf": [<type>, ...]} (two to four types);
-- no check type appears twice; `sanctions_screening` is present as a required single step.
CREATE FUNCTION trustwork.verification_steps_ok(p_steps jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  WITH s AS (SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_steps) = 'array' THEN p_steps ELSE '[]'::jsonb END) e),
  types AS (
    SELECT e ->> 'check' AS t FROM s WHERE e ? 'check'
    UNION ALL SELECT a FROM s, jsonb_array_elements_text(CASE WHEN jsonb_typeof(e -> 'anyOf') = 'array' THEN e -> 'anyOf' ELSE '[]'::jsonb END) a WHERE e ? 'anyOf'
  )
  SELECT jsonb_typeof(p_steps) = 'array' AND jsonb_array_length(p_steps) BETWEEN 1 AND 12
    AND NOT EXISTS (
      SELECT 1 FROM s WHERE NOT (
        (e ? 'check' AND NOT e ? 'anyOf' AND jsonb_typeof(e -> 'required') = 'boolean' AND (e ->> 'check') = ANY (trustwork.verification_check_types())
          AND (SELECT count(*) FROM jsonb_object_keys(e)) = 2)
        OR (e ? 'anyOf' AND NOT e ? 'check' AND jsonb_typeof(e -> 'anyOf') = 'array' AND jsonb_array_length(e -> 'anyOf') BETWEEN 2 AND 4
          AND (SELECT count(*) FROM jsonb_object_keys(e)) = 1
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(e -> 'anyOf') a WHERE a NOT IN (SELECT unnest(trustwork.verification_check_types())) OR a = 'sanctions_screening'))))
    AND (SELECT count(*) FROM types) = (SELECT count(DISTINCT t) FROM types)
    AND EXISTS (SELECT 1 FROM s WHERE e ->> 'check' = 'sanctions_screening' AND (e ->> 'required')::boolean)
$$;

-- 1. Providers ---------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.verification_provider (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  check_type text NOT NULL CHECK (check_type = ANY (trustwork.verification_check_types()) AND check_type <> 'sanctions_screening'),
  adapter text NOT NULL CHECK (adapter ~ '^[a-z][a-z0-9_]{1,40}$'),
  mode text NOT NULL CHECK (mode IN ('fake', 'manual', 'live')),
  credential_ref_id uuid NULL REFERENCES trustwork.provider_credential_ref (id),
  approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  legal_basis text NOT NULL CHECK (legal_basis IN ('statutory_public_register', 'contract', 'consent', 'legitimate_interest_assessed', 'legal_obligation')),
  cost_minor bigint NULL CHECK (cost_minor IS NULL OR cost_minor >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Live mode exists only with a credential reference and a consumed second-person approval.
  CONSTRAINT verification_provider_live CHECK (mode <> 'live' OR (credential_ref_id IS NOT NULL AND approval_id IS NOT NULL))
);
CREATE UNIQUE INDEX verification_provider_active_uq ON trustwork.verification_provider (hub_id, check_type, adapter) WHERE status = 'active';

-- The digest a second person approves before a provider goes live (the console shows it).
CREATE FUNCTION trustwork.verification_provider_digest(p_provider uuid, p_revision integer, p_credential uuid) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT encode(sha256(convert_to('verification.provider.live:' || p_provider::text || ':' || p_revision::text || ':' || p_credential::text, 'UTF8')), 'hex')
$$;

-- 2. Recipes -----------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.verification_recipe (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_-]{2,60}$'),
  version integer NOT NULL CHECK (version >= 1),
  subject_kind text NOT NULL CHECK (subject_kind IN ('company', 'person')),
  trigger text NOT NULL CHECK (trigger = ANY (trustwork.verification_triggers())),
  steps jsonb NOT NULL CHECK (trustwork.verification_steps_ok(steps)),
  badge_categories text[] NOT NULL CHECK (cardinality(badge_categories) BETWEEN 1 AND 10),
  recheck_months integer NOT NULL CHECK (recheck_months BETWEEN 1 AND 24),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded')),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hub_id, key, version),
  CONSTRAINT verification_recipe_activation CHECK ((status = 'draft') = (activated_by IS NULL))
);
CREATE UNIQUE INDEX verification_recipe_active_uq ON trustwork.verification_recipe (hub_id, key) WHERE status = 'active';

-- Versions are immutable once drafted: only status, activation and revision move, and only forward.
CREATE FUNCTION trustwork.verification_recipe_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recipe versions are kept' USING ERRCODE = 'insufficient_privilege', HINT = 'verification.immutable';
  END IF;
  IF (NEW.hub_id, NEW.key, NEW.version, NEW.subject_kind, NEW.trigger, NEW.steps, NEW.badge_categories, NEW.recheck_months, NEW.drafted_by)
     IS DISTINCT FROM (OLD.hub_id, OLD.key, OLD.version, OLD.subject_kind, OLD.trigger, OLD.steps, OLD.badge_categories, OLD.recheck_months, OLD.drafted_by)
     OR NOT ((OLD.status = 'draft' AND NEW.status IN ('draft', 'active')) OR (OLD.status = 'active' AND NEW.status IN ('active', 'superseded')) OR (OLD.status = NEW.status)) THEN
    RAISE EXCEPTION 'a recipe version is immutable' USING ERRCODE = 'insufficient_privilege', HINT = 'verification.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_recipe_guard BEFORE UPDATE OR DELETE ON trustwork.verification_recipe FOR EACH ROW EXECUTE FUNCTION trustwork.verification_recipe_guard();

-- 3. Check results (append-only evidence records) -----------------------------------------------------------------------
CREATE TABLE trustwork.verification_check (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  recipe_id uuid NOT NULL REFERENCES trustwork.verification_recipe (id),
  check_type text NOT NULL CHECK (check_type = ANY (trustwork.verification_check_types())),
  provider_id uuid NULL REFERENCES trustwork.verification_provider (id),
  mode text NOT NULL CHECK (mode IN ('fake', 'manual', 'live', 'screening')),
  result text NOT NULL CHECK (result IN ('pass', 'fail', 'inconclusive', 'unavailable')),
  -- A reference to where the evidence lives (a register record number, a document store key); never the document.
  evidence_ref text NULL CHECK (evidence_ref IS NULL OR evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$'),
  -- The sanctions check only: the SANC-003 subject state and the revision it read.
  screening_state_id uuid NULL REFERENCES trustwork.screening_subject_state (id),
  screening_state_revision integer NULL,
  recorded_by uuid NOT NULL REFERENCES trustwork.person (id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT verification_check_subject CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  -- The sanctions check comes from screening (no provider, never "fail" on its own); every other check names its provider.
  CONSTRAINT verification_check_sanctions CHECK (
    (check_type = 'sanctions_screening') = (mode = 'screening')
    AND (check_type <> 'sanctions_screening' OR (provider_id IS NULL AND result <> 'fail'))
    AND (check_type = 'sanctions_screening' OR (provider_id IS NOT NULL AND screening_state_id IS NULL))),
  CONSTRAINT verification_check_expiry CHECK (expires_at > recorded_at)
);
CREATE INDEX verification_check_subject_idx ON trustwork.verification_check (hub_id, subject_company_id, subject_person_id, check_type, recorded_at DESC);
CREATE INDEX verification_check_expiry_idx ON trustwork.verification_check (hub_id, expires_at);
CREATE TRIGGER verification_check_append_only BEFORE UPDATE OR DELETE ON trustwork.verification_check FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Helpers ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.verification_require_hub(p_hub uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_hub IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.hub WHERE id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
END $$;
CREATE FUNCTION trustwork.verification_staff(p_ctx jsonb, p_permissions text[], p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM trustwork.verification_require_hub(p_hub);
  RETURN trustwork.admin_authorize(p_ctx, p_permissions, NULL, p_hub);
END $$;
CREATE FUNCTION trustwork.verification_check_revision(p_actual integer, p_expected integer) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_expected IS NULL OR p_actual <> p_expected THEN
    RAISE EXCEPTION 'the record changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'verification.revision_conflict';
  END IF;
END $$;
CREATE FUNCTION trustwork.verification_require_subject(p_kind text, p_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_kind = 'company' AND EXISTS (SELECT 1 FROM trustwork.company WHERE id = p_id) THEN RETURN; END IF;
  IF p_kind = 'person' AND EXISTS (SELECT 1 FROM trustwork.person WHERE id = p_id) THEN RETURN; END IF;
  RAISE EXCEPTION 'no such subject' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
END $$;
CREATE FUNCTION trustwork.verification_recipe_for(p_hub uuid, p_recipe uuid, p_kind text) RETURNS trustwork.verification_recipe
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_recipe trustwork.verification_recipe%ROWTYPE;
BEGIN
  SELECT * INTO v_recipe FROM trustwork.verification_recipe WHERE id = p_recipe AND hub_id = p_hub;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such recipe' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_recipe.status <> 'active' THEN
    RAISE EXCEPTION 'checks run under an active recipe' USING ERRCODE = 'check_violation', HINT = 'verification.recipe_not_active';
  END IF;
  IF v_recipe.subject_kind <> p_kind THEN
    RAISE EXCEPTION 'the recipe is for a % subject', v_recipe.subject_kind USING ERRCODE = 'check_violation', HINT = 'verification.subject_mismatch';
  END IF;
  RETURN v_recipe;
END $$;
-- The check types a recipe names.
CREATE FUNCTION trustwork.verification_recipe_types(p_steps jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(t), ARRAY[]::text[]) FROM (
    SELECT e ->> 'check' AS t FROM jsonb_array_elements(p_steps) e WHERE e ? 'check'
    UNION ALL SELECT a FROM jsonb_array_elements(p_steps) e, jsonb_array_elements_text(e -> 'anyOf') a WHERE e ? 'anyOf'
  ) x
$$;

-- 5. Commands ---------------------------------------------------------------------------------------------------------
-- Every command takes DATA-002's command context p_ctx ({elevationId, requestId, reasonCode, reasonText}).

-- A provider in fake or manual mode. Live mode is reached only through verification_go_live.
CREATE FUNCTION trustwork.verification_register_provider(p_ctx jsonb, p_hub uuid, p_input jsonb) RETURNS trustwork.verification_provider
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.verification_staff(p_ctx, ARRAY['admin.claims.policy.edit'], p_hub);
  v_row trustwork.verification_provider%ROWTYPE;
BEGIN
  IF p_input ->> 'mode' NOT IN ('fake', 'manual') THEN
    RAISE EXCEPTION 'a provider starts in fake or manual mode' USING ERRCODE = 'check_violation', HINT = 'verification.live_needs_second_person';
  END IF;
  IF p_input ->> 'checkType' = 'sanctions_screening' THEN
    RAISE EXCEPTION 'sanctions screening runs through the screening engine' USING ERRCODE = 'check_violation', HINT = 'verification.sanctions_through_screening';
  END IF;
  INSERT INTO trustwork.verification_provider (hub_id, check_type, adapter, mode, retention_days, legal_basis, cost_minor, created_by)
  VALUES (p_hub, p_input ->> 'checkType', p_input ->> 'adapter', p_input ->> 'mode', (p_input ->> 'retentionDays')::integer, p_input ->> 'legalBasis',
    NULLIF(p_input ->> 'costMinor', '')::bigint, v_actor.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'verification.provider_registered', 'verification_provider', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Live mode: a credential reference of the hub and a consumed second-person approval of exactly this provider version.
CREATE FUNCTION trustwork.verification_go_live(p_ctx jsonb, p_provider uuid, p_expected_revision integer, p_credential uuid, p_approval uuid) RETURNS trustwork.verification_provider
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.verification_provider%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.verification_provider%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.verification_provider WHERE id = p_provider FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such provider' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.verification_staff(p_ctx, ARRAY['admin.claims.policy.edit'], v_before.hub_id);
  PERFORM trustwork.verification_check_revision(v_before.revision, p_expected_revision);
  IF v_before.status <> 'active' OR v_before.mode = 'live' THEN
    RAISE EXCEPTION 'the provider is % in % mode', v_before.status, v_before.mode USING ERRCODE = 'check_violation', HINT = 'verification.invalid_transition';
  END IF;
  IF p_credential IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.provider_credential_ref c WHERE c.id = p_credential AND c.hub_id = v_before.hub_id) THEN
    RAISE EXCEPTION 'live mode needs a credential reference of this hub' USING ERRCODE = 'check_violation', HINT = 'verification.credential_required';
  END IF;
  IF p_approval IS NULL THEN
    RAISE EXCEPTION 'live mode needs a second person' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
  END IF;
  PERFORM trustwork.admin_consume_approval(p_approval, 'providers.enable_non_fake', 'hub', NULL, v_before.hub_id,
    trustwork.verification_provider_digest(v_before.id, v_before.revision, p_credential), v_before.id);
  UPDATE trustwork.verification_provider SET mode = 'live', credential_ref_id = p_credential, approval_id = p_approval, revision = revision + 1, updated_at = now()
   WHERE id = p_provider RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'verification.provider_live', 'verification_provider', v_row.id, to_jsonb(v_before), to_jsonb(v_row), NULL, p_approval);
  RETURN v_row;
END $$;

-- A new draft version of a recipe (the next version of its key).
CREATE FUNCTION trustwork.verification_draft_recipe(p_ctx jsonb, p_hub uuid, p_input jsonb) RETURNS trustwork.verification_recipe
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.verification_staff(p_ctx, ARRAY['admin.claims.policy.edit'], p_hub);
  v_version integer;
  v_row trustwork.verification_recipe%ROWTYPE;
BEGIN
  IF NOT trustwork.verification_steps_ok(p_input -> 'steps') THEN
    RAISE EXCEPTION 'a recipe needs valid steps, no repeated check and a required sanctions screening step' USING ERRCODE = 'check_violation',
      HINT = CASE WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_input -> 'steps') = 'array' THEN p_input -> 'steps' ELSE '[]'::jsonb END) e
                                   WHERE e ->> 'check' = 'sanctions_screening' AND (e ->> 'required') = 'true')
                  THEN 'verification.sanctions_required' ELSE 'verification.invalid_steps' END;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.verification_recipe:' || p_hub::text || ':' || (p_input ->> 'key'), 0));
  v_version := coalesce((SELECT max(version) FROM trustwork.verification_recipe WHERE hub_id = p_hub AND key = p_input ->> 'key'), 0) + 1;
  INSERT INTO trustwork.verification_recipe (hub_id, key, version, subject_kind, trigger, steps, badge_categories, recheck_months, drafted_by)
  VALUES (p_hub, p_input ->> 'key', v_version, p_input ->> 'subjectKind', p_input ->> 'trigger', p_input -> 'steps',
    ARRAY(SELECT jsonb_array_elements_text(p_input -> 'badgeCategories')), (p_input ->> 'recheckMonths')::integer, v_actor.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'verification.recipe_drafted', 'verification_recipe', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Activation supersedes the active version of the same key.
CREATE FUNCTION trustwork.verification_activate_recipe(p_ctx jsonb, p_recipe uuid, p_expected_revision integer) RETURNS trustwork.verification_recipe
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.verification_recipe%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.verification_recipe%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.verification_recipe WHERE id = p_recipe FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such recipe' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.verification_staff(p_ctx, ARRAY['admin.claims.policy.edit'], v_before.hub_id);
  PERFORM trustwork.verification_check_revision(v_before.revision, p_expected_revision);
  IF v_before.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft is activated' USING ERRCODE = 'check_violation', HINT = 'verification.invalid_transition';
  END IF;
  UPDATE trustwork.verification_recipe SET status = 'superseded', revision = revision + 1 WHERE hub_id = v_before.hub_id AND key = v_before.key AND status = 'active';
  UPDATE trustwork.verification_recipe SET status = 'active', activated_by = v_actor.person_id, activated_at = now(), revision = revision + 1
   WHERE id = p_recipe RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'verification.recipe_activated', 'verification_recipe', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- A check result from a fake or manual provider (a live adapter's results arrive through the worker in a later slice).
-- Manual results name an evidence reference; the sanctions check is refused here (verification_record_screening).
CREATE FUNCTION trustwork.verification_record_check(p_ctx jsonb, p_hub uuid, p_subject_kind text, p_subject uuid, p_recipe uuid, p_provider uuid, p_result text, p_evidence text)
RETURNS trustwork.verification_check
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.verification_staff(p_ctx, ARRAY['admin.claims.decide'], p_hub);
  v_recipe trustwork.verification_recipe%ROWTYPE;
  v_provider trustwork.verification_provider%ROWTYPE;
  v_row trustwork.verification_check%ROWTYPE;
BEGIN
  PERFORM trustwork.verification_require_subject(p_subject_kind, p_subject);
  v_recipe := trustwork.verification_recipe_for(p_hub, p_recipe, p_subject_kind);
  SELECT * INTO v_provider FROM trustwork.verification_provider WHERE id = p_provider AND hub_id = p_hub AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such provider' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_provider.mode = 'live' THEN
    RAISE EXCEPTION 'live results come from the adapter, not from a person' USING ERRCODE = 'check_violation', HINT = 'verification.live_results_from_adapter';
  END IF;
  IF NOT v_provider.check_type = ANY (trustwork.verification_recipe_types(v_recipe.steps)) THEN
    RAISE EXCEPTION 'the recipe does not use this check' USING ERRCODE = 'check_violation', HINT = 'verification.check_not_in_recipe';
  END IF;
  IF v_provider.mode = 'manual' AND p_evidence IS NULL AND p_result IN ('pass', 'fail') THEN
    RAISE EXCEPTION 'a manual result names its evidence' USING ERRCODE = 'check_violation', HINT = 'verification.evidence_required';
  END IF;
  INSERT INTO trustwork.verification_check (hub_id, subject_person_id, subject_company_id, recipe_id, check_type, provider_id, mode, result, evidence_ref, recorded_by, expires_at)
  VALUES (p_hub, CASE WHEN p_subject_kind = 'person' THEN p_subject END, CASE WHEN p_subject_kind = 'company' THEN p_subject END, p_recipe, v_provider.check_type,
    v_provider.id, v_provider.mode, p_result, p_evidence, v_actor.person_id, now() + make_interval(months => v_recipe.recheck_months))
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'verification.check_recorded', 'verification_check', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- The sanctions check: a reference to the SANC-003 state. It passes only when screening is available and the subject is
-- neither held nor suspended; an unavailable store is "unavailable", anything else "inconclusive" (never "fail": a
-- possible match is decided in SANC-003, never here).
CREATE FUNCTION trustwork.verification_record_screening(p_ctx jsonb, p_hub uuid, p_subject_kind text, p_subject uuid, p_recipe uuid) RETURNS trustwork.verification_check
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.verification_staff(p_ctx, ARRAY['admin.claims.decide'], p_hub);
  v_recipe trustwork.verification_recipe%ROWTYPE;
  v_state trustwork.screening_subject_state%ROWTYPE;
  v_gate record;
  v_result text;
  v_row trustwork.verification_check%ROWTYPE;
BEGIN
  PERFORM trustwork.verification_require_subject(p_subject_kind, p_subject);
  v_recipe := trustwork.verification_recipe_for(p_hub, p_recipe, p_subject_kind);
  v_state := trustwork.screening_state_row(CASE WHEN p_subject_kind = 'person' THEN p_subject END, CASE WHEN p_subject_kind = 'company' THEN p_subject END);
  IF NOT trustwork.screening_available() THEN
    v_result := 'unavailable';
  ELSE
    SELECT * INTO v_gate FROM trustwork.screening_gate_check(ARRAY[p_subject_kind], ARRAY[p_subject]) LIMIT 1;
    v_result := CASE WHEN v_state.id IS NOT NULL AND v_state.last_outcome = 'clear' AND NOT coalesce(v_gate.money_held, true) AND NOT coalesce(v_gate.suspended, true)
      THEN 'pass' ELSE 'inconclusive' END;
  END IF;
  INSERT INTO trustwork.verification_check (hub_id, subject_person_id, subject_company_id, recipe_id, check_type, mode, result, screening_state_id, screening_state_revision,
    recorded_by, expires_at)
  VALUES (p_hub, CASE WHEN p_subject_kind = 'person' THEN p_subject END, CASE WHEN p_subject_kind = 'company' THEN p_subject END, p_recipe, 'sanctions_screening',
    'screening', v_result, v_state.id, v_state.revision, v_actor.person_id, now() + make_interval(months => v_recipe.recheck_months))
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'verification.screening_recorded', 'verification_check', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- 6. Evaluation ------------------------------------------------------------------------------------------------------
-- The subject's standing under a recipe: the latest unexpired result per check type; required steps must pass, an
-- anyOf step needs one pass. handoverBlocked re-reads screening now: a possible match, a hold, a suspension or an
-- unavailable store blocks every hand-over level, whatever the recorded checks say.
CREATE FUNCTION trustwork.verification_evaluate(p_hub uuid, p_subject_kind text, p_subject uuid, p_recipe uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_recipe trustwork.verification_recipe%ROWTYPE;
  v_latest jsonb;
  v_missing text[] := ARRAY[]::text[];
  v_failed text[] := ARRAY[]::text[];
  v_step jsonb;
  v_state trustwork.screening_subject_state%ROWTYPE;
  v_blocked boolean;
  v_expires timestamptz;
BEGIN
  IF NOT trustwork.admin_has_any_permission(trustwork.verification_reader_permissions(), NULL, p_hub) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT * INTO v_recipe FROM trustwork.verification_recipe WHERE id = p_recipe AND hub_id = p_hub AND subject_kind = p_subject_kind;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such recipe' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT coalesce(jsonb_object_agg(check_type, result), '{}'::jsonb), min(expires_at) INTO v_latest, v_expires FROM (
    SELECT DISTINCT ON (check_type) check_type, result, expires_at FROM trustwork.verification_check
     WHERE hub_id = p_hub AND recipe_id = p_recipe AND expires_at > now()
       AND (CASE WHEN p_subject_kind = 'person' THEN subject_person_id ELSE subject_company_id END) = p_subject
     ORDER BY check_type, recorded_at DESC
  ) x;
  FOR v_step IN SELECT e FROM jsonb_array_elements(v_recipe.steps) e LOOP
    IF v_step ? 'check' THEN
      IF (v_step ->> 'required')::boolean AND coalesce(v_latest ->> (v_step ->> 'check'), '') <> 'pass' THEN
        IF v_latest ->> (v_step ->> 'check') = 'fail' THEN v_failed := v_failed || (v_step ->> 'check'); ELSE v_missing := v_missing || (v_step ->> 'check'); END IF;
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_step -> 'anyOf') a WHERE v_latest ->> a = 'pass') THEN
      v_missing := v_missing || ARRAY(SELECT jsonb_array_elements_text(v_step -> 'anyOf'));
    END IF;
  END LOOP;
  v_state := trustwork.screening_state_row(CASE WHEN p_subject_kind = 'person' THEN p_subject END, CASE WHEN p_subject_kind = 'company' THEN p_subject END);
  v_blocked := NOT trustwork.screening_available() OR v_state.id IS NULL OR v_state.last_outcome IS DISTINCT FROM 'clear' OR v_state.money_held OR v_state.suspended
    OR coalesce(v_latest ->> 'sanctions_screening', '') <> 'pass';
  RETURN jsonb_build_object(
    'status', CASE WHEN cardinality(v_failed) > 0 THEN 'failed' WHEN cardinality(v_missing) > 0 THEN 'pending' ELSE 'passed' END,
    'missing', to_jsonb(v_missing), 'failed', to_jsonb(v_failed), 'handoverBlocked', v_blocked,
    'badgeCategories', CASE WHEN cardinality(v_failed) = 0 AND cardinality(v_missing) = 0 AND NOT v_blocked THEN to_jsonb(v_recipe.badge_categories) ELSE '[]'::jsonb END,
    'expiresAt', v_expires);
END $$;

-- Checks whose result expires within p_days (the worker schedules re-checks from this list).
CREATE FUNCTION trustwork.verification_due_rechecks(p_hub uuid, p_days integer) RETURNS TABLE (check_id uuid, subject_kind text, subject_id uuid, recipe_id uuid, check_type text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT DISTINCT ON (c.recipe_id, c.subject_company_id, c.subject_person_id, c.check_type) c.id,
    CASE WHEN c.subject_person_id IS NOT NULL THEN 'person' ELSE 'company' END, coalesce(c.subject_person_id, c.subject_company_id), c.recipe_id, c.check_type, c.expires_at
  FROM trustwork.verification_check c
  WHERE c.hub_id = p_hub AND c.expires_at <= now() + make_interval(days => greatest(p_days, 0))
  ORDER BY c.recipe_id, c.subject_company_id, c.subject_person_id, c.check_type, c.recorded_at DESC
$$;

-- 7. Readers, row-level security and grants --------------------------------------------------------------------------
CREATE FUNCTION trustwork.verification_staff_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND p_hub IS NOT NULL AND trustwork.admin_has_any_permission(trustwork.verification_reader_permissions(), NULL, p_hub)
$$;

ALTER TABLE trustwork.verification_provider ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.verification_provider FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.verification_recipe ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.verification_recipe FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.verification_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.verification_check FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.verification_provider AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.verification_recipe AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.verification_check AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY verification_provider_read ON trustwork.verification_provider FOR SELECT TO trustwork_app USING (trustwork.verification_staff_reader(hub_id));
CREATE POLICY verification_recipe_read ON trustwork.verification_recipe FOR SELECT TO trustwork_app USING (trustwork.verification_staff_reader(hub_id));
CREATE POLICY verification_check_read ON trustwork.verification_check FOR SELECT TO trustwork_app USING (trustwork.verification_staff_reader(hub_id));

GRANT SELECT ON trustwork.verification_provider, trustwork.verification_recipe, trustwork.verification_check TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.verification_register_provider(jsonb, uuid, jsonb), trustwork.verification_go_live(jsonb, uuid, integer, uuid, uuid),
  trustwork.verification_draft_recipe(jsonb, uuid, jsonb), trustwork.verification_activate_recipe(jsonb, uuid, integer),
  trustwork.verification_record_check(jsonb, uuid, text, uuid, uuid, uuid, text, text), trustwork.verification_record_screening(jsonb, uuid, text, uuid, uuid),
  trustwork.verification_evaluate(uuid, text, uuid, uuid), trustwork.verification_staff_reader(uuid),
  trustwork.verification_check_types(), trustwork.verification_triggers(), trustwork.verification_reader_permissions(), trustwork.verification_steps_ok(jsonb),
  trustwork.verification_recipe_types(jsonb), trustwork.verification_provider_digest(uuid, integer, uuid)
TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.verification_due_rechecks(uuid, integer) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
