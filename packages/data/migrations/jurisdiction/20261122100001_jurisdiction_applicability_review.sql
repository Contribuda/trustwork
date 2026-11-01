-- HUB-005 owning review of immutable evidence staged by an authorized maintenance/domain importer.
-- HTTP accepts only stored evidence IDs/digests; no participant hub/country/company/location assertion is evidence.
CREATE TABLE trustwork.jurisdiction_applicability_review (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  evidence_id uuid NOT NULL REFERENCES trustwork.jurisdiction_applicability(id),
  evidence_digest text NOT NULL,
  previous_revision integer NOT NULL,
  proposer jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE trustwork.jurisdiction_applicability_activation (
  review_id uuid PRIMARY KEY REFERENCES trustwork.jurisdiction_applicability_review(id),
  reviewer jsonb NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trustwork.jurisdiction_applicability_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_applicability_review FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_applicability_review FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
ALTER TABLE trustwork.jurisdiction_applicability_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_applicability_activation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_applicability_activation FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_review_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_applicability_review FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER jurisdiction_activation_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_applicability_activation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER jurisdiction_review_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_applicability_review FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER jurisdiction_activation_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_applicability_activation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT ON trustwork.jurisdiction_applicability_review FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT ON trustwork.jurisdiction_applicability_activation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();

-- Validate the exact stored authorization, including its original session/elevation and role assignment, at the
-- serialization point. A different session of the same person or a replacement role never rescues a stale review.
CREATE FUNCTION trustwork.jurisdiction_review_authority(a jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE epoch integer; sess trustwork.session%ROWTYPE; e trustwork.session_elevation%ROWTYPE; r record;
BEGIN
  SELECT authz_epoch INTO epoch FROM trustwork.person WHERE id=(a->>'personId')::uuid FOR SHARE NOWAIT;
  SELECT * INTO sess FROM trustwork.session WHERE id=(a->>'sessionId')::uuid FOR SHARE NOWAIT;
  SELECT * INTO e FROM trustwork.session_elevation WHERE id=(a->>'elevationId')::uuid FOR SHARE NOWAIT;
  SELECT x.*,d.permissions,d.scopes INTO r FROM trustwork.staff_role_assignment x JOIN trustwork.staff_role_definition_version d ON d.role=x.role AND d.version=x.definition_version
    WHERE x.id=(a->>'assignmentId')::uuid FOR SHARE OF x,d NOWAIT;
  RETURN coalesce(epoch=(a->>'epoch')::integer AND sess.person_id=(a->>'personId')::uuid AND sess.revoked_at IS NULL
    AND sess.idle_expires_at>clock_timestamp() AND sess.absolute_expires_at>clock_timestamp()
    AND e.session_id=sess.id AND e.person_id=sess.person_id AND e.revoked_at IS NULL AND e.expires_at>clock_timestamp()
    AND r.person_id=sess.person_id AND r.revoked_at IS NULL AND r.valid_from<=clock_timestamp() AND (r.valid_until IS NULL OR r.valid_until>clock_timestamp())
    AND r.definition_version=(a->>'definitionVersion')::integer AND a->>'permission'=ANY(r.permissions) AND r.scope_kind=ANY(r.scopes)
    AND (r.scope_kind IN ('platform','node') OR (r.scope_kind='hub' AND r.hub_id=(a->>'hubId')::uuid)),false);
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;
CREATE FUNCTION trustwork.jurisdiction_staff_snapshot(p_session uuid,p_ctx jsonb,p_hub uuid,p_permission text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE actor uuid; grant_row record; snapshot jsonb; authorized trustwork.admin_actor;
BEGIN
  actor:=trustwork.jurisdiction_require_actor(p_session);
  authorized:=trustwork.admin_authorize(p_ctx,ARRAY[p_permission],NULL,p_hub);
  SELECT a.id,a.definition_version INTO grant_row FROM trustwork.staff_role_assignment a JOIN trustwork.staff_role_definition_version d ON d.role=a.role AND d.version=a.definition_version
    WHERE a.person_id=actor AND a.role=authorized.role AND a.breakglass=authorized.breakglass AND a.revoked_at IS NULL AND a.valid_from<=clock_timestamp() AND (a.valid_until IS NULL OR a.valid_until>clock_timestamp())
      AND p_permission=ANY(d.permissions) AND a.scope_kind=ANY(d.scopes)
      AND (a.scope_kind IN ('platform','node') OR (a.scope_kind='hub' AND a.hub_id=p_hub)) ORDER BY a.valid_from,a.id LIMIT 1;
  snapshot:=jsonb_build_object('personId',actor,'epoch',trustwork.current_authz_epoch(),'sessionId',p_session,'elevationId',p_ctx->>'elevationId',
    'assignmentId',grant_row.id,'definitionVersion',grant_row.definition_version,'permission',p_permission,'hubId',p_hub);
  IF NOT trustwork.jurisdiction_review_authority(snapshot) THEN RAISE EXCEPTION 'current exact staff authority required' USING ERRCODE='42501'; END IF;
  RETURN snapshot;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;

CREATE FUNCTION trustwork.jurisdiction_applicability_propose(p_session uuid,p_ctx jsonb,p_evidence uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE e trustwork.jurisdiction_applicability%ROWTYPE; a jsonb; rev integer; result trustwork.jurisdiction_applicability_review%ROWTYPE; actor trustwork.admin_actor;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO e FROM trustwork.jurisdiction_applicability WHERE id=p_evidence;
  IF e.id IS NULL THEN RAISE EXCEPTION 'evidence unavailable' USING ERRCODE='42501'; END IF;
  a:=trustwork.jurisdiction_staff_snapshot(p_session,p_ctx,(e.document->>'hubId')::uuid,'admin.hub.jurisdiction.edit');
  IF e.digest IS DISTINCT FROM p_digest OR (e.document->>'effectiveUntil')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'exact unexpired evidence required' USING ERRCODE='23514';
  END IF;
  SELECT revision INTO rev FROM trustwork.jurisdiction_applicability_current WHERE subject_kind=e.document->>'subjectKind' AND subject_id=(e.document->>'subjectId')::uuid;
  INSERT INTO trustwork.jurisdiction_applicability_review(evidence_id,evidence_digest,previous_revision,proposer) VALUES(e.id,e.digest,coalesce(rev,0),a) RETURNING * INTO result;
  -- Record the exact assignment already authorized and locked, not a newly resolved alternate grant.
  SELECT (a->>'personId')::uuid,r.role,r.breakglass,(a->>'elevationId')::uuid,a->>'permission'
    INTO actor FROM trustwork.staff_role_assignment r WHERE r.id=(a->>'assignmentId')::uuid;
  -- The shared audit stores only exact row digests. Evidence and the affected person never become an audit payload.
  PERFORM 1 FROM trustwork.admin_sequence WHERE name='admin_audit_event' FOR UPDATE NOWAIT;
  PERFORM trustwork.admin_record(actor,p_ctx,NULL,(a->>'hubId')::uuid,'jurisdiction.applicability_proposed',
    'jurisdiction_applicability_review',result.id,NULL,to_jsonb(result));
  INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload)
    VALUES('jurisdiction_applicability_review',result.id::text,1,'jurisdiction.applicability_proposed',
      jsonb_build_object('reviewId',result.id,'requestId',p_ctx->>'requestId'));
  IF NOT trustwork.jurisdiction_review_authority(a) THEN RAISE EXCEPTION 'authority expired before commit' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('reviewId',result.id,'evidenceDigest',e.digest,'state','pending_second_person');
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;
CREATE FUNCTION trustwork.jurisdiction_applicability_activate(p_session uuid,p_ctx jsonb,p_review uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE review trustwork.jurisdiction_applicability_review%ROWTYPE; e trustwork.jurisdiction_applicability%ROWTYPE; a jsonb; rev integer;
  actor trustwork.admin_actor; activation trustwork.jurisdiction_applicability_activation%ROWTYPE;
  previous_head jsonb; current_head jsonb;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO review FROM trustwork.jurisdiction_applicability_review WHERE id=p_review;
  SELECT * INTO e FROM trustwork.jurisdiction_applicability WHERE id=review.evidence_id;
  IF e.id IS NULL THEN RAISE EXCEPTION 'review unavailable' USING ERRCODE='42501'; END IF;
  a:=trustwork.jurisdiction_staff_snapshot(p_session,p_ctx,(e.document->>'hubId')::uuid,'admin.hub.jurisdiction.activate');
  IF a->>'personId'=review.proposer->>'personId' OR NOT trustwork.jurisdiction_review_authority(review.proposer) THEN
    RAISE EXCEPTION 'independent current review required' USING ERRCODE='42501';
  END IF;
  SELECT revision INTO rev FROM trustwork.jurisdiction_applicability_current WHERE subject_kind=e.document->>'subjectKind' AND subject_id=(e.document->>'subjectId')::uuid;
  IF p_digest IS DISTINCT FROM e.digest OR e.digest<>review.evidence_digest OR coalesce(rev,0)<>review.previous_revision
    OR (e.document->>'effectiveFrom')::timestamptz>clock_timestamp() OR (e.document->>'effectiveUntil')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'applicability evidence or current head changed' USING ERRCODE='23514';
  END IF;
  IF NOT trustwork.jurisdiction_review_authority(a) THEN RAISE EXCEPTION 'reviewer authority changed' USING ERRCODE='42501'; END IF;
  SELECT to_jsonb(h) INTO previous_head FROM trustwork.jurisdiction_applicability_current h
    WHERE subject_kind=e.document->>'subjectKind' AND subject_id=(e.document->>'subjectId')::uuid;
  INSERT INTO trustwork.jurisdiction_applicability_activation(review_id,reviewer) VALUES(review.id,a) RETURNING * INTO activation;
  INSERT INTO trustwork.jurisdiction_applicability_current(subject_kind,subject_id,applicability_id)
    VALUES(e.document->>'subjectKind',(e.document->>'subjectId')::uuid,e.id)
    ON CONFLICT(subject_kind,subject_id) DO UPDATE SET applicability_id=excluded.applicability_id;
  SELECT to_jsonb(h) INTO current_head FROM trustwork.jurisdiction_applicability_current h
    WHERE subject_kind=e.document->>'subjectKind' AND subject_id=(e.document->>'subjectId')::uuid;
  -- Record the exact assignment already authorized and locked, not a newly resolved alternate grant.
  SELECT (a->>'personId')::uuid,r.role,r.breakglass,(a->>'elevationId')::uuid,a->>'permission'
    INTO actor FROM trustwork.staff_role_assignment r WHERE r.id=(a->>'assignmentId')::uuid;
  PERFORM 1 FROM trustwork.admin_sequence WHERE name='admin_audit_event' FOR UPDATE NOWAIT;
  -- The independent decision is this immutable HUB review, not a fabricated ADM second_person_approval.
  -- Exact before/after images bind it and the current head without disclosing either private row.
  PERFORM trustwork.admin_record(actor,p_ctx,NULL,(a->>'hubId')::uuid,'jurisdiction.applicability_activated',
    'jurisdiction_applicability_review',review.id,
    jsonb_build_object('review',to_jsonb(review),'activation',NULL,'head',previous_head),
    jsonb_build_object('review',to_jsonb(review),'activation',to_jsonb(activation),'head',current_head));
  INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload)
    VALUES('jurisdiction_applicability_review',review.id::text,2,'jurisdiction.applicability_activated',
      jsonb_build_object('reviewId',review.id,'requestId',p_ctx->>'requestId'));
  IF NOT trustwork.jurisdiction_review_authority(a) OR NOT trustwork.jurisdiction_review_authority(review.proposer) THEN
    RAISE EXCEPTION 'authority expired before commit' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('reviewId',review.id,'evidenceDigest',e.digest,'state','active');
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.jurisdiction_applicability_propose(uuid,jsonb,uuid,text),trustwork.jurisdiction_applicability_activate(uuid,jsonb,uuid,text) TO trustwork_app;
