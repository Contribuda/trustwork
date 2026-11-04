-- HUB-001 audit fix: a sensitive configuration version is never activated by its drafter (hubs_activate_config_version),
-- but for a legal document the same rule lived only in the console. The API and the database let a drafter request the
-- activation of their own document and, once a second person approved, execute it: two people, of whom the author was
-- the one who put the text into force.
--
-- The database now holds it at both ends, like configuration versions:
--   * asking: a trigger on second_person_approval refuses a legal.activate_document_version request whose digest binds a
--     document its requester drafted, for every writer (the activation route and POST /v1/admin/approvals alike);
--   * executing: hubs_activate_legal_document refuses the drafter, so a request opened before this rule, or under a
--     digest the trigger could not match, still cannot put the drafter's text into force.
-- The drafter may still be the second person who approves another staff member's request, as for configuration versions.

CREATE FUNCTION trustwork.hubs_legal_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.action = 'legal.activate_document_version' AND EXISTS (
       SELECT 1 FROM trustwork.legal_document_version d JOIN trustwork.counsel_approval c ON c.hub_id = d.hub_id AND d.id = ANY (c.document_version_ids)
        WHERE d.hub_id = NEW.hub_id AND d.drafted_by = NEW.requested_by
          AND trustwork.hubs_legal_digest(d.id, d.hub_id, d.kind, d.locale, d.version, d.body_digest, c.id) = NEW.action_digest) THEN
    RAISE EXCEPTION 'a legal document is activated by someone other than its drafter' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_approval';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER second_person_approval_legal_drafter BEFORE INSERT ON trustwork.second_person_approval FOR EACH ROW EXECUTE FUNCTION trustwork.hubs_legal_request_guard();

CREATE OR REPLACE FUNCTION trustwork.hubs_activate_legal_document(p_ctx jsonb, p_document uuid, p_expected_revision integer, p_approval_id uuid) RETURNS trustwork.legal_document_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.legal_document_version%ROWTYPE;
  v_row trustwork.legal_document_version%ROWTYPE;
  v_counsel uuid;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.legal_document_version WHERE id = p_document;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such legal document version' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.admin_action_permissions('legal.activate_document_version'), NULL, v_before.hub_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.legal:' || v_before.hub_id::text || ':' || v_before.kind || ':' || v_before.locale, 0));
  SELECT * INTO v_before FROM trustwork.legal_document_version WHERE id = p_document FOR UPDATE;
  IF v_before.status <> 'draft' THEN
    RAISE EXCEPTION 'the document version is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  IF p_expected_revision IS NOT NULL AND v_before.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the document version changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'hubs.revision_conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.legal_document_version d WHERE d.hub_id = v_before.hub_id AND d.kind = v_before.kind AND d.locale = v_before.locale
             AND d.status = 'active' AND d.version > v_before.version) THEN
    RAISE EXCEPTION 'a newer version is already active' USING ERRCODE = 'check_violation', HINT = 'hubs.config_stale';
  END IF;
  IF v_actor.person_id = v_before.drafted_by THEN
    RAISE EXCEPTION 'a legal document is activated by someone other than its drafter' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_approval';
  END IF;
  SELECT c.id INTO v_counsel FROM trustwork.counsel_approval c WHERE c.hub_id = v_before.hub_id AND p_document = ANY (c.document_version_ids)
   ORDER BY c.recorded_at DESC, c.id LIMIT 1;
  IF v_counsel IS NULL THEN
    RAISE EXCEPTION 'record the counsel approval of this version first' USING ERRCODE = 'check_violation', HINT = 'hubs.counsel_approval_required';
  END IF;
  IF p_approval_id IS NULL THEN
    RAISE EXCEPTION 'activating a legal document needs a second person''s approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
  END IF;
  PERFORM trustwork.admin_consume_approval(p_approval_id, 'legal.activate_document_version', 'hub', NULL, v_before.hub_id,
    trustwork.hubs_legal_digest(v_before.id, v_before.hub_id, v_before.kind, v_before.locale, v_before.version, v_before.body_digest, v_counsel), v_before.id);
  UPDATE trustwork.legal_document_version SET status = 'superseded'
   WHERE hub_id = v_before.hub_id AND kind = v_before.kind AND locale = v_before.locale AND status = 'active';
  UPDATE trustwork.legal_document_version SET status = 'active', activated_by = v_actor.person_id, activated_at = now(), approval_id = p_approval_id, counsel_approval_id = v_counsel
   WHERE id = p_document RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'legal.document_activated', 'legal_document_version', v_row.id,
    jsonb_build_object('status', v_before.status, 'revision', v_before.revision),
    jsonb_build_object('id', v_row.id, 'kind', v_row.kind, 'locale', v_row.locale, 'version', v_row.version, 'bodyDigest', v_row.body_digest, 'status', v_row.status,
      'counselApprovalId', v_row.counsel_approval_id, 'revision', v_row.revision), NULL, p_approval_id);
  RETURN v_row;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
