-- PROV-001 / CNT-001: owning synchronization before content locks, current command admission after waits.
-- Forward-only: earlier unpublished migrations and every immutable publication digest remain intact.
CREATE FUNCTION trustwork.provenance_content_gate() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE prior_timeout text := current_setting('lock_timeout');
BEGIN
  -- One node-local publication authority gate. No provider work belongs in this transaction.
  -- Preserve a stricter caller limit; otherwise bound contention to five seconds. Never retry here.
  IF prior_timeout::interval = interval '0' OR prior_timeout::interval > interval '5 seconds' THEN
    PERFORM set_config('lock_timeout','5s',true);
  END IF;
  PERFORM pg_advisory_xact_lock(731209, 97);
  PERFORM set_config('lock_timeout',prior_timeout,true);
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'publication authority busy; reload' USING ERRCODE='40001',HINT='content.authority_busy';
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_content_gate() FROM PUBLIC,trustwork_app,trustwork_worker;

-- Identity writers do not share a single row order: membership/role revocation can hold its row before
-- updating person; session reset can hold session/elevation first. NOWAIT is intentional, not a retry.
CREATE OR REPLACE FUNCTION trustwork.provenance_session(p_ctx jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE me uuid := trustwork.admin_require_caller(); s trustwork.session; epoch integer;
BEGIN
  SELECT authz_epoch INTO epoch FROM trustwork.person WHERE id=me FOR SHARE NOWAIT;
  IF epoch IS DISTINCT FROM trustwork.current_authz_epoch() THEN
    RAISE EXCEPTION 'request authority changed' USING ERRCODE='42501',HINT='provenance.authority_changed';
  END IF;
  SELECT * INTO s FROM trustwork.session WHERE id=(p_ctx->>'sessionId')::uuid AND person_id=me FOR SHARE NOWAIT;
  IF s.id IS NULL OR s.revoked_at IS NOT NULL OR s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp()
    OR coalesce(length(p_ctx->>'requestId'),0) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'first-party session required' USING ERRCODE='42501',HINT='provenance.first_party_required';
  END IF;
  RETURN me;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'request authority busy; reload' USING ERRCODE='40001',HINT='content.authority_busy';
END $$;

CREATE FUNCTION trustwork.provenance_staff(p_ctx jsonb,p_permissions text[],p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE me uuid := trustwork.provenance_session(p_ctx); e trustwork.session_elevation; a record;
BEGIN
  -- Validate the existing context contract, then check the exact session and current clock under locks.
  PERFORM trustwork.admin_require_elevation(p_ctx);
  SELECT * INTO e FROM trustwork.session_elevation WHERE id=(p_ctx->>'elevationId')::uuid FOR SHARE NOWAIT;
  IF e.person_id IS DISTINCT FROM me OR e.session_id IS DISTINCT FROM (p_ctx->>'sessionId')::uuid
    OR e.revoked_at IS NOT NULL OR e.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'current exact elevation required' USING ERRCODE='42501',HINT='admin.elevation_required';
  END IF;
  SELECT s.role,s.breakglass,permission.value AS permission INTO a
    FROM trustwork.staff_role_assignment s
    JOIN trustwork.staff_role_definition_version d ON d.role=s.role AND d.version=s.definition_version
    CROSS JOIN unnest(p_permissions) WITH ORDINALITY permission(value,ord)
    WHERE s.person_id=me AND s.revoked_at IS NULL AND s.valid_from<=clock_timestamp()
      AND (s.valid_until IS NULL OR s.valid_until>clock_timestamp())
      AND permission.value=ANY(d.permissions) AND s.scope_kind=ANY(d.scopes)
      AND (s.scope_kind IN ('platform','node') OR (s.hub_id=p_hub AND NOT permission.value=ANY(trustwork.admin_node_only_permissions())))
    ORDER BY s.breakglass,permission.ord,s.id LIMIT 1 FOR SHARE OF s NOWAIT;
  IF a.role IS NULL THEN RAISE EXCEPTION 'current role required' USING ERRCODE='42501',HINT='admin.forbidden'; END IF;
  RETURN ROW(me,a.role,a.breakglass,e.id,a.permission)::trustwork.admin_actor;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'request authority busy; reload' USING ERRCODE='40001',HINT='content.authority_busy';
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_staff(jsonb,text[],uuid) FROM PUBLIC,trustwork_app,trustwork_worker;

CREATE OR REPLACE FUNCTION trustwork.provenance_authorize(p_ctx jsonb,p_pub trustwork.publication,p_review boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE actor trustwork.admin_actor; me uuid:=trustwork.provenance_session(p_ctx);
BEGIN
  IF p_pub.owner_kind='editorial' AND p_ctx->>'elevationId' IS NULL THEN
    RAISE EXCEPTION 'elevation required' USING ERRCODE='42501',HINT='admin.elevation_required';
  END IF;
  IF p_pub.owner_kind='editorial' OR p_ctx->>'elevationId' IS NOT NULL THEN
    actor:=trustwork.provenance_staff(p_ctx,CASE WHEN p_review THEN ARRAY['admin.publications.review'] ELSE ARRAY['admin.publications.publish'] END,p_pub.hub_id);
    PERFORM trustwork.admin_record(actor,p_ctx,NULL,p_pub.hub_id,'provenance.authorized','publication',p_pub.id,NULL,NULL);
  ELSE
    -- Existing and absent membership changes bump the locked person's epoch; in-flight row writers refuse.
    PERFORM 1 FROM trustwork.membership WHERE person_id=me ORDER BY id FOR SHARE NOWAIT;
    PERFORM trustwork.content_require_right(p_pub,'publish');
  END IF;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'request authority busy; reload' USING ERRCODE='40001',HINT='content.authority_busy';
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_create(p_ctx jsonb, p_hub uuid, p_owner_kind text, p_owner_company uuid, p_format text, p_article_format text, p_language text, p_licence text,
  p_requires_review boolean, p_draft jsonb, p_authorship jsonb) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_actor trustwork.admin_actor;
  v_row trustwork.publication%ROWTYPE;
  v_version trustwork.publication_version%ROWTYPE;
BEGIN
  IF p_owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.publish', 'admin.publications.review'], p_hub);
  ELSIF p_owner_kind = 'company' THEN
    IF p_owner_company IS NULL OR NOT trustwork.content_acts_for(NULL, p_owner_company) THEN
      RAISE EXCEPTION 'company publications are written by members holding company.publish' USING ERRCODE = 'insufficient_privilege', HINT = 'content.not_authorised';
    END IF;
  ELSIF p_owner_kind <> 'person' THEN
    RAISE EXCEPTION 'unknown owner kind' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.invalid_owner';
  END IF;
  INSERT INTO trustwork.publication (hub_id, format, article_format, owner_kind, owner_person_id, owner_company_id, original_language, licence, requires_review, created_by)
  VALUES (p_hub, p_format, p_article_format, p_owner_kind, CASE WHEN p_owner_kind = 'person' THEN v_me END, CASE WHEN p_owner_kind = 'company' THEN p_owner_company END,
          p_language, coalesce(p_licence, 'all_rights'), p_owner_kind = 'editorial' OR coalesce(p_requires_review, false), v_me)
  RETURNING * INTO v_row;
  v_version := trustwork.content_write_draft(v_row, p_draft, NULL, NULL);
  PERFORM trustwork.content_write_authorship(v_row, p_authorship);
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'publication.create', 'publication', v_row.id, NULL, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_save_draft(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_draft jsonb, p_authorship jsonb) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
BEGIN
  IF v_row.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.publish', 'admin.publications.review'], v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, 'edit');
  END IF;
  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'only drafts are edited; a published text is corrected' USING ERRCODE = 'check_violation', HINT = CASE WHEN v_row.first_published_at IS NULL THEN 'content.not_draft' ELSE 'content.use_correction' END;
  END IF;
  IF p_draft IS NOT NULL THEN
    PERFORM trustwork.content_write_draft(v_row, p_draft, NULL, NULL);
  END IF;
  IF p_authorship IS NOT NULL THEN
    PERFORM trustwork.content_write_authorship(v_row, p_authorship);
  END IF;
  UPDATE trustwork.publication SET updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'publication.draft_saved', 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_transition(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_to text) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
BEGIN
  IF NOT ((v_row.status = 'draft' AND p_to = 'in_review') OR (v_row.status IN ('in_review', 'scheduled') AND p_to = 'draft')) THEN
    RAISE EXCEPTION 'publication % -> % is not a submit or return', v_row.status, p_to USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  IF v_row.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, CASE WHEN v_row.status = 'scheduled' THEN ARRAY['admin.publications.publish'] ELSE ARRAY['admin.publications.review', 'admin.publications.publish'] END, v_row.hub_id);
  ELSIF v_row.status = 'in_review' AND p_ctx IS NOT NULL AND trustwork.content_right(v_row) IS NULL THEN
    -- A reviewer returns a submitted personal or company publication for revision.
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.review'], v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, CASE WHEN v_row.status = 'scheduled' THEN 'publish' ELSE 'edit' END);
  END IF;
  UPDATE trustwork.publication SET status = p_to, scheduled_for = NULL WHERE id = v_row.id RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN p_to = 'in_review' THEN 'publication.submitted' ELSE 'publication.returned' END, 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_publish(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_scheduled_for timestamptz) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
  v_draft trustwork.publication_version%ROWTYPE;
BEGIN
  IF v_row.status NOT IN ('draft', 'in_review', 'scheduled') THEN
    RAISE EXCEPTION 'already published; corrections are new versions' USING ERRCODE = 'check_violation', HINT = 'content.use_correction';
  END IF;
  SELECT * INTO v_draft FROM trustwork.publication_version WHERE publication_id = v_row.id AND status = 'draft';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no draft version to publish' USING ERRCODE = 'check_violation', HINT = 'content.no_draft';
  END IF;
  IF v_row.requires_review AND v_row.status = 'draft' THEN
    RAISE EXCEPTION 'this publication is published after review' USING ERRCODE = 'check_violation', HINT = 'content.review_required';
  END IF;
  IF v_row.requires_review AND v_row.status = 'in_review' THEN
    v_actor := trustwork.content_staff(p_ctx, CASE WHEN v_row.owner_kind = 'editorial' THEN ARRAY['admin.publications.publish'] ELSE ARRAY['admin.publications.review', 'admin.publications.publish'] END, v_row.hub_id);
    IF v_draft.drafted_by = v_me THEN
      RAISE EXCEPTION 'a reviewer never approves a version they drafted' USING ERRCODE = 'insufficient_privilege', HINT = 'content.self_review';
    END IF;
  ELSIF v_row.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.publish'], v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, 'publish');
  END IF;
  IF p_scheduled_for IS NOT NULL AND p_scheduled_for > now() THEN
    IF cardinality(trustwork.content_publication_blockers(v_row, v_draft)) > 0 THEN
      RAISE EXCEPTION 'publication blocked: %', array_to_string(trustwork.content_publication_blockers(v_row, v_draft), ', ') USING ERRCODE = 'check_violation',
        HINT = 'content.' || (trustwork.content_publication_blockers(v_row, v_draft))[1];
    END IF;
    UPDATE trustwork.publication SET status = 'scheduled', scheduled_for = p_scheduled_for WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    v_row := trustwork.content_release_version(v_row, v_draft.id, v_me, 'published');
  END IF;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN v_row.status = 'scheduled' THEN 'publication.scheduled' ELSE 'publication.published' END, 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_correct(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_draft jsonb, p_note text, p_reason text) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
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
  PERFORM trustwork.provenance_session(p_ctx);
  IF v_row.owner_kind='editorial' THEN
    v_actor:=trustwork.provenance_staff(p_ctx,ARRAY['admin.publications.correct'],v_row.hub_id);
  ELSE
    PERFORM 1 FROM trustwork.membership WHERE person_id=v_me ORDER BY id FOR SHARE NOWAIT;
    PERFORM trustwork.content_require_right(v_row,'publish');
  END IF;
  v_row := trustwork.content_release_version(v_row, v_version.id, v_me, 'corrected');
  INSERT INTO trustwork.correction (hub_id, subject_kind, publication_id, from_version, to_version, reason, corrected_by)
  VALUES (v_row.hub_id, 'publication', v_row.id, v_from, v_version.version, p_reason, v_me);
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'publication.corrected', 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_retract(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_note text) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
BEGIN
  IF v_row.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.retract'], v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, 'publish');
  END IF;
  IF v_row.status NOT IN ('published', 'corrected') THEN
    RAISE EXCEPTION 'only a published publication is retracted' USING ERRCODE = 'check_violation', HINT = CASE WHEN v_row.status = 'retracted' THEN 'content.retracted' ELSE 'content.not_published' END;
  END IF;
  UPDATE trustwork.publication SET status = 'retracted', retraction_note = p_note, retracted_at = now(), retracted_by = v_me WHERE id = v_row.id RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'publication.retracted', 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_set_links(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_topics text[], p_links jsonb) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
  v_code text;
  v_term uuid;
  v_link jsonb;
BEGIN
  IF v_row.owner_kind = 'editorial' OR (p_ctx IS NOT NULL AND trustwork.content_right(v_row) IS NULL) THEN
    v_actor := trustwork.content_staff(p_ctx, CASE WHEN v_row.owner_kind = 'editorial' THEN ARRAY['admin.publications.links.edit', 'admin.publications.publish'] ELSE ARRAY['admin.publications.links.edit'] END, v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, 'edit');
  END IF;
  IF p_topics IS NOT NULL THEN
    UPDATE trustwork.publication_topic t SET removed_at = now(), removed_by = v_me
     WHERE t.publication_id = v_row.id AND t.removed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM trustwork.taxonomy_term x WHERE x.id = t.term_id AND x.code = ANY (p_topics));
    FOREACH v_code IN ARRAY p_topics LOOP
      SELECT id INTO v_term FROM trustwork.taxonomy_term WHERE code = v_code AND scheme = 'topic' AND status = 'released' AND (hub_id IS NULL OR hub_id = v_row.hub_id)
       ORDER BY hub_id NULLS FIRST LIMIT 1;
      IF v_term IS NULL THEN
        RAISE EXCEPTION 'unknown topic %', v_code USING ERRCODE = 'check_violation', HINT = 'content.unknown_topic';
      END IF;
      INSERT INTO trustwork.publication_topic (publication_id, term_id, added_by) VALUES (v_row.id, v_term, v_me) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  IF p_links IS NOT NULL THEN
    IF jsonb_typeof(p_links) <> 'array' THEN
      RAISE EXCEPTION 'links are an array' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.invalid_links';
    END IF;
    UPDATE trustwork.entity_link l SET removed_at = now(), removed_by = v_me
     WHERE l.publication_id = v_row.id AND l.removed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_links) x
                       WHERE x.value ->> 'relation' = l.relation AND (x.value ->> 'id')::uuid = coalesce(l.target_person_id, l.target_company_id)
                         AND x.value ->> 'kind' = CASE WHEN l.target_person_id IS NOT NULL THEN 'person' ELSE 'company' END);
    FOR v_link IN SELECT value FROM jsonb_array_elements(p_links) LOOP
      INSERT INTO trustwork.entity_link (publication_id, target_person_id, target_company_id, relation, added_by)
      VALUES (v_row.id, CASE WHEN v_link ->> 'kind' = 'person' THEN (v_link ->> 'id')::uuid END, CASE WHEN v_link ->> 'kind' = 'company' THEN (v_link ->> 'id')::uuid END,
              v_link ->> 'relation', v_me)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  UPDATE trustwork.publication SET updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'publication.links_edited', 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_grant_editor(p_pub uuid, p_person uuid, p_rights text) RETURNS trustwork.publication_editor
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_pub trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, NULL);
  v_row trustwork.publication_editor%ROWTYPE;
