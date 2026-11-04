-- ADM-005 part 2: the console's object lookup and the work-item read model (docs/engine/hub-console/console-design.md,
-- sections 3.4 and 3.5; contract packages/contracts/src/console-services.ts).
--
-- Both reads are ordinary invoker functions: they run as the staff member under FORCE row-level security, so a row the
-- policies hide cannot be reached, and on top of that each branch states the staff read permission that owns the object.
-- The second gate matters because several policies also admit the *participant* side of a row (the subject of a
-- moderation case, the requester of a support case, an appellant): a staff member who is that participant reads it
-- through their own screens, never as a console object. Nothing is found:
--   * outside the exact target (one hub, the node or the platform): a person covering two hubs gets neither hub's
--     objects while acting on the other;
--   * for a person who is not staff covering the target, whatever other hub they serve;
--   * about the reader, their employer or a party they declared (admin_conflicted), for support cases, moderation cases
--     and appeals: the console routes those to someone else.
-- Output is identifiers and codes. No column of free text is read here: not support_case.summary, incident.title,
-- second_person_approval.reason, case_access_grant.purpose or appeal.reason. An audit event is found by its id, sequence
-- or request id and never by object_id, which may name a person. Participant tables are not touched at all.
--
-- The SECURITY DEFINER helpers answer one question about the *caller* and take no person, so nobody can ask them about
-- someone else; they exist because the assignments covering a hub are not all readable under row-level security.

