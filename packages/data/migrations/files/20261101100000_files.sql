-- FILE-001: object storage port and attachments over the kernel table evidence_artifact (DATA-003).
--
-- The kernel table keeps the content identity of a stored file (owner, parent, classification, storage key, hash, size,
-- type, uploader) immutable and lets the runtime role INSERT a pending artifact under its policy. This slice adds what
-- the lifecycle around it needs, without a new runtime write on evidence_artifact:
--   1. file_artifact_state: upload window and completion, scan verdict, copy/move lineage and the deletion request;
--   2. a restrictive read policy: a file whose deletion was requested disappears for every runtime reader at once;
--   3. owner-run commands for the API role (register and complete an upload, request deletion, copy, move) that repeat
--      the kernel's attach and ownership checks, because they write as the owner;
--   4. owner-run entry points for the worker role (read a scan target, record the verdict, finish a deletion, replay a
--      tombstone, discard an abandoned upload). The worker gets no table grant: it reads and writes only through them.
-- Object bytes never touch the database. Tombstones of deleted files live in object storage (the tombstone ledger,
-- outside the restorable snapshot); files_apply_tombstone replays them after a restore.

CREATE TABLE trustwork.file_artifact_state (
  artifact_id uuid PRIMARY KEY REFERENCES trustwork.evidence_artifact (id) ON DELETE CASCADE,
  origin text NOT NULL CHECK (origin IN ('upload', 'copy', 'move')),
  -- Copy/move lineage. No foreign key: the source of a move is deleted in the same transaction.
  source_artifact_id uuid NULL,
  -- Copy only: the storage key the worker copies the bytes from (the source row may be deleted before it runs).
  copy_from_key text NULL CHECK (copy_from_key IS NULL OR (length(copy_from_key) <= 512 AND copy_from_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.=-]*$' AND copy_from_key !~ '\.\.')),
  upload_expires_at timestamptz NULL,
  upload_completed_at timestamptz NULL,
  scanned_at timestamptz NULL,
  quarantine_reason text NULL CHECK (quarantine_reason IS NULL OR quarantine_reason IN ('malware', 'hash_mismatch', 'size_mismatch', 'type_mismatch', 'missing_content', 'location_metadata', 'unreadable')),
  deletion_requested_at timestamptz NULL,
  deletion_requested_by uuid NULL REFERENCES trustwork.person (id),
  deletion_mode text NULL CHECK (deletion_mode IS NULL OR deletion_mode IN ('delete', 'erase')),
  -- Erasure: the privacy request and the two people who executed it (retention and privacy, subject rights).
  privacy_request_id text NULL CHECK (privacy_request_id IS NULL OR length(privacy_request_id) BETWEEN 1 AND 128),
  erasure_approvers uuid[] NULL CHECK (erasure_approvers IS NULL OR (cardinality(erasure_approvers) = 2 AND erasure_approvers[1] <> erasure_approvers[2])),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_state_origin_shape CHECK (
    (origin = 'upload' AND source_artifact_id IS NULL AND copy_from_key IS NULL)
    OR (origin = 'copy' AND source_artifact_id IS NOT NULL AND copy_from_key IS NOT NULL AND upload_expires_at IS NULL)
    OR (origin = 'move' AND source_artifact_id IS NOT NULL AND copy_from_key IS NULL AND upload_expires_at IS NULL)
  ),
  CONSTRAINT file_state_deletion_shape CHECK ((deletion_requested_at IS NULL) = (deletion_mode IS NULL)),
  CONSTRAINT file_state_erasure_shape CHECK (
    (deletion_mode = 'erase' AND privacy_request_id IS NOT NULL AND erasure_approvers IS NOT NULL)
    OR (deletion_mode IS DISTINCT FROM 'erase' AND privacy_request_id IS NULL AND erasure_approvers IS NULL)
  )
);
CREATE INDEX file_state_open_uploads_idx ON trustwork.file_artifact_state (upload_expires_at) WHERE origin = 'upload' AND upload_completed_at IS NULL;
CREATE INDEX file_state_deletions_idx ON trustwork.file_artifact_state (deletion_requested_at) WHERE deletion_requested_at IS NOT NULL;

CREATE FUNCTION trustwork.file_state_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER file_artifact_state_touch BEFORE UPDATE ON trustwork.file_artifact_state FOR EACH ROW EXECUTE FUNCTION trustwork.file_state_touch();

-- Lineage, the upload window and a recorded verdict never change; a deletion request is never withdrawn.
CREATE FUNCTION trustwork.file_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.origin <> OLD.origin OR NEW.source_artifact_id IS DISTINCT FROM OLD.source_artifact_id OR NEW.copy_from_key IS DISTINCT FROM OLD.copy_from_key
     OR NEW.upload_expires_at IS DISTINCT FROM OLD.upload_expires_at OR NEW.created_at <> OLD.created_at
     OR (OLD.upload_completed_at IS NOT NULL AND NEW.upload_completed_at IS DISTINCT FROM OLD.upload_completed_at)
     OR (OLD.scanned_at IS NOT NULL AND (NEW.scanned_at IS DISTINCT FROM OLD.scanned_at OR NEW.quarantine_reason IS DISTINCT FROM OLD.quarantine_reason))
     OR (OLD.deletion_requested_at IS NOT NULL AND (NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at OR NEW.deletion_requested_by IS DISTINCT FROM OLD.deletion_requested_by
         OR (OLD.deletion_mode = 'erase' AND NEW.deletion_mode IS DISTINCT FROM OLD.deletion_mode))) THEN
    RAISE EXCEPTION 'file state history is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'files.state_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_artifact_state_guard BEFORE UPDATE ON trustwork.file_artifact_state FOR EACH ROW EXECUTE FUNCTION trustwork.file_state_guard();

ALTER TABLE trustwork.file_artifact_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.file_artifact_state FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.file_artifact_state AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- 1. Hidden once deletion is requested -------------------------------------------------------------------------------
-- Owner-run so the evidence policy can consult the state table without a policy cycle (state reads evidence).
CREATE FUNCTION trustwork.files_hidden(p_artifact_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.file_artifact_state s WHERE s.artifact_id = p_artifact_id AND s.deletion_requested_at IS NOT NULL)
$$;
CREATE POLICY evidence_artifact_not_deleted ON trustwork.evidence_artifact AS RESTRICTIVE FOR SELECT TO trustwork_app
  USING (NOT trustwork.files_hidden(id));

-- The runtime role reads the state of the artifacts it can read (the evidence policy decides).
CREATE POLICY file_artifact_state_read ON trustwork.file_artifact_state FOR SELECT TO trustwork_app
  USING (trustwork.current_person_id() IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.evidence_artifact a WHERE a.id = artifact_id));
