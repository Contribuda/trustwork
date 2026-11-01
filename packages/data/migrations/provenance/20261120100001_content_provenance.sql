-- PROV-001 / CNT-001 / CNT-003: mandatory publication guards and exact delivery provenance.
-- No autonomous publishing policy, signing authority, or retroactive evidence is introduced.
CREATE FUNCTION trustwork.provenance_version_record(v trustwork.publication_version) RETURNS trustwork.provenance_record
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
 SELECT r FROM trustwork.provenance_record r WHERE r.version_id=v.id ORDER BY r.revision DESC LIMIT 1
$$;

CREATE FUNCTION trustwork.provenance_version_blocker(p trustwork.publication,v trustwork.publication_version) RETURNS text
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
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_publication_base_blockers(p_pub trustwork.publication, p_version trustwork.publication_version) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_out text[] := '{}';
  v_src jsonb;
  v_uses jsonb;
  v_assisted boolean := p_version.assistant_assisted OR EXISTS (SELECT 1 FROM trustwork.publication_authorship a WHERE a.publication_id = p_pub.id AND a.assistant_assisted);
BEGIN
  IF p_pub.format = 'news' AND jsonb_array_length(p_version.source_refs) = 0 THEN
    v_out := array_append(v_out, 'news_needs_source');
  END IF;
  IF p_pub.format = 'news' AND p_version.event_time IS NULL THEN
    v_out := array_append(v_out, 'news_needs_event_time');
  END IF;
  IF p_version.treatment = 'translation' AND p_version.language = p_pub.original_language AND NOT EXISTS (SELECT 1 FROM trustwork.edition_link l WHERE l.translation_publication_id = p_pub.id) THEN
    v_out := array_append(v_out, 'translation_needs_original');
  END IF;
  FOR v_src IN SELECT value FROM jsonb_array_elements(p_version.source_refs) LOOP
    IF jsonb_typeof(v_src) <> 'object' OR coalesce(v_src ->> 'uri', '') = '' OR coalesce(v_src ->> 'name', '') = '' OR coalesce(v_src ->> 'observedAt', '') = '' THEN
      v_out := array_append(v_out, 'source_incomplete');
      CONTINUE;
    END IF;
    CONTINUE WHEN v_src ->> 'kind' = 'own_reporting';
    v_uses := v_src -> 'allowedUses';
    IF coalesce(v_src ->> 'license', '') = '' OR jsonb_typeof(v_uses) IS DISTINCT FROM 'object' THEN
      v_out := array_append(v_out, 'source_licence_missing');
      CONTINUE;
    END IF;
    IF NOT coalesce((v_uses ->> 'displayHeadlineAndLink')::boolean, false) THEN v_out := array_append(v_out, 'licence_forbids_display'); END IF;
    IF p_version.treatment = 'summary' AND NOT coalesce((v_uses ->> 'displaySummary')::boolean, false) THEN v_out := array_append(v_out, 'licence_forbids_summary'); END IF;
    IF p_version.treatment = 'rewrite' AND NOT coalesce((v_uses ->> 'rewriteWithAttribution')::boolean, false) THEN v_out := array_append(v_out, 'licence_forbids_rewrite'); END IF;
    IF p_version.treatment = 'translation' AND NOT coalesce((v_uses ->> 'translate')::boolean, false) THEN v_out := array_append(v_out, 'licence_forbids_translation'); END IF;
    IF v_assisted AND NOT coalesce((v_uses ->> 'sendToModelProviders')::boolean, false) THEN v_out := array_append(v_out, 'licence_forbids_model_use'); END IF;
  END LOOP;
  RETURN ARRAY(SELECT DISTINCT b FROM unnest(v_out) b ORDER BY b);
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_publication_blockers(p_pub trustwork.publication,p_version trustwork.publication_version) RETURNS text[]
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE result text[] := trustwork.content_publication_base_blockers(p_pub,p_version); blocker text;
BEGIN
 blocker := trustwork.provenance_version_blocker(p_pub,p_version);
 IF blocker IS NOT NULL THEN result := array_append(result,blocker); END IF;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_source_current_ok(p trustwork.publication, v trustwork.publication_version) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE ref jsonb; item trustwork.source_item; uses jsonb; matches integer;
