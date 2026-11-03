-- PROV-001: generated and AI-edited images carry their IPTC digital source type in the file itself, and readers get
-- them only in that form. Replaces the test-only attachment table, which no route ever wrote and nothing deployed holds.
-- The request is a human decision through the first-party API; the bytes are changed by the worker, outside any
-- request transaction; the result is a new public file that goes through the ordinary scan.
DROP FUNCTION trustwork.provenance_attach_test_image(jsonb,jsonb);
DROP TABLE trustwork.provenance_image_attachment;

CREATE TABLE trustwork.provenance_image (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  provenance_id uuid NOT NULL REFERENCES trustwork.provenance_record(id),
  publication_id uuid NOT NULL REFERENCES trustwork.publication(id),
  -- Both files may be erased later. The row then keeps its digests and the reader simply loses the image.
  source_asset_id uuid REFERENCES trustwork.evidence_artifact(id) ON DELETE SET NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  digital_source_type text NOT NULL CHECK (digital_source_type IN ('trainedAlgorithmicMedia','compositeWithTrainedAlgorithmicMedia')),
  alt_text text NOT NULL CHECK (length(btrim(alt_text)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','carried','failed')),
  failure text CHECK (failure IN ('source_unavailable','hash_mismatch','unsupported_type','malformed_image','existing_credentials')),
  derived_asset_id uuid REFERENCES trustwork.evidence_artifact(id) ON DELETE SET NULL,
  derived_sha256 text CHECK (derived_sha256 ~ '^[a-f0-9]{64}$'),
  -- Only ever an explicitly unsigned test attachment: no signing authority exists, so nothing here claims C2PA validity.
  credentials jsonb CHECK (credentials IS NULL OR (credentials->>'format' = 'trustwork-provenance-test-attachment-1' AND credentials->>'assurance' = 'test_only_unsigned' AND credentials->>'c2paValid' = 'false')),
  requested_by uuid NOT NULL REFERENCES trustwork.person(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (provenance_id, source_asset_id),
  CHECK ((status = 'failed') = (failure IS NOT NULL)),
  CHECK ((status = 'carried') = (derived_sha256 IS NOT NULL)),
  CHECK ((status = 'pending') = (completed_at IS NULL))
);
CREATE INDEX provenance_image_publication_idx ON trustwork.provenance_image (publication_id);
CREATE INDEX provenance_image_derived_idx ON trustwork.provenance_image (derived_asset_id) WHERE derived_asset_id IS NOT NULL;
CREATE INDEX provenance_image_source_idx ON trustwork.provenance_image (source_asset_id) WHERE source_asset_id IS NOT NULL;

-- The request is immutable; the outcome is written once; a file link can only be cleared, by erasure.
CREATE FUNCTION trustwork.provenance_image_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.id <> OLD.id OR NEW.provenance_id <> OLD.provenance_id OR NEW.publication_id <> OLD.publication_id
    OR NEW.source_sha256 <> OLD.source_sha256 OR NEW.media_type <> OLD.media_type OR NEW.digital_source_type <> OLD.digital_source_type
    OR NEW.alt_text <> OLD.alt_text OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at
    OR (NEW.source_asset_id IS NOT NULL AND NEW.source_asset_id IS DISTINCT FROM OLD.source_asset_id)
    OR (OLD.status <> 'pending' AND (NEW.status <> OLD.status OR NEW.failure IS DISTINCT FROM OLD.failure OR NEW.derived_sha256 IS DISTINCT FROM OLD.derived_sha256
      OR NEW.credentials IS DISTINCT FROM OLD.credentials OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
      OR (NEW.derived_asset_id IS NOT NULL AND NEW.derived_asset_id IS DISTINCT FROM OLD.derived_asset_id))) THEN
    RAISE EXCEPTION 'an image record is immutable once decided' USING ERRCODE='23514',HINT='provenance.image_immutable';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_image_guard() FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE TRIGGER provenance_image_guard BEFORE UPDATE OR DELETE ON trustwork.provenance_image FOR EACH ROW EXECUTE FUNCTION trustwork.provenance_image_guard();

ALTER TABLE trustwork.provenance_image ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provenance_image FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.provenance_image TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY provenance_read ON trustwork.provenance_image FOR SELECT TO trustwork_app USING (trustwork.content_can_view(publication_id));
GRANT SELECT ON trustwork.provenance_image TO trustwork_app;

-- A publication's files were declared in FILE-001 but no one could attach any: `owns_resource` had no publication case.
-- Whoever may work on the piece may now attach to it: a holder of a publication right, or staff who publish or review
-- in its hub. Reading the file still follows the evidence policy, and readers get only the labelled copy.
CREATE OR REPLACE FUNCTION trustwork.owns_resource(p_resource_kind text, p_resource_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND CASE p_resource_kind
    WHEN 'project' THEN EXISTS (
      SELECT 1 FROM trustwork.project p WHERE p.id = p_resource_id
        AND (p.owner_person_id = trustwork.current_person_id() OR (p.owner_company_id IS NOT NULL AND p.owner_company_id = trustwork.current_company_id()))
    )
    WHEN 'rfq' THEN EXISTS (
      SELECT 1 FROM trustwork.rfq r WHERE r.id = p_resource_id
        AND trustwork.commerce_party_acts(r.owner_person_id, r.owner_company_id, 'company.deals.manage')
    )
    WHEN 'quote' THEN EXISTS (
      SELECT 1 FROM trustwork.quote q WHERE q.id = p_resource_id
        AND trustwork.commerce_party_acts(q.seller_person_id, q.seller_company_id, 'company.deals.manage')
    )
    WHEN 'publication' THEN EXISTS (
      SELECT 1 FROM trustwork.publication p WHERE p.id = p_resource_id
        AND (trustwork.content_right(p) IS NOT NULL OR trustwork.admin_has_any_permission(ARRAY['admin.publications.review', 'admin.publications.publish'], NULL, p.hub_id))
    )
    ELSE false END
$$;

-- A reader may be given the image: carried, its file scanned clean and not being deleted.
CREATE FUNCTION trustwork.provenance_image_ready(i trustwork.provenance_image) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT i.status='carried' AND EXISTS(SELECT 1 FROM trustwork.evidence_artifact a WHERE a.id=i.derived_asset_id
    AND a.scan_state='clean' AND a.sha256=i.derived_sha256 AND NOT trustwork.files_hidden(a.id))
$$;
REVOKE ALL ON FUNCTION trustwork.provenance_image_ready(trustwork.provenance_image) FROM PUBLIC,trustwork_app,trustwork_worker;

-- Same checks as 20261205100000, plus: a generated piece has at least one image, and every requested image is ready.
CREATE OR REPLACE FUNCTION trustwork.provenance_version_blocker(p trustwork.publication,v trustwork.publication_version) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE r trustwork.provenance_record := trustwork.provenance_version_record(v); o trustwork.publication_version; original trustwork.publication; candidate trustwork.publication_version := v;
BEGIN
 candidate.status := 'published';
 IF NOT trustwork.content_source_current_ok(p,candidate) THEN RETURN 'provenance_source_unavailable'; END IF;
 IF r.id IS NULL THEN RETURN 'provenance_required'; END IF;
 IF r.version_digest IS DISTINCT FROM trustwork.content_version_digest(v)
   OR (v.status='draft' AND r.version_revision<>v.revision) THEN RETURN 'provenance_binding_mismatch'; END IF;
 IF (v.assistant_assisted OR EXISTS(SELECT 1 FROM trustwork.publication_authorship a WHERE a.publication_id=p.id AND a.assistant_assisted)) AND r.kind='none'
 THEN RETURN 'provenance_disclosure_required'; END IF;
 IF ((v.treatment='translation' AND v.assistant_assisted) OR EXISTS(SELECT 1 FROM trustwork.edition_link l WHERE l.translation_publication_id=p.id AND l.machine_assisted))
   AND r.kind<>'machine_translation' THEN RETURN 'provenance_translation_required'; END IF;
 IF r.kind='machine_translation' THEN
   SELECT * INTO o FROM trustwork.publication_version WHERE id=r.original_version_id;
   SELECT * INTO original FROM trustwork.publication WHERE id=o.publication_id FOR SHARE;
   IF original.id IS NULL OR original.hub_id<>p.hub_id OR original.status='retracted' OR NOT trustwork.content_public_ok(original)
     OR o.content_digest IS DISTINCT FROM r.original_digest OR original.current_version_id<>o.id
     OR NOT trustwork.provenance_original_available(original.id,ARRAY[p.id])
     THEN RETURN 'provenance_original_unavailable'; END IF;
   IF NOT EXISTS(SELECT 1 FROM trustwork.provenance_review review WHERE review.provenance_id=r.id
     AND review.reviewer_person_id<>r.responsible_person_id AND review.reviewer_person_id<>v.drafted_by)
     THEN RETURN 'provenance_review_required'; END IF;
 END IF;
 IF v.status='draft' AND ((r.kind='generated' AND NOT EXISTS(SELECT 1 FROM trustwork.provenance_image i WHERE i.provenance_id=r.id))
   OR EXISTS(SELECT 1 FROM trustwork.provenance_image i WHERE i.provenance_id=r.id AND NOT trustwork.provenance_image_ready(i)))
 THEN RETURN 'provenance_image_required'; END IF;
 IF r.kind<>'none' AND v.status='draft' AND NOT trustwork.provenance_editor_credited(r) THEN RETURN 'provenance_credit_required'; END IF;
 RETURN NULL;
END $$;

-- Editorial office section 8.5 (L4): a generated image never stands where a reader expects documentation.
CREATE FUNCTION trustwork.provenance_image_request(p_ctx jsonb,p_input jsonb) RETURNS trustwork.provenance_image
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE r trustwork.provenance_record; p trustwork.publication; v trustwork.publication_version; a trustwork.evidence_artifact; result trustwork.provenance_image;
BEGIN
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=(p_input->>'provenanceId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  SELECT * INTO p FROM trustwork.publication WHERE id=r.publication_id FOR UPDATE;
  SELECT * INTO v FROM trustwork.publication_version WHERE id=r.version_id FOR UPDATE;
  PERFORM trustwork.provenance_authorize(p_ctx,p);
  IF v.status<>'draft' OR r.version_revision<>v.revision OR r.version_digest<>trustwork.content_version_digest(v)
    OR r.revision<>(SELECT max(revision) FROM trustwork.provenance_record WHERE version_id=v.id)
    OR p_input->'binding' IS DISTINCT FROM jsonb_build_object('publicationId',p.id,'version',v.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',r.version_digest)) THEN
    RAISE EXCEPTION 'image binding changed' USING ERRCODE='23514',HINT='provenance.binding_mismatch';
  END IF;
  IF r.kind NOT IN ('generated','ai_assisted') THEN
    RAISE EXCEPTION 'the record discloses no generated or edited image' USING ERRCODE='23514',HINT='provenance.disclosure_required';
  END IF;
  IF p.format IN ('news','company_post') OR p_input->'depictsRealPerson' IS DISTINCT FROM 'false'::jsonb OR p_input->'documentary' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'a generated image never stands as documentation' USING ERRCODE='23514',HINT='provenance.image_documentary';
  END IF;
  SELECT * INTO a FROM trustwork.evidence_artifact WHERE id=(p_input->>'assetId')::uuid AND parent_kind='publication' AND parent_id=p.id
    AND scan_state='clean' AND media_type IN ('image/jpeg','image/png','image/webp') AND NOT trustwork.files_hidden(id);
  IF NOT FOUND THEN RAISE EXCEPTION 'no clean image of this publication' USING ERRCODE='23514',HINT='provenance.image_binding_mismatch'; END IF;
  -- Readers get only the labelled copy, so the unlabelled upload must not already be public.
  IF a.classification='public' THEN RAISE EXCEPTION 'upload the source as a private file' USING ERRCODE='23514',HINT='provenance.image_source_public'; END IF;
  INSERT INTO trustwork.provenance_image(provenance_id,publication_id,source_asset_id,source_sha256,media_type,digital_source_type,alt_text,requested_by)
    VALUES(r.id,p.id,a.id,a.sha256,a.media_type,p_input->>'digitalSourceType',p_input->>'altText',trustwork.current_person_id()) RETURNING * INTO result;
  PERFORM trustwork.provenance_journal(p_ctx,r.id,p.id,'provenance.image_recorded',NULL);
  INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload)
    VALUES('provenance_image',result.id::text,1,'provenance.image_requested',jsonb_build_object('imageId',result.id));
  RETURN result;
END;
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_image_request(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_image_request(jsonb,jsonb) TO trustwork_app;

-- Worker entry points: identifiers, digests and the storage key, no person.
CREATE FUNCTION trustwork.provenance_image_target(p_id uuid)
RETURNS TABLE (status text, storage_key text, bytes bigint, source_sha256 text, media_type text, digital_source_type text, provenance_id uuid, asset_id uuid, publication_id uuid, version integer, version_digest text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT i.status, a.storage_key, a.bytes, i.source_sha256, i.media_type, i.digital_source_type, i.provenance_id, i.source_asset_id, i.publication_id, v.version, r.version_digest
  FROM trustwork.provenance_image i JOIN trustwork.provenance_record r ON r.id=i.provenance_id JOIN trustwork.publication_version v ON v.id=r.version_id
  LEFT JOIN trustwork.evidence_artifact a ON a.id=i.source_asset_id AND a.scan_state='clean' AND NOT trustwork.files_hidden(a.id)
  WHERE i.id=p_id
$$;
REVOKE ALL ON FUNCTION trustwork.provenance_image_target(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_image_target(uuid) TO trustwork_worker;

-- The labelled bytes become a public file of the same owner and publication, pending the ordinary scan. A file whose
-- bytes did not change (it already carried the type) still gets its own row: the source stays private.
CREATE FUNCTION trustwork.provenance_image_complete(p_id uuid,p_key text,p_sha256 text,p_bytes bigint,p_credentials jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE i trustwork.provenance_image; a trustwork.evidence_artifact; v_id uuid;
BEGIN
  SELECT * INTO i FROM trustwork.provenance_image WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR i.status<>'pending' THEN RETURN false; END IF;
  SELECT * INTO a FROM trustwork.evidence_artifact WHERE id=i.source_asset_id;
  IF NOT FOUND THEN
    UPDATE trustwork.provenance_image SET status='failed',failure='source_unavailable',completed_at=now() WHERE id=p_id;
    RETURN false;
  END IF;
  INSERT INTO trustwork.evidence_artifact(owner_person_id,owner_company_id,parent_kind,parent_id,classification,storage_key,sha256,bytes,media_type,uploaded_by)
    VALUES(a.owner_person_id,a.owner_company_id,'publication',i.publication_id,'public',p_key,p_sha256,p_bytes,i.media_type,i.requested_by) RETURNING id INTO v_id;
  INSERT INTO trustwork.file_artifact_state(artifact_id,origin,upload_completed_at) VALUES(v_id,'upload',now());
  UPDATE trustwork.provenance_image SET status='carried',derived_asset_id=v_id,derived_sha256=p_sha256,credentials=p_credentials,completed_at=now() WHERE id=p_id;
  INSERT INTO trustwork.audit_event(action,object_kind,object_id,basis) VALUES('provenance.image_carried','provenance_image',p_id::text,jsonb_build_object('artifactId',v_id));
  INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload)
    VALUES('evidence_artifact',v_id::text,1,'file.uploaded',jsonb_build_object('artifactId',v_id));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_image_complete(uuid,text,text,bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_image_complete(uuid,text,text,bigint,jsonb) TO trustwork_worker;

CREATE FUNCTION trustwork.provenance_image_fail(p_id uuid,p_failure text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  UPDATE trustwork.provenance_image SET status='failed',failure=p_failure,completed_at=now() WHERE id=p_id AND status='pending';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO trustwork.audit_event(action,object_kind,object_id,basis) VALUES('provenance.image_failed','provenance_image',p_id::text,jsonb_build_object('failure',p_failure));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_image_fail(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_image_fail(uuid,text) TO trustwork_worker;

-- Same projection as 20261120100001, with the images of the exact record.
CREATE OR REPLACE FUNCTION trustwork.provenance_delivery_metadata(p_hub uuid, p_pub uuid, p_version integer, p_channel text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE p trustwork.publication; v trustwork.publication_version; r trustwork.provenance_record; o trustwork.publication_version;
 original trustwork.publication; result jsonb; credits jsonb; images jsonb; review trustwork.provenance_review;
BEGIN
  IF p_channel NOT IN ('web','feed','pdf') OR p_channel IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO p FROM trustwork.publication WHERE id=p_pub AND hub_id=p_hub;
  IF NOT FOUND OR NOT trustwork.content_public_ok(p) THEN RETURN NULL; END IF;
  SELECT * INTO v FROM trustwork.publication_version WHERE publication_id=p_pub AND version=p_version;
  IF v.status IS DISTINCT FROM 'published' OR NOT trustwork.content_source_current_ok(p,v) THEN RETURN NULL; END IF;
  SELECT * INTO r FROM trustwork.provenance_record WHERE version_id=v.id ORDER BY revision DESC LIMIT 1;
  IF r.id IS NULL OR r.version_digest IS DISTINCT FROM v.content_digest THEN RETURN jsonb_build_object('availability','unavailable','machineAssisted',v.assistant_assisted OR EXISTS(SELECT 1 FROM trustwork.publication_authorship WHERE publication_id=p.id AND assistant_assisted) OR EXISTS(SELECT 1 FROM trustwork.edition_link WHERE translation_publication_id=p.id AND machine_assisted)); END IF;
  SELECT * INTO review FROM trustwork.provenance_review WHERE provenance_id=r.id;
  IF r.original_version_id IS NOT NULL THEN
    SELECT * INTO o FROM trustwork.publication_version WHERE id=r.original_version_id;
    SELECT * INTO original FROM trustwork.publication WHERE id=o.publication_id;
    IF original.id IS NULL OR original.hub_id<>p_hub OR original.status='retracted' OR NOT trustwork.content_public_ok(original) OR NOT trustwork.content_source_current_ok(original,o) OR NOT trustwork.provenance_original_available(original.id,ARRAY[p_pub]) THEN RETURN NULL; END IF;
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
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'digitalSourceType',i.digital_source_type,'altText',i.alt_text) ORDER BY i.requested_at,i.id),'[]') INTO images
    FROM trustwork.provenance_image i WHERE i.provenance_id=r.id AND trustwork.provenance_image_ready(i);
  result := jsonb_build_object('availability','recorded','binding',jsonb_build_object('publicationId',p.id,'version',v.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',r.version_digest)),'revision',r.revision,'kind',r.kind,'roles',r.roles,'evidence',r.evidence,
    'machineAssisted',r.kind<>'none' OR v.assistant_assisted,'credits',credits,'images',images);
  IF o.id IS NOT NULL THEN result:=result || jsonb_build_object('translation',jsonb_build_object('reviewed',true,'originalPublicationId',original.id,
    'originalVersion',o.version,'originalDigest',o.content_digest,'originalLanguage',o.language,'originalFormat',original.format,'currentOriginalVersion',original.current_version,'stale',original.current_version_id<>o.id)); END IF;
  RETURN result;
END $$;

-- What the public image route may stream: only an image of a version the reader is currently shown.
CREATE FUNCTION trustwork.provenance_image_delivery(p_hub uuid,p_pub uuid,p_image uuid)
RETURNS TABLE (storage_key text, sha256 text, bytes bigint, media_type text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE i trustwork.provenance_image; v trustwork.publication_version; p trustwork.publication; metadata jsonb;
BEGIN
  SELECT * INTO i FROM trustwork.provenance_image WHERE id=p_image AND publication_id=p_pub;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT pv.* INTO v FROM trustwork.provenance_record r JOIN trustwork.publication_version pv ON pv.id=r.version_id WHERE r.id=i.provenance_id;
  SELECT * INTO p FROM trustwork.publication WHERE id=p_pub AND hub_id=p_hub;
  IF NOT FOUND OR p.status='retracted' THEN RETURN; END IF;
  metadata := trustwork.provenance_delivery_metadata(p_hub,p_pub,v.version,'web');
  IF metadata IS NULL OR NOT coalesce(metadata->'images','[]') @> jsonb_build_array(jsonb_build_object('id',i.id)) THEN RETURN; END IF;
  RETURN QUERY SELECT a.storage_key,a.sha256,a.bytes,a.media_type FROM trustwork.evidence_artifact a WHERE a.id=i.derived_asset_id;
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_image_delivery(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_image_delivery(uuid,uuid,uuid) TO trustwork_app;
