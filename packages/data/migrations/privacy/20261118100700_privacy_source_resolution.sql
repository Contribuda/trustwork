-- Exact source resolution belongs to SRC. Original provenance is never rewritten or deleted.
CREATE TABLE trustwork.source_field_resolution (
  id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE REFERENCES trustwork.privacy_source_request(id),
  source_field_id uuid NOT NULL REFERENCES trustwork.sourced_record_field(id),
  replacement_field_id uuid UNIQUE REFERENCES trustwork.sourced_record_field(id),
  action text NOT NULL CHECK(action IN ('correction','erasure')), source_digest text NOT NULL,
  decision_digest text NOT NULL, retained_digest text,
  executed_by uuid NOT NULL REFERENCES trustwork.person(id), approved_by uuid NOT NULL REFERENCES trustwork.person(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(executed_by<>approved_by), CHECK((action='correction')=(replacement_field_id IS NOT NULL)),
  CHECK((action='erasure')=(retained_digest IS NOT NULL))
);
CREATE TRIGGER source_field_resolution_immutable BEFORE UPDATE OR DELETE ON trustwork.source_field_resolution
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TABLE trustwork.privacy_source_hold (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), source_field_id uuid NOT NULL REFERENCES trustwork.sourced_record_field(id),
  placed_by uuid NOT NULL REFERENCES trustwork.person(id), reason_code text NOT NULL CHECK(reason_code IN ('litigation','statutory_retention','dispute_evidence')),
  evidence_ref uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER privacy_source_hold_immutable BEFORE UPDATE OR DELETE ON trustwork.privacy_source_hold
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TABLE trustwork.privacy_source_plan (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), request_id uuid NOT NULL REFERENCES trustwork.privacy_source_request(id),
  proposed_by uuid NOT NULL REFERENCES trustwork.person(id), proposer_grant_id uuid NOT NULL REFERENCES trustwork.case_access_grant(id),
  reviewer_grant_id uuid REFERENCES trustwork.case_access_grant(id), proposer_authority_digest text NOT NULL, reviewer_authority_digest text,
  approval_id uuid NOT NULL UNIQUE REFERENCES trustwork.second_person_approval(id), snapshot jsonb NOT NULL, digest text NOT NULL,
  state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','applied')), created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['source_field_resolution','privacy_source_hold','privacy_source_plan'] LOOP
    EXECUTE format('ALTER TABLE trustwork.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE trustwork.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY maintenance ON trustwork.%I TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on())',t);
  END LOOP;
END $$;

-- Use existing support grant authority, with an additional exact external-case binding.
CREATE FUNCTION trustwork.privacy_source_case(p_person uuid,p_grant uuid,p_field uuid,p_case uuid) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE v_grant trustwork.case_access_grant%ROWTYPE;
BEGIN
  PERFORM 1 FROM trustwork.person WHERE id=p_person FOR SHARE;
  PERFORM 1 FROM trustwork.staff_role_assignment WHERE person_id=p_person ORDER BY id FOR SHARE;
  PERFORM 1 FROM trustwork.support_case WHERE id=p_case FOR SHARE;
  SELECT * INTO v_grant FROM trustwork.case_access_grant WHERE id=p_grant FOR SHARE;
  IF v_grant.support_case_id IS DISTINCT FROM p_case OR NOT coalesce(trustwork.admin_grant_usable(p_person,p_grant,'sourced_record_field',p_field),false)
    OR v_grant.expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM trustwork.admin_resolve_permission(p_person,'admin.privacy.erasure.execute',NULL,v_grant.hub_id) r
      JOIN trustwork.staff_role_assignment a ON a.person_id=p_person AND a.role=r.role
      JOIN trustwork.staff_role_definition_version d ON d.role=a.role AND d.version=a.definition_version
      WHERE a.revoked_at IS NULL AND a.valid_from<=clock_timestamp() AND (a.valid_until IS NULL OR a.valid_until>clock_timestamp())
        AND 'admin.privacy.erasure.execute'=ANY(d.permissions) AND a.scope_kind=ANY(d.scopes)
        AND (a.scope_kind='platform' OR a.scope_kind='node' OR a.hub_id=v_grant.hub_id)) THEN
    RAISE EXCEPTION 'current exact source case grant required' USING ERRCODE='42501',HINT='privacy.case_grant_required';
  END IF;
END $$;

