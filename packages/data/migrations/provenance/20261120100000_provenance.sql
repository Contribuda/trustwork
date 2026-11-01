-- PROV-001: append-only evidence and narrowly scoped credit consent. No publishing policy is added.
-- Shared CNT publication hooks and public wire integration are deliberately not installed before CNT-003 merges.
CREATE TABLE trustwork.provenance_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  publication_id uuid NOT NULL REFERENCES trustwork.publication(id),
  version_id uuid NOT NULL,
  version_digest text NOT NULL CHECK (version_digest ~ '^[a-f0-9]{64}$'),
  version_revision integer NOT NULL CHECK (version_revision > 0),
  revision integer NOT NULL CHECK (revision > 0),
  responsible_person_id uuid NOT NULL REFERENCES trustwork.person(id),
  kind text NOT NULL CHECK (kind IN ('none','ai_assisted','machine_translation','generated')),
  roles text[] NOT NULL,
  evidence text NOT NULL CHECK (evidence = 'human_declaration'),
  original_version_id uuid REFERENCES trustwork.publication_version(id),
  original_digest text CHECK (original_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (version_id, publication_id) REFERENCES trustwork.publication_version(id, publication_id),
  UNIQUE(version_id, revision),
  CHECK ((kind = 'machine_translation') = (original_version_id IS NOT NULL)),
  CHECK ((original_version_id IS NULL) = (original_digest IS NULL)),
  CHECK (original_version_id IS DISTINCT FROM version_id),
  CHECK (kind <> 'none' OR cardinality(roles) = 0),
  CHECK (roles <@ ARRAY['editorial_scout','editorial_collector','editorial_researcher','editorial_writer','editorial_fact_checker',
    'editorial_translator','editorial_post_editor','editorial_desk','editorial_layout','editorial_designer','editorial_illustrator',
    'editorial_photo_research','editorial_metadata','editorial_distribution','editorial_curator','editorial_licence_checker',
    'editorial_accessibility','editorial_corrections_watch','editorial_knowledge']::text[])
);
CREATE TABLE trustwork.provenance_review (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  provenance_id uuid NOT NULL UNIQUE REFERENCES trustwork.provenance_record(id),
  reviewer_person_id uuid NOT NULL REFERENCES trustwork.person(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trustwork.provenance_credit_consent (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  provenance_id uuid NOT NULL REFERENCES trustwork.provenance_record(id),
  person_id uuid NOT NULL REFERENCES trustwork.person(id),
  role text NOT NULL CHECK (role IN ('responsible_editor','translation_reviewer')),
  credit text NOT NULL CHECK (length(btrim(credit)) BETWEEN 1 AND 200),
  channels text[] NOT NULL CHECK (cardinality(channels) BETWEEN 1 AND 3 AND channels <@ ARRAY['web','feed','pdf']::text[]),
  notice_version text NOT NULL CHECK (notice_version = 'provenance.credit.v1'),
  session_id uuid NOT NULL REFERENCES trustwork.session(id),
  request_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trustwork.provenance_credit_revocation (
  consent_id uuid PRIMARY KEY REFERENCES trustwork.provenance_credit_consent(id),
  person_id uuid NOT NULL REFERENCES trustwork.person(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  revoked_at timestamptz NOT NULL DEFAULT now()
);
-- Private image attachment records preserve input byte and publication bindings, without claiming standards validity.
CREATE TABLE trustwork.provenance_image_attachment (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  provenance_id uuid NOT NULL REFERENCES trustwork.provenance_record(id),
  asset_id uuid NOT NULL REFERENCES trustwork.evidence_artifact(id),
  asset_sha256 text NOT NULL CHECK (asset_sha256 ~ '^[a-f0-9]{64}$'),
  digital_source_type text NOT NULL CHECK (digital_source_type IN ('trainedAlgorithmicMedia','compositeWithTrainedAlgorithmicMedia')),
  attachment jsonb NOT NULL CHECK (attachment->>'format' = 'trustwork-provenance-test-attachment-1' AND attachment->>'assurance' = 'test_only_unsigned' AND attachment->>'c2paValid' = 'false'),
  recorded_by uuid NOT NULL REFERENCES trustwork.person(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provenance_id, asset_id, asset_sha256)
);

CREATE FUNCTION trustwork.provenance_session(p_ctx jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE v_me uuid := trustwork.admin_require_caller();
BEGIN
  -- Lock the actual session against concurrent revocation. Client-provided identities are never used.
  PERFORM 1 FROM trustwork.session WHERE id = (p_ctx->>'sessionId')::uuid AND person_id = v_me
    AND revoked_at IS NULL AND idle_expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp() FOR SHARE;
  IF NOT FOUND OR coalesce(length(p_ctx->>'requestId'),0) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'first-party session required' USING ERRCODE='42501', HINT='provenance.first_party_required';
  END IF;
  RETURN v_me;
END $$;

CREATE FUNCTION trustwork.provenance_authorize(p_ctx jsonb, p_pub trustwork.publication, p_review boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE v_actor trustwork.admin_actor;
BEGIN
  PERFORM trustwork.provenance_session(p_ctx);
  IF p_pub.owner_kind = 'editorial' AND p_ctx->>'elevationId' IS NULL THEN
    RAISE EXCEPTION 'elevation required' USING ERRCODE='42501',HINT='admin.elevation_required';
  END IF;
  IF p_pub.owner_kind = 'editorial' OR p_ctx->>'elevationId' IS NOT NULL THEN
    v_actor := trustwork.content_staff(p_ctx, CASE WHEN p_review THEN ARRAY['admin.publications.review'] ELSE ARRAY['admin.publications.publish'] END, p_pub.hub_id);
    PERFORM trustwork.admin_record(v_actor,p_ctx,NULL,p_pub.hub_id,'provenance.authorized','publication',p_pub.id,NULL,NULL);
  ELSE
    PERFORM trustwork.content_require_right(p_pub,'publish');
  END IF;
END $$;
CREATE FUNCTION trustwork.provenance_journal(p_ctx jsonb, p_id uuid, p_pub uuid, p_action text, p_reason text) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,request_id,reason,basis)
    VALUES(trustwork.current_person_id(),p_action,'provenance',p_id::text,p_ctx->>'requestId',p_reason,jsonb_build_object('publicationId',p_pub));
  INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload)
    VALUES('provenance',p_id::text,1,p_action,jsonb_build_object('publicationId',p_pub,'provenanceId',p_id));
END $$;

CREATE FUNCTION trustwork.provenance_declare(p_ctx jsonb, p_input jsonb) RETURNS trustwork.provenance_record
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_me uuid := trustwork.provenance_session(p_ctx); v_pub trustwork.publication; v_version trustwork.publication_version;
 v_original trustwork.publication_version; v_row trustwork.provenance_record; v_revision integer; v_roles text[];
BEGIN
  -- Stable order also serializes a declaration with correction or removal of its original.
  PERFORM 1 FROM trustwork.publication WHERE id IN ((p_input#>>'{binding,publicationId}')::uuid,(p_input#>>'{original,publicationId}')::uuid) ORDER BY id FOR UPDATE;
  SELECT * INTO v_pub FROM trustwork.publication WHERE id=(p_input#>>'{binding,publicationId}')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  PERFORM trustwork.provenance_authorize(p_ctx,v_pub);
  SELECT * INTO v_version FROM trustwork.publication_version WHERE publication_id=v_pub.id AND version=(p_input#>>'{binding,version}')::integer FOR UPDATE;
  IF NOT FOUND OR p_input#>>'{binding,digest,algorithm}' IS DISTINCT FROM 'trustwork-digest-1'
     OR p_input#>>'{binding,digest,value}' IS DISTINCT FROM trustwork.content_version_digest(v_version) THEN
    RAISE EXCEPTION 'version binding mismatch' USING ERRCODE='23514',HINT='provenance.binding_mismatch';
  END IF;
  SELECT coalesce(max(revision),0) INTO v_revision FROM trustwork.provenance_record WHERE version_id=v_version.id;
  IF (p_input->>'expectedRevision')::integer IS DISTINCT FROM v_revision THEN
    RAISE EXCEPTION 'revision changed' USING ERRCODE='40001',HINT='content.revision_conflict';
  END IF;
  IF p_input->>'evidence' IS DISTINCT FROM 'human_declaration' THEN
    RAISE EXCEPTION 'runtime evidence unavailable' USING ERRCODE='23514',HINT='provenance.evidence_unavailable';
  END IF;
  SELECT array_agg(x) INTO v_roles FROM jsonb_array_elements_text(p_input->'roles') x;
  v_roles := coalesce(v_roles,'{}');
  IF cardinality(v_roles) <> (SELECT count(DISTINCT x) FROM unnest(v_roles) x) THEN RAISE EXCEPTION 'duplicate roles' USING ERRCODE='23514'; END IF;
  IF ((v_version.treatment='translation' AND v_version.assistant_assisted) OR EXISTS(SELECT 1 FROM trustwork.edition_link WHERE translation_publication_id=v_pub.id AND machine_assisted)) AND p_input->>'kind' IS DISTINCT FROM 'machine_translation' THEN
    RAISE EXCEPTION 'translation binding required' USING ERRCODE='23514',HINT='provenance.translation_required';
  END IF;
  IF p_input->>'kind' = 'none' AND (v_version.assistant_assisted OR EXISTS(SELECT 1 FROM trustwork.publication_authorship WHERE publication_id=v_pub.id AND assistant_assisted) OR EXISTS(SELECT 1 FROM trustwork.provenance_record WHERE version_id=v_version.id AND kind <> 'none')) THEN
    RAISE EXCEPTION 'machine disclosure cannot be removed' USING ERRCODE='23514',HINT='provenance.disclosure_required';
  END IF;
  IF p_input->>'kind' = 'machine_translation' THEN
    SELECT v.* INTO v_original FROM trustwork.publication_version v JOIN trustwork.publication p ON p.id=v.publication_id
      WHERE p.id=(p_input#>>'{original,publicationId}')::uuid AND v.version=(p_input#>>'{original,version}')::integer
        AND p.hub_id=v_pub.hub_id AND p.id<>v_pub.id AND v.language<>v_version.language AND v.status='published'
        AND trustwork.content_public_ok(p) AND p.status<>'retracted' AND p.current_version_id=v.id;
    IF NOT FOUND OR p_input#>>'{original,digest,algorithm}' IS DISTINCT FROM 'trustwork-digest-1'
      OR p_input#>>'{original,digest,value}' IS DISTINCT FROM v_original.content_digest THEN
      RAISE EXCEPTION 'original binding mismatch' USING ERRCODE='23514',HINT='provenance.original_unavailable';
    END IF;
  ELSIF p_input->'original' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'unexpected original' USING ERRCODE='23514';
  END IF;
  INSERT INTO trustwork.provenance_record(publication_id,version_id,version_digest,version_revision,revision,responsible_person_id,kind,roles,evidence,original_version_id,original_digest,reason)
    VALUES(v_pub.id,v_version.id,trustwork.content_version_digest(v_version),v_version.revision,v_revision+1,v_me,p_input->>'kind',v_roles,'human_declaration',v_original.id,v_original.content_digest,p_input->>'reason') RETURNING * INTO v_row;
  PERFORM trustwork.provenance_journal(p_ctx,v_row.id,v_pub.id,'provenance.declared',v_row.reason);
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.provenance_review_translation(p_ctx jsonb, p_input jsonb) RETURNS trustwork.provenance_review
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_me uuid := trustwork.provenance_session(p_ctx); r trustwork.provenance_record; v trustwork.publication_version;
 o trustwork.publication_version; p trustwork.publication; original trustwork.publication; result trustwork.provenance_review;
BEGIN
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=(p_input->>'provenanceId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  SELECT * INTO o FROM trustwork.publication_version WHERE id=r.original_version_id;
  PERFORM 1 FROM trustwork.publication WHERE id IN(r.publication_id,o.publication_id) ORDER BY id FOR UPDATE;
  SELECT * INTO p FROM trustwork.publication WHERE id=r.publication_id;
  PERFORM trustwork.provenance_authorize(p_ctx,p,true);
  SELECT * INTO v FROM trustwork.publication_version WHERE id=r.version_id FOR UPDATE;
  SELECT * INTO original FROM trustwork.publication WHERE id=o.publication_id;
  IF r.kind<>'machine_translation' OR original.id IS NULL OR NOT trustwork.content_public_ok(original) OR original.status='retracted'
    OR original.current_version_id<>o.id OR o.content_digest<>r.original_digest THEN
    RAISE EXCEPTION 'original changed or withheld' USING ERRCODE='23514',HINT='provenance.original_unavailable';
  END IF;
  IF r.revision<>(SELECT max(revision) FROM trustwork.provenance_record WHERE version_id=v.id)
    OR r.version_digest<>trustwork.content_version_digest(v) OR (v.status='draft' AND r.version_revision<>v.revision)
    OR p_input->'binding' IS DISTINCT FROM jsonb_build_object('publicationId',p.id,'version',v.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',r.version_digest))
    OR p_input->'original' IS DISTINCT FROM jsonb_build_object('publicationId',original.id,'version',o.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',o.content_digest)) THEN
    RAISE EXCEPTION 'review binding changed' USING ERRCODE='23514',HINT='provenance.binding_mismatch';
  END IF;
  IF v_me IN(r.responsible_person_id,v.drafted_by) OR EXISTS(SELECT 1 FROM trustwork.edition_link WHERE translation_publication_id=p.id AND translator_person_id=v_me) THEN
    RAISE EXCEPTION 'reviewer must differ from translator and responsible person' USING ERRCODE='42501',HINT='content.self_review';
  END IF;
  INSERT INTO trustwork.provenance_review(provenance_id,reviewer_person_id,reason) VALUES(r.id,v_me,p_input->>'reason') RETURNING * INTO result;
  PERFORM trustwork.provenance_journal(p_ctx,r.id,p.id,'provenance.reviewed',result.reason);
  RETURN result;
END $$;

CREATE FUNCTION trustwork.provenance_consent(p_ctx jsonb, p_input jsonb) RETURNS trustwork.provenance_credit_consent
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_me uuid := trustwork.provenance_session(p_ctx); r trustwork.provenance_record; result trustwork.provenance_credit_consent; v_channels text[];
BEGIN
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=(p_input->>'provenanceId')::uuid;
  IF NOT FOUND OR NOT (CASE p_input->>'role' WHEN 'responsible_editor' THEN r.responsible_person_id=v_me
    WHEN 'translation_reviewer' THEN EXISTS(SELECT 1 FROM trustwork.provenance_review WHERE provenance_id=r.id AND reviewer_person_id=v_me) ELSE false END) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found';
  END IF;
  IF p_input->'informedConsent' IS DISTINCT FROM 'true'::jsonb OR NOT EXISTS(SELECT 1 FROM trustwork.person WHERE id=v_me AND display_name=p_input->>'credit') THEN
    RAISE EXCEPTION 'explicit current credit required' USING ERRCODE='23514',HINT='provenance.consent_required';
  END IF;
  SELECT array_agg(x) INTO v_channels FROM jsonb_array_elements_text(p_input->'channels') x;
  IF cardinality(v_channels) <> (SELECT count(DISTINCT x) FROM unnest(v_channels) x) THEN RAISE EXCEPTION 'duplicate channels' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM trustwork.provenance_record WHERE id=r.id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM trustwork.provenance_credit_consent c WHERE c.provenance_id=r.id AND c.person_id=v_me AND c.role=p_input->>'role' AND c.channels && v_channels
    AND NOT EXISTS(SELECT 1 FROM trustwork.provenance_credit_revocation revoked WHERE revoked.consent_id=c.id)) THEN
    RAISE EXCEPTION 'revoke overlapping consent before replacing it' USING ERRCODE='23514',HINT='provenance.consent_overlap';
  END IF;
  INSERT INTO trustwork.provenance_credit_consent(provenance_id,person_id,role,credit,channels,notice_version,session_id,request_id)
    VALUES(r.id,v_me,p_input->>'role',p_input->>'credit',v_channels,p_input->>'noticeVersion',(p_ctx->>'sessionId')::uuid,p_ctx->>'requestId') RETURNING * INTO result;
  PERFORM trustwork.provenance_journal(p_ctx,r.id,r.publication_id,'provenance.credit_granted',NULL);
  RETURN result;
END $$;
CREATE FUNCTION trustwork.provenance_revoke(p_ctx jsonb, p_id uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_me uuid := trustwork.provenance_session(p_ctx); c trustwork.provenance_credit_consent; r trustwork.provenance_record;
BEGIN
  SELECT * INTO c FROM trustwork.provenance_credit_consent WHERE id=p_id AND person_id=v_me FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=c.provenance_id;
  INSERT INTO trustwork.provenance_credit_revocation(consent_id,person_id,reason) VALUES(c.id,v_me,p_reason) ON CONFLICT DO NOTHING;
  PERFORM trustwork.provenance_journal(p_ctx,r.id,r.publication_id,'provenance.credit_revoked',p_reason);
  RETURN c.id;
END $$;

-- Internal owning projection seam. No anonymous API route or shared CNT wire schema is added here.
-- Current CNT public authority is composed; after CNT-003 it also applies its live source revocation guards.
CREATE FUNCTION trustwork.provenance_delivery_metadata(p_hub uuid, p_pub uuid, p_version integer, p_channel text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE p trustwork.publication; v trustwork.publication_version; r trustwork.provenance_record; o trustwork.publication_version;
 original trustwork.publication; result jsonb; credits jsonb; review trustwork.provenance_review;
BEGIN
  IF p_channel NOT IN ('web','feed','pdf') OR p_channel IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO p FROM trustwork.publication WHERE id=p_pub AND hub_id=p_hub;
  IF NOT FOUND OR p.status='retracted' OR trustwork.content_public_version(p_hub,p_pub,p_version) IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v FROM trustwork.publication_version WHERE publication_id=p_pub AND version=p_version;
  SELECT * INTO r FROM trustwork.provenance_record WHERE version_id=v.id AND version_digest=v.content_digest ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('availability','unavailable','machineAssisted',v.assistant_assisted OR EXISTS(SELECT 1 FROM trustwork.publication_authorship WHERE publication_id=p.id AND assistant_assisted) OR EXISTS(SELECT 1 FROM trustwork.edition_link WHERE translation_publication_id=p.id AND machine_assisted)); END IF;
  SELECT * INTO review FROM trustwork.provenance_review WHERE provenance_id=r.id;
  IF r.original_version_id IS NOT NULL THEN
    SELECT * INTO o FROM trustwork.publication_version WHERE id=r.original_version_id;
    SELECT * INTO original FROM trustwork.publication WHERE id=o.publication_id;
    IF original.status='retracted' OR trustwork.content_public_version(p_hub,original.id,o.version) IS NULL THEN RETURN NULL; END IF;
    IF review.id IS NULL THEN RETURN NULL; END IF;
  END IF;
  SELECT coalesce(jsonb_object_agg(role,credit),'{}') INTO credits FROM (
    SELECT DISTINCT ON(c.role) c.role,c.credit FROM trustwork.provenance_credit_consent c
      JOIN trustwork.person person ON person.id=c.person_id
      WHERE c.provenance_id=r.id AND p_channel=ANY(c.channels)
        AND NOT EXISTS(SELECT 1 FROM trustwork.provenance_credit_revocation revoked WHERE revoked.consent_id=c.id)
        AND person.display_name=c.credit
      ORDER BY c.role,c.granted_at DESC,c.id DESC
  ) allowed;
  result := jsonb_build_object('availability','recorded','revision',r.revision,'kind',r.kind,'roles',r.roles,'evidence',r.evidence,
    'machineAssisted',r.kind<>'none' OR v.assistant_assisted,'credits',credits);
  IF o.id IS NOT NULL THEN result:=result || jsonb_build_object('translation',jsonb_build_object('reviewed',true,'originalPublicationId',original.id,
    'originalVersion',o.version,'originalDigest',o.content_digest,'currentOriginalVersion',original.current_version,'stale',original.current_version_id<>o.id)); END IF;
  RETURN result;
END $$;

-- Callable guard for the provenance-owned publication adapter. Shared CNT hook installation waits for #473.
CREATE FUNCTION trustwork.provenance_require_publishable(p_ctx jsonb,p_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.provenance_record; v trustwork.publication_version; p trustwork.publication; original trustwork.publication;
BEGIN
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  SELECT p2.* INTO original FROM trustwork.publication p2 JOIN trustwork.publication_version o ON o.publication_id=p2.id WHERE o.id=r.original_version_id;
  PERFORM 1 FROM trustwork.publication WHERE id IN(r.publication_id,original.id) ORDER BY id FOR UPDATE;
  SELECT * INTO p FROM trustwork.publication WHERE id=r.publication_id;
  PERFORM trustwork.provenance_authorize(p_ctx,p);
  SELECT * INTO v FROM trustwork.publication_version WHERE id=r.version_id FOR UPDATE;
  IF v.status<>'draft' OR v.revision<>r.version_revision OR trustwork.content_version_digest(v)<>r.version_digest
     OR r.revision<>(SELECT max(revision) FROM trustwork.provenance_record WHERE version_id=v.id) THEN
    RAISE EXCEPTION 'provenance binding changed' USING ERRCODE='23514',HINT='provenance.binding_mismatch';
  END IF;
  IF r.kind='machine_translation' AND (NOT EXISTS(SELECT 1 FROM trustwork.provenance_review WHERE provenance_id=r.id)
    OR NOT EXISTS(SELECT 1 FROM trustwork.publication op WHERE op.id=original.id AND op.current_version_id=r.original_version_id AND op.status<>'retracted'
      AND trustwork.content_public_ok(op))) THEN
    RAISE EXCEPTION 'exact translation review required' USING ERRCODE='23514',HINT='provenance.review_required';
  END IF;
END $$;

ALTER TABLE trustwork.provenance_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provenance_record FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.provenance_record TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE TRIGGER provenance_record_immutable BEFORE UPDATE OR DELETE ON trustwork.provenance_record FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
GRANT SELECT ON trustwork.provenance_record TO trustwork_app;

ALTER TABLE trustwork.provenance_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provenance_review FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.provenance_review TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE TRIGGER provenance_review_immutable BEFORE UPDATE OR DELETE ON trustwork.provenance_review FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
GRANT SELECT ON trustwork.provenance_review TO trustwork_app;

ALTER TABLE trustwork.provenance_credit_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provenance_credit_consent FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.provenance_credit_consent TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE TRIGGER provenance_credit_consent_immutable BEFORE UPDATE OR DELETE ON trustwork.provenance_credit_consent FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
GRANT SELECT ON trustwork.provenance_credit_consent TO trustwork_app;

ALTER TABLE trustwork.provenance_credit_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provenance_credit_revocation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.provenance_credit_revocation TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE TRIGGER provenance_credit_revocation_immutable BEFORE UPDATE OR DELETE ON trustwork.provenance_credit_revocation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
GRANT SELECT ON trustwork.provenance_credit_revocation TO trustwork_app;

ALTER TABLE trustwork.provenance_image_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provenance_image_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.provenance_image_attachment TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE TRIGGER provenance_image_attachment_immutable BEFORE UPDATE OR DELETE ON trustwork.provenance_image_attachment FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
GRANT SELECT ON trustwork.provenance_image_attachment TO trustwork_app;
CREATE POLICY provenance_read ON trustwork.provenance_record FOR SELECT TO trustwork_app USING (trustwork.content_can_view(publication_id));
CREATE POLICY provenance_read ON trustwork.provenance_review FOR SELECT TO trustwork_app USING (EXISTS(SELECT 1 FROM trustwork.provenance_record r WHERE r.id=provenance_id));
CREATE POLICY provenance_read ON trustwork.provenance_image_attachment FOR SELECT TO trustwork_app USING (EXISTS(SELECT 1 FROM trustwork.provenance_record r WHERE r.id=provenance_id));
CREATE POLICY provenance_read ON trustwork.provenance_credit_consent FOR SELECT TO trustwork_app USING (person_id=trustwork.current_person_id());
CREATE POLICY provenance_read ON trustwork.provenance_credit_revocation FOR SELECT TO trustwork_app USING (person_id=trustwork.current_person_id());
REVOKE ALL ON FUNCTION trustwork.provenance_session(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION trustwork.provenance_authorize(jsonb,trustwork.publication,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION trustwork.provenance_journal(jsonb,uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION trustwork.provenance_declare(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_declare(jsonb,jsonb) TO trustwork_app;
REVOKE ALL ON FUNCTION trustwork.provenance_review_translation(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_review_translation(jsonb,jsonb) TO trustwork_app;
REVOKE ALL ON FUNCTION trustwork.provenance_consent(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_consent(jsonb,jsonb) TO trustwork_app;
REVOKE ALL ON FUNCTION trustwork.provenance_revoke(jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_revoke(jsonb,uuid,text) TO trustwork_app;
REVOKE ALL ON FUNCTION trustwork.provenance_delivery_metadata(uuid,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_delivery_metadata(uuid,uuid,integer,text) TO trustwork_app;
REVOKE ALL ON FUNCTION trustwork.provenance_require_publishable(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_require_publishable(jsonb,uuid) TO trustwork_app;

-- This route persists only an explicitly unsigned test sidecar. Real signing remains unavailable.
CREATE FUNCTION trustwork.provenance_attach_test_image(p_ctx jsonb,p_attachment jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.provenance_record; p trustwork.publication; v trustwork.publication_version; i jsonb:=p_attachment->'input'; result uuid;
BEGIN
  PERFORM trustwork.provenance_session(p_ctx);
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=(i->>'provenanceId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  SELECT * INTO p FROM trustwork.publication WHERE id=r.publication_id FOR UPDATE;
  PERFORM trustwork.provenance_authorize(p_ctx,p);
  SELECT * INTO v FROM trustwork.publication_version WHERE id=r.version_id;
  IF r.kind NOT IN ('generated','ai_assisted') OR p_attachment->>'format' IS DISTINCT FROM 'trustwork-provenance-test-attachment-1'
    OR p_attachment->>'assurance' IS DISTINCT FROM 'test_only_unsigned' OR p_attachment->>'c2paValid' IS DISTINCT FROM 'false'
    OR i->>'depictsRealPerson' IS DISTINCT FROM 'false' OR i->>'documentary' IS DISTINCT FROM 'false'
    OR p_attachment->>'attachmentSha256' IS DISTINCT FROM trustwork.admin_digest(i)
    OR i->'binding' IS DISTINCT FROM jsonb_build_object('publicationId',p.id,'version',v.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',r.version_digest))
    OR r.version_digest<>trustwork.content_version_digest(v) OR r.revision<>(SELECT max(revision) FROM trustwork.provenance_record WHERE version_id=v.id)
    OR NOT EXISTS(SELECT 1 FROM trustwork.evidence_artifact a WHERE a.id=(i->>'assetId')::uuid AND a.sha256=i->>'assetSha256'
      AND a.parent_kind='publication' AND a.parent_id=p.id AND a.scan_state='clean' AND a.media_type LIKE 'image/%') THEN
    RAISE EXCEPTION 'image binding mismatch' USING ERRCODE='23514',HINT='provenance.image_binding_mismatch';
  END IF;
  INSERT INTO trustwork.provenance_image_attachment(provenance_id,asset_id,asset_sha256,digital_source_type,attachment,recorded_by)
    VALUES(r.id,(i->>'assetId')::uuid,i->>'assetSha256',i->>'digitalSourceType',p_attachment,trustwork.current_person_id()) RETURNING id INTO result;
  PERFORM trustwork.provenance_journal(p_ctx,r.id,p.id,'provenance.test_image_attached',NULL);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_attach_test_image(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_attach_test_image(jsonb,jsonb) TO trustwork_app;
