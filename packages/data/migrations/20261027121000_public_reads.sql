-- BE-001: scoped participants read the project row they participate in (the DATA-001 policy covered owners and
-- managers only), and anonymous public projections are served by owner-run allowlisted lookups that return only
-- public columns (every runtime policy requires an identity; anonymous requests have none).

-- Any live participation of the current person or of the active employer on a resource.
CREATE FUNCTION trustwork.participates_in_resource(p_resource_kind text, p_resource_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.object_participation p
    WHERE p.resource_kind = p_resource_kind AND p.resource_id = p_resource_id
      AND p.revoked_at IS NULL AND p.valid_from <= now() AND (p.valid_until IS NULL OR p.valid_until > now())
      AND (p.party_person_id = trustwork.current_person_id() OR (p.party_company_id IS NOT NULL AND p.party_company_id = trustwork.current_company_id()))
  )
$$;
GRANT EXECUTE ON FUNCTION trustwork.participates_in_resource(text, uuid) TO trustwork_app;

DROP POLICY project_read ON trustwork.project;
CREATE POLICY project_read ON trustwork.project FOR SELECT TO trustwork_app
  USING (
    trustwork.current_person_id() IS NOT NULL
    AND (publicity_enabled OR owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id()
         OR trustwork.participates_in_resource('project', id))
  );

-- Public projection columns of a published project; nothing for private or unknown ids (not found, not forbidden).
CREATE FUNCTION trustwork.public_project_read(p_id uuid)
RETURNS TABLE (id uuid, name text, summary text, status text, published_story text, revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id, p.name, p.summary, p.status, p.published_story, p.revision FROM trustwork.project p WHERE p.id = p_id AND p.publicity_enabled
$$;

-- Public profile columns of a person with profile_visibility = 'public'.
CREATE FUNCTION trustwork.public_person_read(p_id uuid)
RETURNS TABLE (id uuid, display_name text, public_headline text, public_expertise text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id, p.display_name, p.public_headline, p.public_expertise FROM trustwork.person p WHERE p.id = p_id AND p.profile_visibility = 'public'
$$;

GRANT EXECUTE ON FUNCTION trustwork.public_project_read(uuid), trustwork.public_person_read(uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
