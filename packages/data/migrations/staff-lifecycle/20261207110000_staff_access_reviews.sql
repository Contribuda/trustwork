-- ADM-004 part 4: access-review campaigns (docs/engine/hub-console/console-design.md, section 4.2 "Access reviews").
-- Contract: packages/contracts/src/staff-lifecycle.ts.
--
-- A campaign lists the active assignments held exactly at its scope (optionally of some roles) when it opens, with a
-- deadline. A reviewer who is not the holder marks each item keep or remove with a reason; "remove" revokes the role
-- through the ADM-001 assignment guard in the same transaction (the reviewer holds admin.staff.revoke at the scope).
-- Nothing is ever removed silently: an item unanswered at the deadline is *escalated*, which means only a holder of the
-- scope's owner role (hub-owner, node-operator or platform-owner) may still decide it; the state is computed from the
-- deadline at every read, so no job has to run. The campaign closes by itself with the last decision and the audit row
-- carries the kept and removed counts; a campaign opened by mistake is withdrawn with a reason, never deleted.
--
-- No item records what the holder did: no last use, counts or any other activity (the design's last-use question stays
-- open with the owner and is deliberately not implemented).

CREATE TABLE trustwork.staff_access_review_campaign (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  roles text[] NULL CHECK (roles IS NULL OR (cardinality(roles) >= 1 AND roles <@ trustwork.admin_staff_roles() AND trustwork.admin_distinct(roles))),
  due_at timestamptz NOT NULL,
  opened_by uuid NOT NULL REFERENCES trustwork.person (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'withdrawn')),
  closed_at timestamptz NULL,
  closed_by uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_access_review_campaign_scope_shape CHECK ((scope_kind = 'platform' AND node_id IS NULL AND hub_id IS NULL)
    OR (scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT staff_access_review_campaign_closed_shape CHECK ((status = 'open') = (closed_at IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL))
);
CREATE INDEX staff_access_review_campaign_hub_idx ON trustwork.staff_access_review_campaign (hub_id, created_at DESC) WHERE hub_id IS NOT NULL;

CREATE TABLE trustwork.staff_access_review_item (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  campaign_id uuid NOT NULL REFERENCES trustwork.staff_access_review_campaign (id),
  assignment_id uuid NOT NULL REFERENCES trustwork.staff_role_assignment (id),
  holder_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  role text NOT NULL CHECK (role = ANY (trustwork.admin_staff_roles())),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  verdict text NULL CHECK (verdict IN ('keep', 'remove')),
  effect text NULL CHECK (effect IN ('kept', 'revoked', 'already_ended')),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  decision_reason text NULL CHECK (length(decision_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_access_review_item_once UNIQUE (campaign_id, assignment_id),
  CONSTRAINT staff_access_review_item_not_self CHECK (decided_by IS NULL OR decided_by <> holder_person_id),
  CONSTRAINT staff_access_review_item_decision_shape CHECK ((verdict IS NULL) = (decided_by IS NULL) AND (verdict IS NULL) = (decided_at IS NULL)
    AND (verdict IS NULL) = (decision_reason IS NULL) AND (verdict IS NULL) = (effect IS NULL)
    AND (verdict IS NULL OR (verdict = 'keep' AND effect IN ('kept', 'already_ended')) OR (verdict = 'remove' AND effect IN ('revoked', 'already_ended'))))
);
CREATE INDEX staff_access_review_item_campaign_idx ON trustwork.staff_access_review_item (campaign_id);
CREATE INDEX staff_access_review_item_holder_idx ON trustwork.staff_access_review_item (holder_person_id) WHERE verdict IS NULL;

CREATE FUNCTION trustwork.staff_access_review_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'access reviews are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.revision := 1;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'staff_access_review_campaign' THEN
    IF ROW(NEW.id, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.title, NEW.roles, NEW.due_at, NEW.opened_by, NEW.reason, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.title, OLD.roles, OLD.due_at, OLD.opened_by, OLD.reason, OLD.created_at)
       OR OLD.status <> 'open' THEN
      RAISE EXCEPTION 'a campaign''s terms are immutable and a closed campaign is final' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.campaign_id, NEW.assignment_id, NEW.holder_person_id, NEW.role, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.campaign_id, OLD.assignment_id, OLD.holder_person_id, OLD.role, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.created_at)
       OR OLD.verdict IS NOT NULL THEN
      RAISE EXCEPTION 'a review item is decided once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
    NEW.decided_at := now();
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_access_review_campaign_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.staff_access_review_campaign FOR EACH ROW EXECUTE FUNCTION trustwork.staff_access_review_guard();
CREATE TRIGGER staff_access_review_item_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.staff_access_review_item FOR EACH ROW EXECUTE FUNCTION trustwork.staff_access_review_guard();

-- The campaign's audit image carries its tallies; no item image names what a holder did.
CREATE FUNCTION trustwork.staff_access_review_image(p staff_access_review_campaign) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'scope', trustwork.admin_scope_json(p.scope_kind, p.node_id, p.hub_id), 'title', p.title, 'roles', to_jsonb(p.roles), 'dueAt', p.due_at,
    'openedBy', p.opened_by, 'status', p.status, 'closedBy', p.closed_by, 'revision', p.revision,
    'kept', (SELECT count(*) FROM trustwork.staff_access_review_item i WHERE i.campaign_id = p.id AND i.verdict = 'keep'),
    'removed', (SELECT count(*) FROM trustwork.staff_access_review_item i WHERE i.campaign_id = p.id AND i.verdict = 'remove'),
    'pending', (SELECT count(*) FROM trustwork.staff_access_review_item i WHERE i.campaign_id = p.id AND i.verdict IS NULL))
$$;
CREATE FUNCTION trustwork.staff_access_review_item_image(p staff_access_review_item) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'campaignId', p.campaign_id, 'assignmentId', p.assignment_id, 'holderPersonId', p.holder_person_id, 'role', p.role,
    'verdict', p.verdict, 'effect', p.effect, 'decidedBy', p.decided_by, 'revision', p.revision)
