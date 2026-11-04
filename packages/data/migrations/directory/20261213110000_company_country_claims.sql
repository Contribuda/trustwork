-- Claim review stays inside a hub's territories (issue #592, the launch blocker recorded in #563). A reviewer could
-- grant administrator on any company through a claim filed at their hub, because nothing tied a company to a place.
-- The country of the previous migration is that tie.
--
-- Rules:
--   * deciding a claim, re-checking a verification, proposing or confirming a dispute and verifying an identifier are
--     refused for a hub with no territory inside the company's country, and for a company with no country. A rejection
--     counts: it is a decision too, and a claim on a company with no country waits for a correction;
--   * a dispute lives at the hub of the claim that opened it, so `claims_submit` keeps a company with a country at the
--     hubs of that country. Otherwise a claim filed elsewhere would park a dispute where nobody may decide it;
--   * the check and the write cannot race: the company row is locked first, so a correction finishes before or after,
--     and the territory row stays locked, so `hubs_remove_territory` does too (`directory_lock_hub_cover`);
--   * whoever corrected a company's country does not approve a claim on it or re-check it. A person holding both
--     permissions could otherwise move a company into their hub's territory and hand it over alone;
--   * private records reach staff through an open support case of the company at that hub, as before, or through a
--     claim in play only when the hub covers the company's country;
--   * `claims_revoke` keeps no such check: the hub that gave a hand-over can always undo it.

