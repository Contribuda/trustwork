-- PRV-001. No country law or deadline is invented here. Runtime writes use the narrow commands below.
CREATE TABLE trustwork.privacy_country_policy (
  country text PRIMARY KEY CHECK (country ~ '^[A-Z]{2}$'),
  version text NOT NULL,
  review text NOT NULL CHECK (review IN ('UNKNOWN', 'verified')),
  sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array'),
  deadline_days integer CHECK (deadline_days > 0),
  retention_days integer CHECK (retention_days >= 0),
  registry_poll_hours integer CHECK (registry_poll_hours > 0),
  registry_deadline_days integer CHECK (registry_deadline_days > 0),
  CHECK (review <> 'verified' OR (jsonb_array_length(sources) > 0 AND deadline_days IS NOT NULL AND retention_days IS NOT NULL))
);
CREATE TABLE trustwork.privacy_request (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  requested_by uuid NOT NULL REFERENCES trustwork.person(id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('person', 'company')),
  subject_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('access', 'erasure', 'correction', 'objection')),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  policy_version text,
  policy_status text NOT NULL CHECK (policy_status IN ('UNKNOWN', 'verified')),
  deadline_at timestamptz,
  retention_days integer,
  correction jsonb,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'erasure_blocked', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'correction') = (correction IS NOT NULL)),
  CHECK (policy_status <> 'verified' OR (deadline_at IS NOT NULL AND retention_days IS NOT NULL))
);
CREATE TABLE trustwork.privacy_preference (
  person_id uuid PRIMARY KEY REFERENCES trustwork.person(id),
  opt_out_sale boolean NOT NULL DEFAULT false,
  opt_out_sharing boolean NOT NULL DEFAULT false,
  limit_sensitive boolean NOT NULL DEFAULT false,
  direct_marketing_objection boolean NOT NULL DEFAULT false,
  gpc boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Minimal one-way contact keys only. This is a collection/send barrier, not a contact directory.
CREATE TABLE trustwork.privacy_suppression (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  person_id uuid,
  marketing boolean NOT NULL DEFAULT true,
  do_not_collect boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trustwork.privacy_export (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  requested_by uuid NOT NULL REFERENCES trustwork.person(id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('person', 'company')),
  subject_id uuid NOT NULL,
  coverage jsonb NOT NULL CHECK (jsonb_typeof(coverage) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trustwork.legal_hold (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  request_id uuid NOT NULL REFERENCES trustwork.privacy_request(id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('person', 'company')),
  subject_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('litigation', 'statutory_retention', 'dispute_evidence')),
  evidence_ref uuid NOT NULL,
  placed_by uuid NOT NULL REFERENCES trustwork.person(id),
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES trustwork.person(id),
  released_at timestamptz,
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX legal_hold_subject ON trustwork.legal_hold(subject_kind, subject_id) WHERE released_at IS NULL;
-- The restorable receipt is NOT the erasure ledger. The authoritative ledger is a separate blob store.
CREATE TABLE trustwork.privacy_replay_receipt (
  request_id uuid PRIMARY KEY,
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  ledger_digest text NOT NULL CHECK (ledger_digest ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trustwork.data_broker_registration (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  country text NOT NULL REFERENCES trustwork.privacy_country_policy(country),
  registry text NOT NULL CHECK (registry IN ('fake_drop')),
  registration_ref text NOT NULL,
  last_polled_at timestamptz,
  next_poll_at timestamptz
);

CREATE FUNCTION trustwork.privacy_subject_authorized(p_kind text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT CASE WHEN p_kind = 'person' THEN p_id = trustwork.current_person_id()
    WHEN p_kind = 'company' THEN EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.person_id = trustwork.current_person_id()
      AND m.company_id = p_id AND m.role = 'administrator' AND m.status = 'active' AND m.valid_from <= now() AND m.ended_at IS NULL)
    ELSE false END
$$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['privacy_country_policy', 'privacy_request', 'privacy_preference', 'privacy_suppression', 'privacy_export', 'legal_hold', 'privacy_replay_receipt', 'data_broker_registration'] LOOP
    EXECUTE format('ALTER TABLE trustwork.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE trustwork.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY maintenance ON trustwork.%I TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on())', t);
  END LOOP;
END $$;
CREATE POLICY own_request ON trustwork.privacy_request FOR SELECT TO trustwork_app
  USING (requested_by = trustwork.current_person_id() AND trustwork.privacy_subject_authorized(subject_kind, subject_id));
CREATE POLICY own_preference ON trustwork.privacy_preference FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());
CREATE POLICY own_export ON trustwork.privacy_export FOR SELECT TO trustwork_app
  USING (requested_by = trustwork.current_person_id() AND trustwork.privacy_subject_authorized(subject_kind, subject_id));
CREATE POLICY staff_hold ON trustwork.legal_hold FOR SELECT TO trustwork_app USING (trustwork.admin_has_permission('admin.privacy.hold', NULL, NULL));
CREATE POLICY readable_policy ON trustwork.privacy_country_policy FOR SELECT TO trustwork_app USING (trustwork.current_person_id() IS NOT NULL);
CREATE FUNCTION trustwork.privacy_subject_erased(p_kind text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS(SELECT 1 FROM trustwork.privacy_replay_receipt WHERE subject_kind = p_kind AND subject_id = p_id)
$$;
CREATE POLICY erased_request ON trustwork.privacy_request AS RESTRICTIVE FOR SELECT TO trustwork_app USING (NOT trustwork.privacy_subject_erased(subject_kind, subject_id));
CREATE POLICY erased_export ON trustwork.privacy_export AS RESTRICTIVE FOR SELECT TO trustwork_app USING (NOT trustwork.privacy_subject_erased(subject_kind, subject_id));
CREATE POLICY erased_preference ON trustwork.privacy_preference AS RESTRICTIVE FOR SELECT TO trustwork_app USING (NOT trustwork.privacy_subject_erased('person', person_id));
GRANT SELECT ON trustwork.privacy_request, trustwork.privacy_preference, trustwork.privacy_export, trustwork.legal_hold, trustwork.privacy_country_policy TO trustwork_app;

CREATE FUNCTION trustwork.privacy_lock_subject(p_kind text, p_id uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('privacy:' || p_kind || ':' || p_id::text, 0))
$$;
CREATE FUNCTION trustwork.privacy_objection(p_person uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$ BEGIN
  INSERT INTO trustwork.privacy_preference(person_id, direct_marketing_objection) VALUES (p_person, true)
    ON CONFLICT(person_id) DO UPDATE SET direct_marketing_objection = true, revision = privacy_preference.revision + 1, updated_at = now();
  INSERT INTO trustwork.privacy_suppression(digest, person_id)
    SELECT encode(sha256(convert_to(email_normalized, 'UTF8')), 'hex'), p_person FROM trustwork.email_binding WHERE person_id = p_person AND verified_at IS NOT NULL
    ON CONFLICT(digest) DO UPDATE SET marketing = true;
END $$;

CREATE FUNCTION trustwork.privacy_request_create(p_input jsonb) RETURNS trustwork.privacy_request
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid := trustwork.admin_require_caller(); v_kind text := p_input->'subject'->>'kind'; v_id uuid := (p_input->'subject'->>'id')::uuid;
  v_policy trustwork.privacy_country_policy%ROWTYPE; v_row trustwork.privacy_request%ROWTYPE;
BEGIN
  IF NOT coalesce(trustwork.privacy_subject_authorized(v_kind, v_id), false) OR trustwork.privacy_subject_erased(v_kind, v_id) THEN
    RAISE EXCEPTION 'subject unavailable' USING ERRCODE = '42501', HINT = 'privacy.forbidden';
  END IF;
  PERFORM trustwork.privacy_lock_subject(v_kind, v_id);
  SELECT * INTO v_policy FROM trustwork.privacy_country_policy WHERE country = p_input->>'country';
  INSERT INTO trustwork.privacy_request(requested_by, subject_kind, subject_id, kind, country, policy_version, policy_status, deadline_at, retention_days, correction)
    VALUES(v_person, v_kind, v_id, p_input->>'kind', p_input->>'country', v_policy.version, coalesce(v_policy.review, 'UNKNOWN'),
      CASE WHEN v_policy.review = 'verified' THEN now() + make_interval(days => v_policy.deadline_days) END,
      CASE WHEN v_policy.review = 'verified' THEN v_policy.retention_days END, nullif(p_input->'correction', 'null'::jsonb)) RETURNING * INTO v_row;
  IF v_row.kind = 'objection' AND v_kind = 'person' THEN PERFORM trustwork.privacy_objection(v_id); END IF;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.privacy_preference_set(p_input jsonb) RETURNS trustwork.privacy_preference
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid := trustwork.admin_require_caller(); v_row trustwork.privacy_preference%ROWTYPE;
BEGIN
  PERFORM trustwork.privacy_lock_subject('person', v_person);
  IF trustwork.privacy_subject_erased('person', v_person) THEN RAISE EXCEPTION 'subject unavailable' USING ERRCODE = '42501', HINT = 'privacy.forbidden'; END IF;
  INSERT INTO trustwork.privacy_preference(person_id, opt_out_sale, opt_out_sharing, limit_sensitive, direct_marketing_objection, gpc)
    VALUES(v_person, (p_input->>'optOutSale')::boolean OR (p_input->>'gpc')::boolean, (p_input->>'optOutSharing')::boolean OR (p_input->>'gpc')::boolean,
      (p_input->>'limitSensitive')::boolean, (p_input->>'directMarketingObjection')::boolean, (p_input->>'gpc')::boolean)
    ON CONFLICT(person_id) DO UPDATE SET opt_out_sale = excluded.opt_out_sale OR privacy_preference.gpc,
      opt_out_sharing = excluded.opt_out_sharing OR privacy_preference.gpc, limit_sensitive = excluded.limit_sensitive,
      direct_marketing_objection = excluded.direct_marketing_objection OR privacy_preference.direct_marketing_objection,
      gpc = excluded.gpc OR privacy_preference.gpc, revision = privacy_preference.revision + 1, updated_at = now();
  SELECT * INTO v_row FROM trustwork.privacy_preference WHERE person_id = v_person;
  IF v_row.direct_marketing_objection THEN PERFORM trustwork.privacy_objection(v_person); END IF;
  SELECT * INTO v_row FROM trustwork.privacy_preference WHERE person_id = v_person;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.privacy_hold_place(p_ctx jsonb, p_request uuid, p_reason text, p_evidence uuid) RETURNS trustwork.legal_hold
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.privacy.hold'], NULL, NULL);
  v_request trustwork.privacy_request%ROWTYPE; v_row trustwork.legal_hold%ROWTYPE;
BEGIN
  SELECT * INTO v_request FROM trustwork.privacy_request WHERE id = p_request;
  IF v_request.id IS NULL THEN RAISE EXCEPTION 'request unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found'; END IF;
  IF (v_request.subject_kind = 'person' AND v_request.subject_id = v_actor.person_id)
    OR (v_request.subject_kind = 'company' AND EXISTS(SELECT 1 FROM trustwork.membership WHERE person_id = v_actor.person_id AND company_id = v_request.subject_id AND status = 'active')) THEN
    RAISE EXCEPTION 'subject conflict' USING ERRCODE = '42501', HINT = 'admin.conflict_of_interest';
  END IF;
  PERFORM trustwork.privacy_lock_subject(v_request.subject_kind, v_request.subject_id);
  IF EXISTS(SELECT 1 FROM trustwork.privacy_replay_receipt WHERE subject_kind = v_request.subject_kind AND subject_id = v_request.subject_id) THEN
    RAISE EXCEPTION 'erasure already decided' USING ERRCODE = '55000', HINT = 'privacy.erasure_decided';
  END IF;
  INSERT INTO trustwork.legal_hold(request_id, subject_kind, subject_id, reason_code, evidence_ref, placed_by)
    VALUES(p_request, v_request.subject_kind, v_request.subject_id, p_reason, p_evidence, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, NULL, 'privacy.hold_placed', 'legal_hold', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;
CREATE FUNCTION trustwork.privacy_hold_release(p_ctx jsonb, p_id uuid) RETURNS trustwork.legal_hold
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.privacy.hold'], NULL, NULL); v_row trustwork.legal_hold%ROWTYPE; v_before jsonb;
BEGIN
  SELECT * INTO v_row FROM trustwork.legal_hold WHERE id = p_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'hold unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found'; END IF;
  IF (v_row.subject_kind = 'person' AND v_row.subject_id = v_actor.person_id)
    OR (v_row.subject_kind = 'company' AND EXISTS(SELECT 1 FROM trustwork.membership WHERE person_id = v_actor.person_id AND company_id = v_row.subject_id AND status = 'active')) THEN
    RAISE EXCEPTION 'subject conflict' USING ERRCODE = '42501', HINT = 'admin.conflict_of_interest';
  END IF;
  PERFORM trustwork.privacy_lock_subject(v_row.subject_kind, v_row.subject_id);
  SELECT * INTO v_row FROM trustwork.legal_hold WHERE id = p_id FOR UPDATE;
  v_before := to_jsonb(v_row);
  IF v_row.released_at IS NOT NULL THEN RETURN v_row; END IF;
  UPDATE trustwork.legal_hold SET released_at = now(), released_by = v_actor.person_id WHERE id = p_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, NULL, 'privacy.hold_released', 'legal_hold', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.privacy_export_create(p_kind text, p_id uuid, p_coverage jsonb) RETURNS trustwork.privacy_export
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_row trustwork.privacy_export%ROWTYPE; v_person uuid := trustwork.admin_require_caller(); BEGIN
  IF NOT coalesce(trustwork.privacy_subject_authorized(p_kind, p_id), false) OR trustwork.privacy_subject_erased(p_kind, p_id) THEN
    RAISE EXCEPTION 'subject unavailable' USING ERRCODE = '42501', HINT = 'privacy.forbidden';
  END IF;
  INSERT INTO trustwork.privacy_export(requested_by, subject_kind, subject_id, coverage) VALUES(v_person, p_kind, p_id, p_coverage) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Readiness is deliberately fail-closed until every required owning module has a real erasure command.
CREATE FUNCTION trustwork.privacy_erasure_check(p_ctx jsonb, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.privacy.erasure.execute'], NULL, NULL); v_row trustwork.privacy_request%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.privacy_request WHERE id = p_id;
  IF v_row.id IS NULL OR v_row.kind <> 'erasure' THEN RAISE EXCEPTION 'request unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found'; END IF;
  PERFORM trustwork.privacy_lock_subject(v_row.subject_kind, v_row.subject_id);
  IF EXISTS(SELECT 1 FROM trustwork.legal_hold WHERE subject_kind = v_row.subject_kind AND subject_id = v_row.subject_id AND released_at IS NULL) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'legal_hold');
  END IF;
  IF v_row.policy_status <> 'verified' THEN RETURN jsonb_build_object('ready', false, 'reason', 'country_policy_UNKNOWN'); END IF;
  RETURN jsonb_build_object('ready', false, 'reason', 'module_erasure_adapters_unavailable');
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.privacy_subject_authorized(text, uuid), trustwork.privacy_request_create(jsonb), trustwork.privacy_preference_set(jsonb),
  trustwork.privacy_hold_place(jsonb, uuid, text, uuid), trustwork.privacy_hold_release(jsonb, uuid), trustwork.privacy_export_create(text, uuid, jsonb),
  trustwork.privacy_erasure_check(jsonb, uuid) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.privacy_subject_erased(text, uuid) TO trustwork_app;
