-- Follow-up to PPL-001 (#67) for the BE-003 directory (#51). Integrator decision 2026-10-31 (conductor, on PR #308):
-- the people directory and every other public person listing or lookup require the person's live profile_public
-- consent, not only profile_visibility = 'public'. Every runtime path to a public profile already records that consent
-- (profiles_person_visibility_guard) and its withdrawal sets the profile private; this closes the read side for rows
-- made public without consent (maintenance seeds, imports, older data), so such a person is never listed, never found
-- by id or handle and never visible to another signed-in person.
--
-- Covered reads:
--   * person_self_or_public (runtime SELECT policy on person): other people's rows need the consent. The directory
--     list and lookups of signed-in callers, the directory_handle and evidence_artifact policies (which ask whether
--     the person row is visible) follow from it;
--   * public_person_read (GET /v1/people/:id, anonymous directory lookups), directory_public_people (anonymous list)
--     and directory_public_resolve (anonymous handle resolution): owner-run, so they check the consent themselves.
-- profiles_public_profile, profiles_company_people and profiles_consented_mentions (PPL-001) already require it.

-- Owner-run because consent records are readable only by their subject (FORCE RLS) and a policy on person must ask
-- about other people's consent. Returns a boolean only, never a record.
CREATE FUNCTION trustwork.profiles_public_consent(p_person_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.consent_record c
    WHERE c.subject_person_id = p_person_id AND c.purpose = 'profile_public' AND c.withdrawn_at IS NULL
  )
$$;

ALTER POLICY person_self_or_public ON trustwork.person
  USING (trustwork.current_person_id() IS NOT NULL AND (
    id = trustwork.current_person_id()
    OR (profile_visibility = 'public' AND trustwork.profiles_public_consent(id))
  ));

CREATE OR REPLACE FUNCTION trustwork.public_person_read(p_id uuid)
RETURNS TABLE (id uuid, display_name text, public_headline text, public_expertise text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id, p.display_name, p.public_headline, p.public_expertise FROM trustwork.person p
  WHERE p.id = p_id AND p.profile_visibility = 'public' AND trustwork.profiles_public_consent(p.id)
$$;

CREATE OR REPLACE FUNCTION trustwork.directory_public_people(p_after_created timestamptz, p_after_id uuid, p_limit integer)
RETURNS TABLE (id uuid, display_name text, public_headline text, public_expertise text[], handle text, sort_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id, p.display_name, p.public_headline, p.public_expertise, h.handle,
         to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  FROM trustwork.person p
  LEFT JOIN trustwork.directory_handle h ON h.kind = 'person' AND h.subject_id = p.id AND h.retired_at IS NULL
  WHERE p.profile_visibility = 'public'
    AND trustwork.profiles_public_consent(p.id)
    AND (p.created_at, p.id) < (coalesce(p_after_created, 'infinity'::timestamptz), coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 101)
$$;

CREATE OR REPLACE FUNCTION trustwork.directory_public_resolve(p_kind text, p_handle text)
RETURNS TABLE (subject_id uuid, current_handle text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT h.subject_id, c.handle
  FROM trustwork.directory_handle h
  JOIN trustwork.directory_handle c ON c.kind = h.kind AND c.subject_id = h.subject_id AND c.retired_at IS NULL
  WHERE h.kind = p_kind AND h.handle = p_handle
    AND CASE p_kind
      WHEN 'person' THEN EXISTS (SELECT 1 FROM trustwork.person s WHERE s.id = h.subject_id AND s.profile_visibility = 'public' AND trustwork.profiles_public_consent(s.id))
      WHEN 'company' THEN EXISTS (SELECT 1 FROM trustwork.company s WHERE s.id = h.subject_id)
      WHEN 'project' THEN EXISTS (SELECT 1 FROM trustwork.project s WHERE s.id = h.subject_id AND s.publicity_enabled)
      ELSE false END
$$;

GRANT EXECUTE ON FUNCTION trustwork.profiles_public_consent(uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
