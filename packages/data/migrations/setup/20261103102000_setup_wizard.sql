-- HUB-004: the setup wizard's first run (docs/engine/hub-console/setup-wizard.md, installation.md "The setup token";
-- ADR 012 decisions 11 and 26, ADR 014 decisions 3 and 4).
--
-- A fresh node has no administrator, so whoever reaches it first could claim it. The installer prints a one-time setup
-- token (32 random bytes); only its SHA-256 and expiry are stored here. The token opens exactly one setup run: the
-- answers of each step are stored server-side so a person can stop and resume, steps are saved in order (never ahead of
-- the first incomplete one), restricted places are refused in every answer, the run is bound to the founding
-- administrator once they hold a second factor and recovery codes, and finishing invalidates the token. After setup
-- finished no token can be issued again (the node is set up; staff are assigned through the console).
--
-- Commands (SECURITY DEFINER):
--   setup_issue_token          owner-run only (installer / migrate job, maintenance session): issue or replace the token
--   setup_open                 the run a valid token opens (no row for an unknown, expired or used token)
--   setup_save                 store one step's answer in order; restricted places refused; after the founding
--                              administrator is bound, only that person (signed in) may change anything
--   setup_claim_admin          record the address of the founding administrator's new account (step 5a)
--   setup_bootstrap_admin      the caller becomes the founding administrator: verified address, an active second
--                              factor and unused recovery codes required; the node anchor and the founding role
--                              definition are created if missing, and the founding assignment is made
--   setup_begin_finish         locks the run for the founding administrator's finishing transaction
--   setup_finish               the founding administrator finishes: every step done, the hub created in this
--                              transaction, a deployment-location attestation in force; the token is invalidated
--   setup_screening_lists, setup_screening_candidates
--                              the active screening lists and candidate entries for screening the operator entity
--                              against the engine baseline (SANC-003 matcher in the API), for a valid token only
--
-- The founding assignment: DATA-002's assignment guard lets only a maintenance session bootstrap founding
-- administrators. The API runtime role can never be a maintenance session, so this migration replaces
-- admin_assignment_guard with the same function plus one more authorized path: the bootstrap row inserted by
-- setup_bootstrap_admin in the same transaction, for the founding role at node scope and the person the valid setup
-- run was just bound to (setup_bootstrap_authorized). Every other rule of the guard is unchanged (at most two founding
-- administrators, each once, and only before any console assignment).

-- 0. Vocabularies --------------------------------------------------------------------------------------------------------
-- SETUP_STEPS of packages/contracts/src/hub.ts (frozen console contract).
CREATE FUNCTION trustwork.setup_steps() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['install_check', 'node_identity', 'hub_identity', 'operator', 'first_admin', 'storage_residency', 'providers', 'modes', 'review']::text[]
$$;
-- FOUNDING_NODE_OPERATOR_PERMISSIONS of packages/contracts/src/hub-setup.ts (tested equal).
CREATE FUNCTION trustwork.setup_founding_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.audit.read', 'admin.config.edit', 'admin.hub.country.edit', 'admin.hub.identity.edit', 'admin.hub.jurisdiction.edit', 'admin.hub.launch.check',
    'admin.hub.legal.edit', 'admin.hub.lifecycle.request', 'admin.hub.modes.edit', 'admin.hub.read', 'admin.hub.residency.edit', 'admin.node.hubs.manage',
    'admin.observability.read', 'admin.providers.connection.edit', 'admin.providers.read', 'admin.session.elevate', 'admin.staff.assign', 'admin.staff.read']::text[]
$$;

