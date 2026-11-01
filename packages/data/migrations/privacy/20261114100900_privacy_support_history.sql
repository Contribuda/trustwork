-- Owning SUP projection: the same subject-only access record fields without the interactive 200-row cap.
CREATE FUNCTION trustwork.support_privacy_access_records() RETURNS TABLE (id uuid, at timestamptz, kind text, support_case_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r.id, r.at, r.kind, r.support_case_id FROM trustwork.support_access_record r
  WHERE r.subject_person_id = trustwork.current_person_id() AND trustwork.current_person_id() IS NOT NULL ORDER BY r.at, r.id
$$;
REVOKE ALL ON FUNCTION trustwork.support_privacy_access_records() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.support_privacy_access_records() TO trustwork_app;
