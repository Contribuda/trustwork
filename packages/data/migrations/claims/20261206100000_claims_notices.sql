-- CLM-001 part 2: what the claim routes need from the database.
--
-- 1. Proof of a mailbox. `claims_submit` of part 1 took the address of a domain tie as typed, so anyone who knew a
--    company's domain could name an address on it. An address now counts only when it is a verified login address of
--    the claimant. A new tie kind, `own_domain_mailbox`, records that plainly: the claimant confirmed a code sent to a
--    mailbox on the company's own domain (docs/engine/discovery-and-outreach.md section 7). `invitation_link` keeps its
--    meaning and the same proof until the single-use tokens of OUTR-002 exist.
-- 2. A holder of a claimed-level hand-over who asks for the verified level is not taking over anything: they do not
--    wait for themselves. Asking again for a level already held is refused.
-- 3. A claim asks SANC-003 to screen the claimant and the company: `claims_decide` needs both clear, and the screening
--    engine reacts to the two new events (SCREENING_TRIGGER_EVENTS, trigger `claim`).
-- 4. Notices through COMMS-001. The registry gains `claims.page_notice` (to the people who manage a page: a claim
--    arrived, or the page was handed over) and `claims.claim_update` (to a claimant). Triggers on the claim and the
--    hand-over raise them, so no command can forget one. Parameters are the public company name, an outcome word and a
--    date: never who claims, never a note, never evidence. Both are account notices, so e-mail is planned at once; the
--    API renders the hub's active text in the same transaction (`claims_planned_deliveries`).
-- 5. `claims_active_recipes`: a claimant reads which recipes a hub offers for each level, without any staff right.

-- 1. Tie vocabulary --------------------------------------------------------------------------------------------------
ALTER TABLE trustwork.company_claim DROP CONSTRAINT company_claim_domain_tie_check;
ALTER TABLE trustwork.company_claim ADD CONSTRAINT company_claim_domain_tie_check
  CHECK (domain_tie IN ('invitation_link', 'own_domain_mailbox', 'register_officer_match'));
ALTER TABLE trustwork.company_claim DROP CONSTRAINT company_claim_tie;
ALTER TABLE trustwork.company_claim ADD CONSTRAINT company_claim_tie
  CHECK (coalesce(domain_tie IN ('invitation_link', 'own_domain_mailbox'), false) = (domain_tie_domain IS NOT NULL));

