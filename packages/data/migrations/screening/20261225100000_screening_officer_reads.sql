-- SANC-006, audit follow-up. The screening console keeps a named subject from auditors and from conflicted officers, but
-- only part of that stood on the rows:
--   * `jurisdiction_hold` had no conflict filter at all, and an auditor read it;
--   * `screening_subject_readable` still let an auditor through, so `screening_report_draft` gave an auditor the subject
--     and the list entry, and the other screening tables were closed to an auditor only by the routes in front of them.
-- A named subject is the compliance officer's at the node (console design, section 4.1). Decided here, on the rows, so
-- that no route can forget it. An auditor keeps the lists, the re-screen runs, the refusal counters and the audit trail.
-- The audit trail holds digests of the rows and, today, the reason the officer typed: the reason of a screening decision
-- is free text, so it is not covered here. #608 gives audit reasons their readers; screening actions belong in that rule.

CREATE OR REPLACE FUNCTION trustwork.screening_subject_readable(p_person uuid, p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.screening_panel_reader()
    AND NOT trustwork.admin_conflicted(trustwork.current_person_id(), p_person, p_company)
$$;

-- The definer behind the appeal assignment bypasses the rows, so it takes the same rule itself: an auditor is refused, as
-- anyone else who is not an officer, and a conflicted officer gets the answer of a match with no assignment.
CREATE OR REPLACE FUNCTION trustwork.screening_appeal_assignment_view(p_match uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a record; v_eligible boolean;
BEGIN
  IF NOT trustwork.screening_panel_reader() THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501', HINT = 'admin.forbidden';
  END IF;
  IF NOT trustwork.screening_match_readable(p_match) THEN RETURN NULL; END IF;
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

DROP POLICY jurisdiction_hold_staff_read ON trustwork.jurisdiction_hold;
CREATE POLICY jurisdiction_hold_staff_read ON trustwork.jurisdiction_hold FOR SELECT TO trustwork_app
  USING (trustwork.screening_subject_readable(person_id, NULL));
