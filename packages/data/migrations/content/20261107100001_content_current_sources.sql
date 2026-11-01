-- CNT-003 / CNT-001 / SRC-001: current source authority for every public reader projection.
-- No remote I/O and no source working fields leave these functions. Snapshots are ceilings, not grants.
CREATE FUNCTION trustwork.content_source_current_ok(p trustwork.publication, v trustwork.publication_version) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE ref jsonb; item trustwork.source_item; uses jsonb; matches integer;
BEGIN
  IF p.id IS NULL OR v.publication_id IS DISTINCT FROM p.id OR v.status <> 'published'
    OR cardinality(trustwork.content_publication_blockers(p, v)) <> 0 THEN RETURN false; END IF;
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

-- A publication's current version and any requested historical version both need current authority.
CREATE FUNCTION trustwork.content_public_current_ok(p trustwork.publication) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.content_public_ok(p) AND EXISTS (SELECT 1 FROM trustwork.publication_version v
    WHERE v.id = p.current_version_id AND trustwork.content_source_current_ok(p, v))
$$;

-- PDF uses exactly the same source gate as web, feeds and pinned editions.
CREATE OR REPLACE FUNCTION trustwork.content_render_source_ok(p trustwork.publication, v trustwork.publication_version) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.content_source_current_ok(p, v)
$$;


CREATE OR REPLACE FUNCTION trustwork.content_version_json(p_version trustwork.publication_version, p_with_body boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('version', p_version.version, 'title', p_version.title, 'body', CASE WHEN p_with_body AND p_version.treatment <> 'headline_link' THEN p_version.body END, 'language', p_version.language,
    'sourceRefs', p_version.source_refs, 'treatment', p_version.treatment, 'eventTime', trustwork.content_iso(p_version.event_time),
    'publishedAt', trustwork.content_iso(p_version.published_at), 'correctionOf', p_version.correction_of, 'correctionNote', p_version.correction_note,
    'contentDigest', p_version.content_digest, 'assistantAssisted', p_version.assistant_assisted)
$$;

CREATE OR REPLACE FUNCTION trustwork.content_publication_json(p_pub trustwork.publication) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p_pub.id::text, 'format', p_pub.format, 'articleFormat', p_pub.article_format, 'status', p_pub.status, 'originalLanguage', p_pub.original_language, 'licence', p_pub.licence,
    'firstPublishedAt', trustwork.content_iso(p_pub.first_published_at),
    'owner', jsonb_build_object('kind', p_pub.owner_kind, 'id', coalesce(p_pub.owner_person_id, p_pub.owner_company_id)::text),
    -- A credited person other than the owner is identified only with their consent to be named in this publication.
    'authorship', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', a.author_kind, 'credit', a.credit,
                                                                'id', CASE WHEN a.author_person_id IS NULL OR a.author_person_id = p_pub.owner_person_id
                                                                             OR EXISTS (SELECT 1 FROM trustwork.profiles_consented_mentions(p_pub.id, ARRAY[a.author_person_id]))
                                                                           THEN coalesce(a.author_person_id, a.author_company_id)::text END,
                                                                'assistantAssisted', a.assistant_assisted) ORDER BY a.position), '[]'::jsonb)
                   FROM trustwork.publication_authorship a WHERE a.publication_id = p_pub.id AND (a.author_person_id IS NULL OR a.author_person_id = p_pub.owner_person_id OR EXISTS (SELECT 1 FROM trustwork.profiles_consented_mentions(p_pub.id, ARRAY[a.author_person_id])))),
    'topics', (SELECT coalesce(jsonb_agg(t.code ORDER BY t.code), '[]'::jsonb) FROM trustwork.publication_topic pt JOIN trustwork.taxonomy_term t ON t.id = pt.term_id
               WHERE pt.publication_id = p_pub.id AND pt.removed_at IS NULL),
    'entityLinks', trustwork.content_public_links(p_pub.id),
    'current', (SELECT trustwork.content_version_json(v, p_pub.status <> 'retracted') FROM trustwork.publication_version v WHERE v.id = p_pub.current_version_id),
    'versions', (SELECT coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'publishedAt', trustwork.content_iso(v.published_at), 'correctionOf', v.correction_of,
                                                              'correctionNote', v.correction_note) ORDER BY v.version), '[]'::jsonb)
                 FROM trustwork.publication_version v WHERE v.publication_id = p_pub.id AND v.status = 'published'),
    'corrections', (SELECT coalesce(jsonb_agg(jsonb_build_object('fromVersion', c.from_version, 'toVersion', c.to_version, 'reason', c.reason,
                                                                 'correctedAt', trustwork.content_iso(c.corrected_at)) ORDER BY c.corrected_at), '[]'::jsonb)
                    FROM trustwork.correction c WHERE c.publication_id = p_pub.id),
    'retraction', CASE WHEN p_pub.status = 'retracted' THEN jsonb_build_object('note', p_pub.retraction_note, 'retractedAt', trustwork.content_iso(p_pub.retracted_at)) END,
    'editions', (SELECT coalesce(jsonb_agg(jsonb_build_object('publicationId', CASE WHEN l.original_publication_id = p_pub.id THEN l.translation_publication_id ELSE l.original_publication_id END::text,
                                                              'language', CASE WHEN l.original_publication_id = p_pub.id THEN l.language ELSE o.original_language END,
                                                              'role', CASE WHEN l.original_publication_id = p_pub.id THEN 'translation' ELSE 'original' END,
                                                              'machineAssisted', l.machine_assisted, 'reviewed', l.reviewed_by IS NOT NULL) ORDER BY l.created_at), '[]'::jsonb)
                 FROM trustwork.edition_link l JOIN trustwork.publication o ON o.id = l.original_publication_id JOIN trustwork.publication tr ON tr.id = l.translation_publication_id
                 WHERE (l.original_publication_id = p_pub.id OR l.translation_publication_id = p_pub.id) AND trustwork.content_public_current_ok(o) AND trustwork.content_public_current_ok(tr)))
  WHERE trustwork.content_public_current_ok(p_pub)
