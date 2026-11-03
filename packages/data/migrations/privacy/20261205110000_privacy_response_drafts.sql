-- PRV-001: a privacy response package may be prepared at Draft by a staff member. The row keeps room for an operator
-- agent under an operator grant (AGT-030), but refuses it until such grants exist. Preparing is not deciding. The row has a single state, carries ids and codes only (never a correction text or an
-- address), changes nothing on the request, its holds or its plans, and is immutable once written.
CREATE TABLE trustwork.privacy_response_draft (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  request_id uuid NOT NULL REFERENCES trustwork.privacy_request(id),
  prepared_by uuid NOT NULL REFERENCES trustwork.person(id),
  prepared_via text NOT NULL CHECK (prepared_via IN ('person', 'delegated_agent')),
  mandate_id text CHECK (mandate_id IS NULL OR length(mandate_id) BETWEEN 1 AND 128),
  mandate_revision integer CHECK (mandate_revision IS NULL OR mandate_revision >= 1),
  state text NOT NULL DEFAULT 'Draft' CHECK (state = 'Draft'),
  package jsonb NOT NULL CHECK (jsonb_typeof(package) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((prepared_via = 'delegated_agent') = (mandate_id IS NOT NULL)),
  CHECK ((mandate_id IS NULL) = (mandate_revision IS NULL)),
  -- Until operator grants exist (AGT-030), only a person prepares a Draft. A participant's mandate marker is never an
  -- operator grant (AGENTS.md); the AGT-030 migration drops this constraint when it adds the grant columns.
  CONSTRAINT privacy_response_draft_person_only CHECK (prepared_via = 'person'),
  -- The same package prepared in person and through an assistant are two records of who prepared what.
  UNIQUE NULLS NOT DISTINCT (request_id, prepared_by, prepared_via, mandate_id, mandate_revision, digest)
);
CREATE INDEX privacy_response_draft_request ON trustwork.privacy_response_draft(request_id, created_at);
CREATE TRIGGER privacy_response_draft_permanent BEFORE UPDATE OR DELETE ON trustwork.privacy_response_draft
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.privacy_response_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.privacy_response_draft FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON trustwork.privacy_response_draft TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- The caller is a person holding the platform privacy read permission and is not the subject or one of its members. No
-- elevation is required because the preparation decides nothing. The subject lock keeps the package consistent with
-- holds and plans written in the same instant.
CREATE FUNCTION trustwork.privacy_response_draft_prepare(p_request uuid, p_coverage jsonb, p_delegation jsonb) RETURNS trustwork.privacy_response_draft
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid := trustwork.admin_require_caller(); v_request trustwork.privacy_request%ROWTYPE; v_holds integer; v_reason text;
  v_package jsonb; v_digest text; v_row trustwork.privacy_response_draft%ROWTYPE; v_via text; v_mandate text; v_revision integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM trustwork.admin_resolve_permission(v_person, 'admin.privacy.request.read', NULL, NULL) r WHERE r.role IS NOT NULL) THEN
    RAISE EXCEPTION 'privacy read permission required' USING ERRCODE = '42501', HINT = 'privacy.forbidden';
  END IF;
  IF jsonb_typeof(p_coverage) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'coverage must be an array' USING ERRCODE = '22023'; END IF;
  -- A delegated principal carries a participant's mandate, which is not an operator grant. Refused until AGT-030
  -- supplies grants with an accountable staff member; the table constraint refuses the row even if this check moved.
  IF p_delegation IS NOT NULL THEN
    RAISE EXCEPTION 'operator grant required; a mandate does not prepare privacy responses' USING ERRCODE = '42501', HINT = 'privacy.operator_grant_required';
  END IF;
  v_via := 'person';
  SELECT * INTO v_request FROM trustwork.privacy_request WHERE id = p_request;
  IF v_request.id IS NULL THEN RAISE EXCEPTION 'request unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found'; END IF;
  IF (v_request.subject_kind = 'person' AND v_request.subject_id = v_person)
    OR (v_request.subject_kind = 'company' AND EXISTS(SELECT 1 FROM trustwork.membership WHERE person_id = v_person AND company_id = v_request.subject_id AND status = 'active')) THEN
    RAISE EXCEPTION 'subject conflict' USING ERRCODE = '42501', HINT = 'admin.conflict_of_interest';
  END IF;
  PERFORM trustwork.privacy_lock_subject(v_request.subject_kind, v_request.subject_id);
  SELECT * INTO v_request FROM trustwork.privacy_request WHERE id = p_request FOR SHARE;
  SELECT count(*) INTO v_holds FROM trustwork.legal_hold WHERE subject_kind = v_request.subject_kind AND subject_id = v_request.subject_id AND released_at IS NULL;
  -- The same fail-closed order as privacy_erasure_check and privacy_plan_execute; a Draft never says "ready".
  v_reason := CASE WHEN v_holds > 0 THEN 'legal_hold' WHEN v_request.policy_status <> 'verified' THEN 'country_policy_UNKNOWN'
    ELSE 'owning_module_capabilities_unavailable' END;
  v_package := jsonb_build_object(
    'version', 1, 'state', 'Draft',
    'request', jsonb_build_object('id', v_request.id, 'kind', v_request.kind, 'state', v_request.state,
      'subject', jsonb_build_object('kind', v_request.subject_kind, 'id', v_request.subject_id),
      'country', v_request.country, 'policyStatus', v_request.policy_status, 'policyVersion', v_request.policy_version,
      'createdAt', to_char(v_request.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'deadlineAt', CASE WHEN v_request.deadline_at IS NULL THEN NULL ELSE to_jsonb(to_char(v_request.deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END,
      'retentionDays', v_request.retention_days, 'hasCorrection', v_request.correction IS NOT NULL),
    'holds', jsonb_build_object('active', v_holds),
    'erasure', CASE WHEN v_request.kind = 'erasure' THEN jsonb_build_object('ready', false, 'reason', v_reason) ELSE NULL END,
    'exportCoverage', p_coverage,
    'inventory', to_jsonb(trustwork.privacy_module_inventory()),
    'unresolved', (SELECT jsonb_agg(jsonb_build_object('module', m, 'capability', 'erase', 'reason', m || '.authorized_subject_retention_and_erasure') ORDER BY m)
      FROM unnest(trustwork.privacy_module_inventory()) m),
    'humanDecisionsRequired', CASE v_request.kind
      WHEN 'erasure' THEN to_jsonb(ARRAY['privacy.plan_propose', 'privacy.plan_approve', 'privacy.plan_execute'])
      WHEN 'correction' THEN to_jsonb(ARRAY['owning_module.correction_resolution'])
      WHEN 'access' THEN to_jsonb(ARRAY['privacy.export_delivery_by_subject'])
      ELSE to_jsonb(ARRAY[]::text[]) END);
  v_digest := trustwork.admin_digest(v_package);
  INSERT INTO trustwork.privacy_response_draft(request_id, prepared_by, prepared_via, mandate_id, mandate_revision, package, digest)
    VALUES(p_request, v_person, v_via, v_mandate, v_revision, v_package, v_digest) ON CONFLICT DO NOTHING;
  SELECT * INTO v_row FROM trustwork.privacy_response_draft WHERE request_id = p_request AND prepared_by = v_person AND prepared_via = v_via
    AND mandate_id IS NOT DISTINCT FROM v_mandate AND mandate_revision IS NOT DISTINCT FROM v_revision AND digest = v_digest;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.privacy_response_drafts(p_request uuid) RETURNS SETOF trustwork.privacy_response_draft
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid := trustwork.admin_require_caller();
BEGIN
  IF NOT EXISTS(SELECT 1 FROM trustwork.admin_resolve_permission(v_person, 'admin.privacy.request.read', NULL, NULL) r WHERE r.role IS NOT NULL) THEN
    RAISE EXCEPTION 'privacy read permission required' USING ERRCODE = '42501', HINT = 'privacy.forbidden';
  END IF;
  RETURN QUERY SELECT * FROM trustwork.privacy_response_draft WHERE request_id = p_request ORDER BY created_at, id;
END $$;

REVOKE EXECUTE ON FUNCTION trustwork.privacy_response_draft_prepare(uuid, jsonb, jsonb), trustwork.privacy_response_drafts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.privacy_response_draft_prepare(uuid, jsonb, jsonb), trustwork.privacy_response_drafts(uuid) TO trustwork_app;
