-- Preserve the owning SRC public serializer, adding only the durable record-use barrier.
CREATE OR REPLACE FUNCTION trustwork.sources_public_provenance(p_hub uuid, p_kind text, p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT jsonb_build_object('recordKind', p_kind, 'recordId', p_record, 'label', 'sourced', 'fields', coalesce(jsonb_agg(jsonb_build_object(
      'field', f.field, 'value', f.value, 'observedAt', to_char(f.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'source', jsonb_build_object('name', s.name, 'attribution', s.attribution_template, 'url', s.url)) ORDER BY f.field, f.observed_at, f.id), '[]'::jsonb))
  FROM trustwork.sourced_record_field f
  JOIN trustwork.import_batch b ON b.id = f.import_batch_id AND b.status = 'activated'
  JOIN trustwork.source s ON s.id = f.source_id AND s.status IN ('active', 'paused', 'retired') AND trustwork.sources_use(s.allowed_uses, 'displayHeadlineAndLink')
  JOIN trustwork.hub h ON h.id = f.hub_id AND h.lifecycle IN ('soft_launch', 'public')
  WHERE f.hub_id = p_hub AND f.record_kind = p_kind AND f.record_id = p_record AND f.active
    AND NOT EXISTS(SELECT 1 FROM trustwork.privacy_suppression p WHERE p.digest = trustwork.privacy_source_key(f.record_kind, f.record_id) AND p.do_not_collect)
    AND trustwork.sources_use(b.licence_snapshot -> 'allowedUses', 'displayHeadlineAndLink')
    AND (f.source_item_id IS NULL OR EXISTS (SELECT 1 FROM trustwork.source_item i WHERE i.id = f.source_item_id
      AND trustwork.sources_use(trustwork.sources_effective_uses(i), 'displayHeadlineAndLink')))
$$;

-- A batch staged before an objection must not become visible afterwards. Source/batch locks are owned by SRC;
-- contact locks are acquired last, in digest order, matching the staging and objection consumers.
CREATE FUNCTION trustwork.privacy_source_activation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_key text;
BEGIN
  IF NEW.status='activated' AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR v_key IN SELECT DISTINCT trustwork.privacy_source_key(record_kind,record_id) FROM trustwork.sourced_record_field WHERE import_batch_id=NEW.id ORDER BY 1 LOOP
      PERFORM trustwork.privacy_contact_lock(v_key);
      IF EXISTS(SELECT 1 FROM trustwork.privacy_suppression WHERE digest=v_key AND do_not_collect) THEN
        RAISE EXCEPTION 'record activation blocked' USING ERRCODE='42501', HINT='privacy.do_not_collect';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER privacy_source_activation BEFORE UPDATE OF status ON trustwork.import_batch
  FOR EACH ROW EXECUTE FUNCTION trustwork.privacy_source_activation_guard();
REVOKE EXECUTE ON FUNCTION trustwork.privacy_source_activation_guard() FROM PUBLIC;

-- Expiry is checked after all potentially waiting serialization locks, not at transaction start.
CREATE OR REPLACE FUNCTION trustwork.privacy_source_submit(p_token_hash text, p_action text, p_value text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_proof trustwork.privacy_source_proof%ROWTYPE; v_field trustwork.sourced_record_field%ROWTYPE;
  v_grant trustwork.case_access_grant%ROWTYPE; v_key text;
BEGIN
  SELECT * INTO v_proof FROM trustwork.privacy_source_proof WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_proof.used_at IS NOT NULL OR v_proof.expires_at <= clock_timestamp() OR v_proof.action IS DISTINCT FROM p_action THEN RETURN; END IF;
  SELECT * INTO v_grant FROM trustwork.case_access_grant WHERE id = v_proof.grant_id;
  PERFORM 1 FROM trustwork.staff_role_assignment WHERE person_id = v_proof.verified_by ORDER BY id FOR SHARE;
  PERFORM 1 FROM trustwork.support_case WHERE id = v_grant.support_case_id FOR SHARE;
  SELECT * INTO v_grant FROM trustwork.case_access_grant WHERE id = v_proof.grant_id FOR SHARE;
  SELECT * INTO v_field FROM trustwork.sourced_record_field WHERE id = v_proof.source_field_id FOR SHARE;
  PERFORM 1 FROM trustwork.source WHERE id = v_field.source_id FOR SHARE;
  v_key := trustwork.privacy_source_key(v_field.record_kind, v_field.record_id);
  PERFORM trustwork.privacy_contact_lock(v_key);
  IF v_proof.expires_at <= clock_timestamp() OR v_grant.expires_at <= clock_timestamp()
    OR NOT coalesce(trustwork.admin_grant_usable(v_proof.verified_by, v_proof.grant_id, 'sourced_record_field', v_field.id), false)
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
