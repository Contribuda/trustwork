-- HUB-005 v2 consumes only authenticated owning proof origins. Legacy global heads remain audit-only.
CREATE FUNCTION trustwork.jurisdiction_review_head(p_evidence uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE d jsonb; e jsonb; result jsonb;
BEGIN
 SELECT r.document INTO d FROM trustwork.jurisdiction_applicability_origin o JOIN trustwork.jurisdiction_proof_record r ON r.id=o.source_id WHERE o.evidence_id=p_evidence;
 IF d IS NOT NULL THEN
  SELECT to_jsonb(h) INTO result FROM trustwork.jurisdiction_scoped_head h WHERE hub_id=(d->>'originHubId')::uuid
   AND subject_kind=d->'subject'->>'kind' AND subject_id=(d->'subject'->>'id')::uuid
   AND action=d->>'action' AND context_kind=d->'context'->>'kind' AND context_id=(d->'context'->>'id')::uuid;
 ELSE
  SELECT document INTO e FROM trustwork.jurisdiction_applicability WHERE id=p_evidence;
  SELECT to_jsonb(h) INTO result FROM trustwork.jurisdiction_applicability_current h WHERE subject_kind=e->>'subjectKind' AND subject_id=(e->>'subjectId')::uuid;
 END IF;
 RETURN result;
END $$;
CREATE FUNCTION trustwork.jurisdiction_review_source(p_evidence uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE source uuid;
BEGIN
 SELECT source_id INTO source FROM trustwork.jurisdiction_applicability_origin WHERE evidence_id=p_evidence;
 -- Old review records retain their audit semantics but never enter v2 consumption.
 RETURN source IS NULL OR trustwork.jurisdiction_proof_live(source);
END $$;
CREATE FUNCTION trustwork.jurisdiction_scoped_evidence(p_kind text,p_subject uuid,p_quote uuid)
RETURNS TABLE(id uuid,document jsonb,digest text,revision integer,source_digest text,source_revision integer,issuer_epoch integer)
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE h trustwork.jurisdiction_scoped_head%ROWTYPE; r trustwork.jurisdiction_proof_record%ROWTYPE; candidate_count integer;
BEGIN
 PERFORM trustwork.jurisdiction_lock();
 SELECT count(*) INTO candidate_count FROM trustwork.jurisdiction_scoped_head x WHERE x.subject_kind=p_kind AND x.subject_id=p_subject AND x.context_kind='quote' AND x.context_id=p_quote AND x.action='send_quote';
 IF candidate_count<>1 THEN RETURN; END IF;
 SELECT * INTO h FROM trustwork.jurisdiction_scoped_head x WHERE x.subject_kind=p_kind AND x.subject_id=p_subject AND x.context_kind='quote' AND x.context_id=p_quote AND x.action='send_quote';
 SELECT pr.* INTO r FROM trustwork.jurisdiction_applicability_origin o JOIN trustwork.jurisdiction_proof_record pr ON pr.id=o.source_id WHERE o.evidence_id=h.applicability_id;
 IF NOT trustwork.jurisdiction_proof_live(r.id) THEN RETURN; END IF;
 -- An additional currently authentic contradictory source poisons the scope, even before a reviewer selects it.
 IF EXISTS(SELECT 1 FROM trustwork.jurisdiction_proof_record other JOIN trustwork.jurisdiction_proof_current pc ON pc.source_id=other.id
   WHERE other.document->'subject'->>'kind'=p_kind AND other.document->'subject'->>'id'=p_subject::text
    AND other.document->'context'->>'id'=p_quote::text AND other.document->>'action'='send_quote'
    AND other.id<>r.id AND trustwork.jurisdiction_proof_live(other.id)
    AND (other.document->>'originHubId' IS DISTINCT FROM r.document->>'originHubId'
      OR NOT ((other.document->'coverage'->'jurisdictions') @> (r.document->'coverage'->'jurisdictions') AND (other.document->'coverage'->'jurisdictions') <@ (r.document->'coverage'->'jurisdictions')))) THEN RETURN; END IF;
 RETURN QUERY SELECT a.id,a.document,a.digest,h.revision,r.digest,pc.revision,ic.epoch
  FROM trustwork.jurisdiction_applicability a JOIN trustwork.jurisdiction_proof_current pc ON pc.source_id=r.id
  JOIN trustwork.jurisdiction_issuer_current ic ON ic.version_id=r.issuer_version_id WHERE a.id=h.applicability_id;
END $$;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_applicability_propose(p_session uuid,p_ctx jsonb,p_evidence uuid,p_digest text) RETURNS jsonb
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
  SELECT (trustwork.jurisdiction_review_head(e.id)->>'revision')::integer INTO rev;
  IF NOT trustwork.jurisdiction_review_source(e.id) THEN RAISE EXCEPTION 'source unavailable' USING ERRCODE='23514'; END IF;
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
  IF NOT trustwork.jurisdiction_review_source(e.id) THEN RAISE EXCEPTION 'source expired before commit' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('reviewId',result.id,'evidenceDigest',e.digest,'state','pending_second_person');
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;
CREATE OR REPLACE FUNCTION trustwork.jurisdiction_applicability_activate(p_session uuid,p_ctx jsonb,p_review uuid,p_digest text) RETURNS jsonb
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
  SELECT (trustwork.jurisdiction_review_head(e.id)->>'revision')::integer INTO rev;
  IF NOT trustwork.jurisdiction_review_source(e.id) THEN RAISE EXCEPTION 'source unavailable' USING ERRCODE='23514'; END IF;
  IF p_digest IS DISTINCT FROM e.digest OR e.digest<>review.evidence_digest OR coalesce(rev,0)<>review.previous_revision
    OR (e.document->>'effectiveFrom')::timestamptz>clock_timestamp() OR (e.document->>'effectiveUntil')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'applicability evidence or current head changed' USING ERRCODE='23514';
  END IF;
  IF NOT trustwork.jurisdiction_review_authority(a) THEN RAISE EXCEPTION 'reviewer authority changed' USING ERRCODE='42501'; END IF;
  previous_head:=trustwork.jurisdiction_review_head(e.id);
  INSERT INTO trustwork.jurisdiction_applicability_activation(review_id,reviewer) VALUES(review.id,a) RETURNING * INTO activation;
  IF EXISTS(SELECT 1 FROM trustwork.jurisdiction_applicability_origin WHERE evidence_id=e.id) THEN
    INSERT INTO trustwork.jurisdiction_scoped_head(hub_id,subject_kind,subject_id,action,context_kind,context_id,applicability_id,revision)
      SELECT (r.document->>'originHubId')::uuid,r.document->'subject'->>'kind',(r.document->'subject'->>'id')::uuid,r.document->>'action',
        r.document->'context'->>'kind',(r.document->'context'->>'id')::uuid,e.id,1
      FROM trustwork.jurisdiction_applicability_origin o JOIN trustwork.jurisdiction_proof_record r ON r.id=o.source_id WHERE o.evidence_id=e.id
      ON CONFLICT(hub_id,subject_kind,subject_id,action,context_kind,context_id) DO UPDATE SET applicability_id=excluded.applicability_id;
  ELSE
    INSERT INTO trustwork.jurisdiction_applicability_current(subject_kind,subject_id,applicability_id)
    VALUES(e.document->>'subjectKind',(e.document->>'subjectId')::uuid,e.id)
    ON CONFLICT(subject_kind,subject_id) DO UPDATE SET applicability_id=excluded.applicability_id;
  END IF;
  current_head:=trustwork.jurisdiction_review_head(e.id);
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
  IF NOT trustwork.jurisdiction_review_source(e.id) THEN RAISE EXCEPTION 'source expired before commit' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('reviewId',review.id,'evidenceDigest',e.digest,'state','active');
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_resolve_quote(p_quote uuid, p_action text, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE
  q trustwork.quote%ROWTYPE; project_id uuid; subjects jsonb; subject jsonb; att record;
  cfg trustwork.hub_config_version%ROWTYPE; src trustwork.jurisdiction_source%ROWTYPE; s jsonb; rule jsonb; r jsonb; prev jsonb;
  queue text[]; seen text[]; j text; h uuid; primary_hub uuid; locales text[]; liability text;
  consent jsonb := '[]'; retention jsonb := '{}'; thresholds jsonb := '{}'; approval text := 'pre_authorized';
  evidence jsonb := '[]'; versions jsonb := '[]'; result jsonb; n integer := 0; mn numeric; mx numeric; currency text;
  unknown_result jsonb := '{"status":"unknown","reasons":["jurisdiction_unavailable"],"bindingDigest":null,"versions":[],"hubId":null,"approval":"human_only","approvalAbove":[],"consentRequirements":[],"recordKeeping":[],"liabilityAllocationKey":null}';
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  IF p_actor IS NULL OR p_action <> 'send_quote' THEN RETURN unknown_result; END IF;
  SELECT * INTO q FROM trustwork.quote WHERE id=p_quote FOR SHARE;
  IF NOT FOUND THEN RETURN unknown_result; END IF;
  PERFORM 1 FROM trustwork.rfq WHERE id=q.rfq_id FOR SHARE;
  SELECT r.project_id INTO project_id FROM trustwork.rfq r WHERE r.id=q.rfq_id;
  IF project_id IS NULL THEN RETURN unknown_result; END IF;
  PERFORM 1 FROM trustwork.project p WHERE p.id=project_id FOR SHARE;
  SELECT jsonb_build_array(jsonb_build_object('project',p.id,'revision',p.revision,'ownerPerson',p.owner_person_id,'ownerCompany',p.owner_company_id,'status',p.status,'quoteRevision',q.revision,'rfqRevision',r.revision)) INTO evidence
    FROM trustwork.project p JOIN trustwork.rfq r ON r.project_id=p.id WHERE r.id=q.rfq_id;
  subjects := jsonb_build_array(
    jsonb_build_object('kind','person','id',p_actor),
    jsonb_build_object('kind',CASE WHEN q.seller_person_id IS NULL THEN 'company' ELSE 'person' END,'id',coalesce(q.seller_person_id,q.seller_company_id)),
    jsonb_build_object('kind',CASE WHEN q.buyer_person_id IS NULL THEN 'company' ELSE 'person' END,'id',coalesce(q.buyer_person_id,q.buyer_company_id)),
    jsonb_build_object('kind','project','id',project_id));
  FOR subject IN SELECT DISTINCT value FROM jsonb_array_elements(subjects) ORDER BY value LOOP
    SELECT * INTO att FROM trustwork.jurisdiction_scoped_evidence(subject->>'kind',(subject->>'id')::uuid,p_quote);
    IF NOT FOUND OR (att.document->>'effectiveFrom')::timestamptz > clock_timestamp() OR (att.document->>'effectiveUntil')::timestamptz <= clock_timestamp() THEN RETURN unknown_result; END IF;
    h := (att.document->>'hubId')::uuid;
    IF subject->>'kind'='project' THEN primary_hub:=h; END IF;
    SELECT v.* INTO cfg FROM trustwork.hub_config_current c JOIN trustwork.hub_config_version v ON v.id=c.version_id
      WHERE c.hub_id=h AND c.domain='jurisdiction' AND v.status='active' AND v.effective_from<=clock_timestamp();
    IF NOT FOUND THEN RETURN unknown_result; END IF;
    SELECT hp.locales INTO locales FROM trustwork.hub_profile hp WHERE hp.hub_id=h;
    PERFORM trustwork.jurisdiction_validate(h,cfg.payload,locales);
    evidence := evidence || jsonb_build_array(jsonb_build_object('applicability',att.digest,'applicabilityRevision',att.revision,'sourceProof',att.source_digest,'sourceRevision',att.source_revision,'issuerEpoch',att.issuer_epoch,'config',cfg.payload_digest,'locales',locales));
    versions := versions || jsonb_build_array(jsonb_build_object('id',cfg.id,'digest',cfg.payload_digest));
    SELECT array_agg(value ORDER BY value) INTO queue FROM jsonb_array_elements_text(att.document->'jurisdictions');
    seen := ARRAY[]::text[];
    WHILE cardinality(queue)>0 LOOP
      j:=queue[1]; queue:=queue[2:];
      IF j=ANY(seen) THEN CONTINUE; END IF;
      seen:=array_append(seen,j); n:=n+1;
      IF n>200 THEN RETURN unknown_result; END IF;
      SELECT value INTO s FROM jsonb_array_elements(cfg.payload->'agentSettings'->'jurisdictions') WHERE value->>'jurisdiction'=j;
      IF s IS NULL THEN RETURN unknown_result; END IF;
      SELECT * INTO src FROM trustwork.jurisdiction_source WHERE id=(s->>'sourceId')::uuid;
      SELECT queue || coalesce(array_agg(value ORDER BY value),ARRAY[]::text[]) INTO queue FROM jsonb_array_elements_text(src.document->'ancestors');
      SELECT value INTO rule FROM jsonb_array_elements(s->'policy'->'actionLimits') WHERE value->>'action'=p_action;
      IF rule IS NULL THEN RETURN unknown_result; END IF;
      IF liability IS NOT NULL AND liability IS DISTINCT FROM s->'policy'->>'liabilityAllocationKey' THEN RETURN unknown_result; END IF;
      liability:=s->'policy'->>'liabilityAllocationKey';
      consent:=consent || (s->'policy'->'consentRequirements');
      IF array_position(ARRAY['pre_authorized','ask_each','human_only'],rule->>'approval') > array_position(ARRAY['pre_authorized','ask_each','human_only'],approval) THEN approval:=rule->>'approval'; END IF;
      IF rule->'approvalAbove'<>'null' THEN
        currency:=rule->'approvalAbove'->>'currency';
        thresholds:=jsonb_set(thresholds,ARRAY[currency],to_jsonb(least((thresholds->>currency)::numeric,(rule->'approvalAbove'->>'minorUnits')::numeric)::text));
      END IF;
      FOR r IN SELECT value FROM jsonb_array_elements(s->'policy'->'recordKeeping') LOOP
        prev:=retention->(r->>'recordClass');
        mn:=greatest((prev->>'minimumDays')::numeric,(r->>'minimumDays')::numeric);
        mx:=least((prev->>'maximumDays')::numeric,(r->>'maximumDays')::numeric);
        IF mn>mx THEN RETURN unknown_result; END IF;
        retention:=jsonb_set(retention,ARRAY[r->>'recordClass'],jsonb_build_object('recordClass',r->>'recordClass','minimumDays',mn,'maximumDays',mx));
      END LOOP;
    END LOOP;
  END LOOP;
  result:=jsonb_build_object('status','resolved','reasons','[]'::jsonb,'hubId',primary_hub,'approval',approval,
    'versions',(SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') FROM (SELECT DISTINCT value v FROM jsonb_array_elements(versions)) u),
    'approvalAbove',(SELECT coalesce(jsonb_agg(jsonb_build_object('currency',key,'minorUnits',value) ORDER BY key),'[]') FROM jsonb_each_text(thresholds)),
    'consentRequirements',(SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') FROM (SELECT DISTINCT value v FROM jsonb_array_elements(consent)) u),
    'recordKeeping',(SELECT coalesce(jsonb_agg(value ORDER BY key),'[]') FROM jsonb_each(retention)),
    'liabilityAllocationKey',liability);
  FOR subject IN SELECT DISTINCT value FROM jsonb_array_elements(subjects) LOOP
    IF NOT EXISTS(SELECT 1 FROM trustwork.jurisdiction_scoped_evidence(subject->>'kind',(subject->>'id')::uuid,p_quote)) THEN RETURN unknown_result; END IF;
  END LOOP;
  RETURN result || jsonb_build_object('bindingDigest',trustwork.admin_digest(jsonb_build_object('kind','jurisdiction-binding-3','quote',p_quote,'action',p_action,'actor',p_actor,'evidence',evidence,'limits',result)));
EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN unknown_result;
END $$;


CREATE OR REPLACE FUNCTION trustwork.jurisdiction_quote_scopes(p_quote uuid,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE q trustwork.quote%ROWTYPE; project uuid; subjects jsonb; subject jsonb; att jsonb;
  queue text[]; seen text[]; j text; n integer:=0; result jsonb:='[]'; ancestors jsonb;
BEGIN
  SELECT * INTO q FROM trustwork.quote WHERE id=p_quote;
  SELECT project_id INTO project FROM trustwork.rfq WHERE id=q.rfq_id;
  subjects:=jsonb_build_array(jsonb_build_object('kind','person','id',p_actor),
    jsonb_build_object('kind',CASE WHEN q.seller_person_id IS NULL THEN 'company' ELSE 'person' END,'id',coalesce(q.seller_person_id,q.seller_company_id)),
    jsonb_build_object('kind',CASE WHEN q.buyer_person_id IS NULL THEN 'company' ELSE 'person' END,'id',coalesce(q.buyer_person_id,q.buyer_company_id)),
    jsonb_build_object('kind','project','id',project));
  FOR subject IN SELECT DISTINCT value FROM jsonb_array_elements(subjects) LOOP
    SELECT a.document INTO att FROM trustwork.jurisdiction_scoped_evidence(subject->>'kind',(subject->>'id')::uuid,p_quote) a;
    IF att IS NULL THEN RETURN NULL; END IF;
    SELECT array_agg(value) INTO queue FROM jsonb_array_elements_text(att->'jurisdictions');
    seen:=ARRAY[]::text[];
    WHILE cardinality(queue)>0 LOOP
      j:=queue[1]; queue:=queue[2:];
      IF j=ANY(seen) THEN CONTINUE; END IF;
      seen:=array_append(seen,j); n:=n+1;
      IF n>200 THEN RETURN NULL; END IF;
      result:=result||jsonb_build_array(jsonb_build_object('hubId',att->>'hubId','jurisdiction',j));
      SELECT src.document->'ancestors' INTO ancestors FROM trustwork.jurisdiction_source src JOIN trustwork.jurisdiction_source_current c ON c.source_id=src.id WHERE c.jurisdiction=j;
      IF ancestors IS NULL THEN RETURN NULL; END IF;
      SELECT queue||coalesce(array_agg(value),ARRAY[]::text[]) INTO queue FROM jsonb_array_elements_text(ancestors);
    END LOOP;
  END LOOP;
  RETURN result;
END $$;


REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
