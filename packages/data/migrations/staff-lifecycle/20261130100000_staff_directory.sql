-- ADM-004 part 1: the staff directory and the effective-access read (docs/engine/hub-console/console-design.md,
-- section 4.2). Contract: packages/contracts/src/staff-lifecycle.ts.
--
-- Rules the functions hold:
--   * only a person who holds an active staff role covering the hub reads its directory; anyone else, and any unknown
--     hub, gets "not found" (existence never leaks);
--   * every such staff member reads the names of the staff covering the hub, because approvals and audit name who asked
--     and who decided; roles and whether a second factor is enrolled need `admin.staff.read` at the hub;
--   * the effective-access read lists one person's active assignments covering the hub, for a reader with
--     `admin.staff.read` there; the API computes the permissions from the released definitions;
--   * nothing here returns what a staff member did: no sign-in, elevation or decision times, counts or other activity.
--
-- Authority model (DATA-002): SECURITY DEFINER reads that resolve the caller from the request principal; no table is
-- added and no row is written.

-- Active assignments covering the hub. Not executable by the runtime role: only the SECURITY DEFINER reads below call it.
CREATE FUNCTION trustwork.staff_covering_assignments(p_hub uuid)
RETURNS SETOF trustwork.staff_role_assignment
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT a.* FROM trustwork.staff_role_assignment a
   WHERE a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
     AND (a.scope_kind IN ('platform', 'node') OR a.hub_id = p_hub)
$$;

-- The caller covers the hub as staff, or the hub "does not exist".
CREATE FUNCTION trustwork.staff_require_hub_staff(p_hub uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_caller uuid := trustwork.current_person_id();
BEGIN
  IF v_caller IS NULL OR p_hub IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.hub h WHERE h.id = p_hub)
     OR NOT trustwork.admin_person_is_staff(v_caller, NULL, p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN v_caller;
END $$;

-- The directory: names for every staff reader of the hub; roles and second-factor state only with admin.staff.read.
CREATE FUNCTION trustwork.staff_directory(p_hub uuid)
RETURNS TABLE (person_id uuid, display_name text, detail boolean, roles jsonb, second_factor text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_detail boolean;
BEGIN
  PERFORM trustwork.staff_require_hub_staff(p_hub);
  v_detail := trustwork.admin_has_permission('admin.staff.read', NULL, p_hub);
  RETURN QUERY
    SELECT p.id, p.display_name, v_detail,
           CASE WHEN v_detail THEN
             jsonb_agg(jsonb_build_object(
               'assignmentId', a.id, 'role', a.role, 'scope', trustwork.admin_scope_json(a.scope_kind, a.node_id, a.hub_id),
               'validUntil', a.valid_until, 'breakglass', a.breakglass) ORDER BY a.role, a.id)
           END,
           CASE WHEN v_detail THEN
             CASE WHEN EXISTS (SELECT 1 FROM trustwork.second_factor f WHERE f.person_id = p.id AND f.state = 'active') THEN 'enrolled' ELSE 'none' END
           END
      FROM trustwork.staff_covering_assignments(p_hub) a
      JOIN trustwork.person p ON p.id = a.person_id
     GROUP BY p.id, p.display_name
     ORDER BY p.display_name, p.id;
END $$;

-- One person's active assignments covering the hub, for a reader with admin.staff.read there; a person without any
-- is "not found" as well, so the read never confirms who is not staff.
CREATE FUNCTION trustwork.staff_effective_assignments(p_hub uuid, p_person uuid)
RETURNS SETOF trustwork.staff_role_assignment
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.staff_require_hub_staff(p_hub);
  IF NOT trustwork.admin_has_permission('admin.staff.read', NULL, p_hub)
     OR NOT EXISTS (SELECT 1 FROM trustwork.staff_covering_assignments(p_hub) a WHERE a.person_id = p_person) THEN
    RAISE EXCEPTION 'no such person' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN QUERY SELECT a.* FROM trustwork.staff_covering_assignments(p_hub) a WHERE a.person_id = p_person ORDER BY a.role, a.id;
END $$;

REVOKE EXECUTE ON FUNCTION trustwork.staff_covering_assignments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.staff_require_hub_staff(uuid), trustwork.staff_directory(uuid), trustwork.staff_effective_assignments(uuid, uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
