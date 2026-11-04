-- PROV-001 / CNT-001: a correction keeps at least the disclosure of the version it corrects.
--
-- The check on a declaration and the release blocker looked at the version in hand and the assistance flags only. A
-- correction draft is a new version with its flags cleared, so it could declare `none` and go out: the piece lost its
-- AI label and, since `none` needs no credit, its named responsible person. The design has no command that corrects a
-- disclosure as such, so nothing here lifts one: a piece that really was mislabelled stays labelled. Forward-only;
-- versions already published and their digests stay as they are.

-- `ai_assisted` is the weakest statement and any other disclosure includes it. `generated` and `machine_translation`
-- each say something the other does not, so each is kept as it is. Keep in step with ProvenanceKindSchema.
CREATE FUNCTION trustwork.provenance_disclosure_kept(p_prior text, p_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_prior = 'none' OR p_kind = p_prior OR (p_prior = 'ai_assisted' AND p_kind <> 'none')
$$;
REVOKE ALL ON FUNCTION trustwork.provenance_disclosure_kept(text,text) FROM PUBLIC,trustwork_app,trustwork_worker;

-- What the corrected version told readers: its record, or for a version published without one, its assistance flag.
CREATE FUNCTION trustwork.provenance_corrected_disclosure(v trustwork.publication_version) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE prior trustwork.publication_version; kind text;
BEGIN
  IF v.correction_of IS NULL THEN RETURN 'none'; END IF;
  SELECT * INTO prior FROM trustwork.publication_version WHERE publication_id=v.publication_id AND version=v.correction_of;
  kind := coalesce((trustwork.provenance_version_record(prior)).kind,'none');
  RETURN CASE WHEN kind='none' AND prior.assistant_assisted THEN 'ai_assisted' ELSE kind END;
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_corrected_disclosure(trustwork.publication_version) FROM PUBLIC,trustwork_app,trustwork_worker;

-- Same checks as 20261205100001, plus: a correction being released keeps the disclosure of what it corrects.
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
 IF v.status='draft' AND NOT trustwork.provenance_disclosure_kept(trustwork.provenance_corrected_disclosure(v),r.kind)
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

-- Same command as 20261120100002, refusing the declaration itself, so nobody credits and reviews a record that could
-- never be released. The blocker above stays the rule; this is the early answer.
CREATE OR REPLACE FUNCTION trustwork.provenance_declare(p_ctx jsonb, p_input jsonb) RETURNS trustwork.provenance_record
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE v_me uuid := trustwork.admin_require_caller(); v_pub trustwork.publication; v_version trustwork.publication_version;
 v_original trustwork.publication_version; v_row trustwork.provenance_record; v_revision integer; v_roles text[];
BEGIN
  -- Stable order also serializes a declaration with correction or removal of its original.
  PERFORM 1 FROM trustwork.publication WHERE id IN ((p_input#>>'{binding,publicationId}')::uuid,(p_input#>>'{original,publicationId}')::uuid) ORDER BY id FOR UPDATE;
  SELECT * INTO v_pub FROM trustwork.publication WHERE id=(p_input#>>'{binding,publicationId}')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  SELECT * INTO v_version FROM trustwork.publication_version WHERE publication_id=v_pub.id AND version=(p_input#>>'{binding,version}')::integer FOR UPDATE;
  PERFORM trustwork.provenance_authorize(p_ctx,v_pub);
  IF v_version.id IS NULL OR p_input#>>'{binding,digest,algorithm}' IS DISTINCT FROM 'trustwork-digest-1'
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
  IF NOT trustwork.provenance_disclosure_kept(trustwork.provenance_corrected_disclosure(v_version),p_input->>'kind') THEN
    RAISE EXCEPTION 'a correction keeps the disclosure of the version it corrects' USING ERRCODE='23514',HINT='provenance.disclosure_required';
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
END;
END $$;
