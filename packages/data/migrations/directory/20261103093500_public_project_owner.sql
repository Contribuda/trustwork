-- QA-002 D2 (integrator defect fix, directory module of BE-003): the owner of a published project in the public
-- projection, and the published projects of a company for its public page.
--
-- Anonymous callers have no identity and the project's owner columns are not public, so both reads are owner-run and
-- return public fields only:
--   * a company owner by its public name and current handle (companies are public rows);
--   * a person owner only while the profile is public with a live profile_public consent (the same rule as every
--     other public person read, profiles/20261101140000_directory_consent.sql); otherwise no row, and the API answers
--     publicOwner null, so the owner stays unnamed rather than guessed;
--   * unpublished projects never appear in either read.
-- Both reads serve signed-in callers too: the public projection is the same for everyone.

-- Public owners of up to 101 published projects (one directory page plus its look-ahead row).
CREATE FUNCTION trustwork.directory_public_project_owners(p_ids uuid[])
RETURNS TABLE (project_id uuid, owner_kind text, owner_id uuid, owner_name text, owner_handle text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id, 'company'::text, c.id, c.display_name, h.handle
  FROM trustwork.project p
  JOIN trustwork.company c ON c.id = p.owner_company_id
  LEFT JOIN trustwork.directory_handle h ON h.kind = 'company' AND h.subject_id = c.id AND h.retired_at IS NULL
  WHERE p.id = ANY (p_ids[1:101]) AND p.publicity_enabled
  UNION ALL
  SELECT p.id, 'person'::text, s.id, s.display_name, h.handle
  FROM trustwork.project p
  JOIN trustwork.person s ON s.id = p.owner_person_id
  LEFT JOIN trustwork.directory_handle h ON h.kind = 'person' AND h.subject_id = s.id AND h.retired_at IS NULL
  WHERE p.id = ANY (p_ids[1:101]) AND p.publicity_enabled
    AND s.profile_visibility = 'public' AND trustwork.profiles_public_consent(s.id)
$$;

-- Published projects owned by one company, in directory order (keyset pagination as directory_public_projects).
CREATE FUNCTION trustwork.directory_public_company_projects(p_company uuid, p_after_created timestamptz, p_after_id uuid, p_limit integer)
RETURNS TABLE (id uuid, name text, summary text, status text, published_story text, handle text, sort_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id, p.name, p.summary, p.status, p.published_story, h.handle,
         to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  FROM trustwork.project p
  LEFT JOIN trustwork.directory_handle h ON h.kind = 'project' AND h.subject_id = p.id AND h.retired_at IS NULL
  WHERE p.owner_company_id = p_company AND p.publicity_enabled
    AND (p.created_at, p.id) < (coalesce(p_after_created, 'infinity'::timestamptz), coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 101)
$$;

GRANT EXECUTE ON FUNCTION trustwork.directory_public_project_owners(uuid[]), trustwork.directory_public_company_projects(uuid, timestamptz, uuid, integer) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
