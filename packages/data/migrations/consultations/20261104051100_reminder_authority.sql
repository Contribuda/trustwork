-- CONS-001: immutable confirmation provenance and absence-safe final dispatch serialization.
-- NULL means unknown legacy/unconfigured provenance; never backfill from a process default.
ALTER TABLE trustwork.consultation_reminder ADD COLUMN source_hub_id uuid REFERENCES trustwork.hub(id);
CREATE INDEX consultation_reminder_hub_due_idx ON trustwork.consultation_reminder(source_hub_id,remind_at,id) WHERE status='scheduled';
GRANT INSERT (source_hub_id) ON trustwork.consultation_reminder TO trustwork_app;

CREATE FUNCTION trustwork.consultation_reminder_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.source_hub_id IS DISTINCT FROM OLD.source_hub_id THEN
    RAISE EXCEPTION 'reminder source hub is immutable' USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consultation_reminder_0source_guard BEFORE UPDATE ON trustwork.consultation_reminder
  FOR EACH ROW EXECUTE FUNCTION trustwork.consultation_reminder_source_guard();

-- Every writer, including the first INSERT and maintenance, takes the same key as dispatch.
-- Do not combine this advisory lock with a preference row lock in the reader: UPDATE has already
-- locked its row before its trigger runs. The next VOLATILE statement sees the committed preference.
CREATE FUNCTION trustwork.comms_preference_write_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE r trustwork.notification_preference%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.person_id,NEW.category,NEW.channel) IS DISTINCT FROM ROW(OLD.person_id,OLD.category,OLD.channel) THEN
    RAISE EXCEPTION 'preference identity is immutable' USING ERRCODE='integrity_constraint_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.comms.preference:' || r.person_id::text || ':' || r.category || ':' || r.channel,0));
  RETURN r;
END $$;
CREATE TRIGGER comms_preference_write_lock BEFORE INSERT OR UPDATE OR DELETE ON trustwork.notification_preference
  FOR EACH ROW EXECUTE FUNCTION trustwork.comms_preference_write_lock();

-- Suppression is another absent-row revoker (unsubscribe, complaint, bounce or legal hold).
CREATE FUNCTION trustwork.comms_suppression_write_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE r trustwork.suppression_entry%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.address_hash IS DISTINCT FROM OLD.address_hash THEN
    RAISE EXCEPTION 'suppression identity is immutable' USING ERRCODE='integrity_constraint_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.comms.suppression:' || r.address_hash,0));
  RETURN r;
END $$;
CREATE TRIGGER comms_suppression_write_lock BEFORE INSERT OR UPDATE OR DELETE ON trustwork.suppression_entry
  FOR EACH ROW EXECUTE FUNCTION trustwork.comms_suppression_write_lock();

