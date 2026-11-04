-- ADM-004, issue #609. `docs/engine/hub-administration.md` says a two-person action needs "the second with a different
-- role", for every such action. 20261218100000_staff_sod_in_database.sql gave the database that rule for the two actions
-- that hand out a staff role and left the rest to the API, which counted staff under row-level security and skipped the
-- check for an approver without `admin.staff.read`. So the database now decides it for every action:
--   * admin_decide_approval refuses the approver (admin.same_role);
--   * admin_consume_approval refuses again, because the scope can reach five people, or the roles can change, between the
--     approval and its use.
-- Both already call this function, so only its filter goes. In reduced mode nothing changes.
CREATE OR REPLACE FUNCTION trustwork.staff_require_different_role(p_action text, p_requester uuid, p_approver uuid, p_node uuid, p_hub uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.staff_sod_full(p_node, p_hub)
     AND trustwork.staff_roles_for_action(p_approver, p_action, p_node, p_hub) <@ trustwork.staff_roles_for_action(p_requester, p_action, p_node, p_hub) THEN
    RAISE EXCEPTION 'in full separation-of-duties mode the second person acts through a different role' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.same_role';
  END IF;
END $$;