-- 1. The setup run (one per node) --------------------------------------------------------------------------------------
CREATE TABLE trustwork.setup_run (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  token_hash text NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_issued_at timestamptz NULL,
  token_expires_at timestamptz NULL,
  completed text[] NOT NULL DEFAULT '{}' CHECK (completed <@ trustwork.setup_steps() AND trustwork.admin_distinct(completed)),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object' AND octet_length(answers::text) <= 131072),
  admin_email text NULL CHECK (admin_email = lower(admin_email) AND length(admin_email) BETWEEN 3 AND 254),
  first_admin_person_id uuid NULL REFERENCES trustwork.person (id),
  first_admin_second_factor text NULL CHECK (first_admin_second_factor IN ('totp', 'webauthn')),
  recovery_codes_issued_at timestamptz NULL,
  bootstrap_xact text NULL,
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT setup_run_token_shape CHECK ((token_hash IS NULL) = (token_expires_at IS NULL) AND (token_hash IS NULL) = (token_issued_at IS NULL)
    AND (token_expires_at IS NULL OR token_expires_at > token_issued_at)),
  CONSTRAINT setup_run_admin_shape CHECK ((first_admin_person_id IS NULL) = (first_admin_second_factor IS NULL)
    AND (first_admin_person_id IS NULL) = (recovery_codes_issued_at IS NULL) AND (first_admin_person_id IS NULL OR node_id IS NOT NULL)),
  CONSTRAINT setup_run_first_admin_step CHECK (('first_admin' = ANY (completed)) = (first_admin_person_id IS NOT NULL)),
  CONSTRAINT setup_run_finished_shape CHECK (finished_at IS NULL
    OR (token_hash IS NULL AND hub_id IS NOT NULL AND first_admin_person_id IS NOT NULL AND completed @> trustwork.setup_steps()))
);
CREATE UNIQUE INDEX setup_run_single ON trustwork.setup_run ((true));
CREATE TRIGGER setup_run_touch BEFORE UPDATE ON trustwork.setup_run FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Every writer: never deleted; a finished run never changes; the founding administrator, the node and the hub are set
-- once; completed steps are never forgotten.
CREATE FUNCTION trustwork.setup_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a setup run is never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.finished_at IS NOT NULL OR NEW.first_admin_person_id IS NOT NULL OR NEW.hub_id IS NOT NULL OR cardinality(NEW.completed) > 0 THEN
      RAISE EXCEPTION 'a setup run starts empty' USING ERRCODE = 'check_violation', HINT = 'setup.invalid_transition';
    END IF;
    NEW.started_at := now();
    RETURN NEW;
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'setup is finished' USING ERRCODE = 'check_violation', HINT = 'setup.finished';
  END IF;
  IF NEW.id <> OLD.id OR NEW.started_at <> OLD.started_at
     OR (OLD.first_admin_person_id IS NOT NULL AND NEW.first_admin_person_id IS DISTINCT FROM OLD.first_admin_person_id)
     OR (OLD.node_id IS NOT NULL AND NEW.node_id IS DISTINCT FROM OLD.node_id)
     OR (OLD.hub_id IS NOT NULL AND NEW.hub_id IS DISTINCT FROM OLD.hub_id)
     OR NOT (NEW.completed @> OLD.completed) THEN
    RAISE EXCEPTION 'the founding administrator, node, hub and completed steps of a setup run never change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'setup.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER setup_run_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.setup_run FOR EACH ROW EXECUTE FUNCTION trustwork.setup_run_guard();

-- 2. Helpers (invoker, no grant; called inside the commands with the maintenance flag) -------------------------------------
-- The open run of a token, locked: a known hash, unexpired, unfinished. Existence never leaks (setup.not_found).
CREATE FUNCTION trustwork.setup_lock_run(p_token_hash text) RETURNS trustwork.setup_run
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_run trustwork.setup_run%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM trustwork.setup_run
   WHERE p_token_hash ~ '^[a-f0-9]{64}$' AND token_hash = p_token_hash AND token_expires_at > now() AND finished_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open setup run for this token' USING ERRCODE = 'no_data_found', HINT = 'setup.not_found';
  END IF;
  RETURN v_run;
END $$;

-- Once the founding administrator is bound, every change is theirs (signed in): the token alone no longer suffices.
CREATE FUNCTION trustwork.setup_require_actor(p_run trustwork.setup_run) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_run.first_admin_person_id IS NOT NULL AND trustwork.current_person_id() IS DISTINCT FROM p_run.first_admin_person_id THEN
    RAISE EXCEPTION 'only the founding administrator continues this setup' USING ERRCODE = 'insufficient_privilege', HINT = 'setup.first_admin_only';
  END IF;
END $$;