-- Internal routing probe: distinguishes non-consultation mail from legacy reminders with NULL provenance.
CREATE FUNCTION trustwork.comms_consultation_for_hub(p_id uuid,p_kind text,p_hub uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_hub uuid;
BEGIN
  IF p_kind='reminder' THEN
    SELECT source_hub_id INTO v_hub FROM trustwork.consultation_reminder WHERE id=p_id;
  ELSIF p_kind IN ('mail','channel') THEN
    SELECT r.source_hub_id INTO v_hub FROM trustwork.consultation_reminder r
      JOIN trustwork.notification n ON n.dedupe_key='message:' || r.message_id::text
      JOIN trustwork.delivery d ON d.notification_id=n.id
      WHERE (p_kind='mail' AND d.mail_delivery_id=p_id) OR (p_kind='channel' AND d.id=p_id);
    IF NOT FOUND AND p_kind='mail' THEN RETURN true; END IF;
  ELSE RETURN false;
  END IF;
  RETURN coalesce(v_hub=p_hub,false);
END $$;

DROP FUNCTION trustwork.comms_consultation_due();
CREATE FUNCTION trustwork.comms_consultation_due(p_hub uuid) RETURNS SETOF uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r.id FROM trustwork.consultation_reminder r JOIN trustwork.consultation_booking b ON b.id = r.booking_id
  WHERE r.source_hub_id=p_hub AND r.status = 'scheduled' AND r.remind_at <= now() AND b.status = 'booked' AND b.slot_start > now()
  ORDER BY r.remind_at, r.id LIMIT 100
$$;

DROP FUNCTION trustwork.comms_produce_consultation_reminder(uuid,text);
CREATE FUNCTION trustwork.comms_produce_consultation_reminder(p_reminder uuid, p_hub uuid, p_body text)
RETURNS SETOF trustwork.comms_planned_delivery
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.consultation_reminder%ROWTYPE; t trustwork.context_thread%ROWTYPE;
  v_booking uuid; v_message uuid; v_recipient uuid; v_notification uuid;
BEGIN
  IF NOT trustwork.comms_consultation_for_hub(p_reminder,'reminder',p_hub) THEN RETURN; END IF;
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

CREATE OR REPLACE FUNCTION trustwork.comms_consultation_delivery(p_delivery uuid) RETURNS trustwork.delivery
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
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('trustwork.comms.preference:' || d.recipient_person_id::text || ':messages:' || d.channel,0));
  IF coalesce((SELECT frequency FROM trustwork.notification_preference WHERE person_id=d.recipient_person_id AND category='messages' AND channel=d.channel),
      trustwork.comms_default_frequency('messages',d.channel)) <> 'immediate' THEN RETURN NULL; END IF;
  IF d.channel <> 'email' THEN
    SELECT * INTO g FROM trustwork.channel_grant WHERE id=d.channel_grant_id FOR SHARE;
    IF g.status <> 'active' OR NOT (g.scopes->'contextKinds' ? 'agreement' AND g.scopes->'actions' ? 'notify') THEN RETURN NULL; END IF;
  END IF;
  RETURN d;
END $$;

DROP FUNCTION trustwork.comms_consultation_mail_allowed(uuid);
CREATE FUNCTION trustwork.comms_consultation_mail_allowed(p_mail uuid,p_hub uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_delivery uuid;
BEGIN
  IF NOT trustwork.comms_consultation_for_hub(p_mail,'mail',p_hub) THEN RETURN false; END IF;
  SELECT d.id INTO v_delivery FROM trustwork.delivery d JOIN trustwork.notification n ON n.id=d.notification_id
    JOIN trustwork.consultation_reminder r ON n.dedupe_key='message:' || r.message_id::text WHERE d.mail_delivery_id=p_mail;
  IF v_delivery IS NULL THEN RETURN true; END IF;
  IF (trustwork.comms_consultation_delivery(v_delivery)).id IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM trustwork.email_binding e JOIN trustwork.delivery d ON d.recipient_person_id=e.person_id
    WHERE d.id=v_delivery AND e.is_primary FOR SHARE OF e;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('trustwork.comms.suppression:' || m.recipient_hash,0))
    FROM trustwork.mail_delivery m WHERE m.id=p_mail;
  -- A queued address does not survive withdrawal of verification or replacement of the primary address.
  RETURN EXISTS(SELECT 1 FROM trustwork.delivery d JOIN trustwork.mail_delivery m ON m.id=d.mail_delivery_id
    JOIN trustwork.email_binding e ON e.person_id=d.recipient_person_id AND e.is_primary AND e.verified_at IS NOT NULL
    WHERE d.id=v_delivery AND trustwork.comms_mail_hash(e.email_normalized)=m.recipient_hash)
    AND NOT EXISTS(SELECT 1 FROM trustwork.mail_delivery m JOIN trustwork.suppression_entry s ON s.address_hash=m.recipient_hash WHERE m.id=p_mail);
END $$;

