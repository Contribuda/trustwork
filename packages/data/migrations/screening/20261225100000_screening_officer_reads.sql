-- SANC-006, audit follow-up. The screening console keeps a named subject from auditors and from conflicted officers, but
-- only part of that stood on the rows:
--   * `jurisdiction_hold` had no conflict filter at all, and an auditor read it;
--   * `screening_subject_readable` still let an auditor through, so `screening_report_draft` gave an auditor the subject
--     and the list entry, and the other screening tables were closed to an auditor only by the routes in front of them.
-- A named subject is the compliance officer's at the node (console design, section 4.1). Decided here, on the rows, so
-- that no route can forget it. An auditor keeps the lists, the re-screen runs, the refusal counters and the audit trail
-- (digests, never payloads), none of which names a subject beside a list entry.

CREATE OR REPLACE FUNCTION trustwork.screening_subject_readable(p_person uuid, p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.screening_panel_reader()
    AND NOT trustwork.admin_conflicted(trustwork.current_person_id(), p_person, p_company)
$$;

DROP POLICY jurisdiction_hold_staff_read ON trustwork.jurisdiction_hold;
CREATE POLICY jurisdiction_hold_staff_read ON trustwork.jurisdiction_hold FOR SELECT TO trustwork_app
  USING (trustwork.screening_subject_readable(person_id, NULL));