$$;

-- The owner role of a scope: who decides what was left unanswered at the deadline.
CREATE FUNCTION trustwork.staff_scope_owner_role(p_scope_kind text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_scope_kind WHEN 'hub' THEN 'hub-owner' WHEN 'node' THEN 'node-operator' ELSE 'platform-owner' END
$$;

-- 1. Open ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.staff_access_review_open(p_ctx jsonb, p_scope_kind text, p_node uuid, p_hub uuid, p_title text, p_roles text[], p_due_in_seconds bigint)
RETURNS trustwork.staff_access_review_campaign
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_target record;
  v_actor trustwork.admin_actor;
  v_row trustwork.staff_access_review_campaign%ROWTYPE;
  v_items integer;
BEGIN
  SELECT * INTO v_target FROM trustwork.admin_target(p_scope_kind, p_node, p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.revoke'], v_target.node, v_target.hub);
  IF p_due_in_seconds IS NULL OR p_due_in_seconds < 86400 OR p_due_in_seconds > 90 * 86400 THEN
    RAISE EXCEPTION 'a review is due between one and ninety days from now' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  INSERT INTO trustwork.staff_access_review_campaign (scope_kind, node_id, hub_id, title, roles, due_at, opened_by, reason)
  VALUES (p_scope_kind, v_target.node, v_target.hub, p_title, p_roles, now() + make_interval(secs => p_due_in_seconds), v_actor.person_id, p_ctx ->> 'reasonText')
  RETURNING * INTO v_row;
  -- The standing assignments held exactly at this scope; break-glass and just-in-time activations are reviewed by their own rules.
  INSERT INTO trustwork.staff_access_review_item (campaign_id, assignment_id, holder_person_id, role, scope_kind, node_id, hub_id)
  SELECT v_row.id, a.id, a.person_id, a.role, a.scope_kind, a.node_id, a.hub_id
    FROM trustwork.staff_role_assignment a
   WHERE a.scope_kind = p_scope_kind AND a.node_id IS NOT DISTINCT FROM v_target.node AND a.hub_id IS NOT DISTINCT FROM v_target.hub
     AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now()) AND NOT a.breakglass
     AND NOT EXISTS (SELECT 1 FROM trustwork.staff_activation x WHERE x.assignment_id = a.id)
     AND (p_roles IS NULL OR a.role = ANY (p_roles));
  GET DIAGNOSTICS v_items = ROW_COUNT;
  IF v_items = 0 THEN
    RAISE EXCEPTION 'nothing to review at this scope' USING ERRCODE = 'no_data_found', HINT = 'admin.review_empty';
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.access_review_opened', 'staff_access_review_campaign', v_row.id, NULL, trustwork.staff_access_review_image(v_row));
  RETURN v_row;
END $$;

-- 2. Decide one item --------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.staff_access_review_decide(p_ctx jsonb, p_item uuid, p_verdict text) RETURNS trustwork.staff_access_review_item
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.staff_access_review_item%ROWTYPE;
  v_row trustwork.staff_access_review_item%ROWTYPE;
  v_campaign trustwork.staff_access_review_campaign%ROWTYPE;
  v_campaign_after trustwork.staff_access_review_campaign%ROWTYPE;
  v_target record;
  v_actor trustwork.admin_actor;
  v_assignment trustwork.staff_role_assignment%ROWTYPE;
  v_effect text;
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_access_review_item WHERE id = p_item FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such review item' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT * INTO v_campaign FROM trustwork.staff_access_review_campaign WHERE id = v_before.campaign_id FOR UPDATE;
  SELECT * INTO v_target FROM trustwork.admin_target(v_before.scope_kind, v_before.node_id, v_before.hub_id);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.revoke'], v_target.node, v_target.hub);
  IF v_actor.person_id = v_before.holder_person_id THEN
    RAISE EXCEPTION 'nobody reviews their own access' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_review';
  END IF;
  IF p_verdict NOT IN ('keep', 'remove') THEN
    RAISE EXCEPTION 'verdict is keep or remove' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  IF v_campaign.status <> 'open' THEN
    RAISE EXCEPTION 'the campaign is %', v_campaign.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF v_before.verdict IS NOT NULL THEN
    RAISE EXCEPTION 'the item is decided' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  -- Past the deadline the item is escalated: only the scope's owner role decides it; nothing is removed silently.
  IF v_campaign.due_at <= now() AND NOT trustwork.admin_person_is_staff(v_actor.person_id, v_target.node, v_target.hub, trustwork.staff_scope_owner_role(v_before.scope_kind)) THEN
    RAISE EXCEPTION 'the item is escalated to the % after the deadline', trustwork.staff_scope_owner_role(v_before.scope_kind) USING ERRCODE = 'insufficient_privilege', HINT = 'admin.review_escalated';
  END IF;
  SELECT * INTO v_assignment FROM trustwork.staff_role_assignment WHERE id = v_before.assignment_id FOR UPDATE;
  IF v_assignment.revoked_at IS NOT NULL OR (v_assignment.valid_until IS NOT NULL AND v_assignment.valid_until <= now()) THEN
    v_effect := 'already_ended';
  ELSIF p_verdict = 'remove' THEN
    UPDATE trustwork.staff_role_assignment SET revoked_at = now(), revoked_by = v_actor.person_id, revoke_reason = p_ctx ->> 'reasonText' WHERE id = v_assignment.id;
    v_effect := 'revoked';
  ELSE
    v_effect := 'kept';
  END IF;
  UPDATE trustwork.staff_access_review_item SET verdict = p_verdict, effect = v_effect, decided_by = v_actor.person_id, decided_at = now(), decision_reason = p_ctx ->> 'reasonText'
   WHERE id = v_before.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.access_review_decided', 'staff_access_review_item', v_row.id,
    trustwork.staff_access_review_item_image(v_before), trustwork.staff_access_review_item_image(v_row));
  IF NOT EXISTS (SELECT 1 FROM trustwork.staff_access_review_item i WHERE i.campaign_id = v_campaign.id AND i.verdict IS NULL) THEN
    UPDATE trustwork.staff_access_review_campaign SET status = 'closed', closed_at = now(), closed_by = v_actor.person_id WHERE id = v_campaign.id RETURNING * INTO v_campaign_after;
    PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.access_review_closed', 'staff_access_review_campaign', v_campaign.id,
      trustwork.staff_access_review_image(v_campaign), trustwork.staff_access_review_image(v_campaign_after));
  END IF;
  RETURN v_row;
