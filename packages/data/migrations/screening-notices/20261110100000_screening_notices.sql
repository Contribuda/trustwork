-- SANC-007: transactional subject notices and recorded appeal routing. No legal disclosure policy is assumed.
-- Existing subject commands, staff authority, suspension and second-person approvals remain authoritative.
ALTER TABLE trustwork.mail_delivery DROP CONSTRAINT mail_delivery_template_check;
ALTER TABLE trustwork.mail_delivery ADD CONSTRAINT mail_delivery_template_check CHECK
  (template IN ('verify_email', 'already_registered', 'recovery', 'email_change', 'membership_invitation', 'security_notice', 'notification', 'screening_notice'));

-- Each appeal keeps its original decision and intended independent reviewer; no participant can read this table.
CREATE TABLE trustwork.screening_appeal_assignment (
  appeal_id uuid PRIMARY KEY REFERENCES trustwork.screening_decision(id),
  match_id uuid NOT NULL REFERENCES trustwork.screening_match(id),
  original_decision_id uuid NOT NULL REFERENCES trustwork.screening_decision(id),
  original_decider uuid NOT NULL REFERENCES trustwork.person(id),
  reviewer_id uuid NULL REFERENCES trustwork.person(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reviewer_id IS DISTINCT FROM original_decider)
);
ALTER TABLE trustwork.screening_appeal_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_appeal_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.screening_appeal_assignment TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY screening_appeal_assignment_staff_read ON trustwork.screening_appeal_assignment FOR SELECT TO trustwork_app
  USING (trustwork.jurisdiction_staff_reader());
GRANT SELECT ON trustwork.screening_appeal_assignment TO trustwork_app;
CREATE TRIGGER screening_appeal_assignment_append_only BEFORE UPDATE OR DELETE ON trustwork.screening_appeal_assignment
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER screening_appeal_assignment_no_truncate BEFORE TRUNCATE ON trustwork.screening_appeal_assignment
  FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.screening_route_appeal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  m trustwork.screening_match%ROWTYPE;
  d trustwork.screening_decision%ROWTYPE;
  v_reviewer uuid;
BEGIN
  IF NEW.kind <> 'appeal' THEN RETURN NEW; END IF;
  SELECT * INTO STRICT m FROM trustwork.screening_match WHERE id = NEW.match_id;
  SELECT * INTO STRICT d FROM trustwork.screening_decision
    WHERE match_id = m.id AND kind IN ('confirm', 'uphold') ORDER BY seq DESC LIMIT 1;
  -- Match the existing screening_staff_actor node authority, exclude subject, company members and declared conflicts.
  SELECT a.person_id INTO v_reviewer FROM trustwork.staff_role_assignment a
    WHERE a.role = 'compliance-officer' AND a.scope_kind = 'node' AND a.node_id = trustwork.jurisdiction_node()
      AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
      AND NOT EXISTS (SELECT 1 FROM trustwork.jurisdiction_hold h WHERE h.person_id = a.person_id AND h.cleared_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM trustwork.screening_subject_state s WHERE s.subject_person_id = a.person_id AND s.suspended)
      AND NOT a.breakglass AND a.person_id <> d.decided_by AND a.person_id IS DISTINCT FROM m.subject_person_id
      AND NOT EXISTS (SELECT 1 FROM trustwork.membership x WHERE x.company_id = m.subject_company_id AND x.person_id = a.person_id AND x.status = 'active')
      AND NOT trustwork.admin_conflicted(a.person_id, m.subject_person_id, m.subject_company_id)
    ORDER BY a.person_id LIMIT 1;
  INSERT INTO trustwork.screening_appeal_assignment (appeal_id, match_id, original_decision_id, original_decider, reviewer_id)
    VALUES (NEW.id, m.id, d.id, d.decided_by, v_reviewer);
  -- No eligible reviewer means unassigned, never an invented assignment or a relaxed separation rule.
  RETURN NEW;
END $$;
CREATE TRIGGER screening_route_appeal AFTER INSERT ON trustwork.screening_decision
  FOR EACH ROW EXECUTE FUNCTION trustwork.screening_route_appeal();

-- Invoker helper, inaccessible to API/worker roles. Called only by the definer triggers below.
-- Recipient comes from verified bindings, never from event payloads or an actor-provided address.
CREATE FUNCTION trustwork.screening_record_notice(p_person uuid, p_kind text) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  e record;
  v_id uuid;
BEGIN
  IF p_person IS NULL THEN RETURN; END IF;
  FOR e IN SELECT email_normalized FROM trustwork.email_binding WHERE person_id = p_person AND verified_at IS NOT NULL LOOP
    v_id := trustwork.new_uuid();
    INSERT INTO trustwork.mail_delivery (id, template, locale_preferences, recipient, recipient_hash, params)
      VALUES (v_id, 'screening_notice', array_remove(ARRAY[trustwork.identity_mail_locale(p_person)], NULL), e.email_normalized,
        encode(sha256(convert_to('mail:' || lower(normalize(btrim(e.email_normalized), NFC)), 'UTF8')), 'hex'), jsonb_build_object('kind', p_kind));
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
      VALUES ('mail_delivery', v_id::text, 1, 'mail.requested', '{}'::jsonb);
  END LOOP;
END $$;

CREATE FUNCTION trustwork.screening_hold_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM trustwork.screening_record_notice(NEW.person_id, 'hold');
  ELSIF OLD.cleared_at IS NULL AND NEW.cleared_at IS NOT NULL THEN
    PERFORM trustwork.screening_record_notice(NEW.person_id, 'cleared');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER screening_hold_notice AFTER INSERT OR UPDATE ON trustwork.jurisdiction_hold
  FOR EACH ROW EXECUTE FUNCTION trustwork.screening_hold_notice();

CREATE FUNCTION trustwork.screening_match_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_kind text;
BEGIN
  -- Company information is never mailed to an arbitrary member; company notices need a separate authorized recipient seam.
  IF NEW.subject_person_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN v_kind := 'review';
  ELSIF OLD.state = NEW.state THEN RETURN NEW;
  ELSIF NEW.state = 'appeal' THEN v_kind := 'appeal_received';
  ELSIF (OLD.state = 'appeal' AND NEW.state = 'confirmed') OR
        (OLD.state = 'pending_reversal' AND NEW.state IN ('confirmed', 'not_same_person')) THEN v_kind := 'appeal_outcome';
  ELSIF NEW.state IN ('confirmed', 'not_same_person') THEN v_kind := 'decision';
  ELSE RETURN NEW;
  END IF;
  PERFORM trustwork.screening_record_notice(NEW.subject_person_id, v_kind);
  RETURN NEW;
END $$;
CREATE TRIGGER screening_match_notice AFTER INSERT OR UPDATE ON trustwork.screening_match
  FOR EACH ROW EXECUTE FUNCTION trustwork.screening_match_notice();

REVOKE ALL ON FUNCTION trustwork.screening_route_appeal(), trustwork.screening_record_notice(uuid, text),
  trustwork.screening_hold_notice(), trustwork.screening_match_notice() FROM PUBLIC, trustwork_app, trustwork_worker;
