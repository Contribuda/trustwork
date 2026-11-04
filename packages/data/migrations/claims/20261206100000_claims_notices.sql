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
-- 6. Takeover protection follows who runs a page (`claims_page_people`: an active administrator or a hand-over), so a
--    page its founder runs waits and hears of a claim like a page that was handed over.
-- 7. Evidence belongs to one claim. `verification_check` rows describe a company, so results recorded for an earlier
--    holder would otherwise pass for a challenger. `company_claim_evidence` binds a check to one claim, only when it was
--    recorded after that claim was submitted, and a decision counts only bound checks.

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
  -- Takeover protection: a page someone else runs is claimed only at the verified level, after a waiting period.
  IF EXISTS (SELECT 1 FROM trustwork.claims_page_people(p_company) p WHERE p <> v_person) THEN
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

-- 5. Evidence of one claim ---------------------------------------------------------------------------------------------
CREATE TABLE trustwork.company_claim_evidence (
  claim_id uuid NOT NULL REFERENCES trustwork.company_claim (id),
  check_id uuid NOT NULL UNIQUE REFERENCES trustwork.verification_check (id),
  bound_by uuid NOT NULL REFERENCES trustwork.person (id),
  bound_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, check_id)
);
CREATE TRIGGER company_claim_evidence_append_only BEFORE UPDATE OR DELETE ON trustwork.company_claim_evidence FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- A reviewer binds checks to a claim in play: of its hub, company and recipe, unexpired, recorded after the claim was
-- submitted, by someone other than the claimant, and bound to no other claim.
CREATE FUNCTION trustwork.claims_bind_evidence(p_ctx jsonb, p_claim uuid, p_checks uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_claim trustwork.company_claim%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_check uuid;
  v_count integer := 0;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_claim FROM trustwork.company_claim WHERE id = p_claim FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such claim' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], v_claim.hub_id);
  IF v_actor.person_id = v_claim.claimant_id THEN
    RAISE EXCEPTION 'the claimant does not bind evidence to their own claim' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.own_claim';
  END IF;
  IF v_claim.state NOT IN ('open', 'waiting', 'disputed') THEN
    RAISE EXCEPTION 'a % claim takes no evidence', v_claim.state USING ERRCODE = 'check_violation', HINT = 'claims.invalid_transition';
  END IF;
  FOREACH v_check IN ARRAY p_checks LOOP
    IF NOT EXISTS (SELECT 1 FROM trustwork.verification_check c
                    WHERE c.id = v_check AND c.hub_id = v_claim.hub_id AND c.subject_company_id = v_claim.company_id AND c.recipe_id = v_claim.recipe_id
                      AND c.recorded_at > v_claim.created_at AND c.expires_at > now() AND c.recorded_by IS DISTINCT FROM v_claim.claimant_id)
       OR EXISTS (SELECT 1 FROM trustwork.company_claim_evidence e WHERE e.check_id = v_check AND e.claim_id <> p_claim) THEN
      RAISE EXCEPTION 'a claim takes only its own checks, recorded after it was submitted' USING ERRCODE = 'check_violation', HINT = 'claims.evidence_mismatch';
    END IF;
    INSERT INTO trustwork.company_claim_evidence (claim_id, check_id, bound_by) VALUES (p_claim, v_check, v_actor.person_id) ON CONFLICT DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_claim.hub_id, 'claims.evidence_bound', 'company_claim', p_claim, NULL, jsonb_build_object('checks', to_jsonb(p_checks)));
  RETURN v_count;
END $$;

-- Whether the checks bound to a claim satisfy the recipe's steps: the latest unexpired bound result per check type.
CREATE FUNCTION trustwork.claims_evidence_passes(p_claim uuid, p_recipe uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_latest jsonb;
  v_step jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(x.check_type, x.result), '{}'::jsonb) INTO v_latest FROM (
    SELECT DISTINCT ON (c.check_type) c.check_type, c.result
      FROM trustwork.company_claim_evidence e JOIN trustwork.verification_check c ON c.id = e.check_id
     WHERE e.claim_id = p_claim AND c.expires_at > now()
     ORDER BY c.check_type, c.recorded_at DESC) x;
  FOR v_step IN SELECT e FROM jsonb_array_elements((SELECT r.steps FROM trustwork.verification_recipe r WHERE r.id = p_recipe)) e LOOP
    IF v_step ? 'check' THEN
      IF (v_step ->> 'required')::boolean AND coalesce(v_latest ->> (v_step ->> 'check'), '') <> 'pass' THEN
        RETURN false;
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_step -> 'anyOf') a WHERE v_latest ->> a = 'pass') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

