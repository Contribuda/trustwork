-- SANC-006: ADR 014 decision 14. `screening.review_requested` had no consumer, so compliance staff heard nothing about a
-- new queue item or hold. Each independent officer of the node now gets a mail intent in the transaction of the event.
-- It names nobody: no parameter, no subject, no list, no entry, no count. There is no preference for it (it cannot be muted).
ALTER TABLE trustwork.mail_delivery DROP CONSTRAINT mail_delivery_template_check;
ALTER TABLE trustwork.mail_delivery ADD CONSTRAINT mail_delivery_template_check CHECK
  (template IN ('verify_email', 'already_registered', 'recovery', 'email_change', 'membership_invitation', 'security_notice', 'notification', 'screening_notice', 'screening_staff_notice'));

-- Internal predicate: the same independence as appeal routing, without an original decider. Grants nothing.
CREATE FUNCTION trustwork.screening_staff_notice_eligible(p_person uuid, p_subject_person uuid, p_subject_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_person IS NOT NULL
    AND NOT trustwork.admin_conflicted(p_person, p_subject_person, p_subject_company)
    AND NOT EXISTS (SELECT 1 FROM trustwork.jurisdiction_hold h WHERE h.person_id = p_person AND h.cleared_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM trustwork.screening_subject_state s WHERE s.subject_person_id = p_person AND s.suspended)
    AND EXISTS (SELECT 1 FROM trustwork.staff_role_assignment r WHERE r.person_id = p_person
      AND r.role = 'compliance-officer' AND r.scope_kind = 'node' AND r.node_id = trustwork.jurisdiction_node()
      AND NOT r.breakglass AND r.revoked_at IS NULL AND r.valid_from <= now() AND (r.valid_until IS NULL OR r.valid_until > now()))
$$;

-- Internal only, called by the event functions below. The recipient comes from verified bindings of current officers,
-- never from an event payload. An unsent notice to the same address already says that work is waiting; a sent one
-- never stops the next.
CREATE FUNCTION trustwork.screening_record_staff_notice(p_subject_person uuid, p_subject_company uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE e record; v_id uuid;
BEGIN
  FOR e IN
    SELECT DISTINCT b.id, b.person_id, b.email_normalized
      FROM trustwork.staff_role_assignment r JOIN trustwork.email_binding b ON b.person_id = r.person_id AND b.verified_at IS NOT NULL
     WHERE r.role = 'compliance-officer' AND r.scope_kind = 'node' AND r.node_id = trustwork.jurisdiction_node()
       AND trustwork.screening_staff_notice_eligible(r.person_id, p_subject_person, p_subject_company)
       AND NOT EXISTS (SELECT 1 FROM trustwork.screening_notice_authority a JOIN trustwork.mail_delivery d ON d.id = a.delivery_id
         WHERE a.binding_id = b.id AND d.template = 'screening_staff_notice' AND d.state = 'pending')
  LOOP
    v_id := trustwork.new_uuid();
    INSERT INTO trustwork.mail_delivery (id, template, locale_preferences, recipient, recipient_hash, params)
      VALUES (v_id, 'screening_staff_notice', array_remove(ARRAY[trustwork.identity_mail_locale(e.person_id)], NULL), e.email_normalized,
        encode(sha256(convert_to('mail:' || lower(normalize(btrim(e.email_normalized), NFC)), 'UTF8')), 'hex'), '{}'::jsonb);
    INSERT INTO trustwork.screening_notice_authority (delivery_id, person_id, binding_id) VALUES (v_id, e.person_id, e.id);
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
      VALUES ('mail_delivery', v_id::text, 1, 'mail.requested', '{}'::jsonb);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_notify_review(p_state uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE s record;
BEGIN
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('screening_case', p_state::text, 1, 'screening.review_requested', jsonb_build_object('queueItemId', p_state, 'mutable', false));
  SELECT subject_person_id, subject_company_id INTO STRICT s FROM trustwork.screening_subject_state WHERE id = p_state;
  PERFORM trustwork.screening_record_staff_notice(s.subject_person_id, s.subject_company_id);
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_hold_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM trustwork.screening_record_notice(NEW.person_id, 'hold');
    PERFORM trustwork.screening_record_staff_notice(NEW.person_id, NULL);
  ELSIF OLD.cleared_at IS NULL AND NEW.cleared_at IS NOT NULL THEN
    PERFORM trustwork.screening_record_notice(NEW.person_id, 'cleared');
  END IF;
  RETURN NEW;
END $$;

-- One dispatch port for both templates. A staff notice also needs an officer who is still independent right now; the
-- subject exclusions were applied at the event, and the mail says nothing about the subject.
CREATE OR REPLACE FUNCTION trustwork.screening_notice_allowed(p_delivery uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM b.id FROM trustwork.screening_notice_authority a
    JOIN trustwork.mail_delivery d ON d.id = a.delivery_id
    JOIN trustwork.email_binding b ON b.id = a.binding_id AND b.person_id = a.person_id
    WHERE a.delivery_id = p_delivery
      AND (d.template = 'screening_notice'
        OR (d.template = 'screening_staff_notice' AND trustwork.screening_staff_notice_eligible(a.person_id, NULL, NULL)))
      AND d.recipient = b.email_normalized AND b.verified_at IS NOT NULL
    FOR SHARE OF b;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION trustwork.screening_staff_notice_eligible(uuid, uuid, uuid), trustwork.screening_record_staff_notice(uuid, uuid),
  trustwork.screening_notify_review(uuid) FROM PUBLIC, trustwork_app, trustwork_worker;