BEGIN
  IF v_pub.owner_kind = 'editorial' THEN
    RAISE EXCEPTION 'the editorial office edits through staff roles' USING ERRCODE = 'check_violation', HINT = 'content.editorial_staff_only';
  END IF;
  PERFORM trustwork.content_require_right(v_pub, 'owner');
  IF p_person = v_me THEN
    RAISE EXCEPTION 'nobody grants a right to themselves' USING ERRCODE = 'insufficient_privilege', HINT = 'content.self_grant';
  END IF;
  UPDATE trustwork.publication_editor SET revoked_at = now(), revoked_by = v_me WHERE publication_id = p_pub AND person_id = p_person AND revoked_at IS NULL;
  INSERT INTO trustwork.publication_editor (publication_id, person_id, rights, granted_by) VALUES (p_pub, p_person, p_rights, v_me) RETURNING * INTO v_row;
  UPDATE trustwork.publication SET updated_at = now() WHERE id = p_pub;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_revoke_editor(p_pub uuid, p_person uuid) RETURNS trustwork.publication_editor
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_pub trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, NULL);
  v_row trustwork.publication_editor%ROWTYPE;
BEGIN
  IF p_person <> v_me THEN
    PERFORM trustwork.content_require_right(v_pub, 'owner');
  END IF;
  UPDATE trustwork.publication_editor SET revoked_at = now(), revoked_by = v_me WHERE publication_id = p_pub AND person_id = p_person AND revoked_at IS NULL RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no live editing right' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  UPDATE trustwork.publication SET updated_at = now() WHERE id = p_pub;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_link_edition(p_ctx jsonb, p_original uuid, p_translation uuid, p_machine_assisted boolean) RETURNS trustwork.edition_link
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_original trustwork.publication%ROWTYPE := trustwork.content_lock(p_original, NULL);
  v_translation trustwork.publication%ROWTYPE := trustwork.content_lock(p_translation, NULL);
  v_actor trustwork.admin_actor;
  v_row trustwork.edition_link%ROWTYPE;