-- The first incomplete step (nextSetupStep), or NULL when every step is done.
CREATE FUNCTION trustwork.setup_next_step(p_completed text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT s FROM unnest(trustwork.setup_steps()) WITH ORDINALITY u(s, ord) WHERE NOT (s = ANY (p_completed)) ORDER BY ord LIMIT 1
$$;

-- Refuses a step ahead of the first incomplete one.
CREATE FUNCTION trustwork.setup_require_order(p_run trustwork.setup_run, p_step text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_missing text[];
BEGIN
  SELECT coalesce(array_agg(s ORDER BY ord), ARRAY[]::text[]) INTO v_missing
    FROM unnest(trustwork.setup_steps()) WITH ORDINALITY u(s, ord)
   WHERE ord < array_position(trustwork.setup_steps(), p_step) AND NOT (s = ANY (p_run.completed));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'complete the earlier steps first' USING ERRCODE = 'check_violation', HINT = 'setup.step_out_of_order', DETAIL = array_to_string(v_missing, ',');
  END IF;
END $$;

-- Every restricted place a step's answer names, as `field:code` (empty: none). The kernel list is authoritative and
-- fails closed while it is not synced; a place inside a restricted region is restricted too.
CREATE FUNCTION trustwork.setup_answer_refusals(p_step text, p_answer jsonb) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_out text[] := ARRAY[]::text[];
  v_t jsonb;
  v_r text;
BEGIN
  IF p_step = 'node_identity' AND trustwork.kernel_place_restricted(p_answer ->> 'jurisdiction') THEN
    v_out := v_out || ('jurisdiction:' || coalesce(p_answer ->> 'jurisdiction', '?'));
  ELSIF p_step = 'hub_identity' THEN
    IF trustwork.kernel_place_restricted(p_answer ->> 'country') THEN v_out := v_out || ('country:' || coalesce(p_answer ->> 'country', '?')); END IF;
    FOR v_t IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_answer -> 'territories') = 'array' THEN p_answer -> 'territories' ELSE '[]'::jsonb END) LOOP
      IF trustwork.kernel_place_restricted(v_t ->> 'code') THEN v_out := v_out || ('territories:' || coalesce(v_t ->> 'code', '?')); END IF;
    END LOOP;
  ELSIF p_step = 'operator' THEN
    FOREACH v_r IN ARRAY trustwork.attestation_refusals(p_answer ->> 'entityCountry', p_answer ->> 'entityRegion', p_answer ->> 'hostingCountry', p_answer ->> 'hostingRegion') LOOP
      v_out := v_out || (CASE split_part(v_r, ':', 1) WHEN 'operator_entity_country' THEN 'entityCountry' WHEN 'operator_entity_region' THEN 'entityRegion'
        WHEN 'hosting_country' THEN 'hostingCountry' ELSE 'hostingRegion' END || ':' || CASE split_part(v_r, ':', 3) WHEN 'region_required' THEN 'region_required' ELSE split_part(v_r, ':', 2) END);
    END LOOP;
  ELSIF p_step = 'storage_residency' AND trustwork.kernel_place_restricted(p_answer ->> 'personalDataCountry') THEN
    v_out := v_out || ('personalDataCountry:' || coalesce(p_answer ->> 'personalDataCountry', '?'));
  END IF;
  RETURN (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), ARRAY[]::text[]) FROM unnest(v_out) x);
END $$;

-- The hub country and every territory's country and region are known, selectable jurisdictions; a pack starting
-- point names a country with an active pack. Raises the first problem.
CREATE FUNCTION trustwork.setup_check_hub_identity(p_answer jsonb) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_country text := p_answer ->> 'country';
  v_codes text[];
  v_code text;
  v_j trustwork.jurisdiction%ROWTYPE;
BEGIN
  SELECT array_agg(DISTINCT c) INTO v_codes FROM (
    SELECT v_country AS c
    UNION SELECT left(t.value ->> 'code', 2) FROM jsonb_array_elements(p_answer -> 'territories') t
    UNION SELECT split_part(t.value ->> 'code', ':', 1) FROM jsonb_array_elements(p_answer -> 'territories') t
  ) x WHERE c IS NOT NULL;
  FOREACH v_code IN ARRAY coalesce(v_codes, ARRAY[]::text[]) LOOP
    SELECT * INTO v_j FROM trustwork.jurisdiction WHERE code = v_code;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown jurisdiction %', v_code USING ERRCODE = 'check_violation', HINT = 'setup.jurisdiction_unknown', DETAIL = v_code;
    END IF;
    IF v_j.restricted OR NOT v_j.selectable THEN
      RAISE EXCEPTION 'jurisdiction % is not selectable', v_code USING ERRCODE = 'check_violation', HINT = 'setup.jurisdiction_not_selectable', DETAIL = v_code;
    END IF;
  END LOOP;
  IF p_answer ->> 'startingPoint' = 'pack' AND NOT EXISTS (
    SELECT 1 FROM trustwork.jurisdiction j WHERE j.code = v_country AND j.source = 'pack' AND j.retired_at IS NULL) THEN
    RAISE EXCEPTION 'country % has no active country pack; start from the generic profile', v_country USING ERRCODE = 'check_violation', HINT = 'setup.pack_unknown', DETAIL = v_country;
  END IF;
END $$;

