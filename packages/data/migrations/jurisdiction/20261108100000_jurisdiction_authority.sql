-- HUB-005 / ADR 022. No country law is seeded. Reviewed sources and applicability enter through owner-module
-- maintenance imports only; API, staff commands and workers cannot assert law or attest a party's jurisdiction.
-- One transaction lock serializes policy reads with source, language, legal and applicability writes. Volatile
-- validators take fresh READ COMMITTED snapshots after waiting. No provider I/O belongs inside this lock.
CREATE FUNCTION trustwork.jurisdiction_lock() RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'jurisdiction authority requires read committed' USING ERRCODE = '40001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.jurisdiction.authority', 0));
END $$;
CREATE FUNCTION trustwork.jurisdiction_write_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM trustwork.jurisdiction_lock(); RETURN NULL; END $$;

CREATE TABLE trustwork.jurisdiction_source (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  document jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (digest)
);
CREATE TABLE trustwork.jurisdiction_source_current (
  jurisdiction text PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES trustwork.jurisdiction_source(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0)
);
CREATE TABLE trustwork.jurisdiction_applicability (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  document jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trustwork.jurisdiction_applicability_current (
  subject_kind text NOT NULL CHECK (subject_kind IN ('person', 'company', 'project')),
  subject_id uuid NOT NULL,
  applicability_id uuid NOT NULL REFERENCES trustwork.jurisdiction_applicability(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY(subject_kind, subject_id)
);
CREATE TABLE trustwork.jurisdiction_intent_binding (
  intent_id uuid PRIMARY KEY REFERENCES trustwork.action_intent(id),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION trustwork.jurisdiction_policy_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE r jsonb; k text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT (p ?& ARRAY['disclosureTextKeys','liabilityAllocationKey','consentRequirements','recordKeeping','actionLimits','legalTextKeys'])
    OR (SELECT count(*) FROM jsonb_object_keys(p)) <> 6
    OR jsonb_typeof(p->'disclosureTextKeys') IS DISTINCT FROM 'object' OR jsonb_typeof(p->'legalTextKeys') IS DISTINCT FROM 'object'
    OR coalesce(p->>'liabilityAllocationKey','') !~ '^[a-z][A-Za-z0-9_.-]{1,120}$'
    OR jsonb_typeof(p->'consentRequirements') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'recordKeeping') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p->'actionLimits') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'actionLimits') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  FOR k IN SELECT jsonb_array_elements_text(p->'consentRequirements') UNION ALL SELECT value #>> '{}' FROM jsonb_each(p->'disclosureTextKeys') LOOP
    IF k IS NULL OR k !~ '^[a-z][A-Za-z0-9_.-]{1,120}$' THEN RETURN false; END IF;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_each(p->'legalTextKeys') LOOP
    IF jsonb_typeof(r) <> 'array' OR jsonb_array_length(r) = 0 THEN RETURN false; END IF;
    FOR k IN SELECT jsonb_array_elements_text(r) LOOP IF k !~ '^[a-z][A-Za-z0-9_.-]{1,120}$' THEN RETURN false; END IF; END LOOP;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_array_elements(p->'recordKeeping') LOOP
    IF NOT (r ?& ARRAY['recordClass','minimumDays','maximumDays']) OR (SELECT count(*) FROM jsonb_object_keys(r)) <> 3
      OR coalesce(r->>'recordClass','') !~ '^[a-z][A-Za-z0-9_.-]{1,120}$'
      OR (r->'minimumDays' <> 'null' AND ((r->>'minimumDays') !~ '^[0-9]+$' OR (r->>'minimumDays')::numeric > 365250))
      OR (r->'maximumDays' <> 'null' AND ((r->>'maximumDays') !~ '^[0-9]+$' OR (r->>'maximumDays')::numeric > 365250))
      OR (r->>'minimumDays')::numeric > (r->>'maximumDays')::numeric THEN RETURN false; END IF;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_array_elements(p->'actionLimits') LOOP
    IF NOT (r ?& ARRAY['action','approval','approvalAbove']) OR (SELECT count(*) FROM jsonb_object_keys(r)) <> 3
      OR (r->>'action') IS NULL OR (r->>'approval') IS NULL OR (r->>'approval') NOT IN ('pre_authorized','ask_each','human_only') THEN RETURN false; END IF;
    IF r->'approvalAbove' <> 'null' AND (jsonb_typeof(r->'approvalAbove') <> 'object'
      OR NOT ((r->'approvalAbove') ?& ARRAY['minorUnits','currency'])
      OR coalesce(r->'approvalAbove'->>'minorUnits','') !~ '^(0|[1-9][0-9]{0,18})$' OR coalesce(r->'approvalAbove'->>'currency','') !~ '^[A-Z]{3}$') THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(*) = count(DISTINCT value->>'action') FROM jsonb_array_elements(p->'actionLimits'))
    AND (SELECT count(*) = count(DISTINCT value->>'recordClass') FROM jsonb_array_elements(p->'recordKeeping'));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION trustwork.jurisdiction_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE d jsonb := NEW.document; areas jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'jurisdiction evidence is immutable' USING ERRCODE = '23000'; END IF;
  areas := (d->'mandatoryAreas') || (d->'advisoryAreas');
  IF d->>'schemaVersion' IS DISTINCT FROM '2' OR d->>'verification' IS DISTINCT FROM 'official'
    OR d->'counsel'->>'status' IS DISTINCT FROM 'reviewed' OR coalesce(d->'counsel'->>'evidenceDigest','') !~ '^[a-f0-9]{64}$'
    OR coalesce(d->'counsel'->>'reviewId','') = '' OR (d->'counsel'->>'reviewedAt')::timestamptz IS NULL
    OR coalesce(d->>'version','') = '' OR (d->>'effectiveFrom')::timestamptz IS NULL OR NOT (d ? 'effectiveUntil')
    OR (d->>'effectiveUntil')::timestamptz <= (d->>'effectiveFrom')::timestamptz
    OR trustwork.hubs_place_code_ok(d->>'jurisdiction') IS DISTINCT FROM true OR trustwork.hubs_place_restricted(NULL,d->>'jurisdiction')
    OR jsonb_typeof(d->'mandatoryAreas') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'advisoryAreas') IS DISTINCT FROM 'array'
    OR jsonb_typeof(d->'ancestors') IS DISTINCT FROM 'array' OR (d->'ancestors') ? (d->>'jurisdiction')
    OR jsonb_typeof(d->'provenance') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'provenance') = 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(d->'provenance') s WHERE coalesce(s->>'contentDigest','') !~ '^[a-f0-9]{64}$'
      OR coalesce(s->>'url','') !~ '^https?://' OR coalesce(s->>'factKey','') = '' OR coalesce(s->>'packVersion','') = '' OR coalesce(s->>'packCode','') = '' OR (s->>'accessed')::date IS NULL)
    OR jsonb_array_length(areas) <> 6 OR NOT (areas @> '["agent_disclosure","liability_allocation","consent","record_keeping","action_limits","legal_texts"]')
    OR trustwork.jurisdiction_policy_valid(d->'policy') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'reviewed executable source required' USING ERRCODE = '23514', HINT = 'jurisdiction.source_invalid';
  END IF;
  NEW.digest := trustwork.admin_digest(d); RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_source_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_source FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_source_guard();

