-- CONS-001 / COMMS-001: a worker can produce only a due, booked consultation reminder in an existing thread.
-- No public thread/author contract or participant grants change. Local sent means the atomic context effect only.
ALTER TABLE trustwork.consultation_reminder ADD COLUMN message_id uuid NULL UNIQUE REFERENCES trustwork.message(id);
ALTER TABLE trustwork.delivery ADD COLUMN consultation_job_id uuid NULL REFERENCES trustwork.job(id);

-- Locks are held through the local effect or final dispatch. No money/commitment is made: pending money screening
-- alone does not block messages; suspension and jurisdiction holds do. Licence checks use the pinned credential.
CREATE FUNCTION trustwork.comms_consultation_effect_allowed(p_booking uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE b trustwork.consultation_booking%ROWTYPE; v record;
BEGIN
  SELECT * INTO b FROM trustwork.consultation_booking WHERE id = p_booking FOR UPDATE;
  IF b.id IS NULL OR b.status <> 'booked' OR b.slot_start IS NULL OR b.slot_start <= clock_timestamp() THEN RETURN false; END IF;
  PERFORM 1 FROM trustwork.membership WHERE company_id = b.seller_company_id ORDER BY id FOR SHARE;
  IF b.terms #>> '{credential,credentialId}' IS NOT NULL AND NOT trustwork.consultation_licence_usable(
      (b.terms #>> '{credential,credentialId}')::uuid, b.expert_person_id) THEN RETURN false; END IF;
  FOR v IN SELECT * FROM trustwork.screening_gate_check(
    CASE WHEN b.seller_company_id IS NULL THEN ARRAY['person','person'] ELSE ARRAY['person','person','company'] END,
    CASE WHEN b.seller_company_id IS NULL THEN ARRAY[b.client_person_id,b.expert_person_id]
      ELSE ARRAY[b.client_person_id,b.expert_person_id,b.seller_company_id] END)
  LOOP
    IF v.suspended OR v.place_hold THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION trustwork.comms_consultation_due() RETURNS SETOF uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r.id FROM trustwork.consultation_reminder r JOIN trustwork.consultation_booking b ON b.id = r.booking_id
  WHERE r.status = 'scheduled' AND r.remind_at <= now() AND b.status = 'booked' AND b.slot_start > now()
  ORDER BY r.remind_at, r.id LIMIT 100
$$;

-- The existing governed template is usable only with all seven engine languages activated by a second person.
CREATE FUNCTION trustwork.comms_consultation_templates(p_hub uuid)
RETURNS TABLE(locale text, subject text, body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT v.locale, v.subject, v.body FROM trustwork.message_template t JOIN trustwork.template_version v ON v.template_id = t.id
  WHERE t.hub_id = p_hub AND t.key = 'thread.message' AND v.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['en','es','ru','uz-Latn','ka','hy','az-Latn']) l
      WHERE NOT EXISTS (SELECT 1 FROM trustwork.template_version x WHERE x.template_id = t.id AND x.status = 'active' AND x.locale = l
        AND x.activated_by_person_id IS NOT NULL AND x.activated_by_person_id <> x.drafted_by_person_id))
$$;

CREATE FUNCTION trustwork.comms_produce_consultation_reminder(p_reminder uuid, p_body text)
RETURNS SETOF trustwork.comms_planned_delivery
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.consultation_reminder%ROWTYPE; t trustwork.context_thread%ROWTYPE;
  v_booking uuid; v_message uuid; v_recipient uuid; v_notification uuid;
BEGIN
  SELECT booking_id INTO v_booking FROM trustwork.consultation_reminder WHERE id = p_reminder;
  IF NOT trustwork.comms_consultation_effect_allowed(v_booking) THEN RETURN; END IF;
  SELECT * INTO r FROM trustwork.consultation_reminder WHERE id = p_reminder FOR UPDATE;
  IF r.status <> 'scheduled' OR r.offset_minutes NOT IN (60,1440) OR r.remind_at > clock_timestamp() THEN RETURN; END IF;
  SELECT * INTO t FROM trustwork.context_thread WHERE context_kind = 'agreement' AND context_id = r.agreement_id FOR UPDATE;
  IF t.id IS NULL OR t.status <> 'open' THEN RETURN; END IF;
  IF p_body IS NULL OR length(btrim(p_body)) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'invalid reminder text'; END IF;
  INSERT INTO trustwork.message(thread_id,direction,author_kind,body)
    VALUES(t.id,'internal','system',p_body) RETURNING id INTO v_message;
  INSERT INTO trustwork.message_link(message_id,object_kind,object_id) VALUES(v_message,'agreement',r.agreement_id);
  FOR v_recipient IN SELECT DISTINCT c FROM trustwork.comms_thread_candidates(t.id) c
    WHERE c IS NOT NULL AND trustwork.comms_thread_side(t.context_kind,t.context_id,NULL,NULL,c,trustwork.comms_active_company(c)) IS NOT NULL ORDER BY c
  LOOP
    -- Recipients can include current company deal managers, each checked independently.
    IF EXISTS(SELECT 1 FROM trustwork.screening_gate_check(ARRAY['person'],ARRAY[v_recipient]) WHERE suspended OR place_hold) THEN CONTINUE; END IF;
    INSERT INTO trustwork.notification(recipient_person_id,category,template_key,params,link_kind,link_id,link_thread_id,transactional,dedupe_key)
      VALUES(v_recipient,'messages','thread.message','{"contextKind":"agreement","threadSubject":"","authorName":""}',
        'agreement',r.agreement_id,t.id,false,'message:' || v_message::text) RETURNING id INTO v_notification;
    RETURN QUERY SELECT * FROM trustwork.comms_plan_deliveries(v_notification,NULL);
  END LOOP;
  INSERT INTO trustwork.audit_event(action,object_kind,object_id,basis)
    VALUES('comms.message_posted','message',v_message::text,jsonb_build_object('threadId',t.id,'via','system','reminderId',r.id));
  INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload)
    VALUES('context_thread',t.id::text,t.message_count+1,'comms.message_posted',jsonb_build_object('threadId',t.id,'messageId',v_message));
  -- This is evidence of an internal context write, never a provider delivery acknowledgement.
  INSERT INTO trustwork.send_receipt(message_id,provider,provider_ref,state) VALUES(v_message,'internal',r.id::text,'delivered');
  UPDATE trustwork.consultation_reminder SET status = 'sent', message_id = v_message WHERE id = r.id;
