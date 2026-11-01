-- Pin existing owning authorization epochs, without granting any new context or impersonating a session.
-- Historical rows stay NULL and cannot acquire fresh dispatch authority by guessing today's ownership.
ALTER TABLE trustwork.agent_intent_provenance ADD COLUMN person_authz_epoch integer;
ALTER TABLE trustwork.agent_intent_provenance ADD COLUMN company_id uuid REFERENCES trustwork.company(id);
ALTER TABLE trustwork.agent_intent_provenance ADD COLUMN company_authz_epoch integer;
CREATE OR REPLACE FUNCTION trustwork.agent_modules_intent_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  INSERT INTO trustwork.agent_intent_provenance(action_intent_id,run_id,principal_person_id,hub_id,mandate_id,mandate_revision,mandate_digest,person_authz_epoch,company_id,company_authz_epoch)
    SELECT NEW.id,p.run_id,p.principal_person_id,p.hub_id,m.id,m.revision,m.digest,person.authz_epoch,co.id,co.authz_epoch
    FROM trustwork.agent_run_provenance p JOIN trustwork.mandate m ON m.id=NEW.mandate_id
    JOIN trustwork.person person ON person.id=p.principal_person_id
    LEFT JOIN trustwork.membership member ON member.person_id=person.id AND member.status='active' AND member.valid_from<=clock_timestamp()
    LEFT JOIN trustwork.company co ON co.id=member.company_id
    WHERE p.run_id=NEW.run_id AND p.principal_person_id=NEW.principal_person_id
      AND m.principal_person_id=p.principal_person_id AND m.revision=NEW.mandate_revision AND m.digest IS NOT NULL;
  RETURN NULL;
END $$;