BEGIN
  IF v_original.owner_kind = 'editorial' OR v_translation.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.publish', 'admin.publications.review'], v_original.hub_id);
  END IF;
  IF v_original.owner_kind <> 'editorial' THEN PERFORM trustwork.content_require_right(v_original, 'edit'); END IF;
  IF v_translation.owner_kind <> 'editorial' THEN PERFORM trustwork.content_require_right(v_translation, 'edit'); END IF;
  IF v_original.hub_id <> v_translation.hub_id OR v_original.original_language = v_translation.original_language THEN
    RAISE EXCEPTION 'a translation is a publication of the same hub in another language' USING ERRCODE = 'check_violation', HINT = 'content.invalid_edition';
  END IF;
  INSERT INTO trustwork.edition_link (original_publication_id, translation_publication_id, language, translator_person_id, machine_assisted, created_by)
  VALUES (p_original, p_translation, v_translation.original_language, v_me, p_machine_assisted, v_me) RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_original.hub_id, 'publication.edition_linked', 'edition_link', v_row.id, NULL, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_review_edition(p_ctx jsonb, p_link uuid) RETURNS trustwork.edition_link
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.edition_link%ROWTYPE;
  v_translation trustwork.publication%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_row FROM trustwork.edition_link WHERE id = p_link FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'edition link not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  SELECT * INTO v_translation FROM trustwork.publication WHERE id = v_row.translation_publication_id;
  IF v_translation.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.review', 'admin.publications.publish'], v_translation.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_translation, 'edit');
  END IF;
  IF v_row.translator_person_id = v_me THEN
    RAISE EXCEPTION 'a translation is reviewed by someone other than its translator' USING ERRCODE = 'insufficient_privilege', HINT = 'content.self_review';
  END IF;
  UPDATE trustwork.edition_link SET reviewed_by = v_me, reviewed_at = now() WHERE id = p_link RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_translation.hub_id, 'publication.edition_reviewed', 'edition_link', v_row.id, NULL, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_wall_add(p_wall_kind text, p_company uuid, p_pub uuid, p_version uuid, p_pinned boolean) RETURNS trustwork.wall_reference
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_pub trustwork.publication%ROWTYPE;
  v_row trustwork.wall_reference%ROWTYPE;
  v_position integer;