-- The caller holds the company row, so the country read here is the one the write stands on.
CREATE FUNCTION trustwork.claims_require_territory(p_hub uuid, p_company uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_country text;
  v_region text;
BEGIN
  SELECT country_code, country_region INTO v_country, v_region FROM trustwork.company WHERE id = p_company;
  -- The restricted list may have split the country, or named the region, since the company was created.
  IF v_country IS NULL OR (v_region IS NULL AND trustwork.attestation_region_required(v_country)) THEN
    RAISE EXCEPTION 'the company has no country on record' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.company_country_missing';
  END IF;
  IF NOT trustwork.directory_lock_hub_cover(p_hub, v_country) OR trustwork.kernel_place_restricted(coalesce(v_region, v_country)) THEN
    RAISE EXCEPTION 'this hub does not cover the company''s country' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.outside_territory';
  END IF;
END $$;

CREATE FUNCTION trustwork.claims_refuse_own_correction(p_person uuid, p_company uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trustwork.company_country_correction r WHERE r.company_id = p_company AND r.corrected_by = p_person) THEN
    RAISE EXCEPTION 'the person who corrected the country does not decide here' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.own_country_correction';
  END IF;
END $$;

-- Whether the hub has a reason to read the company's private records: an open support case at this hub, or a claim in
-- play there on a company of a country it covers.
CREATE OR REPLACE FUNCTION trustwork.claims_staff_reachable(p_hub uuid, p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT (EXISTS (SELECT 1 FROM trustwork.company_claim c WHERE c.hub_id = p_hub AND c.company_id = p_company AND c.state IN ('open', 'waiting', 'disputed'))
          AND trustwork.directory_hub_covers(p_hub, (SELECT c.country_code FROM trustwork.company c WHERE c.id = p_company)))
      OR EXISTS (SELECT 1 FROM trustwork.support_case s WHERE s.hub_id = p_hub AND s.subject_company_id = p_company AND s.status NOT IN ('resolved', 'closed'))
$$;

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
  -- A claim goes to a hub of the company's country. Without a country it may be filed anywhere: it waits for a correction.
  IF v_company.country_code IS NOT NULL AND NOT trustwork.directory_lock_hub_cover(p_hub, v_company.country_code) THEN
    RAISE EXCEPTION 'this hub does not cover the company''s country' USING ERRCODE = 'check_violation', HINT = 'claims.company_outside_hub';
  END IF;
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
  PERFORM trustwork.claims_require_territory(v_before.hub_id, v_before.company_id);
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
    PERFORM trustwork.claims_refuse_own_correction(v_actor.person_id, v_before.company_id);
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

CREATE OR REPLACE FUNCTION trustwork.claims_recheck(p_ctx jsonb, p_verification uuid, p_recipe uuid) RETURNS trustwork.company_verification
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.company_verification%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_recipe trustwork.verification_recipe%ROWTYPE;
  v_standing jsonb;
  v_holder uuid;
  v_state record;
  v_row trustwork.company_verification%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.company_verification WHERE id = p_verification;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such verification' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  PERFORM 1 FROM trustwork.company WHERE id = v_before.company_id FOR UPDATE;
  SELECT * INTO v_before FROM trustwork.company_verification WHERE id = p_verification FOR UPDATE;
  v_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], v_before.hub_id);
  PERFORM trustwork.claims_require_territory(v_before.hub_id, v_before.company_id);
  PERFORM trustwork.claims_refuse_own_correction(v_actor.person_id, v_before.company_id);
  SELECT person_id INTO STRICT v_holder FROM trustwork.company_handover WHERE id = v_before.handover_id;
  -- The person checks of claims_decide: nobody renews their own badge, and a holder who is held or suspended keeps none.
  IF v_actor.person_id = v_holder THEN
    RAISE EXCEPTION 'the holder does not re-check their own verification' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.own_claim';
  END IF;
  IF v_before.state NOT IN ('active', 'expired')
     OR EXISTS (SELECT 1 FROM trustwork.company_verification WHERE renewed_from = p_verification)
     OR EXISTS (SELECT 1 FROM trustwork.company_handover WHERE id = v_before.handover_id AND revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a % verification is not re-checked', v_before.state USING ERRCODE = 'check_violation', HINT = 'claims.invalid_transition';
  END IF;
  v_recipe := trustwork.claims_recipe(v_before.hub_id, p_recipe, v_before.level);
  v_standing := trustwork.verification_evaluate(v_before.hub_id, 'company', v_before.company_id, v_recipe.id);
  IF v_standing ->> 'status' <> 'passed' OR (v_standing ->> 'handoverBlocked')::boolean THEN
    RAISE EXCEPTION 'the recipe standing does not allow a re-check' USING ERRCODE = 'check_violation', HINT = 'claims.standing_not_passed';
  END IF;
  SELECT s.id, s.last_outcome, s.money_held, s.suspended INTO v_state FROM trustwork.screening_state_row(v_holder, NULL) s;
  IF NOT trustwork.screening_available() OR v_state.id IS NULL OR v_state.last_outcome IS DISTINCT FROM 'clear' OR v_state.money_held OR v_state.suspended THEN
    RAISE EXCEPTION 'the holder is not screened clear' USING ERRCODE = 'check_violation', HINT = 'claims.claimant_not_clear';
  END IF;
  UPDATE trustwork.company_verification SET state = 'superseded' WHERE id = p_verification AND state = 'active';
  INSERT INTO trustwork.company_verification (hub_id, company_id, handover_id, level, recipe_id, categories, decided_by, valid_until, renewed_from)
  VALUES (v_before.hub_id, v_before.company_id, v_before.handover_id, v_before.level, v_recipe.id, v_recipe.badge_categories, v_actor.person_id,
    trustwork.claims_valid_until(v_before.hub_id, v_before.company_id, v_recipe.id), p_verification)
  RETURNING * INTO v_row;
  PERFORM trustwork.claims_derive(v_row.company_id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'claims.rechecked', 'company_verification', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION trustwork.claims_propose_dispute(p_ctx jsonb, p_dispute uuid, p_expected_revision integer, p_winner uuid, p_note text) RETURNS trustwork.claim_dispute
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.claim_dispute%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.claim_dispute%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.claim_dispute WHERE id = p_dispute;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such dispute' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  PERFORM 1 FROM trustwork.company WHERE id = v_before.company_id FOR UPDATE;
  SELECT * INTO v_before FROM trustwork.claim_dispute WHERE id = p_dispute FOR UPDATE;
  v_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], v_before.hub_id);
  PERFORM trustwork.claims_require_territory(v_before.hub_id, v_before.company_id);
  PERFORM trustwork.claims_check_revision(v_before.revision, p_expected_revision);
  IF v_before.state <> 'open' THEN
    RAISE EXCEPTION 'the dispute is decided' USING ERRCODE = 'check_violation', HINT = 'claims.invalid_transition';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.company_claim WHERE dispute_id = p_dispute AND claimant_id = v_actor.person_id) THEN
    RAISE EXCEPTION 'a claimant does not decide the dispute' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.own_claim';
  END IF;
  IF p_winner IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.company_claim WHERE id = p_winner AND dispute_id = p_dispute AND state = 'disputed') THEN
    RAISE EXCEPTION 'the winner is a claim of this dispute' USING ERRCODE = 'check_violation', HINT = 'claims.invalid_winner';
  END IF;
  UPDATE trustwork.claim_dispute SET proposed_claim_id = p_winner, proposed_none = p_winner IS NULL, proposed_by = v_actor.person_id, proposed_note = p_note, revision = revision + 1
   WHERE id = p_dispute RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'claims.dispute_proposed', 'claim_dispute', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION trustwork.claims_confirm_dispute(p_ctx jsonb, p_dispute uuid, p_expected_revision integer) RETURNS trustwork.claim_dispute
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.claim_dispute%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.claim_dispute%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.claim_dispute WHERE id = p_dispute;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such dispute' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  PERFORM 1 FROM trustwork.company WHERE id = v_before.company_id FOR UPDATE;
  SELECT * INTO v_before FROM trustwork.claim_dispute WHERE id = p_dispute FOR UPDATE;
  v_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], v_before.hub_id);
  PERFORM trustwork.claims_require_territory(v_before.hub_id, v_before.company_id);
  PERFORM trustwork.claims_check_revision(v_before.revision, p_expected_revision);
  IF v_before.state <> 'open' OR v_before.proposed_by IS NULL THEN
    RAISE EXCEPTION 'a proposed, open dispute is confirmed' USING ERRCODE = 'check_violation', HINT = 'claims.invalid_transition';
  END IF;
  IF v_before.proposed_by = v_actor.person_id THEN
    RAISE EXCEPTION 'a second person confirms the dispute' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.second_person_required';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.company_claim WHERE dispute_id = p_dispute AND claimant_id = v_actor.person_id) THEN
    RAISE EXCEPTION 'a claimant does not decide the dispute' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.own_claim';
  END IF;
  UPDATE trustwork.company_claim SET state = 'rejected', decided_by = v_actor.person_id, decided_at = now(), decision_note = 'Dispute decided for another claim',
         revision = revision + 1
   WHERE dispute_id = p_dispute AND state = 'disputed' AND id IS DISTINCT FROM v_before.proposed_claim_id;
  UPDATE trustwork.company_claim SET state = CASE WHEN waiting_until IS NOT NULL THEN 'waiting' ELSE 'open' END, revision = revision + 1
   WHERE id = v_before.proposed_claim_id AND state = 'disputed';
  UPDATE trustwork.claim_dispute SET state = 'decided', confirmed_by = v_actor.person_id, decided_at = now(), revision = revision + 1 WHERE id = p_dispute RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'claims.dispute_decided', 'claim_dispute', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION trustwork.claims_staff_record_add(p_ctx jsonb, p_hub uuid, p_company uuid, p_kind text, p_payload jsonb, p_source text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], p_hub);
  v_id uuid;