GRANT SELECT ON trustwork.file_artifact_state TO trustwork_app;

-- 2. Shared predicates (invoker; called by the owner-run commands below) -----------------------------------------------
-- The caller may attach to the parent: the same rule as the kernel insert policy.
CREATE FUNCTION trustwork.files_can_attach(p_parent_kind text, p_parent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND CASE p_parent_kind
    WHEN 'person' THEN p_parent_id = trustwork.current_person_id()
    WHEN 'company' THEN p_parent_id = trustwork.current_company_id()
    WHEN 'project' THEN trustwork.owns_resource(p_parent_kind, p_parent_id) OR trustwork.participates_in_resource(p_parent_kind, p_parent_id)
    WHEN 'rfq' THEN trustwork.owns_resource(p_parent_kind, p_parent_id) OR trustwork.participates_in_resource(p_parent_kind, p_parent_id)
    WHEN 'quote' THEN trustwork.owns_resource(p_parent_kind, p_parent_id) OR trustwork.participates_in_resource(p_parent_kind, p_parent_id)
    WHEN 'agreement' THEN trustwork.owns_resource(p_parent_kind, p_parent_id) OR trustwork.participates_in_resource(p_parent_kind, p_parent_id)
    WHEN 'order' THEN trustwork.owns_resource(p_parent_kind, p_parent_id) OR trustwork.participates_in_resource(p_parent_kind, p_parent_id)
    WHEN 'thread' THEN trustwork.owns_resource(p_parent_kind, p_parent_id) OR trustwork.participates_in_resource(p_parent_kind, p_parent_id)
    WHEN 'publication' THEN trustwork.owns_resource(p_parent_kind, p_parent_id) OR trustwork.participates_in_resource(p_parent_kind, p_parent_id)
    ELSE false END
$$;

-- The caller acts for the owner party: the person itself, or a member of the active employer with company.deals.manage.
CREATE FUNCTION trustwork.files_acts_for_owner(p_owner_person_id uuid, p_owner_company_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.current_person_id() IS NOT NULL
    AND (coalesce(p_owner_person_id = trustwork.current_person_id(), false)
         OR (p_owner_company_id IS NOT NULL AND coalesce(p_owner_company_id = trustwork.current_company_id(), false) AND trustwork.current_membership_has('company.deals.manage')))
$$;

-- Classification inherited from the parent kind (CLASSIFICATION_POLICY in packages/contracts/src/files.ts).
CREATE FUNCTION trustwork.files_classification_allowed(p_parent_kind text, p_classification text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE p_parent_kind
    WHEN 'person' THEN p_classification IN ('public', 'owner_private')
    WHEN 'company' THEN p_classification IN ('public', 'owner_private')
    WHEN 'project' THEN p_classification IN ('public', 'shared', 'party_private', 'owner_private')
    WHEN 'publication' THEN p_classification IN ('public', 'shared', 'party_private', 'owner_private')
    WHEN 'rfq' THEN p_classification IN ('shared', 'party_private', 'owner_private')
    WHEN 'quote' THEN p_classification IN ('shared', 'party_private', 'owner_private')
    WHEN 'agreement' THEN p_classification IN ('shared', 'party_private', 'owner_private')
    WHEN 'order' THEN p_classification IN ('shared', 'party_private', 'owner_private')
    WHEN 'thread' THEN p_classification IN ('shared', 'party_private', 'owner_private')
    ELSE false END
$$;

-- 3. Commands of the runtime role -------------------------------------------------------------------------------------

-- Opens the upload window of an artifact the caller has just inserted (pending, uploaded by the caller, no state yet).
-- The window is bounded here, not by the caller: 30 seconds to 15 minutes.
CREATE FUNCTION trustwork.files_register_upload(p_artifact_id uuid, p_ttl_seconds integer) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_expires timestamptz;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 30 OR p_ttl_seconds > 900 THEN
    RAISE EXCEPTION 'upload window out of bounds' USING ERRCODE = 'check_violation', HINT = 'files.window_bounds';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM trustwork.evidence_artifact a
    WHERE a.id = p_artifact_id AND a.uploaded_by = trustwork.current_person_id() AND a.scan_state = 'pending'
      AND NOT EXISTS (SELECT 1 FROM trustwork.file_artifact_state s WHERE s.artifact_id = a.id)
  ) THEN
    RAISE EXCEPTION 'not an upload of the caller' USING ERRCODE = 'insufficient_privilege', HINT = 'files.not_found';
  END IF;
  v_expires := now() + make_interval(secs => p_ttl_seconds);
  INSERT INTO trustwork.file_artifact_state (artifact_id, origin, upload_expires_at) VALUES (p_artifact_id, 'upload', v_expires);
  RETURN v_expires;
END $$;

-- The uploader reports the bytes as sent. Allowed until 15 minutes after the window (a PUT may finish at its end);
-- true the first time, false when already reported (the caller then does not emit the scan event again).
CREATE FUNCTION trustwork.files_complete_upload(p_artifact_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_state trustwork.file_artifact_state%ROWTYPE;
BEGIN
  SELECT s.* INTO v_state FROM trustwork.file_artifact_state s JOIN trustwork.evidence_artifact a ON a.id = s.artifact_id
  WHERE s.artifact_id = p_artifact_id AND a.uploaded_by = trustwork.current_person_id() AND s.origin = 'upload' AND s.deletion_requested_at IS NULL
  FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an upload of the caller' USING ERRCODE = 'insufficient_privilege', HINT = 'files.not_found';
  END IF;
  IF v_state.upload_completed_at IS NOT NULL THEN
    RETURN false;
  END IF;
  IF now() > v_state.upload_expires_at + interval '15 minutes' THEN
    RAISE EXCEPTION 'the upload window has passed' USING ERRCODE = 'check_violation', HINT = 'files.upload_expired';
  END IF;
  UPDATE trustwork.file_artifact_state SET upload_completed_at = now() WHERE artifact_id = p_artifact_id;
  RETURN true;
END $$;

-- Requests deletion: the file disappears for every runtime reader now; the worker removes bytes and row later.
-- Only the owner party (or a company member with company.deals.manage); never under legal hold; true the first time.
CREATE FUNCTION trustwork.files_request_deletion(p_artifact_id uuid) RETURNS boolean
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
  INSERT INTO trustwork.file_artifact_state (artifact_id, origin, deletion_requested_at, deletion_requested_by, deletion_mode)
  VALUES (p_artifact_id, 'upload', now(), trustwork.current_person_id(), 'delete')
  ON CONFLICT (artifact_id) DO UPDATE SET deletion_requested_at = EXCLUDED.deletion_requested_at, deletion_requested_by = EXCLUDED.deletion_requested_by, deletion_mode = 'delete';
  RETURN true;
END $$;

-- Source checks shared by copy and move: visible, clean, not restricted, not being deleted, the caller acts for the
-- owner party, the caller may attach to the target parent and the target parent kind accepts the classification.
CREATE FUNCTION trustwork.files_transfer_source(p_source_id uuid, p_parent_kind text, p_parent_id uuid) RETURNS trustwork.evidence_artifact
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_source trustwork.evidence_artifact%ROWTYPE;
BEGIN
  SELECT * INTO v_source FROM trustwork.evidence_artifact WHERE id = p_source_id FOR UPDATE;
  IF NOT FOUND OR v_source.classification = 'restricted' OR trustwork.files_hidden(p_source_id)
     OR NOT trustwork.files_acts_for_owner(v_source.owner_person_id, v_source.owner_company_id) THEN
    RAISE EXCEPTION 'file not found' USING ERRCODE = 'insufficient_privilege', HINT = 'files.not_found';
  END IF;
  IF v_source.scan_state <> 'clean' THEN
    RAISE EXCEPTION 'only a clean file can be copied or moved' USING ERRCODE = 'check_violation', HINT = 'files.not_clean';
  END IF;
  IF NOT trustwork.files_can_attach(p_parent_kind, p_parent_id) THEN
    RAISE EXCEPTION 'the target parent does not accept files from the caller' USING ERRCODE = 'insufficient_privilege', HINT = 'files.parent_not_found';
  END IF;
  IF NOT trustwork.files_classification_allowed(p_parent_kind, v_source.classification) THEN
    RAISE EXCEPTION 'the target parent kind does not accept this classification' USING ERRCODE = 'check_violation', HINT = 'files.classification_not_allowed';
  END IF;
  IF p_parent_kind = 'person' AND v_source.owner_person_id IS DISTINCT FROM p_parent_id THEN
    RAISE EXCEPTION 'files of a person belong to that person' USING ERRCODE = 'check_violation', HINT = 'files.classification_not_allowed';
  END IF;
  RETURN v_source;
END $$;

-- Copy: a new pending artifact with the same owner, classification, uploader and content identity under another
-- parent and a new storage key; the worker copies the bytes, verifies them and marks the copy clean.
CREATE FUNCTION trustwork.files_copy(p_source_id uuid, p_parent_kind text, p_parent_id uuid, p_storage_key text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_source trustwork.evidence_artifact%ROWTYPE;
  v_id uuid;
BEGIN
  v_source := trustwork.files_transfer_source(p_source_id, p_parent_kind, p_parent_id);
  INSERT INTO trustwork.evidence_artifact (owner_person_id, owner_company_id, parent_kind, parent_id, classification, storage_key, sha256, bytes, media_type, uploaded_by)
  VALUES (v_source.owner_person_id, v_source.owner_company_id, p_parent_kind, p_parent_id, v_source.classification, p_storage_key, v_source.sha256, v_source.bytes, v_source.media_type, v_source.uploaded_by)
  RETURNING id INTO v_id;
  INSERT INTO trustwork.file_artifact_state (artifact_id, origin, source_artifact_id, copy_from_key) VALUES (v_id, 'copy', v_source.id, v_source.storage_key);
  RETURN v_id;
END $$;

-- Move: in one transaction the source row is removed and a new artifact with the same owner, classification,
-- uploader, bytes and storage key (and the clean verdict of those bytes) appears under the target parent. Refused
-- under legal hold (the kernel delete guard).
CREATE FUNCTION trustwork.files_move(p_source_id uuid, p_parent_kind text, p_parent_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_source trustwork.evidence_artifact%ROWTYPE;
  v_id uuid;
BEGIN
  v_source := trustwork.files_transfer_source(p_source_id, p_parent_kind, p_parent_id);
  IF v_source.legal_hold THEN
    RAISE EXCEPTION 'artifact under legal hold' USING ERRCODE = 'integrity_constraint_violation', HINT = 'files.legal_hold';
  END IF;
  IF v_source.parent_kind = p_parent_kind AND v_source.parent_id = p_parent_id THEN
    RAISE EXCEPTION 'the file is already attached there' USING ERRCODE = 'check_violation', HINT = 'files.same_parent';
  END IF;
  DELETE FROM trustwork.evidence_artifact WHERE id = v_source.id;
  INSERT INTO trustwork.evidence_artifact (owner_person_id, owner_company_id, parent_kind, parent_id, classification, storage_key, sha256, bytes, media_type, scan_state, uploaded_by)
  VALUES (v_source.owner_person_id, v_source.owner_company_id, p_parent_kind, p_parent_id, v_source.classification, v_source.storage_key, v_source.sha256, v_source.bytes, v_source.media_type, 'clean', v_source.uploaded_by)
  RETURNING id INTO v_id;
  INSERT INTO trustwork.file_artifact_state (artifact_id, origin, source_artifact_id, scanned_at) VALUES (v_id, 'move', v_source.id, now());
  RETURN v_id;
END $$;

-- 4. Entry points of the worker role ----------------------------------------------------------------------------------

-- What the scanner needs about one artifact: no owner, no parent, no uploader.
CREATE FUNCTION trustwork.files_scan_target(p_artifact_id uuid)
RETURNS TABLE (storage_key text, sha256 text, bytes bigint, media_type text, classification text, scan_state text, copy_from_key text, upload_completed boolean, hidden boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT a.storage_key, a.sha256, a.bytes, a.media_type, a.classification, a.scan_state, s.copy_from_key,
         (s.origin <> 'upload' OR s.upload_completed_at IS NOT NULL), (s.deletion_requested_at IS NOT NULL)
  FROM trustwork.evidence_artifact a LEFT JOIN trustwork.file_artifact_state s ON s.artifact_id = a.id
  WHERE a.id = p_artifact_id
$$;

-- Records the verdict once: pending -> clean | quarantined (a reason exactly when quarantined), audited.
CREATE FUNCTION trustwork.files_record_scan(p_artifact_id uuid, p_state text, p_reason text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF p_state NOT IN ('clean', 'quarantined') OR ((p_state = 'quarantined') <> (p_reason IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid scan verdict' USING ERRCODE = 'check_violation', HINT = 'files.invalid_verdict';
  END IF;
  UPDATE trustwork.evidence_artifact SET scan_state = p_state WHERE id = p_artifact_id AND scan_state = 'pending';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO trustwork.file_artifact_state (artifact_id, origin, scanned_at, quarantine_reason) VALUES (p_artifact_id, 'upload', now(), p_reason)
  ON CONFLICT (artifact_id) DO UPDATE SET scanned_at = EXCLUDED.scanned_at, quarantine_reason = EXCLUDED.quarantine_reason;
  INSERT INTO trustwork.audit_event (action, object_kind, object_id, basis)
  VALUES (CASE p_state WHEN 'clean' THEN 'file.scan_clean' ELSE 'file.quarantined' END, 'evidence_artifact', p_artifact_id::text, jsonb_build_object('reason', p_reason));
  RETURN true;
END $$;

-- What a deletion or erasure needs: the storage key and the request; nothing when no deletion was requested.
CREATE FUNCTION trustwork.files_deletion_target(p_artifact_id uuid)
RETURNS TABLE (storage_key text, legal_hold boolean, deletion_mode text, privacy_request_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT a.storage_key, a.legal_hold, s.deletion_mode, s.privacy_request_id
  FROM trustwork.evidence_artifact a JOIN trustwork.file_artifact_state s ON s.artifact_id = a.id
  WHERE a.id = p_artifact_id AND s.deletion_requested_at IS NOT NULL
$$;

-- Erasure decided by the privacy officer and executed by two different people; marks the artifact for the worker.
-- A legal hold wins (lawful preservation is reconciled by the privacy officer, never overridden here).
CREATE FUNCTION trustwork.files_request_erasure(p_artifact_id uuid, p_privacy_request_id text, p_executed_by uuid, p_second_approver uuid) RETURNS boolean
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

-- Removes the row once the tombstone is written and the bytes are gone; audited. Refused under legal hold.
CREATE FUNCTION trustwork.files_finish_deletion(p_artifact_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_mode text;
  v_request text;
BEGIN
  SELECT s.deletion_mode, s.privacy_request_id INTO v_mode, v_request FROM trustwork.file_artifact_state s WHERE s.artifact_id = p_artifact_id AND s.deletion_requested_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM trustwork.evidence_artifact WHERE id = p_artifact_id;
  INSERT INTO trustwork.audit_event (action, object_kind, object_id, basis)
  VALUES (CASE v_mode WHEN 'erase' THEN 'file.erased' ELSE 'file.deleted' END, 'evidence_artifact', p_artifact_id::text, jsonb_build_object('privacyRequestId', v_request));
  RETURN true;
END $$;

-- Restore replay: removes a row that a restore brought back although its tombstone says it is gone (by id or by its
-- storage key, which a move keeps). Returns the number of rows removed; a row under legal hold raises for an operator.
CREATE FUNCTION trustwork.files_apply_tombstone(p_artifact_id uuid, p_storage_key text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM trustwork.evidence_artifact WHERE id = p_artifact_id OR storage_key = p_storage_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    INSERT INTO trustwork.audit_event (action, object_kind, object_id, basis)
    VALUES ('file.tombstone_replayed', 'evidence_artifact', p_artifact_id::text, jsonb_build_object('rows', v_count));
  END IF;
  RETURN v_count;
END $$;

-- Uploads whose window passed more than an hour ago without a completion report (never visible to anyone else).
CREATE FUNCTION trustwork.files_expired_uploads(p_limit integer) RETURNS TABLE (artifact_id uuid, storage_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT a.id, a.storage_key FROM trustwork.file_artifact_state s JOIN trustwork.evidence_artifact a ON a.id = s.artifact_id
  WHERE s.origin = 'upload' AND s.upload_completed_at IS NULL AND s.upload_expires_at < now() - interval '1 hour' AND a.scan_state = 'pending' AND NOT a.legal_hold
  ORDER BY s.upload_expires_at LIMIT least(greatest(p_limit, 1), 500)
$$;

-- Discards one abandoned upload after its bytes were removed (re-checks the condition; false when it no longer holds).
CREATE FUNCTION trustwork.files_discard_upload(p_artifact_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  DELETE FROM trustwork.evidence_artifact a USING trustwork.file_artifact_state s
  WHERE a.id = p_artifact_id AND s.artifact_id = a.id AND s.origin = 'upload' AND s.upload_completed_at IS NULL
    AND s.upload_expires_at < now() - interval '1 hour' AND a.scan_state = 'pending' AND NOT a.legal_hold;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO trustwork.audit_event (action, object_kind, object_id) VALUES ('file.upload_abandoned', 'evidence_artifact', p_artifact_id::text);
  RETURN true;
END $$;

-- 5. Grants ------------------------------------------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION trustwork.files_hidden(uuid), trustwork.files_register_upload(uuid, integer), trustwork.files_complete_upload(uuid),
  trustwork.files_request_deletion(uuid), trustwork.files_copy(uuid, text, uuid, text), trustwork.files_move(uuid, text, uuid) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.files_scan_target(uuid), trustwork.files_record_scan(uuid, text, text), trustwork.files_deletion_target(uuid),
  trustwork.files_request_erasure(uuid, text, uuid, uuid), trustwork.files_finish_deletion(uuid), trustwork.files_apply_tombstone(uuid, text),
  trustwork.files_expired_uploads(integer), trustwork.files_discard_upload(uuid) TO trustwork_worker;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
