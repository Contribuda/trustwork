-- CLM-001 company claims and hand-over, first slice (docs/engine/discovery-and-outreach.md section 7, ADR 026;
-- docs/engine/hub-administration.md reference recipes). Management access passes only through the hub's verification
-- recipe (HUB-003): a claim names an active recipe for its level, and a reviewer decides against it.
--
-- Rules the schema holds:
--   * one open claim per page; a second claim opens a dispute (both claims wait), which a reviewer proposes and a
--     second, different reviewer confirms; no hand-over happens while a dispute is open;
--   * a claim against a claimed or verified page aims at the verified level and waits a hub-set period (default seven
--     days) before a reviewer may decide;
--   * the decider is never the claimant; a hand-over needs the recipe standing passed and nothing blocking it
--     (verification_evaluate: screening of the company, an unavailable screening store) and the claimant's own
--     screening clear;
--   * claimed level: limited page control (a hand-over row, no company role); verified level: the company
--     administrator role; the company's claim status is derived from the strongest active hand-over in the same
--     transaction; revocation ends what the hand-over gave and derives again;
--   * an invitation link counts only as the claimed-level domain tie, when its address is on a domain recorded for the
--     company and not a free mail service; a link, a reply or a message alone never changes a claim or grants a role;
--   * for a hub-set cooling period (default seven days) after a hand-over, the company's legal name, identifiers and
--     verified domains, and its representative, cannot change.
--
-- Authority model (DATA-002): staff commands are SECURITY DEFINER functions that resolve the caller's permission at the
-- hub, require a live elevation and write an admin_audit_event; the claimant's own commands check the principal; the
-- runtime role reads under row-level security (staff of the hub with a claims permission, and a claimant their own).

-- 0. Settings and vocabularies ----------------------------------------------------------------------------------------
CREATE TABLE trustwork.claims_settings (
  hub_id uuid PRIMARY KEY REFERENCES trustwork.hub (id),
  waiting_days integer NOT NULL DEFAULT 7 CHECK (waiting_days BETWEEN 1 AND 30),
  cooling_days integer NOT NULL DEFAULT 7 CHECK (cooling_days BETWEEN 1 AND 30),
  updated_by uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION trustwork.claims_waiting_days(p_hub uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$ SELECT coalesce((SELECT waiting_days FROM trustwork.claims_settings WHERE hub_id = p_hub), 7) $$;
CREATE FUNCTION trustwork.claims_cooling_days(p_hub uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$ SELECT coalesce((SELECT cooling_days FROM trustwork.claims_settings WHERE hub_id = p_hub), 7) $$;

-- Free mail services whose addresses never tie a person to a company (a starting list; hubs extend it in a later slice).
CREATE FUNCTION trustwork.claims_free_mail_domains() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com',
    'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'zoho.com', 'tutanota.com']::text[]
$$;
CREATE FUNCTION trustwork.claims_reader_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.claims.read', 'admin.claims.decide', 'admin.claims.policy.edit', 'admin.claims.revoke']::text[]
$$;

-- Domains recorded for a company: its verified domains and the website of its active sourced records.
CREATE FUNCTION trustwork.claims_company_domains(p_company uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT d), ARRAY[]::text[]) FROM (
    SELECT lower(unnest(c.verified_domains)) AS d FROM trustwork.company c WHERE c.id = p_company
    UNION ALL
    SELECT lower(regexp_replace(f.value, '^https?://(www\.)?([^/:]+).*$', '\2')) FROM trustwork.sourced_record_field f
     WHERE f.record_kind = 'company' AND f.record_id = p_company AND f.field = 'website' AND f.active
  ) x WHERE d ~ '^[a-z0-9.-]+\.[a-z]{2,}$'
$$;

-- 1. Claims, disputes and hand-overs -------------------------------------------------------------------------------------
CREATE TABLE trustwork.claim_dispute (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'decided', 'dissolved')),
  proposed_claim_id uuid NULL,
  proposed_none boolean NOT NULL DEFAULT false,
  proposed_by uuid NULL REFERENCES trustwork.person (id),
  proposed_note text NULL CHECK (proposed_note IS NULL OR length(btrim(proposed_note)) BETWEEN 10 AND 1000),
  confirmed_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_dispute_proposal CHECK ((proposed_by IS NULL) = (proposed_note IS NULL) AND (proposed_by IS NULL OR proposed_none OR proposed_claim_id IS NOT NULL)),
  -- Decided by a confirming second person; dissolved when a claimant withdrew and one claim was left.
  CONSTRAINT claim_dispute_decision CHECK ((state = 'decided') = (confirmed_by IS NOT NULL) AND (state = 'open') = (decided_at IS NULL)),
  CONSTRAINT claim_dispute_second_person CHECK (confirmed_by IS NULL OR confirmed_by <> proposed_by)
);
CREATE UNIQUE INDEX claim_dispute_open_uq ON trustwork.claim_dispute (company_id) WHERE state = 'open';