$$;

CREATE OR REPLACE FUNCTION trustwork.content_public_publication(p_hub uuid, p_pub uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.content_publication_json(p) FROM trustwork.publication p WHERE p.id = p_pub AND p.hub_id = p_hub AND trustwork.content_public_current_ok(p)
$$;

CREATE OR REPLACE FUNCTION trustwork.content_public_version(p_hub uuid, p_pub uuid, p_version integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.content_version_json(v, p.status <> 'retracted')
  FROM trustwork.publication p JOIN trustwork.publication_version v ON v.publication_id = p.id AND v.version = p_version AND v.status = 'published'
  WHERE p.id = p_pub AND p.hub_id = p_hub AND trustwork.content_public_current_ok(p) AND trustwork.content_source_current_ok(p, v)
$$;

CREATE OR REPLACE FUNCTION trustwork.content_public_feed(p_hub uuid, p_format text, p_topic text, p_before timestamptz, p_before_id uuid, p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.at DESC, x.id DESC), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('id', p.id::text, 'format', p.format, 'articleFormat', p.article_format, 'status', p.status, 'firstPublishedAt', trustwork.content_iso(p.first_published_at),
             'title', v.title, 'eventTime', trustwork.content_iso(v.event_time), 'currentVersion', v.version, 'corrected', p.status = 'corrected', 'retracted', p.status = 'retracted',
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
    'items', (SELECT coalesce(jsonb_agg(CASE WHEN p.hub_id = p_issue.hub_id AND trustwork.content_public_current_ok(p) AND trustwork.content_source_current_ok(p, v) THEN
                jsonb_build_object('position', i.position, 'section', i.section, 'publicationId', i.publication_id::text, 'publicationVersion', v.version, 'withheld', false,
                                   'title', v.title, 'format', p.format, 'articleFormat', p.article_format, 'currentVersion', p.current_version,
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
                                               'title', coalesce(v.title, c.title), 'format', p.format, 'currentVersion', p.current_version,
                                               'corrected', p.status = 'corrected', 'retracted', p.status = 'retracted',
                                               'correctionNote', (SELECT x.correction_note FROM trustwork.publication_version x WHERE x.id = p.current_version_id))
                            ORDER BY w.pinned DESC, w.position), '[]'::jsonb)
  FROM trustwork.wall_reference w JOIN trustwork.publication p ON p.id = w.publication_id
  JOIN trustwork.publication_version c ON c.id = p.current_version_id
  LEFT JOIN trustwork.publication_version v ON v.id = w.publication_version_id
  WHERE w.removed_at IS NULL AND w.wall_kind = p_kind AND coalesce(w.wall_person_id, w.wall_company_id) = p_owner AND trustwork.content_public_current_ok(p) AND trustwork.content_source_current_ok(p, coalesce(v, c))
$$;

CREATE OR REPLACE FUNCTION trustwork.content_public_comments(p_hub uuid, p_pub uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id::text, 'parentId', c.parent_id::text, 'authorId', c.author_person_id::text, 'body', c.body,
                                               'createdAt', trustwork.content_iso(c.created_at)) ORDER BY c.created_at, c.id), '[]'::jsonb)
  FROM trustwork.publication_comment c JOIN trustwork.publication p ON p.id = c.publication_id
  WHERE c.publication_id = p_pub AND p.hub_id = p_hub AND c.status = 'visible' AND trustwork.content_public_current_ok(p)
$$;

CREATE OR REPLACE FUNCTION trustwork.content_public_digest(p_hub uuid, p_digest uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT jsonb_build_object('id', d.id::text, 'title', d.title, 'period', d.period, 'releasedAt', trustwork.content_iso(d.released_at),
    'items', (SELECT coalesce(jsonb_agg(CASE WHEN p.hub_id = p_hub AND trustwork.content_public_current_ok(p) AND trustwork.content_source_current_ok(p, v) THEN
                jsonb_build_object('position', i.position, 'homeNode', i.home_node, 'globalId', i.global_id, 'version', i.version, 'licence', i.licence, 'display', i.display,
                                   'title', i.title, 'body', CASE WHEN i.display = 'full' AND p.status <> 'retracted' AND v.treatment <> 'headline_link' THEN v.body END, 'withheld', false)
              ELSE jsonb_build_object('position', i.position, 'homeNode', i.home_node, 'globalId', i.global_id, 'version', i.version, 'withheld', true) END ORDER BY i.position), '[]'::jsonb)
              FROM trustwork.magazine_digest_item i LEFT JOIN trustwork.publication p ON p.id = i.local_publication_id LEFT JOIN trustwork.publication_version v ON v.id = i.local_version_id
              WHERE i.digest_id = d.id))
  FROM trustwork.magazine_digest d WHERE d.id = p_digest AND d.hub_id = p_hub AND d.status = 'released'
$$;

-- Presentation changes invalidate legacy stored PDFs without modifying their immutable bytes.
-- The version participates in the snapshot digest and rejects old in-flight completion snapshots too.
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
      OR p.status = 'retracted' OR NOT trustwork.content_render_source_ok(p, v) THEN RETURN NULL; END IF;
    pub := trustwork.content_publication_json(p);
    -- Only public, consent-filtered credits leave the database for rendering.
    pub := jsonb_set(pub, '{authorship}', (SELECT coalesce(jsonb_agg(a), '[]'::jsonb)
      FROM jsonb_array_elements(pub -> 'authorship') a WHERE a ->> 'kind' = 'editorial' OR a ->> 'id' IS NOT NULL));
    items := items || jsonb_build_array(jsonb_build_object('position', pin.position, 'section', pin.section,
      'publication', pub, 'version', trustwork.content_public_version(i.hub_id, p.id, v.version)));
  END LOOP;
  IF jsonb_array_length(items) = 0 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('presentationVersion', 2, 'revisionId', r.id, 'issue', trustwork.content_issue_json(i, r) - 'renderArtifacts', 'items', items);
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_render_prepare(p_render uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.render_artifact; snap jsonb; b trustwork.content_render_blob;
BEGIN
  SELECT * INTO r FROM trustwork.render_artifact WHERE id = p_render;
  IF NOT FOUND OR r.format <> 'pdf' THEN RETURN NULL; END IF;
  -- Serialize all requests for the same revision, including duplicate outbox jobs and different render ids.
  PERFORM pg_advisory_xact_lock(hashtextextended(r.issue_revision_id::text, 3));
  SELECT * INTO r FROM trustwork.render_artifact WHERE id = p_render FOR UPDATE;
  IF r.status <> 'queued' THEN RETURN NULL; END IF;
  snap := trustwork.content_render_snapshot(r.issue_revision_id);
  IF snap IS NULL THEN
    UPDATE trustwork.render_artifact SET status = 'failed', failure_reason = 'public_projection_or_licence_unavailable', completed_at = now() WHERE id = r.id;
    RETURN NULL;
  END IF;
  SELECT * INTO b FROM trustwork.content_render_blob WHERE issue_revision_id = r.issue_revision_id;
  IF FOUND THEN
    IF b.snapshot_digest = trustwork.admin_digest(snap) THEN
      UPDATE trustwork.render_artifact SET status = 'rendered', sha256 = b.sha256, renderer_version = 'cnt003-local-2', completed_at = now() WHERE id = r.id;
    ELSE
      UPDATE trustwork.render_artifact SET status = 'failed', failure_reason = 'projection_changed_new_edition_required', completed_at = now() WHERE id = r.id;
    END IF;
    RETURN NULL;
  END IF;
  RETURN snap;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_render_finish(p_render uuid, p_snapshot jsonb, p_bytes bytea) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.render_artifact; snap jsonb; hash text;
BEGIN
  SELECT * INTO r FROM trustwork.render_artifact WHERE id = p_render FOR UPDATE;
  IF NOT FOUND OR r.status <> 'queued' OR r.format <> 'pdf' THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.issue_revision_id::text, 3));
  snap := trustwork.content_render_snapshot(r.issue_revision_id);
  IF snap IS NULL OR snap IS DISTINCT FROM p_snapshot THEN
    UPDATE trustwork.render_artifact SET status = 'failed', failure_reason = 'public_projection_changed', completed_at = now() WHERE id = r.id;
    RETURN false;
  END IF;
  IF octet_length(p_bytes) NOT BETWEEN 5 AND 20971520 OR substring(p_bytes FROM 1 FOR 5) <> convert_to('%PDF-', 'UTF8') THEN
    RAISE EXCEPTION 'invalid PDF bytes' USING ERRCODE = 'check_violation';
  END IF;
  hash := encode(sha256(p_bytes), 'hex');
  INSERT INTO trustwork.content_render_blob (issue_revision_id, render_id, snapshot_digest, sha256, bytes)
    VALUES (r.issue_revision_id, r.id, trustwork.admin_digest(snap), hash, p_bytes);
  UPDATE trustwork.render_artifact SET status = 'rendered', sha256 = hash, renderer_version = 'cnt003-local-2', completed_at = now() WHERE id = r.id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION trustwork.content_source_current_ok(trustwork.publication, trustwork.publication_version),
  trustwork.content_public_current_ok(trustwork.publication) FROM PUBLIC, trustwork_app, trustwork_worker;
