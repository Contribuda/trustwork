-- PRV-001 continuation: identifiers-only barriers. A marketing objection is not identity proof.
CREATE FUNCTION trustwork.privacy_contact_lock(p_digest text) RETURNS void
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('privacy:contact:' || p_digest, 0))
$$;

CREATE FUNCTION trustwork.privacy_marketing_object(p_digest text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid contact digest' USING ERRCODE = '22023'; END IF;
  PERFORM trustwork.privacy_contact_lock(p_digest);
  INSERT INTO trustwork.privacy_suppression(digest, marketing) VALUES(p_digest, true)
    ON CONFLICT(digest) DO UPDATE SET marketing = true;
  -- Use MAIL's existing unsubscribe semantics: security and transactional notices are not marketing.
  INSERT INTO trustwork.suppression_entry(address_hash, reason, source)
    VALUES(p_digest, 'unsubscribe', 'privacy_objection') ON CONFLICT(address_hash) DO NOTHING;
END $$;

-- Worker-only final-dispatch port. The caller locks its delivery first, then retains this lock through
-- the transport call and transaction end. An unknown outcome still belongs to MAIL reconciliation.
CREATE FUNCTION trustwork.privacy_marketing_allowed(p_digest text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  PERFORM trustwork.privacy_contact_lock(p_digest);
  RETURN NOT EXISTS(SELECT 1 FROM trustwork.privacy_suppression WHERE digest = p_digest AND marketing);
END $$;

CREATE OR REPLACE FUNCTION trustwork.privacy_objection(p_person uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE v_email text;
BEGIN
  INSERT INTO trustwork.privacy_preference(person_id, direct_marketing_objection) VALUES(p_person, true)
    ON CONFLICT(person_id) DO UPDATE SET direct_marketing_objection = true, revision = privacy_preference.revision + 1, updated_at = now();
  FOR v_email IN SELECT email_normalized FROM trustwork.email_binding WHERE person_id = p_person AND verified_at IS NOT NULL ORDER BY email_normalized LOOP
    -- Retain the original journal key; add MAIL's namespaced key without rewriting retained decisions.
    INSERT INTO trustwork.privacy_suppression(digest, person_id)
      VALUES(encode(sha256(convert_to(v_email, 'UTF8')), 'hex'), p_person) ON CONFLICT(digest) DO UPDATE SET marketing = true;
    PERFORM trustwork.privacy_marketing_object(trustwork.comms_mail_hash(v_email));
  END LOOP;
END $$;

CREATE TABLE trustwork.privacy_registry_intake (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  registration_id uuid NOT NULL REFERENCES trustwork.data_broker_registration(id),
  external_ref text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 128),
  contact_digest text NOT NULL CHECK (contact_digest ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  policy_version text,
  deadline_at timestamptz,
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received', 'proof_required')),
  UNIQUE(registration_id, external_ref)
);
ALTER TABLE trustwork.privacy_registry_intake ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.privacy_registry_intake FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON trustwork.privacy_registry_intake TO trustwork_owner
  USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());

CREATE FUNCTION trustwork.privacy_registry_receive(p_ctx jsonb, p_registration uuid, p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.privacy.request.read'], NULL, NULL);
  v_registration trustwork.data_broker_registration%ROWTYPE; v_policy trustwork.privacy_country_policy%ROWTYPE;
  v_item jsonb; v_existing trustwork.privacy_registry_intake%ROWTYPE; v_count integer := 0;
BEGIN
  SELECT * INTO v_registration FROM trustwork.data_broker_registration WHERE id = p_registration FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'registry unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found'; END IF;
  SELECT * INTO v_policy FROM trustwork.privacy_country_policy WHERE country = v_registration.country FOR SHARE;
  IF v_policy.review IS DISTINCT FROM 'verified' OR v_policy.registry_poll_hours IS NULL OR v_policy.registry_deadline_days IS NULL THEN
    RETURN jsonb_build_object('status', 'UNKNOWN', 'received', 0, 'nextPollAt', NULL);
  END IF;
  IF v_registration.next_poll_at > now() THEN RETURN jsonb_build_object('status', 'not_due', 'received', 0, 'nextPollAt', v_registration.next_poll_at); END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) > 100 THEN RAISE EXCEPTION 'invalid registry batch' USING ERRCODE = '22023'; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_existing FROM trustwork.privacy_registry_intake WHERE registration_id = p_registration AND external_ref = v_item->>'externalRef';
    IF FOUND AND v_existing.contact_digest IS DISTINCT FROM v_item->>'contactDigest' THEN
      RAISE EXCEPTION 'registry reference conflict' USING ERRCODE = '22023', HINT = 'privacy.registry_conflict';
    END IF;
    INSERT INTO trustwork.privacy_registry_intake(registration_id, external_ref, contact_digest, policy_version, deadline_at, state)
      VALUES(p_registration, v_item->>'externalRef', v_item->>'contactDigest', v_policy.version,
        now() + make_interval(days => v_policy.registry_deadline_days), 'proof_required') ON CONFLICT DO NOTHING;
    IF FOUND THEN v_count := v_count + 1; END IF;
    -- Intake is not deletion authority and cannot assert an address matches a subject.
    PERFORM trustwork.privacy_marketing_object(v_item->>'contactDigest');
  END LOOP;
  UPDATE trustwork.data_broker_registration SET last_polled_at = now(), next_poll_at = now() + make_interval(hours => v_policy.registry_poll_hours)
    WHERE id = p_registration RETURNING * INTO v_registration;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, NULL, 'privacy.registry_received', 'data_broker_registration', p_registration, NULL,
    jsonb_build_object('received', v_count, 'policyVersion', v_policy.version));
  RETURN jsonb_build_object('status', 'received', 'received', v_count, 'nextPollAt', v_registration.next_poll_at);
END $$;

REVOKE EXECUTE ON FUNCTION trustwork.privacy_contact_lock(text), trustwork.privacy_marketing_object(text),
  trustwork.privacy_marketing_allowed(text), trustwork.privacy_registry_receive(jsonb, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.privacy_marketing_object(text), trustwork.privacy_registry_receive(jsonb, uuid, jsonb) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.privacy_marketing_allowed(text) TO trustwork_worker;
