-- ADM-005 part 3: saved views and a staff member's notification settings (docs/engine/hub-console/console-design.md,
-- sections 3.5 and 5; contract packages/contracts/src/console-services.ts).
--
-- A saved view remembers filters, columns and a sort for one surface at one scope, for its owner or for the holders of
-- one role covering that scope (a team). It stores no rows, counts or search text: what a view shows is computed for
-- each reader, under that reader's own permissions, when they open it. Sharing never carries a value someone typed:
-- filter values are codes (no space, no `@`, no plus, no long run of digits) in every view, and a view shared with a
-- team holds no identifier at all, so it cannot tell a team who or what its owner was looking at. The name, the one free
-- text, refuses an address or a telephone number. The checks are on the table, for every writer.
--
-- Only the owner changes a view, and only while they are staff covering its scope and, for a team view, hold the role.
-- Notification settings belong to one person and are read only by them; nothing is sent until they opt in.

CREATE FUNCTION trustwork.console_view_surfaces() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['inbox:waiting', 'inbox:mine', 'inbox:assigned', 'inbox:done', 'users:people', 'users:companies', 'users:staff', 'users:clients',
    'audit:events', 'audit:access', 'flags', 'incidents', 'moderation:cases', 'support:cases', 'pipelines:runs']::text[]
$$;
CREATE FUNCTION trustwork.console_notification_categories() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['approvals', 'case_grants', 'recovery', 'access_reviews', 'assigned_cases', 'appeals', 'incidents', 'alerts']::text[]
$$;
CREATE FUNCTION trustwork.console_view_value_ok(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_typeof(p_value) = 'string' AND (p_value #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$' AND (p_value #>> '{}') !~ '^[0-9]{7,}$'
$$;
-- ConsoleViewConfigurationSchema, for every writer.
CREATE FUNCTION trustwork.console_view_configuration_ok(p_configuration jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_key text;
  v_values jsonb;
  v_sort jsonb := p_configuration -> 'sort';
BEGIN
  IF jsonb_typeof(p_configuration) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_configuration) k) IS DISTINCT FROM ARRAY['columns', 'filters', 'sort']
     OR jsonb_typeof(p_configuration -> 'filters') <> 'object' OR jsonb_typeof(p_configuration -> 'columns') <> 'array' OR octet_length(p_configuration::text) > 8192 THEN
    RETURN false;
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_configuration -> 'filters')) > 20 OR jsonb_array_length(p_configuration -> 'columns') > 40 THEN
    RETURN false;
  END IF;
  FOR v_key, v_values IN SELECT e.key, e.value FROM jsonb_each(p_configuration -> 'filters') e LOOP
    IF v_key !~ '^[a-z][a-zA-Z0-9_.]{0,63}$' OR jsonb_typeof(v_values) <> 'array' OR jsonb_array_length(v_values) NOT BETWEEN 1 AND 20
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_values) v WHERE NOT trustwork.console_view_value_ok(v)) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_configuration -> 'columns') c WHERE jsonb_typeof(c) <> 'string' OR (c #>> '{}') !~ '^[a-z][a-zA-Z0-9_.]{0,63}$') THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(v_sort) <> 'null' AND (jsonb_typeof(v_sort) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_sort) k) IS DISTINCT FROM ARRAY['column', 'direction']
     OR coalesce(v_sort ->> 'column', '') !~ '^[a-z][a-zA-Z0-9_.]{0,63}$' OR coalesce(v_sort ->> 'direction', '') NOT IN ('ascending', 'descending')) THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

