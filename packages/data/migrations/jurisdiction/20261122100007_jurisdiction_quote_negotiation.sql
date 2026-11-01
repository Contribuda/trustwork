-- Read-only owner resolution for the current-version buyer amendment path. No commerce mutation or dispatch authority.
-- Previously stored proof snapshots are not backfilled; changed snapshot/contract requires fresh signed evidence and review.
ALTER TABLE trustwork.jurisdiction_scoped_head DROP CONSTRAINT jurisdiction_scoped_head_action_check;
ALTER TABLE trustwork.jurisdiction_scoped_head ADD CONSTRAINT jurisdiction_scoped_head_action_check CHECK(action IN('send_quote','negotiate','place_order'));

CREATE FUNCTION trustwork.jurisdiction_issuer_document_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
BEGIN
 RETURN coalesce(jsonb_typeof(p)='object' AND (SELECT count(*) FROM jsonb_object_keys(p))=17
  AND p ?& ARRAY['schemaVersion','issuerId','hubId','verifier','implementationDigest','contractDigest','keyId','publicKey','evidenceMode',
    'subjectKinds','actions','contextKinds','jurisdictions','competenceDigest','independence','effectiveFrom','effectiveUntil']
  AND p->>'schemaVersion'='2' AND p->>'evidenceMode'='synthetic' AND p->>'verifier'='synthetic-ed25519-v1'
  AND (p->>'keyId') ~ '^[a-z][A-Za-z0-9_.-]{1,120}$' AND length(p->>'publicKey') BETWEEN 32 AND 1024
  AND (p->>'competenceDigest') ~ '^[a-f0-9]{64}$' AND (p->>'implementationDigest') ~ '^[a-f0-9]{64}$' AND (p->>'contractDigest') ~ '^[a-f0-9]{64}$'
  AND p->>'independence' IN('required','not_required') AND p->'contextKinds'='["quote"]'::jsonb
  AND jsonb_array_length(p->'actions') BETWEEN 1 AND 3 AND p->'actions' <@ '["send_quote","negotiate","place_order"]'::jsonb
  AND (SELECT count(DISTINCT value) FROM jsonb_array_elements(p->'actions'))=jsonb_array_length(p->'actions')
  AND jsonb_array_length(p->'subjectKinds') BETWEEN 1 AND 3 AND p->'subjectKinds' <@ '["person","company","project"]'::jsonb
  AND (SELECT count(DISTINCT value) FROM jsonb_array_elements(p->'subjectKinds'))=jsonb_array_length(p->'subjectKinds')
  AND jsonb_array_length(p->'jurisdictions') BETWEEN 1 AND 20
  AND (SELECT count(DISTINCT value) FROM jsonb_array_elements(p->'jurisdictions'))=jsonb_array_length(p->'jurisdictions')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'jurisdictions') j WHERE j !~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$')
  AND (p->>'effectiveUntil')::timestamptz>clock_timestamp() AND (p->>'effectiveUntil')::timestamptz>(p->>'effectiveFrom')::timestamptz,false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_issuer_propose(p_session uuid,p_ctx jsonb,p_document jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE a jsonb; v trustwork.jurisdiction_issuer_version%ROWTYPE; next_version integer;
BEGIN
 PERFORM trustwork.jurisdiction_lock();
 a:=trustwork.jurisdiction_staff_snapshot(p_session,p_ctx,(p_document->>'hubId')::uuid,'admin.jurisdiction.issuers.propose');
 IF NOT trustwork.jurisdiction_issuer_document_valid(p_document) THEN RAISE EXCEPTION 'invalid issuer registration' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM trustwork.jurisdiction_issuer_version WHERE issuer_id=(p_document->>'issuerId')::uuid AND hub_id<>(p_document->>'hubId')::uuid) THEN
  RAISE EXCEPTION 'issuer hub is immutable' USING ERRCODE='23514'; END IF;
 SELECT coalesce(max(version),0)+1 INTO next_version FROM trustwork.jurisdiction_issuer_version WHERE issuer_id=(p_document->>'issuerId')::uuid;
 INSERT INTO trustwork.jurisdiction_issuer_version(issuer_id,hub_id,version,document,digest,proposer)
 VALUES((p_document->>'issuerId')::uuid,(p_document->>'hubId')::uuid,next_version,p_document,trustwork.admin_digest(p_document),a) RETURNING * INTO v;
 PERFORM trustwork.jurisdiction_source_audit(a,p_ctx,'jurisdiction.issuer_proposed',v.id,NULL,to_jsonb(v));
 RETURN jsonb_build_object('id',v.id,'digest',v.digest,'state','pending_second_person');
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_owning_quote(p_quote uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE q trustwork.quote%ROWTYPE; r trustwork.rfq%ROWTYPE; p trustwork.project%ROWTYPE; material jsonb; history jsonb; qv trustwork.quote_version%ROWTYPE; rv trustwork.rfq_version%ROWTYPE;
BEGIN
 PERFORM trustwork.jurisdiction_lock();
 SELECT * INTO q FROM trustwork.quote WHERE id=p_quote FOR SHARE;
 SELECT * INTO r FROM trustwork.rfq WHERE id=q.rfq_id FOR SHARE;
 SELECT * INTO p FROM trustwork.project WHERE id=r.project_id FOR SHARE;
 IF q.id IS NULL OR p.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO qv FROM trustwork.quote_version WHERE id=q.current_version_id FOR SHARE;
 SELECT * INTO rv FROM trustwork.rfq_version WHERE id=r.current_version_id FOR SHARE;
 IF (SELECT count(*) FROM (SELECT id FROM trustwork.agreement WHERE rfq_id=r.id LIMIT 101) bounded)>100 THEN RETURN NULL; END IF;
 PERFORM id FROM trustwork.agreement WHERE rfq_id=r.id ORDER BY id FOR SHARE NOWAIT;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',revision,'status',status,'digest',accepted_terms_digest) ORDER BY id),'[]') INTO history FROM trustwork.agreement WHERE rfq_id=r.id;
 material:=jsonb_build_object('quote',q.id,'agreementHistory',history,'quoteRevision',q.revision,'quoteStatus',q.status,
   'quoteVersion',qv.id,'quoteVersionRevision',qv.revision,'quoteDigest',qv.digest,'quoteVersionStatus',qv.status,
   'rfqDigest',rv.digest,'rfqVersionStatus',rv.status,'rfq',r.id,'rfqRevision',r.revision,
   'rfqVersion',r.current_version_id,'project',p.id,'projectRevision',p.revision,'projectStatus',p.status,
   'ownerPerson',p.owner_person_id,'ownerCompany',p.owner_company_id,
   'buyerPerson',q.buyer_person_id,'buyerCompany',q.buyer_company_id,'sellerPerson',q.seller_person_id,'sellerCompany',q.seller_company_id);
 RETURN jsonb_build_object('kind','quote','id',q.id,'revision',q.revision,'digest',trustwork.admin_digest(material));
END $$;

-- Initial quote acceptance has exactly one sent version by quote_version_one_sent.
-- The RFQ UPDATE lock fences the absence of a live agreement against the owning insertion guard's SHARE lock.
CREATE FUNCTION trustwork.jurisdiction_quote_acceptance_available(p_quote uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE q trustwork.quote%ROWTYPE; r trustwork.rfq%ROWTYPE;
BEGIN
 SELECT * INTO q FROM trustwork.quote WHERE id=p_quote FOR SHARE;
 SELECT * INTO r FROM trustwork.rfq WHERE id=q.rfq_id FOR UPDATE NOWAIT;
 RETURN coalesce(q.status='sent' AND r.status='published' AND EXISTS(SELECT 1 FROM trustwork.quote_version v
  WHERE v.id=q.current_version_id AND v.status='sent' AND v.valid_until>clock_timestamp() AND v.stale_reason IS NULL
   AND v.rfq_version_id=r.current_version_id)
  AND NOT EXISTS(SELECT 1 FROM trustwork.agreement WHERE rfq_id=r.id AND status IN('proposed','accepted_by_buyer','accepted_by_both')),false);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'current commerce authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_proof_matches(p jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE v trustwork.jurisdiction_issuer_version%ROWTYPE; c jsonb; s jsonb;
BEGIN
 SELECT * INTO v FROM trustwork.jurisdiction_issuer_version WHERE id=(p->>'issuerVersionId')::uuid;
 IF NOT trustwork.jurisdiction_issuer_live(v.id) THEN RETURN false; END IF;
 c:=trustwork.jurisdiction_owning_quote((p->'context'->>'id')::uuid);
 s:=trustwork.jurisdiction_owning_subject(p->'subject'->>'kind',(p->'subject'->>'id')::uuid,(p->'context'->>'id')::uuid);
 RETURN coalesce(p->>'schemaVersion'='2' AND p->>'issuerDigest'=v.digest AND p->>'keyId'=v.document->>'keyId'
   AND p->>'evidenceMode'='synthetic' AND p->>'audienceHubId'=v.hub_id::text AND p->>'originHubId'=v.hub_id::text
   AND p->'demoAuthority'=trustwork.jurisdiction_demo_authority(v.hub_id)
   AND (p->>'action'<>'place_order' OR trustwork.jurisdiction_quote_acceptance_available((p->'context'->>'id')::uuid))
   AND p->'subject'=s AND p->'context'=c AND p->>'action' IN('send_quote','negotiate','place_order')
   AND (p->>'action'='send_quote' OR EXISTS(SELECT 1 FROM trustwork.quote q JOIN trustwork.quote_version qv ON qv.id=q.current_version_id
     JOIN trustwork.rfq r ON r.id=q.rfq_id WHERE q.id=(p->'context'->>'id')::uuid AND qv.status IN('sent','accepted')
       AND qv.rfq_version_id=r.current_version_id AND qv.stale_reason IS NULL AND qv.valid_until>clock_timestamp()))
   AND v.document->'subjectKinds' ? (p->'subject'->>'kind') AND v.document->'actions' ? (p->>'action')
   AND v.document->'contextKinds' ? (p->'context'->>'kind')
   AND p->'coverage'->>'status'='complete' AND jsonb_array_length(p->'coverage'->'jurisdictions') BETWEEN 1 AND 20
   AND (p->'coverage'->'jurisdictions') <@ (v.document->'jurisdictions')
   AND p->'coverage'->>'competenceDigest'=v.document->>'competenceDigest'
   AND (p->'coverage'->>'basisDigest') ~ '^[a-f0-9]{64}$' AND p->'linkage'->>'kind'='verified_engine_subject'
   AND (p->'linkage'->>'evidenceDigest') ~ '^[a-f0-9]{64}$'
   AND (v.document->>'independence'='not_required' OR (p->'coverage'->>'independenceEvidenceDigest') ~ '^[a-f0-9]{64}$')
   AND (p->>'issuedAt')::timestamptz>=(v.document->>'effectiveFrom')::timestamptz
   AND (p->>'effectiveFrom')::timestamptz>=(v.document->>'effectiveFrom')::timestamptz
   AND (p->>'issuedAt')::timestamptz<=clock_timestamp() AND (p->>'effectiveFrom')::timestamptz<=clock_timestamp()
   AND (p->>'effectiveUntil')::timestamptz>clock_timestamp()
   AND (p->>'effectiveUntil')::timestamptz<=(v.document->>'effectiveUntil')::timestamptz
   AND (p->>'effectiveUntil')::timestamptz>(p->>'effectiveFrom')::timestamptz
   AND (p->>'effectiveUntil')::timestamptz<=(p->>'issuedAt')::timestamptz+interval '24 hours',false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_action_evidence(p_kind text,p_subject uuid,p_quote uuid,p_action text)
RETURNS TABLE(id uuid,document jsonb,digest text,revision integer,source_digest text,source_revision integer,issuer_epoch integer)
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE h trustwork.jurisdiction_scoped_head%ROWTYPE; r trustwork.jurisdiction_proof_record%ROWTYPE; candidate_count integer;
BEGIN
 PERFORM trustwork.jurisdiction_lock();
 SELECT count(*) INTO candidate_count FROM trustwork.jurisdiction_scoped_head x WHERE x.subject_kind=p_kind AND x.subject_id=p_subject AND x.context_kind='quote' AND x.context_id=p_quote AND x.action=p_action;
 IF candidate_count<>1 THEN RETURN; END IF;
 SELECT * INTO h FROM trustwork.jurisdiction_scoped_head x WHERE x.subject_kind=p_kind AND x.subject_id=p_subject AND x.context_kind='quote' AND x.context_id=p_quote AND x.action=p_action;
 SELECT pr.* INTO r FROM trustwork.jurisdiction_applicability_origin o JOIN trustwork.jurisdiction_proof_record pr ON pr.id=o.source_id WHERE o.evidence_id=h.applicability_id;
 IF NOT trustwork.jurisdiction_proof_live(r.id) THEN RETURN; END IF;
 -- An additional currently authentic contradictory source poisons the scope, even before a reviewer selects it.
 IF EXISTS(SELECT 1 FROM trustwork.jurisdiction_proof_record other JOIN trustwork.jurisdiction_proof_current pc ON pc.source_id=other.id
   WHERE other.document->'subject'->>'kind'=p_kind AND other.document->'subject'->>'id'=p_subject::text
    AND other.document->'context'->>'id'=p_quote::text AND other.document->>'action'=p_action
    AND other.id<>r.id AND trustwork.jurisdiction_proof_live(other.id)
    AND (other.document->>'originHubId' IS DISTINCT FROM r.document->>'originHubId'
      OR NOT ((other.document->'coverage'->'jurisdictions') @> (r.document->'coverage'->'jurisdictions') AND (other.document->'coverage'->'jurisdictions') <@ (r.document->'coverage'->'jurisdictions')))) THEN RETURN; END IF;
 RETURN QUERY SELECT a.id,a.document,a.digest,h.revision,r.digest,pc.revision,ic.epoch
  FROM trustwork.jurisdiction_applicability a JOIN trustwork.jurisdiction_proof_current pc ON pc.source_id=r.id
  JOIN trustwork.jurisdiction_issuer_current ic ON ic.version_id=r.issuer_version_id WHERE a.id=h.applicability_id;
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
  IF p_actor IS NULL OR p_action NOT IN('send_quote','negotiate','place_order') THEN RETURN unknown_result; END IF;
  SELECT * INTO q FROM trustwork.quote WHERE id=p_quote FOR SHARE;
  IF NOT FOUND THEN RETURN unknown_result; END IF;
  -- Buyer amendment is a separate action, never a seller send-quote alias. Delegated nonparty contexts remain unsupported.
  IF p_action IN('negotiate','place_order') AND NOT coalesce(p_actor=q.buyer_person_id OR EXISTS(
    SELECT 1 FROM trustwork.membership WHERE person_id=p_actor AND company_id=q.buyer_company_id AND status='active'
     AND valid_from<=clock_timestamp() AND ended_at IS NULL AND 'company.deals.manage'=ANY(permissions)),false) THEN RETURN unknown_result; END IF;
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
    SELECT * INTO att FROM trustwork.jurisdiction_action_evidence(subject->>'kind',(subject->>'id')::uuid,p_quote,p_action);
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
    IF NOT EXISTS(SELECT 1 FROM trustwork.jurisdiction_action_evidence(subject->>'kind',(subject->>'id')::uuid,p_quote,p_action)) THEN RETURN unknown_result; END IF;
  END LOOP;
  RETURN result || jsonb_build_object('bindingDigest',trustwork.admin_digest(jsonb_build_object('kind','jurisdiction-binding-3','quote',p_quote,'action',p_action,'actor',p_actor,'evidence',evidence,'limits',result)));
EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN unknown_result;
END $$;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_limits(p_quote uuid, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE q trustwork.quote%ROWTYPE; result jsonb; epoch integer;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  PERFORM trustwork.admin_require_caller();
  SELECT authz_epoch INTO epoch FROM trustwork.person WHERE id=trustwork.current_person_id() FOR SHARE;
  IF epoch IS DISTINCT FROM trustwork.current_authz_epoch() THEN RAISE EXCEPTION 'stale actor' USING ERRCODE='42501'; END IF;
  SELECT * INTO q FROM trustwork.quote WHERE id=p_quote FOR SHARE;
  -- Exact party permission, not public quote visibility, project membership or a staff case grant.
  IF NOT FOUND OR NOT (CASE p_action
    WHEN 'send_quote' THEN trustwork.commerce_party_acts(q.seller_person_id,q.seller_company_id,'company.deals.manage')
    WHEN 'place_order' THEN trustwork.rfq_can(q.rfq_id,'accept') AND trustwork.commerce_party_acts(q.buyer_person_id,q.buyer_company_id,'company.deals.manage')
    WHEN 'negotiate' THEN trustwork.rfq_can(q.rfq_id,'negotiate') AND trustwork.commerce_party_acts(q.buyer_person_id,q.buyer_company_id,'company.deals.manage')
    ELSE false END) THEN RAISE EXCEPTION 'jurisdiction limits unavailable' USING ERRCODE='42501'; END IF;
  result:=trustwork.jurisdiction_resolve_quote(p_quote,p_action,trustwork.current_person_id());
  RETURN result||jsonb_build_object('consentSatisfied',CASE WHEN jsonb_array_length(result->'consentRequirements')=0 THEN true
    ELSE p_action='send_quote' AND trustwork.jurisdiction_consent_current(p_quote,trustwork.current_person_id()) END);
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
