-- PRV-001. Preparing and reading a response Draft needed only the platform privacy read permission, while a plan needs a
-- case grant (privacy_plan_case). A Draft names the holds on a subject, so a privacy officer who filed the request, or
-- whose company did, could read another officer's Draft and learn of a legal hold on themselves; preparation checked
-- the subject and membership but not a declared conflict; and neither route left an audit row.
-- Both commands now need a usable case grant naming the request and the conflict check, and both write the audit row
-- and the access log entry in their own transaction. No elevation is added: a Draft still decides nothing, and
-- admin_audit_event requires an elevation, so the audit row goes to audit_event, as other non-elevated commands do.
DROP FUNCTION trustwork.privacy_response_draft_prepare(uuid, jsonb, jsonb);
DROP FUNCTION trustwork.privacy_response_drafts(uuid);

-- The same locks in the same order as privacy_plan_case, with the read permission a Draft needs. One refusal covers a
-- missing grant, an unknown request and every conflict, so the answer never confirms who the subject is.
CREATE FUNCTION trustwork.privacy_response_draft_case(p_person uuid, p_grant uuid, p_request uuid) RETURNS trustwork.case_access_grant
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE v_case uuid; v_grant trustwork.case_access_grant%ROWTYPE;
BEGIN
  PERFORM 1 FROM trustwork.person WHERE id = p_person FOR SHARE;
  PERFORM 1 FROM trustwork.staff_role_assignment WHERE person_id = p_person ORDER BY id FOR SHARE;
  SELECT support_case_id INTO v_case FROM trustwork.case_access_grant WHERE id = p_grant;
  PERFORM 1 FROM trustwork.support_case WHERE id = v_case FOR SHARE;
  SELECT * INTO v_grant FROM trustwork.case_access_grant WHERE id = p_grant FOR SHARE;
  IF NOT coalesce(trustwork.admin_grant_usable(p_person, p_grant, 'privacy_request', p_request), false)
    OR v_grant.expires_at <= clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM trustwork.support_case c JOIN trustwork.privacy_request r ON r.id = p_request
      WHERE c.id = v_case AND ((r.subject_kind = 'person' AND c.subject_person_id = r.subject_id)
        OR (r.subject_kind = 'company' AND c.subject_company_id = r.subject_id))
      AND NOT trustwork.admin_conflicted(p_person, c.subject_person_id, c.subject_company_id)
      AND c.requester_person_id <> p_person AND r.requested_by <> p_person)
    OR NOT EXISTS(SELECT 1 FROM trustwork.admin_resolve_permission(p_person, 'admin.privacy.request.read', NULL, NULL) r WHERE r.role IS NOT NULL) THEN
    RAISE EXCEPTION 'current privacy authority and case grant required' USING ERRCODE = '42501', HINT = 'privacy.case_grant_required';
  END IF;
  RETURN v_grant;
END $$;

-- One audit row and one access log entry per use of the grant. Ids and digests only, never a package.
CREATE FUNCTION trustwork.privacy_response_draft_audit(p_person uuid, p_grant trustwork.case_access_grant, p_request uuid, p_action text, p_digest text, p_request_id text) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  INSERT INTO trustwork.access_log_entry (actor_person_id, grant_id, hub_id, case_id, kind, object_type, object_id, fields_hash)
    VALUES (p_person, p_grant.id, p_grant.hub_id, p_grant.support_case_id, 'case_read', 'privacy_request', p_request, p_digest);
  INSERT INTO trustwork.audit_event (actor_person_id, action, object_kind, object_id, after_digest, basis, request_id)
    VALUES (p_person, p_action, 'privacy_request', p_request::text, p_digest,
      jsonb_build_object('grantId', p_grant.id, 'caseId', p_grant.support_case_id), p_request_id);
END $$;

-- The caller is a person with the privacy read permission and a usable case grant naming the request, who is not the
-- subject, a member of the subject company, conflicted, or the one who filed it. No elevation is required because the
-- preparation decides nothing. The subject lock keeps the package consistent with holds and plans written in the same
-- instant.
CREATE FUNCTION trustwork.privacy_response_draft_prepare(p_request uuid, p_grant uuid, p_coverage jsonb, p_delegation jsonb, p_request_id text) RETURNS trustwork.privacy_response_draft
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid := trustwork.admin_require_caller(); v_request trustwork.privacy_request%ROWTYPE; v_holds integer; v_reason text;
  v_package jsonb; v_digest text; v_row trustwork.privacy_response_draft%ROWTYPE; v_via text; v_mandate text; v_revision integer;
  v_grant trustwork.case_access_grant%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_coverage) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'coverage must be an array' USING ERRCODE = '22023'; END IF;
  -- A delegated principal carries a participant's mandate, which is not an operator grant. Refused until AGT-030
  -- supplies grants with an accountable staff member; the table constraint refuses the row even if this check moved.
  IF p_delegation IS NOT NULL THEN
    RAISE EXCEPTION 'operator grant required; a mandate does not prepare privacy responses' USING ERRCODE = '42501', HINT = 'privacy.operator_grant_required';
  END IF;
  v_via := 'person';
  v_grant := trustwork.privacy_response_draft_case(v_person, p_grant, p_request);
  SELECT * INTO v_request FROM trustwork.privacy_request WHERE id = p_request;
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
  PERFORM trustwork.privacy_response_draft_audit(v_person, v_grant, p_request, 'privacy.response_draft_prepared', v_digest, p_request_id);
  RETURN v_row;
END $$;

-- Reading writes the audit row, so the function is volatile. The digest covers the digests of the Drafts returned.
CREATE FUNCTION trustwork.privacy_response_drafts(p_request uuid, p_grant uuid, p_request_id text) RETURNS SETOF trustwork.privacy_response_draft
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid := trustwork.admin_require_caller(); v_grant trustwork.case_access_grant%ROWTYPE; v_digest text;
BEGIN
  v_grant := trustwork.privacy_response_draft_case(v_person, p_grant, p_request);
  SELECT trustwork.admin_digest(coalesce(jsonb_agg(d.digest ORDER BY d.created_at, d.id), '[]'::jsonb)) INTO v_digest
    FROM trustwork.privacy_response_draft d WHERE d.request_id = p_request;
  PERFORM trustwork.privacy_response_draft_audit(v_person, v_grant, p_request, 'privacy.response_drafts_read', v_digest, p_request_id);
  RETURN QUERY SELECT * FROM trustwork.privacy_response_draft WHERE request_id = p_request ORDER BY created_at, id;
END $$;

REVOKE EXECUTE ON FUNCTION trustwork.privacy_response_draft_case(uuid, uuid, uuid),
  trustwork.privacy_response_draft_audit(uuid, trustwork.case_access_grant, uuid, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION trustwork.privacy_response_draft_prepare(uuid, uuid, jsonb, jsonb, text), trustwork.privacy_response_drafts(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.privacy_response_draft_prepare(uuid, uuid, jsonb, jsonb, text), trustwork.privacy_response_drafts(uuid, uuid, text) TO trustwork_app;
