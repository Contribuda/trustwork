-- FILE owning revocation barrier for deterministic PRV exports. Existing parent-first order is preserved.
-- Row locking alone does not refresh an already-established MVCC snapshot when the child state was absent.
-- Keep the original command authorization, legal holds and immutable evidence; change only its parent revision.

CREATE OR REPLACE FUNCTION trustwork.files_request_deletion(p_artifact_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_artifact trustwork.evidence_artifact%ROWTYPE;
  v_requested timestamptz;
BEGIN
  SELECT * INTO v_artifact FROM trustwork.evidence_artifact WHERE id = p_artifact_id FOR UPDATE;
  IF NOT FOUND OR v_artifact.classification = 'restricted' OR NOT trustwork.files_acts_for_owner(v_artifact.owner_person_id, v_artifact.owner_company_id) THEN
    RAISE EXCEPTION 'file not found' USING ERRCODE = 'insufficient_privilege', HINT = 'files.not_found';
  END IF;
  IF v_artifact.legal_hold THEN
    RAISE EXCEPTION 'artifact under legal hold' USING ERRCODE = 'integrity_constraint_violation', HINT = 'files.legal_hold';
  END IF;
  SELECT deletion_requested_at INTO v_requested FROM trustwork.file_artifact_state WHERE artifact_id = p_artifact_id;
  IF v_requested IS NOT NULL THEN
    RETURN false;
  END IF;
  -- Publish a parent tuple version before a possibly first child-state insertion.
  -- A repeatable-read export that predates this revocation must fail its parent row lock (40001).
  -- touch_row advances revision; evidence bytes, hash, ownership and provenance stay unchanged.
  UPDATE trustwork.evidence_artifact SET updated_at=clock_timestamp() WHERE id=p_artifact_id;
  INSERT INTO trustwork.file_artifact_state (artifact_id, origin, deletion_requested_at, deletion_requested_by, deletion_mode)
  VALUES (p_artifact_id, 'upload', now(), trustwork.current_person_id(), 'delete')
  ON CONFLICT (artifact_id) DO UPDATE SET deletion_requested_at = EXCLUDED.deletion_requested_at, deletion_requested_by = EXCLUDED.deletion_requested_by, deletion_mode = 'delete';
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION trustwork.files_request_erasure(p_artifact_id uuid, p_privacy_request_id text, p_executed_by uuid, p_second_approver uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_hold boolean;
BEGIN
  IF p_executed_by IS NULL OR p_second_approver IS NULL OR p_executed_by = p_second_approver OR p_privacy_request_id IS NULL THEN
    RAISE EXCEPTION 'erasure needs a privacy request and two different people' USING ERRCODE = 'check_violation', HINT = 'files.erasure_approvers';
  END IF;
  SELECT legal_hold INTO v_hold FROM trustwork.evidence_artifact WHERE id = p_artifact_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_hold THEN
    RAISE EXCEPTION 'artifact under legal hold' USING ERRCODE = 'integrity_constraint_violation', HINT = 'files.legal_hold';
  END IF;
  -- Publish a parent tuple version before a possibly first child-state insertion.
  -- A repeatable-read export that predates this revocation must fail its parent row lock (40001).
  -- touch_row advances revision; evidence bytes, hash, ownership and provenance stay unchanged.
  UPDATE trustwork.evidence_artifact SET updated_at=clock_timestamp() WHERE id=p_artifact_id;
  INSERT INTO trustwork.file_artifact_state (artifact_id, origin, deletion_requested_at, deletion_requested_by, deletion_mode, privacy_request_id, erasure_approvers)
  VALUES (p_artifact_id, 'upload', now(), p_executed_by, 'erase', p_privacy_request_id, ARRAY[p_executed_by, p_second_approver])
  ON CONFLICT (artifact_id) DO UPDATE SET deletion_requested_at = coalesce(trustwork.file_artifact_state.deletion_requested_at, EXCLUDED.deletion_requested_at),
    deletion_requested_by = coalesce(trustwork.file_artifact_state.deletion_requested_by, EXCLUDED.deletion_requested_by),
    deletion_mode = 'erase', privacy_request_id = EXCLUDED.privacy_request_id, erasure_approvers = EXCLUDED.erasure_approvers
  WHERE trustwork.file_artifact_state.deletion_mode IS DISTINCT FROM 'erase';
  INSERT INTO trustwork.audit_event (actor_person_id, action, object_kind, object_id, basis)
  VALUES (p_executed_by, 'file.erasure_requested', 'evidence_artifact', p_artifact_id::text, jsonb_build_object('privacyRequestId', p_privacy_request_id, 'secondApprover', p_second_approver));
  RETURN true;
END $$;
