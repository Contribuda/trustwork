-- BE-003 directory: public handles for people, companies and projects (ADR 012 decision 18), company creation with a
-- founding administrator, keyset indexes behind the paginated directories, and owner-run public reads for anonymous
-- callers (every runtime policy on person and project requires an identity).

-- 1. Handles ------------------------------------------------------------------------------------------------------
-- One row per (kind, handle) for ever: the primary key makes a handle unique per kind and, because rows are never
-- deleted or re-pointed (guard below), a retired handle stays with its subject as a redirect and is never reused for
-- another subject. At most one current (not retired) handle per subject. UUIDs remain the stable identifiers.
-- Format and reserved words mirror HandleSchema / RESERVED_HANDLES in packages/contracts/src/directory.ts.
CREATE TABLE trustwork.directory_handle (
  kind text NOT NULL CHECK (kind IN ('person', 'company', 'project')),
  handle text NOT NULL,
  subject_id uuid NOT NULL,
  assigned_by uuid NOT NULL REFERENCES trustwork.person (id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz NULL,
  PRIMARY KEY (kind, handle),
  CONSTRAINT directory_handle_format CHECK (
    length(handle) BETWEEN 3 AND 40
    AND handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND handle !~ '^[0-9]+$'
    AND handle !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT directory_handle_not_reserved CHECK (NOT (handle = ANY (ARRAY[
    'about', 'account', 'admin', 'administrator', 'api', 'app', 'auth', 'by-handle', 'companies', 'company', 'contribuda', 'contribuddha',
    'directory', 'edit', 'events', 'handles', 'help', 'hub', 'hubs', 'login', 'logout', 'me', 'moderator', 'new', 'null', 'official',
    'people', 'person', 'projects', 'project', 'register', 'root', 'search', 'security', 'settings', 'signup', 'staff', 'support',
    'system', 'trustwork', 'undefined', 'verified', 'www'
  ]::text[])))
);
CREATE UNIQUE INDEX directory_handle_one_current ON trustwork.directory_handle (kind, subject_id) WHERE retired_at IS NULL;
CREATE INDEX directory_handle_subject_idx ON trustwork.directory_handle (kind, subject_id);

-- Identity columns never change and rows are never deleted, for every role (also maintenance): a handle can never be
-- moved to another subject. Only retired_at changes (retire, or reclaim one's own former handle).
CREATE FUNCTION trustwork.directory_handle_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'directory handles are permanent' USING ERRCODE = 'integrity_constraint_violation', HINT = 'directory.handle_permanent';
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.handle <> OLD.handle OR NEW.subject_id <> OLD.subject_id OR NEW.assigned_by <> OLD.assigned_by OR NEW.assigned_at <> OLD.assigned_at THEN
    RAISE EXCEPTION 'directory handle % cannot be re-pointed', OLD.handle USING ERRCODE = 'integrity_constraint_violation', HINT = 'directory.handle_permanent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER directory_handle_guard BEFORE UPDATE OR DELETE ON trustwork.directory_handle FOR EACH ROW EXECUTE FUNCTION trustwork.directory_handle_guard();

ALTER TABLE trustwork.directory_handle ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.directory_handle FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.directory_handle AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- A handle (current or retired) is visible exactly when its subject is visible to the caller under the subject's own
-- policies: public or own profiles, any company, public/owned/participated projects. Private subjects' handles stay
-- hidden. Writes only through trustwork.directory_set_handle / directory_create_company.
CREATE POLICY directory_handle_read ON trustwork.directory_handle FOR SELECT TO trustwork_app
  USING (CASE kind
    WHEN 'person' THEN EXISTS (SELECT 1 FROM trustwork.person s WHERE s.id = subject_id)
    WHEN 'company' THEN EXISTS (SELECT 1 FROM trustwork.company s WHERE s.id = subject_id)
    WHEN 'project' THEN EXISTS (SELECT 1 FROM trustwork.project s WHERE s.id = subject_id)
    ELSE false END);
GRANT SELECT ON trustwork.directory_handle TO trustwork_app;

-- Internal (owner-run, not executable by the runtime role): validates, then makes p_handle the current handle of the
-- subject. Serialized per subject by an advisory lock; a concurrent claim of the same handle by another subject loses
-- on the primary key and is reported as unavailable. Reclaiming one's own retired handle is allowed.
CREATE FUNCTION trustwork.directory_assign_handle(p_kind text, p_subject_id uuid, p_handle text, p_actor uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_existing trustwork.directory_handle%ROWTYPE;
  v_count integer;
BEGIN
  IF p_handle IS NULL OR length(p_handle) NOT BETWEEN 3 AND 40 OR p_handle !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR p_handle ~ '^[0-9]+$'
     OR p_handle ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid handle' USING ERRCODE = 'invalid_parameter_value', HINT = 'directory.handle_invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.directory_handle'), hashtext(p_kind || ':' || p_subject_id::text));
  SELECT * INTO v_existing FROM trustwork.directory_handle WHERE kind = p_kind AND handle = p_handle;
  IF FOUND THEN
    IF v_existing.subject_id <> p_subject_id THEN
      RAISE EXCEPTION 'handle unavailable' USING ERRCODE = 'unique_violation', HINT = 'directory.handle_unavailable';
    END IF;
    IF v_existing.retired_at IS NULL THEN
      RETURN p_handle;
    END IF;
    UPDATE trustwork.directory_handle SET retired_at = now() WHERE kind = p_kind AND subject_id = p_subject_id AND retired_at IS NULL;
    UPDATE trustwork.directory_handle SET retired_at = NULL WHERE kind = p_kind AND handle = p_handle;
    RETURN p_handle;
  END IF;
  SELECT count(*) INTO v_count FROM trustwork.directory_handle WHERE kind = p_kind AND subject_id = p_subject_id;
  IF v_count >= 10 THEN
    RAISE EXCEPTION 'handle limit reached' USING ERRCODE = 'program_limit_exceeded', HINT = 'directory.handle_limit';
  END IF;
  UPDATE trustwork.directory_handle SET retired_at = now() WHERE kind = p_kind AND subject_id = p_subject_id AND retired_at IS NULL;
  BEGIN
    INSERT INTO trustwork.directory_handle (kind, handle, subject_id, assigned_by) VALUES (p_kind, p_handle, p_subject_id, p_actor);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'handle unavailable' USING ERRCODE = 'unique_violation', HINT = 'directory.handle_unavailable';
    WHEN check_violation THEN
      RAISE EXCEPTION 'reserved handle' USING ERRCODE = 'invalid_parameter_value', HINT = 'directory.handle_invalid';
  END;
  RETURN p_handle;
END $$;

-- Runtime entry point: the caller must own the subject (themself; the active employer with company.page.edit; a
-- project owned by themself or by the active employer with company.publish). Mirrors the application policy.
CREATE FUNCTION trustwork.directory_set_handle(p_kind text, p_subject_id uuid, p_handle text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_company uuid := trustwork.current_company_id();
  v_project trustwork.project%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_kind = 'person' THEN
    IF p_subject_id IS DISTINCT FROM v_person THEN
      RAISE EXCEPTION 'not authorised' USING ERRCODE = 'insufficient_privilege', HINT = 'directory.not_authorised';
    END IF;
  ELSIF p_kind = 'company' THEN
    IF NOT EXISTS (SELECT 1 FROM trustwork.company WHERE id = p_subject_id) THEN
      RAISE EXCEPTION 'unknown company' USING ERRCODE = 'insufficient_privilege', HINT = 'directory.not_found';
    END IF;
    IF v_company IS NULL OR p_subject_id <> v_company THEN
      RAISE EXCEPTION 'not authorised' USING ERRCODE = 'insufficient_privilege', HINT = 'directory.not_authorised';
    END IF;
    IF NOT trustwork.current_membership_has('company.page.edit') THEN
      RAISE EXCEPTION 'permission missing' USING ERRCODE = 'insufficient_privilege', HINT = 'membership.permission_missing';
    END IF;
  ELSIF p_kind = 'project' THEN
    SELECT * INTO v_project FROM trustwork.project WHERE id = p_subject_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown project' USING ERRCODE = 'insufficient_privilege', HINT = 'directory.not_found';
    END IF;
    -- coalesce: a NULL owner column must deny, never fall through as "unknown".
    IF NOT (coalesce(v_project.owner_person_id = v_person, false)
            OR (coalesce(v_project.owner_company_id = v_company, false) AND trustwork.current_membership_has('company.publish'))) THEN
      RAISE EXCEPTION 'not authorised' USING ERRCODE = 'insufficient_privilege', HINT = 'directory.not_authorised';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown handle kind' USING ERRCODE = 'invalid_parameter_value', HINT = 'directory.handle_invalid';
  END IF;
  RETURN trustwork.directory_assign_handle(p_kind, p_subject_id, p_handle, v_person);
END $$;

-- 2. Company creation ---------------------------------------------------------------------------------------------
-- Companies are created only here: `registered` and `unclaimed` (claim_status/verified_domains are never written by
-- the runtime role), with exactly one founding administrator, the caller, in the same transaction. The one-active-
-- employer index refuses a caller who is already employed (23505 membership_one_active_employer), which rolls the
-- whole creation back, so no company without an administrator can exist.
DROP POLICY company_insert ON trustwork.company;
REVOKE INSERT ON trustwork.company FROM trustwork_app;

CREATE FUNCTION trustwork.directory_create_company(p_display_name text, p_public_description text, p_handle text)
RETURNS TABLE (company_id uuid, membership_id uuid)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_company uuid;
  v_membership uuid;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  INSERT INTO trustwork.company (display_name, public_description, sourced_status, claim_status)
    VALUES (p_display_name, p_public_description, 'registered', 'unclaimed')
    RETURNING id INTO v_company;
  INSERT INTO trustwork.membership (person_id, company_id, role, permissions, status, invited_by, valid_from)
    VALUES (v_person, v_company, 'administrator',
            ARRAY['company.page.edit', 'company.publish', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit', 'company.billing.view', 'company.billing.manage']::text[],
            'active', NULL, now())
    RETURNING id INTO v_membership;
  IF p_handle IS NOT NULL THEN
    PERFORM trustwork.directory_assign_handle('company', v_company, p_handle, v_person);
  END IF;
  RETURN QUERY SELECT v_company, v_membership;
END $$;

-- 3. Keyset indexes -------------------------------------------------------------------------------------------------
-- Directory order is (created_at DESC, id DESC); partial indexes cover exactly the public subset each list reads, and
-- the "my projects" branches seek by owner. The keyset condition is a row comparison, usable as an index condition.
CREATE INDEX directory_person_public_idx ON trustwork.person (created_at DESC, id DESC) WHERE profile_visibility = 'public';
CREATE INDEX directory_company_idx ON trustwork.company (created_at DESC, id DESC);
CREATE INDEX directory_project_public_idx ON trustwork.project (created_at DESC, id DESC) WHERE publicity_enabled;
CREATE INDEX directory_project_owner_person_idx ON trustwork.project (owner_person_id, created_at DESC, id DESC) WHERE owner_person_id IS NOT NULL;
CREATE INDEX directory_project_owner_company_idx ON trustwork.project (owner_company_id, created_at DESC, id DESC) WHERE owner_company_id IS NOT NULL;

-- 4. Anonymous public reads ---------------------------------------------------------------------------------------
-- Owner-run, public columns of public rows only, same order and keyset as the runtime queries. A NULL position is
-- the first page ('infinity' sorts after every timestamp). sort_key keeps microseconds for exact cursors.
CREATE FUNCTION trustwork.directory_public_people(p_after_created timestamptz, p_after_id uuid, p_limit integer)
RETURNS TABLE (id uuid, display_name text, public_headline text, public_expertise text[], handle text, sort_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id, p.display_name, p.public_headline, p.public_expertise, h.handle,
         to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  FROM trustwork.person p
  LEFT JOIN trustwork.directory_handle h ON h.kind = 'person' AND h.subject_id = p.id AND h.retired_at IS NULL
  WHERE p.profile_visibility = 'public'
    AND (p.created_at, p.id) < (coalesce(p_after_created, 'infinity'::timestamptz), coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 101)
$$;

CREATE FUNCTION trustwork.directory_public_projects(p_after_created timestamptz, p_after_id uuid, p_limit integer)
RETURNS TABLE (id uuid, name text, summary text, status text, published_story text, handle text, sort_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id, p.name, p.summary, p.status, p.published_story, h.handle,
         to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  FROM trustwork.project p
  LEFT JOIN trustwork.directory_handle h ON h.kind = 'project' AND h.subject_id = p.id AND h.retired_at IS NULL
  WHERE p.publicity_enabled
    AND (p.created_at, p.id) < (coalesce(p_after_created, 'infinity'::timestamptz), coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 101)
$$;

-- Handle -> subject for anonymous callers, only when the subject is public (public profile, any company, published
-- project); nothing otherwise (not found, never forbidden). current_handle is the subject's current handle.
CREATE FUNCTION trustwork.directory_public_resolve(p_kind text, p_handle text)
RETURNS TABLE (subject_id uuid, current_handle text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT h.subject_id, c.handle
  FROM trustwork.directory_handle h
  JOIN trustwork.directory_handle c ON c.kind = h.kind AND c.subject_id = h.subject_id AND c.retired_at IS NULL
  WHERE h.kind = p_kind AND h.handle = p_handle
    AND CASE p_kind
      WHEN 'person' THEN EXISTS (SELECT 1 FROM trustwork.person s WHERE s.id = h.subject_id AND s.profile_visibility = 'public')
      WHEN 'company' THEN EXISTS (SELECT 1 FROM trustwork.company s WHERE s.id = h.subject_id)
      WHEN 'project' THEN EXISTS (SELECT 1 FROM trustwork.project s WHERE s.id = h.subject_id AND s.publicity_enabled)
      ELSE false END
$$;

GRANT EXECUTE ON FUNCTION trustwork.directory_set_handle(text, uuid, text), trustwork.directory_create_company(text, text, text),
  trustwork.directory_public_people(timestamptz, uuid, integer), trustwork.directory_public_projects(timestamptz, uuid, integer),
  trustwork.directory_public_resolve(text, text) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