BEGIN
  IF p_wall_kind = 'company' AND (p_company IS NULL OR NOT trustwork.content_acts_for(NULL, p_company)) THEN
    RAISE EXCEPTION 'a company wall is curated by members holding company.publish' USING ERRCODE = 'insufficient_privilege', HINT = 'content.not_authorised';
  END IF;
  SELECT * INTO v_pub FROM trustwork.publication WHERE id = p_pub;
  IF NOT FOUND OR NOT trustwork.content_public_ok(v_pub) THEN
    RAISE EXCEPTION 'walls reference public publications' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  IF p_version IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.publication_version v WHERE v.id = p_version AND v.publication_id = p_pub AND v.status = 'published') THEN
    RAISE EXCEPTION 'walls pin published versions' USING ERRCODE = 'check_violation', HINT = 'content.version_not_published';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.wall'), hashtext(coalesce(p_company, v_me)::text));
  SELECT coalesce(max(position), 0) + 1 INTO v_position FROM trustwork.wall_reference WHERE coalesce(wall_person_id, wall_company_id) = coalesce(p_company, v_me) AND removed_at IS NULL;
  INSERT INTO trustwork.wall_reference (wall_kind, wall_person_id, wall_company_id, publication_id, publication_version_id, position, pinned, added_by)
  VALUES (p_wall_kind, CASE WHEN p_wall_kind = 'person' THEN v_me END, CASE WHEN p_wall_kind = 'company' THEN p_company END, p_pub, p_version, v_position, coalesce(p_pinned, false), v_me)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_wall_remove(p_ref uuid) RETURNS trustwork.wall_reference
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.wall_reference%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.wall_reference WHERE id = p_ref AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT trustwork.content_acts_for(v_row.wall_person_id, v_row.wall_company_id) THEN
    RAISE EXCEPTION 'wall reference not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  UPDATE trustwork.wall_reference SET removed_at = now(), removed_by = v_me WHERE id = p_ref RETURNING * INTO v_row;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_comment(p_pub uuid, p_parent uuid, p_body text) RETURNS trustwork.publication_comment
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_pub trustwork.publication%ROWTYPE;
  v_row trustwork.publication_comment%ROWTYPE;