END $$;

-- Resolve only deliveries produced above; callers cannot turn this into a general system-user producer.
CREATE FUNCTION trustwork.comms_consultation_delivery(p_delivery uuid) RETURNS trustwork.delivery
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE d trustwork.delivery%ROWTYPE; r trustwork.consultation_reminder%ROWTYPE; t trustwork.context_thread%ROWTYPE; g trustwork.channel_grant%ROWTYPE;
BEGIN
  SELECT cr.* INTO r FROM trustwork.delivery x JOIN trustwork.notification n ON n.id = x.notification_id
    JOIN trustwork.consultation_reminder cr ON n.dedupe_key = 'message:' || cr.message_id::text WHERE x.id = p_delivery;
  IF r.id IS NULL THEN RETURN NULL; END IF;
  IF NOT trustwork.comms_consultation_effect_allowed(r.booking_id) THEN RETURN NULL; END IF;
  SELECT * INTO d FROM trustwork.delivery WHERE id = p_delivery FOR UPDATE;
  SELECT ct.* INTO t FROM trustwork.notification n JOIN trustwork.context_thread ct ON ct.id = n.link_thread_id WHERE n.id = d.notification_id FOR SHARE OF ct;
  IF t.status <> 'open' OR trustwork.comms_thread_side(t.context_kind,t.context_id,NULL,NULL,d.recipient_person_id,trustwork.comms_active_company(d.recipient_person_id)) IS NULL THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM trustwork.screening_gate_check(ARRAY['person'],ARRAY[d.recipient_person_id]) WHERE suspended OR place_hold) THEN RETURN NULL; END IF;
  PERFORM 1 FROM trustwork.notification_preference WHERE person_id=d.recipient_person_id AND category='messages' AND channel=d.channel FOR SHARE;
  IF coalesce((SELECT frequency FROM trustwork.notification_preference WHERE person_id=d.recipient_person_id AND category='messages' AND channel=d.channel),
      trustwork.comms_default_frequency('messages',d.channel)) <> 'immediate' THEN RETURN NULL; END IF;
  IF d.channel <> 'email' THEN
    SELECT * INTO g FROM trustwork.channel_grant WHERE id=d.channel_grant_id FOR SHARE;
    IF g.status <> 'active' OR NOT (g.scopes->'contextKinds' ? 'agreement' AND g.scopes->'actions' ? 'notify') THEN RETURN NULL; END IF;
  END IF;
  RETURN d;
