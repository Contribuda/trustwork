-- HUB-005: synthetic-only owning proof producer. No operational issuer, key, legal fact or role grant is seeded.
CREATE TABLE trustwork.jurisdiction_issuer_version (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), issuer_id uuid NOT NULL, hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
 version integer NOT NULL, document jsonb NOT NULL, digest text NOT NULL, proposer jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(issuer_id,version),
 CHECK(octet_length(document::text)<=16384), CHECK(digest=trustwork.admin_digest(document)),
 CHECK(document->>'evidenceMode'='synthetic' AND document->>'verifier'='synthetic-ed25519-v1'),
 CHECK((document->>'issuerId')::uuid=issuer_id AND (document->>'hubId')::uuid=hub_id)
);
CREATE TABLE trustwork.jurisdiction_issuer_activation (
 version_id uuid PRIMARY KEY REFERENCES trustwork.jurisdiction_issuer_version(id), reviewer jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE trustwork.jurisdiction_issuer_current (
 issuer_id uuid PRIMARY KEY, version_id uuid NOT NULL UNIQUE REFERENCES trustwork.jurisdiction_issuer_version(id), epoch integer NOT NULL CHECK(epoch>0)
);
CREATE TABLE trustwork.jurisdiction_issuer_revocation (
 version_id uuid PRIMARY KEY REFERENCES trustwork.jurisdiction_issuer_version(id), authority jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE trustwork.jurisdiction_proof_record (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), issuer_version_id uuid NOT NULL REFERENCES trustwork.jurisdiction_issuer_version(id),
 issuer_id uuid NOT NULL, record_id text NOT NULL, record_revision integer NOT NULL CHECK(record_revision>0),
 document jsonb NOT NULL, digest text NOT NULL, signature text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(issuer_id,record_id,record_revision),
 CHECK(octet_length(document::text)<=16384), CHECK(digest=trustwork.admin_digest(document)),
 CHECK(signature ~ '^[A-Za-z0-9+/]{86}==$'), CHECK(document->>'evidenceMode'='synthetic'),
 CHECK(document->>'recordId'=record_id AND (document->>'recordRevision')::integer=record_revision),
 CHECK((document->>'issuerVersionId')::uuid=issuer_version_id)
);
CREATE TABLE trustwork.jurisdiction_proof_current (
 issuer_id uuid NOT NULL, record_id text NOT NULL, source_id uuid NOT NULL UNIQUE REFERENCES trustwork.jurisdiction_proof_record(id),
 revision integer NOT NULL CHECK(revision>0), PRIMARY KEY(issuer_id,record_id)
);
CREATE TABLE trustwork.jurisdiction_proof_revocation (
 source_id uuid PRIMARY KEY REFERENCES trustwork.jurisdiction_proof_record(id), authority jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE trustwork.jurisdiction_applicability_origin (
 evidence_id uuid PRIMARY KEY REFERENCES trustwork.jurisdiction_applicability(id),
 source_id uuid NOT NULL UNIQUE REFERENCES trustwork.jurisdiction_proof_record(id)
);
CREATE TABLE trustwork.jurisdiction_scoped_head (
 hub_id uuid NOT NULL REFERENCES trustwork.hub(id), subject_kind text NOT NULL, subject_id uuid NOT NULL,
 action text NOT NULL CHECK(action='send_quote'), context_kind text NOT NULL CHECK(context_kind='quote'), context_id uuid NOT NULL,
 applicability_id uuid NOT NULL UNIQUE REFERENCES trustwork.jurisdiction_applicability_origin(evidence_id), revision integer NOT NULL CHECK(revision>0),
 PRIMARY KEY(hub_id,subject_kind,subject_id,action,context_kind,context_id)
);

-- Minimal owning snapshot: no private geography, content, negotiations, account or budget values.
-- These helpers are maintenance/internal only; a runtime UUID is not authority to read their result.
CREATE FUNCTION trustwork.jurisdiction_owning_quote(p_quote uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE q trustwork.quote%ROWTYPE; r trustwork.rfq%ROWTYPE; p trustwork.project%ROWTYPE; material jsonb;
BEGIN
 PERFORM trustwork.jurisdiction_lock();
 SELECT * INTO q FROM trustwork.quote WHERE id=p_quote FOR SHARE;
 SELECT * INTO r FROM trustwork.rfq WHERE id=q.rfq_id FOR SHARE;
 SELECT * INTO p FROM trustwork.project WHERE id=r.project_id FOR SHARE;
 IF q.id IS NULL OR p.id IS NULL THEN RETURN NULL; END IF;
 material:=jsonb_build_object('quote',q.id,'quoteRevision',q.revision,'rfq',r.id,'rfqRevision',r.revision,
   'rfqVersion',r.current_version_id,'project',p.id,'projectRevision',p.revision,'projectStatus',p.status,
   'ownerPerson',p.owner_person_id,'ownerCompany',p.owner_company_id,
   'buyerPerson',q.buyer_person_id,'buyerCompany',q.buyer_company_id,'sellerPerson',q.seller_person_id,'sellerCompany',q.seller_company_id);
 RETURN jsonb_build_object('kind','quote','id',q.id,'revision',q.revision,'digest',trustwork.admin_digest(material));
END $$;
CREATE FUNCTION trustwork.jurisdiction_owning_subject(p_kind text,p_id uuid,p_quote uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE q trustwork.quote%ROWTYPE; project uuid; rev integer; epoch integer; material jsonb;
BEGIN
 PERFORM trustwork.jurisdiction_owning_quote(p_quote);
 SELECT * INTO q FROM trustwork.quote WHERE id=p_quote;
 SELECT project_id INTO project FROM trustwork.rfq WHERE id=q.rfq_id;
 IF p_kind='project' AND p_id=project THEN
   SELECT revision INTO rev FROM trustwork.project WHERE id=p_id FOR SHARE;
 ELSIF p_kind='company' AND p_id IN(q.buyer_company_id,q.seller_company_id) THEN
   SELECT revision,authz_epoch INTO rev,epoch FROM trustwork.company WHERE id=p_id FOR SHARE NOWAIT;
 ELSIF p_kind='person' AND (p_id IN(q.buyer_person_id,q.seller_person_id) OR EXISTS(
   SELECT 1 FROM trustwork.membership WHERE person_id=p_id AND company_id IN(q.buyer_company_id,q.seller_company_id)
    AND status='active' AND valid_from<=clock_timestamp() AND ended_at IS NULL AND 'company.deals.manage'=ANY(permissions))) THEN
   SELECT revision,authz_epoch INTO rev,epoch FROM trustwork.person WHERE id=p_id FOR SHARE NOWAIT;
 END IF;
 IF rev IS NULL THEN RETURN NULL; END IF;
 material:=jsonb_build_object('kind',p_kind,'id',p_id,'revision',rev,'epoch',epoch);
 RETURN material||jsonb_build_object('digest',trustwork.admin_digest(material));
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'current authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy';
END $$;

-- Use the owning modes lock, including absent heads. This serializes real config activation with consumption.
-- NOWAIT avoids the inverse admin/modes/HUB lock order; mode changes never need our private source tables.
CREATE FUNCTION trustwork.jurisdiction_demo_authority(p_hub uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE v trustwork.hub_config_version%ROWTYPE;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('trustwork.hub_config:' || p_hub::text || ':modes',0)) THEN
   RAISE EXCEPTION 'current mode authority is busy' USING ERRCODE='55P03',HINT='hubs.authority_busy'; END IF;
 SELECT v2.* INTO v FROM trustwork.hub_config_current c JOIN trustwork.hub_config_version v2 ON v2.id=c.version_id
   WHERE c.hub_id=p_hub AND c.domain='modes' AND v2.status='active' FOR SHARE OF c,v2;
 IF v.id IS NULL OR v.payload->>'dataMode'<>'demo' THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('versionId',v.id,'version',v.version,'digest',v.payload_digest);
END $$;

CREATE FUNCTION trustwork.jurisdiction_issuer_live(p_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE v trustwork.jurisdiction_issuer_version%ROWTYPE; a jsonb;
BEGIN
 SELECT * INTO v FROM trustwork.jurisdiction_issuer_version WHERE id=p_id;
 SELECT reviewer INTO a FROM trustwork.jurisdiction_issuer_activation WHERE version_id=p_id;
 RETURN coalesce(a IS NOT NULL AND EXISTS(SELECT 1 FROM trustwork.jurisdiction_issuer_current WHERE issuer_id=v.issuer_id AND version_id=p_id)
   AND NOT EXISTS(SELECT 1 FROM trustwork.jurisdiction_issuer_revocation WHERE version_id=p_id)
   AND (v.document->>'effectiveFrom')::timestamptz<=clock_timestamp() AND (v.document->>'effectiveUntil')::timestamptz>clock_timestamp()
   AND trustwork.jurisdiction_review_authority(v.proposer) AND trustwork.jurisdiction_review_authority(a),false);
END $$;
CREATE FUNCTION trustwork.jurisdiction_proof_matches(p jsonb) RETURNS boolean
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
   AND p->'subject'=s AND p->'context'=c AND p->>'action'='send_quote'
   AND v.document->'subjectKinds' ? (p->'subject'->>'kind') AND v.document->'actions' ? (p->>'action')
   AND v.document->'contextKinds' ? (p->'context'->>'kind')
   AND p->'coverage'->>'status'='complete' AND jsonb_array_length(p->'coverage'->'jurisdictions') BETWEEN 1 AND 20
   AND (p->'coverage'->'jurisdictions') <@ (v.document->'jurisdictions')
   AND p->'coverage'->>'competenceDigest'=v.document->>'competenceDigest'
   AND (p->'coverage'->>'basisDigest') ~ '^[a-f0-9]{64}$' AND p->'linkage'->>'kind'='verified_engine_subject'
   AND (p->'linkage'->>'evidenceDigest') ~ '^[a-f0-9]{64}$'
   AND (v.document->>'independence'='not_required' OR (p->'coverage'->>'independenceEvidenceDigest') ~ '^[a-f0-9]{64}$')
   AND (p->>'issuedAt')::timestamptz<=clock_timestamp() AND (p->>'effectiveFrom')::timestamptz<=clock_timestamp()
   AND (p->>'effectiveUntil')::timestamptz>clock_timestamp()
   AND (p->>'effectiveUntil')::timestamptz<=(v.document->>'effectiveUntil')::timestamptz
   AND (p->>'effectiveUntil')::timestamptz>(p->>'effectiveFrom')::timestamptz
   AND (p->>'effectiveUntil')::timestamptz<=(p->>'issuedAt')::timestamptz+interval '24 hours',false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION trustwork.jurisdiction_proof_live(p_source uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE r trustwork.jurisdiction_proof_record%ROWTYPE;
BEGIN
 SELECT * INTO r FROM trustwork.jurisdiction_proof_record WHERE id=p_source;
 RETURN coalesce(r.id IS NOT NULL AND EXISTS(SELECT 1 FROM trustwork.jurisdiction_proof_current WHERE source_id=r.id)
   AND NOT EXISTS(SELECT 1 FROM trustwork.jurisdiction_proof_revocation WHERE source_id=r.id)
   AND trustwork.jurisdiction_proof_matches(r.document),false);
END $$;

-- A failed post-write check aborts SQL even if a caller catches the repository exception.
CREATE FUNCTION trustwork.jurisdiction_require_proof_live(p_source uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
BEGIN
 IF NOT trustwork.jurisdiction_proof_live(p_source) THEN
  RAISE EXCEPTION 'source unavailable before commit' USING ERRCODE='23514'; END IF;
END $$;

-- Current pointers are derived from exact immutable records, even for direct maintenance SQL.
CREATE FUNCTION trustwork.jurisdiction_source_pointer_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE v trustwork.jurisdiction_issuer_version%ROWTYPE; r trustwork.jurisdiction_proof_record%ROWTYPE; d jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'history is retained' USING ERRCODE='23000'; END IF;
 IF TG_TABLE_NAME='jurisdiction_issuer_current' THEN
   SELECT * INTO v FROM trustwork.jurisdiction_issuer_version WHERE id=NEW.version_id;
   IF NEW.issuer_id<>v.issuer_id OR NOT EXISTS(SELECT 1 FROM trustwork.jurisdiction_issuer_activation WHERE version_id=v.id)
     OR EXISTS(SELECT 1 FROM trustwork.jurisdiction_issuer_revocation WHERE version_id=v.id)
     OR (TG_OP='UPDATE' AND (NEW.issuer_id<>OLD.issuer_id OR v.version<=(SELECT version FROM trustwork.jurisdiction_issuer_version WHERE id=OLD.version_id))) THEN
     RAISE EXCEPTION 'invalid issuer head' USING ERRCODE='23514'; END IF;
   NEW.epoch:=CASE WHEN TG_OP='INSERT' THEN 1 ELSE OLD.epoch+1 END;
 ELSIF TG_TABLE_NAME='jurisdiction_proof_current' THEN
   SELECT * INTO r FROM trustwork.jurisdiction_proof_record WHERE id=NEW.source_id;
   IF NEW.issuer_id<>r.issuer_id OR NEW.record_id<>r.record_id OR NOT trustwork.jurisdiction_proof_matches(r.document)
     OR (TG_OP='UPDATE' AND (NEW.issuer_id<>OLD.issuer_id OR NEW.record_id<>OLD.record_id OR r.record_revision<=(SELECT record_revision FROM trustwork.jurisdiction_proof_record WHERE id=OLD.source_id))) THEN
     RAISE EXCEPTION 'invalid source head' USING ERRCODE='23514'; END IF;
   NEW.revision:=CASE WHEN TG_OP='INSERT' THEN 1 ELSE OLD.revision+1 END;
 ELSE
   SELECT proof.document INTO d FROM trustwork.jurisdiction_applicability_origin o JOIN trustwork.jurisdiction_proof_record proof ON proof.id=o.source_id
     WHERE o.evidence_id=NEW.applicability_id AND trustwork.jurisdiction_proof_live(proof.id);
   IF d IS NULL OR NEW.hub_id::text<>d->>'originHubId' OR NEW.subject_kind<>d->'subject'->>'kind' OR NEW.subject_id::text<>d->'subject'->>'id'
     OR NEW.context_kind<>d->'context'->>'kind' OR NEW.context_id::text<>d->'context'->>'id' OR NEW.action<>d->>'action'
     OR NOT EXISTS(SELECT 1 FROM trustwork.jurisdiction_applicability_review x JOIN trustwork.jurisdiction_applicability_activation a ON a.review_id=x.id WHERE x.evidence_id=NEW.applicability_id)
     OR (TG_OP='UPDATE' AND ROW(NEW.hub_id,NEW.subject_kind,NEW.subject_id,NEW.action,NEW.context_kind,NEW.context_id) IS DISTINCT FROM ROW(OLD.hub_id,OLD.subject_kind,OLD.subject_id,OLD.action,OLD.context_kind,OLD.context_id)) THEN
     RAISE EXCEPTION 'invalid scoped evidence head' USING ERRCODE='23514'; END IF;
   NEW.revision:=CASE WHEN TG_OP='INSERT' THEN 1 ELSE OLD.revision+1 END;
 END IF;
 RETURN NEW;
END $$;

ALTER TABLE trustwork.jurisdiction_issuer_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_issuer_version FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_issuer_version FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_issuer_version FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER source_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_issuer_version FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER source_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_issuer_version FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

ALTER TABLE trustwork.jurisdiction_issuer_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_issuer_activation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_issuer_activation FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_issuer_activation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER source_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_issuer_activation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER source_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_issuer_activation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

ALTER TABLE trustwork.jurisdiction_issuer_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_issuer_current FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_issuer_current FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_issuer_current FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER source_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_issuer_current FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER source_pointer_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_issuer_current FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_source_pointer_guard();

ALTER TABLE trustwork.jurisdiction_issuer_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_issuer_revocation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_issuer_revocation FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_issuer_revocation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER source_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_issuer_revocation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER source_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_issuer_revocation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

ALTER TABLE trustwork.jurisdiction_proof_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_proof_record FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_proof_record FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_proof_record FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER source_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_proof_record FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER source_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_proof_record FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

ALTER TABLE trustwork.jurisdiction_proof_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_proof_current FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_proof_current FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_proof_current FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER source_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_proof_current FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER source_pointer_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_proof_current FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_source_pointer_guard();

ALTER TABLE trustwork.jurisdiction_proof_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_proof_revocation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_proof_revocation FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_proof_revocation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER source_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_proof_revocation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER source_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_proof_revocation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

ALTER TABLE trustwork.jurisdiction_applicability_origin ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_applicability_origin FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_applicability_origin FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_applicability_origin FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER source_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_applicability_origin FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER source_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_applicability_origin FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

ALTER TABLE trustwork.jurisdiction_scoped_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_scoped_head FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_scoped_head FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_scoped_head FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER source_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_scoped_head FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER source_pointer_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction_scoped_head FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_source_pointer_guard();

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

CREATE FUNCTION trustwork.jurisdiction_source_insert_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE r trustwork.jurisdiction_proof_record%ROWTYPE; e trustwork.jurisdiction_applicability%ROWTYPE; v trustwork.jurisdiction_issuer_version%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='jurisdiction_proof_record' THEN
  SELECT * INTO v FROM trustwork.jurisdiction_issuer_version WHERE id=NEW.issuer_version_id;
  IF NEW.issuer_id<>v.issuer_id OR NOT trustwork.jurisdiction_proof_matches(NEW.document) THEN
   RAISE EXCEPTION 'source unavailable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='jurisdiction_applicability_origin' THEN
  SELECT * INTO r FROM trustwork.jurisdiction_proof_record WHERE id=NEW.source_id;
  SELECT * INTO e FROM trustwork.jurisdiction_applicability WHERE id=NEW.evidence_id;
  IF NOT trustwork.jurisdiction_proof_live(r.id) OR e.document IS DISTINCT FROM jsonb_build_object(
   'subjectKind',r.document->'subject'->>'kind','subjectId',r.document->'subject'->>'id','hubId',r.document->>'originHubId',
   'jurisdictions',r.document->'coverage'->'jurisdictions','evidenceId','synthetic.authenticatedApplicability','evidenceDigest',r.digest,
   'effectiveFrom',r.document->>'effectiveFrom','effectiveUntil',r.document->>'effectiveUntil') THEN
   RAISE EXCEPTION 'exact source origin required' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO v FROM trustwork.jurisdiction_issuer_version WHERE id=NEW.version_id;
  IF NEW.reviewer->>'personId'=v.proposer->>'personId' OR NOT trustwork.jurisdiction_review_authority(v.proposer)
   OR NOT trustwork.jurisdiction_review_authority(NEW.reviewer) OR NEW.reviewer->>'permission'<>'admin.jurisdiction.issuers.activate'
   OR NEW.reviewer->>'hubId'<>v.hub_id::text THEN RAISE EXCEPTION 'independent issuer activation required' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_insert_guard BEFORE INSERT ON trustwork.jurisdiction_proof_record FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_source_insert_guard();
CREATE TRIGGER source_origin_guard BEFORE INSERT ON trustwork.jurisdiction_applicability_origin FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_source_insert_guard();
CREATE TRIGGER source_activation_guard BEFORE INSERT ON trustwork.jurisdiction_issuer_activation FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_source_insert_guard();
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