BEGIN
  SELECT * INTO v_pub FROM trustwork.publication WHERE id = p_pub;
  IF NOT FOUND OR NOT trustwork.content_public_ok(v_pub) OR v_pub.status = 'retracted' THEN
    RAISE EXCEPTION 'comments are written on public publications' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  IF p_parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.publication_comment c WHERE c.id = p_parent AND c.publication_id = p_pub AND c.status = 'visible') THEN
    RAISE EXCEPTION 'the parent comment is not visible here' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  INSERT INTO trustwork.publication_comment (publication_id, author_person_id, parent_id, body) VALUES (p_pub, v_me, p_parent, p_body) RETURNING * INTO v_row;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_apply_moderation(p_case uuid, p_effect text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_case trustwork.moderation_case%ROWTYPE;
  v_ok boolean;
  v_pub trustwork.publication%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_case FROM trustwork.moderation_case WHERE id = p_case;
  IF NOT FOUND OR NOT trustwork.admin_has_any_permission(ARRAY['admin.moderation.decide', 'admin.moderation.emergency.hold', 'admin.moderation.appeal.decide', 'admin.trust.appeals.decide'], NULL, v_case.hub_id) THEN
    RAISE EXCEPTION 'moderation effects follow a staff decision' USING ERRCODE = 'insufficient_privilege', HINT = 'content.not_authorised';
  END IF;
  v_ok := CASE p_effect
    WHEN 'hold' THEN v_case.emergency_hold AND v_case.status IN ('open', 'in_review')
    WHEN 'remove' THEN v_case.decision = 'content_removed'
    WHEN 'restore' THEN v_case.decision = 'content_restored'
      OR EXISTS (SELECT 1 FROM trustwork.appeal a WHERE a.subject_kind = 'moderation_case' AND a.subject_id = v_case.id AND a.status = 'overturned')
    WHEN 'none' THEN true
    ELSE false END;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'the case does not support %', p_effect USING ERRCODE = 'check_violation', HINT = 'content.moderation_mismatch';
  END IF;
  IF p_effect = 'none' THEN
    RETURN 'none';
  END IF;
  IF v_case.target_kind = 'publication' THEN
    SELECT * INTO v_pub FROM trustwork.publication WHERE id = v_case.target_id AND hub_id = v_case.hub_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN 'unknown_target';
    END IF;
    UPDATE trustwork.publication SET moderation_state = CASE p_effect WHEN 'hold' THEN 'held' WHEN 'remove' THEN 'removed' ELSE 'none' END,
           held_by_case_id = CASE WHEN p_effect = 'restore' THEN NULL ELSE v_case.id END
     WHERE id = v_pub.id;
    RETURN 'applied';
  ELSIF v_case.target_kind = 'publication_comment' THEN
    UPDATE trustwork.publication_comment c SET status = CASE p_effect WHEN 'hold' THEN 'held' WHEN 'remove' THEN 'removed' ELSE 'visible' END,
           moderation_case_id = v_case.id
     WHERE c.id = v_case.target_id AND EXISTS (SELECT 1 FROM trustwork.publication p WHERE p.id = c.publication_id AND p.hub_id = v_case.hub_id);
    RETURN CASE WHEN FOUND THEN 'applied' ELSE 'unknown_target' END;
  END IF;
  RETURN 'not_content';
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_issue_create(p_ctx jsonb, p_hub uuid, p_number integer, p_date date, p_theme text, p_cover uuid, p_letter uuid) RETURNS trustwork.issue
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.curate'], p_hub);
  v_row trustwork.issue%ROWTYPE;
BEGIN
  IF p_letter IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.publication p WHERE p.id = p_letter AND p.hub_id = p_hub) THEN
    RAISE EXCEPTION 'the editor''s letter is a publication of this hub' USING ERRCODE = 'check_violation', HINT = 'content.other_hub';
  END IF;
  INSERT INTO trustwork.issue (hub_id, number, issue_date, theme, cover_asset_id, editor_letter_publication_id, created_by)
  VALUES (p_hub, p_number, p_date, p_theme, p_cover, p_letter, v_actor.person_id) RETURNING * INTO v_row;
  INSERT INTO trustwork.issue_revision (issue_id, edition, created_by) VALUES (v_row.id, 1, v_actor.person_id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'issue.create', 'issue', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_issue_curate(p_ctx jsonb, p_issue uuid, p_expected_revision integer, p_items jsonb, p_theme text, p_cover uuid, p_letter uuid) RETURNS trustwork.issue
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_row trustwork.issue%ROWTYPE := trustwork.content_issue_lock(p_issue, p_expected_revision);
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.curate', 'admin.issues.correct'], v_row.hub_id);
  v_before jsonb := to_jsonb(v_row);
  v_revision uuid;
BEGIN
  SELECT id INTO v_revision FROM trustwork.issue_revision WHERE issue_id = v_row.id AND status = 'draft';
  IF v_revision IS NULL OR v_row.status = 'review' THEN
    RAISE EXCEPTION 'only a draft revision outside review is curated' USING ERRCODE = 'check_violation', HINT = 'content.issue_frozen';
  END IF;
  IF p_items IS NOT NULL THEN
    PERFORM trustwork.content_issue_write_items(v_revision, p_items);
  END IF;
  IF v_row.current_edition IS NULL THEN
    IF p_letter IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.publication p WHERE p.id = p_letter AND p.hub_id = v_row.hub_id) THEN
      RAISE EXCEPTION 'the editor''s letter is a publication of this hub' USING ERRCODE = 'check_violation', HINT = 'content.other_hub';
    END IF;
    UPDATE trustwork.issue SET theme = coalesce(p_theme, theme), cover_asset_id = coalesce(p_cover, cover_asset_id), editor_letter_publication_id = coalesce(p_letter, editor_letter_publication_id)
     WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    UPDATE trustwork.issue SET updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'issue.curate', 'issue', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_issue_transition(p_ctx jsonb, p_issue uuid, p_expected_revision integer, p_to text) RETURNS trustwork.issue
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_row trustwork.issue%ROWTYPE := trustwork.content_issue_lock(p_issue, p_expected_revision);
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.curate'], v_row.hub_id);
  v_before jsonb := to_jsonb(v_row);
BEGIN
  IF p_to NOT IN ('draft', 'curated', 'review') THEN
    RAISE EXCEPTION 'release and correction have their own commands' USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  UPDATE trustwork.issue SET status = p_to WHERE id = v_row.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'issue.status', 'issue', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_issue_release(p_ctx jsonb, p_issue uuid, p_expected_revision integer) RETURNS trustwork.issue
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_row trustwork.issue%ROWTYPE := trustwork.content_issue_lock(p_issue, p_expected_revision);
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.release'], v_row.hub_id);
  v_before jsonb := to_jsonb(v_row);
  v_revision trustwork.issue_revision%ROWTYPE;
  v_items jsonb;
