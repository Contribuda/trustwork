-- MCP-002: the hub authorization server for the MCP surfaces (ADR 013 decisions 5 to 9 and 19; docs/engine/mcp-server.md,
-- "Connecting and authorization"). A connection is another hand of the person's one agent (AGT-002 `ExternalConnection`,
-- protocol `mcp`): it holds the person's consent for one client, one redirect URI and one surface, and every token
-- references it. Scopes, toolsets, private data classes and mandate bindings are read from the live consent on every
-- token check, so withdrawing or narrowing takes effect before the next call.
--
-- Tables (all ENABLE + FORCE row-level security; the runtime role reads only the caller's own connections and consents
-- and writes nothing directly):
--   oauth_client                       client registrations: Client ID Metadata Documents (cached), pre-registered and
--                                      deprecated dynamic registrations
--   connection_consent                 what the person agreed to, per client id, redirect URI and surface (history kept)
--   connection                         the live connection that tokens reference
--   oauth_authorization_code           single-use codes (hash only) bound to PKCE S256, the redirect URI and the resource
--   connection_token_family            one per code redemption; revoking the family ends every token issued from it
--   connection_token                   access and refresh tokens, stored only as SHA-256 hashes, audience-bound
--   connection_call                    audit of every MCP call by argument digest (written by MCP-003)
--   connection_confirmation_challenge  on-site confirmation of a commit (behaviour in MCP-005)
--
-- Commands (SECURITY DEFINER, search_path pinned, executable by trustwork_app only):
--   pre-identity, keyed by hashes or client ids: oauth_client_get, oauth_client_store_metadata,
--     oauth_client_register_dynamic, oauth_code_redeem, oauth_refresh_rotate, oauth_token_revoke,
--     connection_token_introspect
--   under the person's principal: connection_consent_grant, oauth_code_issue, connection_revoke, connection_revoke_all
-- Internal (trigger) definer: connections_revoke_on_credential_change (password change and account recovery revoke
-- every token of the person).
--
-- A person held by a jurisdiction check (SANC-001) or suspended by a confirmed screening match (SANC-003) gets no code
-- and no token, and their existing tokens stop working at the next check. No column stores a token, a code or a
-- verifier: only SHA-256 hashes and the S256 challenge.

-- 1. Vocabulary helpers -------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.connections_participant_scopes() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['read.public', 'read.me', 'read.contexts', 'read.private', 'propose', 'act']::text[]
$$;
CREATE FUNCTION trustwork.connections_staff_scopes() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['admin.read', 'admin.propose']::text[]
$$;
CREATE FUNCTION trustwork.connections_private_classes() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['negotiation_constraints', 'budgets', 'private_projects', 'drafts']::text[]
$$;
CREATE FUNCTION trustwork.connections_toolsets() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY['account', 'agent', 'companies', 'projects', 'plans', 'consultations', 'tasks', 'catalogue', 'procurement', 'sales', 'orders',
    'execution', 'reputation', 'knowledge', 'learning', 'events', 'publications', 'matching', 'messages', 'notifications', 'billing', 'files', 'hub']::text[]