-- Does the person hold an active second factor and unused recovery codes now?
CREATE FUNCTION trustwork.setup_second_factor_ready(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.second_factor f WHERE f.person_id = p_person AND f.state = 'active')
     AND EXISTS (SELECT 1 FROM trustwork.recovery_code r WHERE r.person_id = p_person AND r.used_at IS NULL AND r.revoked_at IS NULL)
$$;

-- The founding assignment path the assignment guard accepts besides a maintenance session: setup_bootstrap_admin bound
-- this person to the open run in this very transaction, for the founding role at node scope.
CREATE FUNCTION trustwork.setup_bootstrap_authorized(p_person uuid, p_role text, p_scope_kind text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_role = 'node-operator' AND p_scope_kind = 'node' AND EXISTS (
    SELECT 1 FROM trustwork.setup_run r
    WHERE r.first_admin_person_id = p_person AND r.finished_at IS NULL AND r.token_hash IS NOT NULL
      AND r.bootstrap_xact = pg_current_xact_id()::text)
$$;

-- 3. Commands ----------------------------------------------------------------------------------------------------------------
-- Owner-run (installer, migrate job): issue a token or replace the current one (the old one stops working at once);
-- the answers stay, so setup resumes. Refused once setup finished, and on a node whose staff were assigned another way.
CREATE FUNCTION trustwork.setup_issue_token(p_token_hash text, p_expires_at timestamptz) RETURNS trustwork.setup_run
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_run trustwork.setup_run%ROWTYPE;
  v_exists boolean;
BEGIN
  IF NOT trustwork.maintenance_session() THEN
    RAISE EXCEPTION 'setup tokens are issued by the installer only' USING ERRCODE = 'insufficient_privilege', HINT = 'setup.owner_only';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' OR p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '7 days' THEN
    RAISE EXCEPTION 'a setup token is a SHA-256 hash with an expiry within seven days' USING ERRCODE = 'invalid_parameter_value', HINT = 'setup.token_invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.setup_run'));
  SELECT * INTO v_run FROM trustwork.setup_run FOR UPDATE;
  v_exists := FOUND;
  IF v_exists AND v_run.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'setup already finished; staff are assigned through the console' USING ERRCODE = 'check_violation', HINT = 'setup.finished';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.staff_role_assignment a WHERE a.person_id IS DISTINCT FROM v_run.first_admin_person_id) THEN
    RAISE EXCEPTION 'this node already has staff; it is set up' USING ERRCODE = 'check_violation', HINT = 'setup.finished';
  END IF;
  IF v_exists THEN
    UPDATE trustwork.setup_run SET token_hash = p_token_hash, token_issued_at = now(), token_expires_at = p_expires_at WHERE id = v_run.id RETURNING * INTO v_run;
  ELSE
    INSERT INTO trustwork.setup_run (token_hash, token_issued_at, token_expires_at) VALUES (p_token_hash, now(), p_expires_at) RETURNING * INTO v_run;
  END IF;
  RETURN v_run;
END $$;

-- The run a valid token opens; no row for an unknown, expired or used token.
CREATE FUNCTION trustwork.setup_open(p_token_hash text) RETURNS SETOF trustwork.setup_run
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT * FROM trustwork.setup_run
  WHERE p_token_hash ~ '^[a-f0-9]{64}$' AND token_hash = p_token_hash AND token_expires_at > now() AND finished_at IS NULL
$$;

-- Saves one step's answer (the API validated its shape against the contract). In order; restricted places refused;
-- the founding administrator's node name is fixed once the node anchor exists.
CREATE FUNCTION trustwork.setup_save(p_token_hash text, p_step text, p_answer jsonb) RETURNS trustwork.setup_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.setup_run%ROWTYPE := trustwork.setup_lock_run(p_token_hash);
  v_items text[];
