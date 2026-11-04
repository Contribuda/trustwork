-- PROV-001: a source deleted while its image job runs yields no public labelled copy.
--
-- provenance_image_target leaves out a source with a deletion request, but the job then reads, labels and stores the
-- bytes outside any transaction. provenance_image_complete only noticed a source row that was already gone, so a
-- deletion requested in that window produced a new public file of an image its owner had just withdrawn. The source
-- row is now locked first: every deletion and erasure takes it FOR UPDATE, so one that is still in flight is waited
-- for and seen here, and one that comes later finds a recorded outcome. Forward-only.
CREATE OR REPLACE FUNCTION trustwork.provenance_image_complete(p_id uuid,p_key text,p_sha256 text,p_bytes bigint,p_credentials jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE i trustwork.provenance_image; a trustwork.evidence_artifact; v_id uuid;
BEGIN
  SELECT * INTO i FROM trustwork.provenance_image WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR i.status<>'pending' THEN RETURN false; END IF;
  SELECT * INTO a FROM trustwork.evidence_artifact WHERE id=i.source_asset_id FOR SHARE;
  IF NOT FOUND OR trustwork.files_hidden(a.id) THEN
    PERFORM trustwork.provenance_image_fail(p_id,'source_unavailable');
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