$$;
CREATE FUNCTION trustwork.connections_distinct(p text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT cardinality(p) = (SELECT count(DISTINCT x) FROM unnest(p) AS x)
$$;
-- RFC 8252 section 7.3: a registered loopback redirect URI matches any port; everything else matches exactly.
CREATE FUNCTION trustwork.connections_redirect_matches(p_registered text, p_presented text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_registered = p_presented OR (
    p_registered ~ '^http://(127\.0\.0\.1|\[::1\]|localhost)(:[0-9]{1,5})?/'
    AND regexp_replace(p_registered, '^(http://(127\.0\.0\.1|\[::1\]|localhost))(:[0-9]{1,5})?', '\1')
      = regexp_replace(p_presented, '^(http://(127\.0\.0\.1|\[::1\]|localhost))(:[0-9]{1,5})?', '\1'))
$$;

-- 2. Client registrations -----------------------------------------------------------------------------------------------
CREATE TABLE trustwork.oauth_client (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  client_id text NOT NULL UNIQUE CHECK (length(client_id) BETWEEN 1 AND 500),
  registration text NOT NULL CHECK (registration IN ('client_id_metadata_document', 'pre_registered', 'dynamic_registration')),
  -- Self-asserted unless the hub lists the client id (listing is hub policy, read at request time, and never grants scope).
  client_name text NOT NULL CHECK (length(btrim(client_name)) BETWEEN 1 AND 120),
  client_uri text NULL CHECK (client_uri IS NULL OR (client_uri ~ '^https://' AND length(client_uri) <= 500)),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 20 AND trustwork.connections_distinct(redirect_uris)),
  application_type text NOT NULL CHECK (application_type IN ('web', 'native')),
  token_endpoint_auth_method text NOT NULL CHECK (token_endpoint_auth_method IN ('none', 'private_key_jwt')),
  -- Public keys of a confidential client (private_key_jwt); never a secret.
  jwks jsonb NULL CHECK (jwks IS NULL OR jsonb_typeof(jwks -> 'keys') = 'array'),
  company_id uuid NULL REFERENCES trustwork.company (id),
  metadata_digest text NULL CHECK (metadata_digest IS NULL OR metadata_digest ~ '^[a-f0-9]{64}$'),
  metadata_fetched_at timestamptz NULL,
  metadata_expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NULL,
  disabled_at timestamptz NULL,
  disabled_reason text NULL CHECK (disabled_reason IS NULL OR length(btrim(disabled_reason)) BETWEEN 1 AND 500),
  CONSTRAINT oauth_client_id_shape CHECK (CASE registration
    WHEN 'client_id_metadata_document' THEN client_id ~ '^https://[^/?#]+/[^?#]*$' AND metadata_digest IS NOT NULL AND metadata_fetched_at IS NOT NULL AND metadata_expires_at IS NOT NULL
    ELSE client_id ~ '^[A-Za-z0-9_.:-]{8,200}$' AND metadata_digest IS NULL END),
  CONSTRAINT oauth_client_keys CHECK ((token_endpoint_auth_method = 'private_key_jwt') = (jwks IS NOT NULL)),
  -- Metadata documents and dynamic registrations are public clients in this release; only pre-registration is confidential.
  CONSTRAINT oauth_client_public_unless_registered CHECK (registration = 'pre_registered' OR token_endpoint_auth_method = 'none'),
  CONSTRAINT oauth_client_company_only_registered CHECK (company_id IS NULL OR registration = 'pre_registered'),
  CONSTRAINT oauth_client_disabled_shape CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
);
CREATE INDEX oauth_client_dynamic_idx ON trustwork.oauth_client (created_at) WHERE registration = 'dynamic_registration';

-- 3. Consents ------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.connection_consent (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  client_ref uuid NOT NULL REFERENCES trustwork.oauth_client (id),
  client_id text NOT NULL,
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 500),
  surface text NOT NULL CHECK (surface IN ('participant', 'admin')),
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1 AND trustwork.connections_distinct(scopes)),
  private_data_classes text[] NOT NULL DEFAULT '{}' CHECK (private_data_classes <@ trustwork.connections_private_classes() AND trustwork.connections_distinct(private_data_classes)),
  -- One acknowledgement of the residency warning per private class: [{"dataClass": ..., "acknowledgedAt": ...}].
  private_class_acknowledgements jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(private_class_acknowledgements) = 'array'),
  toolsets text[] NOT NULL DEFAULT '{}' CHECK (toolsets <@ trustwork.connections_toolsets() AND trustwork.connections_distinct(toolsets)),
  -- [{"mandateId": uuid, "revision": int}], each an active mandate of the person confirmed on the site.
  mandate_bindings jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(mandate_bindings) = 'array' AND jsonb_array_length(mandate_bindings) <= 50),
  consent_text_version integer NOT NULL CHECK (consent_text_version >= 1),
  step_up boolean NOT NULL CHECK (step_up),
  elevation_id uuid NULL REFERENCES trustwork.session_elevation (id),
  locale text NOT NULL CHECK (length(locale) BETWEEN 2 AND 35),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  withdrawn_at timestamptz NULL,
  withdrawn_reason text NULL CHECK (withdrawn_reason IN ('superseded', 'person_revocation', 'refresh_reuse_pending', 'expired')),
  CONSTRAINT connection_consent_lifetime CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '366 days'),
  CONSTRAINT connection_consent_withdrawal_shape CHECK ((withdrawn_at IS NULL) = (withdrawn_reason IS NULL)),
  CONSTRAINT connection_consent_scope_vocabulary CHECK (CASE surface
    WHEN 'participant' THEN scopes <@ trustwork.connections_participant_scopes() AND cardinality(toolsets) >= 1
    ELSE scopes <@ trustwork.connections_staff_scopes() AND cardinality(toolsets) = 0 AND cardinality(private_data_classes) = 0 AND jsonb_array_length(mandate_bindings) = 0 END),
  -- The staff member consents in an elevated session; participants never through one.
  CONSTRAINT connection_consent_staff_elevated CHECK ((surface = 'admin') = (elevation_id IS NOT NULL)),
  CONSTRAINT connection_consent_private_per_class CHECK (('read.private' = ANY (scopes)) = (cardinality(private_data_classes) > 0)),
  CONSTRAINT connection_consent_act_bound CHECK (('act' = ANY (scopes)) = (jsonb_array_length(mandate_bindings) > 0))
);
CREATE UNIQUE INDEX connection_consent_live ON trustwork.connection_consent (person_id, client_id, redirect_uri, surface) WHERE withdrawn_at IS NULL;
CREATE INDEX connection_consent_person_idx ON trustwork.connection_consent (person_id, granted_at);