CREATE TABLE trustwork.console_saved_view (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  surface text NOT NULL CHECK (surface = ANY (trustwork.console_view_surfaces())),
  owner_person_id uuid NOT NULL REFERENCES trustwork.person (id) ON DELETE CASCADE,
  team_role text NULL CHECK (team_role = ANY (trustwork.admin_staff_roles())),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80 AND name = btrim(name) AND position('@' IN name) = 0 AND name !~ '[0-9][0-9 ()./-]{5,}[0-9]'),
  configuration jsonb NOT NULL CHECK (trustwork.console_view_configuration_ok(configuration)),
  is_default boolean NOT NULL DEFAULT false,
  removed_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT console_saved_view_scope_shape CHECK ((scope_kind = 'platform' AND node_id IS NULL AND hub_id IS NULL)
    OR (scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT console_saved_view_team_no_identifier CHECK (team_role IS NULL OR configuration::text !~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
);
CREATE INDEX console_saved_view_owner_idx ON trustwork.console_saved_view (owner_person_id, surface) WHERE removed_at IS NULL;
CREATE INDEX console_saved_view_team_idx ON trustwork.console_saved_view (hub_id, surface) WHERE team_role IS NOT NULL AND removed_at IS NULL;
-- At most one default per person, surface and scope.
CREATE UNIQUE INDEX console_saved_view_one_default ON trustwork.console_saved_view (owner_person_id, surface, scope_kind, coalesce(node_id, hub_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_default AND removed_at IS NULL;
CREATE FUNCTION trustwork.console_view_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF ROW(NEW.id, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.surface, NEW.owner_person_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.surface, OLD.owner_person_id, OLD.created_at) OR OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a view keeps its owner, scope and surface, and a removed view stays removed' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER console_saved_view_guard BEFORE UPDATE ON trustwork.console_saved_view FOR EACH ROW EXECUTE FUNCTION trustwork.console_view_guard();
CREATE TRIGGER console_saved_view_touch BEFORE UPDATE ON trustwork.console_saved_view FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.console_notification_setting (
  person_id uuid PRIMARY KEY REFERENCES trustwork.person (id) ON DELETE CASCADE,
  email_categories text[] NOT NULL DEFAULT '{}' CHECK (email_categories <@ trustwork.console_notification_categories() AND trustwork.admin_distinct(email_categories)),
  quiet_from_minute integer NULL CHECK (quiet_from_minute BETWEEN 0 AND 1439),
  quiet_until_minute integer NULL CHECK (quiet_until_minute BETWEEN 0 AND 1439),
  quiet_time_zone text NULL CHECK (length(quiet_time_zone) BETWEEN 1 AND 64),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT console_notification_quiet_shape CHECK ((quiet_from_minute IS NULL) = (quiet_until_minute IS NULL) AND (quiet_from_minute IS NULL) = (quiet_time_zone IS NULL)
    AND quiet_from_minute IS DISTINCT FROM coalesce(quiet_until_minute, -1))
);
CREATE TRIGGER console_notification_setting_touch BEFORE UPDATE ON trustwork.console_notification_setting FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Caller + elevation + any active role covering the target: what a staff member's own preferences need. The audit row
-- names the role found and the elevation they acted through. Invoker helper, called inside the commands below.
CREATE FUNCTION trustwork.console_actor(p_ctx jsonb, p_node uuid, p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_elevation uuid := trustwork.admin_require_elevation(p_ctx);
  v_person uuid := trustwork.current_person_id();
  v_role record;
BEGIN
  SELECT a.role, a.breakglass INTO v_role FROM trustwork.staff_role_assignment a
   WHERE a.person_id = v_person AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
     AND CASE a.scope_kind WHEN 'platform' THEN true WHEN 'node' THEN p_hub IS NOT NULL OR p_node = a.node_id ELSE p_hub = a.hub_id END
   ORDER BY a.breakglass, a.valid_from, a.id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no staff role covers this scope' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  RETURN ROW(v_person, v_role.role, v_role.breakglass, v_elevation, 'admin.session.elevate')::trustwork.admin_actor;
END $$;

-- One person's view commands run one at a time, so the limit and the single default hold under concurrent requests.
CREATE FUNCTION trustwork.console_lock_person(p_person uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('console_person:' || p_person::text, 0))
$$;
CREATE FUNCTION trustwork.console_view_require_team(p_actor trustwork.admin_actor, p_team_role text, p_node uuid, p_hub uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_team_role IS NOT NULL AND NOT trustwork.admin_person_is_staff(p_actor.person_id, p_node, p_hub, p_team_role) THEN
    RAISE EXCEPTION 'a view is shared only with a team one belongs to' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
END $$;

CREATE FUNCTION trustwork.console_view_create(p_ctx jsonb, p_node uuid, p_hub uuid, p_surface text, p_name text, p_configuration jsonb, p_team_role text, p_is_default boolean)
RETURNS trustwork.console_saved_view
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := CASE WHEN p_hub IS NULL THEN p_node END;
  v_actor trustwork.admin_actor := trustwork.console_actor(p_ctx, v_node, p_hub);
  v_row trustwork.console_saved_view%ROWTYPE;
BEGIN
  PERFORM trustwork.console_view_require_team(v_actor, p_team_role, v_node, p_hub);
  PERFORM trustwork.console_lock_person(v_actor.person_id);
  IF (SELECT count(*) FROM trustwork.console_saved_view v WHERE v.owner_person_id = v_actor.person_id AND v.removed_at IS NULL) >= 100 THEN
    RAISE EXCEPTION 'a person keeps at most 100 views' USING ERRCODE = 'check_violation', HINT = 'admin.view_limit';
  END IF;
  IF p_is_default THEN
    UPDATE trustwork.console_saved_view v SET is_default = false
     WHERE v.owner_person_id = v_actor.person_id AND v.surface = p_surface AND v.is_default AND v.removed_at IS NULL AND v.node_id IS NOT DISTINCT FROM v_node AND v.hub_id IS NOT DISTINCT FROM p_hub;
  END IF;
  INSERT INTO trustwork.console_saved_view (scope_kind, node_id, hub_id, surface, owner_person_id, team_role, name, configuration, is_default)
  VALUES (trustwork.admin_scope_kind(v_node, p_hub), v_node, p_hub, p_surface, v_actor.person_id, p_team_role, p_name, p_configuration, p_is_default) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, p_hub, 'console.view_created', 'console_saved_view', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.console_view_update(p_ctx jsonb, p_view uuid, p_expected_revision integer, p_name text, p_configuration jsonb, p_team_role text, p_is_default boolean)
RETURNS trustwork.console_saved_view
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_before trustwork.console_saved_view%ROWTYPE;
  v_row trustwork.console_saved_view%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  PERFORM trustwork.console_lock_person(v_person);
  SELECT * INTO v_before FROM trustwork.console_saved_view WHERE id = p_view AND owner_person_id = v_person AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such view' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.console_actor(p_ctx, v_before.node_id, v_before.hub_id);
  PERFORM trustwork.console_view_require_team(v_actor, p_team_role, v_before.node_id, v_before.hub_id);
  IF p_expected_revision IS DISTINCT FROM v_before.revision THEN
    RAISE EXCEPTION 'the view changed' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF p_is_default THEN
    UPDATE trustwork.console_saved_view v SET is_default = false
     WHERE v.owner_person_id = v_person AND v.id <> p_view AND v.surface = v_before.surface AND v.is_default AND v.removed_at IS NULL
       AND v.node_id IS NOT DISTINCT FROM v_before.node_id AND v.hub_id IS NOT DISTINCT FROM v_before.hub_id;
  END IF;
  UPDATE trustwork.console_saved_view SET name = p_name, configuration = p_configuration, team_role = p_team_role, is_default = p_is_default WHERE id = p_view RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'console.view_updated', 'console_saved_view', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.console_view_remove(p_ctx jsonb, p_view uuid, p_expected_revision integer) RETURNS trustwork.console_saved_view
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_before trustwork.console_saved_view%ROWTYPE;
  v_row trustwork.console_saved_view%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  PERFORM trustwork.console_lock_person(v_person);
  SELECT * INTO v_before FROM trustwork.console_saved_view WHERE id = p_view AND owner_person_id = v_person AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such view' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.console_actor(p_ctx, v_before.node_id, v_before.hub_id);
  IF p_expected_revision IS DISTINCT FROM v_before.revision THEN
    RAISE EXCEPTION 'the view changed' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.console_saved_view SET removed_at = now(), is_default = false WHERE id = p_view RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'console.view_removed', 'console_saved_view', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- p_expected_revision 0: the person has no settings yet. The scope is where the audit row is written.
CREATE FUNCTION trustwork.console_notifications_set(p_ctx jsonb, p_node uuid, p_hub uuid, p_expected_revision integer, p_categories text[], p_quiet_from integer, p_quiet_until integer, p_time_zone text)
RETURNS trustwork.console_notification_setting
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := CASE WHEN p_hub IS NULL THEN p_node END;
  v_actor trustwork.admin_actor := trustwork.console_actor(p_ctx, v_node, p_hub);
  v_before trustwork.console_notification_setting%ROWTYPE;
  v_row trustwork.console_notification_setting%ROWTYPE;
BEGIN
  IF p_time_zone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = p_time_zone) THEN
    RAISE EXCEPTION 'unknown time zone' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  PERFORM trustwork.console_lock_person(v_actor.person_id);
  SELECT * INTO v_before FROM trustwork.console_notification_setting WHERE person_id = v_actor.person_id FOR UPDATE;
  IF p_expected_revision IS DISTINCT FROM coalesce(v_before.revision, 0) THEN
    RAISE EXCEPTION 'the settings changed' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  INSERT INTO trustwork.console_notification_setting (person_id, email_categories, quiet_from_minute, quiet_until_minute, quiet_time_zone)
  VALUES (v_actor.person_id, p_categories, p_quiet_from, p_quiet_until, p_time_zone)
  ON CONFLICT (person_id) DO UPDATE SET email_categories = EXCLUDED.email_categories, quiet_from_minute = EXCLUDED.quiet_from_minute, quiet_until_minute = EXCLUDED.quiet_until_minute,
    quiet_time_zone = EXCLUDED.quiet_time_zone RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, p_hub, 'console.notifications_set', 'console_notification_setting', v_actor.person_id,
    CASE WHEN v_before.person_id IS NULL THEN NULL ELSE to_jsonb(v_before) END, to_jsonb(v_row));
  RETURN v_row;
END $$;

ALTER TABLE trustwork.console_saved_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.console_saved_view FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.console_notification_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.console_notification_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.console_saved_view AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.console_notification_setting AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- The reader is staff covering the view's scope and owns it, or holds its team role there. A removed view is gone.
CREATE POLICY console_saved_view_read ON trustwork.console_saved_view FOR SELECT TO trustwork_app
  USING (removed_at IS NULL AND trustwork.console_is_staff(node_id, hub_id)
         AND (owner_person_id = trustwork.current_person_id() OR (team_role IS NOT NULL AND trustwork.console_holds_role(team_role, node_id, hub_id))));
CREATE POLICY console_notification_setting_read ON trustwork.console_notification_setting FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());
GRANT SELECT ON trustwork.console_saved_view, trustwork.console_notification_setting TO trustwork_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.console_view_create(jsonb, uuid, uuid, text, text, jsonb, text, boolean), trustwork.console_view_update(jsonb, uuid, integer, text, jsonb, text, boolean),
  trustwork.console_view_remove(jsonb, uuid, integer), trustwork.console_notifications_set(jsonb, uuid, uuid, integer, text[], integer, integer, text) TO trustwork_app;