CREATE FUNCTION trustwork.jurisdiction_applicability_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE d jsonb := NEW.document; found_subject boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'applicability evidence is immutable' USING ERRCODE = '23000'; END IF;
  IF d->>'subjectKind' = 'person' THEN SELECT EXISTS(SELECT 1 FROM trustwork.person WHERE id=(d->>'subjectId')::uuid) INTO found_subject;
  ELSIF d->>'subjectKind' = 'company' THEN SELECT EXISTS(SELECT 1 FROM trustwork.company WHERE id=(d->>'subjectId')::uuid) INTO found_subject;
  ELSIF d->>'subjectKind' = 'project' THEN SELECT EXISTS(SELECT 1 FROM trustwork.project WHERE id=(d->>'subjectId')::uuid) INTO found_subject;
  END IF;
  IF found_subject IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM trustwork.hub WHERE id=(d->>'hubId')::uuid)
    OR coalesce(d->>'evidenceId','') = '' OR coalesce(d->>'evidenceDigest','') !~ '^[a-f0-9]{64}$'
    OR (d->>'effectiveFrom')::timestamptz IS NULL OR (d->>'effectiveUntil')::timestamptz IS NULL
    OR (d->>'effectiveFrom')::timestamptz >= (d->>'effectiveUntil')::timestamptz
    OR jsonb_typeof(d->'jurisdictions') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'jurisdictions') = 0
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(d->'jurisdictions') j WHERE NOT trustwork.hubs_place_code_ok(j) OR trustwork.hubs_place_restricted((d->>'hubId')::uuid,j)) THEN
    RAISE EXCEPTION 'reviewed domain applicability required' USING ERRCODE = '23514';
  END IF;
  NEW.digest := trustwork.admin_digest(d); RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_applicability_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_applicability FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_applicability_guard();