CREATE FUNCTION trustwork.console_is_staff(p_node uuid, p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.admin_person_is_staff(trustwork.current_person_id(), p_node, p_hub)
$$;
-- The role through which the caller holds one of the permissions at the target; NULL when none.
CREATE FUNCTION trustwork.console_role_holding(p_permissions text[], p_node uuid, p_hub uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r.role FROM trustwork.admin_resolve_any(trustwork.current_person_id(), p_permissions, p_node, p_hub) r
$$;
CREATE FUNCTION trustwork.console_conflicted(p_party_person uuid, p_party_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.admin_conflicted(trustwork.current_person_id(), p_party_person, p_party_company)
$$;
-- Would the database let the caller decide this pending approval? Holding the action's permission is checked by the
-- reader; this adds what admin_decide_approval and support_activate_action refuse later: the full-mode different-role
-- rule of the staff actions, and an approver who is the subject of an account servicing action or conflicted with them.
CREATE FUNCTION trustwork.console_approval_decidable(p_approval uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT NOT EXISTS (SELECT 1 FROM trustwork.account_service_action s WHERE s.approval_id = a.id
                      AND trustwork.admin_conflicted(trustwork.current_person_id(), s.subject_person_id, NULL))
     AND NOT (a.action IN ('staff.assign_sensitive_role', 'staff.grant_breakglass') AND trustwork.staff_sod_full(a.node_id, a.hub_id)
              AND trustwork.staff_roles_for_action(trustwork.current_person_id(), a.action, a.node_id, a.hub_id)
                  <@ trustwork.staff_roles_for_action(a.requested_by, a.action, a.node_id, a.hub_id))
    FROM trustwork.second_person_approval a WHERE a.id = p_approval
$$;
-- Does the caller hold this role at a scope covering the target? After its deadline an access-review item is decided only
-- by the scope's owner role; a team view is read by the holders of its role.
CREATE FUNCTION trustwork.console_holds_role(p_role text, p_node uuid, p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.admin_person_is_staff(trustwork.current_person_id(), p_node, p_hub, p_role)
$$;

-- Timestamps as the contract writes them (RFC 3339, UTC, `Z`).
CREATE FUNCTION trustwork.console_ts(p_at timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- The lookup behind the palette's `#`: exact identifiers only, so there is nothing to suggest or to count. Every branch
-- runs for every call, and the order is the fixed order of kinds, then a number or id the reader sees.
CREATE FUNCTION trustwork.console_search(p_id uuid, p_number bigint, p_key text, p_node uuid, p_hub uuid)
RETURNS TABLE (hit jsonb)
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_me uuid := trustwork.current_person_id();
  v_staff boolean := false;
BEGIN
  IF v_me IS NULL OR NOT trustwork.console_is_staff(p_node, p_hub) THEN
    RETURN;
  END IF;
  IF p_id IS NOT NULL AND trustwork.admin_has_permission('admin.staff.read', p_node, p_hub) THEN
    IF p_hub IS NOT NULL THEN
      -- The directory answers "not found" for an unknown hub; here that is the same empty answer as anything else.
      BEGIN
        v_staff := EXISTS (SELECT 1 FROM trustwork.staff_directory(p_hub) d WHERE d.person_id = p_id);
      EXCEPTION WHEN no_data_found THEN
        v_staff := false;
      END;
    ELSE
      v_staff := EXISTS (SELECT 1 FROM trustwork.staff_role_assignment a WHERE a.person_id = p_id AND a.revoked_at IS NULL AND a.valid_from <= now()
                          AND (a.valid_until IS NULL OR a.valid_until > now()) AND a.node_id IS NOT DISTINCT FROM p_node AND a.hub_id IS NULL);
    END IF;
  END IF;
  RETURN QUERY
  SELECT r.doc FROM (
    SELECT 1 AS place, 0::bigint AS tie, a.id AS id,
           jsonb_build_object('kind', 'approval', 'id', a.id, 'scope', trustwork.admin_scope_json(a.scope_kind, a.node_id, a.hub_id), 'action', a.action, 'status', a.status) AS doc
      FROM trustwork.second_person_approval a
     WHERE a.id = p_id AND a.node_id IS NOT DISTINCT FROM p_node AND a.hub_id IS NOT DISTINCT FROM p_hub
    UNION ALL
    SELECT 2, 0, v.id, jsonb_build_object('kind', 'config_version', 'id', v.id, 'scope', trustwork.admin_scope_json('hub', NULL, v.hub_id), 'domain', v.domain, 'version', v.version, 'status', v.status)
      FROM trustwork.hub_config_version v WHERE v.id = p_id AND v.hub_id = p_hub
    UNION ALL
    SELECT 3, 0, i.id, jsonb_build_object('kind', 'incident', 'id', i.id, 'scope', trustwork.admin_scope_json(i.scope_kind, i.node_id, i.hub_id), 'incidentKind', i.kind, 'severity', i.severity, 'status', i.status)
      FROM trustwork.incident i WHERE i.id = p_id AND i.node_id IS NOT DISTINCT FROM p_node AND i.hub_id IS NOT DISTINCT FROM p_hub
    UNION ALL
    SELECT 4, c.number, c.id, jsonb_build_object('kind', 'support_case', 'id', c.id, 'scope', trustwork.admin_scope_json('hub', NULL, c.hub_id), 'number', c.number, 'status', c.status)
      FROM trustwork.support_case c
     WHERE (c.id = p_id OR c.number = p_number) AND c.hub_id = p_hub
       AND trustwork.admin_has_any_permission(trustwork.admin_support_permissions(), NULL, c.hub_id)
       AND c.requester_person_id <> v_me AND NOT trustwork.console_conflicted(c.subject_person_id, c.subject_company_id)
    UNION ALL
    SELECT 5, 0, m.id, jsonb_build_object('kind', 'moderation_case', 'id', m.id, 'scope', trustwork.admin_scope_json('hub', NULL, m.hub_id), 'status', m.status)
      FROM trustwork.moderation_case m
     WHERE m.id = p_id AND m.hub_id = p_hub AND trustwork.admin_has_permission('admin.moderation.read', NULL, m.hub_id)
       AND NOT trustwork.console_conflicted(m.subject_person_id, m.subject_company_id)
    UNION ALL
    SELECT 6, 0, l.id, jsonb_build_object('kind', 'appeal', 'id', l.id, 'scope', trustwork.admin_scope_json('hub', NULL, l.hub_id), 'status', l.status)
      FROM trustwork.appeal l
     WHERE l.id = p_id AND l.hub_id = p_hub
       AND trustwork.admin_has_any_permission(ARRAY['admin.moderation.read', 'admin.moderation.appeal.decide', 'admin.trust.appeals.decide'], NULL, l.hub_id)
       AND NOT trustwork.console_conflicted(l.appellant_person_id, l.appellant_company_id)
    UNION ALL
    SELECT 7, 0, u.id, jsonb_build_object('kind', 'pipeline_run', 'id', u.id, 'scope', trustwork.admin_scope_json('hub', NULL, u.hub_id), 'state', u.state, 'dryRun', u.dry_run)
      FROM trustwork.pipeline_run u WHERE u.id = p_id AND u.hub_id = p_hub
    UNION ALL
    SELECT 8, e.sequence, e.id, jsonb_build_object('kind', 'audit_event', 'id', e.id, 'scope', trustwork.admin_scope_json(e.scope_kind, e.node_id, e.hub_id), 'sequence', e.sequence,
             'action', e.action, 'outcome', e.outcome, 'occurredAt', trustwork.console_ts(e.occurred_at))
      FROM trustwork.admin_audit_event e
     WHERE (e.id = p_id OR e.sequence = p_number OR e.request_id = p_id::text) AND e.node_id IS NOT DISTINCT FROM p_node AND e.hub_id IS NOT DISTINCT FROM p_hub
    UNION ALL
    SELECT 9, 0, f.id, jsonb_build_object('kind', 'flag', 'id', f.id, 'scope', trustwork.admin_scope_json(f.scope_kind, f.node_id, f.hub_id), 'key', f.key, 'stage', o.stage,
             'sharePercent', o.share_percent, 'expiresAt', trustwork.console_ts(f.expires_at))
      FROM trustwork.feature_flag f JOIN trustwork.feature_flag_rollout o ON o.flag_id = f.id
     WHERE (f.id = p_id OR f.key = p_key) AND f.node_id IS NOT DISTINCT FROM p_node AND f.hub_id IS NOT DISTINCT FROM p_hub
    UNION ALL
    SELECT 10, 0, p_id, jsonb_build_object('kind', 'staff', 'id', p_id, 'scope', trustwork.admin_scope_json(trustwork.admin_scope_kind(p_node, p_hub), p_node, p_hub))
     WHERE v_staff
  ) r
  ORDER BY r.place, r.tie, r.id
  LIMIT 20;
END $$;

-- One row of the inbox (ConsoleWorkItemSchema).
CREATE FUNCTION trustwork.console_work_row(p_kind text, p_id uuid, p_scope_kind text, p_node uuid, p_hub uuid, p_state text, p_action text, p_severity text, p_role text,
  p_requested_by uuid, p_at timestamptz, p_expires_at timestamptz, p_reason jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('kind', p_kind, 'id', p_id, 'scope', trustwork.admin_scope_json(p_scope_kind, p_node, p_hub), 'state', p_state, 'action', p_action, 'severity', p_severity,
    'role', p_role, 'requestedBy', p_requested_by, 'at', trustwork.console_ts(p_at), 'expiresAt', trustwork.console_ts(p_expires_at), 'reason', p_reason)
$$;
CREATE FUNCTION trustwork.console_work_kind(p_action text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_action IN ('support.reset_second_factor', 'support.rebind_recovery_email') THEN 'recovery_escalation' ELSE 'approval' END
$$;

-- The staff member's work at one target, each row with the reason it is theirs (console-design 3.5). `waiting`: what they
-- may decide now, excluding what the deciding command would refuse them. `mine`: what they asked for. `assigned`: cases,
-- appeals, incidents and alerts they are on. `done`: their decisions of the last 90 days. A row is here only while its
-- owner's read rule still admits the viewer, so losing a role takes the work with it. At most 501 rows, so the caller
-- can say that more exist; rows are ordered by a date in the row. Operator Agent team review items join here when
-- AGT-030 gives them a table.
CREATE FUNCTION trustwork.console_work_items(p_view text, p_node uuid, p_hub uuid)
RETURNS TABLE (item jsonb)
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_me uuid := trustwork.current_person_id();
BEGIN
  IF v_me IS NULL OR NOT trustwork.console_is_staff(p_node, p_hub) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT r.doc FROM (
    -- Waiting for me: second-person approvals and recovery escalations.
    SELECT a.request_expires_at AS due, a.id AS id, trustwork.console_work_row(trustwork.console_work_kind(a.action), a.id, a.scope_kind, a.node_id, a.hub_id, a.status, a.action, NULL, NULL, a.requested_by,
             a.requested_at, a.request_expires_at, jsonb_build_object('code', 'holds_role', 'role', h.role)) AS doc
      FROM trustwork.second_person_approval a
      CROSS JOIN LATERAL (SELECT trustwork.console_role_holding(trustwork.admin_action_permissions(a.action), a.node_id, a.hub_id) AS role) h
     WHERE p_view = 'waiting' AND a.status = 'pending' AND a.requested_by <> v_me AND a.request_expires_at > now() AND h.role IS NOT NULL
       AND a.node_id IS NOT DISTINCT FROM p_node AND a.hub_id IS NOT DISTINCT FROM p_hub AND trustwork.console_approval_decidable(a.id)
    UNION ALL
    -- Waiting for me: case grants, never on one's own request, account, employer or a declared party.
    SELECT g.requested_at, g.id, trustwork.console_work_row('case_grant', g.id, 'hub', NULL, g.hub_id, g.status, NULL, NULL, NULL, g.requested_by, g.requested_at, NULL,
             jsonb_build_object('code', 'holds_role', 'role', h.role))
      FROM trustwork.case_access_grant g
      JOIN trustwork.support_case c ON c.id = g.support_case_id
      CROSS JOIN LATERAL (SELECT trustwork.console_role_holding(ARRAY['admin.support.grant.approve'], NULL, g.hub_id) AS role) h
     WHERE p_view = 'waiting' AND g.status = 'requested' AND g.requested_by <> v_me AND g.hub_id = p_hub AND h.role IS NOT NULL
       AND c.requester_person_id <> v_me AND NOT trustwork.console_conflicted(c.subject_person_id, c.subject_company_id)
    UNION ALL
    -- Waiting for me: access-review items, never one's own access; past the deadline only for the owner role.
    SELECT c.due_at, i.id, trustwork.console_work_row('access_review_item', i.id, i.scope_kind, i.node_id, i.hub_id, 'pending', NULL, NULL, i.role, NULL, i.created_at, c.due_at,
             CASE WHEN c.due_at > now() THEN jsonb_build_object('code', 'holds_role', 'role', h.role)
                  ELSE jsonb_build_object('code', 'escalated_to_owner_role', 'role', trustwork.staff_scope_owner_role(i.scope_kind)) END)
      FROM trustwork.staff_access_review_item i
      JOIN trustwork.staff_access_review_campaign c ON c.id = i.campaign_id
      CROSS JOIN LATERAL (SELECT trustwork.console_role_holding(ARRAY['admin.staff.revoke'], i.node_id, i.hub_id) AS role) h
     WHERE p_view = 'waiting' AND i.verdict IS NULL AND c.status = 'open' AND i.holder_person_id <> v_me AND h.role IS NOT NULL
       AND i.node_id IS NOT DISTINCT FROM p_node AND i.hub_id IS NOT DISTINCT FROM p_hub
       AND (c.due_at > now() OR trustwork.console_holds_role(trustwork.staff_scope_owner_role(i.scope_kind), i.node_id, i.hub_id))
    UNION ALL
    -- My requests.
    SELECT CASE a.status WHEN 'pending' THEN a.request_expires_at ELSE a.expires_at END, a.id,
           trustwork.console_work_row(trustwork.console_work_kind(a.action), a.id, a.scope_kind, a.node_id, a.hub_id, a.status, a.action, NULL, NULL, a.requested_by, a.requested_at,
             CASE a.status WHEN 'pending' THEN a.request_expires_at ELSE a.expires_at END, jsonb_build_object('code', 'requested_by_you'))
      FROM trustwork.second_person_approval a
     WHERE p_view = 'mine' AND a.requested_by = v_me AND a.node_id IS NOT DISTINCT FROM p_node AND a.hub_id IS NOT DISTINCT FROM p_hub
       AND ((a.status = 'pending' AND a.request_expires_at > now()) OR (a.status = 'approved' AND a.expires_at > now()))
    UNION ALL
    SELECT coalesce(g.expires_at, g.requested_at), g.id, trustwork.console_work_row('case_grant', g.id, 'hub', NULL, g.hub_id, g.status, NULL, NULL, NULL, g.requested_by, g.requested_at, g.expires_at,
             jsonb_build_object('code', 'requested_by_you'))
      FROM trustwork.case_access_grant g
     WHERE p_view = 'mine' AND g.requested_by = v_me AND g.hub_id = p_hub AND (g.status = 'requested' OR (g.status = 'approved' AND g.expires_at > now()))
    UNION ALL
    SELECT s.created_at, s.id, trustwork.console_work_row('staff_activation', s.id, s.scope_kind, s.node_id, s.hub_id, s.status, NULL, NULL, s.role, s.person_id, s.created_at, NULL,
             jsonb_build_object('code', 'requested_by_you'))
      FROM trustwork.staff_activation s
     WHERE p_view = 'mine' AND s.person_id = v_me AND s.status = 'pending' AND s.node_id IS NOT DISTINCT FROM p_node AND s.hub_id IS NOT DISTINCT FROM p_hub
    UNION ALL
    -- Assigned to me.
    SELECT c.opened_at, c.id, trustwork.console_work_row('support_case', c.id, 'hub', NULL, c.hub_id, c.status, NULL, NULL, NULL, NULL, c.opened_at, NULL, jsonb_build_object('code', 'assigned_to_you'))
      FROM trustwork.support_case c
     WHERE p_view = 'assigned' AND c.assigned_to = v_me AND c.status <> 'closed' AND c.hub_id = p_hub
       AND trustwork.admin_has_any_permission(trustwork.admin_support_permissions(), NULL, c.hub_id)
       AND c.requester_person_id <> v_me AND NOT trustwork.console_conflicted(c.subject_person_id, c.subject_company_id)
    UNION ALL
    SELECT m.opened_at, m.id, trustwork.console_work_row('moderation_case', m.id, 'hub', NULL, m.hub_id, m.status, NULL, NULL, NULL, NULL, m.opened_at, NULL, jsonb_build_object('code', 'assigned_to_you'))
      FROM trustwork.moderation_case m
     WHERE p_view = 'assigned' AND m.assigned_to = v_me AND m.status IN ('open', 'in_review', 'appealed') AND m.hub_id = p_hub
       AND trustwork.admin_has_permission('admin.moderation.read', NULL, m.hub_id) AND NOT trustwork.console_conflicted(m.subject_person_id, m.subject_company_id)
    UNION ALL
    -- Appeals have no assignee: they are the work of whoever may decide them, never the original decider.
    SELECT l.filed_at, l.id, trustwork.console_work_row('appeal', l.id, 'hub', NULL, l.hub_id, l.status, NULL, NULL, NULL, NULL, l.filed_at, NULL, jsonb_build_object('code', 'holds_role', 'role', h.role))
      FROM trustwork.appeal l
      CROSS JOIN LATERAL (SELECT trustwork.console_role_holding(CASE WHEN l.subject_kind IN ('sanction', 'moderation_case') THEN ARRAY['admin.moderation.appeal.decide'] ELSE ARRAY['admin.trust.appeals.decide'] END, NULL, l.hub_id) AS role) h
     WHERE p_view = 'assigned' AND l.status IN ('submitted', 'in_review') AND l.hub_id = p_hub AND h.role IS NOT NULL
       AND l.original_decided_by <> v_me AND NOT trustwork.console_conflicted(l.appellant_person_id, l.appellant_company_id)
    UNION ALL
    SELECT coalesce(i.notification_deadline, i.opened_at), i.id, trustwork.console_work_row('incident', i.id, i.scope_kind, i.node_id, i.hub_id, i.status, NULL, i.severity, NULL, NULL, i.opened_at, i.notification_deadline, jsonb_build_object('code', 'opened_by_you'))
      FROM trustwork.incident i
     WHERE p_view = 'assigned' AND i.opened_by = v_me AND i.status <> 'closed' AND i.node_id IS NOT DISTINCT FROM p_node AND i.hub_id IS NOT DISTINCT FROM p_hub
    UNION ALL
    SELECT t.first_at, t.id, trustwork.console_work_row('pipeline_alert', t.id, 'hub', NULL, t.hub_id, t.state, NULL, NULL, NULL, NULL, t.first_at, NULL, jsonb_build_object('code', 'acknowledged_by_you'))
      FROM trustwork.pipeline_alert t
     WHERE p_view = 'assigned' AND t.acknowledged_by = v_me AND t.state = 'acknowledged' AND t.hub_id = p_hub
    UNION ALL
    -- Done: my decisions of the last 90 days that I may still read.
    SELECT coalesce(a.approved_at, a.updated_at), a.id, trustwork.console_work_row(trustwork.console_work_kind(a.action), a.id, a.scope_kind, a.node_id, a.hub_id, a.status, a.action, NULL, NULL, a.requested_by,
             coalesce(a.approved_at, a.updated_at), NULL, jsonb_build_object('code', 'decided_by_you'))
      FROM trustwork.second_person_approval a
     WHERE p_view = 'done' AND (a.approved_by = v_me OR a.declined_by = v_me) AND coalesce(a.approved_at, a.updated_at) > now() - interval '90 days'
       AND a.node_id IS NOT DISTINCT FROM p_node AND a.hub_id IS NOT DISTINCT FROM p_hub
    UNION ALL
    SELECT coalesce(g.approved_at, g.updated_at), g.id, trustwork.console_work_row('case_grant', g.id, 'hub', NULL, g.hub_id, g.status, NULL, NULL, NULL, g.requested_by, coalesce(g.approved_at, g.updated_at), NULL,
             jsonb_build_object('code', 'decided_by_you'))
      FROM trustwork.case_access_grant g
     WHERE p_view = 'done' AND (g.approved_by = v_me OR g.denied_by = v_me) AND coalesce(g.approved_at, g.updated_at) > now() - interval '90 days' AND g.hub_id = p_hub
       AND trustwork.admin_has_any_permission(ARRAY['admin.support.grant.approve', 'admin.audit.read'], NULL, g.hub_id)
    UNION ALL
    SELECT i.decided_at, i.id, trustwork.console_work_row('access_review_item', i.id, i.scope_kind, i.node_id, i.hub_id, i.verdict, NULL, NULL, i.role, NULL, i.decided_at, NULL, jsonb_build_object('code', 'decided_by_you'))
      FROM trustwork.staff_access_review_item i
     WHERE p_view = 'done' AND i.decided_by = v_me AND i.decided_at > now() - interval '90 days' AND i.node_id IS NOT DISTINCT FROM p_node AND i.hub_id IS NOT DISTINCT FROM p_hub
    UNION ALL
    SELECT m.decided_at, m.id, trustwork.console_work_row('moderation_case', m.id, 'hub', NULL, m.hub_id, m.status, NULL, NULL, NULL, NULL, m.decided_at, NULL, jsonb_build_object('code', 'decided_by_you'))
      FROM trustwork.moderation_case m
     WHERE p_view = 'done' AND m.decided_by = v_me AND m.decided_at > now() - interval '90 days' AND m.hub_id = p_hub
       AND trustwork.admin_has_permission('admin.moderation.read', NULL, m.hub_id)
    UNION ALL
    SELECT l.decided_at, l.id, trustwork.console_work_row('appeal', l.id, 'hub', NULL, l.hub_id, l.status, NULL, NULL, NULL, NULL, l.decided_at, NULL, jsonb_build_object('code', 'decided_by_you'))
      FROM trustwork.appeal l
     WHERE p_view = 'done' AND l.decided_by = v_me AND l.decided_at > now() - interval '90 days' AND l.hub_id = p_hub
       AND trustwork.admin_has_any_permission(ARRAY['admin.moderation.read', 'admin.moderation.appeal.decide', 'admin.trust.appeals.decide'], NULL, l.hub_id)
  ) r
  ORDER BY CASE WHEN p_view = 'done' THEN NULL ELSE r.due END ASC NULLS LAST, r.due DESC, r.id
  LIMIT 501;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.console_is_staff(uuid, uuid), trustwork.console_role_holding(text[], uuid, uuid), trustwork.console_conflicted(uuid, uuid),
  trustwork.console_approval_decidable(uuid), trustwork.console_holds_role(text, uuid, uuid), trustwork.console_ts(timestamptz),
  trustwork.console_search(uuid, bigint, text, uuid, uuid), trustwork.console_work_row(text, uuid, text, uuid, uuid, text, text, text, text, uuid, timestamptz, timestamptz, jsonb),
  trustwork.console_work_kind(text), trustwork.console_work_items(text, uuid, uuid), trustwork.staff_scope_owner_role(text) TO trustwork_app;