END $$;

CREATE FUNCTION trustwork.comms_consultation_mail_allowed(p_mail uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_delivery uuid;
BEGIN
  SELECT d.id INTO v_delivery FROM trustwork.delivery d JOIN trustwork.notification n ON n.id=d.notification_id
    JOIN trustwork.consultation_reminder r ON n.dedupe_key='message:' || r.message_id::text WHERE d.mail_delivery_id=p_mail;
  IF v_delivery IS NULL THEN RETURN true; END IF;
  IF (trustwork.comms_consultation_delivery(v_delivery)).id IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM trustwork.email_binding e JOIN trustwork.delivery d ON d.recipient_person_id=e.person_id
    WHERE d.id=v_delivery AND e.is_primary FOR SHARE OF e;
  -- A queued address does not survive withdrawal of verification or replacement of the primary address.
  RETURN EXISTS(SELECT 1 FROM trustwork.delivery d JOIN trustwork.mail_delivery m ON m.id=d.mail_delivery_id
    JOIN trustwork.email_binding e ON e.person_id=d.recipient_person_id AND e.is_primary AND e.verified_at IS NOT NULL
    WHERE d.id=v_delivery AND trustwork.comms_mail_hash(e.email_normalized)=m.recipient_hash)
    AND NOT EXISTS(SELECT 1 FROM trustwork.mail_delivery m JOIN trustwork.suppression_entry s ON s.address_hash=m.recipient_hash WHERE m.id=p_mail);
END $$;

CREATE FUNCTION trustwork.comms_consultation_enqueue_mail(p_delivery uuid, p_locale text, p_subject text, p_body text, p_path text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  d trustwork.delivery := trustwork.comms_consultation_delivery(p_delivery);
  v_transactional boolean;
  v_address text;
  v_hash text;
  v_reason text;
  v_mail uuid := trustwork.new_uuid();
BEGIN
  IF d.id IS NULL THEN RETURN 'skipped'; END IF;
  IF d.channel <> 'email' OR d.state <> 'queued' OR d.mail_delivery_id IS NOT NULL THEN
    RAISE EXCEPTION 'delivery is not a queued e-mail' USING ERRCODE = 'check_violation', HINT = 'comms.delivery_state';
  END IF;
  IF p_path !~ '^/app/[A-Za-z0-9/_.?=&-]{0,255}$' THEN
    RAISE EXCEPTION 'links stay inside the workspace' USING ERRCODE = 'check_violation', HINT = 'comms.link_invalid';
  END IF;
  SELECT n.transactional INTO v_transactional FROM trustwork.notification n WHERE n.id = d.notification_id;
  SELECT b.email_normalized INTO v_address FROM trustwork.email_binding b
  WHERE b.person_id = d.recipient_person_id AND b.is_primary AND b.verified_at IS NOT NULL;
  IF v_address IS NULL THEN
    UPDATE trustwork.delivery SET state = 'skipped', reason = 'no_verified_address' WHERE id = d.id;
    RETURN 'skipped';
  END IF;
  v_hash := trustwork.comms_mail_hash(v_address);
  SELECT s.reason INTO v_reason FROM trustwork.suppression_entry s WHERE s.address_hash = v_hash;
  IF v_reason IS NOT NULL AND (v_reason <> 'unsubscribe' OR NOT coalesce(v_transactional, false)) THEN
    UPDATE trustwork.delivery SET state = 'suppressed', reason = 'suppressed_' || v_reason WHERE id = d.id;
    RETURN 'suppressed';
  END IF;
  INSERT INTO trustwork.mail_delivery (id, template, locale_preferences, recipient, recipient_hash, params)
  VALUES (v_mail, 'notification', ARRAY[p_locale], v_address, v_hash,
          jsonb_build_object('subject', left(p_subject, 200), 'body', left(p_body, 1200), 'path', p_path, 'transactional', CASE WHEN v_transactional THEN 'true' ELSE 'false' END));
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload) VALUES ('mail_delivery', v_mail::text, 1, 'mail.requested', '{}'::jsonb);
  UPDATE trustwork.delivery SET mail_delivery_id = v_mail WHERE id = d.id;
  RETURN 'queued';
END $$;

CREATE OR REPLACE FUNCTION trustwork.consultation_reminder_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  b trustwork.consultation_booking%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reminders are cancelled, not deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'UPDATE' AND current_user = 'trustwork_owner' AND trustwork.maintenance_on()
    AND OLD.status = 'scheduled' AND NEW.status = 'sent' AND OLD.message_id IS NULL
    AND (to_jsonb(NEW) - ARRAY['status','message_id','revision','updated_at']) = (to_jsonb(OLD) - ARRAY['status','message_id','revision','updated_at'])
    AND EXISTS(SELECT 1 FROM trustwork.message m JOIN trustwork.context_thread t ON t.id=m.thread_id
      JOIN trustwork.send_receipt s ON s.message_id=m.id AND s.provider='internal' AND s.provider_ref=OLD.id::text AND s.state='delivered'
      WHERE m.id=NEW.message_id AND m.author_kind='system' AND t.context_kind='agreement' AND t.context_id=OLD.agreement_id)
  THEN RETURN NEW; END IF;
  IF NEW.message_id IS DISTINCT FROM OLD.message_id THEN
    RAISE EXCEPTION 'reminder identity is immutable' USING ERRCODE='integrity_constraint_violation';
  END IF;
  SELECT * INTO b FROM trustwork.consultation_booking WHERE id = NEW.booking_id;
  IF trustwork.consultation_booking_side(NEW.booking_id) IS NULL THEN
    RAISE EXCEPTION 'only the two parties schedule reminders' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF b.status <> 'booked' OR b.slot_start IS NULL OR NEW.agreement_id IS DISTINCT FROM b.agreement_id OR NEW.status <> 'scheduled'
       OR NEW.remind_at <> b.slot_start - make_interval(mins => NEW.offset_minutes) THEN
      RAISE EXCEPTION 'reminders follow the booked slot' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.booking_id, NEW.agreement_id, NEW.remind_at, NEW.offset_minutes, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.booking_id, OLD.agreement_id, OLD.remind_at, OLD.offset_minutes, OLD.created_at)
     OR (NEW.status <> OLD.status AND NOT (OLD.status = 'scheduled' AND NEW.status = 'cancelled' AND b.status = 'cancelled')) THEN
    RAISE EXCEPTION 'a reminder is cancelled with its booking only' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;

