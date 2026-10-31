-- DATA-001 identity tables: person, email_binding, credential, session, auth_token, login_failure.
-- All party tables are ENABLE + FORCE row level security. Pre-identity access (login, signup, verification,
-- recovery) goes only through the SECURITY DEFINER allowlist at the end of this file.

CREATE TABLE trustwork.person (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  profile_visibility text NOT NULL DEFAULT 'private' CHECK (profile_visibility IN ('private', 'public')),
  public_headline text NULL CHECK (public_headline IS NULL OR length(public_headline) <= 20000),
  public_expertise text[] NOT NULL DEFAULT '{}',
  prefers_buying boolean NOT NULL DEFAULT false,
  prefers_selling boolean NOT NULL DEFAULT false,
  prefers_industry_participation boolean NOT NULL DEFAULT false,
  authz_epoch integer NOT NULL DEFAULT 1 CHECK (authz_epoch >= 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER person_touch BEFORE UPDATE ON trustwork.person FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.email_binding (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  email_normalized text NOT NULL UNIQUE CHECK (email_normalized = lower(email_normalized) AND length(email_normalized) BETWEEN 3 AND 254),
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_binding_person_idx ON trustwork.email_binding (person_id);
-- One primary binding per person.
CREATE UNIQUE INDEX email_binding_one_primary ON trustwork.email_binding (person_id) WHERE is_primary;

CREATE TABLE trustwork.credential (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  kind text NOT NULL CHECK (kind IN ('password', 'google', 'apple', 'totp', 'webauthn', 'recovery_code')),
  provider text NULL CHECK (provider IN ('google', 'apple')),
  provider_subject text NULL CHECK (provider_subject IS NULL OR length(provider_subject) BETWEEN 1 AND 255),
  password_hash text NULL,
  disabled_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_shape CHECK (
    (kind = 'password' AND password_hash IS NOT NULL AND provider IS NULL AND provider_subject IS NULL)
    OR (kind IN ('google', 'apple') AND provider = kind AND provider_subject IS NOT NULL AND password_hash IS NULL)
    OR (kind IN ('totp', 'webauthn', 'recovery_code') AND provider IS NULL AND provider_subject IS NULL AND password_hash IS NULL)
  )
);
CREATE INDEX credential_person_idx ON trustwork.credential (person_id);
-- Provider identity is (provider, subject), never the e-mail.
CREATE UNIQUE INDEX credential_provider_subject ON trustwork.credential (provider, provider_subject) WHERE provider IS NOT NULL;
-- One password credential per person.
CREATE UNIQUE INDEX credential_one_password ON trustwork.credential (person_id) WHERE kind = 'password';
CREATE TRIGGER credential_touch BEFORE UPDATE ON trustwork.credential FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.session (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  auth_method text NOT NULL CHECK (auth_method IN ('password', 'google', 'apple', 'recovery')),
  user_agent_family text NOT NULL DEFAULT '' CHECK (length(user_agent_family) <= 100),
  ip_prefix text NOT NULL DEFAULT '' CHECK (length(ip_prefix) <= 64),
  revoked_at timestamptz NULL,
  revoked_reason text NULL CHECK (revoked_reason IN ('logout', 'logout_all', 'password_change', 'recovery', 'admin', 'expired', 'suspicious')),
  CONSTRAINT session_expiry_order CHECK (idle_expires_at <= absolute_expires_at),
  CONSTRAINT session_revocation_shape CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX session_person_idx ON trustwork.session (person_id);

CREATE TABLE trustwork.auth_token (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  kind text NOT NULL CHECK (kind IN ('verify_email', 'email_change', 'recovery')),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  email_normalized text NOT NULL CHECK (email_normalized = lower(email_normalized)),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL
);
CREATE INDEX auth_token_person_idx ON trustwork.auth_token (person_id);

-- Bounded by expires_at: the maintenance sweeper deletes expired rows; the runtime role never reads it directly.
CREATE TABLE trustwork.login_failure (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_hash bytea NOT NULL CHECK (octet_length(subject_hash) = 32),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX login_failure_subject_idx ON trustwork.login_failure (subject_hash, occurred_at);

-- Row level security: enabled and forced on every identity table.
ALTER TABLE trustwork.person ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.person FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.email_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.email_binding FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.credential FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.session FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.auth_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.auth_token FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.login_failure ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.login_failure FORCE ROW LEVEL SECURITY;

-- Maintenance policies: the owner sees rows only with the transaction-local maintenance flag.
CREATE POLICY maintenance_all ON trustwork.person AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.email_binding AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.credential AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.session AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.auth_token AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.login_failure AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Runtime policies keyed on the trusted principal. No INSERT policy on person or credential rows of other people.
CREATE POLICY person_self_or_public ON trustwork.person FOR SELECT TO trustwork_app
  USING (trustwork.current_person_id() IS NOT NULL AND (id = trustwork.current_person_id() OR profile_visibility = 'public'));
CREATE POLICY person_self_update ON trustwork.person FOR UPDATE TO trustwork_app
  USING (id = trustwork.current_person_id()) WITH CHECK (id = trustwork.current_person_id());

CREATE POLICY email_binding_self ON trustwork.email_binding FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY credential_self ON trustwork.credential FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY session_self ON trustwork.session FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY auth_token_self ON trustwork.auth_token FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
-- login_failure: no runtime policy at all; writes and counts go through auth_record_login_failure.

-- Privileges. No DELETE and no TRUNCATE for the runtime role anywhere; the password hash column is never
-- selectable directly (auth_lookup_password_credential returns it for the login flow only).
GRANT SELECT, UPDATE (display_name, profile_visibility, public_headline, public_expertise, prefers_buying, prefers_selling, prefers_industry_participation) ON trustwork.person TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (is_primary, verified_at) ON trustwork.email_binding TO trustwork_app;
GRANT SELECT (id, person_id, kind, provider, provider_subject, disabled_at, revision, created_at, updated_at), INSERT, UPDATE (password_hash, disabled_at) ON trustwork.credential TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (last_seen_at, idle_expires_at, authenticated_at, revoked_at, revoked_reason) ON trustwork.session TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (consumed_at) ON trustwork.auth_token TO trustwork_app;

-- The trusted setter trustwork.set_principal lives in the company/access migration (it resolves the active membership).

-- Pre-identity allowlist. Each takes hashes, never raw tokens, and returns minimal columns.
CREATE FUNCTION trustwork.auth_lookup_session(p_token_hash bytea)
RETURNS TABLE (session_id uuid, person_id uuid, authz_epoch integer, idle_expires_at timestamptz, absolute_expires_at timestamptz, authenticated_at timestamptz, auth_method text, revoked_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT s.id, s.person_id, p.authz_epoch, s.idle_expires_at, s.absolute_expires_at, s.authenticated_at, s.auth_method, s.revoked_at
  FROM trustwork.session s JOIN trustwork.person p ON p.id = s.person_id
  WHERE s.token_hash = p_token_hash
$$;

-- Always returns exactly one row: unknown or disabled e-mails get person_id NULL and a deterministic dummy hash
-- so the caller performs one password verification regardless (no error-based enumeration).
CREATE FUNCTION trustwork.auth_lookup_password_credential(p_email_normalized text)
RETURNS TABLE (person_id uuid, credential_id uuid, password_hash text, disabled_at timestamptz, email_verified boolean, authz_epoch integer)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT * FROM (
    SELECT c.person_id, c.id, c.password_hash, c.disabled_at, (b.verified_at IS NOT NULL), p.authz_epoch
    FROM trustwork.email_binding b
    JOIN trustwork.credential c ON c.person_id = b.person_id AND c.kind = 'password'
    JOIN trustwork.person p ON p.id = b.person_id
    WHERE b.email_normalized = p_email_normalized
    UNION ALL
    SELECT NULL::uuid, NULL::uuid, '$argon2id$v=19$m=65536,t=3,p=4$c3Ryb3ktZHVtbXktc2FsdA$ZHVtbXktaGFzaC1uZXZlci1tYXRjaGVzLWFueXRoaW5n', NULL::timestamptz, false, NULL::integer
  ) rows
  LIMIT 1
$$;

CREATE FUNCTION trustwork.auth_lookup_provider_credential(p_provider text, p_provider_subject text)
RETURNS TABLE (person_id uuid, credential_id uuid, disabled_at timestamptz, authz_epoch integer)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT c.person_id, c.id, c.disabled_at, p.authz_epoch
  FROM trustwork.credential c JOIN trustwork.person p ON p.id = c.person_id
  WHERE c.provider = p_provider AND c.provider_subject = p_provider_subject
$$;

-- Single use: marks consumed_at atomically and returns nothing for unknown, expired or already consumed tokens.
CREATE FUNCTION trustwork.auth_consume_token(p_token_hash bytea, p_kind text)
RETURNS TABLE (token_id uuid, person_id uuid, email_normalized text, authz_epoch integer)
LANGUAGE sql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  WITH consumed AS (
    UPDATE trustwork.auth_token t SET consumed_at = now()
    WHERE t.token_hash = p_token_hash AND t.kind = p_kind AND t.consumed_at IS NULL AND t.expires_at > now()
    RETURNING t.id, t.person_id, t.email_normalized
  )
  SELECT c.id, c.person_id, c.email_normalized, p.authz_epoch FROM consumed c JOIN trustwork.person p ON p.id = c.person_id
$$;

-- Signup primitive: person + unverified primary binding + password credential + verification token in one call.
-- Returns NULL when the e-mail is already bound (the caller answers identically and e-mails the existing owner).
CREATE FUNCTION trustwork.auth_register_person(p_display_name text, p_email_normalized text, p_password_hash text, p_verify_token_hash bytea, p_verify_expires_at timestamptz)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM trustwork.email_binding WHERE email_normalized = p_email_normalized) THEN
    RETURN NULL;
  END IF;
  INSERT INTO trustwork.person (display_name) VALUES (p_display_name) RETURNING id INTO v_person;
  INSERT INTO trustwork.email_binding (person_id, email_normalized, is_primary) VALUES (v_person, p_email_normalized, true);
  INSERT INTO trustwork.credential (person_id, kind, password_hash) VALUES (v_person, 'password', p_password_hash);
  INSERT INTO trustwork.auth_token (token_hash, kind, person_id, email_normalized, expires_at)
    VALUES (p_verify_token_hash, 'verify_email', v_person, p_email_normalized, p_verify_expires_at);
  RETURN v_person;
END $$;

-- Issues a token for a bound e-mail pre-identity (recovery, re-sent verification). Returns the person id or NULL;
-- the HTTP layer must answer identically either way.
CREATE FUNCTION trustwork.auth_issue_token(p_email_normalized text, p_kind text, p_token_hash bytea, p_expires_at timestamptz, p_require_verified boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid;
BEGIN
  SELECT person_id INTO v_person FROM trustwork.email_binding
  WHERE email_normalized = p_email_normalized AND (NOT p_require_verified OR verified_at IS NOT NULL);
  IF v_person IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO trustwork.auth_token (token_hash, kind, person_id, email_normalized, expires_at)
    VALUES (p_token_hash, p_kind, v_person, p_email_normalized, p_expires_at);
  RETURN v_person;
END $$;

-- Records one failure and returns the count inside the window; thresholds (H03) are decided by the caller.
CREATE FUNCTION trustwork.auth_record_login_failure(p_subject_hash bytea, p_window interval, p_retention interval)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO trustwork.login_failure (subject_hash, expires_at) VALUES (p_subject_hash, now() + p_retention);
  SELECT count(*) INTO v_count FROM trustwork.login_failure WHERE subject_hash = p_subject_hash AND occurred_at >= now() - p_window;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION
  trustwork.auth_lookup_session(bytea),
  trustwork.auth_lookup_password_credential(text),
  trustwork.auth_lookup_provider_credential(text, text),
  trustwork.auth_consume_token(bytea, text),
  trustwork.auth_register_person(text, text, text, bytea, timestamptz),
  trustwork.auth_issue_token(text, text, bytea, timestamptz, boolean),
  trustwork.auth_record_login_failure(bytea, interval, interval)
TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