CREATE TRIGGER jurisdiction_binding_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_intent_binding FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.jurisdiction_head_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'authority heads cannot be removed' USING ERRCODE = '23000'; END IF;
  IF TG_TABLE_NAME = 'jurisdiction_source_current' THEN
    IF NOT EXISTS(SELECT 1 FROM trustwork.jurisdiction_source WHERE id=NEW.source_id AND document->>'jurisdiction'=NEW.jurisdiction) THEN RAISE EXCEPTION 'source scope mismatch' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND NEW.jurisdiction<>OLD.jurisdiction THEN RAISE EXCEPTION 'scope immutable' USING ERRCODE='23514'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM trustwork.jurisdiction_applicability WHERE id=NEW.applicability_id AND document->>'subjectKind'=NEW.subject_kind AND document->>'subjectId'=NEW.subject_id::text) THEN RAISE EXCEPTION 'applicability scope mismatch' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND (NEW.subject_kind<>OLD.subject_kind OR NEW.subject_id<>OLD.subject_id) THEN RAISE EXCEPTION 'scope immutable' USING ERRCODE='23514'; END IF;
  END IF;
  NEW.revision:=CASE WHEN TG_OP='INSERT' THEN 1 ELSE OLD.revision+1 END;
  RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_source_head_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_source_current FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_head_guard();
CREATE TRIGGER jurisdiction_applicability_head_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_applicability_current FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_head_guard();

-- Returns false on an incomparable currency, identity or empty retention intersection. Advisory overrides still
-- must be well-formed; absent source areas/actions are never interpreted as permission.
CREATE FUNCTION trustwork.jurisdiction_protects(p jsonb, b jsonb, mandatory jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE r jsonb; a jsonb; k text; v jsonb;
BEGIN
  IF NOT trustwork.jurisdiction_policy_valid(p) THEN RETURN false; END IF;
  IF mandatory ? 'agent_disclosure' AND NOT ((p->'disclosureTextKeys') @> (b->'disclosureTextKeys')) THEN RETURN false; END IF;
  IF mandatory ? 'liability_allocation' AND p->>'liabilityAllocationKey' IS DISTINCT FROM b->>'liabilityAllocationKey' THEN RETURN false; END IF;
  IF mandatory ? 'consent' AND NOT ((p->'consentRequirements') @> (b->'consentRequirements')) THEN RETURN false; END IF;
  IF mandatory ? 'legal_texts' AND NOT ((p->'legalTextKeys') @> (b->'legalTextKeys')) THEN RETURN false; END IF;
  IF mandatory ? 'record_keeping' THEN
    FOR r IN SELECT value FROM jsonb_array_elements(b->'recordKeeping') LOOP
      SELECT value INTO a FROM jsonb_array_elements(p->'recordKeeping') WHERE value->>'recordClass'=r->>'recordClass';
      IF a IS NULL OR (r->>'minimumDays' IS NOT NULL AND (a->>'minimumDays' IS NULL OR (a->>'minimumDays')::numeric < (r->>'minimumDays')::numeric))
        OR (r->>'maximumDays' IS NOT NULL AND (a->>'maximumDays' IS NULL OR (a->>'maximumDays')::numeric > (r->>'maximumDays')::numeric)) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p->'actionLimits') LOOP
    SELECT value INTO a FROM jsonb_array_elements(b->'actionLimits') WHERE value->>'action'=r->>'action';
    IF a IS NULL THEN RETURN false; END IF;
  END LOOP;
  IF mandatory ? 'action_limits' THEN
    FOR r IN SELECT value FROM jsonb_array_elements(b->'actionLimits') LOOP
      SELECT value INTO a FROM jsonb_array_elements(p->'actionLimits') WHERE value->>'action'=r->>'action';
      IF a IS NULL OR array_position(ARRAY['pre_authorized','ask_each','human_only'],a->>'approval') < array_position(ARRAY['pre_authorized','ask_each','human_only'],r->>'approval') THEN RETURN false; END IF;
      IF r->'approvalAbove' <> 'null' AND (a->'approvalAbove' = 'null'
        OR a->'approvalAbove'->>'currency' IS DISTINCT FROM r->'approvalAbove'->>'currency'
        OR (a->'approvalAbove'->>'minorUnits')::numeric > (r->'approvalAbove'->>'minorUnits')::numeric) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION trustwork.hubs_legal_kinds() RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT ARRAY['terms','privacy_notice','sanctions_section','cookie_notice','community_rules','organizer_terms','author_terms','notice_at_collection','do_not_sell_notice','agent_jurisdiction']::text[]