DROP FUNCTION trustwork.comms_consultation_channel_claim(uuid,uuid,bigint);
CREATE FUNCTION trustwork.comms_consultation_channel_claim(p_delivery uuid,p_job uuid,p_fence bigint,p_hub uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE d trustwork.delivery := trustwork.comms_consultation_delivery(p_delivery); g trustwork.channel_grant%ROWTYPE;
BEGIN
  IF NOT trustwork.comms_consultation_for_hub(p_delivery,'channel',p_hub) THEN RETURN NULL; END IF;
  IF d.id IS NULL THEN RETURN NULL; END IF;
  IF d.consultation_job_id IS DISTINCT FROM p_job OR d.state NOT IN ('queued','outcome_unknown') THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND state='leased' AND fencing_token=p_fence AND leased_until>clock_timestamp()) THEN RAISE EXCEPTION 'stale delivery lease'; END IF;
  SELECT * INTO g FROM trustwork.channel_grant WHERE id=d.channel_grant_id;
  UPDATE trustwork.delivery SET state='outcome_unknown' WHERE id=d.id;
  RETURN jsonb_build_object('deliveryId',d.id,'provider',d.provider,'account',g.account_ref,'languages',
    coalesce((SELECT to_jsonb(languages) FROM trustwork.person_profile WHERE person_id=d.recipient_person_id),'[]'::jsonb));
END $$;

GRANT EXECUTE ON FUNCTION trustwork.comms_consultation_for_hub(uuid,text,uuid), trustwork.comms_consultation_due(uuid),
  trustwork.comms_produce_consultation_reminder(uuid,uuid,text), trustwork.comms_consultation_mail_allowed(uuid,uuid),
  trustwork.comms_consultation_channel_claim(uuid,uuid,bigint,uuid) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

-- Jobs are routed by persisted origin, so another hub cannot exhaust retries by leasing this hub's work.
CREATE FUNCTION trustwork.comms_consultation_mail_hub(p_mail uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
  SELECT r.source_hub_id FROM trustwork.consultation_reminder r
    JOIN trustwork.notification n ON n.dedupe_key='message:' || r.message_id::text
    JOIN trustwork.delivery d ON d.notification_id=n.id WHERE d.mail_delivery_id=p_mail
$$;
CREATE OR REPLACE FUNCTION trustwork.comms_consultation_channel_job(p_delivery uuid,p_job uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE d trustwork.delivery := trustwork.comms_consultation_delivery(p_delivery);
BEGIN
  IF d.id IS NULL OR d.channel='email' OR d.state<>'queued' OR d.consultation_job_id IS NOT NULL THEN RAISE EXCEPTION 'not a new consultation channel delivery'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND kind='consultation.notify.' || (SELECT r.source_hub_id::text FROM trustwork.consultation_reminder r JOIN trustwork.notification n ON n.dedupe_key='message:' || r.message_id::text WHERE n.id=d.notification_id) AND payload->>'deliveryId'=p_delivery::text) THEN RAISE EXCEPTION 'wrong delivery job'; END IF;
  UPDATE trustwork.delivery SET consultation_job_id=p_job WHERE id=p_delivery;
END $$;

CREATE OR REPLACE FUNCTION trustwork.comms_consultation_channel_reconcile() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE d record; v_count integer := 0;
BEGIN
  FOR d IN SELECT x.id,x.provider,j.state AS job_state FROM trustwork.delivery x JOIN trustwork.job j ON j.id=x.consultation_job_id
    WHERE x.state='outcome_unknown' AND (j.kind='consultation.notify' OR j.kind LIKE 'consultation.notify.%') AND j.state IN ('succeeded','dead') ORDER BY x.id LIMIT 100 FOR UPDATE OF x SKIP LOCKED
  LOOP
    UPDATE trustwork.delivery SET state=CASE WHEN d.job_state='succeeded' THEN 'sent' ELSE 'failed' END WHERE id=d.id;
    INSERT INTO trustwork.send_receipt(delivery_id,provider,state) VALUES(d.id,d.provider,CASE WHEN d.job_state='succeeded' THEN 'accepted' ELSE 'failed' END);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION trustwork.comms_consultation_mail_hub(uuid) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
