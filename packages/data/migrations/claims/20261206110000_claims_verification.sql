-- CLM-001 part 3: per-hub verification badges, expiry and re-checks, and recovery.
--
-- `company_verification` is what a hub stands behind: a level, the badge categories of the recipe, who decided, and
-- until when. A hand-over writes one row in the same transaction; a re-check writes a new row; revocation of the
-- hand-over revokes it. Rows hold categories and dates, never documents.
--
-- The company's claim status is now derived from the strongest active verification, as docs/data/model.md describes:
--   * a verification past its date no longer counts, and the page is `claimed` while someone still holds it;
--   * a `verified` page with no active administrator falls back to `claimed` (discovery-and-outreach section 7,
--     recovery), and a new verified claim restores it;
--   * companies that never went through a claim are not touched.
-- Every change of the derived status appends `company.verification_changed` for the projections that follow.
--
-- Public badges show the level, categories and dates. A category naming sanctions or screening is left out: a
-- screening state is never part of a public projection (ADR 014 decision 16), whatever a recipe calls it. They follow
-- the no-administrator rule of the status, so a page never shows more on `/badges` than its status says.
--
-- Recovery is a safety net, not a product path today: `end_membership` and the role change refuse to remove the last
-- administrator, and `claims_revoke` revokes the verification with the role. Only a maintenance write reaches it.

CREATE TABLE trustwork.company_verification (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  handover_id uuid NOT NULL REFERENCES trustwork.company_handover (id),
  level text NOT NULL CHECK (level IN ('claimed', 'verified')),
  recipe_id uuid NOT NULL REFERENCES trustwork.verification_recipe (id),
  categories text[] NOT NULL CHECK (cardinality(categories) BETWEEN 1 AND 10),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'expired', 'revoked', 'superseded')),
  decided_by uuid NOT NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NOT NULL,
  renewed_from uuid NULL UNIQUE REFERENCES trustwork.company_verification (id),
  revoked_at timestamptz NULL,
  revoked_by uuid NULL REFERENCES trustwork.person (id),
  revocation_reason_code text NULL CHECK (revocation_reason_code IS NULL OR revocation_reason_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT company_verification_period CHECK (valid_until > decided_at),
  CONSTRAINT company_verification_revocation CHECK ((state = 'revoked') = (revoked_at IS NOT NULL) AND (revoked_at IS NULL) = (revocation_reason_code IS NULL))
);
CREATE UNIQUE INDEX company_verification_active_uq ON trustwork.company_verification (hub_id, company_id, level) WHERE state = 'active';
CREATE INDEX company_verification_company_idx ON trustwork.company_verification (company_id) WHERE state = 'active';
CREATE INDEX company_verification_expiry_idx ON trustwork.company_verification (valid_until) WHERE state = 'active';

-- What was decided never changes; only the state moves, and only forward from active.
CREATE FUNCTION trustwork.claims_verification_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF (NEW.hub_id, NEW.company_id, NEW.handover_id, NEW.level, NEW.recipe_id, NEW.categories, NEW.decided_by, NEW.decided_at, NEW.valid_until, NEW.renewed_from)
     IS DISTINCT FROM (OLD.hub_id, OLD.company_id, OLD.handover_id, OLD.level, OLD.recipe_id, OLD.categories, OLD.decided_by, OLD.decided_at, OLD.valid_until, OLD.renewed_from) THEN
    RAISE EXCEPTION 'a verification is a record: a re-check writes a new row' USING ERRCODE = 'check_violation', HINT = 'claims.verification_frozen';
  END IF;
  IF NEW.state <> OLD.state AND OLD.state NOT IN ('active', 'expired') THEN
    RAISE EXCEPTION 'a % verification stays so', OLD.state USING ERRCODE = 'check_violation', HINT = 'claims.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_verification_guard BEFORE UPDATE ON trustwork.company_verification FOR EACH ROW EXECUTE FUNCTION trustwork.claims_verification_guard();

