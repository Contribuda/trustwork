-- Human privacy review binds a server-built subject inventory, never caller-supplied delete instructions.
CREATE TABLE trustwork.privacy_subject_plan (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), request_id uuid NOT NULL REFERENCES trustwork.privacy_request(id),
  proposed_by uuid NOT NULL REFERENCES trustwork.person(id), proposer_grant_id uuid NOT NULL REFERENCES trustwork.case_access_grant(id),
  proposer_authority_digest text NOT NULL, reviewer_authority_digest text,
  reviewer_grant_id uuid REFERENCES trustwork.case_access_grant(id), approval_id uuid NOT NULL UNIQUE REFERENCES trustwork.second_person_approval(id),
  snapshot jsonb NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed', 'approved', 'blocked', 'invalidated')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX privacy_subject_plan_accepted ON trustwork.privacy_subject_plan(request_id) WHERE state IN ('approved', 'blocked');
ALTER TABLE trustwork.privacy_subject_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.privacy_subject_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON trustwork.privacy_subject_plan TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());

CREATE FUNCTION trustwork.privacy_module_inventory() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['approval-routes','assistant','assistant-goals','billing','catalogue','communications','connections','consultations',
    'content','directory','execution','files','hubs','identity','jurisdiction','models','plans','platform-admin',
    'procurement','profiles','projects','providers','reputation','sales','screening','screening-gates','sources',
    'supplier-base','support','tasks','transactions','trust']::text[]
$$;

-- The authorization row locks survive the mutation/decision transaction. Case closure locks case before grant;
-- role revocation locks assignment before revoking grants. Keep that order here as well.
CREATE FUNCTION trustwork.privacy_plan_case(p_person uuid, p_grant uuid, p_request uuid) RETURNS void
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
      AND NOT trustwork.admin_conflicted(p_person, c.subject_person_id, c.subject_company_id) AND c.requester_person_id <> p_person)
    OR NOT EXISTS(SELECT 1 FROM trustwork.admin_resolve_permission(p_person, 'admin.privacy.erasure.execute', NULL, NULL) r WHERE r.role IS NOT NULL) THEN
    RAISE EXCEPTION 'current privacy authority and case grant required' USING ERRCODE = '42501', HINT = 'privacy.case_grant_required';
  END IF;
END $$;

CREATE FUNCTION trustwork.privacy_plan_snapshot(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE v_request trustwork.privacy_request%ROWTYPE; v_policy trustwork.privacy_country_policy%ROWTYPE;
  v_subject jsonb; v_holds jsonb; v_rows jsonb; v_actions jsonb;
BEGIN
  SELECT * INTO v_request FROM trustwork.privacy_request WHERE id = p_request;
  IF NOT FOUND OR v_request.kind <> 'erasure' THEN RAISE EXCEPTION 'request unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found'; END IF;
  PERFORM trustwork.privacy_lock_subject(v_request.subject_kind, v_request.subject_id);
  SELECT * INTO v_request FROM trustwork.privacy_request WHERE id = p_request FOR SHARE;
  SELECT * INTO v_policy FROM trustwork.privacy_country_policy WHERE country = v_request.country FOR SHARE;
  IF v_request.subject_kind = 'person' THEN
    PERFORM 1 FROM trustwork.person WHERE id = v_request.subject_id FOR SHARE;
    SELECT jsonb_build_object('kind', 'person', 'id', id, 'revision', revision, 'authzEpoch', authz_epoch) INTO v_subject FROM trustwork.person WHERE id = v_request.subject_id;
  ELSE
    PERFORM 1 FROM trustwork.company WHERE id = v_request.subject_id FOR SHARE;
    SELECT jsonb_build_object('kind', 'company', 'id', id, 'revision', revision, 'authzEpoch', authz_epoch) INTO v_subject FROM trustwork.company WHERE id = v_request.subject_id;
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id), '[]'::jsonb) INTO v_holds FROM trustwork.legal_hold h
    WHERE subject_kind = v_request.subject_kind AND subject_id = v_request.subject_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'versionDigest', trustwork.admin_digest(to_jsonb(r)), 'action', 'redact_correction') ORDER BY r.id), '[]'::jsonb)
    INTO v_rows FROM trustwork.privacy_request r WHERE r.subject_kind = v_request.subject_kind AND r.subject_id = v_request.subject_id AND r.correction IS NOT NULL;
  SELECT jsonb_agg(jsonb_build_object('module', m, 'action', 'unavailable', 'gap', m || '.authorized_subject_retention_and_erasure') ORDER BY m)
    INTO v_actions FROM unnest(trustwork.privacy_module_inventory()) m;
  RETURN jsonb_build_object('version', 1, 'requestId', p_request, 'subject', v_subject, 'requestDigest', trustwork.admin_digest(to_jsonb(v_request)),
    'policy', to_jsonb(v_policy), 'holds', v_holds, 'inventory', to_jsonb(trustwork.privacy_module_inventory()), 'actions', v_actions,
    'privacyOwnedRecords', v_rows, 'complete', false);