CREATE TABLE trustwork.company_claim (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  claimant_id uuid NOT NULL REFERENCES trustwork.person (id),
  level text NOT NULL CHECK (level IN ('claimed', 'verified')),
  recipe_id uuid NOT NULL REFERENCES trustwork.verification_recipe (id),
  domain_tie text NULL CHECK (domain_tie IN ('invitation_link', 'register_officer_match')),
  domain_tie_domain text NULL CHECK (domain_tie_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  state text NOT NULL CHECK (state IN ('open', 'waiting', 'disputed', 'approved', 'rejected', 'withdrawn')),
  waiting_until timestamptz NULL,
  dispute_id uuid NULL REFERENCES trustwork.claim_dispute (id),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  decision_note text NULL CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 1 AND 1000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_claim_tie CHECK ((domain_tie = 'invitation_link') = (domain_tie_domain IS NOT NULL)),
  CONSTRAINT company_claim_waiting CHECK (state <> 'waiting' OR waiting_until IS NOT NULL),
  CONSTRAINT company_claim_disputed CHECK (state <> 'disputed' OR dispute_id IS NOT NULL),
  CONSTRAINT company_claim_decision CHECK ((state IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT company_claim_four_eyes CHECK (decided_by IS NULL OR decided_by <> claimant_id)
);
-- One claim in play per page (a dispute holds the others as `disputed`).
CREATE UNIQUE INDEX company_claim_open_uq ON trustwork.company_claim (company_id) WHERE state IN ('open', 'waiting');
CREATE INDEX company_claim_hub_idx ON trustwork.company_claim (hub_id, state, created_at);
CREATE INDEX company_claim_claimant_idx ON trustwork.company_claim (claimant_id, created_at);

CREATE TABLE trustwork.company_handover (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  claim_id uuid NOT NULL UNIQUE REFERENCES trustwork.company_claim (id),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  level text NOT NULL CHECK (level IN ('claimed', 'verified')),
  membership_id uuid NULL REFERENCES trustwork.membership (id),
  decided_by uuid NOT NULL REFERENCES trustwork.person (id),
  cooling_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  revoked_by uuid NULL REFERENCES trustwork.person (id),
  revoke_reason text NULL CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 10 AND 1000),
  CONSTRAINT company_handover_role CHECK ((level = 'verified') = (membership_id IS NOT NULL)),
  CONSTRAINT company_handover_revocation CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT company_handover_cooling CHECK (cooling_until > created_at)
);
CREATE INDEX company_handover_company_idx ON trustwork.company_handover (company_id) WHERE revoked_at IS NULL;

-- 2. Helpers -----------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.claims_staff(p_ctx jsonb, p_permissions text[], p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_hub IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.hub WHERE id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN trustwork.admin_authorize(p_ctx, p_permissions, NULL, p_hub);
END $$;
CREATE FUNCTION trustwork.claims_check_revision(p_actual integer, p_expected integer) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_expected IS NULL OR p_actual <> p_expected THEN
    RAISE EXCEPTION 'the record changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'claims.revision_conflict';
  END IF;
END $$;

-- The company's claim status from its strongest active hand-over; written only here.
CREATE FUNCTION trustwork.claims_derive(p_company uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_status text;
BEGIN
  SELECT CASE WHEN bool_or(level = 'verified') THEN 'verified' WHEN bool_or(level = 'claimed') THEN 'claimed' ELSE 'unclaimed' END INTO v_status
    FROM trustwork.company_handover WHERE company_id = p_company AND revoked_at IS NULL;
  v_status := coalesce(v_status, 'unclaimed');
  UPDATE trustwork.company SET claim_status = v_status WHERE id = p_company AND claim_status IS DISTINCT FROM v_status;
  RETURN v_status;
END $$;

-- Whether the cooling period of a hand-over of this company is running.
CREATE FUNCTION trustwork.claims_cooling(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.company_handover WHERE company_id = p_company AND revoked_at IS NULL AND cooling_until > now())
$$;

-- An active recipe of the hub for a company claim at the level (trigger claim_claimed or claim_verified).
CREATE FUNCTION trustwork.claims_recipe(p_hub uuid, p_recipe uuid, p_level text) RETURNS trustwork.verification_recipe
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_recipe trustwork.verification_recipe%ROWTYPE;
  v_trigger text := CASE p_level WHEN 'claimed' THEN 'claim_claimed' ELSE 'claim_verified' END;
BEGIN
  SELECT * INTO v_recipe FROM trustwork.verification_recipe WHERE id = p_recipe AND hub_id = p_hub;
  IF NOT FOUND OR v_recipe.status <> 'active' OR v_recipe.subject_kind <> 'company' OR v_recipe.trigger <> v_trigger THEN
    RAISE EXCEPTION 'a claim names an active company recipe for its level' USING ERRCODE = 'check_violation', HINT = 'claims.recipe_mismatch';
  END IF;
  RETURN v_recipe;
END $$;

-- 3. The claimant's commands -------------------------------------------------------------------------------------------
-- A claim on a company page. p_tie: NULL, or {"kind": "invitation_link", "email": "<address>"} — the link counts only as
-- the claimed-level domain tie when the address is on a domain recorded for the company and not a free mail service;
-- otherwise it is recorded as nothing. A second claim opens a dispute; a claim against a claimed or verified page aims
-- at the verified level and waits.
CREATE FUNCTION trustwork.claims_submit(p_hub uuid, p_company uuid, p_level text, p_recipe uuid, p_tie jsonb) RETURNS trustwork.company_claim
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
  IF EXISTS (SELECT 1 FROM trustwork.company_handover WHERE company_id = p_company AND person_id = v_person AND revoked_at IS NULL AND level = 'verified') THEN
    RAISE EXCEPTION 'you already manage this page' USING ERRCODE = 'check_violation', HINT = 'claims.already_managing';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.claim_dispute WHERE company_id = p_company AND state = 'open') THEN
    RAISE EXCEPTION 'a dispute about this page is open' USING ERRCODE = 'check_violation', HINT = 'claims.dispute_open';
  END IF;
  -- The invitation link as a domain tie: the address domain must be recorded for the company and not a free service.
  IF p_tie IS NOT NULL AND p_tie ->> 'kind' = 'invitation_link' AND (p_tie ->> 'email') ~ '^[^@\s]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
    v_domain := lower(split_part(p_tie ->> 'email', '@', 2));
    IF NOT (v_domain = ANY (trustwork.claims_free_mail_domains())) AND v_domain = ANY (trustwork.claims_company_domains(p_company)) THEN
      v_tie := 'invitation_link';
    ELSE
      v_domain := NULL;
    END IF;
  END IF;
  -- Takeover protection: a claimed or verified page is claimed again only at the verified level, after a waiting period.
  IF EXISTS (SELECT 1 FROM trustwork.company_handover WHERE company_id = p_company AND revoked_at IS NULL) THEN
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
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.claims_withdraw(p_claim uuid) RETURNS trustwork.company_claim
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.company_claim%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.company_claim WHERE id = p_claim AND claimant_id = trustwork.current_person_id() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such claim' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  IF v_row.state NOT IN ('open', 'waiting', 'disputed') THEN
    RAISE EXCEPTION 'the claim is decided' USING ERRCODE = 'check_violation', HINT = 'claims.invalid_transition';
  END IF;
  UPDATE trustwork.company_claim SET state = 'withdrawn', revision = revision + 1 WHERE id = p_claim RETURNING * INTO v_row;
  -- A dispute left with one claim ends: the remaining claim is back in play.
  IF v_row.dispute_id IS NOT NULL AND (SELECT count(*) FROM trustwork.company_claim WHERE dispute_id = v_row.dispute_id AND state = 'disputed') = 1 THEN
    UPDATE trustwork.company_claim SET state = CASE WHEN waiting_until IS NOT NULL THEN 'waiting' ELSE 'open' END, revision = revision + 1
     WHERE dispute_id = v_row.dispute_id AND state = 'disputed';
    UPDATE trustwork.claim_dispute SET state = 'dissolved', decided_at = now(), revision = revision + 1 WHERE id = v_row.dispute_id AND state = 'open';
  END IF;
  RETURN v_row;
END $$;

-- 4. Staff commands ------------------------------------------------------------------------------------------------------
-- A reviewer decides a claim (approve or reject). Approval needs: a claim in play (open, or waiting past its period),
-- a reviewer who is not the claimant, the recipe standing passed with nothing blocking the hand-over, the claimant's
-- screening clear, and for the claimed level a domain tie (an accepted invitation link, or the reviewer's recorded
-- register officer match). The hand-over follows in the same transaction.
CREATE FUNCTION trustwork.claims_decide(p_ctx jsonb, p_claim uuid, p_expected_revision integer, p_decision text, p_officer_match boolean, p_note text)
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

-- A dispute: one reviewer proposes the outcome (a winning claim, or none) with a note; a second, different reviewer
-- who is not a claimant confirms it. The winner goes back into play (waiting again when the page is managed) for an
-- ordinary decision; the others are rejected. No hand-over happens here.
CREATE FUNCTION trustwork.claims_propose_dispute(p_ctx jsonb, p_dispute uuid, p_expected_revision integer, p_winner uuid, p_note text) RETURNS trustwork.claim_dispute
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.claim_dispute%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.claim_dispute%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.claim_dispute WHERE id = p_dispute FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such dispute' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], v_before.hub_id);
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

CREATE FUNCTION trustwork.claims_confirm_dispute(p_ctx jsonb, p_dispute uuid, p_expected_revision integer) RETURNS trustwork.claim_dispute
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.claim_dispute%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.claim_dispute%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.claim_dispute WHERE id = p_dispute FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such dispute' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.decide'], v_before.hub_id);
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

-- Revocation with a reason: ends the administrator role the hand-over gave and derives the claim status again.
CREATE FUNCTION trustwork.claims_revoke(p_ctx jsonb, p_handover uuid, p_reason text) RETURNS trustwork.company_handover
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.company_handover%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.company_handover%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.company_handover WHERE id = p_handover FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such hand-over' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.revoke'], v_before.hub_id);
  IF v_before.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'the hand-over is revoked' USING ERRCODE = 'check_violation', HINT = 'claims.invalid_transition';
  END IF;
  UPDATE trustwork.company_handover SET revoked_at = now(), revoked_by = v_actor.person_id, revoke_reason = p_reason WHERE id = p_handover RETURNING * INTO v_row;
  IF v_row.membership_id IS NOT NULL THEN
    UPDATE trustwork.membership SET status = 'ended', ended_at = now(), ended_by = v_actor.person_id, ended_reason = 'Verification revoked: ' || left(p_reason, 400),
           revision = revision + 1, updated_at = now()
     WHERE id = v_row.membership_id AND status = 'active';
  END IF;
  PERFORM trustwork.claims_derive(v_row.company_id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'claims.revoked', 'company_handover', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.claims_set_settings(p_ctx jsonb, p_hub uuid, p_waiting_days integer, p_cooling_days integer) RETURNS trustwork.claims_settings
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.policy.edit'], p_hub);
  v_row trustwork.claims_settings%ROWTYPE;
BEGIN
  INSERT INTO trustwork.claims_settings (hub_id, waiting_days, cooling_days, updated_by) VALUES (p_hub, p_waiting_days, p_cooling_days, v_actor.person_id)
  ON CONFLICT (hub_id) DO UPDATE SET waiting_days = EXCLUDED.waiting_days, cooling_days = EXCLUDED.cooling_days, updated_by = EXCLUDED.updated_by,
    revision = claims_settings.revision + 1, updated_at = now()
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'claims.settings_set', 'claims_settings', p_hub, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- 5. Cooling period guards ---------------------------------------------------------------------------------------------
-- Legal name, identifiers and verified domains do not change while a hand-over cools down; the claim status itself is
-- written by claims_derive and stays free.
CREATE FUNCTION trustwork.claims_company_cooling_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF (NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.legal_identifiers IS DISTINCT FROM OLD.legal_identifiers OR NEW.verified_domains IS DISTINCT FROM OLD.verified_domains)
     AND trustwork.claims_cooling(NEW.id) THEN
    RAISE EXCEPTION 'sensitive company details are locked during the cooling period' USING ERRCODE = 'check_violation', HINT = 'claims.cooling_period';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_claims_cooling BEFORE UPDATE ON trustwork.company FOR EACH ROW EXECUTE FUNCTION trustwork.claims_company_cooling_guard();

CREATE FUNCTION trustwork.claims_representative_cooling_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.accountable_person_id IS DISTINCT FROM OLD.accountable_person_id OR NEW.status IS DISTINCT FROM OLD.status)
     AND trustwork.claims_cooling(NEW.company_id) THEN
    RAISE EXCEPTION 'the company representative is locked during the cooling period' USING ERRCODE = 'check_violation', HINT = 'claims.cooling_period';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_representative_claims_cooling BEFORE INSERT OR UPDATE ON trustwork.company_representative FOR EACH ROW EXECUTE FUNCTION trustwork.claims_representative_cooling_guard();

