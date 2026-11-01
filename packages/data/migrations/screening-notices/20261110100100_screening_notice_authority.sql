-- SANC-007: event-time authority is durable and never inferred from a reused address.
CREATE TABLE trustwork.screening_notice_authority (
  delivery_id uuid PRIMARY KEY REFERENCES trustwork.mail_delivery(id),
  person_id uuid NOT NULL REFERENCES trustwork.person(id),
  -- Deliberately no binding FK: deletion must remain possible and must invalidate delivery.
  binding_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE trustwork.screening_notice_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_notice_authority FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.screening_notice_authority TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE TRIGGER screening_notice_authority_append_only BEFORE UPDATE OR DELETE ON trustwork.screening_notice_authority
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER screening_notice_authority_no_truncate BEFORE TRUNCATE ON trustwork.screening_notice_authority
  FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- Internal only: the transition triggers own both the intent and its authority in the same transaction.
CREATE OR REPLACE FUNCTION trustwork.screening_record_notice(p_person uuid, p_kind text) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE e record; v_id uuid;
BEGIN
  IF p_person IS NULL THEN RETURN; END IF;
  FOR e IN SELECT id, email_normalized FROM trustwork.email_binding WHERE person_id = p_person AND verified_at IS NOT NULL LOOP
    v_id := trustwork.new_uuid();
    INSERT INTO trustwork.mail_delivery (id, template, locale_preferences, recipient, recipient_hash, params)
      VALUES (v_id, 'screening_notice', array_remove(ARRAY[trustwork.identity_mail_locale(p_person)], NULL), e.email_normalized,
        encode(sha256(convert_to('mail:' || lower(normalize(btrim(e.email_normalized), NFC)), 'UTF8')), 'hex'), jsonb_build_object('kind', p_kind));
    INSERT INTO trustwork.screening_notice_authority (delivery_id, person_id, binding_id) VALUES (v_id, p_person, e.id);
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
      VALUES ('mail_delivery', v_id::text, 1, 'mail.requested', '{}'::jsonb);
  END LOOP;
END $$;

-- Worker-only boolean port. The caller holds the delivery row first, and retains this transaction through send.
-- FOR SHARE conflicts with actual binding UPDATE/DELETE (including verification removal and identity commands).
-- No row means refusal: no absence lock or fallback to the current owner of the address is needed.
CREATE FUNCTION trustwork.screening_notice_allowed(p_delivery uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM b.id FROM trustwork.screening_notice_authority a
    JOIN trustwork.mail_delivery d ON d.id = a.delivery_id
    JOIN trustwork.email_binding b ON b.id = a.binding_id AND b.person_id = a.person_id
    WHERE a.delivery_id = p_delivery AND d.template = 'screening_notice'
      AND d.recipient = b.email_normalized AND b.verified_at IS NOT NULL
    FOR SHARE OF b;
  RETURN FOUND;
END $$;
REVOKE ALL ON TABLE trustwork.screening_notice_authority FROM PUBLIC, trustwork_app, trustwork_worker;
REVOKE ALL ON FUNCTION trustwork.screening_record_notice(uuid, text), trustwork.screening_notice_allowed(uuid) FROM PUBLIC, trustwork_app, trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.screening_notice_allowed(uuid) TO trustwork_worker;
-- Legacy notices have no provable event-time binding and intentionally receive no backfilled authority.
