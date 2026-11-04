-- HUBC-007: the launch gate `verification_recipe_enabled` now rests on the recipes, so activating a version re-opens a passed
-- gate, as activating a configuration version does for the gates that rest on it.
-- Whether the hub runs a recipe. It answers for the launch gate, whose callers carry the maintenance setting; no role is granted it.
CREATE FUNCTION trustwork.verification_has_active_recipe(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.verification_recipe r WHERE r.hub_id = p_hub AND r.status = 'active');
$$;
REVOKE EXECUTE ON FUNCTION trustwork.verification_has_active_recipe(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION trustwork.verification_activate_recipe(p_ctx jsonb, p_recipe uuid, p_expected_revision integer) RETURNS trustwork.verification_recipe
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.verification_recipe%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.verification_recipe%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.verification_recipe WHERE id = p_recipe FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such recipe' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.verification_staff(p_ctx, ARRAY['admin.claims.policy.edit'], v_before.hub_id);
  PERFORM trustwork.verification_check_revision(v_before.revision, p_expected_revision);
  IF v_before.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft is activated' USING ERRCODE = 'check_violation', HINT = 'verification.invalid_transition';
  END IF;
  UPDATE trustwork.verification_recipe SET status = 'superseded', revision = revision + 1 WHERE hub_id = v_before.hub_id AND key = v_before.key AND status = 'active';
  UPDATE trustwork.verification_recipe SET status = 'active', activated_by = v_actor.person_id, activated_at = now(), revision = revision + 1
   WHERE id = p_recipe RETURNING * INTO v_row;
  -- What the launch gate rests on changed, so a passed gate waits for a person again, as after a configuration version.
  PERFORM trustwork.hubs_reopen_gate(v_row.hub_id, 'verification_recipe_enabled', 'recipe ' || v_row.key || ' version ' || v_row.version || ' activated');
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'verification.recipe_activated', 'verification_recipe', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;