-- 6. Reads ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.claims_staff_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND p_hub IS NOT NULL AND trustwork.admin_has_any_permission(trustwork.claims_reader_permissions(), NULL, p_hub)
$$;

ALTER TABLE trustwork.claims_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.claims_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.claim_dispute ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.claim_dispute FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_claim FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_handover ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_handover FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.claims_settings AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.claim_dispute AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.company_claim AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.company_handover AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY claims_settings_read ON trustwork.claims_settings FOR SELECT TO trustwork_app USING (trustwork.claims_staff_reader(hub_id));
CREATE POLICY claim_dispute_read ON trustwork.claim_dispute FOR SELECT TO trustwork_app USING (trustwork.claims_staff_reader(hub_id));
CREATE POLICY company_claim_read ON trustwork.company_claim FOR SELECT TO trustwork_app USING (claimant_id = trustwork.current_person_id() OR trustwork.claims_staff_reader(hub_id));
CREATE POLICY company_handover_read ON trustwork.company_handover FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id() OR trustwork.claims_staff_reader(hub_id));

GRANT SELECT ON trustwork.claims_settings, trustwork.claim_dispute, trustwork.company_claim, trustwork.company_handover TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.claims_submit(uuid, uuid, text, uuid, jsonb), trustwork.claims_withdraw(uuid), trustwork.claims_decide(jsonb, uuid, integer, text, boolean, text),
  trustwork.claims_propose_dispute(jsonb, uuid, integer, uuid, text), trustwork.claims_confirm_dispute(jsonb, uuid, integer), trustwork.claims_revoke(jsonb, uuid, text),
  trustwork.claims_set_settings(jsonb, uuid, integer, integer), trustwork.claims_staff_reader(uuid), trustwork.claims_cooling(uuid),
  trustwork.claims_waiting_days(uuid), trustwork.claims_cooling_days(uuid), trustwork.claims_free_mail_domains(), trustwork.claims_reader_permissions()
TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
