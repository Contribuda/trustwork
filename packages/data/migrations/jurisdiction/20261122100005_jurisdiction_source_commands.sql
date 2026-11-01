-- Explicit source-command permissions are opt-in released-role capabilities. No assignment is upgraded or seeded.
CREATE FUNCTION trustwork.jurisdiction_source_audit(a jsonb,ctx jsonb,action text,object_id uuid,before_image jsonb,after_image jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE actor trustwork.admin_actor;
BEGIN
 SELECT (a->>'personId')::uuid,r.role,r.breakglass,(a->>'elevationId')::uuid,a->>'permission' INTO actor
 FROM trustwork.staff_role_assignment r WHERE r.id=(a->>'assignmentId')::uuid;
 PERFORM 1 FROM trustwork.admin_sequence WHERE name='admin_audit_event' FOR UPDATE NOWAIT;
 PERFORM trustwork.admin_record(actor,ctx,NULL,(a->>'hubId')::uuid,action,'jurisdiction_source_decision',object_id,before_image,after_image);
 INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload)
 VALUES('jurisdiction_source_decision',object_id::text,1,action,jsonb_build_object('decisionId',object_id,'requestId',ctx->>'requestId'));
 IF NOT trustwork.jurisdiction_review_authority(a) THEN RAISE EXCEPTION 'current authority unavailable' USING ERRCODE='42501',HINT='admin.forbidden'; END IF;