BEGIN
  PERFORM trustwork.claims_require_company(p_company);
  PERFORM trustwork.directory_lock_hub_cover(p_hub, (SELECT c.country_code FROM trustwork.company c WHERE c.id = p_company));
  IF NOT trustwork.claims_staff_reachable(p_hub, p_company) THEN
    RAISE EXCEPTION 'no open claim or case of this company at this hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF p_kind NOT IN ('identifier', 'registration') OR p_source IS NULL THEN
    RAISE EXCEPTION 'staff record identifiers and registrations with their source' USING ERRCODE = 'check_violation', HINT = 'claims.invalid_record';
  END IF;
  v_id := trustwork.claims_record_insert(p_company, p_kind, p_payload, 'sourced', p_source, v_actor.person_id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'claims.record_sourced', 'company', p_company, NULL, jsonb_build_object('recordKind', p_kind, 'recordId', v_id));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION trustwork.claims_verify_identifier(p_ctx jsonb, p_hub uuid, p_identifier uuid, p_expected_revision integer, p_check uuid) RETURNS trustwork.company_identifier
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], p_hub);
  v_before trustwork.company_identifier%ROWTYPE;
  v_row trustwork.company_identifier%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.company_identifier WHERE id = p_identifier AND retired_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such identifier' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  PERFORM trustwork.claims_require_company(v_before.company_id);
  PERFORM trustwork.claims_require_territory(p_hub, v_before.company_id);
  SELECT * INTO v_before FROM trustwork.company_identifier WHERE id = p_identifier FOR UPDATE;
  PERFORM trustwork.claims_check_revision(v_before.revision, p_expected_revision);
  IF NOT EXISTS (SELECT 1 FROM trustwork.verification_check c WHERE c.id = p_check AND c.hub_id = p_hub AND c.subject_company_id = v_before.company_id AND c.result = 'pass' AND c.expires_at > now()
                  AND c.check_type IN ('register_match', 'officer_match', 'tax_status', 'licence')) THEN
    RAISE EXCEPTION 'an identifier is verified by a passing check of the company' USING ERRCODE = 'check_violation', HINT = 'claims.check_mismatch';
  END IF;
  UPDATE trustwork.company_identifier SET status = 'verified', verification_check_id = p_check, revision = revision + 1 WHERE id = p_identifier RETURNING * INTO v_row;
  PERFORM trustwork.claims_mirror_identifiers(v_row.company_id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'claims.identifier_verified', 'company_identifier', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