BEGIN
  IF p.id IS NULL OR v.publication_id IS DISTINCT FROM p.id OR v.status <> 'published'
    OR cardinality(trustwork.content_publication_base_blockers(p, v)) <> 0 THEN RETURN false; END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(v.source_refs) LOOP
    CONTINUE WHEN ref ->> 'kind' = 'own_reporting' AND NOT EXISTS (SELECT 1 FROM trustwork.source_item i
      WHERE i.publication_id = p.id AND i.url = ref ->> 'uri');
    -- Count all linked candidates, including inactive ones: never choose whichever currently grants more.
    SELECT count(*) INTO matches FROM trustwork.source_item i
      WHERE i.publication_id = p.id AND i.url = ref ->> 'uri';
    IF matches <> 1 THEN RETURN false; END IF;
    SELECT i.* INTO item FROM trustwork.source_item i
      JOIN trustwork.source s ON s.id = i.source_id AND s.hub_id = i.hub_id
      JOIN trustwork.import_batch b ON b.id = i.import_batch_id AND b.source_id = s.id AND b.hub_id = i.hub_id
      WHERE i.publication_id = p.id AND i.hub_id = p.hub_id AND i.url = ref ->> 'uri'
        AND i.status = 'drafted' AND s.status = 'active' AND b.status = 'activated';
    IF NOT FOUND THEN RETURN false; END IF;
    uses := trustwork.sources_uses_and(ref -> 'allowedUses', trustwork.sources_effective_uses(item));
    IF NOT trustwork.sources_use(uses, 'displayHeadlineAndLink')
      OR (v.treatment = 'summary' AND NOT trustwork.sources_use(uses, 'displaySummary'))
      OR (v.treatment = 'rewrite' AND NOT trustwork.sources_use(uses, 'rewriteWithAttribution'))
      OR (v.treatment = 'translation' AND NOT trustwork.sources_use(uses, 'translate'))
      OR (v.treatment = 'original_reporting' AND NOT trustwork.sources_use(uses, 'storeFullText'))
      OR ((v.assistant_assisted OR EXISTS (SELECT 1 FROM trustwork.publication_authorship a
            WHERE a.publication_id = p.id AND a.assistant_assisted)) AND NOT trustwork.sources_use(uses, 'sendToModelProviders'))
      THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_correct(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_draft jsonb, p_note text, p_reason text) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
  v_from integer := v_row.current_version;
  v_version trustwork.publication_version%ROWTYPE;
