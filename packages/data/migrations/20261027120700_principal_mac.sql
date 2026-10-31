-- BE-001 identity hardening (closes the "known limit" of DATA-001): the transaction-local identity is bound to an
-- owner-only secret. trustwork.set_principal computes trustwork.principal_mac over the values it set plus the backend pid and
-- the transaction start time; trustwork.verify_person_id() recomputes the MAC as a SECURITY DEFINER verifier and returns
-- NULL when it does not match. trustwork.current_person_id() / current_company_id() / current_authz_epoch() are thin
-- inlinable wrappers around the verifier, so a forged set_config('trustwork.person_id', ...) as trustwork_app has no identity:
-- every policy denies and every definer helper sees NULL.

CREATE TABLE trustwork.principal_key (
  id integer PRIMARY KEY CHECK (id = 1),
  secret bytea NOT NULL CHECK (octet_length(secret) = 32),
  rotated_at timestamptz NOT NULL DEFAULT now()
);
-- Owner-only: no privilege for the runtime role. gen_random_uuid() uses the server's strong random source; three of
-- them (366 random bits) are folded through SHA-256 into the 256-bit secret. Rotation is a maintenance UPDATE
-- (`-- trustwork:expect-rows 1`); it invalidates nothing durable because the MAC lives only inside open transactions.
INSERT INTO trustwork.principal_key (id, secret)
  VALUES (1, sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')));
REVOKE ALL ON trustwork.principal_key FROM PUBLIC;
REVOKE ALL ON trustwork.principal_key FROM trustwork_app;

-- MAC input: secret || person || '|' || company || '|' || epoch || '|' || backend pid || '|' || transaction start.
-- The pid and transaction timestamp bind the value to this transaction on this backend, so a MAC observed in one
-- transaction cannot be replayed in another (set_config values die at COMMIT/ROLLBACK anyway). The expression is
-- inlined in the setter and the verifier on purpose: a callable helper would let the runtime role compute MACs.

CREATE OR REPLACE FUNCTION trustwork.set_principal(p_person_id uuid, p_authz_epoch integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_epoch integer;
  v_company uuid;
  v_company_text text;
BEGIN
  IF p_person_id IS NULL OR p_authz_epoch IS NULL THEN
    RAISE EXCEPTION 'principal requires person id and authz epoch' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT authz_epoch INTO v_epoch FROM trustwork.person WHERE id = p_person_id;
  IF v_epoch IS NULL THEN
    RAISE EXCEPTION 'unknown principal' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF v_epoch <> p_authz_epoch THEN
    RAISE EXCEPTION 'stale authz epoch % (current %)', p_authz_epoch, v_epoch USING ERRCODE = '28000', HINT = 'access.stale_epoch';
  END IF;
  SELECT company_id INTO v_company FROM trustwork.membership
  WHERE person_id = p_person_id AND status = 'active' AND valid_from <= now();
  v_company_text := coalesce(v_company::text, '');
  PERFORM set_config('trustwork.person_id', p_person_id::text, true);
  PERFORM set_config('trustwork.authz_epoch', p_authz_epoch::text, true);
  PERFORM set_config('trustwork.company_id', v_company_text, true);
  PERFORM set_config('trustwork.principal_mac', (
    SELECT encode(sha256(k.secret || convert_to(
      p_person_id::text || '|' || v_company_text || '|' || p_authz_epoch::text || '|' || pg_backend_pid()::text || '|' || transaction_timestamp()::text, 'UTF8')), 'hex')
    FROM trustwork.principal_key k WHERE k.id = 1), true);
END $$;

-- Verifier: a missing or empty value denies, a malformed uuid aborts (22P02), a value without the matching MAC denies.
-- Takes no arguments on purpose: it is not an oracle that lets a caller test candidate MACs for other identities.
CREATE FUNCTION trustwork.verify_person_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = trustwork, pg_temp AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('trustwork.person_id', true), '') IS NULL THEN NULL
    WHEN current_setting('trustwork.principal_mac', true) IS NOT DISTINCT FROM (
         SELECT encode(sha256(k.secret || convert_to(
           current_setting('trustwork.person_id', true) || '|' || coalesce(current_setting('trustwork.company_id', true), '') || '|' || coalesce(current_setting('trustwork.authz_epoch', true), '') || '|' || pg_backend_pid()::text || '|' || transaction_timestamp()::text, 'UTF8')), 'hex')
         FROM trustwork.principal_key k WHERE k.id = 1)
      THEN current_setting('trustwork.person_id', true)::uuid
    -- A forged well-formed value yields NULL; malformed text still aborts (22P02, RL-08) so a typo never looks like "no identity".
    ELSE CASE WHEN current_setting('trustwork.person_id', true)::uuid IS NULL THEN NULL::uuid ELSE NULL::uuid END END
$$;
GRANT EXECUTE ON FUNCTION trustwork.verify_person_id() TO trustwork_app;

-- Wrappers: plain SQL without SET clauses so the planner inlines them; the verifier call sits in a scalar sub-select
-- (no FROM), which becomes an uncorrelated InitPlan evaluated once per query instead of once per row.
CREATE OR REPLACE FUNCTION trustwork.current_person_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT (SELECT trustwork.verify_person_id())
$$;

CREATE OR REPLACE FUNCTION trustwork.current_company_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN (SELECT trustwork.verify_person_id()) IS NULL THEN NULL
              ELSE NULLIF(current_setting('trustwork.company_id', true), '')::uuid END
$$;

CREATE OR REPLACE FUNCTION trustwork.current_authz_epoch() RETURNS integer
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN (SELECT trustwork.verify_person_id()) IS NULL THEN NULL
              ELSE NULLIF(current_setting('trustwork.authz_epoch', true), '')::integer END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
