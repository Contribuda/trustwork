-- CNT-003: local PDF bytes commit atomically with the fenced worker job. No object-store effects.
-- The public delivery guard compares the current public/licence projection with the captured one.
CREATE TABLE trustwork.content_render_blob (
  issue_revision_id uuid PRIMARY KEY REFERENCES trustwork.issue_revision (id),
  render_id uuid NOT NULL UNIQUE REFERENCES trustwork.render_artifact (id),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 5 AND 20971520),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE trustwork.content_render_blob ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.content_render_blob FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.content_render_blob FOR ALL TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE TRIGGER content_render_blob_immutable BEFORE UPDATE OR DELETE ON trustwork.content_render_blob
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Conservative PDF eligibility: a third-party reference needs a live, explicitly linked source item.
-- A URL alone is never authority and is never fetched. Publication licence snapshots remain ceilings.
CREATE FUNCTION trustwork.content_render_source_ok(p trustwork.publication, v trustwork.publication_version) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE ref jsonb; item trustwork.source_item; uses jsonb;
BEGIN
  IF cardinality(trustwork.content_publication_blockers(p, v)) <> 0 THEN RETURN false; END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(v.source_refs) LOOP
    CONTINUE WHEN ref ->> 'kind' = 'own_reporting';
    SELECT i.* INTO item FROM trustwork.source_item i JOIN trustwork.source s ON s.id = i.source_id
      WHERE i.publication_id = p.id AND i.hub_id = p.hub_id AND i.url = ref ->> 'uri'
        AND i.status = 'drafted' AND s.status = 'active' ORDER BY i.id LIMIT 1;
    IF NOT FOUND THEN RETURN false; END IF;
    uses := trustwork.sources_effective_uses(item);
    IF NOT trustwork.sources_use(uses, 'displayHeadlineAndLink')
      OR (v.treatment = 'summary' AND NOT trustwork.sources_use(uses, 'displaySummary'))
      OR (v.treatment = 'rewrite' AND NOT trustwork.sources_use(uses, 'rewriteWithAttribution'))
      OR (v.treatment = 'translation' AND NOT trustwork.sources_use(uses, 'translate')) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION trustwork.content_render_snapshot(p_revision uuid) RETURNS jsonb
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
    IF p.hub_id <> i.hub_id OR v.status <> 'published' OR NOT trustwork.content_public_ok(p)
      OR p.status = 'retracted' OR NOT trustwork.content_render_source_ok(p, v) THEN RETURN NULL; END IF;
    pub := trustwork.content_publication_json(p);
    -- Only public, consent-filtered credits leave the database for rendering.
    pub := jsonb_set(pub, '{authorship}', (SELECT coalesce(jsonb_agg(a), '[]'::jsonb)
      FROM jsonb_array_elements(pub -> 'authorship') a WHERE a ->> 'kind' = 'editorial' OR a ->> 'id' IS NOT NULL));
    items := items || jsonb_build_array(jsonb_build_object('position', pin.position, 'section', pin.section,
      'publication', pub, 'version', trustwork.content_public_version(i.hub_id, p.id, v.version)));
  END LOOP;
  IF jsonb_array_length(items) = 0 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('revisionId', r.id, 'issue', trustwork.content_issue_json(i, r) - 'renderArtifacts', 'items', items);
END $$;

CREATE FUNCTION trustwork.content_render_prepare(p_render uuid) RETURNS jsonb
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
      UPDATE trustwork.render_artifact SET status = 'rendered', sha256 = b.sha256, renderer_version = 'cnt003-local-1', completed_at = now() WHERE id = r.id;
    ELSE
      UPDATE trustwork.render_artifact SET status = 'failed', failure_reason = 'projection_changed_new_edition_required', completed_at = now() WHERE id = r.id;
    END IF;
    RETURN NULL;
  END IF;
  RETURN snap;
END $$;

CREATE FUNCTION trustwork.content_render_finish(p_render uuid, p_snapshot jsonb, p_bytes bytea) RETURNS boolean
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
  UPDATE trustwork.render_artifact SET status = 'rendered', sha256 = hash, renderer_version = 'cnt003-local-1', completed_at = now() WHERE id = r.id;
  RETURN true;
END $$;

CREATE FUNCTION trustwork.content_render_fail(p_render uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  UPDATE trustwork.render_artifact SET status = 'failed', failure_reason = 'local_renderer_failed', completed_at = now()
  WHERE id = p_render AND format = 'pdf' AND status = 'queued'
$$;

-- Same guard for HEAD-like availability and download. Never cache: correction/consent/licence changes invalidate bytes.
CREATE FUNCTION trustwork.content_public_pdf(p_hub uuid, p_number integer, p_edition integer)
RETURNS TABLE (bytes bytea, sha256 text, edition integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT b.bytes, b.sha256, r.edition FROM trustwork.content_render_blob b
  JOIN trustwork.issue_revision r ON r.id = b.issue_revision_id JOIN trustwork.issue i ON i.id = r.issue_id
  WHERE i.hub_id = p_hub AND i.number = p_number AND r.edition = coalesce(p_edition, i.current_edition)
    AND b.snapshot_digest = trustwork.admin_digest(trustwork.content_render_snapshot(r.id))
$$;
REVOKE ALL ON FUNCTION trustwork.content_render_source_ok(trustwork.publication, trustwork.publication_version),
  trustwork.content_render_snapshot(uuid), trustwork.content_render_prepare(uuid), trustwork.content_render_fail(uuid), trustwork.content_render_finish(uuid, jsonb, bytea),
  trustwork.content_public_pdf(uuid, integer, integer) FROM PUBLIC, trustwork_app, trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.content_render_prepare(uuid), trustwork.content_render_fail(uuid), trustwork.content_render_finish(uuid, jsonb, bytea) TO trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.content_public_pdf(uuid, integer, integer) TO trustwork_app;
