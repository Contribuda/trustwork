-- SANC-006. Every screening decision refuses the subject, a member of the subject company and a reviewer with a declared
-- conflict, and so do staff notices, but the reads did not: such an officer could read the subject's money hold, the
-- list entry, the reasons and the deciders. The filter belongs on the rows, so that no route can forget it and a
-- conflicted officer gets the answer of a subject that has no record: nothing, and a 404 on an exact lookup.
-- Decisions and matches go through definers and keep their own, more specific refusals.

-- Is the caller a screening reader who is independent of this subject? admin_conflicted covers the person, their
-- active employer and a live declaration. A definer because a policy runs as the caller, who cannot read those tables.
CREATE FUNCTION trustwork.screening_subject_readable(p_person uuid, p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.jurisdiction_staff_reader()
    AND NOT trustwork.admin_conflicted(trustwork.current_person_id(), p_person, p_company)
$$;

CREATE FUNCTION trustwork.screening_match_readable(p_match uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.screening_match m WHERE m.id = p_match
    AND trustwork.screening_subject_readable(m.subject_person_id, m.subject_company_id))
$$;

-- The compliance panel of a named subject is the compliance officer's (console design, section 4.1). Decided here from
-- the assignment at the node: a role name on the principal also counts a hub-scoped assignment, which is not this
-- authority, and a node auditor holding one would pass.
CREATE FUNCTION trustwork.screening_panel_reader() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND trustwork.jurisdiction_node() IS NOT NULL
    AND trustwork.admin_person_is_staff(trustwork.current_person_id(), trustwork.jurisdiction_node(), NULL, 'compliance-officer')
$$;

DROP POLICY screening_subject_state_staff_read ON trustwork.screening_subject_state;
DROP POLICY screening_result_staff_read ON trustwork.screening_result;
DROP POLICY screening_match_staff_read ON trustwork.screening_match;
DROP POLICY screening_decision_staff_read ON trustwork.screening_decision;
DROP POLICY screening_report_draft_staff_read ON trustwork.screening_report_draft;
DROP POLICY screening_appeal_assignment_staff_read ON trustwork.screening_appeal_assignment;
CREATE POLICY screening_subject_state_staff_read ON trustwork.screening_subject_state FOR SELECT TO trustwork_app
  USING (trustwork.screening_subject_readable(subject_person_id, subject_company_id));
CREATE POLICY screening_result_staff_read ON trustwork.screening_result FOR SELECT TO trustwork_app
  USING (trustwork.screening_subject_readable(subject_person_id, subject_company_id));
CREATE POLICY screening_match_staff_read ON trustwork.screening_match FOR SELECT TO trustwork_app
  USING (trustwork.screening_subject_readable(subject_person_id, subject_company_id));
CREATE POLICY screening_decision_staff_read ON trustwork.screening_decision FOR SELECT TO trustwork_app
  USING (trustwork.screening_match_readable(match_id));
CREATE POLICY screening_report_draft_staff_read ON trustwork.screening_report_draft FOR SELECT TO trustwork_app
  USING (trustwork.screening_subject_readable(subject_person_id, subject_company_id));
CREATE POLICY screening_appeal_assignment_staff_read ON trustwork.screening_appeal_assignment FOR SELECT TO trustwork_app
  USING (trustwork.screening_match_readable(match_id));

REVOKE EXECUTE ON FUNCTION trustwork.screening_subject_readable(uuid, uuid), trustwork.screening_match_readable(uuid), trustwork.screening_panel_reader() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.screening_subject_readable(uuid, uuid), trustwork.screening_match_readable(uuid), trustwork.screening_panel_reader() TO trustwork_app;
