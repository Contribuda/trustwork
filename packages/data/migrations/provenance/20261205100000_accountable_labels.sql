-- PROV-001: a disclosed piece names its responsible person; a tool is never a credit; one blocked piece cannot
-- hold back every other scheduled release. Forward-only; earlier migrations and published digests stay as they are.

-- The responsible person's current public credit on web pages, bound to the exact provenance record.
CREATE FUNCTION trustwork.provenance_editor_credited(r trustwork.provenance_record) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM trustwork.provenance_credit_consent c
    JOIN trustwork.person person ON person.id=c.person_id
    WHERE c.provenance_id=r.id AND c.role='responsible_editor' AND c.person_id=r.responsible_person_id
      AND 'web'=ANY(c.channels) AND person.display_name=c.credit
      AND NOT EXISTS(SELECT 1 FROM trustwork.provenance_credit_revocation revoked WHERE revoked.consent_id=c.id))
$$;
REVOKE ALL ON FUNCTION trustwork.provenance_editor_credited(trustwork.provenance_record) FROM PUBLIC,trustwork_app,trustwork_worker;

-- Consent stays free to withdraw after publication: the check applies to a version being released, never to one
-- already published, so a withdrawal removes the name without withholding the piece or blocking a later issue.
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
 IF r.kind<>'none' AND v.status='draft' AND NOT trustwork.provenance_editor_credited(r) THEN RETURN 'provenance_credit_required'; END IF;
 RETURN NULL;
END $$;

-- Literal tool names only; keep in step with MACHINE_CREDIT in packages/contracts/src/provenance.ts.
CREATE FUNCTION trustwork.provenance_machine_credit(p_credit text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT btrim(p_credit) ~* '^(ai|a\.i\.|artificial intelligence|chatgpt|gpt|claude|codex|gemini|copilot|ии)$'
$$;
REVOKE ALL ON FUNCTION trustwork.provenance_machine_credit(text) FROM PUBLIC,trustwork_app,trustwork_worker;

CREATE FUNCTION trustwork.provenance_credit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.provenance_machine_credit(NEW.credit) THEN
    RAISE EXCEPTION 'a tool is never an author' USING ERRCODE='23514',HINT='content.credit_names_a_tool';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trustwork.provenance_credit_guard() FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE TRIGGER provenance_credit_guard BEFORE INSERT ON trustwork.publication_authorship FOR EACH ROW EXECUTE FUNCTION trustwork.provenance_credit_guard();

-- A due piece that no longer passes (consent withdrawn, original corrected, source revoked) stays scheduled and is
-- recorded once per reason; the others in the same run still go out. Only rule refusals are caught: anything else,
-- such as the authority gate timing out, still aborts the run.
CREATE OR REPLACE FUNCTION trustwork.content_publish_due(p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_pub trustwork.publication%ROWTYPE;
  v_draft uuid;
  v_count integer := 0;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 500));
  v_hint text;
BEGIN
  PERFORM trustwork.provenance_content_gate();
  FOR v_pub IN SELECT * FROM trustwork.publication WHERE status = 'scheduled' AND scheduled_for <= now() ORDER BY scheduled_for, id
               FOR UPDATE SKIP LOCKED LOOP
    EXIT WHEN v_count >= v_limit;
    SELECT id INTO v_draft FROM trustwork.publication_version WHERE publication_id = v_pub.id AND status = 'draft';
    BEGIN
      PERFORM trustwork.content_release_version(v_pub, v_draft, (SELECT drafted_by FROM trustwork.publication_version WHERE id = v_draft), 'published');
      v_count := v_count + 1;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF NOT EXISTS(SELECT 1 FROM trustwork.audit_event WHERE object_kind='publication' AND object_id=v_pub.id::text
        AND action='publication.schedule_blocked' AND reason=v_hint) THEN
        INSERT INTO trustwork.audit_event(action,object_kind,object_id,reason,basis)
          VALUES('publication.schedule_blocked','publication',v_pub.id::text,v_hint,jsonb_build_object('scheduledFor',trustwork.content_iso(v_pub.scheduled_for)));
      END IF;
    END;
  END LOOP;
  RETURN v_count;
END $$;