-- 2. Notification registry (database twin of NOTIFICATION_TEMPLATES; the bodies repeat the existing keys unchanged) ------
CREATE OR REPLACE FUNCTION trustwork.comms_template_params(p_key text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_key
    WHEN 'thread.opened' THEN ARRAY['contextKind', 'threadSubject', 'authorName']
    WHEN 'thread.message' THEN ARRAY['contextKind', 'threadSubject', 'authorName']
    WHEN 'account.security_notice' THEN ARRAY['event']
    WHEN 'registers.licence_expiring' THEN ARRAY['factKind', 'validUntil', 'daysBefore']
    WHEN 'claims.page_notice' THEN ARRAY['companyName', 'stage', 'waitingUntil']
    WHEN 'claims.claim_update' THEN ARRAY['companyName', 'outcome']
  END::text[]
$$;
CREATE OR REPLACE FUNCTION trustwork.comms_template_category(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_key WHEN 'thread.opened' THEN 'messages' WHEN 'thread.message' THEN 'messages' WHEN 'account.security_notice' THEN 'account'
    WHEN 'registers.licence_expiring' THEN 'account' WHEN 'claims.page_notice' THEN 'account' WHEN 'claims.claim_update' THEN 'account' END
$$;

-- 3. Submission --------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trustwork.claims_submit(p_hub uuid, p_company uuid, p_level text, p_recipe uuid, p_tie jsonb) RETURNS trustwork.company_claim
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_company trustwork.company%ROWTYPE;
  v_other trustwork.company_claim%ROWTYPE;
  v_dispute uuid;
  v_domain text;
  v_tie text;
  v_state text := 'open';
  v_waiting timestamptz;
  v_row trustwork.company_claim%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'a principal is required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.email_binding WHERE person_id = v_person AND verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'claims come from a verified login' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.verified_login_required';
  END IF;
  SELECT * INTO v_company FROM trustwork.company WHERE id = p_company FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM trustwork.hub WHERE id = p_hub) THEN
    RAISE EXCEPTION 'no such page' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  IF p_level NOT IN ('claimed', 'verified') THEN
    RAISE EXCEPTION 'a claim is for the claimed or the verified level' USING ERRCODE = 'check_violation', HINT = 'claims.invalid_level';
  END IF;
  PERFORM trustwork.claims_recipe(p_hub, p_recipe, p_level);
  IF EXISTS (SELECT 1 FROM trustwork.company_claim WHERE company_id = p_company AND claimant_id = v_person AND state IN ('open', 'waiting', 'disputed')) THEN
    RAISE EXCEPTION 'you already have a claim on this page' USING ERRCODE = 'unique_violation', HINT = 'claims.already_claiming';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.company_handover WHERE company_id = p_company AND person_id = v_person AND revoked_at IS NULL AND (level = 'verified' OR p_level = 'claimed')) THEN
    RAISE EXCEPTION 'you already manage this page' USING ERRCODE = 'check_violation', HINT = 'claims.already_managing';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.claim_dispute WHERE company_id = p_company AND state = 'open') THEN
    RAISE EXCEPTION 'a dispute about this page is open' USING ERRCODE = 'check_violation', HINT = 'claims.dispute_open';
  END IF;
  -- The domain tie: the address must be the claimant's own verified address, on a domain recorded for the company and
  -- not on a free service. Anything else is recorded as nothing; a tie never moves a claim by itself.
  IF p_tie IS NOT NULL AND p_tie ->> 'kind' IN ('invitation_link', 'own_domain_mailbox') AND (p_tie ->> 'email') ~ '^[^@\s]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
    v_domain := lower(split_part(p_tie ->> 'email', '@', 2));
    IF NOT (v_domain = ANY (trustwork.claims_free_mail_domains())) AND v_domain = ANY (trustwork.claims_company_domains(p_company))
       AND EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.person_id = v_person AND b.verified_at IS NOT NULL AND b.email_normalized = lower(p_tie ->> 'email')) THEN
      v_tie := p_tie ->> 'kind';
    ELSE
      v_domain := NULL;
    END IF;
  END IF;
  -- Takeover protection: a page someone else holds is claimed only at the verified level, after a waiting period.
  IF EXISTS (SELECT 1 FROM trustwork.company_handover WHERE company_id = p_company AND revoked_at IS NULL AND person_id <> v_person) THEN
    IF p_level <> 'verified' THEN
      RAISE EXCEPTION 'a managed page is claimed only with verified-level evidence' USING ERRCODE = 'check_violation', HINT = 'claims.verified_level_required';
    END IF;
    v_state := 'waiting';
    v_waiting := now() + make_interval(days => trustwork.claims_waiting_days(p_hub));
  END IF;
  SELECT * INTO v_other FROM trustwork.company_claim WHERE company_id = p_company AND state IN ('open', 'waiting') FOR UPDATE;
  IF FOUND THEN
    INSERT INTO trustwork.claim_dispute (hub_id, company_id) VALUES (p_hub, p_company) RETURNING id INTO v_dispute;
    UPDATE trustwork.company_claim SET state = 'disputed', dispute_id = v_dispute, revision = revision + 1 WHERE id = v_other.id;
    v_state := 'disputed';
  END IF;
  INSERT INTO trustwork.company_claim (hub_id, company_id, claimant_id, level, recipe_id, domain_tie, domain_tie_domain, state, waiting_until, dispute_id)
  VALUES (p_hub, p_company, v_person, p_level, p_recipe, v_tie, v_domain, v_state, v_waiting, v_dispute)
  RETURNING * INTO v_row;
  -- SANC-003 screens both sides of a claim; the events carry identifiers only.
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload) VALUES
    ('person', v_person::text, 1, 'identity.company_claim_submitted', jsonb_build_object('claimId', v_row.id)),
    ('company', p_company::text, 1, 'company.claim_submitted', jsonb_build_object('claimId', v_row.id));
  RETURN v_row;
END $$;

