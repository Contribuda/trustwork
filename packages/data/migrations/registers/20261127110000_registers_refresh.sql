-- REG-001 part 2: what the worker refreshes. A due adapter re-observes the records it already holds (current facts):
-- an identifier value, or the record reference for registers without identifiers. Nothing new is discovered here;
-- discovery belongs to datasets (MINE-001). The worker reads only these subjects, never the facts themselves.
CREATE FUNCTION trustwork.registers_adapter_subjects(p_adapter uuid, p_limit integer) RETURNS TABLE (identifier_value text, record_ref text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT DISTINCT ON (coalesce(f.identifier_norm, ''), CASE WHEN f.identifier_norm IS NULL THEN f.record_ref END)
         f.identifier_value, CASE WHEN f.identifier_value IS NULL THEN f.record_ref END
    FROM trustwork.register_fact f
   WHERE f.adapter_id = p_adapter AND f.superseded_at IS NULL
   ORDER BY coalesce(f.identifier_norm, ''), CASE WHEN f.identifier_norm IS NULL THEN f.record_ref END, f.observed_at DESC
   LIMIT greatest(least(p_limit, 5000), 0)
$$;
-- Marks a due live adapter as visited without observations, so the worker reports it once per cadence instead of every
-- tick; live adapters have no code yet and are never guessed.
CREATE FUNCTION trustwork.registers_mark_visited(p_adapter uuid, p_now timestamptz) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  UPDATE trustwork.register_adapter SET last_run_at = p_now WHERE id = p_adapter AND status = 'active'
$$;
REVOKE EXECUTE ON FUNCTION trustwork.registers_adapter_subjects(uuid, integer), trustwork.registers_mark_visited(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.registers_adapter_subjects(uuid, integer), trustwork.registers_mark_visited(uuid, timestamptz) TO trustwork_worker;
