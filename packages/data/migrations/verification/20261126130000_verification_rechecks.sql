-- HUB-003 part 4: adapter results and scheduled re-checks. A result from an adapter (fake now, live with the country
-- adapters later) has no person as its author; a manual result always names its reviewer. The worker re-checks results
-- that expire soon: a fake adapter repeats its deterministic answer, a manual result waits for a reviewer (the console
-- lists it), and a live provider without an adapter is reported, never guessed.

ALTER TABLE trustwork.verification_check ALTER COLUMN recorded_by DROP NOT NULL;
ALTER TABLE trustwork.verification_check ADD CONSTRAINT verification_check_author
  CHECK (recorded_by IS NOT NULL OR mode IN ('fake', 'live'));

-- Results that expire within p_days across every hub, the latest per recipe, subject and check type, with the
-- provider's mode (the worker's work list).
CREATE FUNCTION trustwork.verification_due_rechecks_all(p_days integer, p_limit integer)
RETURNS TABLE (check_id uuid, hub_id uuid, check_type text, provider_mode text, result text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT x.id, x.hub_id, x.check_type, coalesce(p.mode, 'screening'), x.result, x.expires_at FROM (
    SELECT DISTINCT ON (c.recipe_id, c.subject_company_id, c.subject_person_id, c.check_type) c.*
    FROM trustwork.verification_check c
    ORDER BY c.recipe_id, c.subject_company_id, c.subject_person_id, c.check_type, c.recorded_at DESC
  ) x
  LEFT JOIN trustwork.verification_provider p ON p.id = x.provider_id
  WHERE x.expires_at <= now() + make_interval(days => greatest(p_days, 0))
  ORDER BY x.expires_at
  LIMIT least(greatest(coalesce(p_limit, 1), 1), 1000)
$$;

-- An adapter's answer to the re-check of an existing result: same subject, recipe, check type and provider; the
-- provider is active and its mode is an adapter mode (fake; live adapters arrive with the country packs). The latest
-- result must be the one re-checked, so a racing re-check or a reviewer's newer result is never overwritten.
CREATE FUNCTION trustwork.verification_record_adapter_result(p_check uuid, p_result text, p_evidence text) RETURNS trustwork.verification_check
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_check trustwork.verification_check%ROWTYPE;
  v_provider trustwork.verification_provider%ROWTYPE;
  v_recipe trustwork.verification_recipe%ROWTYPE;
  v_row trustwork.verification_check%ROWTYPE;
BEGIN
  SELECT * INTO v_check FROM trustwork.verification_check WHERE id = p_check;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such result' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.verification_recheck:' || v_check.recipe_id::text || ':' || coalesce(v_check.subject_company_id, v_check.subject_person_id)::text
    || ':' || v_check.check_type, 0));
  IF EXISTS (SELECT 1 FROM trustwork.verification_check c WHERE c.recipe_id = v_check.recipe_id AND c.check_type = v_check.check_type
       AND c.subject_company_id IS NOT DISTINCT FROM v_check.subject_company_id AND c.subject_person_id IS NOT DISTINCT FROM v_check.subject_person_id
       AND c.recorded_at > v_check.recorded_at) THEN
    RAISE EXCEPTION 'a newer result exists' USING ERRCODE = 'serialization_failure', HINT = 'verification.superseded';
  END IF;
  SELECT * INTO v_provider FROM trustwork.verification_provider WHERE id = v_check.provider_id AND status = 'active';
  IF NOT FOUND OR v_provider.mode <> 'fake' THEN
    RAISE EXCEPTION 'only an adapter re-checks without a person' USING ERRCODE = 'check_violation', HINT = 'verification.not_an_adapter';
  END IF;
  SELECT * INTO v_recipe FROM trustwork.verification_recipe WHERE id = v_check.recipe_id;
  INSERT INTO trustwork.verification_check (hub_id, subject_person_id, subject_company_id, recipe_id, check_type, provider_id, mode, result, evidence_ref, recorded_by, expires_at)
  VALUES (v_check.hub_id, v_check.subject_person_id, v_check.subject_company_id, v_check.recipe_id, v_check.check_type, v_provider.id, v_provider.mode, p_result, p_evidence, NULL,
    now() + make_interval(months => v_recipe.recheck_months))
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Results of a hub that expire within p_days (staff of the hub with a claims permission; the console's re-check list).
CREATE FUNCTION trustwork.verification_hub_due(p_hub uuid, p_days integer)
RETURNS TABLE (check_id uuid, check_type text, provider_mode text, result text, expires_at timestamptz, subject_kind text, subject_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.admin_has_any_permission(trustwork.verification_reader_permissions(), NULL, p_hub) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN QUERY SELECT x.id, x.check_type, coalesce(p.mode, 'screening'), x.result, x.expires_at,
      CASE WHEN x.subject_person_id IS NOT NULL THEN 'person' ELSE 'company' END, coalesce(x.subject_person_id, x.subject_company_id)
    FROM (SELECT DISTINCT ON (c.recipe_id, c.subject_company_id, c.subject_person_id, c.check_type) c.* FROM trustwork.verification_check c WHERE c.hub_id = p_hub
          ORDER BY c.recipe_id, c.subject_company_id, c.subject_person_id, c.check_type, c.recorded_at DESC) x
    LEFT JOIN trustwork.verification_provider p ON p.id = x.provider_id
    WHERE x.expires_at <= now() + make_interval(days => greatest(p_days, 0))
    ORDER BY x.expires_at;
END $$;

REVOKE EXECUTE ON FUNCTION trustwork.verification_due_rechecks_all(integer, integer), trustwork.verification_record_adapter_result(uuid, text, text), trustwork.verification_hub_due(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.verification_due_rechecks_all(integer, integer), trustwork.verification_record_adapter_result(uuid, text, text) TO trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.verification_hub_due(uuid, integer) TO trustwork_app;