CREATE FUNCTION trustwork.privacy_source_snapshot(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE v_request trustwork.privacy_source_request%ROWTYPE; v_proof trustwork.privacy_source_proof%ROWTYPE;
  v_external trustwork.support_external_source_subject%ROWTYPE; v_field trustwork.sourced_record_field%ROWTYPE;
  v_source uuid; v_case uuid; v_policy trustwork.privacy_country_policy%ROWTYPE; v_holds jsonb;
BEGIN
  SELECT * INTO v_request FROM trustwork.privacy_source_request WHERE id=p_request;
  SELECT * INTO v_proof FROM trustwork.privacy_source_proof WHERE id=v_request.proof_id;
  SELECT c.id INTO v_case FROM trustwork.support_case c JOIN trustwork.case_access_grant g ON g.support_case_id=c.id
    JOIN trustwork.support_external_source_subject e ON e.id=c.external_source_subject_id WHERE g.id=v_proof.grant_id;
  -- Only the explicit verified external-subject contract is resolvable by this port.
  SELECT e.* INTO v_external FROM trustwork.support_external_source_subject e JOIN trustwork.support_case c ON c.external_source_subject_id=e.id WHERE c.id=v_case;
  IF v_request.id IS NULL OR v_request.action NOT IN ('correction','erasure') OR v_external.id IS NULL THEN
    RAISE EXCEPTION 'source request unavailable' USING ERRCODE='42501',HINT='privacy.not_found';
  END IF;
  SELECT * INTO v_field FROM trustwork.sourced_record_field WHERE id=v_request.source_field_id;
  PERFORM trustwork.privacy_lock_subject('company',v_field.record_id);
  PERFORM trustwork.privacy_lock_subject('person',v_field.record_id);
  v_source:=v_field.source_id;
  PERFORM 1 FROM trustwork.source WHERE id=v_source FOR UPDATE;
  SELECT * INTO v_field FROM trustwork.sourced_record_field WHERE id=v_request.source_field_id FOR UPDATE;
  IF NOT v_field.active OR v_field.source_id IS DISTINCT FROM v_source OR trustwork.privacy_source_digest(v_field.id) IS DISTINCT FROM v_proof.source_digest
    OR v_external.source_digest IS DISTINCT FROM v_proof.source_digest
    OR v_external.proposed_value_digest IS DISTINCT FROM trustwork.admin_digest(coalesce(to_jsonb(v_request.proposed_value),'null'::jsonb)) THEN
    RAISE EXCEPTION 'source changed' USING ERRCODE='40001',HINT='privacy.plan_changed';
  END IF;
  -- An absent policy stays UNKNOWN. A present policy cannot change during decision/application.
  SELECT * INTO v_policy FROM trustwork.privacy_country_policy WHERE country=v_external.country FOR SHARE;
  SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY id),'[]'::jsonb) INTO v_holds FROM trustwork.privacy_source_hold h WHERE source_field_id=v_field.id;
  IF EXISTS(SELECT 1 FROM trustwork.legal_hold WHERE subject_id=v_field.record_id AND released_at IS NULL) THEN
    v_holds:=v_holds||jsonb_build_array(jsonb_build_object('reason','subject_legal_hold'));
  END IF;
  RETURN jsonb_build_object('requestId',p_request,'sourceFieldId',v_field.id,'sourceDigest',v_proof.source_digest,
    'sourceId',v_field.source_id,'sourceEvidenceDigest',trustwork.admin_digest(to_jsonb(v_field)-'active'-'deactivated_at'-'takedown_id'),
    'recordKind',v_field.record_kind,'recordId',v_field.record_id,'caseId',v_case,'action',v_request.action,
    'proposedValueDigest',v_external.proposed_value_digest,'evidenceDigest',v_external.evidence_digest,
    'policy',to_jsonb(v_policy),'holds',v_holds,'retentionStartedAt',v_field.observed_at);
END $$;

