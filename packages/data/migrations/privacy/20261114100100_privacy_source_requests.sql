-- A case-scoped human attestation binds one sourced record, action and current source revision.
-- Contact knowledge and a marketing objection never issue this capability.
CREATE TABLE trustwork.privacy_source_proof (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  source_field_id uuid NOT NULL REFERENCES trustwork.sourced_record_field(id),
  source_digest text NOT NULL, action text NOT NULL CHECK(action IN ('correction', 'erasure', 'objection')),
  grant_id uuid NOT NULL REFERENCES trustwork.case_access_grant(id),
  verified_by uuid NOT NULL REFERENCES trustwork.person(id), evidence_ref uuid NOT NULL,
  method text NOT NULL CHECK(method IN ('signed_statement', 'record_control', 'verified_representative')),
  expires_at timestamptz NOT NULL, used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trustwork.privacy_source_request (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), proof_id uuid NOT NULL UNIQUE REFERENCES trustwork.privacy_source_proof(id),
  source_field_id uuid NOT NULL REFERENCES trustwork.sourced_record_field(id),
  action text NOT NULL CHECK(action IN ('correction', 'erasure', 'objection')),
  proposed_value text CHECK(length(proposed_value) BETWEEN 1 AND 2000),
  state text NOT NULL DEFAULT 'received' CHECK(state IN ('received', 'objection_applied', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK((action = 'correction') = (proposed_value IS NOT NULL))
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['privacy_source_proof', 'privacy_source_request'] LOOP
    EXECUTE format('ALTER TABLE trustwork.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE trustwork.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY maintenance ON trustwork.%I TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on())', t);
  END LOOP;
END $$;

CREATE FUNCTION trustwork.privacy_source_digest(p_field uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('field', to_jsonb(f), 'sourceRevision', s.revision, 'sourceStatus', s.status))
  FROM trustwork.sourced_record_field f JOIN trustwork.source s ON s.id = f.source_id WHERE f.id = p_field
$$;
CREATE FUNCTION trustwork.privacy_source_key(p_kind text, p_record uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT encode(sha256(convert_to('source-record:' || p_kind || ':' || p_record::text, 'UTF8')), 'hex')
$$;

CREATE FUNCTION trustwork.privacy_source_prove(p_ctx jsonb, p_field uuid, p_grant uuid, p_action text, p_token_hash text, p_method text, p_evidence uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_actor trustwork.admin_actor; v_field trustwork.sourced_record_field%ROWTYPE;
  v_grant trustwork.case_access_grant%ROWTYPE; v_id uuid; v_source_id uuid;
BEGIN
  SELECT * INTO v_field FROM trustwork.sourced_record_field WHERE id = p_field;
  IF NOT FOUND OR NOT v_field.active THEN RAISE EXCEPTION 'record unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found'; END IF;
  SELECT * INTO v_grant FROM trustwork.case_access_grant WHERE id = p_grant;
  PERFORM 1 FROM trustwork.person WHERE id = trustwork.current_person_id() FOR SHARE;
  PERFORM 1 FROM trustwork.staff_role_assignment WHERE person_id = trustwork.current_person_id() ORDER BY id FOR SHARE;
  PERFORM 1 FROM trustwork.support_case WHERE id = v_grant.support_case_id FOR SHARE;
  SELECT * INTO v_grant FROM trustwork.case_access_grant WHERE id = p_grant FOR SHARE;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.privacy.request.read'], NULL, v_field.hub_id);
  IF NOT coalesce(trustwork.admin_grant_usable(v_actor.person_id, p_grant, 'sourced_record_field', p_field), false)
    OR v_grant.hub_id <> v_field.hub_id THEN
    RAISE EXCEPTION 'current record-specific case grant required' USING ERRCODE = '42501', HINT = 'privacy.case_grant_required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.support_case_note WHERE id = p_evidence AND support_case_id = v_grant.support_case_id
      AND author_person_id = v_actor.person_id AND visibility = 'internal') THEN
    RAISE EXCEPTION 'recorded human verification evidence required' USING ERRCODE = '42501', HINT = 'privacy.proof_required';
  END IF;
  v_source_id := v_field.source_id;
  PERFORM 1 FROM trustwork.source WHERE id = v_source_id FOR SHARE;
  SELECT * INTO v_field FROM trustwork.sourced_record_field WHERE id = p_field FOR SHARE;
  IF NOT FOUND OR NOT v_field.active OR v_field.source_id IS DISTINCT FROM v_source_id OR v_grant.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'record unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found';
  END IF;
  INSERT INTO trustwork.privacy_source_proof(token_hash, source_field_id, source_digest, action, grant_id, verified_by, evidence_ref, method, expires_at)
    VALUES(p_token_hash, p_field, trustwork.privacy_source_digest(p_field), p_action, p_grant, v_actor.person_id, p_evidence, p_method, v_grant.expires_at) RETURNING id INTO v_id;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_field.hub_id, 'privacy.source_proof_issued', 'privacy_source_proof', v_id, NULL,
    jsonb_build_object('sourceFieldId', p_field, 'action', p_action, 'method', p_method, 'evidenceRef', p_evidence), v_grant.support_case_id);
  RETURN v_id;
END $$;

CREATE FUNCTION trustwork.privacy_source_submit(p_token_hash text, p_action text, p_value text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_proof trustwork.privacy_source_proof%ROWTYPE; v_field trustwork.sourced_record_field%ROWTYPE;
  v_grant trustwork.case_access_grant%ROWTYPE; v_key text; v_source_id uuid;
BEGIN
  SELECT * INTO v_proof FROM trustwork.privacy_source_proof WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_proof.used_at IS NOT NULL OR v_proof.expires_at <= now() OR v_proof.action IS DISTINCT FROM p_action THEN RETURN; END IF;
  SELECT * INTO v_grant FROM trustwork.case_access_grant WHERE id = v_proof.grant_id;
  PERFORM 1 FROM trustwork.staff_role_assignment WHERE person_id = v_proof.verified_by ORDER BY id FOR SHARE;
  PERFORM 1 FROM trustwork.support_case WHERE id = v_grant.support_case_id FOR SHARE;
  SELECT * INTO v_grant FROM trustwork.case_access_grant WHERE id = v_proof.grant_id FOR SHARE;
  -- Resolve identity without a child lock, then follow SRC's parent-before-child order.
  SELECT source_id INTO v_source_id FROM trustwork.sourced_record_field WHERE id = v_proof.source_field_id;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM trustwork.source WHERE id = v_source_id FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_field FROM trustwork.sourced_record_field WHERE id = v_proof.source_field_id FOR SHARE;
  IF NOT FOUND OR NOT v_field.active OR v_field.source_id IS DISTINCT FROM v_source_id THEN RETURN; END IF;
  IF NOT coalesce(trustwork.admin_grant_usable(v_proof.verified_by, v_proof.grant_id, 'sourced_record_field', v_field.id), false)
    OR NOT EXISTS(SELECT 1 FROM trustwork.admin_resolve_permission(v_proof.verified_by, 'admin.privacy.request.read', NULL, v_field.hub_id) r WHERE r.role IS NOT NULL)
    OR trustwork.privacy_source_digest(v_field.id) IS DISTINCT FROM v_proof.source_digest THEN RETURN; END IF;
  INSERT INTO trustwork.privacy_source_request(proof_id, source_field_id, action, proposed_value, state)
    VALUES(v_proof.id, v_field.id, p_action, p_value, CASE WHEN p_action = 'objection' THEN 'objection_applied' ELSE 'received' END);
  UPDATE trustwork.privacy_source_proof SET used_at = now() WHERE id = v_proof.id;
  IF p_action = 'objection' THEN
    v_key := trustwork.privacy_source_key(v_field.record_kind, v_field.record_id);
    PERFORM trustwork.privacy_contact_lock(v_key);
    INSERT INTO trustwork.privacy_suppression(digest, marketing, do_not_collect) VALUES(v_key, false, true)
      ON CONFLICT(digest) DO UPDATE SET do_not_collect = true;
  END IF;
END $$;

-- An additive consumer at the actual SRC staging table: all current stage/refresh commands pass here.
-- Existing provenance stays immutable; correction/erasure decisions are separate owning operations.
CREATE FUNCTION trustwork.privacy_source_collect_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_key text := trustwork.privacy_source_key(NEW.record_kind, NEW.record_id);
BEGIN
  PERFORM trustwork.privacy_contact_lock(v_key);
  IF EXISTS(SELECT 1 FROM trustwork.privacy_suppression WHERE digest = v_key AND do_not_collect) THEN
    RAISE EXCEPTION 'record collection blocked' USING ERRCODE = '42501', HINT = 'privacy.do_not_collect';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER privacy_source_collect BEFORE INSERT ON trustwork.sourced_record_field
  FOR EACH ROW EXECUTE FUNCTION trustwork.privacy_source_collect_guard();

REVOKE EXECUTE ON FUNCTION trustwork.privacy_source_digest(uuid), trustwork.privacy_source_key(text, uuid),
  trustwork.privacy_source_prove(jsonb, uuid, uuid, text, text, text, uuid), trustwork.privacy_source_submit(text, text, text),
  trustwork.privacy_source_collect_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.privacy_source_prove(jsonb, uuid, uuid, text, text, text, uuid), trustwork.privacy_source_submit(text, text, text) TO trustwork_app;
