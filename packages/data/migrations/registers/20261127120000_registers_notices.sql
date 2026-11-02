-- REG-001 part 4: reminder notices and facts by identifier.
--
-- 1. The COMMS-001 template registry gains `registers.licence_expiring` (database twin of NOTIFICATION_TEMPLATES in
--    packages/contracts/src/communications.ts): category account, parameters factKind, validUntil and daysBefore. The
--    function bodies repeat the existing keys unchanged.
-- 2. The expiry watch now also tells every active administrator of the company in the notification centre, once per
--    reminder (dedupe key `registers:reminder:<id>`). The notice carries only the fact kind, the register's last valid
--    day and the days left: no identifier, no record reference, no link to anything outside the workspace. E-mail
--    delivery waits for the hub's template versions of this key (COMMS-001 templates); nothing is planned here.
-- 3. Canonical entities (ENT-001) cite register facts by identifier: staff of the hub read the current facts for an
--    identifier kind and value, before display rules, with source, observed time, licence snapshot and valid_until.

CREATE OR REPLACE FUNCTION trustwork.comms_template_params(p_key text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_key
    WHEN 'thread.opened' THEN ARRAY['contextKind', 'threadSubject', 'authorName']
    WHEN 'thread.message' THEN ARRAY['contextKind', 'threadSubject', 'authorName']
    WHEN 'account.security_notice' THEN ARRAY['event']
    WHEN 'registers.licence_expiring' THEN ARRAY['factKind', 'validUntil', 'daysBefore']
  END::text[]
$$;
CREATE OR REPLACE FUNCTION trustwork.comms_template_category(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_key WHEN 'thread.opened' THEN 'messages' WHEN 'thread.message' THEN 'messages' WHEN 'account.security_notice' THEN 'account'
    WHEN 'registers.licence_expiring' THEN 'account' END
$$;

CREATE OR REPLACE FUNCTION trustwork.registers_run_expiry_watch(p_now timestamptz) RETURNS SETOF trustwork.register_reminder
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_reminder trustwork.register_reminder%ROWTYPE;
BEGIN
  FOR v_reminder IN
    INSERT INTO trustwork.register_reminder (hub_id, company_id, fact_id, adapter_id, kind, record_ref, valid_until, days_before)
    SELECT f.hub_id, c.id, f.id, f.adapter_id, f.kind, f.record_ref, f.valid_until, step.d
      FROM trustwork.register_fact f
      JOIN trustwork.company c ON c.claim_status IN ('claimed', 'verified')
       AND (trustwork.registers_company_holds(c.id, f.identifier_kind, f.identifier_norm)
         OR EXISTS (SELECT 1 FROM trustwork.register_fact_link l WHERE l.adapter_id = f.adapter_id AND l.record_ref = f.record_ref AND l.company_id = c.id AND l.ended_at IS NULL))
      CROSS JOIN LATERAL (
        SELECT min(d) AS d FROM unnest(trustwork.registers_reminder_days()) d WHERE f.valid_until - (p_now AT TIME ZONE 'UTC')::date <= d) step
     WHERE f.superseded_at IS NULL AND f.valid_until IS NOT NULL AND f.valid_until >= (p_now AT TIME ZONE 'UTC')::date AND step.d IS NOT NULL
    ON CONFLICT (company_id, adapter_id, kind, record_ref, valid_until, days_before) DO NOTHING
    RETURNING *
  LOOP
    INSERT INTO trustwork.notification (recipient_person_id, category, template_key, params, transactional, dedupe_key)
    SELECT m.person_id, trustwork.comms_template_category('registers.licence_expiring'), 'registers.licence_expiring',
           jsonb_build_object('factKind', v_reminder.kind, 'validUntil', to_char(v_reminder.valid_until, 'YYYY-MM-DD'),
             'daysBefore', (v_reminder.valid_until - (p_now AT TIME ZONE 'UTC')::date)::text),
           trustwork.comms_template_transactional('registers.licence_expiring'), 'registers:reminder:' || v_reminder.id::text
      FROM trustwork.membership m
     WHERE m.company_id = v_reminder.company_id AND m.status = 'active' AND m.role = 'administrator'
    ON CONFLICT (recipient_person_id, dedupe_key) DO NOTHING;
    RETURN NEXT v_reminder;
  END LOOP;
END $$;

-- Staff of the hub: current facts for an identifier (ENT-001 cites them field by field), before display rules.
CREATE FUNCTION trustwork.registers_identifier_facts(p_hub uuid, p_kind text, p_value text) RETURNS SETOF trustwork.register_fact
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.registers_staff_reader(p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN QUERY SELECT * FROM trustwork.register_fact f
   WHERE f.hub_id = p_hub AND f.superseded_at IS NULL AND f.identifier_kind = p_kind AND f.identifier_norm = trustwork.registers_norm(p_value)
   ORDER BY f.kind, f.record_ref;
END $$;

REVOKE EXECUTE ON FUNCTION trustwork.registers_identifier_facts(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.registers_identifier_facts(uuid, text, text) TO trustwork_app;
