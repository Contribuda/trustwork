-- HUB-005 / AGT-003: the dispatch handler now enters here, so this function must serve every intent.
--
-- It was written for bound quote intents and refuses anything else. A binding can exist only in a quote context, so an
-- intent in a quote or agreement context without one is refused here. Any other context keeps going to the owning
-- command exactly as it did, whatever its action: `quoting.send_quote` in an rfq context or `deal_desk.place_order` in
-- an order or project context gets no jurisdiction policy check, because no resolver exists for those contexts yet.
-- This function reads no sanctions state. Holds of the principal, the company and a deal's parties are the owning
-- recheck's (20261216100300), on both routes. Otherwise identical to 20261122100000.

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_begin_attempt(p_intent uuid,p_job uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE i trustwork.action_intent%ROWTYPE; b trustwork.jurisdiction_intent_binding%ROWTYPE; limits jsonb;
  q trustwork.quote%ROWTYPE; party_person uuid; party_company uuid; authorized boolean; j trustwork.job%ROWTYPE; origin_hub uuid;
  attempt jsonb; after_limits jsonb; v_context text;
BEGIN
  -- Only these contexts can be bound; the path below refuses them unbound. Everything else has no policy to apply here.
  -- The context of an intent never changes after it is recorded.
  SELECT context_kind INTO v_context FROM trustwork.action_intent WHERE id=p_intent;
  IF v_context NOT IN ('quote','agreement') THEN RETURN trustwork.assistant_begin_attempt(p_intent,p_job,NULL,p_fence); END IF;
  -- The fenced AGT-003 order (jurisdiction_dispatch_fence) plus current consent: jurisdiction lock, then the owning
  -- AGT epoch authority, and only then job and intent; the attempt runs under the intent's immutable origin hub.
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO j FROM trustwork.job WHERE id=p_job;
  IF NOT FOUND OR j.state<>'leased' OR j.kind<>'assistant.dispatch' OR j.payload->>'intentId' IS DISTINCT FROM p_intent::text
    OR j.fencing_token<>p_fence OR j.leased_until<=clock_timestamp() THEN RAISE EXCEPTION 'dispatch lease mismatch' USING ERRCODE='55P03'; END IF;
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent;
  IF NOT FOUND OR i.state<>'queued' THEN RETURN jsonb_build_object('status','skip','state',coalesce(i.state,'missing')); END IF;
  PERFORM trustwork.agent_modules_effect_authority_refusal(p_intent);
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent FOR UPDATE;
  IF NOT FOUND OR i.state<>'queued' THEN RETURN jsonb_build_object('status','skip','state',coalesce(i.state,'missing')); END IF;
  SELECT hub_id INTO origin_hub FROM trustwork.agent_intent_provenance WHERE action_intent_id=p_intent;
  SELECT * INTO b FROM trustwork.jurisdiction_intent_binding WHERE intent_id=p_intent;
  IF FOUND AND i.context_kind='quote' AND b.action_digest=i.action_digest THEN
    -- Consent belongs to the principal: hold the person and the seller membership while it is evaluated.
    PERFORM 1 FROM trustwork.person WHERE id=i.principal_person_id FOR SHARE;
    SELECT * INTO q FROM trustwork.quote WHERE id=i.context_id::uuid FOR SHARE;
    PERFORM 1 FROM trustwork.membership WHERE person_id=i.principal_person_id AND company_id=q.seller_company_id FOR SHARE;
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
    OR (jsonb_array_length(limits->'consentRequirements')>0 AND NOT trustwork.jurisdiction_consent_current(i.context_id::uuid,i.principal_person_id))
    OR limits->>'approval'='human_only' THEN
    PERFORM trustwork.assistant_finish_intent(i.id,'revoked','jurisdiction policy changed or unavailable','jurisdiction:policy_changed');
    RETURN jsonb_build_object('status','refused','reason','jurisdiction_policy_changed');
  END IF;
  attempt:=trustwork.assistant_begin_attempt(p_intent,p_job,origin_hub,p_fence);
  -- The assistant may have waited on domain/mandate locks. Recheck after it returns, before committing an attempt.
  IF attempt->>'status'='dispatch' THEN
    after_limits:=trustwork.jurisdiction_resolve_quote(i.context_id::uuid,i.action,i.principal_person_id);
    IF after_limits->>'status' IS DISTINCT FROM 'resolved' OR after_limits->>'bindingDigest' IS DISTINCT FROM b.binding_digest
      OR (after_limits->>'hubId')::uuid IS DISTINCT FROM origin_hub
      OR (jsonb_array_length(after_limits->'consentRequirements')>0 AND NOT trustwork.jurisdiction_consent_current(i.context_id::uuid,i.principal_person_id)) THEN
      RAISE EXCEPTION 'jurisdiction changed after domain wait' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND state='leased' AND fencing_token=p_fence AND leased_until>clock_timestamp()) THEN
      RAISE EXCEPTION 'dispatch lease expired after domain wait' USING ERRCODE='55P03';
    END IF;
  END IF;
  RETURN attempt;
END $$;