END $$;

CREATE FUNCTION trustwork.privacy_plan_authority_digest(p_person uuid, p_grant uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('person', p_person, 'grant', (SELECT to_jsonb(g) FROM trustwork.case_access_grant g WHERE id = p_grant),
    'roles', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id), '[]'::jsonb) FROM trustwork.staff_role_assignment a WHERE person_id = p_person)))
$$;

CREATE FUNCTION trustwork.privacy_plan_propose(p_ctx jsonb, p_request uuid, p_grant uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_actor trustwork.admin_actor; v_snapshot jsonb; v_digest text; v_approval trustwork.second_person_approval%ROWTYPE; v_id uuid;
BEGIN
  PERFORM trustwork.privacy_plan_case(trustwork.current_person_id(), p_grant, p_request);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.privacy.erasure.execute'], NULL, NULL);
  v_snapshot := trustwork.privacy_plan_snapshot(p_request);
  v_digest := trustwork.admin_digest(v_snapshot);
  UPDATE trustwork.privacy_subject_plan SET state = 'invalidated' WHERE request_id = p_request AND state IN ('approved', 'blocked') AND digest <> v_digest;
  v_approval := trustwork.admin_request_approval(p_ctx, 'privacy.execute_erasure', 'platform', NULL, NULL, v_digest);
  INSERT INTO trustwork.privacy_subject_plan(request_id, proposed_by, proposer_grant_id, proposer_authority_digest, approval_id, snapshot, digest)
    VALUES(p_request, v_actor.person_id, p_grant, trustwork.privacy_plan_authority_digest(v_actor.person_id, p_grant), v_approval.id, v_snapshot, v_digest) RETURNING id INTO v_id;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, NULL, 'privacy.plan_proposed', 'privacy_subject_plan', v_id, NULL, jsonb_build_object('digest', v_digest));
  RETURN jsonb_build_object('id', v_id, 'digest', v_digest, 'approvalId', v_approval.id, 'snapshot', v_snapshot, 'state', 'proposed');
END $$;

CREATE FUNCTION trustwork.privacy_plan_approve(p_ctx jsonb, p_plan uuid, p_grant uuid, p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_plan trustwork.privacy_subject_plan%ROWTYPE; v_actor trustwork.admin_actor; v_snapshot jsonb;
BEGIN
  SELECT * INTO v_plan FROM trustwork.privacy_subject_plan WHERE id = p_plan FOR UPDATE;
  IF NOT FOUND OR v_plan.state <> 'proposed' THEN RAISE EXCEPTION 'plan unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found'; END IF;
  PERFORM trustwork.privacy_plan_case(trustwork.current_person_id(), p_grant, v_plan.request_id);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.privacy.erasure.execute'], NULL, NULL);
  v_snapshot := trustwork.privacy_plan_snapshot(v_plan.request_id);
  IF p_digest IS DISTINCT FROM v_plan.digest OR trustwork.admin_digest(v_snapshot) <> v_plan.digest
    OR trustwork.privacy_plan_authority_digest(v_plan.proposed_by, v_plan.proposer_grant_id) IS DISTINCT FROM v_plan.proposer_authority_digest THEN
    RAISE EXCEPTION 'subject plan changed' USING ERRCODE = '40001', HINT = 'privacy.plan_changed';
  END IF;
  PERFORM trustwork.admin_decide_approval(p_ctx, v_plan.approval_id, 'approve', p_digest);
  UPDATE trustwork.privacy_subject_plan SET state = 'approved', reviewer_grant_id = p_grant,
    reviewer_authority_digest = trustwork.privacy_plan_authority_digest(v_actor.person_id, p_grant) WHERE id = p_plan;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, NULL, 'privacy.plan_approved', 'privacy_subject_plan', p_plan, NULL, jsonb_build_object('digest', p_digest));
  RETURN jsonb_build_object('id', p_plan, 'digest', p_digest, 'state', 'approved', 'executable', false);