-- 4. Notices -----------------------------------------------------------------------------------------------------------
-- One notification, planned for e-mail when a person acts. Invoked from triggers inside the claim commands only, so
-- it needs no grant. A worker with no person records the bell notice alone.
CREATE FUNCTION trustwork.claims_notify(p_recipient uuid, p_template text, p_params jsonb, p_dedupe text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  v_notification uuid;
BEGIN
  INSERT INTO trustwork.notification (recipient_person_id, category, template_key, params, transactional, dedupe_key, created_by_person_id)
  VALUES (p_recipient, trustwork.comms_template_category(p_template), p_template, p_params, trustwork.comms_template_transactional(p_template), p_dedupe, v_actor)
  ON CONFLICT (recipient_person_id, dedupe_key) DO NOTHING RETURNING id INTO v_notification;
  IF v_notification IS NOT NULL AND v_actor IS NOT NULL THEN
    PERFORM 1 FROM trustwork.comms_plan_deliveries(v_notification, v_actor);
  END IF;
END $$;

-- Who runs a page today: its active administrators and the holders of an active hand-over (a claimed-level holder has
-- no membership).
CREATE FUNCTION trustwork.claims_page_people(p_company uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT m.person_id FROM trustwork.membership m WHERE m.company_id = p_company AND m.status = 'active' AND m.role = 'administrator'
  UNION
  SELECT h.person_id FROM trustwork.company_handover h WHERE h.company_id = p_company AND h.revoked_at IS NULL
$$;

CREATE FUNCTION trustwork.claims_claim_notice() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_name text;
  v_outcome text;
  v_person uuid;
BEGIN
  SELECT left(display_name, 200) INTO v_name FROM trustwork.company WHERE id = NEW.company_id;
  IF TG_OP = 'INSERT' AND NEW.waiting_until IS NOT NULL THEN
    FOR v_person IN SELECT p FROM trustwork.claims_page_people(NEW.company_id) p WHERE p <> NEW.claimant_id LOOP
      PERFORM trustwork.claims_notify(v_person, 'claims.page_notice',
        jsonb_build_object('companyName', v_name, 'stage', 'claim_opened', 'waitingUntil', to_char(NEW.waiting_until AT TIME ZONE 'UTC', 'YYYY-MM-DD')), 'claims:page:' || NEW.id::text || ':opened');
    END LOOP;
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_outcome := CASE WHEN NEW.state = 'disputed' THEN 'in_dispute' END;
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    v_outcome := CASE
      WHEN NEW.state = 'disputed' THEN 'in_dispute'
      WHEN OLD.state = 'disputed' AND NEW.state IN ('open', 'waiting') THEN 'back_in_review'
      WHEN NEW.state IN ('approved', 'rejected') THEN NEW.state
    END;
  END IF;
  IF v_outcome IS NOT NULL THEN
    PERFORM trustwork.claims_notify(NEW.claimant_id, 'claims.claim_update', jsonb_build_object('companyName', v_name, 'outcome', v_outcome),
      'claims:claim:' || NEW.id::text || ':' || NEW.revision::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER company_claim_notice AFTER INSERT OR UPDATE OF state ON trustwork.company_claim FOR EACH ROW EXECUTE FUNCTION trustwork.claims_claim_notice();

CREATE FUNCTION trustwork.claims_handover_notice() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_name text;
  v_person uuid;
BEGIN
  SELECT left(display_name, 200) INTO v_name FROM trustwork.company WHERE id = NEW.company_id;
  IF TG_OP = 'INSERT' THEN
    FOR v_person IN SELECT p FROM trustwork.claims_page_people(NEW.company_id) p WHERE p <> NEW.person_id LOOP
      PERFORM trustwork.claims_notify(v_person, 'claims.page_notice', jsonb_build_object('companyName', v_name, 'stage', 'handed_over'), 'claims:page:' || NEW.id::text || ':handed_over');
    END LOOP;
  ELSIF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    PERFORM trustwork.claims_notify(NEW.person_id, 'claims.claim_update', jsonb_build_object('companyName', v_name, 'outcome', 'revoked'), 'claims:handover:' || NEW.id::text || ':revoked');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER company_handover_notice AFTER INSERT OR UPDATE OF revoked_at ON trustwork.company_handover FOR EACH ROW EXECUTE FUNCTION trustwork.claims_handover_notice();

-- The e-mail deliveries of claim notices the caller planned in this transaction and the API has not rendered yet.
-- Rendering settles each of them, so nothing older is ever left here.
CREATE FUNCTION trustwork.claims_planned_deliveries() RETURNS SETOF trustwork.comms_planned_delivery
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT d.id, n.id, d.recipient_person_id, d.channel, d.provider, d.channel_grant_id, NULL::text, coalesce(pp.languages, '{}'::text[]), n.template_key, n.params, n.transactional,
         n.link_kind, n.link_id, n.link_thread_id
    FROM trustwork.delivery d
    JOIN trustwork.notification n ON n.id = d.notification_id
    LEFT JOIN trustwork.person_profile pp ON pp.person_id = d.recipient_person_id
   WHERE d.created_by_person_id = trustwork.current_person_id() AND d.state = 'queued' AND d.channel = 'email' AND d.mail_delivery_id IS NULL AND n.template_key LIKE 'claims.%'
   ORDER BY d.created_at, d.id
$$;

-- 5. What a hub offers a claimant --------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.claims_active_recipes(p_hub uuid) RETURNS TABLE (id uuid, level text, key text, version integer, steps jsonb, badge_categories text[], recheck_months integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r.id, CASE r.trigger WHEN 'claim_claimed' THEN 'claimed' ELSE 'verified' END, r.key, r.version, r.steps, r.badge_categories, r.recheck_months
    FROM trustwork.verification_recipe r
   WHERE r.hub_id = p_hub AND r.status = 'active' AND r.subject_kind = 'company' AND r.trigger IN ('claim_claimed', 'claim_verified') AND trustwork.current_person_id() IS NOT NULL
   ORDER BY r.trigger, r.key
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.claims_planned_deliveries(), trustwork.claims_active_recipes(uuid) TO trustwork_app;