CREATE FUNCTION trustwork.agent_modules_effect_authority_refusal(p_intent uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE p trustwork.agent_intent_provenance%ROWTYPE; r trustwork.agent_run_provenance%ROWTYPE;
  i trustwork.action_intent%ROWTYPE; m trustwork.mandate%ROWTYPE; v_epoch integer; v_connection uuid; v_representative uuid; s trustwork.session%ROWTYPE; v_run_state text;
BEGIN
  SELECT * INTO p FROM trustwork.agent_intent_provenance WHERE action_intent_id=p_intent;
  IF p.person_authz_epoch IS NULL THEN RETURN 'legacy_authority_unknown'; END IF;
  SELECT * INTO m FROM trustwork.mandate WHERE id=p.mandate_id;
  v_representative := CASE WHEN m.grantee_kind='company_representative' THEN m.grantee_company_id END;
  SELECT connection_id INTO v_connection FROM trustwork.connection_call WHERE action_intent_id=p_intent ORDER BY at LIMIT 1;
  PERFORM trustwork.agent_modules_lock_epochs(p.hub_id,v_representative,p.principal_person_id,v_connection);
  SELECT authz_epoch INTO v_epoch FROM trustwork.person WHERE id=p.principal_person_id FOR SHARE;
  IF v_epoch IS DISTINCT FROM p.person_authz_epoch THEN RETURN 'owning_authority_changed'; END IF;
  IF p.company_id IS NOT NULL THEN
    SELECT authz_epoch INTO v_epoch FROM trustwork.company WHERE id=p.company_id FOR SHARE;
    IF v_epoch IS DISTINCT FROM p.company_authz_epoch THEN RETURN 'owning_authority_changed'; END IF;
  END IF;
  SELECT * INTO r FROM trustwork.agent_run_provenance WHERE run_id=p.run_id;
  SELECT * INTO s FROM trustwork.session WHERE id=r.session_id AND person_id=p.principal_person_id FOR SHARE;
  IF s.id IS NULL OR s.revoked_at IS NOT NULL OR s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp() THEN RETURN 'session_authority_unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.agent_serving_hub WHERE id=r.serving_binding_id AND hub_id=p.hub_id AND active) THEN RETURN 'hub_provenance_unavailable'; END IF;
  SELECT * INTO m FROM trustwork.mandate WHERE id=p.mandate_id FOR SHARE;
  SELECT state INTO v_run_state FROM trustwork.run WHERE id=p.run_id FOR SHARE;
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent FOR UPDATE;
  IF m.valid_until<=clock_timestamp() THEN RETURN 'mandate_expired'; END IF;
  IF m.status<>'active' OR m.revision<>p.mandate_revision OR m.digest<>p.mandate_digest THEN RETURN 'mandate_authority_changed'; END IF;
  IF v_run_state IS NULL OR v_run_state IN ('cancelled','failed') THEN RETURN 'run_cancelled'; END IF;
  IF trustwork.agent_modules_dispatch_refusal_internal(p.hub_id,i.module_key,i.capability_id,i.action,i.principal_person_id,v_connection,v_representative) IS NOT NULL THEN RETURN 'kill_switch'; END IF;
  IF trustwork.agent_modules_policy_refusal(p.hub_id,i.capability_id,trustwork.agent_modules_mandate_kind(m.grantee_kind,m.on_behalf_company_id),
    EXISTS(SELECT 1 FROM trustwork.company WHERE id=m.on_behalf_company_id AND claim_status='verified'),'free') IS NOT NULL THEN RETURN 'capability_off'; END IF;
  IF NOT (trustwork.agent_modules_capability_binding(p.hub_id,i.capability_id) -> 'contextKinds') ? i.context_kind THEN RETURN 'capability_binding'; END IF;
  IF NOT trustwork.agent_modules_effect_binding(p.hub_id,i.capability_id,i.effect ->> 'provider',i.effect ->> 'operation') THEN RETURN 'capability_binding'; END IF;
  IF cardinality(i.ask_reasons)>0 THEN
    PERFORM 1 FROM trustwork.approval WHERE action_intent_id=i.id AND action_digest=i.action_digest AND mandate_revision=i.mandate_revision AND revoked_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RETURN 'approval_missing'; END IF;
  END IF;
  IF i.reservation_id IS NOT NULL THEN
    -- Preserve BILL's reservation ownership and lock order; this port grants no money or spending authority.
    PERFORM b.id FROM trustwork.budget b JOIN trustwork.reservation q ON q.budget_id=b.id
      WHERE q.id=i.reservation_id AND b.status='active' AND b.period_from<=clock_timestamp() AND b.period_to>clock_timestamp() FOR SHARE OF b;
    IF NOT FOUND THEN RETURN 'budget_authority_unavailable'; END IF;
    PERFORM 1 FROM trustwork.reservation WHERE id=i.reservation_id FOR SHARE;
    IF NOT trustwork.billing_reservation_open(i.reservation_id) THEN RETURN 'reservation_closed'; END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_effect_authority_refusal(uuid) FROM PUBLIC,trustwork_app,trustwork_worker;

ALTER FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) RENAME TO agent_modules_begin_implementation_attempt;
REVOKE ALL ON FUNCTION trustwork.agent_modules_begin_implementation_attempt(uuid,uuid,uuid,bigint) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.assistant_begin_attempt(p_intent uuid,p_job uuid,p_hub uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_reason text; i trustwork.action_intent%ROWTYPE;
BEGIN
  PERFORM 1 FROM trustwork.job WHERE id=p_job AND kind='assistant.dispatch' AND state='leased' AND leased_until>clock_timestamp()
    AND fencing_token=p_fence AND payload ->> 'intentId'=p_intent::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispatch lease unavailable' USING ERRCODE='55P03',HINT='assistant.fenced_out'; END IF;
  -- Check every current owning epoch before durable admission and quota reservation.
  v_reason := trustwork.agent_modules_effect_authority_refusal(p_intent);
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent FOR UPDATE;
  IF i.state='queued' AND v_reason IS NOT NULL THEN
    PERFORM trustwork.assistant_finish_intent(p_intent,'revoked','recheck: ' || v_reason,'recheck:' || v_reason);
    RETURN jsonb_build_object('status','refused','reason',v_reason);
  END IF;
  RETURN trustwork.agent_modules_begin_implementation_attempt(p_intent,p_job,p_hub,p_fence);
END $$;
REVOKE ALL ON FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) FROM PUBLIC,trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) TO trustwork_worker;

-- Hold the same current authority through the actual code-owned callback. The attempt was committed earlier;
-- a process/transaction crash cannot erase it or authorize retry. Revocation first means no callback at all.
CREATE FUNCTION trustwork.agent_modules_enter_effect(p_attempt uuid,p_job uuid,p_fence bigint) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE a trustwork.action_attempt%ROWTYPE; v_reason text;
BEGIN
  SELECT * INTO a FROM trustwork.action_attempt WHERE id=p_attempt AND job_id=p_job AND fencing_token=p_fence;
  IF a.id IS NULL THEN RAISE EXCEPTION 'unknown fenced attempt' USING ERRCODE='42501'; END IF;
  v_reason := trustwork.agent_modules_effect_authority_refusal(a.action_intent_id);
  IF v_reason IS NOT NULL THEN RETURN false; END IF;
  PERFORM 1 FROM trustwork.job WHERE id=p_job AND state='leased' AND leased_until>clock_timestamp() AND fencing_token=p_fence FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN v_reason IS NULL AND EXISTS(SELECT 1 FROM trustwork.action_intent WHERE id=a.action_intent_id AND state='executing');
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_enter_effect(uuid,uuid,bigint) FROM PUBLIC,trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_enter_effect(uuid,uuid,bigint) TO trustwork_worker;