END $$;

-- Actual execution admission: all checks happen under the same subject/policy/authority locks.
-- No owning module currently supplies a complete subject-erasure operation. Record the exact engineering gaps;
-- do not consume an approval, write a retained decision or claim deletion merely because two people reviewed it.
CREATE FUNCTION trustwork.privacy_plan_execute(p_ctx jsonb, p_plan uuid, p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_plan trustwork.privacy_subject_plan%ROWTYPE; v_approval trustwork.second_person_approval%ROWTYPE;
  v_actor trustwork.admin_actor; v_snapshot jsonb; v_reason text;
BEGIN
  SELECT * INTO v_plan FROM trustwork.privacy_subject_plan WHERE id = p_plan FOR UPDATE;
  IF NOT FOUND OR v_plan.state NOT IN ('approved', 'blocked') OR v_plan.proposed_by <> trustwork.current_person_id() THEN
    RAISE EXCEPTION 'plan unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found';
  END IF;
  SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = v_plan.approval_id FOR SHARE;
  IF v_approval.status <> 'approved' OR v_approval.approved_by = v_plan.proposed_by OR v_approval.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'current second-person approval required' USING ERRCODE = '42501', HINT = 'privacy.approval_required';
  END IF;
  PERFORM trustwork.privacy_plan_case(v_plan.proposed_by, v_plan.proposer_grant_id, v_plan.request_id);
  PERFORM trustwork.privacy_plan_case(v_approval.approved_by, v_plan.reviewer_grant_id, v_plan.request_id);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.privacy.erasure.execute'], NULL, NULL);
  v_snapshot := trustwork.privacy_plan_snapshot(v_plan.request_id);
  IF p_digest IS DISTINCT FROM v_plan.digest OR trustwork.admin_digest(v_snapshot) <> v_plan.digest
    OR trustwork.privacy_plan_authority_digest(v_plan.proposed_by, v_plan.proposer_grant_id) IS DISTINCT FROM v_plan.proposer_authority_digest
    OR trustwork.privacy_plan_authority_digest(v_approval.approved_by, v_plan.reviewer_grant_id) IS DISTINCT FROM v_plan.reviewer_authority_digest THEN
    UPDATE trustwork.privacy_subject_plan SET state = 'invalidated' WHERE id = p_plan;
    v_reason := 'plan_changed';
  ELSE
    v_reason := CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(v_snapshot->'holds') h WHERE h->>'released_at' IS NULL) THEN 'legal_hold'
      WHEN v_snapshot#>>'{policy,review}' IS DISTINCT FROM 'verified' THEN 'country_policy_UNKNOWN'
      ELSE 'owning_module_capabilities_unavailable' END;
    UPDATE trustwork.privacy_subject_plan SET state = 'blocked' WHERE id = p_plan;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, NULL, 'privacy.execution_blocked', 'privacy_subject_plan', p_plan, NULL,
    jsonb_build_object('reason', v_reason, 'digest', v_plan.digest));
  RETURN jsonb_build_object('status', CASE WHEN v_reason = 'plan_changed' THEN 'invalidated' ELSE 'blocked' END, 'complete', false,
    'reason', v_reason, 'gaps', v_snapshot->'actions');
END $$;

REVOKE EXECUTE ON FUNCTION trustwork.privacy_module_inventory(), trustwork.privacy_plan_case(uuid, uuid, uuid), trustwork.privacy_plan_snapshot(uuid),
  trustwork.privacy_plan_authority_digest(uuid, uuid),
  trustwork.privacy_plan_propose(jsonb, uuid, uuid), trustwork.privacy_plan_approve(jsonb, uuid, uuid, text), trustwork.privacy_plan_execute(jsonb, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.privacy_plan_propose(jsonb, uuid, uuid), trustwork.privacy_plan_approve(jsonb, uuid, uuid, text), trustwork.privacy_plan_execute(jsonb, uuid, text) TO trustwork_app;
