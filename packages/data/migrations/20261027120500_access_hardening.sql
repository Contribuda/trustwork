-- DATA-001 review fixes (PR #13): RLS on company/project, party-private company data, self-escalation guards,
-- job fencing privileges, epoch bumps without revision churn, lookup determinism and provider-first signup.

-- P2-4: epoch-only updates (SECURITY DEFINER bump triggers) must not change the optimistic revision.
CREATE OR REPLACE FUNCTION trustwork.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_old jsonb := to_jsonb(OLD) - 'authz_epoch' - 'revision' - 'updated_at';
  v_new jsonb := to_jsonb(NEW) - 'authz_epoch' - 'revision' - 'updated_at';
BEGIN
  IF v_old = v_new THEN
    NEW.revision := OLD.revision;
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

-- Maintenance context = owner role with the transaction/function-scoped flag (a self-set flag by trustwork_app is not enough).
CREATE FUNCTION trustwork.in_maintenance() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT current_user = 'trustwork_owner' AND current_setting('trustwork.maintenance', true) = 'on'
$$;
GRANT EXECUTE ON FUNCTION trustwork.in_maintenance() TO trustwork_app;

-- P1-2: company carries party-private data; split it off and filter both company and project.
CREATE TABLE trustwork.company_private (
  company_id uuid PRIMARY KEY REFERENCES trustwork.company (id),
  internal_notes text NULL,
  billing_account_id uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER company_private_touch BEFORE UPDATE ON trustwork.company_private FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
INSERT INTO trustwork.company_private (company_id, internal_notes, billing_account_id)
  SELECT id, internal_notes, billing_account_id FROM trustwork.company WHERE internal_notes IS NOT NULL OR billing_account_id IS NOT NULL;
ALTER TABLE trustwork.company DROP COLUMN internal_notes, DROP COLUMN billing_account_id;

ALTER TABLE trustwork.company ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_private FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.project ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.project FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.company AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.company_private AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.project AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Companies are public entities (name, status, legal identifiers); only the active employer's members may change them.
CREATE POLICY company_read ON trustwork.company FOR SELECT TO trustwork_app USING (true);
CREATE POLICY company_insert ON trustwork.company FOR INSERT TO trustwork_app WITH CHECK (trustwork.current_person_id() IS NOT NULL);
CREATE POLICY company_update ON trustwork.company FOR UPDATE TO trustwork_app
  USING (id = trustwork.current_company_id()) WITH CHECK (id = trustwork.current_company_id());
CREATE POLICY company_private_own ON trustwork.company_private FOR ALL TO trustwork_app
  USING (company_id = trustwork.current_company_id()) WITH CHECK (company_id = trustwork.current_company_id());
GRANT SELECT, INSERT, UPDATE (internal_notes, billing_account_id) ON trustwork.company_private TO trustwork_app;

-- Ownership of a resource for the current principal (person owner or active employer owner). Only projects exist
-- in this slice; COM-001 extends the function (CREATE OR REPLACE) for rfq/quote/agreement/order/thread/publication.
CREATE FUNCTION trustwork.owns_resource(p_resource_kind text, p_resource_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND CASE p_resource_kind
    WHEN 'project' THEN EXISTS (
      SELECT 1 FROM trustwork.project p WHERE p.id = p_resource_id
        AND (p.owner_person_id = trustwork.current_person_id() OR (p.owner_company_id IS NOT NULL AND p.owner_company_id = trustwork.current_company_id()))
    )
    ELSE false END
$$;
GRANT EXECUTE ON FUNCTION trustwork.owns_resource(text, uuid) TO trustwork_app;

-- Projects: public ones are readable by everyone with an identity; private ones by the owner party or a manager.
CREATE POLICY project_read ON trustwork.project FOR SELECT TO trustwork_app
  USING (
    trustwork.current_person_id() IS NOT NULL
    AND (publicity_enabled OR owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id() OR trustwork.can_manage_resource('project', id))
  );
CREATE POLICY project_insert ON trustwork.project FOR INSERT TO trustwork_app
  WITH CHECK (creator_person_id = trustwork.current_person_id() AND (owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id()));
CREATE POLICY project_update ON trustwork.project FOR UPDATE TO trustwork_app
  USING (owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id() OR trustwork.can_manage_resource('project', id))
  WITH CHECK (owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id() OR trustwork.can_manage_resource('project', id));

-- P1-3: no self-escalation through write policies.
-- One live owner row per resource; the owner branch of participation_insert requires actual ownership.
CREATE UNIQUE INDEX participation_one_live_owner ON trustwork.object_participation (resource_kind, resource_id) WHERE side = 'owner' AND revoked_at IS NULL;
DROP POLICY participation_insert ON trustwork.object_participation;
CREATE POLICY participation_insert ON trustwork.object_participation FOR INSERT TO trustwork_app
  WITH CHECK (
    granted_by_person_id = trustwork.current_person_id()
    AND (
      (side = 'owner' AND (party_person_id = trustwork.current_person_id() OR party_company_id = trustwork.current_company_id()) AND trustwork.owns_resource(resource_kind, resource_id))
      OR trustwork.can_manage_resource(resource_kind, resource_id)
    )
  );
-- A party may revoke itself but never widen or extend its own grant; managers (or maintenance) may change grants.
CREATE OR REPLACE FUNCTION trustwork.participation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resource_kind <> OLD.resource_kind OR NEW.resource_id <> OLD.resource_id
     OR NEW.party_person_id IS DISTINCT FROM OLD.party_person_id OR NEW.party_company_id IS DISTINCT FROM OLD.party_company_id THEN
    RAISE EXCEPTION 'participation % cannot be reassigned', OLD.id USING ERRCODE = 'integrity_constraint_violation', HINT = 'access.immutable_parties';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'participation % cannot be un-revoked', OLD.id USING ERRCODE = 'integrity_constraint_violation', HINT = 'access.revocation_final';
  END IF;
  IF (NEW.capabilities <> OLD.capabilities OR NEW.audience <> OLD.audience OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.side <> OLD.side)
     AND NOT trustwork.in_maintenance()
     AND NOT trustwork.can_manage_resource(OLD.resource_kind, OLD.resource_id) THEN
    RAISE EXCEPTION 'participation % may only be changed by a manager of the resource', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'access.self_amplification';
  END IF;
  RETURN NEW;
END $$;

-- Membership: a person may only request to join as an invited plain member; invitations come from the employer.
DROP POLICY membership_insert ON trustwork.membership;
CREATE POLICY membership_insert ON trustwork.membership FOR INSERT TO trustwork_app
  WITH CHECK (
    (person_id = trustwork.current_person_id() AND status = 'invited' AND role = 'member' AND permissions = '{}'::text[] AND invited_by IS NULL)
    OR (company_id = trustwork.current_company_id() AND invited_by = trustwork.current_person_id())
  );
-- Role/permission changes come from a colleague of the active employer, never from the member themself.
CREATE OR REPLACE FUNCTION trustwork.membership_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.person_id <> OLD.person_id OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'membership % cannot be reassigned to another person or company', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'membership.immutable_parties';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'invited' AND NEW.status IN ('active', 'declined', 'expired', 'withdrawn'))
      OR (OLD.status = 'active' AND NEW.status = 'ended')
    ) THEN
      RAISE EXCEPTION 'membership transition % -> % is not allowed', OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation', HINT = 'membership.invalid_transition';
    END IF;
  END IF;
  IF (NEW.role <> OLD.role OR NEW.permissions <> OLD.permissions)
     AND NOT trustwork.in_maintenance()
     AND NOT coalesce(OLD.company_id = trustwork.current_company_id() AND OLD.person_id <> trustwork.current_person_id(), false) THEN
    RAISE EXCEPTION 'membership % role or permissions may only be changed by another member of the company', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'membership.self_promotion';
  END IF;
  RETURN NEW;
END $$;

-- Permission grants: never to oneself.
DROP POLICY permission_grant_write ON trustwork.permission_grant;
CREATE POLICY permission_grant_write ON trustwork.permission_grant FOR INSERT TO trustwork_app
  WITH CHECK (granted_by = trustwork.current_person_id() AND principal_person_id IS DISTINCT FROM trustwork.current_person_id());

-- P3: set_principal honours a future valid_from.
CREATE OR REPLACE FUNCTION trustwork.set_principal(p_person_id uuid, p_authz_epoch integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_epoch integer;
  v_company uuid;
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
  PERFORM set_config('trustwork.person_id', p_person_id::text, true);
  PERFORM set_config('trustwork.authz_epoch', p_authz_epoch::text, true);
  PERFORM set_config('trustwork.company_id', coalesce(v_company::text, ''), true);
END $$;

-- P3: deterministic row choice (a real credential always wins over the dummy row).
CREATE OR REPLACE FUNCTION trustwork.auth_lookup_password_credential(p_email_normalized text)
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
  ORDER BY person_id IS NULL
  LIMIT 1
$$;

-- P3: a concurrent signup with the same e-mail is answered like a duplicate, not with an error.
CREATE OR REPLACE FUNCTION trustwork.auth_register_person(p_display_name text, p_email_normalized text, p_password_hash text, p_verify_token_hash bytea, p_verify_expires_at timestamptz)
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
EXCEPTION WHEN unique_violation THEN
  RETURN NULL;
END $$;

-- P3: provider-first signup (Google/Apple) without a password; the e-mail binding is verified only when the
-- provider proof is accepted by policy (H06), otherwise it stays unverified until our own verification.
CREATE FUNCTION trustwork.auth_register_provider_person(p_display_name text, p_email_normalized text, p_provider text, p_provider_subject text, p_email_verified boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM trustwork.email_binding WHERE email_normalized = p_email_normalized)
     OR EXISTS (SELECT 1 FROM trustwork.credential WHERE provider = p_provider AND provider_subject = p_provider_subject) THEN
    RETURN NULL;
  END IF;
  INSERT INTO trustwork.person (display_name) VALUES (p_display_name) RETURNING id INTO v_person;
  INSERT INTO trustwork.email_binding (person_id, email_normalized, is_primary, verified_at)
    VALUES (v_person, p_email_normalized, true, CASE WHEN p_email_verified THEN now() END);
  INSERT INTO trustwork.credential (person_id, kind, provider, provider_subject) VALUES (v_person, p_provider, p_provider, p_provider_subject);
  RETURN v_person;
EXCEPTION WHEN unique_violation THEN
  RETURN NULL;
END $$;
GRANT EXECUTE ON FUNCTION trustwork.auth_register_provider_person(text, text, text, text, boolean) TO trustwork_app;

-- P2-3: the runtime role cannot move the fencing token or attempt counter; only the lease helper (owner) does.
REVOKE UPDATE (fencing_token, attempt) ON trustwork.job FROM trustwork_app;
CREATE OR REPLACE FUNCTION trustwork.lease_jobs(p_kinds text[], p_worker text, p_lease interval, p_limit integer)
RETURNS SETOF trustwork.job
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp AS $$
  WITH candidate AS (
    SELECT id FROM trustwork.job
    WHERE state = 'queued' AND next_at <= now() AND kind = ANY (p_kinds)
    ORDER BY next_at, id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE trustwork.job j
  SET state = 'leased', leased_until = now() + p_lease, leased_by = p_worker,
      fencing_token = j.fencing_token + 1, attempt = j.attempt + 1, updated_at = clock_timestamp()
  FROM candidate c
  WHERE j.id = c.id
  RETURNING j.*
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