$$;

CREATE FUNCTION trustwork.jurisdiction_validate(p_hub uuid, p jsonb, locales text[]) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE s jsonb; src trustwork.jurisdiction_source%ROWTYPE; l text; key text; binding jsonb; doc trustwork.legal_document_version%ROWTYPE; keys jsonb;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  IF p->'agentSettings'->>'schemaVersion' IS DISTINCT FROM '2' OR jsonb_typeof(p->'agentSettings'->'jurisdictions') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p->'agentSettings'->'jurisdictions') NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'executable jurisdiction settings required' USING ERRCODE='23514', HINT='jurisdiction.settings_unknown';
  END IF;
  IF (SELECT count(*)<>count(DISTINCT value->>'jurisdiction') FROM jsonb_array_elements(p->'agentSettings'->'jurisdictions')) THEN RAISE EXCEPTION 'duplicate jurisdiction' USING ERRCODE='23514'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(p->'agentSettings'->'jurisdictions') LOOP
    SELECT v.* INTO src FROM trustwork.jurisdiction_source v JOIN trustwork.jurisdiction_source_current c ON c.source_id=v.id
      WHERE c.jurisdiction=s->>'jurisdiction' AND v.id=(s->>'sourceId')::uuid AND v.digest=s->>'sourceDigest' AND c.revision=(s->>'sourceRevision')::integer;
    IF NOT FOUND OR (src.document->>'effectiveFrom')::timestamptz > clock_timestamp()
      OR (src.document->>'effectiveUntil')::timestamptz <= clock_timestamp()
      OR trustwork.hubs_place_restricted(p_hub,s->>'jurisdiction')
      OR trustwork.jurisdiction_protects(s->'policy',src.document->'policy',src.document->'mandatoryAreas') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'current reviewed source and protective policy required' USING ERRCODE='23514', HINT='jurisdiction.source_or_policy_changed';
    END IF;
    IF jsonb_typeof(s->'legalBindings') IS DISTINCT FROM 'array' OR
      (SELECT count(*)<>count(DISTINCT (value->>'locale',value->>'key')) FROM jsonb_array_elements(s->'legalBindings')) THEN RAISE EXCEPTION 'legal bindings invalid' USING ERRCODE='23514'; END IF;
    FOREACH l IN ARRAY locales LOOP
      IF coalesce(s->'policy'->'disclosureTextKeys'->>l,'')='' OR jsonb_typeof(s->'policy'->'legalTextKeys'->l) IS DISTINCT FROM 'array'
        OR jsonb_array_length(s->'policy'->'legalTextKeys'->l)=0 THEN RAISE EXCEPTION 'every hub language required' USING ERRCODE='23514', HINT='jurisdiction.language_missing'; END IF;
      keys := jsonb_build_array(s->'policy'->'disclosureTextKeys'->>l,s->'policy'->>'liabilityAllocationKey') || (s->'policy'->'legalTextKeys'->l) || (s->'policy'->'consentRequirements');
      FOR key IN SELECT DISTINCT jsonb_array_elements_text(keys) LOOP
        SELECT value INTO binding FROM jsonb_array_elements(s->'legalBindings') WHERE value->>'locale'=l AND value->>'key'=key;
        SELECT * INTO doc FROM trustwork.legal_document_version WHERE id=(binding->>'documentId')::uuid;
        IF NOT FOUND OR doc.hub_id<>p_hub OR doc.kind<>'agent_jurisdiction' OR doc.locale<>l OR doc.status<>'active'
          OR doc.body_digest IS DISTINCT FROM binding->>'bodyDigest' OR doc.counsel_approval_id IS DISTINCT FROM (binding->>'counselApprovalId')::uuid
          OR NOT EXISTS(SELECT 1 FROM trustwork.counsel_approval ca WHERE ca.id=doc.counsel_approval_id AND ca.hub_id=p_hub AND doc.id=ANY(ca.document_version_ids)) THEN
          RAISE EXCEPTION 'immutable counsel-reviewed legal binding required' USING ERRCODE='23514', HINT='jurisdiction.legal_binding_invalid';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION trustwork.jurisdiction_config_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE old_payload jsonb;
