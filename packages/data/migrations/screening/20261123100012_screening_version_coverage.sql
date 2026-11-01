-- PAY-001 same-node payments: whether every given person is screened clear against every given list version. The
-- screening module keeps sole read access to its subject states (tests/screening/projections.test.ts); callers get a
-- yes or no and nothing about why.
CREATE FUNCTION trustwork.screening_persons_clear_for_versions(p_persons uuid[], p_versions uuid[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT cardinality(p_persons) > 0 AND NOT EXISTS (
    SELECT 1 FROM unnest(p_persons) AS p(person_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM trustwork.screening_subject_state s
      WHERE s.subject_person_id = p.person_id AND p_versions <@ s.screened_versions AND s.last_outcome = 'clear'))
$$;
REVOKE EXECUTE ON FUNCTION trustwork.screening_persons_clear_for_versions(uuid[], uuid[]) FROM PUBLIC;