BEGIN
  IF p_step IS NULL OR NOT (p_step = ANY (trustwork.setup_steps())) OR p_step IN ('first_admin', 'review') THEN
    RAISE EXCEPTION 'step % is not saved here', coalesce(p_step, '?') USING ERRCODE = 'invalid_parameter_value', HINT = 'setup.step_invalid';
  END IF;
  IF p_answer IS NULL OR jsonb_typeof(p_answer) <> 'object' THEN
    RAISE EXCEPTION 'an answer is an object' USING ERRCODE = 'invalid_parameter_value', HINT = 'setup.answer_invalid';
  END IF;
  PERFORM trustwork.setup_require_actor(v_run);
  PERFORM trustwork.setup_require_order(v_run, p_step);
  IF p_step = 'node_identity' AND v_run.node_id IS NOT NULL AND (v_run.answers -> 'node_identity') IS DISTINCT FROM p_answer THEN
    RAISE EXCEPTION 'the node identity is fixed once the founding administrator is set up' USING ERRCODE = 'check_violation', HINT = 'setup.node_fixed';
  END IF;
  IF p_step = 'install_check' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_answer -> 'checks') = 'array' THEN p_answer -> 'checks' ELSE '[]'::jsonb END) c WHERE c.value ->> 'state' = 'fail') THEN
    RAISE EXCEPTION 'a blocking install check failed' USING ERRCODE = 'check_violation', HINT = 'setup.install_check_failed',
      DETAIL = (SELECT string_agg(c.value ->> 'id', ',') FROM jsonb_array_elements(p_answer -> 'checks') c WHERE c.value ->> 'state' = 'fail');
  END IF;
  PERFORM trustwork.kernel_lock_restrictions_shared();
  v_items := trustwork.setup_answer_refusals(p_step, p_answer);
  IF cardinality(v_items) > 0 THEN
    RAISE EXCEPTION 'a restricted place is never offered, hosted or served' USING ERRCODE = 'check_violation', HINT = 'setup.restricted_place', DETAIL = array_to_string(v_items, ',');
  END IF;
  IF p_step = 'hub_identity' THEN
    PERFORM trustwork.setup_check_hub_identity(p_answer);
  END IF;
  UPDATE trustwork.setup_run
     SET answers = answers || jsonb_build_object(p_step, p_answer),
         completed = CASE WHEN p_step = ANY (completed) THEN completed ELSE completed || p_step END
   WHERE id = v_run.id RETURNING * INTO v_run;
  RETURN v_run;
END $$;

-- Step 5a: the address of the account the founding administrator just created (verified later by the mailbox proof).
CREATE FUNCTION trustwork.setup_claim_admin(p_token_hash text, p_email text) RETURNS trustwork.setup_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.setup_run%ROWTYPE := trustwork.setup_lock_run(p_token_hash);
BEGIN
  PERFORM trustwork.setup_require_order(v_run, 'first_admin');
  IF v_run.first_admin_person_id IS NOT NULL THEN
    RAISE EXCEPTION 'the founding administrator is already set up' USING ERRCODE = 'check_violation', HINT = 'setup.first_admin_bound';
  END IF;
  UPDATE trustwork.setup_run SET admin_email = lower(p_email) WHERE id = v_run.id RETURNING * INTO v_run;
  RETURN v_run;
END $$;

-- Step 5b: the signed-in caller becomes the founding administrator (node-operator at the node). Their address must be
-- the verified primary one claimed in step 5a (when one was claimed); they must hold an active second factor and
-- unused recovery codes. Idempotent for the same person.
CREATE FUNCTION trustwork.setup_bootstrap_admin(p_token_hash text, p_second_factor text) RETURNS trustwork.setup_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_run trustwork.setup_run%ROWTYPE := trustwork.setup_lock_run(p_token_hash);
  v_node uuid;
  v_version integer;
  v_issued timestamptz;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'sign in as the founding administrator' USING ERRCODE = 'insufficient_privilege', HINT = 'access.no_principal';
  END IF;
  PERFORM trustwork.setup_require_order(v_run, 'first_admin');
  IF v_run.first_admin_person_id IS NOT NULL THEN
    IF v_run.first_admin_person_id = v_person THEN
      RETURN v_run;
    END IF;
    RAISE EXCEPTION 'the founding administrator is already set up' USING ERRCODE = 'insufficient_privilege', HINT = 'setup.first_admin_only';
  END IF;
  IF p_second_factor IS DISTINCT FROM 'totp' THEN
    -- Passkeys (WebAuthn) are not implemented by BE-004 yet; only an enrolled authenticator app counts.
    RAISE EXCEPTION 'enrol an authenticator app; passkeys are not available yet' USING ERRCODE = 'check_violation', HINT = 'setup.second_factor_unavailable';
  END IF;
  IF v_run.admin_email IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM trustwork.email_binding b WHERE b.person_id = v_person AND b.email_normalized = v_run.admin_email AND b.verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'sign in with the account created in this setup' USING ERRCODE = 'insufficient_privilege', HINT = 'setup.admin_account_mismatch';
  END IF;
  IF NOT trustwork.setup_second_factor_ready(v_person) THEN
    RAISE EXCEPTION 'the founding administrator needs an active second factor and recovery codes' USING ERRCODE = 'check_violation', HINT = 'setup.second_factor_required';
  END IF;
  SELECT max(r.created_at) INTO v_issued FROM trustwork.recovery_code r WHERE r.person_id = v_person AND r.used_at IS NULL AND r.revoked_at IS NULL;

  v_node := (SELECT id FROM trustwork.admin_node LIMIT 1);
  IF v_node IS NULL THEN
    INSERT INTO trustwork.admin_node (label) VALUES (coalesce(v_run.answers -> 'node_identity' ->> 'nodeName', 'Trustwork node')) RETURNING id INTO v_node;
  END IF;
  SELECT max(d.version) INTO v_version FROM trustwork.staff_role_definition_version d WHERE d.role = 'node-operator' AND 'node' = ANY (d.scopes);
  IF v_version IS NULL THEN
    INSERT INTO trustwork.staff_role_definition_version (role, version, scopes, permissions, grant_max_hours, sod_mode, released_by)
    VALUES ('node-operator', 1, ARRAY['node'], trustwork.setup_founding_permissions(), 72, 'reduced', NULL);
    v_version := 1;
  END IF;

  UPDATE trustwork.setup_run
     SET first_admin_person_id = v_person, first_admin_second_factor = p_second_factor, recovery_codes_issued_at = v_issued, node_id = v_node,
         bootstrap_xact = pg_current_xact_id()::text, completed = completed || 'first_admin'::text
   WHERE id = v_run.id RETURNING * INTO v_run;
  INSERT INTO trustwork.staff_role_assignment (person_id, role, scope_kind, node_id, hub_id, definition_version, granted_by, reason, setup_bootstrap)
  VALUES (v_person, 'node-operator', 'node', v_node, NULL, v_version, NULL, 'Founding administrator (setup wizard)', true);
  UPDATE trustwork.setup_run SET bootstrap_xact = NULL WHERE id = v_run.id RETURNING * INTO v_run;
  RETURN v_run;