-- The decision of part 1, which now also asks for the claim's own evidence. The hub-wide standing stays: a screening
-- block or a newer failed result about the company still stops a hand-over.
CREATE OR REPLACE FUNCTION trustwork.claims_decide(p_ctx jsonb, p_claim uuid, p_expected_revision integer, p_decision text, p_officer_match boolean, p_note text)
RETURNS trustwork.company_claim
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.company_claim%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_standing jsonb;
  v_state record;
  v_membership uuid;
  v_row trustwork.company_claim%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.company_claim WHERE id = p_claim;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such claim' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  PERFORM 1 FROM trustwork.company WHERE id = v_before.company_id FOR UPDATE;
  SELECT * INTO v_before FROM trustwork.company_claim WHERE id = p_claim FOR UPDATE;
  v_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], v_before.hub_id);
  PERFORM trustwork.claims_check_revision(v_before.revision, p_expected_revision);
  IF v_actor.person_id = v_before.claimant_id THEN
    RAISE EXCEPTION 'the claimant does not decide their own claim' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.own_claim';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected') OR v_before.state NOT IN ('open', 'waiting') THEN
    RAISE EXCEPTION 'a % claim is not decided here', v_before.state USING ERRCODE = 'check_violation', HINT = 'claims.invalid_transition';
  END IF;
  IF v_before.state = 'waiting' AND v_before.waiting_until > now() THEN
    RAISE EXCEPTION 'the waiting period runs until %', v_before.waiting_until USING ERRCODE = 'check_violation', HINT = 'claims.waiting_period';
  END IF;
  IF p_decision = 'approved' THEN
    IF v_before.level = 'claimed' AND v_before.domain_tie IS NULL AND NOT coalesce(p_officer_match, false) THEN
      RAISE EXCEPTION 'the claimed level needs a domain tie or a register officer match' USING ERRCODE = 'check_violation', HINT = 'claims.company_tie_required';
    END IF;
    IF NOT trustwork.claims_evidence_passes(v_before.id, v_before.recipe_id) THEN
      RAISE EXCEPTION 'a decision counts only checks bound to this claim' USING ERRCODE = 'check_violation', HINT = 'claims.evidence_required';
    END IF;
    v_standing := trustwork.verification_evaluate(v_before.hub_id, 'company', v_before.company_id, v_before.recipe_id);
    IF v_standing ->> 'status' <> 'passed' OR (v_standing ->> 'handoverBlocked')::boolean THEN
      RAISE EXCEPTION 'the recipe standing does not allow a hand-over' USING ERRCODE = 'check_violation', HINT = 'claims.standing_not_passed';
    END IF;
    SELECT s.id, s.last_outcome, s.money_held, s.suspended INTO v_state FROM trustwork.screening_state_row(v_before.claimant_id, NULL) s;
    IF NOT trustwork.screening_available() OR v_state.id IS NULL OR v_state.last_outcome IS DISTINCT FROM 'clear' OR v_state.money_held OR v_state.suspended THEN
      RAISE EXCEPTION 'the claimant is not screened clear' USING ERRCODE = 'check_violation', HINT = 'claims.claimant_not_clear';
    END IF;
    IF v_before.level = 'verified' THEN
      IF EXISTS (SELECT 1 FROM trustwork.membership WHERE person_id = v_before.claimant_id AND status = 'active' AND company_id <> v_before.company_id) THEN
        RAISE EXCEPTION 'the claimant works for another company' USING ERRCODE = 'check_violation', HINT = 'claims.claimant_employed_elsewhere';
      END IF;
      SELECT id INTO v_membership FROM trustwork.membership WHERE person_id = v_before.claimant_id AND company_id = v_before.company_id AND status = 'active' FOR UPDATE;
      IF v_membership IS NULL THEN
        INSERT INTO trustwork.membership (person_id, company_id, role, permissions, status, valid_from)
        VALUES (v_before.claimant_id, v_before.company_id, 'administrator', ARRAY['company.page.edit', 'company.members.manage'], 'active', now()) RETURNING id INTO v_membership;
      ELSE
        UPDATE trustwork.membership SET role = 'administrator', permissions = ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['company.page.edit', 'company.members.manage'])),
               revision = revision + 1, updated_at = now() WHERE id = v_membership;
      END IF;
    END IF;
  END IF;
  UPDATE trustwork.company_claim SET state = p_decision, decided_by = v_actor.person_id, decided_at = now(), decision_note = NULLIF(btrim(coalesce(p_note, '')), ''),
         domain_tie = CASE WHEN p_decision = 'approved' AND domain_tie IS NULL AND coalesce(p_officer_match, false) THEN 'register_officer_match' ELSE domain_tie END,
         revision = revision + 1
   WHERE id = p_claim RETURNING * INTO v_row;
  IF p_decision = 'approved' THEN
    INSERT INTO trustwork.company_handover (hub_id, company_id, claim_id, person_id, level, membership_id, decided_by, cooling_until)
    VALUES (v_row.hub_id, v_row.company_id, v_row.id, v_row.claimant_id, v_row.level, v_membership, v_actor.person_id,
      now() + make_interval(days => trustwork.claims_cooling_days(v_row.hub_id)));
    PERFORM trustwork.claims_derive(v_row.company_id);
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'claims.' || p_decision, 'company_claim', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

ALTER TABLE trustwork.company_claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_claim_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.company_claim_evidence AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY company_claim_evidence_read ON trustwork.company_claim_evidence FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.company_claim c WHERE c.id = claim_id AND c.claimant_id IS DISTINCT FROM trustwork.current_person_id() AND trustwork.claims_staff_reader(c.hub_id)));
GRANT SELECT ON trustwork.company_claim_evidence TO trustwork_app;

-- 6. What a hub offers a claimant --------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.claims_active_recipes(p_hub uuid) RETURNS TABLE (id uuid, level text, key text, version integer, steps jsonb, badge_categories text[], recheck_months integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r.id, CASE r.trigger WHEN 'claim_claimed' THEN 'claimed' ELSE 'verified' END, r.key, r.version, r.steps, r.badge_categories, r.recheck_months
    FROM trustwork.verification_recipe r
   WHERE r.hub_id = p_hub AND r.status = 'active' AND r.subject_kind = 'company' AND r.trigger IN ('claim_claimed', 'claim_verified') AND trustwork.current_person_id() IS NOT NULL
   ORDER BY r.trigger, r.key
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.claims_planned_deliveries(), trustwork.claims_active_recipes(uuid), trustwork.claims_bind_evidence(jsonb, uuid, uuid[]) TO trustwork_app;