BEGIN
  SELECT * INTO v_revision FROM trustwork.issue_revision WHERE issue_id = v_row.id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND OR (v_revision.edition = 1 AND v_row.status <> 'review') THEN
    RAISE EXCEPTION 'nothing to release (the first edition is released from review)' USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('position', i.position, 'publicationId', i.publication_id::text, 'publicationVersion', v.version, 'section', i.section) ORDER BY i.position), '[]'::jsonb)
    INTO v_items FROM trustwork.issue_item i JOIN trustwork.publication_version v ON v.id = i.publication_version_id WHERE i.issue_revision_id = v_revision.id;
  IF jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'an issue releases with at least one item' USING ERRCODE = 'check_violation', HINT = 'content.issue_empty';
  END IF;
  UPDATE trustwork.issue_revision SET status = 'released', released_at = now(), released_by = v_actor.person_id,
         digest = trustwork.admin_digest(jsonb_build_object('issueNumber', v_row.number, 'date', to_char(v_row.issue_date, 'YYYY-MM-DD'), 'items', v_items))
   WHERE id = v_revision.id;
  UPDATE trustwork.issue SET status = CASE WHEN v_revision.edition = 1 THEN 'released' ELSE 'corrected' END, current_edition = v_revision.edition
   WHERE id = v_row.id RETURNING * INTO v_row;
  IF v_revision.edition > 1 THEN
    INSERT INTO trustwork.correction (hub_id, subject_kind, issue_id, from_version, to_version, reason, corrected_by)
    VALUES (v_row.hub_id, 'issue', v_row.id, v_revision.edition - 1, v_revision.edition, v_revision.correction_note, v_actor.person_id);
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN v_revision.edition = 1 THEN 'issue.release' ELSE 'issue.correction_release' END, 'issue', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_issue_correct(p_ctx jsonb, p_issue uuid, p_expected_revision integer, p_note text) RETURNS trustwork.issue
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_row trustwork.issue%ROWTYPE := trustwork.content_issue_lock(p_issue, p_expected_revision);
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.correct'], v_row.hub_id);
  v_before jsonb := to_jsonb(v_row);
  v_current uuid;
  v_new uuid;
BEGIN
  IF v_row.status NOT IN ('released', 'corrected') OR EXISTS (SELECT 1 FROM trustwork.issue_revision WHERE issue_id = v_row.id AND status = 'draft') THEN
    RAISE EXCEPTION 'a correction edition follows a release, one at a time' USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  IF length(coalesce(p_note, '')) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a correction edition carries a note' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.correction_note_required';
  END IF;
  SELECT id INTO v_current FROM trustwork.issue_revision WHERE issue_id = v_row.id AND edition = v_row.current_edition;
  INSERT INTO trustwork.issue_revision (issue_id, edition, correction_note, created_by) VALUES (v_row.id, v_row.current_edition + 1, p_note, v_actor.person_id) RETURNING id INTO v_new;
  INSERT INTO trustwork.issue_item (issue_revision_id, position, section, publication_id, publication_version_id)
  SELECT v_new, i.position, i.section, i.publication_id, coalesce(p.current_version_id, i.publication_version_id)
    FROM trustwork.issue_item i JOIN trustwork.publication p ON p.id = i.publication_id
   WHERE i.issue_revision_id = v_current AND p.status <> 'retracted';
  UPDATE trustwork.issue SET updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'issue.correction_open', 'issue', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_render_request(p_ctx jsonb, p_issue uuid, p_edition integer, p_format text) RETURNS trustwork.render_artifact
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_issue trustwork.issue%ROWTYPE := trustwork.content_issue_lock(p_issue, NULL);
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.render'], v_issue.hub_id);
  v_revision uuid;
  v_row trustwork.render_artifact%ROWTYPE;
BEGIN
  SELECT id INTO v_revision FROM trustwork.issue_revision WHERE issue_id = p_issue AND edition = p_edition;
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'edition not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  INSERT INTO trustwork.render_artifact (issue_revision_id, format, requested_by) VALUES (v_revision, p_format, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_issue.hub_id, 'issue.render_requested', 'render_artifact', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_render_record(p_ctx jsonb, p_render uuid, p_status text, p_artifact uuid, p_sha256 text, p_renderer text, p_failure text) RETURNS trustwork.render_artifact
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_row trustwork.render_artifact%ROWTYPE;
  v_hub uuid;
  v_actor trustwork.admin_actor;
  v_before jsonb;
BEGIN
  SELECT r.* INTO v_row FROM trustwork.render_artifact r WHERE r.id = p_render FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'render not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  SELECT i.hub_id INTO v_hub FROM trustwork.issue_revision r JOIN trustwork.issue i ON i.id = r.issue_id WHERE r.id = v_row.issue_revision_id;
  v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.render'], v_hub);
  IF p_artifact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.evidence_artifact a WHERE a.id = p_artifact AND a.sha256 = p_sha256) THEN
    RAISE EXCEPTION 'the artifact does not carry this hash' USING ERRCODE = 'check_violation', HINT = 'content.artifact_mismatch';
  END IF;
  v_before := to_jsonb(v_row);
  UPDATE trustwork.render_artifact SET status = p_status, artifact_id = p_artifact, sha256 = CASE WHEN p_status = 'rendered' THEN p_sha256 END,
         renderer_version = CASE WHEN p_status = 'rendered' THEN p_renderer END, failure_reason = CASE WHEN p_status = 'failed' THEN p_failure END, completed_at = now()
   WHERE id = p_render RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_hub, 'issue.render_recorded', 'render_artifact', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_digest_create(p_ctx jsonb, p_hub uuid, p_title text, p_period text, p_publications uuid[]) RETURNS trustwork.magazine_digest
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.curate'], p_hub);
  v_row trustwork.magazine_digest%ROWTYPE;
  v_pub trustwork.publication%ROWTYPE;
  v_version trustwork.publication_version%ROWTYPE;
  v_id uuid;
  v_pos integer := 0;
  v_full boolean;