END $$;

-- Step 9 begins: locks the run for the founding administrator's finishing transaction, so of two simultaneous finishes
-- one waits and then finds the setup finished (not found).
CREATE FUNCTION trustwork.setup_begin_finish(p_token_hash text) RETURNS trustwork.setup_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.setup_run%ROWTYPE := trustwork.setup_lock_run(p_token_hash);
BEGIN
  IF v_run.first_admin_person_id IS NULL OR trustwork.current_person_id() IS DISTINCT FROM v_run.first_admin_person_id THEN
    RAISE EXCEPTION 'only the founding administrator finishes setup' USING ERRCODE = 'insufficient_privilege', HINT = 'setup.first_admin_only';
  END IF;
  PERFORM trustwork.setup_require_order(v_run, 'review');
  RETURN v_run;
END $$;

-- Step 9: the founding administrator finishes. The hub was created by HUB-001's hubs_create earlier in this
-- transaction; the attestation must be in force now; the founding administrator still holds a second factor.
CREATE FUNCTION trustwork.setup_finish(p_token_hash text, p_hub uuid) RETURNS trustwork.setup_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.setup_run%ROWTYPE := trustwork.setup_lock_run(p_token_hash);
BEGIN
  IF v_run.first_admin_person_id IS NULL OR trustwork.current_person_id() IS DISTINCT FROM v_run.first_admin_person_id THEN
    RAISE EXCEPTION 'only the founding administrator finishes setup' USING ERRCODE = 'insufficient_privilege', HINT = 'setup.first_admin_only';
  END IF;
  PERFORM trustwork.setup_require_order(v_run, 'review');
  IF NOT trustwork.setup_second_factor_ready(v_run.first_admin_person_id) THEN
    RAISE EXCEPTION 'the founding administrator needs an active second factor and recovery codes' USING ERRCODE = 'check_violation', HINT = 'setup.second_factor_required';
  END IF;
  IF NOT trustwork.attestation_in_force(now()) THEN
    RAISE EXCEPTION 'setup finishes only with a deployment-location attestation in force' USING ERRCODE = 'check_violation', HINT = 'setup.attestation_required';
  END IF;
  IF p_hub IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.hub h JOIN trustwork.hub_profile p ON p.hub_id = h.id WHERE h.id = p_hub AND h.lifecycle = 'draft') THEN
    RAISE EXCEPTION 'setup finishes with a draft hub' USING ERRCODE = 'check_violation', HINT = 'setup.hub_required';
  END IF;
  UPDATE trustwork.setup_run
     SET hub_id = p_hub, finished_at = now(), token_hash = NULL, token_issued_at = NULL, token_expires_at = NULL,
         completed = CASE WHEN 'review' = ANY (completed) THEN completed ELSE completed || 'review'::text END
   WHERE id = v_run.id RETURNING * INTO v_run;
  RETURN v_run;
END $$;

