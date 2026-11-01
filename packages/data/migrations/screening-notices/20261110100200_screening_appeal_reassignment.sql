-- SANC-007: preserve the original routing evidence; append changes and move an explicit versioned pointer.
CREATE TABLE trustwork.screening_appeal_routing_history (
  appeal_id uuid NOT NULL REFERENCES trustwork.screening_appeal_assignment(appeal_id),
  version integer NOT NULL CHECK (version > 0),
  reviewer_id uuid NULL REFERENCES trustwork.person(id),
  assigned_by uuid NULL REFERENCES trustwork.person(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (appeal_id, version)
);
CREATE TABLE trustwork.screening_appeal_routing_current (
  appeal_id uuid PRIMARY KEY REFERENCES trustwork.screening_appeal_assignment(appeal_id),
  version integer NOT NULL,
  FOREIGN KEY (appeal_id, version) REFERENCES trustwork.screening_appeal_routing_history(appeal_id, version)
);
ALTER TABLE trustwork.screening_appeal_routing_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_appeal_routing_history FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_appeal_routing_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_appeal_routing_current FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.screening_appeal_routing_history TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.screening_appeal_routing_current TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE TRIGGER screening_appeal_routing_history_append_only BEFORE UPDATE OR DELETE ON trustwork.screening_appeal_routing_history
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER screening_appeal_routing_history_no_truncate BEFORE TRUNCATE ON trustwork.screening_appeal_routing_history
  FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

INSERT INTO trustwork.screening_appeal_routing_history (appeal_id, version, reviewer_id, reason, assigned_at)
  SELECT appeal_id, 1, reviewer_id, 'Initial routing snapshot', assigned_at FROM trustwork.screening_appeal_assignment;
INSERT INTO trustwork.screening_appeal_routing_current (appeal_id, version)
  SELECT appeal_id, 1 FROM trustwork.screening_appeal_assignment;

CREATE FUNCTION trustwork.screening_appeal_routing_init() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  INSERT INTO trustwork.screening_appeal_routing_history (appeal_id, version, reviewer_id, reason, assigned_at)
    VALUES (NEW.appeal_id, 1, NEW.reviewer_id, 'Initial routing snapshot', NEW.assigned_at);
  INSERT INTO trustwork.screening_appeal_routing_current (appeal_id, version) VALUES (NEW.appeal_id, 1);
  RETURN NEW;
END $$;
CREATE TRIGGER screening_appeal_routing_init AFTER INSERT ON trustwork.screening_appeal_assignment
  FOR EACH ROW EXECUTE FUNCTION trustwork.screening_appeal_routing_init();

-- Internal eligibility predicate; never grants a role, an elevation or permission to decide.
CREATE FUNCTION trustwork.screening_appeal_reviewer_eligible(p_appeal uuid, p_reviewer uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.screening_appeal_assignment a JOIN trustwork.screening_match m ON m.id = a.match_id
    WHERE a.appeal_id = p_appeal AND p_reviewer IS NOT NULL AND p_reviewer <> a.original_decider
      AND p_reviewer IS DISTINCT FROM m.subject_person_id
      AND NOT trustwork.admin_conflicted(p_reviewer, m.subject_person_id, m.subject_company_id)
      AND NOT EXISTS (SELECT 1 FROM trustwork.jurisdiction_hold h WHERE h.person_id = p_reviewer AND h.cleared_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM trustwork.screening_subject_state s WHERE s.subject_person_id = p_reviewer AND s.suspended)
      AND EXISTS (SELECT 1 FROM trustwork.staff_role_assignment r WHERE r.person_id = p_reviewer
        AND r.role = 'compliance-officer' AND r.scope_kind = 'node' AND r.node_id = trustwork.jurisdiction_node()
        AND NOT r.breakglass AND r.revoked_at IS NULL AND r.valid_from <= now() AND (r.valid_until IS NULL OR r.valid_until > now()))
  )
$$;

CREATE FUNCTION trustwork.screening_appeal_assignment_view(p_match uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a record; v_eligible boolean;
BEGIN
  IF NOT trustwork.jurisdiction_staff_reader() THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501', HINT = 'admin.forbidden';
  END IF;
  SELECT r.*, h.reviewer_id AS current_reviewer, h.assigned_at AS current_at, c.version, m.state INTO a
    FROM trustwork.screening_appeal_assignment r JOIN trustwork.screening_decision d ON d.id = r.appeal_id
    JOIN trustwork.screening_appeal_routing_current c ON c.appeal_id = r.appeal_id
    JOIN trustwork.screening_appeal_routing_history h ON h.appeal_id = c.appeal_id AND h.version = c.version
    JOIN trustwork.screening_match m ON m.id = r.match_id WHERE r.match_id = p_match ORDER BY d.seq DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_eligible := trustwork.screening_appeal_reviewer_eligible(a.appeal_id, a.current_reviewer);
  RETURN jsonb_build_object('appealId', a.appeal_id, 'originalDecisionId', a.original_decision_id,
    'reviewerId', CASE WHEN a.state = 'appeal' AND v_eligible THEN a.current_reviewer ELSE NULL END,
    'assignedAt', to_char(a.current_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'version', a.version,
    'status', CASE WHEN a.state <> 'appeal' THEN 'closed' WHEN a.current_reviewer IS NULL THEN 'unassigned'
      WHEN v_eligible THEN 'assigned' ELSE 'unavailable' END);
END $$;

CREATE FUNCTION trustwork.screening_reassign_appeal(p_ctx jsonb, p_match uuid, p_expected integer, p_reviewer uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_actor trustwork.admin_actor; m trustwork.screening_match; a trustwork.screening_appeal_assignment;
  v_version integer; v_before jsonb;
BEGIN
  -- Rare, short staff-only routing transaction: protect both existing and absent authority/conflict rows.
  -- NOWAIT refuses concurrent authority writers instead of introducing a lock-order cycle with their commands.
  BEGIN
    LOCK TABLE trustwork.staff_role_assignment, trustwork.staff_conflict_declaration, trustwork.membership,
      trustwork.jurisdiction_hold, trustwork.screening_subject_state IN SHARE MODE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'authority changed concurrently; reload' USING ERRCODE = '40001', HINT = 'screening.routing_conflict';
  END;
  v_actor := trustwork.screening_staff_actor(p_ctx, 'admin.screening.appeals.decide');
  PERFORM trustwork.screening_check_reason(p_reason, NULL);
  m := trustwork.screening_lock_match_for(p_match, v_actor.person_id);
  IF m.state <> 'appeal' THEN
    RAISE EXCEPTION 'no pending appeal' USING ERRCODE = '23514', HINT = 'screening.match_state';
  END IF;
  SELECT r.* INTO STRICT a FROM trustwork.screening_appeal_assignment r
    JOIN trustwork.screening_decision d ON d.id = r.appeal_id WHERE r.match_id = p_match ORDER BY d.seq DESC LIMIT 1;
  IF NOT trustwork.screening_appeal_reviewer_eligible(a.appeal_id, v_actor.person_id) THEN
    RAISE EXCEPTION 'independent current officer required' USING ERRCODE = '42501', HINT = 'admin.forbidden';
  END IF;
  SELECT version INTO v_version FROM trustwork.screening_appeal_routing_current WHERE appeal_id = a.appeal_id FOR UPDATE;
  IF p_expected IS NULL OR v_version <> p_expected THEN
    RAISE EXCEPTION 'routing version changed' USING ERRCODE = '40001', HINT = 'screening.routing_conflict';
  END IF;
  IF p_reviewer IS NOT NULL AND NOT trustwork.screening_appeal_reviewer_eligible(a.appeal_id, p_reviewer) THEN
    RAISE EXCEPTION 'reviewer is not currently independent and eligible' USING ERRCODE = '42501', HINT = 'admin.forbidden';
  END IF;
  v_before := trustwork.screening_appeal_assignment_view(p_match);
  INSERT INTO trustwork.screening_appeal_routing_history (appeal_id, version, reviewer_id, assigned_by, reason)
    VALUES (a.appeal_id, v_version + 1, p_reviewer, v_actor.person_id, btrim(p_reason));
  UPDATE trustwork.screening_appeal_routing_current SET version = v_version + 1 WHERE appeal_id = a.appeal_id;
  PERFORM trustwork.admin_record(v_actor, p_ctx, trustwork.jurisdiction_node(), NULL, 'screening.appeal_reassigned',
    'screening_match', p_match, v_before, trustwork.screening_appeal_assignment_view(p_match));
  RETURN trustwork.screening_appeal_assignment_view(p_match);
END $$;
REVOKE ALL ON TABLE trustwork.screening_appeal_routing_history, trustwork.screening_appeal_routing_current FROM PUBLIC, trustwork_app, trustwork_worker;
REVOKE ALL ON FUNCTION trustwork.screening_appeal_routing_init(), trustwork.screening_appeal_reviewer_eligible(uuid, uuid),
  trustwork.screening_appeal_assignment_view(uuid), trustwork.screening_reassign_appeal(jsonb, uuid, integer, uuid, text) FROM PUBLIC, trustwork_app, trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.screening_appeal_assignment_view(uuid), trustwork.screening_reassign_appeal(jsonb, uuid, integer, uuid, text) TO trustwork_app;