BEGIN
  INSERT INTO trustwork.magazine_digest (hub_id, title, period, created_by) VALUES (p_hub, p_title, p_period, v_actor.person_id) RETURNING * INTO v_row;
  FOREACH v_id IN ARRAY coalesce(p_publications, '{}') LOOP
    SELECT * INTO v_pub FROM trustwork.publication WHERE id = v_id AND hub_id = p_hub;
    IF NOT FOUND OR NOT trustwork.content_public_ok(v_pub) OR v_pub.status = 'retracted' THEN
      RAISE EXCEPTION 'digests reference public publications of this hub' USING ERRCODE = 'check_violation', HINT = 'content.not_public';
    END IF;
    SELECT * INTO v_version FROM trustwork.publication_version WHERE id = v_pub.current_version_id;
    v_full := v_pub.licence = 'cc_by' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_version.source_refs) s
                                                       WHERE s ->> 'kind' <> 'own_reporting' AND NOT coalesce((s -> 'allowedUses' ->> 'syndicateToPeers')::boolean, false));
    v_pos := v_pos + 1;
    INSERT INTO trustwork.magazine_digest_item (digest_id, position, home_node, global_id, version, licence, display, title, local_publication_id, local_version_id)
    VALUES (v_row.id, v_pos, 'local', v_pub.id::text, v_version.version, v_pub.licence, CASE WHEN v_full THEN 'full' ELSE 'headline_link' END, v_version.title, v_pub.id, v_version.id);
  END LOOP;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'digest.create', 'magazine_digest', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_digest_release(p_ctx jsonb, p_digest uuid, p_expected_revision integer) RETURNS trustwork.magazine_digest
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_row trustwork.magazine_digest%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_before jsonb;
BEGIN
  SELECT * INTO v_row FROM trustwork.magazine_digest WHERE id = p_digest FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'digest not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.release'], v_row.hub_id);
  IF p_expected_revision IS NOT NULL AND v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the digest changed' USING ERRCODE = 'serialization_failure', HINT = 'content.revision_conflict';
  END IF;
  IF v_row.status <> 'draft' OR NOT EXISTS (SELECT 1 FROM trustwork.magazine_digest_item WHERE digest_id = v_row.id) THEN
    RAISE EXCEPTION 'a digest is released once, with items' USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  v_before := to_jsonb(v_row);
  UPDATE trustwork.magazine_digest SET status = 'released', released_at = now(), released_by = v_actor.person_id WHERE id = v_row.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'digest.release', 'magazine_digest', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_publish_due(p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_pub trustwork.publication%ROWTYPE;
  v_draft uuid;
  v_count integer := 0;
BEGIN
  FOR v_pub IN SELECT * FROM trustwork.publication WHERE status = 'scheduled' AND scheduled_for <= now() ORDER BY scheduled_for, id LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
               FOR UPDATE SKIP LOCKED LOOP
    SELECT id INTO v_draft FROM trustwork.publication_version WHERE publication_id = v_pub.id AND status = 'draft';
    PERFORM trustwork.content_release_version(v_pub, v_draft, (SELECT drafted_by FROM trustwork.publication_version WHERE id = v_draft), 'published');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_lock(p_pub uuid, p_expected_revision integer) RETURNS trustwork.publication
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_row trustwork.publication%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.publication WHERE id = p_pub FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  IF p_expected_revision IS NOT NULL AND v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the publication changed' USING ERRCODE = 'serialization_failure', HINT = 'content.revision_conflict';
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_issue_lock(p_issue uuid, p_expected_revision integer) RETURNS trustwork.issue
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_row trustwork.issue%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.issue WHERE id = p_issue FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  IF p_expected_revision IS NOT NULL AND v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the issue changed' USING ERRCODE = 'serialization_failure', HINT = 'content.revision_conflict';
  END IF;
  RETURN v_row;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.content_release_version(p_pub trustwork.publication, p_version_id uuid, p_actor uuid, p_status text) RETURNS trustwork.publication
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE
  v_version trustwork.publication_version%ROWTYPE;
  v_blockers text[];
  v_row trustwork.publication%ROWTYPE;
BEGIN
  SELECT * INTO v_version FROM trustwork.publication_version WHERE id = p_version_id AND publication_id = p_pub.id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no draft version to publish' USING ERRCODE = 'check_violation', HINT = 'content.no_draft';
  END IF;
  v_blockers := trustwork.content_publication_blockers(p_pub, v_version);
  IF cardinality(v_blockers) > 0 THEN
    RAISE EXCEPTION 'publication blocked: %', array_to_string(v_blockers, ', ') USING ERRCODE = 'check_violation', HINT = 'content.' || v_blockers[1];
  END IF;
  UPDATE trustwork.publication_version SET status = 'published', published_at = now(), published_by = p_actor, content_digest = trustwork.content_version_digest(v_version)
   WHERE id = v_version.id;
  UPDATE trustwork.publication SET status = p_status, current_version = v_version.version, current_version_id = v_version.id, scheduled_for = NULL,
         first_published_at = coalesce(first_published_at, now())
   WHERE id = p_pub.id RETURNING * INTO v_row;
  RETURN v_row;
END;
END $$;

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

CREATE OR REPLACE FUNCTION trustwork.provenance_review_translation(p_ctx jsonb, p_input jsonb) RETURNS trustwork.provenance_review
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE v_me uuid := trustwork.admin_require_caller(); r trustwork.provenance_record; v trustwork.publication_version;
 o trustwork.publication_version; p trustwork.publication; original trustwork.publication; result trustwork.provenance_review;
BEGIN
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=(p_input->>'provenanceId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  SELECT * INTO o FROM trustwork.publication_version WHERE id=r.original_version_id;
  PERFORM 1 FROM trustwork.publication WHERE id IN(r.publication_id,o.publication_id) ORDER BY id FOR UPDATE;
  SELECT * INTO p FROM trustwork.publication WHERE id=r.publication_id;
  SELECT * INTO v FROM trustwork.publication_version WHERE id=r.version_id FOR UPDATE;
  PERFORM trustwork.provenance_authorize(p_ctx,p,true);
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
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.provenance_consent(p_ctx jsonb, p_input jsonb) RETURNS trustwork.provenance_credit_consent
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE v_me uuid := trustwork.admin_require_caller(); r trustwork.provenance_record; result trustwork.provenance_credit_consent; v_channels text[];
BEGIN
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=(p_input->>'provenanceId')::uuid;
  IF r.id IS NOT NULL THEN PERFORM 1 FROM trustwork.provenance_record WHERE id=r.id FOR UPDATE; END IF;
  v_me:=trustwork.provenance_session(p_ctx);
  IF r.id IS NULL OR NOT (CASE p_input->>'role' WHEN 'responsible_editor' THEN r.responsible_person_id=v_me
    WHEN 'translation_reviewer' THEN EXISTS(SELECT 1 FROM trustwork.provenance_review WHERE provenance_id=r.id AND reviewer_person_id=v_me) ELSE false END) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found';
  END IF;
  IF p_input->'informedConsent' IS DISTINCT FROM 'true'::jsonb OR NOT EXISTS(SELECT 1 FROM trustwork.person WHERE id=v_me AND display_name=p_input->>'credit') THEN
    RAISE EXCEPTION 'explicit current credit required' USING ERRCODE='23514',HINT='provenance.consent_required';
  END IF;
  SELECT array_agg(x) INTO v_channels FROM jsonb_array_elements_text(p_input->'channels') x;
  IF cardinality(v_channels) <> (SELECT count(DISTINCT x) FROM unnest(v_channels) x) THEN RAISE EXCEPTION 'duplicate channels' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM trustwork.provenance_credit_consent c WHERE c.provenance_id=r.id AND c.person_id=v_me AND c.role=p_input->>'role' AND c.channels && v_channels
    AND NOT EXISTS(SELECT 1 FROM trustwork.provenance_credit_revocation revoked WHERE revoked.consent_id=c.id)) THEN
    RAISE EXCEPTION 'revoke overlapping consent before replacing it' USING ERRCODE='23514',HINT='provenance.consent_overlap';
  END IF;
  INSERT INTO trustwork.provenance_credit_consent(provenance_id,person_id,role,credit,channels,notice_version,session_id,request_id)
    VALUES(r.id,v_me,p_input->>'role',p_input->>'credit',v_channels,p_input->>'noticeVersion',(p_ctx->>'sessionId')::uuid,p_ctx->>'requestId') RETURNING * INTO result;
  PERFORM trustwork.provenance_journal(p_ctx,r.id,r.publication_id,'provenance.credit_granted',NULL);
  RETURN result;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.provenance_revoke(p_ctx jsonb, p_id uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE v_me uuid := trustwork.admin_require_caller(); c trustwork.provenance_credit_consent; r trustwork.provenance_record;
BEGIN
  SELECT * INTO c FROM trustwork.provenance_credit_consent WHERE id=p_id AND person_id=v_me FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=c.provenance_id;
  v_me:=trustwork.provenance_session(p_ctx);
  INSERT INTO trustwork.provenance_credit_revocation(consent_id,person_id,reason) VALUES(c.id,v_me,p_reason) ON CONFLICT DO NOTHING;
  PERFORM trustwork.provenance_journal(p_ctx,r.id,r.publication_id,'provenance.credit_revoked',p_reason);
  RETURN c.id;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.provenance_require_publishable(p_ctx jsonb,p_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE r trustwork.provenance_record; v trustwork.publication_version; p trustwork.publication; original trustwork.publication;
BEGIN
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  SELECT p2.* INTO original FROM trustwork.publication p2 JOIN trustwork.publication_version o ON o.publication_id=p2.id WHERE o.id=r.original_version_id;
  PERFORM 1 FROM trustwork.publication WHERE id IN(r.publication_id,original.id) ORDER BY id FOR UPDATE;
  SELECT * INTO p FROM trustwork.publication WHERE id=r.publication_id;
  SELECT * INTO v FROM trustwork.publication_version WHERE id=r.version_id FOR UPDATE;
  PERFORM trustwork.provenance_authorize(p_ctx,p);
  IF v.status<>'draft' OR v.revision<>r.version_revision OR trustwork.content_version_digest(v)<>r.version_digest
     OR r.revision<>(SELECT max(revision) FROM trustwork.provenance_record WHERE version_id=v.id) THEN
    RAISE EXCEPTION 'provenance binding changed' USING ERRCODE='23514',HINT='provenance.binding_mismatch';
  END IF;
  IF r.kind='machine_translation' AND (NOT EXISTS(SELECT 1 FROM trustwork.provenance_review WHERE provenance_id=r.id)
    OR NOT EXISTS(SELECT 1 FROM trustwork.publication op WHERE op.id=original.id AND op.current_version_id=r.original_version_id AND op.status<>'retracted'
      AND trustwork.content_public_ok(op))) THEN
    RAISE EXCEPTION 'exact translation review required' USING ERRCODE='23514',HINT='provenance.review_required';
  END IF;
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.provenance_attach_test_image(p_ctx jsonb,p_attachment jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE r trustwork.provenance_record; p trustwork.publication; v trustwork.publication_version; i jsonb:=p_attachment->'input'; result uuid;
BEGIN
  SELECT * INTO r FROM trustwork.provenance_record WHERE id=(i->>'provenanceId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002',HINT='content.not_found'; END IF;
  SELECT * INTO p FROM trustwork.publication WHERE id=r.publication_id FOR UPDATE;
  SELECT * INTO v FROM trustwork.publication_version WHERE id=r.version_id;
  PERFORM trustwork.provenance_authorize(p_ctx,p);
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
END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.provenance_prepare_correction(p_ctx jsonb,p_pub uuid,p_expected integer,p_draft jsonb,p_note text) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.provenance_content_gate();
DECLARE p trustwork.publication := trustwork.content_lock(p_pub,p_expected); v trustwork.publication_version;
BEGIN
 PERFORM 1 FROM trustwork.publication_version WHERE publication_id=p.id AND status='draft' FOR UPDATE;
 PERFORM trustwork.provenance_authorize(p_ctx,p);
 IF p.status NOT IN ('published','corrected') OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 THEN
   RAISE EXCEPTION 'published original and correction note required' USING ERRCODE='23514',HINT='content.not_published';
 END IF;
 v := trustwork.content_write_draft(p,p_draft,p.current_version,p_note);
 UPDATE trustwork.publication SET updated_at=now() WHERE id=p.id RETURNING * INTO p;
 PERFORM trustwork.provenance_journal(p_ctx,v.id,p.id,'provenance.correction_prepared',p_note);
 RETURN p;
END;
END $$;