-- The active screening lists (SANC-003 baseline) for screening the operator entity during setup.
CREATE FUNCTION trustwork.setup_screening_lists(p_token_hash text) RETURNS TABLE (list_code text, baseline boolean, version_id uuid, available boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.setup_open(p_token_hash)) THEN
    RAISE EXCEPTION 'no open setup run for this token' USING ERRCODE = 'no_data_found', HINT = 'setup.not_found';
  END IF;
  RETURN QUERY SELECT l.list_code, l.baseline, l.version_id, l.available FROM trustwork.screening_lists_now() l;
END $$;
CREATE FUNCTION trustwork.setup_screening_candidates(p_token_hash text, p_entry_types text[], p_tokens text[], p_initials text[])
RETURNS TABLE (list_code text, list_version_id uuid, entry_uid text, entry_type text, primary_name text, programs text[], name_keys text[], entry_digest text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.setup_open(p_token_hash)) THEN
    RAISE EXCEPTION 'no open setup run for this token' USING ERRCODE = 'no_data_found', HINT = 'setup.not_found';
  END IF;
  IF cardinality(coalesce(p_tokens, ARRAY[]::text[])) > 64 OR cardinality(coalesce(p_initials, ARRAY[]::text[])) > 64 THEN
    RAISE EXCEPTION 'too many name tokens' USING ERRCODE = 'invalid_parameter_value', HINT = 'setup.answer_invalid';
  END IF;
  RETURN QUERY SELECT * FROM trustwork.screening_candidates(p_entry_types, p_tokens, p_initials);
END $$;