GRANT EXECUTE ON FUNCTION trustwork.comms_consultation_due(), trustwork.comms_consultation_templates(uuid),
  trustwork.comms_produce_consultation_reminder(uuid,text), trustwork.comms_consultation_enqueue_mail(uuid,text,text,text,text),
  trustwork.comms_consultation_mail_allowed(uuid) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

-- One leased external job owns each channel delivery. Unknown outcomes remain durable until explicit job reconciliation.
CREATE FUNCTION trustwork.comms_consultation_channel_job(p_delivery uuid,p_job uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE d trustwork.delivery := trustwork.comms_consultation_delivery(p_delivery);
BEGIN
  IF d.id IS NULL OR d.channel='email' OR d.state<>'queued' OR d.consultation_job_id IS NOT NULL THEN RAISE EXCEPTION 'not a new consultation channel delivery'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND kind='consultation.notify' AND payload->>'deliveryId'=p_delivery::text) THEN RAISE EXCEPTION 'wrong delivery job'; END IF;
  UPDATE trustwork.delivery SET consultation_job_id=p_job WHERE id=p_delivery;
END $$;

CREATE FUNCTION trustwork.comms_consultation_channel_claim(p_delivery uuid,p_job uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE d trustwork.delivery := trustwork.comms_consultation_delivery(p_delivery); g trustwork.channel_grant%ROWTYPE;
BEGIN
  IF d.id IS NULL THEN RETURN NULL; END IF;
  IF d.consultation_job_id IS DISTINCT FROM p_job OR d.state NOT IN ('queued','outcome_unknown') THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND state='leased' AND fencing_token=p_fence AND leased_until>clock_timestamp()) THEN RAISE EXCEPTION 'stale delivery lease'; END IF;
  SELECT * INTO g FROM trustwork.channel_grant WHERE id=d.channel_grant_id;
  UPDATE trustwork.delivery SET state='outcome_unknown' WHERE id=d.id;
  RETURN jsonb_build_object('deliveryId',d.id,'provider',d.provider,'account',g.account_ref,'languages',
    coalesce((SELECT to_jsonb(languages) FROM trustwork.person_profile WHERE person_id=d.recipient_person_id),'[]'::jsonb));
