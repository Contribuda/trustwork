-- BE-001 review fixes (PR #17): bounded tables (sweeper + login_failure cap) and a non-disclosing admission denial.

-- P2-3: login_failure is capped at 10,000 rows; the oldest rows beyond the cap are evicted on insert, so an attacker
-- cannot grow the table without bound (synthetic subjects for unknown accounts share the same cap).
CREATE OR REPLACE FUNCTION trustwork.auth_record_login_failure(p_subject_hash bytea, p_window interval, p_retention interval)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_count integer;
  v_total bigint;
  v_cap constant integer := 10000;
BEGIN
  INSERT INTO trustwork.login_failure (subject_hash, expires_at) VALUES (p_subject_hash, now() + p_retention);
  SELECT count(*) INTO v_total FROM trustwork.login_failure;
  IF v_total > v_cap THEN
    DELETE FROM trustwork.login_failure WHERE id IN (SELECT id FROM trustwork.login_failure ORDER BY occurred_at, id LIMIT (v_total - v_cap));
  END IF;
  SELECT count(*) INTO v_count FROM trustwork.login_failure WHERE subject_hash = p_subject_hash AND occurred_at >= now() - p_window;
  RETURN v_count;
END $$;

-- P2-3: owner-run sweeper callable by the worker/API with the runtime role. Deletes expired or consumed auth tokens,
-- expired login failures, expired idempotency records, settled/expired/denied admission leases past the grace period,
-- revoked or expired sessions past the retention, and purges never-verified signups (no verified binding, no provider
-- credential, older than p_unverified_age) together with their tokens, credentials, bindings and sessions. Persons
-- referenced by audit rows are kept (audit is append-only); pre-identity audit rows therefore carry no actor.
CREATE FUNCTION trustwork.sweep_expired(p_session_retention interval, p_lease_grace interval, p_unverified_age interval)
RETURNS TABLE (auth_tokens integer, login_failures integer, idempotency_records integer, admission_leases integer, sessions integer, unverified_persons integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_tokens integer; v_failures integer; v_idempotency integer; v_leases integer; v_sessions integer; v_persons integer;
  v_purge uuid[];
BEGIN
  -- No identity requirement: the only effect is deleting expired bookkeeping (never party data of live accounts).
  DELETE FROM trustwork.auth_token WHERE expires_at < now() OR consumed_at IS NOT NULL;
  GET DIAGNOSTICS v_tokens = ROW_COUNT;
  DELETE FROM trustwork.login_failure WHERE expires_at < now();
  GET DIAGNOSTICS v_failures = ROW_COUNT;
  DELETE FROM trustwork.idempotency_record WHERE expires_at < now();
  GET DIAGNOSTICS v_idempotency = ROW_COUNT;
  DELETE FROM trustwork.admission_lease
  WHERE (settled_at IS NOT NULL AND settled_at < now() - p_lease_grace)
     OR (denied_at IS NOT NULL AND denied_at < now() - p_lease_grace)
     OR (admitted_at IS NULL AND expires_at < now() - p_lease_grace);
  GET DIAGNOSTICS v_leases = ROW_COUNT;
  DELETE FROM trustwork.session
  WHERE (revoked_at IS NOT NULL AND revoked_at < now() - p_session_retention)
     OR (absolute_expires_at < now() - p_session_retention);
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  SELECT array_agg(p.id) INTO v_purge
  FROM trustwork.person p
  WHERE p.created_at < now() - p_unverified_age
    AND NOT EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.person_id = p.id AND b.verified_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM trustwork.credential c WHERE c.person_id = p.id AND c.provider IS NOT NULL AND c.disabled_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.person_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM trustwork.project pr WHERE pr.creator_person_id = p.id OR pr.owner_person_id = p.id OR pr.leader_person_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM trustwork.object_participation op WHERE op.party_person_id = p.id OR op.granted_by_person_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM trustwork.audit_event a WHERE a.actor_person_id = p.id AND a.action NOT LIKE 'auth.%');
  v_persons := coalesce(cardinality(v_purge), 0);
  IF v_persons > 0 THEN
    DELETE FROM trustwork.auth_token WHERE person_id = ANY (v_purge);
    DELETE FROM trustwork.session WHERE person_id = ANY (v_purge);
    DELETE FROM trustwork.credential WHERE person_id = ANY (v_purge);
    DELETE FROM trustwork.email_binding WHERE person_id = ANY (v_purge);
    DELETE FROM trustwork.person WHERE id = ANY (v_purge) AND NOT EXISTS (SELECT 1 FROM trustwork.audit_event a WHERE a.actor_person_id = trustwork.person.id);
    GET DIAGNOSTICS v_persons = ROW_COUNT;
  END IF;
  RETURN QUERY SELECT v_tokens, v_failures, v_idempotency, v_leases, v_sessions, v_persons;
END $$;
GRANT EXECUTE ON FUNCTION trustwork.sweep_expired(interval, interval, interval) TO trustwork_app;

-- P3: an admission by a principal other than the permit's owner answers like an unknown permit (no existence
-- disclosure) and leaves the lease untouched for its owner.
CREATE OR REPLACE FUNCTION trustwork.admission_admit(
  p_permit_id text, p_binding jsonb, p_payload_digest text, p_policy_epoch text, p_scope_fingerprint text, p_dependencies_digest text, p_lease interval
) RETURNS TABLE (admitted boolean, reason text, lease_id uuid, lease_until timestamptz, scope_epochs bigint[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_lease trustwork.admission_lease;
  v_now_epochs bigint[];
  v_reason text := NULL;
  v_until timestamptz;
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RETURN QUERY SELECT false, 'missing_identity'::text, NULL::uuid, NULL::timestamptz, NULL::bigint[];
    RETURN;
  END IF;
  SELECT * INTO v_lease FROM trustwork.admission_lease l WHERE l.permit_id = p_permit_id AND l.principal_id = trustwork.current_person_id() FOR UPDATE;
  IF v_lease.id IS NULL THEN
    RETURN QUERY SELECT false, 'unknown_permit'::text, NULL::uuid, NULL::timestamptz, NULL::bigint[];
    RETURN;
  END IF;
  IF v_lease.admitted_at IS NOT NULL OR v_lease.denied_at IS NOT NULL THEN
    v_reason := 'replayed';
  ELSIF v_lease.revoked_at IS NOT NULL THEN
    v_reason := 'revoked';
  ELSIF v_lease.expires_at <= now() THEN
    v_reason := 'expired';
  ELSIF v_lease.binding <> p_binding THEN
    v_reason := 'binding_mismatch';
  ELSIF v_lease.payload_digest <> p_payload_digest THEN
    v_reason := 'digest_mismatch';
  ELSIF v_lease.policy_epoch <> p_policy_epoch OR v_lease.scope_fingerprint <> p_scope_fingerprint OR v_lease.dependencies_digest <> p_dependencies_digest THEN
    v_reason := 'context_mismatch';
  END IF;
  IF v_reason IS NULL THEN
    SELECT array_agg(a.epoch ORDER BY a.scope) INTO v_now_epochs
    FROM (SELECT s.scope, s.epoch FROM trustwork.admission_scope s WHERE s.scope = ANY (v_lease.scopes) FOR SHARE) a;
    IF v_now_epochs IS NULL OR cardinality(v_now_epochs) <> cardinality(v_lease.scope_epochs) OR v_now_epochs <> v_lease.scope_epochs THEN
      v_reason := 'revoked';
    END IF;
  END IF;
  IF v_reason IS NOT NULL THEN
    IF v_reason <> 'replayed' THEN
      UPDATE trustwork.admission_lease SET denied_at = now(), denied_reason = v_reason WHERE id = v_lease.id AND denied_at IS NULL;
    END IF;
    RETURN QUERY SELECT false, v_reason, NULL::uuid, NULL::timestamptz, v_now_epochs;
    RETURN;
  END IF;
  v_until := now() + p_lease;
  UPDATE trustwork.admission_lease SET admitted_at = now(), lease_until = v_until WHERE id = v_lease.id;
  RETURN QUERY SELECT true, NULL::text, v_lease.id, v_until, v_now_epochs;
END $$;

-- P3: current authorization epoch of a person for the session resolver's one retry after a stale epoch. The epoch is
-- an integer that discloses nothing about the person; the resolver only calls it for the person of a valid session.
CREATE FUNCTION trustwork.auth_person_epoch(p_person_id uuid) RETURNS TABLE (authz_epoch integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.authz_epoch FROM trustwork.person p WHERE p.id = p_person_id
$$;
GRANT EXECUTE ON FUNCTION trustwork.auth_person_epoch(uuid) TO trustwork_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