-- 4. Connections ---------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.connection (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NULL,
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  protocol text NOT NULL DEFAULT 'mcp' CHECK (protocol = 'mcp'),
  surface text NOT NULL CHECK (surface IN ('participant', 'admin')),
  client_ref uuid NOT NULL REFERENCES trustwork.oauth_client (id),
  client_id text NOT NULL,
  -- The token audience: exactly one surface's canonical URI.
  resource text NOT NULL CHECK (resource ~ '^https?://[^/?#]+/mcp(/admin)?$'),
  redirect_uri text NOT NULL,
  consent_id uuid NOT NULL REFERENCES trustwork.connection_consent (id),
  rate_limit_profile text NOT NULL DEFAULT 'standard' CHECK (rate_limit_profile ~ '^[a-z][a-z0-9_]{1,40}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  status_reason text NULL CHECK (status_reason IN ('refresh_reuse', 'person_revocation', 'consent_expired', 'client_disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NULL,
  revoked_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CONSTRAINT connection_revoked_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT connection_reason_shape CHECK ((status = 'active') = (status_reason IS NULL)),
  CONSTRAINT connection_resource_surface CHECK ((surface = 'admin') = (resource ~ '/mcp/admin$'))
);
CREATE UNIQUE INDEX connection_live ON trustwork.connection (person_id, client_id, redirect_uri, surface) WHERE status <> 'revoked';
CREATE INDEX connection_person_idx ON trustwork.connection (person_id, status);

-- 5. Authorization codes -------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.oauth_authorization_code (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  connection_id uuid NOT NULL REFERENCES trustwork.connection (id),
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  -- RFC 7636 S256 only: BASE64URL(SHA-256(code_verifier)), 43 characters.
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource text NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
  dpop_jkt text NULL CHECK (dpop_jkt IS NULL OR dpop_jkt ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  CONSTRAINT oauth_authorization_code_short CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX oauth_authorization_code_connection_idx ON trustwork.oauth_authorization_code (connection_id);

-- 6. Token families and tokens -------------------------------------------------------------------------------------------
CREATE TABLE trustwork.connection_token_family (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  connection_id uuid NOT NULL REFERENCES trustwork.connection (id),
  code_id uuid NOT NULL UNIQUE REFERENCES trustwork.oauth_authorization_code (id),
  audience text NOT NULL,
  -- RFC 9449: the JWK thumbprint every token of the family is bound to (NULL: bearer tokens).
  dpop_jkt text NULL CHECK (dpop_jkt IS NULL OR dpop_jkt ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  revoked_reason text NULL CHECK (revoked_reason IN ('refresh_reuse', 'code_replay', 'client_revocation', 'person_revocation', 'credential_change', 'consent_superseded')),
  CONSTRAINT connection_token_family_revocation_shape CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT connection_token_family_lifetime CHECK (absolute_expires_at > created_at AND absolute_expires_at <= created_at + interval '365 days')
);
CREATE INDEX connection_token_family_connection_idx ON trustwork.connection_token_family (connection_id) WHERE revoked_at IS NULL;

CREATE TABLE trustwork.connection_token (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  family_id uuid NOT NULL REFERENCES trustwork.connection_token_family (id),
  connection_id uuid NOT NULL REFERENCES trustwork.connection (id),
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  audience text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  rotated_from_id uuid NULL REFERENCES trustwork.connection_token (id),
  -- A refresh token is used exactly once (rotation); a second presentation is reuse.
  used_at timestamptz NULL,
  revoked_at timestamptz NULL,
  CONSTRAINT connection_token_lifetime CHECK (expires_at > issued_at AND (kind = 'refresh' OR expires_at <= issued_at + interval '15 minutes')),
  CONSTRAINT connection_token_used_only_refresh CHECK (used_at IS NULL OR kind = 'refresh')
);
CREATE INDEX connection_token_family_idx ON trustwork.connection_token (family_id);

-- 7. Calls and confirmation challenges (rows written by MCP-003 and MCP-005) -----------------------------------------
CREATE TABLE trustwork.connection_call (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  connection_id uuid NOT NULL REFERENCES trustwork.connection (id),
  token_family_id uuid NOT NULL REFERENCES trustwork.connection_token_family (id),
  capability_id text NOT NULL CHECK (capability_id ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' AND length(capability_id) <= 100),
  args_digest text NOT NULL CHECK (args_digest ~ '^sha256:[a-f0-9]{64}$'),
  result_code text NOT NULL CHECK (result_code ~ '^[a-z][a-z0-9_.]{1,79}$'),
  mandate_ref jsonb NULL CHECK (mandate_ref IS NULL OR jsonb_typeof(mandate_ref) = 'object'),
  action_intent_id uuid NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connection_call_connection_idx ON trustwork.connection_call (connection_id, at);

CREATE TABLE trustwork.connection_confirmation_challenge (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22,64}$'),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  connection_id uuid NOT NULL REFERENCES trustwork.connection (id),
  capability_id text NOT NULL CHECK (capability_id ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' AND length(capability_id) <= 100),
  capability_version integer NOT NULL CHECK (capability_version >= 1),
  action_intent_id uuid NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^sha256:[a-f0-9]{64}$'),
  mandate_ref jsonb NULL CHECK (mandate_ref IS NULL OR jsonb_typeof(mandate_ref) = 'object'),
  confirmation text NOT NULL CHECK (confirmation IN ('mandate', 'person_each', 'person_each_step_up')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'expired', 'consumed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz NULL,
  consumed_at timestamptz NULL,
  CONSTRAINT connection_confirmation_challenge_short CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CONSTRAINT connection_confirmation_challenge_shape CHECK (CASE status
    WHEN 'pending' THEN decided_at IS NULL AND consumed_at IS NULL
    WHEN 'confirmed' THEN decided_at IS NOT NULL AND consumed_at IS NULL
    WHEN 'declined' THEN decided_at IS NOT NULL AND consumed_at IS NULL
    WHEN 'consumed' THEN decided_at IS NOT NULL AND consumed_at IS NOT NULL
    ELSE consumed_at IS NULL END)
);
CREATE INDEX connection_confirmation_challenge_person_idx ON trustwork.connection_confirmation_challenge (person_id, status);

-- The contract's transition table (confirmationTransitionAllowed): pending -> confirmed|declined|expired,
-- confirmed -> consumed|expired; the binding columns never change.
CREATE FUNCTION trustwork.connections_challenge_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.person_id <> OLD.person_id OR NEW.connection_id <> OLD.connection_id OR NEW.capability_id <> OLD.capability_id
     OR NEW.capability_version <> OLD.capability_version OR NEW.action_intent_id <> OLD.action_intent_id OR NEW.action_digest <> OLD.action_digest
     OR NEW.mandate_ref IS DISTINCT FROM OLD.mandate_ref OR NEW.confirmation <> OLD.confirmation OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'a confirmation challenge binding is immutable' USING ERRCODE = '23514', HINT = 'connections.challenge_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('confirmed', 'declined', 'expired'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('consumed', 'expired'))) THEN
    RAISE EXCEPTION 'invalid confirmation challenge transition' USING ERRCODE = '23514', HINT = 'connections.challenge_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_confirmation_challenge_guard BEFORE UPDATE ON trustwork.connection_confirmation_challenge
  FOR EACH ROW EXECUTE FUNCTION trustwork.connections_challenge_guard();

-- Audit rows of calls are append-only.
CREATE TRIGGER connection_call_append_only BEFORE UPDATE OR DELETE ON trustwork.connection_call FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 8. Internal helpers (not definers; called inside the commands) ----------------------------------------------------------
-- A person held by a jurisdiction check or suspended by a confirmed screening match gets no code and no token. The
-- suspension is read through the screening module's own gate port (screening_state), never from its tables.
CREATE FUNCTION trustwork.connections_person_blocked(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.jurisdiction_hold h WHERE h.person_id = p_person AND h.cleared_at IS NULL)
      OR coalesce((SELECT s.suspended FROM trustwork.screening_state('person', p_person) s), false)
$$;

CREATE FUNCTION trustwork.connections_revoke_families(p_connection uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE trustwork.connection_token_family SET revoked_at = now(), revoked_reason = p_reason WHERE connection_id = p_connection AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE trustwork.connection_token SET revoked_at = now() WHERE connection_id = p_connection AND revoked_at IS NULL;
  RETURN v_count;
END $$;

CREATE FUNCTION trustwork.connections_revoke_family(p_family uuid, p_reason text) RETURNS void
LANGUAGE sql SET search_path = trustwork, pg_temp AS $$
  UPDATE trustwork.connection_token_family SET revoked_at = now(), revoked_reason = p_reason WHERE id = p_family AND revoked_at IS NULL;
  UPDATE trustwork.connection_token SET revoked_at = now() WHERE family_id = p_family AND revoked_at IS NULL;
$$;

-- The live grant behind a connection: active connection, live consent, enabled client, person not blocked.
CREATE FUNCTION trustwork.connections_grant_live(p_connection uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.connection c
    JOIN trustwork.connection_consent k ON k.id = c.consent_id
    JOIN trustwork.oauth_client o ON o.id = c.client_ref
    WHERE c.id = p_connection AND c.status = 'active' AND k.withdrawn_at IS NULL AND k.expires_at > now() AND o.disabled_at IS NULL
      AND NOT trustwork.connections_person_blocked(c.person_id))
$$;

-- Issues one access token and one refresh token for a family (hashes computed by the API from fresh 256-bit values).
CREATE FUNCTION trustwork.connections_issue_pair(p_family trustwork.connection_token_family, p_access_hash bytea, p_refresh_hash bytea,
  p_access_ttl_seconds integer, p_refresh_idle_seconds integer, p_rotated_from uuid)
RETURNS TABLE (access_expires_at timestamptz, refresh_expires_at timestamptz)
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_access timestamptz := now() + make_interval(secs => p_access_ttl_seconds);
  v_refresh timestamptz := least(now() + make_interval(secs => p_refresh_idle_seconds), p_family.absolute_expires_at);
BEGIN
  IF p_access_ttl_seconds NOT BETWEEN 60 AND 900 OR p_refresh_idle_seconds NOT BETWEEN 3600 AND 31536000 THEN
    RAISE EXCEPTION 'token lifetimes outside the engine bounds' USING ERRCODE = 'invalid_parameter_value', HINT = 'connections.lifetime_bounds';
  END IF;
  INSERT INTO trustwork.connection_token (family_id, connection_id, kind, token_hash, audience, expires_at, rotated_from_id)
  VALUES (p_family.id, p_family.connection_id, 'access', p_access_hash, p_family.audience, least(v_access, p_family.absolute_expires_at), NULL),
         (p_family.id, p_family.connection_id, 'refresh', p_refresh_hash, p_family.audience, v_refresh, p_rotated_from);
  RETURN QUERY SELECT least(v_access, p_family.absolute_expires_at), v_refresh;
END $$;

-- 9. Pre-identity commands ------------------------------------------------------------------------------------------------
-- An enabled client registration by client id (public metadata only).
CREATE FUNCTION trustwork.oauth_client_get(p_client_id text)
RETURNS TABLE (id uuid, client_id text, registration text, client_name text, client_uri text, redirect_uris text[], application_type text,
  token_endpoint_auth_method text, jwks jsonb, company_id uuid, metadata_expires_at timestamptz, disabled boolean)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT o.id, o.client_id, o.registration, o.client_name, o.client_uri, o.redirect_uris, o.application_type, o.token_endpoint_auth_method, o.jwks, o.company_id,
         o.metadata_expires_at, o.disabled_at IS NOT NULL
  FROM trustwork.oauth_client o WHERE o.client_id = p_client_id
$$;

-- Stores (or refreshes) a validated Client ID Metadata Document fetched by the API through the egress guard. A client id
-- registered another way, or disabled, is never overwritten.
CREATE FUNCTION trustwork.oauth_client_store_metadata(p_client_id text, p_client_name text, p_client_uri text, p_redirect_uris text[],
  p_application_type text, p_digest text, p_expires_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.oauth_client%ROWTYPE;
BEGIN
  IF p_expires_at <= now() OR p_expires_at > now() + interval '1 day' THEN
    RAISE EXCEPTION 'metadata cache lifetime outside bounds' USING ERRCODE = 'invalid_parameter_value', HINT = 'connections.metadata_cache';
  END IF;
  SELECT * INTO v_row FROM trustwork.oauth_client WHERE client_id = p_client_id FOR UPDATE;
  IF FOUND THEN
    IF v_row.registration <> 'client_id_metadata_document' OR v_row.disabled_at IS NOT NULL THEN
      RAISE EXCEPTION 'client registration cannot be replaced' USING ERRCODE = 'insufficient_privilege', HINT = 'connections.client_locked';
    END IF;
    UPDATE trustwork.oauth_client
       SET client_name = p_client_name, client_uri = p_client_uri, redirect_uris = p_redirect_uris, application_type = p_application_type,
           metadata_digest = p_digest, metadata_fetched_at = now(), metadata_expires_at = p_expires_at, updated_at = now()
     WHERE id = v_row.id;
    RETURN v_row.id;
  END IF;
  INSERT INTO trustwork.oauth_client (client_id, registration, client_name, client_uri, redirect_uris, application_type, token_endpoint_auth_method,
    metadata_digest, metadata_fetched_at, metadata_expires_at)
  VALUES (p_client_id, 'client_id_metadata_document', p_client_name, p_client_uri, p_redirect_uris, p_application_type, 'none', p_digest, now(), p_expires_at)
  RETURNING id INTO v_row.id;
  RETURN v_row.id;
END $$;

-- Deprecated dynamic client registration (RFC 7591) behind the hub switch: public clients only. Registrations unused
-- for 30 days and never connected are deleted on the way (their codes and connections cannot exist).
CREATE FUNCTION trustwork.oauth_client_register_dynamic(p_client_id text, p_client_name text, p_client_uri text, p_redirect_uris text[], p_application_type text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_id uuid;
BEGIN
  DELETE FROM trustwork.oauth_client o
   WHERE o.registration = 'dynamic_registration' AND coalesce(o.last_used_at, o.created_at) < now() - interval '30 days'
     AND NOT EXISTS (SELECT 1 FROM trustwork.connection c WHERE c.client_ref = o.id)
     AND NOT EXISTS (SELECT 1 FROM trustwork.connection_consent k WHERE k.client_ref = o.id);
  INSERT INTO trustwork.oauth_client (client_id, registration, client_name, client_uri, redirect_uris, application_type, token_endpoint_auth_method)
  VALUES (p_client_id, 'dynamic_registration', p_client_name, p_client_uri, p_redirect_uris, p_application_type, 'none')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Redeems an authorization code once. The API computed `p_challenge` = BASE64URL(SHA-256(code_verifier)) from the
-- presented verifier (NULL when none was presented). Any failed redemption consumes the code; a second presentation
-- of a consumed code revokes every token issued from it (RFC 6749 section 4.1.2). Concurrent redemptions serialise on
-- the code row: exactly one issues tokens.
CREATE FUNCTION trustwork.oauth_code_redeem(p_code_hash bytea, p_client_id text, p_redirect_uri text, p_resource text, p_challenge text, p_dpop_jkt text,
  p_access_hash bytea, p_refresh_hash bytea, p_access_ttl_seconds integer, p_refresh_idle_seconds integer, p_refresh_absolute_seconds integer)
RETURNS TABLE (outcome text, connection_id uuid, family_id uuid, person_id uuid, audience text, scopes text[], dpop_jkt text,
  access_expires_at timestamptz, refresh_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
#variable_conflict use_column
DECLARE
  v_code trustwork.oauth_authorization_code%ROWTYPE;
  v_conn trustwork.connection%ROWTYPE;
  v_family trustwork.connection_token_family%ROWTYPE;
  v_scopes text[];
  v_pair record;
BEGIN
  IF p_code_hash IS NULL OR octet_length(p_code_hash) <> 32 THEN
    RETURN QUERY SELECT 'invalid_grant'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO v_code FROM trustwork.oauth_authorization_code c WHERE c.code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_grant'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_code.consumed_at IS NOT NULL THEN
    -- Replay: whatever was issued from this code stops working now.
    PERFORM trustwork.connections_revoke_family(f.id, 'code_replay') FROM trustwork.connection_token_family f WHERE f.code_id = v_code.id;
    RETURN QUERY SELECT 'code_replay'::text, v_code.connection_id, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  UPDATE trustwork.oauth_authorization_code SET consumed_at = now() WHERE id = v_code.id;
  IF v_code.expires_at <= now() OR v_code.client_id <> p_client_id OR v_code.redirect_uri <> p_redirect_uri OR v_code.resource <> p_resource THEN
    RETURN QUERY SELECT 'invalid_grant'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_challenge IS NULL OR p_challenge <> v_code.code_challenge THEN
    RETURN QUERY SELECT 'invalid_verifier'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_code.dpop_jkt IS NOT NULL AND v_code.dpop_jkt IS DISTINCT FROM p_dpop_jkt THEN
    RETURN QUERY SELECT 'invalid_dpop'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO v_conn FROM trustwork.connection c WHERE c.id = v_code.connection_id FOR UPDATE;
  IF NOT trustwork.connections_grant_live(v_conn.id) THEN
    RETURN QUERY SELECT 'access_denied'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT k.scopes INTO v_scopes FROM trustwork.connection_consent k WHERE k.id = v_conn.consent_id;
  IF p_refresh_absolute_seconds NOT BETWEEN 86400 AND 31536000 THEN
    RAISE EXCEPTION 'refresh lifetime outside the engine bounds' USING ERRCODE = 'invalid_parameter_value', HINT = 'connections.lifetime_bounds';
  END IF;
  INSERT INTO trustwork.connection_token_family (connection_id, code_id, audience, dpop_jkt, absolute_expires_at)
  VALUES (v_conn.id, v_code.id, v_code.resource, p_dpop_jkt, now() + make_interval(secs => p_refresh_absolute_seconds))
  RETURNING * INTO v_family;
  SELECT * INTO v_pair FROM trustwork.connections_issue_pair(v_family, p_access_hash, p_refresh_hash, p_access_ttl_seconds, p_refresh_idle_seconds, NULL);
  UPDATE trustwork.connection SET last_used_at = now() WHERE id = v_conn.id;
  UPDATE trustwork.oauth_client SET last_used_at = now() WHERE id = v_conn.client_ref;
  RETURN QUERY SELECT 'issued'::text, v_conn.id, v_family.id, v_conn.person_id, v_family.audience, v_scopes, v_family.dpop_jkt, v_pair.access_expires_at, v_pair.refresh_expires_at;
END $$;

-- Rotates a refresh token. A refresh token presented a second time (already rotated) is reuse: the whole family is
-- revoked and the connection suspended until the person allows it again on the site.
CREATE FUNCTION trustwork.oauth_refresh_rotate(p_refresh_hash bytea, p_client_id text, p_resource text, p_dpop_jkt text,
  p_access_hash bytea, p_refresh_hash_new bytea, p_access_ttl_seconds integer, p_refresh_idle_seconds integer)
RETURNS TABLE (outcome text, connection_id uuid, family_id uuid, person_id uuid, audience text, scopes text[], dpop_jkt text,
  access_expires_at timestamptz, refresh_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
#variable_conflict use_column
DECLARE
  v_token trustwork.connection_token%ROWTYPE;
  v_family trustwork.connection_token_family%ROWTYPE;
  v_conn trustwork.connection%ROWTYPE;
  v_scopes text[];
  v_pair record;
BEGIN
  IF p_refresh_hash IS NULL OR octet_length(p_refresh_hash) <> 32 THEN
    RETURN QUERY SELECT 'invalid_grant'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO v_token FROM trustwork.connection_token t WHERE t.token_hash = p_refresh_hash AND t.kind = 'refresh' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_grant'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO v_family FROM trustwork.connection_token_family f WHERE f.id = v_token.family_id FOR UPDATE;
  SELECT * INTO v_conn FROM trustwork.connection c WHERE c.id = v_token.connection_id FOR UPDATE;
  IF v_conn.client_id <> p_client_id THEN
    RETURN QUERY SELECT 'invalid_grant'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_token.used_at IS NOT NULL THEN
    PERFORM trustwork.connections_revoke_family(v_family.id, 'refresh_reuse');
    IF v_conn.status = 'active' THEN
      UPDATE trustwork.connection SET status = 'suspended', status_reason = 'refresh_reuse', updated_at = now(), revision = revision + 1 WHERE id = v_conn.id;
    END IF;
    RETURN QUERY SELECT 'reuse_detected'::text, v_conn.id, v_family.id, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_token.revoked_at IS NOT NULL OR v_family.revoked_at IS NOT NULL OR v_token.expires_at <= now() OR v_family.absolute_expires_at <= now()
     OR (p_resource IS NOT NULL AND p_resource <> v_family.audience) THEN
    RETURN QUERY SELECT 'invalid_grant'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_family.dpop_jkt IS DISTINCT FROM p_dpop_jkt THEN
    RETURN QUERY SELECT 'invalid_dpop'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF NOT trustwork.connections_grant_live(v_conn.id) THEN
    RETURN QUERY SELECT 'access_denied'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text[], NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  UPDATE trustwork.connection_token SET used_at = now() WHERE id = v_token.id;
  -- The access tokens issued before this rotation end with it: one live access token per family.
  UPDATE trustwork.connection_token SET revoked_at = now() WHERE family_id = v_family.id AND kind = 'access' AND revoked_at IS NULL;
  SELECT k.scopes INTO v_scopes FROM trustwork.connection_consent k WHERE k.id = v_conn.consent_id;
  SELECT * INTO v_pair FROM trustwork.connections_issue_pair(v_family, p_access_hash, p_refresh_hash_new, p_access_ttl_seconds, p_refresh_idle_seconds, v_token.id);
  UPDATE trustwork.connection SET last_used_at = now() WHERE id = v_conn.id;
  RETURN QUERY SELECT 'issued'::text, v_conn.id, v_family.id, v_conn.person_id, v_family.audience, v_scopes, v_family.dpop_jkt, v_pair.access_expires_at, v_pair.refresh_expires_at;
END $$;

-- RFC 7009: the client revokes one of its own tokens. A refresh token ends its family; an access token ends itself.
-- Unknown tokens and tokens of another client change nothing (the endpoint answers 200 either way).
CREATE FUNCTION trustwork.oauth_token_revoke(p_token_hash bytea, p_client_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_token trustwork.connection_token%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RETURN false;
  END IF;
  SELECT t.* INTO v_token FROM trustwork.connection_token t JOIN trustwork.connection c ON c.id = t.connection_id
   WHERE t.token_hash = p_token_hash AND c.client_id = p_client_id FOR UPDATE OF t;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_token.kind = 'refresh' THEN
    PERFORM trustwork.connections_revoke_family(v_token.family_id, 'client_revocation');
  ELSE
    UPDATE trustwork.connection_token SET revoked_at = now() WHERE id = v_token.id AND revoked_at IS NULL;
  END IF;
  RETURN true;
END $$;

-- The resource server's check of a presented access token for one audience. Returns no row unless the token is a live
-- access token for exactly this audience, its family and connection are live, the consent is in force, the client is
-- enabled and the person is neither held nor suspended. The grant comes from the live consent, not from the token.
CREATE FUNCTION trustwork.connection_token_introspect(p_token_hash bytea, p_audience text)
RETURNS TABLE (connection_id uuid, family_id uuid, person_id uuid, surface text, client_id text, scopes text[], toolsets text[], private_data_classes text[],
  mandate_bindings jsonb, dpop_jkt text, expires_at timestamptz, hub_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT c.id, f.id, c.person_id, c.surface, c.client_id, k.scopes, k.toolsets, k.private_data_classes, k.mandate_bindings, f.dpop_jkt, t.expires_at, c.hub_id
  FROM trustwork.connection_token t
  JOIN trustwork.connection_token_family f ON f.id = t.family_id
  JOIN trustwork.connection c ON c.id = t.connection_id
  JOIN trustwork.connection_consent k ON k.id = c.consent_id
  WHERE p_token_hash IS NOT NULL AND octet_length(p_token_hash) = 32
    AND t.token_hash = p_token_hash AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now()
    AND t.audience = p_audience AND f.audience = p_audience AND c.resource = p_audience
    AND f.revoked_at IS NULL AND f.absolute_expires_at > now()
    AND trustwork.connections_grant_live(c.id)
$$;

-- 10. Commands under the person's principal -------------------------------------------------------------------------------
-- Records the person's consent (given on the hub's own page after step-up; staff in an elevated session) for one client,
-- redirect URI and surface, and returns the live connection. A previous consent for the same key is superseded (kept as
-- history); a suspended connection becomes active again because the person allowed it again on the site.
CREATE FUNCTION trustwork.connection_consent_grant(p_client_id text, p_redirect_uri text, p_surface text, p_resource text, p_scopes text[],
  p_private_classes text[], p_toolsets text[], p_mandate_bindings jsonb, p_text_version integer, p_step_up boolean, p_elevation uuid,
  p_locale text, p_expires_at timestamptz, p_hub uuid)
RETURNS TABLE (connection_id uuid, consent_id uuid)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
#variable_conflict use_column
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_client trustwork.oauth_client%ROWTYPE;
  v_binding jsonb;
  v_consent uuid;
  v_conn trustwork.connection%ROWTYPE;
  v_acks jsonb;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'a verified identity is required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF NOT coalesce(p_step_up, false) THEN
    RAISE EXCEPTION 'consent to a connection requires step-up' USING ERRCODE = 'insufficient_privilege', HINT = 'connections.step_up_required';
  END IF;
  IF trustwork.connections_person_blocked(v_person) THEN
    RAISE EXCEPTION 'the account cannot connect clients now' USING ERRCODE = 'insufficient_privilege', HINT = 'connections.person_blocked';
  END IF;
  SELECT * INTO v_client FROM trustwork.oauth_client WHERE client_id = p_client_id;
  IF NOT FOUND OR v_client.disabled_at IS NOT NULL OR NOT (p_redirect_uri = ANY (v_client.redirect_uris)) THEN
    RAISE EXCEPTION 'unknown client or redirect URI' USING ERRCODE = 'invalid_parameter_value', HINT = 'connections.client_invalid';
  END IF;
  IF p_surface = 'admin' THEN
    IF p_elevation IS NULL OR NOT EXISTS (
      SELECT 1 FROM trustwork.session_elevation e JOIN trustwork.session s ON s.id = e.session_id
      WHERE e.id = p_elevation AND e.person_id = v_person AND e.revoked_at IS NULL AND e.expires_at > now() AND s.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'staff consent requires a live elevated session' USING ERRCODE = 'insufficient_privilege', HINT = 'connections.elevation_required';
    END IF;
  ELSIF p_elevation IS NOT NULL THEN
    RAISE EXCEPTION 'participant consent is not tied to an elevation' USING ERRCODE = 'invalid_parameter_value', HINT = 'connections.elevation_unexpected';
  END IF;
  -- Every binding names an active mandate the person gave their own agent, at its current revision.
  FOR v_binding IN SELECT * FROM jsonb_array_elements(coalesce(p_mandate_bindings, '[]'::jsonb)) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM trustwork.mandate m
      WHERE m.id = (v_binding ->> 'mandateId')::uuid AND m.revision = (v_binding ->> 'revision')::integer AND m.principal_person_id = v_person
        AND m.grantee_kind = 'own_agent' AND m.status = 'active' AND m.valid_until > now()) THEN
      RAISE EXCEPTION 'a mandate binding does not name an active mandate of the person' USING ERRCODE = 'insufficient_privilege', HINT = 'connections.mandate_binding_invalid';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('dataClass', d, 'acknowledgedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY d), '[]'::jsonb)
    INTO v_acks FROM unnest(coalesce(p_private_classes, '{}'::text[])) AS d;
  UPDATE trustwork.connection_consent SET withdrawn_at = now(), withdrawn_reason = 'superseded'
   WHERE person_id = v_person AND client_id = p_client_id AND redirect_uri = p_redirect_uri AND surface = p_surface AND withdrawn_at IS NULL;
  INSERT INTO trustwork.connection_consent (person_id, client_ref, client_id, redirect_uri, surface, scopes, private_data_classes, private_class_acknowledgements, toolsets,
    mandate_bindings, consent_text_version, step_up, elevation_id, locale, expires_at)
  VALUES (v_person, v_client.id, p_client_id, p_redirect_uri, p_surface, p_scopes, coalesce(p_private_classes, '{}'), v_acks, coalesce(p_toolsets, '{}'),
    coalesce(p_mandate_bindings, '[]'), p_text_version, p_step_up, p_elevation, p_locale, p_expires_at)
  RETURNING id INTO v_consent;
  SELECT * INTO v_conn FROM trustwork.connection c
   WHERE c.person_id = v_person AND c.client_id = p_client_id AND c.redirect_uri = p_redirect_uri AND c.surface = p_surface AND c.status <> 'revoked' FOR UPDATE;
  IF FOUND THEN
    IF v_conn.resource <> p_resource THEN
      RAISE EXCEPTION 'the connection is bound to another resource' USING ERRCODE = 'invalid_parameter_value', HINT = 'connections.resource_mismatch';
    END IF;
    UPDATE trustwork.connection SET consent_id = v_consent, status = 'active', status_reason = NULL, updated_at = now(), revision = revision + 1, hub_id = p_hub
     WHERE id = v_conn.id;
  ELSE
    INSERT INTO trustwork.connection (hub_id, person_id, surface, client_ref, client_id, resource, redirect_uri, consent_id)
    VALUES (p_hub, v_person, p_surface, v_client.id, p_client_id, p_resource, p_redirect_uri, v_consent)
    RETURNING * INTO v_conn;
  END IF;
  RETURN QUERY SELECT v_conn.id, v_consent;
END $$;

-- Issues an authorization code for one of the caller's live connections (after a fresh consent, or a consent still in
-- force for this exact client, redirect URI and scopes).
CREATE FUNCTION trustwork.oauth_code_issue(p_connection uuid, p_code_hash bytea, p_redirect_uri text, p_code_challenge text, p_resource text, p_scopes text[],
  p_dpop_jkt text, p_ttl_seconds integer) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_conn trustwork.connection%ROWTYPE;
  v_expires timestamptz := now() + make_interval(secs => p_ttl_seconds);
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'a verified identity is required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_ttl_seconds NOT BETWEEN 10 AND 600 THEN
    RAISE EXCEPTION 'code lifetime outside bounds' USING ERRCODE = 'invalid_parameter_value', HINT = 'connections.lifetime_bounds';
  END IF;
  SELECT * INTO v_conn FROM trustwork.connection c WHERE c.id = p_connection AND c.person_id = v_person;
  IF NOT FOUND OR NOT trustwork.connections_redirect_matches(v_conn.redirect_uri, p_redirect_uri) OR v_conn.resource <> p_resource OR NOT trustwork.connections_grant_live(v_conn.id) THEN
    RAISE EXCEPTION 'no live connection for this request' USING ERRCODE = 'insufficient_privilege', HINT = 'connections.connection_not_live';
  END IF;
  IF NOT (p_scopes <@ (SELECT k.scopes FROM trustwork.connection_consent k WHERE k.id = v_conn.consent_id)) THEN
    RAISE EXCEPTION 'the requested scopes exceed the consent' USING ERRCODE = 'insufficient_privilege', HINT = 'connections.scope_exceeds_consent';
  END IF;
  INSERT INTO trustwork.oauth_authorization_code (code_hash, connection_id, client_id, redirect_uri, code_challenge, resource, scopes, dpop_jkt, expires_at)
  VALUES (p_code_hash, v_conn.id, v_conn.client_id, p_redirect_uri, p_code_challenge, p_resource, p_scopes, p_dpop_jkt, v_expires);
  RETURN v_expires;
END $$;

-- The person revokes one of their connections: it stops before the next call (consent withdrawn, every token revoked).
CREATE FUNCTION trustwork.connection_revoke(p_connection uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_conn trustwork.connection%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'a verified identity is required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_conn FROM trustwork.connection c WHERE c.id = p_connection AND c.person_id = v_person FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection not found' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_conn.status = 'revoked' THEN
    RETURN false;
  END IF;
  PERFORM trustwork.connections_revoke_families(v_conn.id, 'person_revocation');
  UPDATE trustwork.connection_consent SET withdrawn_at = now(), withdrawn_reason = 'person_revocation' WHERE id = v_conn.consent_id AND withdrawn_at IS NULL;
  UPDATE trustwork.connection SET status = 'revoked', status_reason = 'person_revocation', revoked_at = now(), updated_at = now(), revision = revision + 1 WHERE id = v_conn.id;
  RETURN true;
END $$;

-- Revokes every connection of the caller; returns how many were live.
CREATE FUNCTION trustwork.connection_revoke_all() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_id uuid;
  v_count integer := 0;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'a verified identity is required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  FOR v_id IN SELECT c.id FROM trustwork.connection c WHERE c.person_id = v_person AND c.status <> 'revoked' ORDER BY c.id FOR UPDATE LOOP
    PERFORM trustwork.connections_revoke_families(v_id, 'person_revocation');
    UPDATE trustwork.connection_consent SET withdrawn_at = now(), withdrawn_reason = 'person_revocation'
     WHERE id = (SELECT consent_id FROM trustwork.connection WHERE id = v_id) AND withdrawn_at IS NULL;
    UPDATE trustwork.connection SET status = 'revoked', status_reason = 'person_revocation', revoked_at = now(), updated_at = now(), revision = revision + 1 WHERE id = v_id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- 11. Password change and account recovery revoke every token of the person -------------------------------------------
-- Both paths write a new password hash (BE-002 changePassword, completeRecovery); the connections stay, so the client
-- asks the person to sign in again with the new password before it gets new tokens.
CREATE FUNCTION trustwork.connections_revoke_on_credential_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NEW.kind <> 'password' OR (TG_OP = 'UPDATE' AND NEW.password_hash IS NOT DISTINCT FROM OLD.password_hash) THEN
    RETURN NULL;
  END IF;
  FOR v_id IN SELECT c.id FROM trustwork.connection c WHERE c.person_id = NEW.person_id AND c.status <> 'revoked' LOOP
    PERFORM trustwork.connections_revoke_families(v_id, 'credential_change');
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER credential_revokes_connection_tokens AFTER INSERT OR UPDATE OF password_hash ON trustwork.credential
  FOR EACH ROW EXECUTE FUNCTION trustwork.connections_revoke_on_credential_change();

-- 12. Row-level security and grants ---------------------------------------------------------------------------------------
ALTER TABLE trustwork.oauth_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.oauth_client FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_consent FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.oauth_authorization_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.oauth_authorization_code FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_token_family ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_token_family FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_token FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_call FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_confirmation_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_confirmation_challenge FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.oauth_client AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.connection_consent AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.connection AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.oauth_authorization_code AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.connection_token_family AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.connection_token AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.connection_call AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.connection_confirmation_challenge AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- The person reads their own connections, consents, the clients behind them, their calls and their challenges (Settings
-- -> Connections, MCP-070). Codes, families and tokens are never readable by the runtime role.
CREATE POLICY connection_own_read ON trustwork.connection FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());
CREATE POLICY connection_consent_own_read ON trustwork.connection_consent FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());
CREATE POLICY oauth_client_connected_read ON trustwork.oauth_client FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.connection_consent k WHERE k.client_ref = oauth_client.id AND k.person_id = trustwork.current_person_id()));
CREATE POLICY connection_call_own_read ON trustwork.connection_call FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.connection c WHERE c.id = connection_call.connection_id AND c.person_id = trustwork.current_person_id()));
CREATE POLICY connection_confirmation_challenge_own_read ON trustwork.connection_confirmation_challenge FOR SELECT TO trustwork_app
  USING (person_id = trustwork.current_person_id());

GRANT SELECT ON trustwork.connection, trustwork.connection_consent, trustwork.oauth_client, trustwork.connection_call, trustwork.connection_confirmation_challenge TO trustwork_app;
-- No direct reads of the client's jwks or metadata bookkeeping beyond what the list needs.
REVOKE SELECT ON trustwork.oauth_client FROM trustwork_app;
GRANT SELECT (id, client_id, registration, client_name, client_uri, application_type, created_at) ON trustwork.oauth_client TO trustwork_app;

GRANT EXECUTE ON FUNCTION trustwork.oauth_client_get(text), trustwork.oauth_client_store_metadata(text, text, text, text[], text, text, timestamptz),
  trustwork.oauth_client_register_dynamic(text, text, text, text[], text),
  trustwork.oauth_code_redeem(bytea, text, text, text, text, text, bytea, bytea, integer, integer, integer),
  trustwork.oauth_refresh_rotate(bytea, text, text, text, bytea, bytea, integer, integer),
  trustwork.oauth_token_revoke(bytea, text), trustwork.connection_token_introspect(bytea, text),
  trustwork.connection_consent_grant(text, text, text, text, text[], text[], text[], jsonb, integer, boolean, uuid, text, timestamptz, uuid),
  trustwork.oauth_code_issue(uuid, bytea, text, text, text, text[], text, integer),
  trustwork.connection_revoke(uuid), trustwork.connection_revoke_all() TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
