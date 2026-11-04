-- CNT-001: a scheduled release is the act of the person who scheduled it, so it needs that person's right when it runs.
--
-- content_publish_due rechecked the piece (blockers, provenance, credit) but not the person: someone removed from the
-- company, stripped of a publish right or of a staff role still had their piece released, and published_by named the
-- drafter, who may have decided nothing. The schedule now records who set it; each due piece rechecks that person and
-- records them as the publisher. Forward-only; published versions and their digests stay as they are.

ALTER TABLE trustwork.publication ADD COLUMN scheduled_by uuid NULL REFERENCES trustwork.person (id);
-- Pieces scheduled before this column have no author on record: they stay NULL, which the recheck refuses, until
-- someone with the right schedules or publishes them again. A guess from the drafter is what this migration removes.
ALTER TABLE trustwork.publication ADD CONSTRAINT publication_scheduled_by CHECK (scheduled_by IS NULL OR status = 'scheduled');

-- Every path out of 'scheduled' (release, return to draft) ends the schedule, and with it the record of who set it.
CREATE FUNCTION trustwork.content_schedule_ended() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.status <> 'scheduled' THEN NEW.scheduled_by := NULL; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trustwork.content_schedule_ended() FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE TRIGGER publication_schedule_ended BEFORE UPDATE OF status ON trustwork.publication FOR EACH ROW EXECUTE FUNCTION trustwork.content_schedule_ended();

-- Same command as 20261120100002, recording who set the schedule.
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
    UPDATE trustwork.publication SET status = 'scheduled', scheduled_for = p_scheduled_for, scheduled_by = v_me WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    v_row := trustwork.content_release_version(v_row, v_draft.id, v_me, 'published');
  END IF;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN v_row.status = 'scheduled' THEN 'publication.scheduled' ELSE 'publication.published' END, 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END;
END $$;

-- Does the person who scheduled this piece still hold a right that could have scheduled it? The same three doors as
-- content_publish, read for that person rather than the caller, because no caller exists when the worker runs. An
-- elevation is a session fact and cannot be rechecked here; the staff role behind it can. A held person is refused on
-- every request, so a release they set up in advance does not go out on their behalf either.
-- Revocations hold their own row before the person's, so waiting here could deadlock with them: NOWAIT, as in
-- provenance_session, and the caller leaves the piece for the next run.
CREATE FUNCTION trustwork.content_release_authority(p trustwork.publication) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE me uuid := p.scheduled_by;
BEGIN
  IF me IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM trustwork.person WHERE id = me FOR SHARE NOWAIT;
  PERFORM 1 FROM trustwork.membership WHERE person_id = me ORDER BY id FOR SHARE NOWAIT;
  PERFORM 1 FROM trustwork.staff_role_assignment WHERE person_id = me ORDER BY id FOR SHARE NOWAIT;
  IF EXISTS (SELECT 1 FROM trustwork.jurisdiction_hold h WHERE h.person_id = me AND h.cleared_at IS NULL) THEN RETURN false; END IF;
  IF p.owner_kind = 'editorial' THEN
    RETURN (SELECT r.role FROM trustwork.admin_resolve_any(me, ARRAY['admin.publications.publish'], NULL, p.hub_id) r) IS NOT NULL;
  END IF;
  RETURN coalesce(p.owner_person_id = me, false)
    OR EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.person_id = me AND m.company_id = p.owner_company_id
      AND m.status = 'active' AND m.valid_from <= now() AND 'company.publish' = ANY (m.permissions))
    OR EXISTS (SELECT 1 FROM trustwork.publication_editor e WHERE e.publication_id = p.id AND e.person_id = me AND e.revoked_at IS NULL AND e.rights = 'publish')
    OR (p.requires_review AND (SELECT r.role FROM trustwork.admin_resolve_any(me, ARRAY['admin.publications.review', 'admin.publications.publish'], NULL, p.hub_id) r) IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION trustwork.content_release_authority(trustwork.publication) FROM PUBLIC,trustwork_app,trustwork_worker;

-- Same run as 20261205100000, with the person rechecked and named. A piece whose scheduler lost the right stays
-- scheduled and is recorded once, as any other blocked piece; anyone who holds the right can release or return it.
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
      IF NOT trustwork.content_release_authority(v_pub) THEN
        RAISE EXCEPTION 'the person who scheduled this piece no longer holds the right to publish it' USING ERRCODE = 'check_violation', HINT = 'content.schedule_authority_lapsed';
      END IF;
      PERFORM trustwork.content_release_version(v_pub, v_draft, v_pub.scheduled_by, 'published');
      INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis)
        VALUES(v_pub.scheduled_by,'publication.scheduled_release','publication',v_pub.id::text,jsonb_build_object('scheduledFor',trustwork.content_iso(v_pub.scheduled_for)));
      v_count := v_count + 1;
    EXCEPTION
      WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF NOT EXISTS(SELECT 1 FROM trustwork.audit_event WHERE object_kind='publication' AND object_id=v_pub.id::text
          AND action='publication.schedule_blocked' AND reason=v_hint) THEN
          INSERT INTO trustwork.audit_event(action,object_kind,object_id,reason,basis)
            VALUES('publication.schedule_blocked','publication',v_pub.id::text,v_hint,jsonb_build_object('scheduledFor',trustwork.content_iso(v_pub.scheduled_for)));
        END IF;
      -- A revocation is in flight for this person. Nothing is decided yet: the next run sees its outcome.
      WHEN lock_not_available THEN NULL;
    END;
  END LOOP;
  RETURN v_count;
END $$;