END $$;

CREATE FUNCTION trustwork.comms_consultation_channel_settle(p_delivery uuid,p_job uuid,p_fence bigint,p_state text,p_ref text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF p_state NOT IN ('sent','failed','outcome_unknown','skipped') THEN RAISE EXCEPTION 'invalid channel result'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND state='leased' AND fencing_token=p_fence AND leased_until>clock_timestamp()) THEN RAISE EXCEPTION 'stale delivery lease'; END IF;
  UPDATE trustwork.delivery SET state=p_state,provider_ref=left(p_ref,200)
    WHERE id=p_delivery AND consultation_job_id=p_job AND state IN ('queued','outcome_unknown');
  IF FOUND AND p_state<>'skipped' THEN
    INSERT INTO trustwork.send_receipt(delivery_id,provider,provider_ref,state)
      SELECT id,provider,left(p_ref,200),CASE p_state WHEN 'sent' THEN 'accepted' WHEN 'failed' THEN 'failed' ELSE 'unknown' END FROM trustwork.delivery WHERE id=p_delivery;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION trustwork.comms_consultation_channel_job(uuid,uuid),
  trustwork.comms_consultation_channel_claim(uuid,uuid,bigint), trustwork.comms_consultation_channel_settle(uuid,uuid,bigint,text,text) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

-- Reconcile durable channel outcomes from the existing REL-001 job evidence; this never resends.
CREATE FUNCTION trustwork.comms_consultation_channel_reconcile() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE d record; v_count integer := 0;
BEGIN
  FOR d IN SELECT x.id,x.provider,j.state AS job_state FROM trustwork.delivery x JOIN trustwork.job j ON j.id=x.consultation_job_id
    WHERE x.state='outcome_unknown' AND j.kind='consultation.notify' AND j.state IN ('succeeded','dead') ORDER BY x.id LIMIT 100 FOR UPDATE OF x SKIP LOCKED
  LOOP
    UPDATE trustwork.delivery SET state=CASE WHEN d.job_state='succeeded' THEN 'sent' ELSE 'failed' END WHERE id=d.id;
    INSERT INTO trustwork.send_receipt(delivery_id,provider,state) VALUES(d.id,d.provider,CASE WHEN d.job_state='succeeded' THEN 'accepted' ELSE 'failed' END);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
GRANT EXECUTE ON FUNCTION trustwork.comms_consultation_channel_reconcile() TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
