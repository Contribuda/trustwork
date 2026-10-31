-- BE-002: identity hardening follow-ups (architecture audit B3, B7, B8, C2 and the BE-001 review).
--   1. A maintenance session is a login that is a member of trustwork_owner (the migrator) with the maintenance flag.
--      The flag alone proves nothing: the runtime role may set it, and inside a SECURITY DEFINER function
--      trustwork.in_maintenance() is then true because current_user is the owner.
--   2. admission_revoke is scoped to the caller's own scopes, scopes it manages, or scopes whose revocation the same
--      transaction has just performed (participation revoked, membership ended); otherwise maintenance only.
--   3. auth_disable_password requires the owner's identity or a maintenance session (no API path calls it any more:
--      failed attempts now cause a progressive delay, never a disabled password).
--   4. Mailbox proof: signup against an address held only by another person's UNVERIFIED binding creates the new
--      person with a verification token; consuming a verification or e-mail change token (the mailbox proof) removes
--      the squatting unverified binding and binds the address, verified, to the prover.
--   5. Progressive login delay helpers: failure count with the time since the last failure, and clearing one's own
--      account counters after a proof (successful sign-in, step-up or recovery).
--   6. The runtime (API) role loses what the worker owns since REL-001: the caller-chosen sweep, job leasing,
--      reconciliation and every job update. It keeps job SELECT/INSERT (enqueue) and gains UPDATE (expires_at) on
--      idempotency_record for the in-progress takeover lease.
--   7. person.display_name may be NULL (provider sign-up without a name); clients render a localized placeholder.

-- 1. -----------------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.maintenance_session() RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT current_setting('trustwork.maintenance', true) = 'on' AND pg_has_role(session_user, 'trustwork_owner', 'MEMBER')
$$;

