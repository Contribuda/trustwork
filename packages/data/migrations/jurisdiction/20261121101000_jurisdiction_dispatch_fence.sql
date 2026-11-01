-- HUB-005 / AGT-003 isolated owning caller repair. Original applied08 SQL stays unchanged.
-- No remote effect runs here; original immutable origin and current lease feed the real AGT command.
CREATE OR REPLACE FUNCTION trustwork.jurisdiction_begin_attempt(p_intent uuid,p_job uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE i trustwork.action_intent%ROWTYPE; b trustwork.jurisdiction_intent_binding%ROWTYPE; limits jsonb;
  q trustwork.quote%ROWTYPE; party_person uuid; party_company uuid; authorized boolean; j trustwork.job%ROWTYPE; origin_hub uuid;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO j FROM trustwork.job WHERE id=p_job;
  IF NOT FOUND OR j.state<>'leased' OR j.kind<>'assistant.dispatch' OR j.payload->>'intentId' IS DISTINCT FROM p_intent::text
    OR j.fencing_token<>p_fence OR j.leased_until<=clock_timestamp() THEN RAISE EXCEPTION 'dispatch lease mismatch' USING ERRCODE='55P03'; END IF;
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent;
  IF NOT FOUND OR i.state<>'queued' THEN RETURN jsonb_build_object('status','skip','state',coalesce(i.state,'missing')); END IF;
  -- Jurisdiction precedes AGT epochs, person/session, mandate/run and intent locks.
  -- Never hold job/intent first while waiting for the owning epoch authority.
  PERFORM trustwork.agent_modules_effect_authority_refusal(p_intent);
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent FOR UPDATE;
  IF NOT FOUND OR i.state<>'queued' THEN RETURN jsonb_build_object('status','skip','state',coalesce(i.state,'missing')); END IF;
  SELECT hub_id INTO origin_hub FROM trustwork.agent_intent_provenance WHERE action_intent_id=p_intent;
  SELECT * INTO b FROM trustwork.jurisdiction_intent_binding WHERE intent_id=p_intent;
  IF FOUND AND i.context_kind='quote' AND b.action_digest=i.action_digest THEN
    SELECT * INTO q FROM trustwork.quote WHERE id=i.context_id::uuid;
    IF i.action='send_quote' THEN party_person:=q.seller_person_id;party_company:=q.seller_company_id;
    END IF;
    authorized:=party_person=i.principal_person_id OR EXISTS(SELECT 1 FROM trustwork.membership WHERE person_id=i.principal_person_id AND company_id=party_company AND status='active' AND 'company.deals.manage'=ANY(permissions));
    IF authorized THEN limits:=trustwork.jurisdiction_resolve_quote(i.context_id::uuid,i.action,i.principal_person_id); END IF;
  END IF;
  -- Every domain/epoch wait is over. A lease that expired while blocked grants no admission.
  SELECT * INTO j FROM trustwork.job WHERE id=p_job FOR UPDATE;
  IF NOT FOUND OR j.state<>'leased' OR j.kind<>'assistant.dispatch' OR j.payload->>'intentId' IS DISTINCT FROM p_intent::text
    OR j.fencing_token<>p_fence OR j.leased_until<=clock_timestamp() THEN RAISE EXCEPTION 'dispatch lease mismatch' USING ERRCODE='55P03'; END IF;
  IF origin_hub IS NULL OR (limits->>'hubId')::uuid IS DISTINCT FROM origin_hub
    OR limits->>'status' IS DISTINCT FROM 'resolved' OR limits->>'bindingDigest' IS DISTINCT FROM b.binding_digest
    OR jsonb_array_length(limits->'consentRequirements')>0 OR limits->>'approval'='human_only' THEN
    PERFORM trustwork.assistant_finish_intent(i.id,'revoked','jurisdiction policy changed or unavailable','jurisdiction:policy_changed');
    RETURN jsonb_build_object('status','refused','reason','jurisdiction_policy_changed');
  END IF;
  RETURN trustwork.assistant_begin_attempt(p_intent,p_job,origin_hub,p_fence);
END $$;
REVOKE ALL ON FUNCTION trustwork.jurisdiction_begin_attempt(uuid,uuid,bigint) FROM PUBLIC,trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.jurisdiction_begin_attempt(uuid,uuid,bigint) TO trustwork_worker;