BEGIN
  IF NEW.domain='jurisdiction' AND NEW.status='active' AND OLD.status IS DISTINCT FROM 'active' THEN
    SELECT payload INTO old_payload FROM trustwork.hub_config_version WHERE hub_id=NEW.hub_id AND domain='jurisdiction' AND id<>NEW.id AND payload ? 'agentSettings' LIMIT 1;
    IF NEW.payload ? 'agentSettings' OR old_payload IS NOT NULL THEN
      IF NEW.activated_by IS NOT DISTINCT FROM NEW.drafted_by THEN RAISE EXCEPTION 'drafter cannot activate' USING ERRCODE='42501'; END IF;
      PERFORM trustwork.jurisdiction_validate(NEW.hub_id,NEW.payload,(SELECT locales FROM trustwork.hub_profile WHERE hub_id=NEW.hub_id));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_config_guard BEFORE UPDATE ON trustwork.hub_config_version FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_config_guard();
CREATE FUNCTION trustwork.jurisdiction_language_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE p jsonb;
BEGIN
  IF NEW.locales IS DISTINCT FROM OLD.locales THEN
    p := trustwork.hubs_active_payload(NEW.hub_id,'jurisdiction');
    IF p ? 'agentSettings' THEN PERFORM trustwork.jurisdiction_validate(NEW.hub_id,p,NEW.locales); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_language_guard BEFORE UPDATE ON trustwork.hub_profile FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_language_guard();