-- 2. -----------------------------------------------------------------------------------------------------------------
-- Invoker helper (no grant): runs as the owner inside admission_revoke and reads the FORCE-RLS tables with the
-- function-scoped maintenance flag. Rows written by the current top-level transaction carry its xid in xmin.
CREATE FUNCTION trustwork.admission_revoke_allowed(p_scope text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_match text[];
  v_kind text;
  v_id uuid;
  v_xid xid;
BEGIN
  IF v_person IS NULL THEN
    RETURN false;
  END IF;
  v_match := regexp_match(p_scope, '^([a-z][a-z0-9_]{0,59}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  IF v_match IS NULL THEN
    RETURN false;
  END IF;
  v_kind := v_match[1];
  v_id := v_match[2]::uuid;
  -- Own scopes.
  IF v_kind = 'person' AND v_id = v_person THEN
    RETURN true;
  END IF;
  IF v_kind = 'company' AND v_id = trustwork.current_company_id() AND trustwork.current_membership_has('company.members.manage') THEN
    RETURN true;
  END IF;
  IF v_kind NOT IN ('person', 'company') AND (trustwork.can_manage_resource(v_kind, v_id) OR trustwork.owns_resource(v_kind, v_id)) THEN
    RETURN true;
  END IF;
  -- Revocation evidence written by this transaction (participation revoke under RLS, end_membership, ownership
  -- transfer): the scopes of the revoked row may be revoked too.
  v_xid := pg_current_xact_id_if_assigned()::xid;
  IF v_xid IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM trustwork.object_participation p
    WHERE p.xmin = v_xid AND p.revoked_at IS NOT NULL
      AND ((v_kind = 'person' AND p.party_person_id = v_id)
        OR (v_kind = 'company' AND p.party_company_id = v_id)
        OR (p.resource_kind = v_kind AND p.resource_id = v_id))
  ) OR (v_kind = 'person' AND EXISTS (
    SELECT 1 FROM trustwork.membership m WHERE m.xmin = v_xid AND m.status = 'ended' AND m.person_id = v_id
  ));
END $$;

CREATE OR REPLACE FUNCTION trustwork.admission_revoke(p_scope text, p_reason text) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_epoch bigint;
BEGIN
  IF NOT trustwork.maintenance_session() THEN
    IF trustwork.current_person_id() IS NULL THEN
      RAISE EXCEPTION 'revocation requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
    END IF;
    IF NOT trustwork.admission_revoke_allowed(p_scope) THEN
      RAISE EXCEPTION 'scope % is outside the caller''s authority', p_scope USING ERRCODE = '42501', HINT = 'admission.revoke_out_of_scope';
    END IF;
  END IF;
  INSERT INTO trustwork.admission_scope (scope) VALUES (p_scope) ON CONFLICT (scope) DO NOTHING;
  UPDATE trustwork.admission_scope SET epoch = epoch + 1, revoked_at = now(), updated_at = clock_timestamp() WHERE scope = p_scope RETURNING epoch INTO v_epoch;
  INSERT INTO trustwork.revocation_event (scope, epoch, reason, actor_person_id) VALUES (p_scope, v_epoch, p_reason, trustwork.current_person_id());
  UPDATE trustwork.admission_lease SET revoked_at = now()
  WHERE p_scope = ANY (scopes) AND admitted_at IS NULL AND denied_at IS NULL AND revoked_at IS NULL;
  RETURN v_epoch;
END $$;

-- 3. -----------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trustwork.auth_disable_password(p_email_normalized text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_count integer;
  v_person uuid;
BEGIN
  IF NOT trustwork.maintenance_session() THEN
    v_person := trustwork.current_person_id();
    IF v_person IS NULL THEN
      RAISE EXCEPTION 'disabling a password requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.email_normalized = p_email_normalized AND b.person_id = v_person) THEN
      RAISE EXCEPTION 'only the owner of the address may disable its password' USING ERRCODE = '42501', HINT = 'access.forbidden';
    END IF;
  END IF;
  UPDATE trustwork.credential c SET disabled_at = now()
  FROM trustwork.email_binding b
  WHERE b.email_normalized = p_email_normalized AND c.person_id = b.person_id AND c.kind = 'password' AND c.disabled_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- 4. -----------------------------------------------------------------------------------------------------------------
-- Signup: 'registered' (new person with an unverified primary binding), 'claim_pending' (the address is held by
-- another person's unverified binding: the new person gets a password and a verification token for the address but
-- no binding until the mailbox proof), or 'bound' (a verified binding exists; person_id is its owner for the notice).
-- A concurrent signup that wins the unique index is re-read once.
CREATE FUNCTION trustwork.auth_signup(p_display_name text, p_email_normalized text, p_password_hash text, p_verify_token_hash bytea, p_verify_expires_at timestamptz)
RETURNS TABLE (person_id uuid, outcome text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_binding trustwork.email_binding;
  v_person uuid;
BEGIN
  FOR v_attempt IN 1..2 LOOP
    SELECT * INTO v_binding FROM trustwork.email_binding b WHERE b.email_normalized = p_email_normalized FOR UPDATE;
    IF v_binding.id IS NOT NULL AND v_binding.verified_at IS NOT NULL THEN
      RETURN QUERY SELECT v_binding.person_id, 'bound'::text;
      RETURN;
    END IF;
    BEGIN
      INSERT INTO trustwork.person (display_name) VALUES (p_display_name) RETURNING id INTO v_person;
      IF v_binding.id IS NULL THEN
        INSERT INTO trustwork.email_binding (person_id, email_normalized, is_primary) VALUES (v_person, p_email_normalized, true);
      END IF;
      INSERT INTO trustwork.credential (person_id, kind, password_hash) VALUES (v_person, 'password', p_password_hash);
      INSERT INTO trustwork.auth_token (token_hash, kind, person_id, email_normalized, expires_at)
        VALUES (p_verify_token_hash, 'verify_email', v_person, p_email_normalized, p_verify_expires_at);
      RETURN QUERY SELECT v_person, CASE WHEN v_binding.id IS NULL THEN 'registered' ELSE 'claim_pending' END;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      v_binding := NULL;
    END;
  END LOOP;
  RETURN QUERY SELECT NULL::uuid, 'bound'::text;
END $$;

-- Mailbox proof: consumes a verify_email or email_change token (single use, unexpired) and binds the address,
-- verified, to the token's person. Outcomes: 'verified' (own binding), 'bound' (address was free), 'claimed' (an
-- unverified binding of another person was removed: that person loses every credential, token and session unless
-- they keep another verified address, in which case only the squatted binding goes), 'taken' (another person holds
-- the address verified). No row: unknown, consumed or expired token.
CREATE FUNCTION trustwork.auth_prove_mailbox(p_token_hash bytea)
RETURNS TABLE (person_id uuid, email_normalized text, kind text, authz_epoch integer, outcome text, binding_id uuid, displaced_person_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_token trustwork.auth_token;
  v_binding trustwork.email_binding;
  v_binding_id uuid;
  v_displaced uuid;
  v_outcome text;
BEGIN
  UPDATE trustwork.auth_token t SET consumed_at = now()
  WHERE t.token_hash = p_token_hash AND t.kind IN ('verify_email', 'email_change') AND t.consumed_at IS NULL AND t.expires_at > now()
  RETURNING t.* INTO v_token;
  IF v_token.id IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO v_binding FROM trustwork.email_binding b WHERE b.email_normalized = v_token.email_normalized FOR UPDATE;
  IF v_binding.id IS NOT NULL AND v_binding.person_id = v_token.person_id THEN
    UPDATE trustwork.email_binding SET verified_at = now() WHERE id = v_binding.id AND verified_at IS NULL;
    v_binding_id := v_binding.id;
    v_outcome := 'verified';
  ELSIF v_binding.id IS NOT NULL AND v_binding.verified_at IS NOT NULL THEN
    v_outcome := 'taken';
  ELSE
    IF v_binding.id IS NOT NULL THEN
      v_displaced := v_binding.person_id;
      DELETE FROM trustwork.email_binding WHERE id = v_binding.id;
      IF NOT EXISTS (SELECT 1 FROM trustwork.email_binding o WHERE o.person_id = v_displaced AND o.verified_at IS NOT NULL) THEN
        UPDATE trustwork.credential SET disabled_at = now() WHERE credential.person_id = v_displaced AND disabled_at IS NULL;
        UPDATE trustwork.auth_token SET consumed_at = now() WHERE auth_token.person_id = v_displaced AND consumed_at IS NULL;
        UPDATE trustwork.session SET revoked_at = now(), revoked_reason = 'suspicious' WHERE session.person_id = v_displaced AND revoked_at IS NULL;
      END IF;
    END IF;
    BEGIN
      INSERT INTO trustwork.email_binding (person_id, email_normalized, is_primary, verified_at)
      VALUES (v_token.person_id, v_token.email_normalized,
        NOT EXISTS (SELECT 1 FROM trustwork.email_binding o WHERE o.person_id = v_token.person_id AND o.is_primary), now())
      RETURNING id INTO v_binding_id;
      v_outcome := CASE WHEN v_displaced IS NULL THEN 'bound' ELSE 'claimed' END;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent proof bound the address first; the caller answers auth.email_taken and rolls back.
      v_binding_id := NULL;
      v_outcome := 'taken';
    END;
  END IF;
  RETURN QUERY SELECT v_token.person_id, v_token.email_normalized, v_token.kind, p.authz_epoch, v_outcome, v_binding_id, v_displaced
  FROM trustwork.person p WHERE p.id = v_token.person_id;
END $$;

-- 5. -----------------------------------------------------------------------------------------------------------------
-- Failures inside the window and the seconds since the newest one (database clock), for the progressive delay.
CREATE FUNCTION trustwork.auth_login_throttle(p_subject_hash bytea, p_window interval)
RETURNS TABLE (failures integer, seconds_since_last double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT count(*)::integer, coalesce(extract(epoch FROM now() - max(f.occurred_at)), 0)::double precision
  FROM trustwork.login_failure f WHERE f.subject_hash = p_subject_hash AND f.occurred_at >= now() - p_window
$$;

-- Clears the account failure counters of the current person's verified addresses (subject = sha256('account:' ||
-- address), as hashed by the API). Requires the verified identity; nobody can clear someone else's counter.
CREATE FUNCTION trustwork.auth_clear_login_failures() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_count integer;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'clearing failure counters requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  DELETE FROM trustwork.login_failure f USING trustwork.email_binding b
  WHERE b.person_id = v_person AND b.verified_at IS NOT NULL
    AND f.subject_hash = sha256(convert_to('account:' || b.email_normalized, 'UTF8'));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- 6. -----------------------------------------------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION trustwork.sweep_expired(interval, interval, interval) FROM trustwork_app;
REVOKE EXECUTE ON FUNCTION trustwork.lease_jobs(text[], text, interval, integer) FROM trustwork_app;
REVOKE EXECUTE ON FUNCTION trustwork.reconcile_job(uuid, text, text) FROM trustwork_app;
-- Table-level REVOKE also removes every column-level UPDATE grant on job.
REVOKE UPDATE ON trustwork.job FROM trustwork_app;
GRANT UPDATE (expires_at) ON trustwork.idempotency_record TO trustwork_app;

-- 7. -----------------------------------------------------------------------------------------------------------------
-- The length CHECK (1..200) still applies to every non-NULL name.
ALTER TABLE trustwork.person ALTER COLUMN display_name DROP NOT NULL;

GRANT EXECUTE ON FUNCTION
  trustwork.auth_signup(text, text, text, bytea, timestamptz),
  trustwork.auth_prove_mailbox(bytea),
  trustwork.auth_login_throttle(bytea, interval),
  trustwork.auth_clear_login_failures()
TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
