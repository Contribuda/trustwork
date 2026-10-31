-- BE-004: second factor (TOTP), recovery codes, sign-in challenges, elevated sessions and support resets.
--
-- Secrets: second_factor.secret_sealed is AES-256-GCM sealed by the API with a key the database never sees; the
-- runtime role may read the sealed bytes of its own rows only. recovery_code.code_hash is a keyed hash (HMAC-SHA256)
-- and is not selectable by the runtime role at all: a code is used through second_factor_use_recovery_code.
-- Replay: second_factor.last_used_step only increases (trigger), so the guarded UPDATE in the API accepts each TOTP
-- time step once per factor even under concurrent requests.
-- Support resets: requested by one person, approved by a second, effective no sooner than 72 hours after approval
-- (database clock), cancellable by the subject or the staff involved until then. Staff roles are checked by the API
-- (StaffRoleResolver) until ADM-001's staff_role_assignment exists; the functions below enforce the people rules
-- (requester != subject, approver distinct from both, only the parties act) and the cooling-off on their own.

-- 1. Factors -----------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.second_factor (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  kind text NOT NULL CHECK (kind IN ('totp')),
  state text NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  secret_sealed bytea NOT NULL CHECK (octet_length(secret_sealed) BETWEEN 30 AND 200),
  last_used_step bigint NULL CHECK (last_used_step IS NULL OR last_used_step >= 0),
  pending_expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz NULL,
  last_used_at timestamptz NULL,
  revoked_at timestamptz NULL,
  revoked_reason text NULL CHECK (revoked_reason IN ('removed', 'abandoned', 'support_reset')),
  CONSTRAINT second_factor_state_shape CHECK (
    (state = 'pending' AND pending_expires_at IS NOT NULL AND activated_at IS NULL AND revoked_at IS NULL AND revoked_reason IS NULL)
    OR (state = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL AND revoked_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
  )
);
CREATE INDEX second_factor_person_idx ON trustwork.second_factor (person_id);
CREATE UNIQUE INDEX second_factor_one_active ON trustwork.second_factor (person_id, kind) WHERE state = 'active';
CREATE UNIQUE INDEX second_factor_one_pending ON trustwork.second_factor (person_id) WHERE state = 'pending';

-- Forward-only lifecycle: pending -> active | revoked, active -> revoked; the owner, kind and sealed secret never
-- change and the accepted time step never goes back.
CREATE FUNCTION trustwork.second_factor_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.person_id <> OLD.person_id OR NEW.kind <> OLD.kind OR NEW.secret_sealed <> OLD.secret_sealed OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'second factor identity is immutable' USING ERRCODE = '23514', HINT = 'second_factor.immutable';
  END IF;
  IF OLD.state = 'revoked' AND (NEW.state <> 'revoked' OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'a revoked second factor stays revoked' USING ERRCODE = '23514', HINT = 'second_factor.revoked_final';
  END IF;
  IF OLD.state = 'active' AND NEW.state = 'pending' THEN
    RAISE EXCEPTION 'an active second factor cannot return to pending' USING ERRCODE = '23514', HINT = 'second_factor.invalid_transition';
  END IF;
  IF OLD.last_used_step IS NOT NULL AND (NEW.last_used_step IS NULL OR NEW.last_used_step < OLD.last_used_step) THEN
    RAISE EXCEPTION 'the accepted time step never goes back' USING ERRCODE = '23514', HINT = 'second_factor.step_regression';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER second_factor_guard BEFORE UPDATE ON trustwork.second_factor FOR EACH ROW EXECUTE FUNCTION trustwork.second_factor_guard();

-- 2. Recovery codes ----------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.recovery_code (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  batch_id uuid NOT NULL,
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz NULL,
  revoked_at timestamptz NULL,
  CONSTRAINT recovery_code_hash_unique UNIQUE (person_id, code_hash)
);
CREATE INDEX recovery_code_person_idx ON trustwork.recovery_code (person_id) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE FUNCTION trustwork.recovery_code_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.person_id <> OLD.person_id OR NEW.batch_id <> OLD.batch_id OR NEW.code_hash <> OLD.code_hash OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'recovery code identity is immutable' USING ERRCODE = '23514', HINT = 'second_factor.immutable';
  END IF;
  IF (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at) OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'a used or revoked recovery code stays so' USING ERRCODE = '23514', HINT = 'second_factor.recovery_code_final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_code_guard BEFORE UPDATE ON trustwork.recovery_code FOR EACH ROW EXECUTE FUNCTION trustwork.recovery_code_guard();

-- 3. Sign-in challenges ------------------------------------------------------------------------------------------------
-- Issued after a correct password or provider proof for a person with an active factor; the browser holds the random
-- token in a cookie, the table only its SHA-256. Single use, at most five attempts, short expiry.
CREATE TABLE trustwork.second_factor_challenge (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  auth_method text NOT NULL CHECK (auth_method IN ('password', 'google', 'apple')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  consumed_at timestamptz NULL,
  CONSTRAINT second_factor_challenge_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX second_factor_challenge_person_idx ON trustwork.second_factor_challenge (person_id);

-- 4. Elevated sessions -------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.session_elevation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  session_id uuid NOT NULL REFERENCES trustwork.session (id),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  factor_kind text NOT NULL CHECK (factor_kind IN ('totp', 'recovery_code')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  revoked_reason text NULL CHECK (revoked_reason IN ('ended', 'replaced', 'factor_changed', 'session_ended')),
  CONSTRAINT session_elevation_short CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  CONSTRAINT session_elevation_revocation_shape CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX session_elevation_session_idx ON trustwork.session_elevation (session_id) WHERE revoked_at IS NULL;
CREATE INDEX session_elevation_person_idx ON trustwork.session_elevation (person_id) WHERE revoked_at IS NULL;

-- An elevation belongs to a live session of the same person (RLS limits the lookup to the caller's own sessions).
CREATE FUNCTION trustwork.session_elevation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM trustwork.session s WHERE s.id = NEW.session_id AND s.person_id = NEW.person_id AND s.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'an elevation needs a live session of the same person' USING ERRCODE = '23514', HINT = 'second_factor.elevation_session';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.session_id <> OLD.session_id OR NEW.person_id <> OLD.person_id OR NEW.factor_kind <> OLD.factor_kind OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'an elevation can only be revoked' USING ERRCODE = '23514', HINT = 'second_factor.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_elevation_guard BEFORE INSERT OR UPDATE ON trustwork.session_elevation FOR EACH ROW EXECUTE FUNCTION trustwork.session_elevation_guard();

-- 5. Support resets ----------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.second_factor_reset (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  subject_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  support_case_id uuid NOT NULL,
  evidence_refs uuid[] NOT NULL CHECK (cardinality(evidence_refs) BETWEEN 1 AND 10),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  requested_by uuid NOT NULL REFERENCES trustwork.person (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid NULL REFERENCES trustwork.person (id),
  approved_at timestamptz NULL,
  effective_at timestamptz NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'cooling_off', 'done', 'cancelled')),
  cancelled_by uuid NULL REFERENCES trustwork.person (id),
  cancelled_at timestamptz NULL,
  executed_by uuid NULL REFERENCES trustwork.person (id),
  executed_at timestamptz NULL,
  CONSTRAINT second_factor_reset_not_self CHECK (requested_by <> subject_person_id),
  CONSTRAINT second_factor_reset_second_person CHECK (approved_by IS NULL OR (approved_by <> requested_by AND approved_by <> subject_person_id)),
  CONSTRAINT second_factor_reset_cooling_off CHECK (effective_at IS NULL OR (approved_at IS NOT NULL AND effective_at >= approved_at + interval '72 hours' AND effective_at >= requested_at + interval '72 hours')),
  CONSTRAINT second_factor_reset_state_shape CHECK (
    (state = 'pending' AND approved_by IS NULL AND cancelled_at IS NULL AND executed_at IS NULL)
    OR (state = 'cooling_off' AND approved_by IS NOT NULL AND effective_at IS NOT NULL AND cancelled_at IS NULL AND executed_at IS NULL)
    OR (state = 'done' AND approved_by IS NOT NULL AND executed_by IS NOT NULL AND executed_at IS NOT NULL AND executed_at >= effective_at AND cancelled_at IS NULL)
    OR (state = 'cancelled' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND executed_at IS NULL)
  )
);
CREATE UNIQUE INDEX second_factor_reset_one_open ON trustwork.second_factor_reset (subject_person_id) WHERE state IN ('pending', 'cooling_off');

-- 6. Row level security ------------------------------------------------------------------------------------------------
ALTER TABLE trustwork.second_factor ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.second_factor FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.recovery_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.recovery_code FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.second_factor_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.second_factor_challenge FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.session_elevation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.session_elevation FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.second_factor_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.second_factor_reset FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.second_factor AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.recovery_code AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.second_factor_challenge AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.session_elevation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.second_factor_reset AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

CREATE POLICY second_factor_self ON trustwork.second_factor FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY recovery_code_self ON trustwork.recovery_code FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY second_factor_challenge_self ON trustwork.second_factor_challenge FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY session_elevation_self ON trustwork.session_elevation FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
-- The parties of a reset see it; the requester inserts it pending; every transition goes through a function below.
CREATE POLICY second_factor_reset_parties ON trustwork.second_factor_reset FOR SELECT TO trustwork_app
  USING (trustwork.current_person_id() IN (subject_person_id, requested_by, approved_by));
CREATE POLICY second_factor_reset_request ON trustwork.second_factor_reset FOR INSERT TO trustwork_app
  WITH CHECK (requested_by = trustwork.current_person_id() AND state = 'pending' AND approved_by IS NULL AND cancelled_by IS NULL AND executed_by IS NULL);

-- No DELETE anywhere; recovery_code.code_hash is write-only for the runtime role.
GRANT SELECT, INSERT, UPDATE (state, last_used_step, last_used_at, activated_at, pending_expires_at, revoked_at, revoked_reason) ON trustwork.second_factor TO trustwork_app;
GRANT SELECT (id, person_id, batch_id, created_at, used_at, revoked_at), INSERT, UPDATE (revoked_at) ON trustwork.recovery_code TO trustwork_app;
GRANT SELECT (id, person_id, auth_method, created_at, expires_at, attempts, consumed_at), INSERT, UPDATE (attempts, consumed_at) ON trustwork.second_factor_challenge TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (revoked_at, revoked_reason) ON trustwork.session_elevation TO trustwork_app;
GRANT SELECT, INSERT (subject_person_id, support_case_id, evidence_refs, reason, requested_by) ON trustwork.second_factor_reset TO trustwork_app;

-- 7. Functions ---------------------------------------------------------------------------------------------------------
-- Uses one unused, unrevoked recovery code of the current person; returns its id, or NULL. Single use under
-- concurrency: the row lock makes a second UPDATE of the same code see used_at and match nothing.
CREATE FUNCTION trustwork.second_factor_use_recovery_code(p_code_hash bytea) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_id uuid;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'using a recovery code requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  UPDATE trustwork.recovery_code SET used_at = now()
  WHERE person_id = v_person AND code_hash = p_code_hash AND used_at IS NULL AND revoked_at IS NULL
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Pre-identity lookup of a sign-in challenge by its token hash: open (unconsumed, unexpired, attempts left) only.
CREATE FUNCTION trustwork.auth_lookup_second_factor_challenge(p_token_hash bytea, p_max_attempts integer)
RETURNS TABLE (challenge_id uuid, person_id uuid, authz_epoch integer, auth_method text, expires_at timestamptz, attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT c.id, c.person_id, p.authz_epoch, c.auth_method, c.expires_at, c.attempts
  FROM trustwork.second_factor_challenge c JOIN trustwork.person p ON p.id = c.person_id
  WHERE c.token_hash = p_token_hash AND c.consumed_at IS NULL AND c.expires_at > now() AND c.attempts < p_max_attempts
$$;

-- Clears the second-factor failure counter of the current person (subject = sha256('second_factor:' || person id)).
CREATE FUNCTION trustwork.auth_clear_second_factor_failures() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_count integer;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'clearing failure counters requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  DELETE FROM trustwork.login_failure f WHERE f.subject_hash = sha256(convert_to('second_factor:' || v_person::text, 'UTF8'));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Verified addresses of a reset's subject, for the notices; only the parties of that reset may ask.
CREATE FUNCTION trustwork.second_factor_reset_subject_addresses(p_reset_id uuid) RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_subject uuid;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT r.subject_person_id INTO v_subject FROM trustwork.second_factor_reset r
  WHERE r.id = p_reset_id AND v_person IN (r.subject_person_id, r.requested_by, r.approved_by);
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'reset not found' USING ERRCODE = '42501', HINT = 'second_factor.reset_not_found';
  END IF;
  RETURN QUERY SELECT b.email_normalized FROM trustwork.email_binding b WHERE b.person_id = v_subject AND b.verified_at IS NOT NULL ORDER BY b.created_at;
END $$;

-- Second person: the approver differs from the requester and the subject; the cooling-off starts now (database clock).
CREATE FUNCTION trustwork.second_factor_reset_approve(p_reset_id uuid)
RETURNS TABLE (id uuid, subject_person_id uuid, approved_at timestamptz, effective_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_reset trustwork.second_factor_reset;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_reset FROM trustwork.second_factor_reset r WHERE r.id = p_reset_id FOR UPDATE;
  IF v_reset.id IS NULL THEN
    RAISE EXCEPTION 'reset not found' USING ERRCODE = '42501', HINT = 'second_factor.reset_not_found';
  END IF;
  IF v_person = v_reset.requested_by OR v_person = v_reset.subject_person_id THEN
    RAISE EXCEPTION 'a second person must approve' USING ERRCODE = '42501', HINT = 'second_factor.reset_second_person';
  END IF;
  IF v_reset.state <> 'pending' THEN
    RAISE EXCEPTION 'reset is not pending' USING ERRCODE = '42501', HINT = 'second_factor.reset_state';
  END IF;
  UPDATE trustwork.second_factor_reset r
  SET approved_by = v_person, approved_at = now(), effective_at = greatest(now(), r.requested_at) + interval '72 hours', state = 'cooling_off'
  WHERE r.id = p_reset_id;
  RETURN QUERY SELECT r.id, r.subject_person_id, r.approved_at, r.effective_at FROM trustwork.second_factor_reset r WHERE r.id = p_reset_id;
END $$;

-- The subject, the requester or the approver may cancel until the reset takes effect.
CREATE FUNCTION trustwork.second_factor_reset_cancel(p_reset_id uuid)
RETURNS TABLE (id uuid, subject_person_id uuid, cancelled_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_reset trustwork.second_factor_reset;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_reset FROM trustwork.second_factor_reset r WHERE r.id = p_reset_id FOR UPDATE;
  IF v_reset.id IS NULL OR v_person NOT IN (v_reset.subject_person_id, v_reset.requested_by, coalesce(v_reset.approved_by, v_reset.requested_by)) THEN
    RAISE EXCEPTION 'reset not found' USING ERRCODE = '42501', HINT = 'second_factor.reset_not_found';
  END IF;
  IF v_reset.state NOT IN ('pending', 'cooling_off') THEN
    RAISE EXCEPTION 'reset is final' USING ERRCODE = '42501', HINT = 'second_factor.reset_state';
  END IF;
  UPDATE trustwork.second_factor_reset r SET state = 'cancelled', cancelled_by = v_person, cancelled_at = now() WHERE r.id = p_reset_id;
  RETURN QUERY SELECT r.id, r.subject_person_id, r.cancelled_at FROM trustwork.second_factor_reset r WHERE r.id = p_reset_id;
END $$;

-- After the cooling-off, the requester or the approver executes the reset: every factor, recovery code, open
-- challenge, elevation and session of the subject ends in this transaction.
CREATE FUNCTION trustwork.second_factor_reset_execute(p_reset_id uuid)
RETURNS TABLE (id uuid, subject_person_id uuid, executed_at timestamptz, factors_revoked integer, sessions_revoked integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_reset trustwork.second_factor_reset;
  v_factors integer;
  v_sessions integer;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_reset FROM trustwork.second_factor_reset r WHERE r.id = p_reset_id FOR UPDATE;
  IF v_reset.id IS NULL OR v_person NOT IN (v_reset.requested_by, coalesce(v_reset.approved_by, v_reset.requested_by)) THEN
    RAISE EXCEPTION 'reset not found' USING ERRCODE = '42501', HINT = 'second_factor.reset_not_found';
  END IF;
  IF v_reset.state <> 'cooling_off' THEN
    RAISE EXCEPTION 'reset is not approved or already final' USING ERRCODE = '42501', HINT = 'second_factor.reset_state';
  END IF;
  IF v_reset.effective_at > now() THEN
    RAISE EXCEPTION 'the cooling-off period has not ended' USING ERRCODE = '42501', HINT = 'second_factor.reset_cooling_off';
  END IF;
  UPDATE trustwork.second_factor f SET state = 'revoked', revoked_at = now(), revoked_reason = 'support_reset'
  WHERE f.person_id = v_reset.subject_person_id AND f.state IN ('pending', 'active');
  GET DIAGNOSTICS v_factors = ROW_COUNT;
  UPDATE trustwork.recovery_code c SET revoked_at = now() WHERE c.person_id = v_reset.subject_person_id AND c.used_at IS NULL AND c.revoked_at IS NULL;
  UPDATE trustwork.second_factor_challenge c SET consumed_at = now() WHERE c.person_id = v_reset.subject_person_id AND c.consumed_at IS NULL;
  UPDATE trustwork.session_elevation e SET revoked_at = now(), revoked_reason = 'factor_changed' WHERE e.person_id = v_reset.subject_person_id AND e.revoked_at IS NULL;
  UPDATE trustwork.session s SET revoked_at = now(), revoked_reason = 'admin' WHERE s.person_id = v_reset.subject_person_id AND s.revoked_at IS NULL;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  UPDATE trustwork.second_factor_reset r SET state = 'done', executed_by = v_person, executed_at = now() WHERE r.id = p_reset_id;
  RETURN QUERY SELECT r.id, r.subject_person_id, r.executed_at, v_factors, v_sessions FROM trustwork.second_factor_reset r WHERE r.id = p_reset_id;
END $$;

GRANT EXECUTE ON FUNCTION
  trustwork.second_factor_use_recovery_code(bytea),
  trustwork.auth_lookup_second_factor_challenge(bytea, integer),
  trustwork.auth_clear_second_factor_failures(),
  trustwork.second_factor_reset_subject_addresses(uuid),
  trustwork.second_factor_reset_approve(uuid),
  trustwork.second_factor_reset_cancel(uuid),
  trustwork.second_factor_reset_execute(uuid)
TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