CREATE FUNCTION trustwork.privacy_source_plan_propose(p_ctx jsonb,p_request uuid,p_grant uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_actor trustwork.admin_actor; v_field uuid; v_case uuid; v_snapshot jsonb; v_digest text; v_approval trustwork.second_person_approval%ROWTYPE; v_id uuid;
BEGIN
  SELECT r.source_field_id,g.support_case_id INTO v_field,v_case FROM trustwork.privacy_source_request r
    JOIN trustwork.privacy_source_proof p ON p.id=r.proof_id JOIN trustwork.case_access_grant g ON g.id=p.grant_id WHERE r.id=p_request;
  PERFORM trustwork.privacy_source_case(trustwork.current_person_id(),p_grant,v_field,v_case);
  v_actor:=trustwork.admin_authorize(p_ctx,ARRAY['admin.privacy.erasure.execute'],NULL,NULL);
  v_snapshot:=trustwork.privacy_source_snapshot(p_request); v_digest:=trustwork.admin_digest(v_snapshot);
  v_approval:=trustwork.admin_request_approval(p_ctx,'privacy.execute_erasure','platform',NULL,NULL,v_digest);
  INSERT INTO trustwork.privacy_source_plan(request_id,proposed_by,proposer_grant_id,proposer_authority_digest,approval_id,snapshot,digest)
    VALUES(p_request,v_actor.person_id,p_grant,trustwork.privacy_plan_authority_digest(v_actor.person_id,p_grant),v_approval.id,v_snapshot,v_digest) RETURNING id INTO v_id;
  PERFORM trustwork.admin_record(v_actor,p_ctx,NULL,NULL,'privacy.source_plan_proposed','privacy_source_plan',v_id,NULL,jsonb_build_object('digest',v_digest),v_case);
  RETURN jsonb_build_object('id',v_id,'digest',v_digest,'approvalId',v_approval.id,'snapshot',v_snapshot);
END $$;

CREATE FUNCTION trustwork.privacy_source_plan_approve(p_ctx jsonb,p_id uuid,p_grant uuid,p_digest text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_plan trustwork.privacy_source_plan%ROWTYPE; v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_plan FROM trustwork.privacy_source_plan WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_plan.state<>'proposed' THEN RAISE EXCEPTION 'plan unavailable' USING ERRCODE='42501',HINT='privacy.not_found'; END IF;
  PERFORM trustwork.privacy_source_case(v_plan.proposed_by,v_plan.proposer_grant_id,(v_plan.snapshot->>'sourceFieldId')::uuid,(v_plan.snapshot->>'caseId')::uuid);
  PERFORM trustwork.privacy_source_case(trustwork.current_person_id(),p_grant,(v_plan.snapshot->>'sourceFieldId')::uuid,(v_plan.snapshot->>'caseId')::uuid);
  v_actor:=trustwork.admin_authorize(p_ctx,ARRAY['admin.privacy.erasure.execute'],NULL,NULL);
  IF p_digest IS DISTINCT FROM v_plan.digest OR trustwork.admin_digest(trustwork.privacy_source_snapshot(v_plan.request_id))<>p_digest
    OR trustwork.privacy_plan_authority_digest(v_plan.proposed_by,v_plan.proposer_grant_id) IS DISTINCT FROM v_plan.proposer_authority_digest THEN
    RAISE EXCEPTION 'source plan changed' USING ERRCODE='40001',HINT='privacy.plan_changed';
  END IF;
  PERFORM trustwork.admin_decide_approval(p_ctx,v_plan.approval_id,'approve',p_digest);
  UPDATE trustwork.privacy_source_plan SET state='approved',reviewer_grant_id=p_grant,
    reviewer_authority_digest=trustwork.privacy_plan_authority_digest(v_actor.person_id,p_grant) WHERE id=p_id;
END $$;

-- Admission returns only exact reviewed metadata and holds every authority/source/policy lock through the caller transaction.
CREATE FUNCTION trustwork.privacy_source_plan_admit(p_ctx jsonb,p_id uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_plan trustwork.privacy_source_plan%ROWTYPE; v_approval trustwork.second_person_approval%ROWTYPE;
  v_actor trustwork.admin_actor; v_snapshot jsonb;
BEGIN
  SELECT * INTO v_plan FROM trustwork.privacy_source_plan WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_plan.state<>'approved' OR v_plan.proposed_by<>trustwork.current_person_id() THEN
    RAISE EXCEPTION 'plan unavailable' USING ERRCODE='42501',HINT='privacy.not_found';
  END IF;
  SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id=v_plan.approval_id FOR SHARE;
  IF v_approval.status<>'approved' OR v_approval.expires_at<=clock_timestamp() OR v_approval.approved_by=v_plan.proposed_by THEN
    RAISE EXCEPTION 'current second person required' USING ERRCODE='42501',HINT='privacy.approval_required';
  END IF;
  PERFORM trustwork.privacy_source_case(v_plan.proposed_by,v_plan.proposer_grant_id,(v_plan.snapshot->>'sourceFieldId')::uuid,(v_plan.snapshot->>'caseId')::uuid);
  PERFORM trustwork.privacy_source_case(v_approval.approved_by,v_plan.reviewer_grant_id,(v_plan.snapshot->>'sourceFieldId')::uuid,(v_plan.snapshot->>'caseId')::uuid);
  v_actor:=trustwork.admin_authorize(p_ctx,ARRAY['admin.privacy.erasure.execute'],NULL,NULL);
  v_snapshot:=trustwork.privacy_source_snapshot(v_plan.request_id);
  IF p_digest IS DISTINCT FROM v_plan.digest OR trustwork.admin_digest(v_snapshot)<>p_digest
    OR trustwork.privacy_plan_authority_digest(v_plan.proposed_by,v_plan.proposer_grant_id) IS DISTINCT FROM v_plan.proposer_authority_digest
    OR trustwork.privacy_plan_authority_digest(v_approval.approved_by,v_plan.reviewer_grant_id) IS DISTINCT FROM v_plan.reviewer_authority_digest THEN
    RAISE EXCEPTION 'source plan changed' USING ERRCODE='40001',HINT='privacy.plan_changed';
  END IF;
  IF jsonb_array_length(v_snapshot->'holds')>0 THEN RAISE EXCEPTION 'legal hold' USING ERRCODE='42501',HINT='privacy.legal_hold'; END IF;
  IF v_snapshot#>>'{policy,review}' IS DISTINCT FROM 'verified' OR v_snapshot#>>'{policy,retention_days}' IS NULL THEN
    RAISE EXCEPTION 'policy or retention unknown' USING ERRCODE='42501',HINT='privacy.country_policy_UNKNOWN';
  END IF;
  IF (v_snapshot->>'retentionStartedAt')::timestamptz + make_interval(days=>(v_snapshot#>>'{policy,retention_days}')::int)>clock_timestamp() THEN
    RAISE EXCEPTION 'retention not elapsed' USING ERRCODE='42501',HINT='privacy.retention_required';
  END IF;
  PERFORM trustwork.privacy_source_case(v_plan.proposed_by,v_plan.proposer_grant_id,(v_plan.snapshot->>'sourceFieldId')::uuid,(v_plan.snapshot->>'caseId')::uuid);
  PERFORM trustwork.privacy_source_case(v_approval.approved_by,v_plan.reviewer_grant_id,(v_plan.snapshot->>'sourceFieldId')::uuid,(v_plan.snapshot->>'caseId')::uuid);
  IF v_approval.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'approval expired' USING ERRCODE='42501',HINT='privacy.approval_required'; END IF;
  RETURN v_snapshot||jsonb_build_object('approvalId',v_plan.approval_id,'planId',p_id,'digest',p_digest,'executedBy',v_actor.person_id,'approvedBy',v_approval.approved_by);
END $$;

-- Owning mutation port. Runtime roles cannot call it, so a supplied digest cannot manufacture retained authority.
CREATE FUNCTION trustwork.sources_apply_privacy_resolution(p_id uuid,p_retained_digest text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE v_plan trustwork.privacy_source_plan%ROWTYPE; v_request trustwork.privacy_source_request%ROWTYPE;
  v_field trustwork.sourced_record_field%ROWTYPE; v_replacement uuid; v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  SELECT * INTO v_plan FROM trustwork.privacy_source_plan WHERE id=p_id FOR UPDATE;
  SELECT * INTO v_request FROM trustwork.privacy_source_request WHERE id=v_plan.request_id;
  PERFORM 1 FROM trustwork.source WHERE id=(SELECT source_id FROM trustwork.sourced_record_field WHERE id=v_request.source_field_id) FOR UPDATE;
  SELECT * INTO v_field FROM trustwork.sourced_record_field WHERE id=v_request.source_field_id FOR UPDATE;
  SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id=v_plan.approval_id;
  IF EXISTS(SELECT 1 FROM trustwork.source_field_resolution WHERE id=p_id AND retained_digest IS NOT DISTINCT FROM p_retained_digest) THEN RETURN p_id; END IF;
  IF v_plan.state<>'approved' OR trustwork.privacy_source_digest(v_field.id) IS DISTINCT FROM v_plan.snapshot->>'sourceDigest'
    OR (v_request.action='erasure' AND p_retained_digest IS NULL) THEN
    RAISE EXCEPTION 'exact retained resolution required' USING ERRCODE='42501',HINT='privacy.plan_changed';
  END IF;
  IF v_request.action='correction' THEN
    v_replacement:=trustwork.new_uuid();
    PERFORM set_config('trustwork.source_resolution_field',v_replacement::text,true);
    INSERT INTO trustwork.sourced_record_field(id,hub_id,record_kind,record_id,field,value,source_id,import_batch_id,source_item_id)
      VALUES(v_replacement,v_field.hub_id,v_field.record_kind,v_field.record_id,v_field.field,v_request.proposed_value,v_field.source_id,v_field.import_batch_id,v_field.source_item_id)
      RETURNING id INTO v_replacement;
    PERFORM set_config('trustwork.source_resolution_field','',true);
  ELSE
    PERFORM trustwork.privacy_contact_lock(trustwork.privacy_source_key(v_field.record_kind,v_field.record_id));
    INSERT INTO trustwork.privacy_suppression(digest,marketing,do_not_collect) VALUES(trustwork.privacy_source_key(v_field.record_kind,v_field.record_id),false,true)
      ON CONFLICT(digest) DO UPDATE SET do_not_collect=true;
  END IF;
  UPDATE trustwork.sourced_record_field SET active=false,deactivated_at=clock_timestamp() WHERE id=v_field.id;
  INSERT INTO trustwork.source_field_resolution(id,request_id,source_field_id,replacement_field_id,action,source_digest,decision_digest,retained_digest,executed_by,approved_by)
    VALUES(p_id,v_request.id,v_field.id,v_replacement,v_request.action,v_plan.snapshot->>'sourceDigest',v_plan.digest,p_retained_digest,v_plan.proposed_by,v_approval.approved_by);
  UPDATE trustwork.privacy_source_request SET state='resolved' WHERE id=v_request.id;
  UPDATE trustwork.privacy_source_plan SET state='applied' WHERE id=p_id;
  RETURN p_id;
END $$;
CREATE FUNCTION trustwork.privacy_source_plan_execute(p_ctx jsonb,p_id uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_admission jsonb;
BEGIN
  v_admission:=trustwork.privacy_source_plan_admit(p_ctx,p_id,p_digest);
  IF v_admission->>'action'='erasure' THEN
    RETURN jsonb_build_object('status','blocked','complete',false,'reason','retained_authority_unavailable');
  END IF;
  PERFORM trustwork.admin_consume_approval((SELECT approval_id FROM trustwork.privacy_source_plan WHERE id=p_id),'privacy.execute_erasure','platform',NULL,NULL,p_digest,p_id);
  PERFORM trustwork.sources_apply_privacy_resolution(p_id);
  RETURN jsonb_build_object('status','applied','complete',false,'scope','exact_source_field','evidenceRetained',true);
END $$;

CREATE FUNCTION trustwork.privacy_source_hold_place(p_ctx jsonb,p_field uuid,p_grant uuid,p_reason text,p_evidence uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_case uuid; v_actor trustwork.admin_actor; v_id uuid;
BEGIN
  SELECT support_case_id INTO v_case FROM trustwork.case_access_grant WHERE id=p_grant;
  PERFORM trustwork.privacy_source_case(trustwork.current_person_id(),p_grant,p_field,v_case);
  v_actor:=trustwork.admin_authorize(p_ctx,ARRAY['admin.privacy.hold'],NULL,NULL);
  PERFORM 1 FROM trustwork.source WHERE id=(SELECT source_id FROM trustwork.sourced_record_field WHERE id=p_field) FOR UPDATE;
  INSERT INTO trustwork.privacy_source_hold(source_field_id,placed_by,reason_code,evidence_ref) VALUES(p_field,v_actor.person_id,p_reason,p_evidence) RETURNING id INTO v_id;
  PERFORM trustwork.admin_record(v_actor,p_ctx,NULL,NULL,'privacy.source_hold_placed','privacy_source_hold',v_id,NULL,jsonb_build_object('reason',p_reason),v_case);
  RETURN v_id;
END $$;
REVOKE EXECUTE ON FUNCTION trustwork.privacy_source_case(uuid,uuid,uuid,uuid),trustwork.privacy_source_snapshot(uuid),
  trustwork.privacy_source_plan_propose(jsonb,uuid,uuid),trustwork.privacy_source_plan_approve(jsonb,uuid,uuid,text),
  trustwork.privacy_source_plan_admit(jsonb,uuid,text),trustwork.sources_apply_privacy_resolution(uuid,text),trustwork.privacy_source_plan_execute(jsonb,uuid,text),
  trustwork.privacy_source_hold_place(jsonb,uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.privacy_source_plan_propose(jsonb,uuid,uuid),trustwork.privacy_source_plan_approve(jsonb,uuid,uuid,text),
  trustwork.privacy_source_plan_admit(jsonb,uuid,text),trustwork.privacy_source_plan_execute(jsonb,uuid,text),trustwork.privacy_source_hold_place(jsonb,uuid,uuid,text,uuid) TO trustwork_app;

CREATE TABLE trustwork.source_privacy_replay_receipt (
  request_id uuid PRIMARY KEY, source_field_id uuid NOT NULL, retained_digest text NOT NULL CHECK(retained_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE trustwork.source_privacy_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.source_privacy_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON trustwork.source_privacy_replay_receipt TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER source_privacy_replay_immutable BEFORE UPDATE OR DELETE ON trustwork.source_privacy_replay_receipt FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Owning restore command: available only to the fenced restore owner, never to API/worker roles.
CREATE FUNCTION trustwork.sources_replay_privacy_erasure(p_record jsonb,p_digest text) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE v_field trustwork.sourced_record_field%ROWTYPE; v_prior text; v_key text;
BEGIN
  PERFORM trustwork.privacy_lock_subject('company',(p_record->>'recordId')::uuid);
  PERFORM trustwork.privacy_lock_subject('person',(p_record->>'recordId')::uuid);
  PERFORM 1 FROM trustwork.source WHERE id=(p_record->>'sourceId')::uuid FOR UPDATE;
  SELECT * INTO v_field FROM trustwork.sourced_record_field WHERE id=(p_record->>'sourceFieldId')::uuid FOR UPDATE;
  IF EXISTS(SELECT 1 FROM trustwork.privacy_source_hold WHERE source_field_id=(p_record->>'sourceFieldId')::uuid)
    OR EXISTS(SELECT 1 FROM trustwork.legal_hold WHERE subject_id=(p_record->>'recordId')::uuid AND released_at IS NULL) THEN
    RAISE EXCEPTION 'source restore conflicts with legal hold' USING ERRCODE='42501',HINT='privacy.legal_hold';
  END IF;
  IF v_field.id IS NOT NULL AND (v_field.source_id IS DISTINCT FROM (p_record->>'sourceId')::uuid OR v_field.record_id IS DISTINCT FROM (p_record->>'recordId')::uuid
    OR v_field.record_kind IS DISTINCT FROM p_record->>'recordKind'
    OR trustwork.admin_digest(to_jsonb(v_field)-'active'-'deactivated_at'-'takedown_id') IS DISTINCT FROM p_record->>'evidenceDigest') THEN
    RAISE EXCEPTION 'source evidence changed' USING ERRCODE='40001',HINT='privacy.plan_changed';
  END IF;
  SELECT retained_digest INTO v_prior FROM trustwork.source_privacy_replay_receipt WHERE request_id=(p_record->>'requestId')::uuid;
  IF FOUND AND v_prior IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'retained decision conflicts' USING ERRCODE='23000'; END IF;
  v_key:=trustwork.privacy_source_key(p_record->>'recordKind',(p_record->>'recordId')::uuid);
  PERFORM trustwork.privacy_contact_lock(v_key);
  INSERT INTO trustwork.privacy_suppression(digest,marketing,do_not_collect) VALUES(v_key,false,true) ON CONFLICT(digest) DO UPDATE SET do_not_collect=true;
  UPDATE trustwork.sourced_record_field SET active=false,deactivated_at=clock_timestamp() WHERE id=v_field.id AND active;
  INSERT INTO trustwork.source_privacy_replay_receipt(request_id,source_field_id,retained_digest)
    VALUES((p_record->>'requestId')::uuid,(p_record->>'sourceFieldId')::uuid,p_digest) ON CONFLICT(request_id) DO NOTHING;
END $$;
REVOKE EXECUTE ON FUNCTION trustwork.sources_replay_privacy_erasure(jsonb,text) FROM PUBLIC;

-- Preserve the owning SRC public serializer, adding only the durable record-use barrier.
CREATE OR REPLACE FUNCTION trustwork.sources_public_provenance(p_hub uuid, p_kind text, p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT jsonb_build_object('recordKind', p_kind, 'recordId', p_record, 'label', 'sourced', 'fields', coalesce(jsonb_agg(jsonb_build_object(
      'field', f.field, 'value', f.value, 'observedAt', to_char(f.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'source', jsonb_build_object('name', s.name, 'attribution', s.attribution_template, 'url', s.url),
      'correction', CASE WHEN r.id IS NOT NULL THEN jsonb_build_object('kind','verified_subject_correction','at',r.created_at) ELSE NULL END) ORDER BY f.field, f.observed_at, f.id), '[]'::jsonb))
  FROM trustwork.sourced_record_field f
  LEFT JOIN trustwork.source_field_resolution r ON r.replacement_field_id=f.id
  JOIN trustwork.import_batch b ON b.id = f.import_batch_id AND b.status = 'activated'
  JOIN trustwork.source s ON s.id = f.source_id AND s.status IN ('active', 'paused', 'retired') AND trustwork.sources_use(s.allowed_uses, 'displayHeadlineAndLink')
  JOIN trustwork.hub h ON h.id = f.hub_id AND h.lifecycle IN ('soft_launch', 'public')
  WHERE f.hub_id = p_hub AND f.record_kind = p_kind AND f.record_id = p_record AND f.active
    AND NOT EXISTS(SELECT 1 FROM trustwork.privacy_suppression p WHERE p.digest = trustwork.privacy_source_key(f.record_kind, f.record_id) AND p.do_not_collect)
    AND trustwork.sources_use(b.licence_snapshot -> 'allowedUses', 'displayHeadlineAndLink')
    AND (f.source_item_id IS NULL OR EXISTS (SELECT 1 FROM trustwork.source_item i WHERE i.id = f.source_item_id
      AND trustwork.sources_use(trustwork.sources_effective_uses(i), 'displayHeadlineAndLink')))
$$;


-- A correction cannot be silently undone by importing the old value again. A new review is required.
CREATE OR REPLACE FUNCTION trustwork.privacy_source_activation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_key text;
BEGIN
  IF NEW.status='activated' AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR v_key IN SELECT DISTINCT trustwork.privacy_source_key(record_kind,record_id) FROM trustwork.sourced_record_field WHERE import_batch_id=NEW.id ORDER BY 1 LOOP
      PERFORM trustwork.privacy_contact_lock(v_key);
      IF EXISTS(SELECT 1 FROM trustwork.privacy_suppression WHERE digest=v_key AND do_not_collect) THEN
        RAISE EXCEPTION 'record activation blocked' USING ERRCODE='42501',HINT='privacy.do_not_collect';
      END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM trustwork.sourced_record_field pending JOIN trustwork.sourced_record_field original
      ON original.record_kind=pending.record_kind AND original.record_id=pending.record_id AND original.field=pending.field
      JOIN trustwork.source_field_resolution r ON r.source_field_id=original.id WHERE pending.import_batch_id=NEW.id) THEN
      RAISE EXCEPTION 'resolved field requires new review' USING ERRCODE='42501',HINT='privacy.source_review_required';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trustwork.privacy_source_collect_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_key text:=trustwork.privacy_source_key(NEW.record_kind,NEW.record_id);
BEGIN
  PERFORM trustwork.privacy_contact_lock(v_key);
  IF EXISTS(SELECT 1 FROM trustwork.privacy_suppression WHERE digest=v_key AND do_not_collect) THEN
    RAISE EXCEPTION 'record collection blocked' USING ERRCODE='42501',HINT='privacy.do_not_collect';
  END IF;
  IF NEW.id::text IS DISTINCT FROM current_setting('trustwork.source_resolution_field',true) AND EXISTS(SELECT 1 FROM trustwork.source_field_resolution r JOIN trustwork.sourced_record_field f ON f.id=r.source_field_id
    WHERE f.record_kind=NEW.record_kind AND f.record_id=NEW.record_id AND f.field=NEW.field) THEN
    RAISE EXCEPTION 'resolved field requires new review' USING ERRCODE='42501',HINT='privacy.source_review_required';
  END IF;
  RETURN NEW;
END $$;