END $$;

-- 3. Withdraw a campaign opened by mistake (its undecided items stay undecided: no removal ever happens silently) ------
CREATE FUNCTION trustwork.staff_access_review_withdraw(p_ctx jsonb, p_campaign uuid) RETURNS trustwork.staff_access_review_campaign
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.staff_access_review_campaign%ROWTYPE;
  v_row trustwork.staff_access_review_campaign%ROWTYPE;
  v_target record;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_access_review_campaign WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT * INTO v_target FROM trustwork.admin_target(v_before.scope_kind, v_before.node_id, v_before.hub_id);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.revoke'], v_target.node, v_target.hub);
  IF v_before.status <> 'open' THEN
    RAISE EXCEPTION 'the campaign is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.staff_access_review_campaign SET status = 'withdrawn', closed_at = now(), closed_by = v_actor.person_id WHERE id = v_before.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.access_review_withdrawn', 'staff_access_review_campaign', v_row.id,
    trustwork.staff_access_review_image(v_before), trustwork.staff_access_review_image(v_row));
  RETURN v_row;
END $$;

-- 4. Reads: staff with admin.staff.read at the scope ----------------------------------------------------------------
ALTER TABLE trustwork.staff_access_review_campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_access_review_campaign FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_access_review_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_access_review_item FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.staff_access_review_campaign AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.staff_access_review_item AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY staff_access_review_campaign_read ON trustwork.staff_access_review_campaign FOR SELECT TO trustwork_app USING (trustwork.admin_has_permission('admin.staff.read', node_id, hub_id));
CREATE POLICY staff_access_review_item_read ON trustwork.staff_access_review_item FOR SELECT TO trustwork_app USING (trustwork.admin_has_permission('admin.staff.read', node_id, hub_id));
GRANT SELECT ON trustwork.staff_access_review_campaign, trustwork.staff_access_review_item TO trustwork_app;

GRANT EXECUTE ON FUNCTION trustwork.staff_access_review_open(jsonb, text, uuid, uuid, text, text[], bigint), trustwork.staff_access_review_decide(jsonb, uuid, text),
  trustwork.staff_access_review_withdraw(jsonb, uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