-- Until when a recipe's results hold for a company: the earliest expiry of the latest result per check type, or the
-- recipe's re-check period when no result is on record.
CREATE FUNCTION trustwork.claims_valid_until(p_hub uuid, p_company uuid, p_recipe uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(
    (SELECT min(x.expires_at) FROM (
       SELECT DISTINCT ON (c.check_type) c.expires_at FROM trustwork.verification_check c
        WHERE c.hub_id = p_hub AND c.recipe_id = p_recipe AND c.subject_company_id = p_company AND c.expires_at > now()
        ORDER BY c.check_type, c.recorded_at DESC) x),
    now() + make_interval(months => (SELECT r.recheck_months FROM trustwork.verification_recipe r WHERE r.id = p_recipe)))
$$;

-- A hand-over writes its verification; revoking the hand-over revokes what it stands on.
CREATE FUNCTION trustwork.claims_handover_verification() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_recipe uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT recipe_id INTO STRICT v_recipe FROM trustwork.company_claim WHERE id = NEW.claim_id;
    UPDATE trustwork.company_verification SET state = 'superseded' WHERE hub_id = NEW.hub_id AND company_id = NEW.company_id AND level = NEW.level AND state = 'active';
    INSERT INTO trustwork.company_verification (hub_id, company_id, handover_id, level, recipe_id, categories, decided_by, valid_until)
    SELECT NEW.hub_id, NEW.company_id, NEW.id, NEW.level, r.id, r.badge_categories, NEW.decided_by, trustwork.claims_valid_until(NEW.hub_id, NEW.company_id, r.id)
      FROM trustwork.verification_recipe r WHERE r.id = v_recipe;
  ELSIF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    UPDATE trustwork.company_verification SET state = 'revoked', revoked_at = NEW.revoked_at, revoked_by = NEW.revoked_by, revocation_reason_code = 'handover_revoked'
     WHERE handover_id = NEW.id AND state IN ('active', 'expired');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER company_handover_verification AFTER INSERT OR UPDATE OF revoked_at ON trustwork.company_handover FOR EACH ROW EXECUTE FUNCTION trustwork.claims_handover_verification();

-- The status from the strongest active verification; written only here.
CREATE OR REPLACE FUNCTION trustwork.claims_derive(p_company uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_status text;
  v_changed boolean;
BEGIN
  SELECT CASE WHEN bool_or(level = 'verified') THEN 'verified' WHEN bool_or(level = 'claimed') THEN 'claimed' END INTO v_status
    FROM trustwork.company_verification WHERE company_id = p_company AND state = 'active' AND valid_until > now();
  IF v_status IS NULL THEN
    v_status := 'unclaimed';
    IF EXISTS (SELECT 1 FROM trustwork.company_handover WHERE company_id = p_company AND revoked_at IS NULL) THEN
      v_status := 'claimed';
    END IF;
  END IF;
  IF v_status = 'verified' AND NOT EXISTS (SELECT 1 FROM trustwork.membership WHERE company_id = p_company AND status = 'active' AND role = 'administrator') THEN
    v_status := 'claimed';
  END IF;
  UPDATE trustwork.company SET claim_status = v_status WHERE id = p_company AND claim_status IS DISTINCT FROM v_status;
  v_changed := FOUND;
  IF v_changed THEN
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
    VALUES ('company', p_company::text, 1, 'company.verification_changed', jsonb_build_object('claimStatus', v_status));
  END IF;
  RETURN v_status;
END $$;

-- Recovery: losing the last administrator is a change of what the page may claim. Runs for whoever ends the membership,
-- so it is a definer; companies that never went through a claim keep their status.
CREATE FUNCTION trustwork.claims_membership_ended() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trustwork.company_handover WHERE company_id = NEW.company_id) THEN
    PERFORM trustwork.claims_derive(NEW.company_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER membership_claims_recovery AFTER UPDATE OF status, role ON trustwork.membership FOR EACH ROW
  WHEN (OLD.status = 'active' AND OLD.role = 'administrator' AND (NEW.status <> 'active' OR NEW.role <> 'administrator'))
  EXECUTE FUNCTION trustwork.claims_membership_ended();

-- A re-check under an active recipe of the level: the standing must pass with nothing blocking it, and the hand-over
-- must still stand. A new row carries the new date; a failing standing changes nothing and the old date runs out.
CREATE FUNCTION trustwork.claims_recheck(p_ctx jsonb, p_verification uuid, p_recipe uuid) RETURNS trustwork.company_verification
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

-- The worker: verifications past their date lapse, the status follows, and the holder hears of it in the bell (no person
-- acts here, so no e-mail is rendered). Safe to repeat and to run from several workers.
CREATE FUNCTION trustwork.claims_run_expiry(p_now timestamptz, p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v trustwork.company_verification%ROWTYPE;
  v_name text;
  v_person uuid;
  v_count integer := 0;
BEGIN
  FOR v IN SELECT * FROM trustwork.company_verification WHERE state = 'active' AND valid_until <= p_now ORDER BY valid_until, id LIMIT greatest(p_limit, 0) FOR UPDATE SKIP LOCKED LOOP
    UPDATE trustwork.company_verification SET state = 'expired' WHERE id = v.id;
    PERFORM trustwork.claims_derive(v.company_id);
    SELECT left(display_name, 200) INTO v_name FROM trustwork.company WHERE id = v.company_id;
    SELECT person_id INTO v_person FROM trustwork.company_handover WHERE id = v.handover_id AND revoked_at IS NULL;
    IF v_person IS NOT NULL THEN
      PERFORM trustwork.claims_notify(v_person, 'claims.claim_update', jsonb_build_object('companyName', v_name, 'outcome', 'expired'), 'claims:verification:' || v.id::text || ':expired');
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- What a hub may show about a company. Nobody needs a session; nothing here comes from a document.
CREATE FUNCTION trustwork.claims_public_badges(p_hub uuid, p_company uuid) RETURNS TABLE (level text, categories text[], decided_at timestamptz, valid_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT v.level, ARRAY(SELECT c FROM unnest(v.categories) c WHERE c !~ '(sanction|screen)' ORDER BY c), v.decided_at, v.valid_until
    FROM trustwork.company_verification v
   WHERE v.hub_id = p_hub AND v.company_id = p_company AND v.state = 'active' AND v.valid_until > now()
     AND (v.level <> 'verified' OR EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.company_id = p_company AND m.status = 'active' AND m.role = 'administrator'))
   ORDER BY v.level DESC
$$;

-- Hand-overs made before this migration get their row.
INSERT INTO trustwork.company_verification (hub_id, company_id, handover_id, level, recipe_id, categories, decided_by, decided_at, valid_until)
SELECT h.hub_id, h.company_id, h.id, h.level, c.recipe_id, r.badge_categories, h.decided_by, h.created_at, greatest(trustwork.claims_valid_until(h.hub_id, h.company_id, c.recipe_id), h.created_at + interval '1 day')
  FROM trustwork.company_handover h
  JOIN trustwork.company_claim c ON c.id = h.claim_id
  JOIN trustwork.verification_recipe r ON r.id = c.recipe_id
 WHERE h.revoked_at IS NULL;

ALTER TABLE trustwork.company_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_verification FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.company_verification AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY company_verification_read ON trustwork.company_verification FOR SELECT TO trustwork_app USING (trustwork.claims_staff_reader(hub_id));
GRANT SELECT ON trustwork.company_verification TO trustwork_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.claims_recheck(jsonb, uuid, uuid), trustwork.claims_public_badges(uuid, uuid) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.claims_run_expiry(timestamptz, integer) TO trustwork_worker;