-- Internal resolver: actor, parties and project come from the concrete quote/RFQ. It has no caller country, locale,
-- address, hub default or free-text parameter. Missing reviewed applicability for ANY subject denies the whole action.
CREATE FUNCTION trustwork.jurisdiction_resolve_quote(p_quote uuid, p_action text, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE
  q trustwork.quote%ROWTYPE; project_id uuid; subjects jsonb; subject jsonb; att trustwork.jurisdiction_applicability%ROWTYPE;
  cfg trustwork.hub_config_version%ROWTYPE; src trustwork.jurisdiction_source%ROWTYPE; s jsonb; rule jsonb; r jsonb; prev jsonb;
  queue text[]; seen text[]; j text; h uuid; primary_hub uuid; locales text[]; liability text;
  consent jsonb := '[]'; retention jsonb := '{}'; thresholds jsonb := '{}'; approval text := 'pre_authorized';
  evidence jsonb := '[]'; versions jsonb := '[]'; result jsonb; n integer := 0; mn numeric; mx numeric; currency text;
  unknown_result jsonb := '{"status":"unknown","reasons":["jurisdiction_unavailable"],"bindingDigest":null,"versions":[],"hubId":null,"approval":"human_only","approvalAbove":[],"consentRequirements":[],"recordKeeping":[],"liabilityAllocationKey":null}';
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  IF p_actor IS NULL OR p_action <> 'send_quote' THEN RETURN unknown_result; END IF;
  SELECT * INTO q FROM trustwork.quote WHERE id=p_quote;
  IF NOT FOUND THEN RETURN unknown_result; END IF;
  SELECT r.project_id INTO project_id FROM trustwork.rfq r WHERE r.id=q.rfq_id;
  IF project_id IS NULL THEN RETURN unknown_result; END IF;
  SELECT jsonb_build_array(jsonb_build_object('project',p.id,'revision',p.revision,'ownerPerson',p.owner_person_id,'ownerCompany',p.owner_company_id,'status',p.status,'quoteRevision',q.revision,'rfqRevision',r.revision)) INTO evidence
    FROM trustwork.project p JOIN trustwork.rfq r ON r.project_id=p.id WHERE r.id=q.rfq_id;
  subjects := jsonb_build_array(
    jsonb_build_object('kind','person','id',p_actor),
    jsonb_build_object('kind',CASE WHEN q.seller_person_id IS NULL THEN 'company' ELSE 'person' END,'id',coalesce(q.seller_person_id,q.seller_company_id)),
    jsonb_build_object('kind',CASE WHEN q.buyer_person_id IS NULL THEN 'company' ELSE 'person' END,'id',coalesce(q.buyer_person_id,q.buyer_company_id)),
    jsonb_build_object('kind','project','id',project_id));
  FOR subject IN SELECT DISTINCT value FROM jsonb_array_elements(subjects) ORDER BY value LOOP
    SELECT a.* INTO att FROM trustwork.jurisdiction_applicability a JOIN trustwork.jurisdiction_applicability_current c ON c.applicability_id=a.id
      WHERE c.subject_kind=subject->>'kind' AND c.subject_id=(subject->>'id')::uuid;
    IF NOT FOUND OR (att.document->>'effectiveFrom')::timestamptz > clock_timestamp() OR (att.document->>'effectiveUntil')::timestamptz <= clock_timestamp() THEN RETURN unknown_result; END IF;
    h := (att.document->>'hubId')::uuid;
    IF subject->>'kind'='project' THEN primary_hub:=h; END IF;
    SELECT v.* INTO cfg FROM trustwork.hub_config_current c JOIN trustwork.hub_config_version v ON v.id=c.version_id
      WHERE c.hub_id=h AND c.domain='jurisdiction' AND v.status='active' AND v.effective_from<=clock_timestamp();
    IF NOT FOUND THEN RETURN unknown_result; END IF;
    SELECT hp.locales INTO locales FROM trustwork.hub_profile hp WHERE hp.hub_id=h;
    PERFORM trustwork.jurisdiction_validate(h,cfg.payload,locales);
    evidence := evidence || jsonb_build_array(jsonb_build_object('applicability',att.digest,'applicabilityRevision',(SELECT revision FROM trustwork.jurisdiction_applicability_current WHERE applicability_id=att.id),'config',cfg.payload_digest,'locales',locales));
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
  RETURN result || jsonb_build_object('bindingDigest',trustwork.admin_digest(jsonb_build_object('kind','jurisdiction-binding-2','quote',p_quote,'action',p_action,'actor',p_actor,'evidence',evidence,'limits',result)));
EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN unknown_result;
END $$;

CREATE FUNCTION trustwork.jurisdiction_limits(p_quote uuid, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE q trustwork.quote%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO q FROM trustwork.quote WHERE id=p_quote;
  -- Exact party permission, not public quote visibility, project membership or a staff case grant.
  IF NOT FOUND OR NOT (CASE p_action
    WHEN 'send_quote' THEN trustwork.commerce_party_acts(q.seller_person_id,q.seller_company_id,'company.deals.manage')
    ELSE false END) THEN RAISE EXCEPTION 'jurisdiction limits unavailable' USING ERRCODE='42501'; END IF;
  RETURN trustwork.jurisdiction_resolve_quote(p_quote,p_action,trustwork.current_person_id());
END $$;

CREATE FUNCTION trustwork.jurisdiction_bind_intent(p_intent uuid, p_digest text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE i trustwork.action_intent%ROWTYPE; limits jsonb;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent;
  IF NOT FOUND OR i.principal_person_id IS DISTINCT FROM trustwork.current_person_id() OR i.context_kind<>'quote' OR i.state NOT IN ('proposed','authorized') THEN RAISE EXCEPTION 'intent not bindable' USING ERRCODE='42501'; END IF;
  limits:=trustwork.jurisdiction_limits(i.context_id::uuid,i.action);
  IF limits->>'status'<>'resolved' OR limits->>'bindingDigest' IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'policy changed' USING ERRCODE='23514',HINT='jurisdiction.policy_changed'; END IF;
  IF jsonb_array_length(limits->'consentRequirements')>0 OR limits->>'approval'='human_only' THEN RAISE EXCEPTION 'consent or human execution required' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(limits->'approvalAbove')>0 AND (i.amount_minor IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(limits->'approvalAbove') m WHERE m->>'currency' IS DISTINCT FROM i.currency)) THEN RAISE EXCEPTION 'amount comparison unavailable' USING ERRCODE='23514'; END IF;
  IF i.state<>'proposed' AND (limits->>'approval'<>'pre_authorized' OR EXISTS(SELECT 1 FROM jsonb_array_elements(limits->'approvalAbove') m WHERE i.amount_minor>(m->>'minorUnits')::numeric)) THEN RAISE EXCEPTION 'jurisdiction approval required' USING ERRCODE='23514'; END IF;
  IF i.action_digest IS DISTINCT FROM trustwork.admin_digest(jsonb_build_object('kind','trustwork.assistant.jurisdiction-action.v2',
    'mandate',jsonb_build_object('id',i.mandate_id,'revision',i.mandate_revision),'capabilityId',i.capability_id,'action',i.action,
    'context',jsonb_build_object('kind',i.context_kind,'id',i.context_id),
    'amount',CASE WHEN i.amount_minor IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('minorUnits',i.amount_minor::text,'currency',i.currency) END,
    'effect',i.effect,'jurisdictionBinding',p_digest)) THEN RAISE EXCEPTION 'intent digest omits jurisdiction binding' USING ERRCODE='23514'; END IF;
  INSERT INTO trustwork.jurisdiction_intent_binding(intent_id,binding_digest,action_digest) VALUES(i.id,p_digest,i.action_digest);
END $$;

-- The API seam rechecks in the action transaction. The worker seam is intentionally a separate restricted definer;
-- it is a refusal gate, never a substitute for assistant_begin_attempt, mandate, budget or provider authority.
CREATE FUNCTION trustwork.jurisdiction_recheck_intent(p_intent uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE i trustwork.action_intent%ROWTYPE; b trustwork.jurisdiction_intent_binding%ROWTYPE; limits jsonb;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent;
  IF NOT FOUND OR i.principal_person_id IS DISTINCT FROM trustwork.current_person_id() THEN RAISE EXCEPTION 'intent unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO b FROM trustwork.jurisdiction_intent_binding WHERE intent_id=i.id;
  IF NOT FOUND OR i.context_kind<>'quote' OR b.action_digest<>i.action_digest THEN RETURN false; END IF;
  limits:=trustwork.jurisdiction_limits(i.context_id::uuid,i.action);
  RETURN limits->>'status'='resolved' AND limits->>'bindingDigest'=b.binding_digest;
END $$;

ALTER TABLE trustwork.jurisdiction_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_source FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_source FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

ALTER TABLE trustwork.jurisdiction_source_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_source_current FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_source_current FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

ALTER TABLE trustwork.jurisdiction_applicability ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_applicability FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_applicability FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

ALTER TABLE trustwork.jurisdiction_applicability_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_applicability_current FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_applicability_current FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

ALTER TABLE trustwork.jurisdiction_intent_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_intent_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_intent_binding FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_source FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_source_current FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_applicability FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_applicability_current FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_intent_binding FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.hub_config_version FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.hub_config_current FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.hub_profile FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.legal_document_version FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.jurisdiction_limits(uuid,text), trustwork.jurisdiction_bind_intent(uuid,text), trustwork.jurisdiction_recheck_intent(uuid) TO trustwork_app;

-- Isolated worker composition seam: same real assistant attempt command, no fabricated request/session identity.
-- The caller must replace the existing beginAttempt call with this function for jurisdiction-bound operations.
CREATE FUNCTION trustwork.jurisdiction_begin_attempt(p_intent uuid,p_job uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE i trustwork.action_intent%ROWTYPE; b trustwork.jurisdiction_intent_binding%ROWTYPE; limits jsonb;
  q trustwork.quote%ROWTYPE; party_person uuid; party_company uuid; authorized boolean; j trustwork.job%ROWTYPE;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO j FROM trustwork.job WHERE id=p_job FOR UPDATE;
  IF NOT FOUND OR j.state<>'leased' OR j.kind<>'assistant.dispatch' OR j.payload->>'intentId' IS DISTINCT FROM p_intent::text
    OR j.fencing_token<>p_fence OR j.leased_until<=clock_timestamp() THEN RAISE EXCEPTION 'dispatch lease mismatch' USING ERRCODE='55P03'; END IF;
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent FOR UPDATE;
  IF NOT FOUND OR i.state<>'queued' THEN RETURN jsonb_build_object('status','skip','state',coalesce(i.state,'missing')); END IF;
  SELECT * INTO b FROM trustwork.jurisdiction_intent_binding WHERE intent_id=p_intent;
  IF FOUND AND i.context_kind='quote' AND b.action_digest=i.action_digest THEN
    SELECT * INTO q FROM trustwork.quote WHERE id=i.context_id::uuid;
    IF i.action='send_quote' THEN party_person:=q.seller_person_id;party_company:=q.seller_company_id;
    END IF;
    authorized:=party_person=i.principal_person_id OR EXISTS(SELECT 1 FROM trustwork.membership WHERE person_id=i.principal_person_id AND company_id=party_company AND status='active' AND 'company.deals.manage'=ANY(permissions));
    IF authorized THEN limits:=trustwork.jurisdiction_resolve_quote(i.context_id::uuid,i.action,i.principal_person_id); END IF;
  END IF;
  IF limits->>'status' IS DISTINCT FROM 'resolved' OR limits->>'bindingDigest' IS DISTINCT FROM b.binding_digest
    OR jsonb_array_length(limits->'consentRequirements')>0 OR limits->>'approval'='human_only' THEN
    PERFORM trustwork.assistant_finish_intent(i.id,'revoked','jurisdiction policy changed or unavailable','jurisdiction:policy_changed');
    RETURN jsonb_build_object('status','refused','reason','jurisdiction_policy_changed');
  END IF;
  RETURN trustwork.assistant_begin_attempt(p_intent,p_job,(limits->>'hubId')::uuid);
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.jurisdiction_begin_attempt(uuid,uuid,bigint) TO trustwork_worker;

CREATE FUNCTION trustwork.jurisdiction_preflight(p_version uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v trustwork.hub_config_version%ROWTYPE;
BEGIN
  SELECT * INTO v FROM trustwork.hub_config_version WHERE id=p_version;
  IF NOT FOUND OR NOT trustwork.hubs_staff_reader(v.hub_id) OR v.domain<>'jurisdiction' THEN RAISE EXCEPTION 'configuration unavailable' USING ERRCODE='42501'; END IF;
  BEGIN
    PERFORM trustwork.jurisdiction_validate(v.hub_id,v.payload,(SELECT locales FROM trustwork.hub_profile WHERE hub_id=v.hub_id));
    RETURN jsonb_build_object('status','ready','versionId',v.id,'payloadDigest',v.payload_digest,'problems','[]'::jsonb);
  EXCEPTION WHEN check_violation OR invalid_text_representation THEN
    RETURN jsonb_build_object('status','blocked','versionId',v.id,'payloadDigest',v.payload_digest,'problems',jsonb_build_array('jurisdiction_source_legal_or_language_unavailable'));
  END;
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.jurisdiction_preflight(uuid) TO trustwork_app;
