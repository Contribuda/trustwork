-- HUB-003 part 3: appeals of adverse verification results (docs/engine/hub-administration.md "Results, appeals and
-- retention": every adverse result can be appealed; the decider of the appeal differs from the original reviewer).
--
-- The subject files: a person for a check about themselves, an active administrator of the company for a check about
-- the company. Only a non-sanctions check with an adverse result (fail, inconclusive, unavailable) is appealable here;
-- sanctions matches are decided and appealed in SANC-003. One open appeal per check. A trust reviewer decides: never
-- the person who recorded the result and never the person who filed. Upholding keeps the result; overturning records
-- a new passing result with an evidence reference (the original stays: results are append-only). Staff decisions are
-- audited in the same transaction; the filer reads their own appeals, staff of the hub read the hub's.

CREATE TABLE trustwork.verification_appeal (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  check_id uuid NOT NULL REFERENCES trustwork.verification_check (id),
  filed_by uuid NOT NULL REFERENCES trustwork.person (id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'overturned')),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  decision_note text NULL CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 1 AND 2000),
  new_check_id uuid NULL REFERENCES trustwork.verification_check (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_appeal_decision CHECK ((status = 'open') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL) AND (decided_by IS NULL) = (decision_note IS NULL)
    AND (status = 'overturned') = (new_check_id IS NOT NULL)),
  CONSTRAINT verification_appeal_not_filer CHECK (decided_by IS NULL OR decided_by <> filed_by)
);
CREATE UNIQUE INDEX verification_appeal_open_uq ON trustwork.verification_appeal (check_id) WHERE status = 'open';
CREATE INDEX verification_appeal_hub_idx ON trustwork.verification_appeal (hub_id, status, created_at);

-- An appeal is decided once: only the decision fields move, from open to decided.
CREATE FUNCTION trustwork.verification_appeal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'open'
     OR (NEW.hub_id, NEW.check_id, NEW.filed_by, NEW.reason, NEW.created_at) IS DISTINCT FROM (OLD.hub_id, OLD.check_id, OLD.filed_by, OLD.reason, OLD.created_at) THEN
    RAISE EXCEPTION 'an appeal is decided once and kept' USING ERRCODE = 'insufficient_privilege', HINT = 'verification.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_appeal_guard BEFORE UPDATE OR DELETE ON trustwork.verification_appeal FOR EACH ROW EXECUTE FUNCTION trustwork.verification_appeal_guard();

-- The subject files an appeal (no staff elevation: this is the participant's own path).
CREATE FUNCTION trustwork.verification_file_appeal(p_check uuid, p_reason text) RETURNS trustwork.verification_appeal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_check trustwork.verification_check%ROWTYPE;
  v_row trustwork.verification_appeal%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'a signed-in person files an appeal' USING ERRCODE = 'insufficient_privilege', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_check FROM trustwork.verification_check WHERE id = p_check FOR SHARE;
  -- The subject only: anyone else finds nothing.
  IF NOT FOUND OR NOT (
       (v_check.subject_person_id IS NOT NULL AND v_check.subject_person_id = v_person)
       OR (v_check.subject_company_id IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.company_id = v_check.subject_company_id AND m.person_id = v_person
             AND m.role = 'administrator' AND m.status = 'active'))) THEN
    RAISE EXCEPTION 'no such result' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_check.check_type = 'sanctions_screening' THEN
    RAISE EXCEPTION 'sanctions screening is appealed in the screening engine' USING ERRCODE = 'check_violation', HINT = 'verification.sanctions_appeal_in_screening';
  END IF;
  IF v_check.result = 'pass' THEN
    RAISE EXCEPTION 'only an adverse result is appealed' USING ERRCODE = 'check_violation', HINT = 'verification.not_adverse';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.verification_appeal WHERE check_id = p_check AND status = 'open') THEN
    RAISE EXCEPTION 'an appeal of this result is open' USING ERRCODE = 'unique_violation', HINT = 'verification.appeal_open';
  END IF;
  INSERT INTO trustwork.verification_appeal (hub_id, check_id, filed_by, reason) VALUES (v_check.hub_id, p_check, v_person, btrim(p_reason)) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- A trust reviewer decides: never the original reviewer, never the filer. Overturning records a new passing result.
CREATE FUNCTION trustwork.verification_decide_appeal(p_ctx jsonb, p_appeal uuid, p_expected_revision integer, p_decision text, p_note text, p_evidence text)
RETURNS trustwork.verification_appeal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.verification_appeal%ROWTYPE;
  v_check trustwork.verification_check%ROWTYPE;
  v_recipe trustwork.verification_recipe%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_new trustwork.verification_check%ROWTYPE;
  v_row trustwork.verification_appeal%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.verification_appeal WHERE id = p_appeal FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such appeal' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.verification_staff(p_ctx, ARRAY['admin.claims.decide'], v_before.hub_id);
  PERFORM trustwork.verification_check_revision(v_before.revision, p_expected_revision);
  IF v_before.status <> 'open' THEN
    RAISE EXCEPTION 'the appeal is decided' USING ERRCODE = 'check_violation', HINT = 'verification.invalid_transition';
  END IF;
  SELECT * INTO v_check FROM trustwork.verification_check WHERE id = v_before.check_id;
  IF v_actor.person_id = v_check.recorded_by THEN
    RAISE EXCEPTION 'the original reviewer never decides the appeal' USING ERRCODE = 'insufficient_privilege', HINT = 'verification.original_reviewer';
  END IF;
  IF v_actor.person_id = v_before.filed_by THEN
    RAISE EXCEPTION 'the filer never decides their own appeal' USING ERRCODE = 'insufficient_privilege', HINT = 'verification.own_appeal';
  END IF;
  IF p_decision NOT IN ('upheld', 'overturned') THEN
    RAISE EXCEPTION 'an appeal is upheld or overturned' USING ERRCODE = 'invalid_parameter_value', HINT = 'verification.invalid_decision';
  END IF;
  IF p_decision = 'overturned' THEN
    IF p_evidence IS NULL THEN
      RAISE EXCEPTION 'overturning names its evidence' USING ERRCODE = 'check_violation', HINT = 'verification.evidence_required';
    END IF;
    SELECT * INTO v_recipe FROM trustwork.verification_recipe WHERE id = v_check.recipe_id;
    INSERT INTO trustwork.verification_check (hub_id, subject_person_id, subject_company_id, recipe_id, check_type, provider_id, mode, result, evidence_ref, recorded_by, expires_at)
    VALUES (v_check.hub_id, v_check.subject_person_id, v_check.subject_company_id, v_check.recipe_id, v_check.check_type, v_check.provider_id, 'manual', 'pass', p_evidence,
      v_actor.person_id, now() + make_interval(months => v_recipe.recheck_months))
    RETURNING * INTO v_new;
  END IF;
  UPDATE trustwork.verification_appeal SET status = p_decision, decided_by = v_actor.person_id, decided_at = now(), decision_note = btrim(p_note), new_check_id = v_new.id,
    revision = revision + 1 WHERE id = p_appeal RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'verification.appeal_' || p_decision, 'verification_appeal', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

ALTER TABLE trustwork.verification_appeal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.verification_appeal FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.verification_appeal AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY verification_appeal_read ON trustwork.verification_appeal FOR SELECT TO trustwork_app
  USING (filed_by = trustwork.current_person_id() OR trustwork.verification_staff_reader(hub_id));
GRANT SELECT ON trustwork.verification_appeal TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.verification_file_appeal(uuid, text), trustwork.verification_decide_appeal(jsonb, uuid, integer, text, text, text) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
