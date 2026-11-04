-- CLM-001, review of the founding authority. A company's country decides which hub reviews its claims, so correcting it
-- is part of who can hand the company over. Two holes, both wider now that the founding role can correct:
--   * the correction had no conflict check: a claimant, a member of the company or staff with a declared conflict could
--     move it. It now refuses all three (admin.conflict_of_interest). A person who ever claimed the company counts,
--     whatever became of the claim: a rejected claimant could otherwise move it and file again;
--   * only an approval and a re-check refused the corrector. A rejection, a dispute proposal or confirmation and an
--     identifier check did not, so someone holding both roles could move a company and then reject the rival claim.
--     `claims_require_territory` runs inside every one of those decisions, under the company lock, so the rule sits there;
--   * in the other order a corrector could move a company and then claim it. The trigger below refuses that, on the
--     company lock `claims_submit` and the correction both take, so neither order can race.
CREATE OR REPLACE FUNCTION trustwork.claims_require_territory(p_hub uuid, p_company uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_country text;
  v_region text;
BEGIN
  PERFORM trustwork.claims_refuse_own_correction(trustwork.current_person_id(), p_company);
  SELECT country_code, country_region INTO v_country, v_region FROM trustwork.company WHERE id = p_company;
  -- The restricted list may have split the country, or named the region, since the company was created.
  IF v_country IS NULL OR (v_region IS NULL AND trustwork.attestation_region_required(v_country)) THEN
    RAISE EXCEPTION 'the company has no country on record' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.company_country_missing';
  END IF;
  IF NOT trustwork.directory_lock_hub_cover(p_hub, v_country) OR trustwork.kernel_place_restricted(coalesce(v_region, v_country)) THEN
    RAISE EXCEPTION 'this hub does not cover the company''s country' USING ERRCODE = 'insufficient_privilege', HINT = 'claims.outside_territory';
  END IF;
END $$;

CREATE FUNCTION trustwork.claims_refuse_corrector_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM trustwork.claims_refuse_own_correction(NEW.claimant_id, NEW.company_id);
  RETURN NEW;
END $$;
CREATE TRIGGER company_claim_not_by_corrector BEFORE INSERT ON trustwork.company_claim FOR EACH ROW EXECUTE FUNCTION trustwork.claims_refuse_corrector_claim();

CREATE OR REPLACE FUNCTION trustwork.directory_correct_company_country(p_ctx jsonb, p_hub uuid, p_company uuid, p_from text, p_from_region text, p_to text, p_to_region text) RETURNS trustwork.company_country_correction
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_current text;
  v_region text;
  v_row trustwork.company_country_correction%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.authority.decide'], p_hub);
  SELECT country_code, country_region INTO v_current, v_region FROM trustwork.company WHERE id = p_company FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such company' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF trustwork.admin_conflicted(v_actor.person_id, NULL, p_company)
     OR EXISTS (SELECT 1 FROM trustwork.company_claim c WHERE c.company_id = p_company AND c.claimant_id = v_actor.person_id) THEN
    RAISE EXCEPTION 'a claimant, a member or a conflicted reviewer does not correct this company' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  IF (v_current, v_region) IS DISTINCT FROM (p_from, p_from_region) THEN
    RAISE EXCEPTION 'the country changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'directory.country_changed';
  END IF;
  IF p_to IS NULL OR (p_to, p_to_region) IS NOT DISTINCT FROM (v_current, v_region) THEN
    RAISE EXCEPTION 'a correction names another place' USING ERRCODE = 'check_violation', HINT = 'directory.country_unchanged';
  END IF;
  IF NOT (trustwork.directory_lock_hub_cover(p_hub, v_current) OR trustwork.directory_lock_hub_cover(p_hub, p_to)) THEN
    RAISE EXCEPTION 'this hub covers neither country' USING ERRCODE = 'insufficient_privilege', HINT = 'directory.outside_territory';
  END IF;
  INSERT INTO trustwork.company_country_correction (company_id, hub_id, from_country, from_region, to_country, to_region, corrected_by)
  VALUES (p_company, p_hub, v_current, v_region, p_to, p_to_region, v_actor.person_id) RETURNING * INTO v_row;
  UPDATE trustwork.company SET country_code = p_to, country_region = p_to_region WHERE id = p_company;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'company.country_corrected', 'company', p_company,
    jsonb_build_object('country', v_current, 'region', v_region), jsonb_build_object('country', p_to, 'region', p_to_region));
  RETURN v_row;
END $$;

REVOKE EXECUTE ON FUNCTION trustwork.claims_refuse_corrector_claim() FROM PUBLIC;
