-- SRC-002 part 2: what the pre-collection gate reads about a source, for the worker's pipeline fetch step. The registry
-- stays staff-only under row-level security; the worker reads exactly these fields of one source through this function
-- and never writes: a changed signal pauses the pipelines that use the source through pipelines_source_changed
-- (PIPE-001), and a person resumes them after a fresh check in the registry.
CREATE FUNCTION trustwork.sources_collection_view(p_source uuid)
RETURNS TABLE (id uuid, hub_id uuid, kind text, url text, status text, allowed_uses jsonb, terms_automated_access text, personal_data boolean, legal_basis text,
  terms_digest text, rsl_status text, rsl_ceiling jsonb, rsl_digest text, robots_digest text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT s.id, s.hub_id, s.kind, s.url, s.status, s.allowed_uses, s.terms_automated_access, s.personal_data, s.legal_basis, s.terms_digest, s.rsl_status, s.rsl_ceiling,
    s.rsl_digest, (SELECT c.robots_digest FROM trustwork.crawl_policy c WHERE c.source_id = s.id ORDER BY c.fetched_at DESC, c.id DESC LIMIT 1)
  FROM trustwork.source s WHERE s.id = p_source
$$;
REVOKE EXECUTE ON FUNCTION trustwork.sources_collection_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.sources_collection_view(uuid) TO trustwork_worker;