-- 4. DATA-002's assignment guard with the setup path ------------------------------------------------------------------------
-- Identical to packages/data/migrations/admin/20261101180000_admin_staff.sql except the founding branch, which also
-- accepts setup_bootstrap_authorized (see the header of this file).
CREATE OR REPLACE FUNCTION trustwork.admin_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_target record;
  v_def trustwork.staff_role_definition_version%ROWTYPE;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_action text;
  v_valid_for bigint;
  v_incident trustwork.incident%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staff assignments are never deleted; revoke them' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.person_id, NEW.role, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.definition_version, NEW.granted_by, NEW.approved_by, NEW.approval_id,
           NEW.reason, NEW.breakglass, NEW.incident_id, NEW.setup_bootstrap, NEW.valid_from, NEW.valid_until, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.person_id, OLD.role, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.definition_version, OLD.granted_by, OLD.approved_by, OLD.approval_id,
           OLD.reason, OLD.breakglass, OLD.incident_id, OLD.setup_bootstrap, OLD.valid_from, OLD.valid_until, OLD.created_at)
       OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'a staff assignment only changes by revocation, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
    SELECT * INTO v_target FROM trustwork.admin_target(OLD.scope_kind, OLD.node_id, OLD.hub_id);
    IF NEW.revoked_by <> OLD.person_id AND NOT trustwork.maintenance_session()
       AND (SELECT r.role FROM trustwork.admin_resolve_permission(NEW.revoked_by, 'admin.staff.revoke', v_target.node, v_target.hub) r) IS NULL THEN
      RAISE EXCEPTION 'revoking needs admin.staff.revoke at a covering scope' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
    END IF;
    NEW.revoked_at := now();
    RETURN NEW;
  END IF;

  NEW.created_at := now();
  IF NEW.valid_from < now() THEN
    NEW.valid_from := now();
  END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL THEN
    RAISE EXCEPTION 'an assignment is born unrevoked' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  SELECT * INTO v_def FROM trustwork.staff_role_definition_version WHERE role = NEW.role AND version = NEW.definition_version;
  IF FOUND AND NOT (NEW.scope_kind = ANY (v_def.scopes)) THEN
    RAISE EXCEPTION 'definition % v% is not held at scope %', NEW.role, NEW.definition_version, NEW.scope_kind USING ERRCODE = 'check_violation', HINT = 'admin.role_scope';
  END IF;

  IF NEW.setup_bootstrap THEN
    -- The setup wizard's founding administrators: a maintenance session or the setup run's own bootstrap (HUB-004), at
    -- most two different people (the second person every later sensitive assignment needs), and only before any staff
    -- assignment was made through the console.
    IF NOT (trustwork.maintenance_session() OR trustwork.setup_bootstrap_authorized(NEW.person_id, NEW.role, NEW.scope_kind)) THEN
      RAISE EXCEPTION 'only the setup maintenance path bootstraps founding administrators' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('trustwork.admin_bootstrap'));
    IF EXISTS (SELECT 1 FROM trustwork.staff_role_assignment a WHERE NOT a.setup_bootstrap)
       OR (SELECT count(*) FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap) >= 2
       OR EXISTS (SELECT 1 FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap AND a.person_id = NEW.person_id) THEN
      RAISE EXCEPTION 'setup is over; assign through a staff administrator' USING ERRCODE = 'check_violation', HINT = 'admin.bootstrap_closed';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO v_target FROM trustwork.admin_target(NEW.scope_kind, NEW.node_id, NEW.hub_id);
  IF (SELECT r.role FROM trustwork.admin_resolve_permission(NEW.granted_by, CASE WHEN NEW.breakglass THEN 'admin.staff.breakglass' ELSE 'admin.staff.assign' END, v_target.node, v_target.hub) r) IS NULL THEN
    RAISE EXCEPTION 'the grantor holds no assigning permission at a covering scope' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;

  IF NEW.breakglass THEN
    IF NEW.valid_until IS NULL OR NEW.valid_until > NEW.valid_from + interval '12 hours' THEN
      RAISE EXCEPTION 'break-glass lasts at most 12 hours' USING ERRCODE = 'check_violation', HINT = 'admin.breakglass_too_long';
    END IF;
    SELECT * INTO v_incident FROM trustwork.incident WHERE id = NEW.incident_id;
    IF NOT FOUND OR v_incident.status IN ('resolved', 'closed') THEN
      RAISE EXCEPTION 'break-glass names an open incident' USING ERRCODE = 'check_violation', HINT = 'admin.incident_not_open';
    END IF;
  END IF;

  IF NEW.role = ANY (trustwork.admin_sensitive_roles()) OR NEW.breakglass THEN
    v_action := CASE WHEN NEW.breakglass THEN 'staff.grant_breakglass' ELSE 'staff.assign_sensitive_role' END;
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
    v_valid_for := CASE WHEN NEW.valid_until IS NULL THEN NULL ELSE round(extract(epoch FROM NEW.valid_until - NEW.valid_from))::bigint END;
    IF NOT FOUND OR v_approval.action <> v_action OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id
       OR v_approval.requested_by IS DISTINCT FROM NEW.granted_by OR v_approval.approved_by IS DISTINCT FROM NEW.approved_by
       OR v_approval.scope_kind <> NEW.scope_kind OR v_approval.node_id IS DISTINCT FROM NEW.node_id OR v_approval.hub_id IS DISTINCT FROM NEW.hub_id
       OR v_approval.action_digest <> trustwork.admin_assignment_digest(v_action, NEW.person_id, NEW.role, NEW.scope_kind, NEW.node_id, NEW.hub_id,
            NEW.definition_version, NEW.breakglass, NEW.incident_id, v_valid_for) THEN
      RAISE EXCEPTION 'sensitive and break-glass roles need the consumed second-person approval of exactly this assignment' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_mismatch';
    END IF;
  ELSIF NEW.approval_id IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'only sensitive and break-glass roles carry an approval' USING ERRCODE = 'check_violation', HINT = 'admin.approval_mismatch';
  END IF;

  -- Separation of duties: in full mode a role never joins a conflicting role held by the same person.
  IF EXISTS (
    SELECT 1 FROM trustwork.staff_role_assignment a
    JOIN trustwork.staff_role_definition_version d ON d.role = a.role AND d.version = a.definition_version
    WHERE a.person_id = NEW.person_id AND a.revoked_at IS NULL AND (a.valid_until IS NULL OR a.valid_until > now())
      AND ((v_def.sod_mode = 'full' AND a.role = ANY (v_def.sod_conflicts)) OR (d.sod_mode = 'full' AND NEW.role = ANY (d.sod_conflicts)))
  ) THEN
    RAISE EXCEPTION 'role % conflicts with a role the person already holds', NEW.role USING ERRCODE = 'check_violation', HINT = 'admin.sod_conflict';
  END IF;
  RETURN NEW;
END $$;

-- 5. Row-level security and grants ------------------------------------------------------------------------------------------
-- The runtime role never reads or writes the run directly: only through the commands above.
ALTER TABLE trustwork.setup_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.setup_run FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.setup_run AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

GRANT EXECUTE ON FUNCTION trustwork.setup_open(text), trustwork.setup_save(text, text, jsonb), trustwork.setup_claim_admin(text, text),
  trustwork.setup_bootstrap_admin(text, text), trustwork.setup_begin_finish(text), trustwork.setup_finish(text, uuid), trustwork.setup_screening_lists(text),
  trustwork.setup_screening_candidates(text, text[], text[], text[]) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
