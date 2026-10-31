-- BE-001 common admission / revocation primitive (docs/architecture/retrieval.md "Authorization and revocation
-- linearization"). One authoritative linearization shared by API and worker nodes:
--   * admission_scope(scope, epoch): a revocation is an exclusive row update (epoch + 1) committed by the revoker;
--   * admission_lease: one row per server-issued permit (EgressPermit) with the scope epochs observed at issue, the
--     exact provider binding and payload digest; admission consumes the permit once (one use) after re-reading the
--     scope rows under FOR SHARE, which waits for a concurrent revocation to commit and then observes its epoch;
--   * revocation_event: append-only history carrying the epoch after each bump so consumers can fence.
-- Already admitted bytes cannot be recalled; the lease (lease_until) bounds the in-flight window for best-effort
-- cancellation and reporting only. None of these tables carries party-private payloads (ids and digests only).

CREATE TABLE trustwork.admission_scope (
  scope text PRIMARY KEY CHECK (length(scope) BETWEEN 1 AND 200),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trustwork.revocation_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  epoch bigint NOT NULL CHECK (epoch >= 1),
  reason text NULL CHECK (reason IS NULL OR length(reason) <= 500),
  actor_person_id uuid NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX revocation_event_scope_idx ON trustwork.revocation_event (scope, id);
CREATE TRIGGER revocation_event_append_only BEFORE UPDATE OR DELETE ON trustwork.revocation_event FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.admission_lease (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  permit_id text NOT NULL UNIQUE CHECK (length(permit_id) BETWEEN 1 AND 128),
  principal_id uuid NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
  scope_epochs bigint[] NOT NULL CHECK (cardinality(scope_epochs) = cardinality(scopes)),
  target text NOT NULL CHECK (target IN ('embedding_provider', 'rerank_provider', 'answer_provider')),
  purpose text NOT NULL CHECK (purpose IN ('query_embedding', 'document_embedding', 'rerank', 'answer')),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  payload_digest text NOT NULL CHECK (length(payload_digest) BETWEEN 1 AND 200),
  policy_epoch text NOT NULL CHECK (length(policy_epoch) BETWEEN 1 AND 40),
  scope_fingerprint text NOT NULL CHECK (length(scope_fingerprint) BETWEEN 1 AND 200),
  dependencies_digest text NOT NULL CHECK (dependencies_digest ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  admitted_at timestamptz NULL,
  lease_until timestamptz NULL,
  settled_at timestamptz NULL,
  outcome text NULL CHECK (outcome IN ('dispatched', 'failed', 'lease_expired', 'cancelled')),
  denied_at timestamptz NULL,
  denied_reason text NULL CHECK (denied_reason IS NULL OR length(denied_reason) <= 60),
  revoked_at timestamptz NULL,
  CONSTRAINT admission_lease_window CHECK (expires_at > issued_at),
  CONSTRAINT admission_lease_admitted_shape CHECK ((admitted_at IS NULL) = (lease_until IS NULL)),
  CONSTRAINT admission_lease_settled_shape CHECK (settled_at IS NULL OR (admitted_at IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX admission_lease_principal_idx ON trustwork.admission_lease (principal_id, issued_at);
CREATE INDEX admission_lease_inflight_idx ON trustwork.admission_lease (lease_until) WHERE admitted_at IS NOT NULL AND settled_at IS NULL;

-- Issues a permit for the current principal. The scope rows are read under FOR SHARE so an in-progress revocation
-- commits first and the lease records the post-revocation epoch. Raises 28000 without a verified identity.
CREATE FUNCTION trustwork.admission_issue(
  p_permit_id text, p_principal_id uuid, p_scopes text[], p_binding jsonb, p_payload_digest text,
  p_policy_epoch text, p_scope_fingerprint text, p_dependencies_digest text, p_expires_at timestamptz
) RETURNS bigint[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_scopes text[];
  v_epochs bigint[];
BEGIN
  IF trustwork.current_person_id() IS NULL OR trustwork.current_person_id() <> p_principal_id THEN
    RAISE EXCEPTION 'admission requires the verified identity of the permit principal' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_scopes IS NULL OR cardinality(p_scopes) = 0 THEN
    RAISE EXCEPTION 'a permit binds at least one scope' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admission.scope_required';
  END IF;
  SELECT array_agg(DISTINCT s ORDER BY s) INTO v_scopes FROM unnest(p_scopes) AS s;
  INSERT INTO trustwork.admission_scope (scope) SELECT unnest(v_scopes) ON CONFLICT (scope) DO NOTHING;
  SELECT array_agg(a.epoch ORDER BY a.scope) INTO v_epochs
  FROM (SELECT s.scope, s.epoch FROM trustwork.admission_scope s WHERE s.scope = ANY (v_scopes) FOR SHARE) a;
  INSERT INTO trustwork.admission_lease (
    permit_id, principal_id, scopes, scope_epochs, target, purpose, binding, payload_digest, policy_epoch, scope_fingerprint, dependencies_digest, expires_at
  ) VALUES (
    p_permit_id, p_principal_id, v_scopes, v_epochs, p_binding ->> 'target', p_binding ->> 'purpose', p_binding, p_payload_digest, p_policy_epoch, p_scope_fingerprint, p_dependencies_digest, p_expires_at
  );
  RETURN v_epochs;
END $$;

-- Serialized admission: consumes the permit once when identity, principal, expiry, binding, digest, context and
-- every scope epoch still match. Every failure records a reason on the lease and returns admitted = false.
CREATE FUNCTION trustwork.admission_admit(
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
  SELECT * INTO v_lease FROM trustwork.admission_lease l WHERE l.permit_id = p_permit_id FOR UPDATE;
  IF v_lease.id IS NULL THEN
    RETURN QUERY SELECT false, 'unknown_permit'::text, NULL::uuid, NULL::timestamptz, NULL::bigint[];
    RETURN;
  END IF;
  IF v_lease.principal_id <> trustwork.current_person_id() THEN
    v_reason := 'principal_mismatch';
  ELSIF v_lease.admitted_at IS NOT NULL OR v_lease.denied_at IS NOT NULL THEN
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
    -- Linearization point: FOR SHARE waits for a concurrent exclusive revocation to commit and then reads its epoch.
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

-- Exclusive revocation: bumps the scope epoch (row lock waits for in-flight admission checks), records the event and
-- invalidates every unadmitted permit on the scope. Returns the epoch after the bump. Requires a verified identity or
-- the maintenance context; the application decides when a scope is revoked (membership end, participation revoke).
CREATE FUNCTION trustwork.admission_revoke(p_scope text, p_reason text) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_epoch bigint;
BEGIN
  IF trustwork.current_person_id() IS NULL AND NOT trustwork.in_maintenance() THEN
    RAISE EXCEPTION 'revocation requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  INSERT INTO trustwork.admission_scope (scope) VALUES (p_scope) ON CONFLICT (scope) DO NOTHING;
  UPDATE trustwork.admission_scope SET epoch = epoch + 1, revoked_at = now(), updated_at = clock_timestamp() WHERE scope = p_scope RETURNING epoch INTO v_epoch;
  INSERT INTO trustwork.revocation_event (scope, epoch, reason, actor_person_id) VALUES (p_scope, v_epoch, p_reason, trustwork.current_person_id());
  UPDATE trustwork.admission_lease SET revoked_at = now()
  WHERE p_scope = ANY (scopes) AND admitted_at IS NULL AND denied_at IS NULL AND revoked_at IS NULL;
  RETURN v_epoch;
END $$;

-- Settles an admitted lease (dispatch finished, failed or exceeded its lease). Only the permit principal may settle.
CREATE FUNCTION trustwork.admission_settle(p_lease_id uuid, p_outcome text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'settlement requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  UPDATE trustwork.admission_lease SET settled_at = now(), outcome = p_outcome
  WHERE id = p_lease_id AND principal_id = trustwork.current_person_id() AND admitted_at IS NOT NULL AND settled_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

GRANT SELECT ON trustwork.admission_scope, trustwork.admission_lease, trustwork.revocation_event TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.admission_issue(text, uuid, text[], jsonb, text, text, text, text, timestamptz),
  trustwork.admission_admit(text, jsonb, text, text, text, text, interval),
  trustwork.admission_revoke(text, text),
  trustwork.admission_settle(uuid, text)
TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