END $$;
CREATE FUNCTION trustwork.jurisdiction_issuer_propose(p_session uuid,p_ctx jsonb,p_document jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE a jsonb; v trustwork.jurisdiction_issuer_version%ROWTYPE; next_version integer;
BEGIN
 PERFORM trustwork.jurisdiction_lock();
 a:=trustwork.jurisdiction_staff_snapshot(p_session,p_ctx,(p_document->>'hubId')::uuid,'admin.jurisdiction.issuers.propose');
 IF p_document->>'schemaVersion' IS DISTINCT FROM '2' OR p_document->>'evidenceMode' IS DISTINCT FROM 'synthetic'
  OR p_document->>'verifier' IS DISTINCT FROM 'synthetic-ed25519-v1' OR length(p_document->>'publicKey') NOT BETWEEN 32 AND 1024
  OR (p_document->>'effectiveUntil')::timestamptz<=clock_timestamp() OR (p_document->>'effectiveUntil')::timestamptz<=(p_document->>'effectiveFrom')::timestamptz
  OR p_document->'actions' IS DISTINCT FROM '["send_quote"]'::jsonb OR p_document->'contextKinds' IS DISTINCT FROM '["quote"]'::jsonb
  OR NOT (p_document->>'competenceDigest' ~ '^[a-f0-9]{64}$') OR NOT(p_document->>'implementationDigest' ~ '^[a-f0-9]{64}$')
  OR NOT(p_document->>'contractDigest' ~ '^[a-f0-9]{64}$') OR p_document->>'independence' NOT IN('not_required','required') THEN
   RAISE EXCEPTION 'invalid issuer registration' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM trustwork.jurisdiction_issuer_version WHERE issuer_id=(p_document->>'issuerId')::uuid AND hub_id<>(p_document->>'hubId')::uuid) THEN
  RAISE EXCEPTION 'issuer hub is immutable' USING ERRCODE='23514'; END IF;
 SELECT coalesce(max(version),0)+1 INTO next_version FROM trustwork.jurisdiction_issuer_version WHERE issuer_id=(p_document->>'issuerId')::uuid;
 INSERT INTO trustwork.jurisdiction_issuer_version(issuer_id,hub_id,version,document,digest,proposer)
 VALUES((p_document->>'issuerId')::uuid,(p_document->>'hubId')::uuid,next_version,p_document,trustwork.admin_digest(p_document),a) RETURNING * INTO v;
 PERFORM trustwork.jurisdiction_source_audit(a,p_ctx,'jurisdiction.issuer_proposed',v.id,NULL,to_jsonb(v));
 RETURN jsonb_build_object('id',v.id,'digest',v.digest,'state','pending_second_person');
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;
CREATE FUNCTION trustwork.jurisdiction_issuer_activate(p_session uuid,p_ctx jsonb,p_id uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v trustwork.jurisdiction_issuer_version%ROWTYPE; a jsonb; decision trustwork.jurisdiction_issuer_activation%ROWTYPE; before_head jsonb; after_head jsonb;
BEGIN
 PERFORM trustwork.jurisdiction_lock();
 SELECT * INTO v FROM trustwork.jurisdiction_issuer_version WHERE id=p_id;
 IF v.id IS NULL THEN RAISE EXCEPTION 'issuer unavailable' USING ERRCODE='42501',HINT='admin.forbidden'; END IF;
 a:=trustwork.jurisdiction_staff_snapshot(p_session,p_ctx,v.hub_id,'admin.jurisdiction.issuers.activate');
 IF a->>'personId'=v.proposer->>'personId' OR NOT trustwork.jurisdiction_review_authority(v.proposer) THEN
  RAISE EXCEPTION 'independent current proposer required' USING ERRCODE='42501',HINT='admin.forbidden'; END IF;
 IF p_digest IS DISTINCT FROM v.digest OR (v.document->>'effectiveFrom')::timestamptz>clock_timestamp()
  OR (v.document->>'effectiveUntil')::timestamptz<=clock_timestamp() OR EXISTS(SELECT 1 FROM trustwork.jurisdiction_issuer_revocation WHERE version_id=v.id) THEN
  RAISE EXCEPTION 'issuer unavailable' USING ERRCODE='23514'; END IF;
 SELECT to_jsonb(h) INTO before_head FROM trustwork.jurisdiction_issuer_current h WHERE issuer_id=v.issuer_id;
 INSERT INTO trustwork.jurisdiction_issuer_activation(version_id,reviewer) VALUES(v.id,a) RETURNING * INTO decision;
 INSERT INTO trustwork.jurisdiction_issuer_current(issuer_id,version_id,epoch) VALUES(v.issuer_id,v.id,1)
 ON CONFLICT(issuer_id) DO UPDATE SET version_id=excluded.version_id;
 SELECT to_jsonb(h) INTO after_head FROM trustwork.jurisdiction_issuer_current h WHERE issuer_id=v.issuer_id;
 PERFORM trustwork.jurisdiction_source_audit(a,p_ctx,'jurisdiction.issuer_activated',v.id,jsonb_build_object('head',before_head),jsonb_build_object('decision',to_jsonb(decision),'head',after_head));
 IF NOT trustwork.jurisdiction_issuer_live(v.id) THEN RAISE EXCEPTION 'issuer authority changed' USING ERRCODE='42501',HINT='admin.forbidden'; END IF;
 RETURN jsonb_build_object('id',v.id,'digest',v.digest,'state','active');
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;
CREATE FUNCTION trustwork.jurisdiction_source_revoke(p_session uuid,p_ctx jsonb,p_kind text,p_id uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v trustwork.jurisdiction_issuer_version%ROWTYPE; r trustwork.jurisdiction_proof_record%ROWTYPE; a jsonb; material jsonb; digest text;
BEGIN
 PERFORM trustwork.jurisdiction_lock();
 IF p_kind='issuer' THEN SELECT * INTO v FROM trustwork.jurisdiction_issuer_version WHERE id=p_id; digest:=v.digest;
 ELSIF p_kind='source' THEN
  SELECT * INTO r FROM trustwork.jurisdiction_proof_record WHERE id=p_id;
  SELECT * INTO v FROM trustwork.jurisdiction_issuer_version WHERE id=r.issuer_version_id; digest:=r.digest;
 ELSE RAISE EXCEPTION 'unknown revocation kind' USING ERRCODE='23514'; END IF;
 IF v.id IS NULL THEN RAISE EXCEPTION 'source unavailable' USING ERRCODE='42501',HINT='admin.forbidden'; END IF;
 a:=trustwork.jurisdiction_staff_snapshot(p_session,p_ctx,v.hub_id,'admin.jurisdiction.sources.revoke');
 IF p_digest IS DISTINCT FROM digest THEN RAISE EXCEPTION 'exact source digest required' USING ERRCODE='23514'; END IF;
 IF p_kind='issuer' THEN
  INSERT INTO trustwork.jurisdiction_issuer_revocation(version_id,authority) VALUES(p_id,a) RETURNING to_jsonb(jurisdiction_issuer_revocation.*) INTO material;
 ELSE
  INSERT INTO trustwork.jurisdiction_proof_revocation(source_id,authority) VALUES(p_id,a) RETURNING to_jsonb(jurisdiction_proof_revocation.*) INTO material;
 END IF;
 PERFORM trustwork.jurisdiction_source_audit(a,p_ctx,'jurisdiction.'||p_kind||'_revoked',p_id,NULL,material);
 RETURN jsonb_build_object('id',p_id,'digest',digest,'state','revoked');
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.jurisdiction_issuer_propose(uuid,jsonb,jsonb),trustwork.jurisdiction_issuer_activate(uuid,jsonb,uuid,text),trustwork.jurisdiction_source_revoke(uuid,jsonb,text,uuid,text) TO trustwork_app;