BEGIN
  IF v_row.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.correct'], v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, 'publish');
  END IF;
  IF v_row.status NOT IN ('published', 'corrected') THEN
    RAISE EXCEPTION 'only a published publication is corrected' USING ERRCODE = 'check_violation', HINT = CASE WHEN v_row.status = 'retracted' THEN 'content.retracted' ELSE 'content.not_published' END;
  END IF;
  IF length(coalesce(p_note, '')) NOT BETWEEN 1 AND 500 OR length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a correction carries a reader-visible note and a reason' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.correction_note_required';
  END IF;
  SELECT * INTO v_version FROM trustwork.publication_version WHERE publication_id=v_row.id AND status='draft' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prepare and declare the correction before release' USING ERRCODE='23514',HINT='content.provenance_required';
  END IF;
  IF v_version.correction_of IS DISTINCT FROM v_from OR v_version.correction_note IS DISTINCT FROM p_note
    OR v_version.title IS DISTINCT FROM p_draft->>'title' OR v_version.body IS DISTINCT FROM p_draft->>'body'
    OR v_version.language IS DISTINCT FROM p_draft->>'language' OR v_version.source_refs IS DISTINCT FROM p_draft->'sourceRefs'
    OR v_version.treatment IS DISTINCT FROM p_draft->>'treatment' OR v_version.event_time IS DISTINCT FROM (p_draft->>'eventTime')::timestamptz
    OR v_version.assistant_assisted IS DISTINCT FROM coalesce((p_draft->>'assistantAssisted')::boolean,false) THEN
    RAISE EXCEPTION 'prepared correction changed' USING ERRCODE='23514',HINT='content.provenance_binding_mismatch';
  END IF;
  v_row := trustwork.content_release_version(v_row, v_version.id, v_me, 'corrected');
  INSERT INTO trustwork.correction (hub_id, subject_kind, publication_id, from_version, to_version, reason, corrected_by)
  VALUES (v_row.hub_id, 'publication', v_row.id, v_from, v_version.version, p_reason, v_me);
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'publication.corrected', 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.provenance_prepare_correction(p_ctx jsonb,p_pub uuid,p_expected integer,p_draft jsonb,p_note text) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE p trustwork.publication := trustwork.content_lock(p_pub,p_expected); v trustwork.publication_version;
BEGIN
 PERFORM trustwork.provenance_authorize(p_ctx,p);
 IF p.status NOT IN ('published','corrected') OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 THEN
   RAISE EXCEPTION 'published original and correction note required' USING ERRCODE='23514',HINT='content.not_published';
 END IF;
 v := trustwork.content_write_draft(p,p_draft,p.current_version,p_note);
 UPDATE trustwork.publication SET updated_at=now() WHERE id=p.id RETURNING * INTO p;
 PERFORM trustwork.provenance_journal(p_ctx,v.id,p.id,'provenance.correction_prepared',p_note);
 RETURN p;
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_prepare_correction(jsonb,uuid,integer,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_prepare_correction(jsonb,uuid,integer,jsonb,text) TO trustwork_app;

CREATE FUNCTION trustwork.provenance_bundle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE pin record; p trustwork.publication; v trustwork.publication_version; blocker text;
BEGIN
 IF NEW.status<>'released' OR OLD.status='released' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='issue_revision' THEN
   FOR pin IN SELECT publication_id AS pub,publication_version_id AS version FROM trustwork.issue_item WHERE issue_revision_id=NEW.id ORDER BY publication_id LOOP
     SELECT * INTO p FROM trustwork.publication WHERE id=pin.pub FOR UPDATE;
     SELECT * INTO v FROM trustwork.publication_version WHERE id=pin.version;
     blocker:=trustwork.provenance_version_blocker(p,v);
     IF blocker IS NOT NULL THEN RAISE EXCEPTION 'publication provenance required' USING ERRCODE='23514',HINT='content.'||blocker; END IF;
   END LOOP;
 ELSE
   FOR pin IN SELECT local_publication_id AS pub,local_version_id AS version FROM trustwork.magazine_digest_item WHERE digest_id=NEW.id ORDER BY local_publication_id LOOP
     SELECT * INTO p FROM trustwork.publication WHERE id=pin.pub FOR UPDATE;
     SELECT * INTO v FROM trustwork.publication_version WHERE id=pin.version;
     blocker:=trustwork.provenance_version_blocker(p,v);
     IF blocker IS NOT NULL THEN RAISE EXCEPTION 'publication provenance required' USING ERRCODE='23514',HINT='content.'||blocker; END IF;
   END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER provenance_issue_release BEFORE UPDATE OF status ON trustwork.issue_revision FOR EACH ROW EXECUTE FUNCTION trustwork.provenance_bundle_guard();
CREATE TRIGGER provenance_digest_release BEFORE UPDATE OF status ON trustwork.magazine_digest FOR EACH ROW EXECUTE FUNCTION trustwork.provenance_bundle_guard();
REVOKE ALL ON FUNCTION trustwork.provenance_version_record(trustwork.publication_version),
 trustwork.provenance_version_blocker(trustwork.publication,trustwork.publication_version),
 trustwork.content_publication_base_blockers(trustwork.publication,trustwork.publication_version),
 trustwork.provenance_bundle_guard() FROM PUBLIC,trustwork_app,trustwork_worker;

-- Bounded recursive availability; cycles in legacy/changed declarations are withheld rather than traversed forever.
CREATE FUNCTION trustwork.provenance_original_available(p_id uuid,p_seen uuid[]) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE p trustwork.publication; v trustwork.publication_version; r trustwork.provenance_record; o trustwork.publication_version;
BEGIN
 IF p_id=ANY(p_seen) OR cardinality(p_seen)>=32 THEN RETURN false; END IF;
 SELECT * INTO p FROM trustwork.publication WHERE id=p_id;
 SELECT * INTO v FROM trustwork.publication_version WHERE id=p.current_version_id;
 IF p.id IS NULL OR p.status='retracted' OR NOT trustwork.content_public_ok(p) OR NOT trustwork.content_source_current_ok(p,v) THEN RETURN false; END IF;
 r:=trustwork.provenance_version_record(v);
 IF r.kind='machine_translation' THEN
   SELECT * INTO o FROM trustwork.publication_version WHERE id=r.original_version_id;
   RETURN r.version_digest=v.content_digest AND EXISTS(SELECT 1 FROM trustwork.provenance_review WHERE provenance_id=r.id)
     AND trustwork.provenance_original_available(o.publication_id,array_append(p_seen,p_id));
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_original_available(uuid,uuid[]) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE OR REPLACE FUNCTION trustwork.provenance_delivery_metadata(p_hub uuid, p_pub uuid, p_version integer, p_channel text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE p trustwork.publication; v trustwork.publication_version; r trustwork.provenance_record; o trustwork.publication_version;
 original trustwork.publication; result jsonb; credits jsonb; review trustwork.provenance_review;
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
  result := jsonb_build_object('availability','recorded','binding',jsonb_build_object('publicationId',p.id,'version',v.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',r.version_digest)),'revision',r.revision,'kind',r.kind,'roles',r.roles,'evidence',r.evidence,
    'machineAssisted',r.kind<>'none' OR v.assistant_assisted,'credits',credits);
  IF o.id IS NOT NULL THEN result:=result || jsonb_build_object('translation',jsonb_build_object('reviewed',true,'originalPublicationId',original.id,
    'originalVersion',o.version,'originalDigest',o.content_digest,'originalLanguage',o.language,'originalFormat',original.format,'currentOriginalVersion',original.current_version,'stale',original.current_version_id<>o.id)); END IF;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION trustwork.content_version_json(p_version trustwork.publication_version, p_with_body boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('version', p_version.version, 'title', p_version.title, 'body', CASE WHEN p_with_body AND p_version.treatment <> 'headline_link' THEN p_version.body END, 'language', p_version.language,
    'sourceRefs', p_version.source_refs, 'treatment', p_version.treatment, 'eventTime', trustwork.content_iso(p_version.event_time),
    'publishedAt', trustwork.content_iso(p_version.published_at), 'correctionOf', p_version.correction_of, 'correctionNote', p_version.correction_note,
    'contentDigest', p_version.content_digest, 'assistantAssisted', p_version.assistant_assisted, 'provenance',trustwork.provenance_delivery_metadata((SELECT hub_id FROM trustwork.publication WHERE id=p_version.publication_id),p_version.publication_id,p_version.version,'web'))
$$;
CREATE OR REPLACE FUNCTION trustwork.content_public_current_ok(p trustwork.publication) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.content_public_ok(p) AND EXISTS (SELECT 1 FROM trustwork.publication_version v
    WHERE v.id = p.current_version_id AND trustwork.content_source_current_ok(p, v) AND trustwork.provenance_delivery_metadata(p.hub_id,p.id,v.version,'web') IS NOT NULL)
$$;
CREATE OR REPLACE FUNCTION trustwork.content_public_version(p_hub uuid, p_pub uuid, p_version integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.content_version_json(v, p.status <> 'retracted')
  FROM trustwork.publication p JOIN trustwork.publication_version v ON v.publication_id = p.id AND v.version = p_version AND v.status = 'published'
  WHERE p.id = p_pub AND p.hub_id = p_hub AND trustwork.content_public_current_ok(p) AND trustwork.content_source_current_ok(p, v) AND trustwork.provenance_delivery_metadata(p_hub,p_pub,p_version,'web') IS NOT NULL
$$;
CREATE OR REPLACE FUNCTION trustwork.content_public_feed(p_hub uuid, p_format text, p_topic text, p_before timestamptz, p_before_id uuid, p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.at DESC, x.id DESC), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('id', p.id::text, 'format', p.format, 'articleFormat', p.article_format, 'status', p.status, 'firstPublishedAt', trustwork.content_iso(p.first_published_at),
             'provenance',trustwork.provenance_delivery_metadata(p.hub_id,p.id,v.version,'feed'),'title', v.title, 'eventTime', trustwork.content_iso(v.event_time), 'currentVersion', v.version, 'corrected', p.status = 'corrected', 'retracted', p.status = 'retracted',
             'sources', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', s ->> 'name', 'kind', s ->> 'kind', 'uri', s ->> 'uri')), '[]'::jsonb) FROM jsonb_array_elements(v.source_refs) s),
             'topics', (SELECT coalesce(jsonb_agg(t.code ORDER BY t.code), '[]'::jsonb) FROM trustwork.publication_topic pt JOIN trustwork.taxonomy_term t ON t.id = pt.term_id
                        WHERE pt.publication_id = p.id AND pt.removed_at IS NULL),
             'credits', (SELECT coalesce(jsonb_agg(a.credit ORDER BY a.position), '[]'::jsonb) FROM trustwork.publication_authorship a WHERE a.publication_id = p.id AND (a.author_person_id IS NULL OR a.author_person_id = p.owner_person_id OR EXISTS (SELECT 1 FROM trustwork.profiles_consented_mentions(p.id, ARRAY[a.author_person_id]))))) AS j,
           p.first_published_at AS at, p.id
    FROM trustwork.publication p JOIN trustwork.publication_version v ON v.id = p.current_version_id
    WHERE p.hub_id = p_hub AND trustwork.content_public_current_ok(p) AND (p_format IS NULL OR p.format = p_format)
      AND (p_topic IS NULL OR EXISTS (SELECT 1 FROM trustwork.publication_topic pt JOIN trustwork.taxonomy_term t ON t.id = pt.term_id WHERE pt.publication_id = p.id AND pt.removed_at IS NULL AND t.code = p_topic))
      AND (p_before IS NULL OR (p.first_published_at, p.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
    ORDER BY p.first_published_at DESC, p.id DESC
    LIMIT greatest(1, least(coalesce(p_limit, 20), 100))) x
$$;
CREATE OR REPLACE FUNCTION trustwork.content_issue_json(p_issue trustwork.issue, p_revision trustwork.issue_revision) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p_issue.id::text, 'revision', p_issue.revision, 'number', p_issue.number, 'date', to_char(p_issue.issue_date, 'YYYY-MM-DD'), 'theme', p_issue.theme, 'status', p_issue.status,
    'coverAssetId', p_issue.cover_asset_id::text, 'editorLetterPublicationId', p_issue.editor_letter_publication_id::text,
    'edition', p_revision.edition, 'currentEdition', p_issue.current_edition, 'digest', p_revision.digest, 'releasedAt', trustwork.content_iso(p_revision.released_at),
    'correctionNote', p_revision.correction_note,
    'items', (SELECT coalesce(jsonb_agg(CASE WHEN p.hub_id = p_issue.hub_id AND trustwork.content_public_current_ok(p) AND trustwork.content_source_current_ok(p, v) AND trustwork.provenance_delivery_metadata(p.hub_id,p.id,v.version,'web') IS NOT NULL THEN
                jsonb_build_object('position', i.position, 'section', i.section, 'publicationId', i.publication_id::text, 'publicationVersion', v.version, 'withheld', false,
                                   'provenance',trustwork.provenance_delivery_metadata(p.hub_id,p.id,v.version,'web'),'title', v.title, 'format', p.format, 'articleFormat', p.article_format, 'currentVersion', p.current_version,
                                   'corrected', p.current_version > v.version, 'retracted', p.status = 'retracted')
              ELSE jsonb_build_object('position', i.position, 'section', i.section, 'publicationId', i.publication_id::text, 'publicationVersion', v.version, 'withheld', true) END
              ORDER BY i.position), '[]'::jsonb)
              FROM trustwork.issue_item i JOIN trustwork.publication p ON p.id = i.publication_id JOIN trustwork.publication_version v ON v.id = i.publication_version_id
              WHERE i.issue_revision_id = p_revision.id),
    'renderArtifacts', (SELECT coalesce(jsonb_agg(jsonb_build_object('format', r.format, 'hash', r.sha256, 'sourceEdition', p_revision.edition, 'rendererVersion', r.renderer_version)
                                                  ORDER BY r.requested_at), '[]'::jsonb)
                        FROM trustwork.render_artifact r WHERE r.issue_revision_id = p_revision.id AND r.status = 'rendered'),
    'corrections', (SELECT coalesce(jsonb_agg(jsonb_build_object('fromEdition', c.from_version, 'toEdition', c.to_version, 'reason', c.reason, 'correctedAt', trustwork.content_iso(c.corrected_at))
                                              ORDER BY c.corrected_at), '[]'::jsonb)
                    FROM trustwork.correction c WHERE c.issue_id = p_issue.id))
$$;
CREATE OR REPLACE FUNCTION trustwork.content_public_wall(p_kind text, p_owner uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', w.id::text, 'publicationId', p.id::text, 'pinned', w.pinned, 'position', w.position,
                                               'version', coalesce(v.version, p.current_version), 'followsCurrent', w.publication_version_id IS NULL,
                                               'provenance',trustwork.provenance_delivery_metadata(p.hub_id,p.id,coalesce(v.version,c.version),'web'),'title', coalesce(v.title, c.title), 'format', p.format, 'currentVersion', p.current_version,
                                               'corrected', p.status = 'corrected', 'retracted', p.status = 'retracted',
                                               'correctionNote', (SELECT x.correction_note FROM trustwork.publication_version x WHERE x.id = p.current_version_id))
                            ORDER BY w.pinned DESC, w.position), '[]'::jsonb)
  FROM trustwork.wall_reference w JOIN trustwork.publication p ON p.id = w.publication_id
  JOIN trustwork.publication_version c ON c.id = p.current_version_id
  LEFT JOIN trustwork.publication_version v ON v.id = w.publication_version_id
  WHERE w.removed_at IS NULL AND w.wall_kind = p_kind AND coalesce(w.wall_person_id, w.wall_company_id) = p_owner AND trustwork.content_public_current_ok(p) AND trustwork.content_source_current_ok(p, coalesce(v, c)) AND trustwork.provenance_delivery_metadata(p.hub_id,p.id,coalesce(v.version,c.version),'web') IS NOT NULL
$$;
CREATE OR REPLACE FUNCTION trustwork.content_public_digest(p_hub uuid, p_digest uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT jsonb_build_object('id', d.id::text, 'title', d.title, 'period', d.period, 'releasedAt', trustwork.content_iso(d.released_at),
    'items', (SELECT coalesce(jsonb_agg(CASE WHEN p.hub_id = p_hub AND trustwork.content_public_current_ok(p) AND trustwork.content_source_current_ok(p, v) AND trustwork.provenance_delivery_metadata(p.hub_id,p.id,v.version,'web') IS NOT NULL THEN
                jsonb_build_object('position', i.position, 'homeNode', i.home_node, 'globalId', i.global_id, 'version', i.version, 'licence', i.licence, 'display', i.display,
                                   'provenance',trustwork.provenance_delivery_metadata(p.hub_id,p.id,v.version,'web'),'title', i.title, 'body', CASE WHEN i.display = 'full' AND p.status <> 'retracted' AND v.treatment <> 'headline_link' THEN v.body END, 'withheld', false)
              ELSE jsonb_build_object('position', i.position, 'homeNode', i.home_node, 'globalId', i.global_id, 'version', i.version, 'withheld', true) END ORDER BY i.position), '[]'::jsonb)
              FROM trustwork.magazine_digest_item i LEFT JOIN trustwork.publication p ON p.id = i.local_publication_id LEFT JOIN trustwork.publication_version v ON v.id = i.local_version_id
              WHERE i.digest_id = d.id))
  FROM trustwork.magazine_digest d WHERE d.id = p_digest AND d.hub_id = p_hub AND d.status = 'released'
$$;
CREATE OR REPLACE FUNCTION trustwork.content_render_snapshot(p_revision uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE r trustwork.issue_revision; i trustwork.issue; pin record; p trustwork.publication; v trustwork.publication_version;
  items jsonb := '[]'::jsonb; pub jsonb;
BEGIN
  SELECT * INTO r FROM trustwork.issue_revision WHERE id = p_revision AND status = 'released';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO i FROM trustwork.issue WHERE id = r.issue_id AND current_edition IS NOT NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  FOR pin IN SELECT * FROM trustwork.issue_item WHERE issue_revision_id = r.id ORDER BY position LOOP
    SELECT * INTO p FROM trustwork.publication WHERE id = pin.publication_id;
    SELECT * INTO v FROM trustwork.publication_version WHERE id = pin.publication_version_id;
    IF p.hub_id <> i.hub_id OR v.status <> 'published' OR NOT trustwork.content_public_current_ok(p)
      OR p.status = 'retracted' OR NOT trustwork.content_render_source_ok(p, v) OR trustwork.provenance_delivery_metadata(i.hub_id,p.id,v.version,'pdf') IS NULL THEN RETURN NULL; END IF;
    pub := trustwork.content_publication_json(p);
    pub := jsonb_set(pub,'{current,provenance}',trustwork.provenance_delivery_metadata(i.hub_id,p.id,p.current_version,'pdf'));
    -- Only public, consent-filtered credits leave the database for rendering.
    pub := jsonb_set(pub, '{authorship}', (SELECT coalesce(jsonb_agg(a), '[]'::jsonb)
      FROM jsonb_array_elements(pub -> 'authorship') a WHERE a ->> 'kind' = 'editorial' OR a ->> 'id' IS NOT NULL));
    items := items || jsonb_build_array(jsonb_build_object('position', pin.position, 'section', pin.section,
      'publication', pub, 'version', jsonb_set(trustwork.content_public_version(i.hub_id,p.id,v.version),'{provenance}',trustwork.provenance_delivery_metadata(i.hub_id,p.id,v.version,'pdf'))));
  END LOOP;
  IF jsonb_array_length(items) = 0 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('presentationVersion', 2, 'provenancePresentationVersion',1, 'revisionId', r.id, 'issue',jsonb_set(trustwork.content_issue_json(i,r)-'renderArtifacts','{items}',(SELECT jsonb_agg(x-'provenance') FROM jsonb_array_elements(trustwork.content_issue_json(i,r)->'items') x)), 'items', items);
END $$;

-- First-party working projection: self consent only, no public reuse of working identities.
CREATE FUNCTION trustwork.provenance_workspace(p_ctx jsonb,p_pub uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE me uuid:=trustwork.provenance_session(p_ctx); p trustwork.publication; v trustwork.publication_version; r trustwork.provenance_record; o trustwork.publication_version;
BEGIN
 IF NOT trustwork.content_can_view(p_pub) THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
 SELECT * INTO p FROM trustwork.publication WHERE id=p_pub;
 SELECT * INTO v FROM trustwork.publication_version WHERE publication_id=p_pub ORDER BY version DESC LIMIT 1;
 r:=trustwork.provenance_version_record(v);
 SELECT * INTO o FROM trustwork.publication_version WHERE id=r.original_version_id;
 RETURN jsonb_build_object('publicationId',p.id,'publicationRevision',p.revision,'ownerKind',p.owner_kind,'status',p.status,
   'credit',(SELECT display_name FROM trustwork.person WHERE id=me),
   'binding',jsonb_build_object('publicationId',p.id,'version',v.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',trustwork.content_version_digest(v))),
   'draft',jsonb_build_object('title',v.title,'body',v.body,'language',v.language,'sourceRefs',v.source_refs,'treatment',v.treatment,'eventTime',trustwork.content_iso(v.event_time),'assistantAssisted',v.assistant_assisted),
   'correctionNote',v.correction_note,'versionStatus',v.status,
   'record',CASE WHEN r.id IS NOT NULL THEN jsonb_build_object('id',r.id,'revision',r.revision,'kind',r.kind,'roles',r.roles,
     'exact',r.version_digest=trustwork.content_version_digest(v) AND (v.status<>'draft' OR r.version_revision=v.revision),
     'original',CASE WHEN o.id IS NOT NULL THEN jsonb_build_object('publicationId',o.publication_id,'version',o.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',r.original_digest)) END,
     'canConsentEditor',r.responsible_person_id=me,'canConsentReviewer',EXISTS(SELECT 1 FROM trustwork.provenance_review WHERE provenance_id=r.id AND reviewer_person_id=me),
     'reviewed',EXISTS(SELECT 1 FROM trustwork.provenance_review WHERE provenance_id=r.id)) END,
   'consents',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'provenanceId',c.provenance_id,'role',c.role,'credit',c.credit,'channels',c.channels,'revoked',EXISTS(SELECT 1 FROM trustwork.provenance_credit_revocation WHERE consent_id=c.id)) ORDER BY c.granted_at),'[]')
      FROM trustwork.provenance_credit_consent c JOIN trustwork.provenance_record r2 ON r2.id=c.provenance_id WHERE r2.publication_id=p.id AND c.person_id=me));
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_workspace(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.provenance_workspace(jsonb,uuid) TO trustwork_app;

-- A legacy edition flag is never a substitute for the exact separate-human review.
CREATE FUNCTION trustwork.provenance_edition_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE p trustwork.publication; v trustwork.publication_version; r trustwork.provenance_record; o trustwork.publication_version;
BEGIN
 SELECT * INTO p FROM trustwork.publication WHERE id=NEW.translation_publication_id FOR UPDATE;
 SELECT * INTO v FROM trustwork.publication_version WHERE publication_id=p.id ORDER BY version DESC LIMIT 1;
 r:=trustwork.provenance_version_record(v);
 IF NEW.machine_assisted AND (v.status='published' OR NEW.reviewed_by IS NOT NULL) THEN
   SELECT * INTO o FROM trustwork.publication_version WHERE id=r.original_version_id;
   IF r.kind IS DISTINCT FROM 'machine_translation' OR r.version_digest IS DISTINCT FROM trustwork.content_version_digest(v)
     OR o.publication_id IS DISTINCT FROM NEW.original_publication_id
     OR (NEW.reviewed_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM trustwork.provenance_review WHERE provenance_id=r.id AND reviewer_person_id=NEW.reviewed_by)) THEN
     RAISE EXCEPTION 'exact provenance review required' USING ERRCODE='23514',HINT='content.provenance_review_required';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER provenance_edition_guard BEFORE INSERT OR UPDATE ON trustwork.edition_link FOR EACH ROW EXECUTE FUNCTION trustwork.provenance_edition_guard();
REVOKE ALL ON FUNCTION trustwork.provenance_edition_guard() FROM PUBLIC,trustwork_app,trustwork_worker;

-- Appending disclosure cannot erase the original of an already published translation.
CREATE FUNCTION trustwork.provenance_preserve_translation() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE previous trustwork.provenance_record; v trustwork.publication_version;
BEGIN
 SELECT * INTO v FROM trustwork.publication_version WHERE id=NEW.version_id;
 SELECT r.* INTO previous FROM trustwork.provenance_record r
   JOIN trustwork.publication_version pv ON pv.id=r.version_id
   WHERE r.publication_id=NEW.publication_id AND pv.version<=v.version AND r.kind='machine_translation'
   ORDER BY pv.version DESC,r.revision DESC LIMIT 1;
 IF previous.id IS NOT NULL AND (NEW.kind<>'machine_translation'
   OR (v.status='published' AND previous.version_id=v.id AND (NEW.original_version_id IS DISTINCT FROM previous.original_version_id OR NEW.original_digest IS DISTINCT FROM previous.original_digest))) THEN
   RAISE EXCEPTION 'translation original is immutable' USING ERRCODE='23514',HINT='provenance.binding_mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER provenance_preserve_translation BEFORE INSERT ON trustwork.provenance_record FOR EACH ROW EXECUTE FUNCTION trustwork.provenance_preserve_translation();
REVOKE ALL ON FUNCTION trustwork.provenance_preserve_translation() FROM PUBLIC,trustwork_app,trustwork_worker;
