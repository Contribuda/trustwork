-- FILE owning read lock: privacy still calls the existing file projection after this admission.
CREATE FUNCTION trustwork.files_privacy_export_lock(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_file trustwork.evidence_artifact%ROWTYPE;
BEGIN
  SELECT * INTO v_file FROM trustwork.evidence_artifact WHERE id=p_id FOR SHARE;
  IF NOT FOUND OR v_file.classification='restricted' OR v_file.scan_state<>'clean'
    OR NOT coalesce(trustwork.files_acts_for_owner(v_file.owner_person_id,v_file.owner_company_id),false) THEN
    RAISE EXCEPTION 'file unavailable' USING ERRCODE='42501',HINT='privacy.not_found';
  END IF;
  PERFORM 1 FROM trustwork.file_artifact_state WHERE artifact_id=p_id FOR SHARE;
  IF trustwork.files_hidden(p_id) THEN RAISE EXCEPTION 'file unavailable' USING ERRCODE='42501',HINT='privacy.not_found'; END IF;
END $$;
REVOKE EXECUTE ON FUNCTION trustwork.files_privacy_export_lock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.files_privacy_export_lock(uuid) TO trustwork_app;
