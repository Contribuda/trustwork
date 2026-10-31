-- DATA-001 company, membership, permission grants, object participation and the trusted principal setter.

CREATE TABLE trustwork.company (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  -- sourced: imported from an external source; registered: created by a platform user.
  sourced_status text NOT NULL DEFAULT 'registered' CHECK (sourced_status IN ('sourced', 'registered')),
  -- Maps to the contract CompanyStatus: unclaimed = sourced, claimed, verified.
  claim_status text NOT NULL DEFAULT 'unclaimed' CHECK (claim_status IN ('unclaimed', 'claimed', 'verified')),
  legal_identifiers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(legal_identifiers) = 'array'),
  public_description text NULL,
  verified_domains text[] NOT NULL DEFAULT '{}',
  internal_notes text NULL,
  billing_account_id uuid NULL,
  authz_epoch integer NOT NULL DEFAULT 1 CHECK (authz_epoch >= 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER company_touch BEFORE UPDATE ON trustwork.company FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.membership (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  role text NOT NULL CHECK (role IN ('member', 'administrator')),
  permissions text[] NOT NULL DEFAULT '{}' CHECK (permissions <@ ARRAY['company.page.edit', 'company.publish', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit', 'company.billing.view', 'company.billing.manage']::text[]),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'declined', 'expired', 'withdrawn', 'ended')),
  invited_by uuid NULL REFERENCES trustwork.person (id),
  invited_at timestamptz NOT NULL DEFAULT now(),
  valid_from timestamptz NULL,
  ended_at timestamptz NULL,
  ended_by uuid NULL REFERENCES trustwork.person (id),
  ended_reason text NULL CHECK (ended_reason IS NULL OR length(ended_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_active_shape CHECK ((status = 'active') = (valid_from IS NOT NULL AND ended_at IS NULL)),
  CONSTRAINT membership_ended_shape CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CONSTRAINT membership_ended_actor CHECK (status <> 'ended' OR (ended_by IS NOT NULL AND ended_reason IS NOT NULL))
);
CREATE INDEX membership_company_idx ON trustwork.membership (company_id);
CREATE INDEX membership_person_idx ON trustwork.membership (person_id);
-- Invariant 1: one active ordinary employer per person.
CREATE UNIQUE INDEX membership_one_active_employer ON trustwork.membership (person_id) WHERE status = 'active';

-- Historical rows are never reassigned; status follows the contract transition table.
CREATE FUNCTION trustwork.membership_guard() RETURNS trigger
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
  RETURN NEW;
END $$;
CREATE TRIGGER membership_guard BEFORE UPDATE ON trustwork.membership FOR EACH ROW EXECUTE FUNCTION trustwork.membership_guard();
CREATE TRIGGER membership_touch BEFORE UPDATE ON trustwork.membership FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Invariant 8: membership activation, change or end bumps the person and company authorization epochs
-- in the same transaction. SECURITY DEFINER because the runtime role may not update other people's rows.
CREATE FUNCTION trustwork.bump_epochs_for_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'active' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status AND NEW.role = OLD.role AND NEW.permissions = OLD.permissions THEN
    RETURN NULL;
  END IF;
  UPDATE trustwork.person SET authz_epoch = authz_epoch + 1 WHERE id = NEW.person_id;
  UPDATE trustwork.company SET authz_epoch = authz_epoch + 1 WHERE id = NEW.company_id;
  RETURN NULL;
END $$;
CREATE TRIGGER membership_epochs AFTER INSERT OR UPDATE ON trustwork.membership FOR EACH ROW EXECUTE FUNCTION trustwork.bump_epochs_for_membership();

CREATE TABLE trustwork.permission_grant (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  principal_person_id uuid NULL REFERENCES trustwork.person (id),
  principal_company_id uuid NULL REFERENCES trustwork.company (id),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object'),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(limits) = 'object'),
  granted_by uuid NOT NULL REFERENCES trustwork.person (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,
  revoked_at timestamptz NULL,
  revoked_reason text NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permission_grant_principal_xor CHECK ((principal_person_id IS NULL) <> (principal_company_id IS NULL))
);
CREATE INDEX permission_grant_person_idx ON trustwork.permission_grant (principal_person_id) WHERE principal_person_id IS NOT NULL;
CREATE INDEX permission_grant_company_idx ON trustwork.permission_grant (principal_company_id) WHERE principal_company_id IS NOT NULL;
CREATE TRIGGER permission_grant_touch BEFORE UPDATE ON trustwork.permission_grant FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.object_participation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  resource_kind text NOT NULL CHECK (resource_kind IN ('project', 'rfq', 'quote', 'agreement', 'order', 'thread', 'publication')),
  resource_id uuid NOT NULL,
  party_person_id uuid NULL REFERENCES trustwork.person (id),
  party_company_id uuid NULL REFERENCES trustwork.company (id),
  side text NOT NULL CHECK (side IN ('owner', 'buyer', 'seller', 'participant', 'staff')),
  capabilities text[] NOT NULL CHECK (
    cardinality(capabilities) >= 1
    AND NOT ('read.public' = ANY (capabilities))
    AND capabilities <@ ARRAY['read.shared', 'read.party_private', 'read.owner_private', 'write.draft', 'publish', 'invite', 'negotiate', 'accept', 'commit_order', 'manage_participants', 'transfer_ownership', 'lead', 'export', 'staff.case_read']::text[]
  ),
  audience text NOT NULL CHECK (audience IN ('shared_party', 'party_private', 'owner_private')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NULL CHECK (valid_until IS NULL OR valid_until > valid_from),
  granted_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  on_behalf_of_person_id uuid NULL REFERENCES trustwork.person (id),
  on_behalf_of_company_id uuid NULL REFERENCES trustwork.company (id),
  revoked_at timestamptz NULL,
  revoked_reason text NULL CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 500),
  case_ref uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT participation_party_xor CHECK ((party_person_id IS NULL) <> (party_company_id IS NULL)),
  CONSTRAINT participation_on_behalf_xor CHECK (on_behalf_of_person_id IS NULL OR on_behalf_of_company_id IS NULL),
  CONSTRAINT participation_staff_case CHECK (NOT ('staff.case_read' = ANY (capabilities)) OR (case_ref IS NOT NULL AND side = 'staff')),
  CONSTRAINT participation_revocation_shape CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX participation_resource_idx ON trustwork.object_participation (resource_kind, resource_id);
CREATE INDEX participation_person_idx ON trustwork.object_participation (party_person_id) WHERE party_person_id IS NOT NULL;
CREATE INDEX participation_company_idx ON trustwork.object_participation (party_company_id) WHERE party_company_id IS NOT NULL;
-- Materialised once: one live non-staff row per (resource, party); re-grant after revoke creates a new row.
CREATE UNIQUE INDEX participation_one_live_per_person ON trustwork.object_participation (resource_kind, resource_id, party_person_id) WHERE revoked_at IS NULL AND side <> 'staff' AND party_person_id IS NOT NULL;
CREATE UNIQUE INDEX participation_one_live_per_company ON trustwork.object_participation (resource_kind, resource_id, party_company_id) WHERE revoked_at IS NULL AND side <> 'staff' AND party_company_id IS NOT NULL;
CREATE TRIGGER participation_touch BEFORE UPDATE ON trustwork.object_participation FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Participation rows are historical: the resource and party never change after insert.
CREATE FUNCTION trustwork.participation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resource_kind <> OLD.resource_kind OR NEW.resource_id <> OLD.resource_id
     OR NEW.party_person_id IS DISTINCT FROM OLD.party_person_id OR NEW.party_company_id IS DISTINCT FROM OLD.party_company_id THEN
    RAISE EXCEPTION 'participation % cannot be reassigned', OLD.id USING ERRCODE = 'integrity_constraint_violation', HINT = 'access.immutable_parties';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'participation % cannot be un-revoked', OLD.id USING ERRCODE = 'integrity_constraint_violation', HINT = 'access.revocation_final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER participation_guard BEFORE UPDATE ON trustwork.object_participation FOR EACH ROW EXECUTE FUNCTION trustwork.participation_guard();

-- Invariant 8: granting, changing or revoking participation bumps the party's epoch.
CREATE FUNCTION trustwork.bump_epochs_for_participation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NEW.party_person_id IS NOT NULL THEN
    UPDATE trustwork.person SET authz_epoch = authz_epoch + 1 WHERE id = NEW.party_person_id;
  ELSE
    UPDATE trustwork.company SET authz_epoch = authz_epoch + 1 WHERE id = NEW.party_company_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER participation_epochs AFTER INSERT OR UPDATE ON trustwork.object_participation FOR EACH ROW EXECUTE FUNCTION trustwork.bump_epochs_for_participation();

-- Row level security.
ALTER TABLE trustwork.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.membership FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.permission_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.permission_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.object_participation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.object_participation FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.membership AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.permission_grant AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.object_participation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- A person sees their own memberships and the memberships of their active employer; inserts and updates
-- stay inside the same two scopes (the invite/accept/end authority is the application policy's job).
CREATE POLICY membership_visible ON trustwork.membership FOR SELECT TO trustwork_app
  USING (person_id = trustwork.current_person_id() OR company_id = trustwork.current_company_id());
CREATE POLICY membership_insert ON trustwork.membership FOR INSERT TO trustwork_app
  WITH CHECK (person_id = trustwork.current_person_id() OR company_id = trustwork.current_company_id());
CREATE POLICY membership_update ON trustwork.membership FOR UPDATE TO trustwork_app
  USING (person_id = trustwork.current_person_id() OR company_id = trustwork.current_company_id())
  WITH CHECK (person_id = trustwork.current_person_id() OR company_id = trustwork.current_company_id());

CREATE POLICY permission_grant_visible ON trustwork.permission_grant FOR SELECT TO trustwork_app
  USING (principal_person_id = trustwork.current_person_id() OR principal_company_id = trustwork.current_company_id() OR granted_by = trustwork.current_person_id());
CREATE POLICY permission_grant_write ON trustwork.permission_grant FOR INSERT TO trustwork_app
  WITH CHECK (granted_by = trustwork.current_person_id());
CREATE POLICY permission_grant_update ON trustwork.permission_grant FOR UPDATE TO trustwork_app
  USING (granted_by = trustwork.current_person_id()) WITH CHECK (granted_by = trustwork.current_person_id());

-- Managing a resource: a live participation of the current person (or of the active employer) that carries
-- manage_participants. SECURITY DEFINER because a policy cannot sub-select its own table (recursion).
CREATE FUNCTION trustwork.can_manage_resource(p_resource_kind text, p_resource_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.object_participation p
    WHERE p.resource_kind = p_resource_kind AND p.resource_id = p_resource_id
      AND p.revoked_at IS NULL AND p.valid_from <= now() AND (p.valid_until IS NULL OR p.valid_until > now())
      AND 'manage_participants' = ANY (p.capabilities)
      AND (p.party_person_id = trustwork.current_person_id() OR (p.party_company_id IS NOT NULL AND p.party_company_id = trustwork.current_company_id()))
  )
$$;
GRANT EXECUTE ON FUNCTION trustwork.can_manage_resource(text, uuid) TO trustwork_app;

-- A party sees its own participation rows (person directly, company through the active membership derived by
-- the setter); managers of a resource see every row on it. Former members and unrelated companies see nothing.
CREATE POLICY participation_visible ON trustwork.object_participation FOR SELECT TO trustwork_app
  USING (
    party_person_id = trustwork.current_person_id()
    OR party_company_id = trustwork.current_company_id()
    OR trustwork.can_manage_resource(resource_kind, resource_id)
  );
-- Inserting: the first owner row of a resource for oneself or one's company, or any row when already managing it.
CREATE POLICY participation_insert ON trustwork.object_participation FOR INSERT TO trustwork_app
  WITH CHECK (
    granted_by_person_id = trustwork.current_person_id()
    AND (
      (side = 'owner' AND (party_person_id = trustwork.current_person_id() OR party_company_id = trustwork.current_company_id()))
      OR trustwork.can_manage_resource(resource_kind, resource_id)
    )
  );
-- Updating (revoke, narrow): the party itself or a manager of the resource.
CREATE POLICY participation_update ON trustwork.object_participation FOR UPDATE TO trustwork_app
  USING (party_person_id = trustwork.current_person_id() OR party_company_id = trustwork.current_company_id() OR trustwork.can_manage_resource(resource_kind, resource_id))
  WITH CHECK (party_person_id = trustwork.current_person_id() OR party_company_id = trustwork.current_company_id() OR trustwork.can_manage_resource(resource_kind, resource_id));

GRANT SELECT, INSERT, UPDATE (display_name, claim_status, legal_identifiers, public_description, verified_domains, internal_notes, billing_account_id) ON trustwork.company TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (role, permissions, status, valid_from, ended_at, ended_by, ended_reason) ON trustwork.membership TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (limits, expires_at, revoked_at, revoked_reason) ON trustwork.permission_grant TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (capabilities, audience, valid_until, revoked_at, revoked_reason) ON trustwork.object_participation TO trustwork_app;

-- Trusted transaction-local principal. SECURITY DEFINER so it can read person and membership under FORCE RLS
-- (the maintenance flag is scoped to this call and restored on exit); the caller must already be in a transaction.
-- Raises SQLSTATE 28000 when the person is unknown or the supplied epoch is stale, so a cached principal fails closed.
CREATE FUNCTION trustwork.set_principal(p_person_id uuid, p_authz_epoch integer) RETURNS void
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
  -- Company context is derived from the database (single active ordinary employer), never from the caller.
  SELECT company_id INTO v_company FROM trustwork.membership WHERE person_id = p_person_id AND status = 'active';
  PERFORM set_config('trustwork.person_id', p_person_id::text, true);
  PERFORM set_config('trustwork.authz_epoch', p_authz_epoch::text, true);
  PERFORM set_config('trustwork.company_id', coalesce(v_company::text, ''), true);
END $$;
GRANT EXECUTE ON FUNCTION trustwork.set_principal(uuid, integer) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
