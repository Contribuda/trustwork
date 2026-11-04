-- AGT-003 / SANC-004: nobody under a jurisdiction hold or a confirmed match has an agent act for them or against them.
--
-- A hold refuses the person at every API door and at sign-in, but it neither bumps the authorization epoch nor revokes
-- the session, and the dispatch recheck looked at neither. An intent queued before the hold therefore went on to an
-- attempt and to the provider. This recheck runs before the attempt exists and again around the callback
-- (agent_modules_enter_effect), on every dispatch route, so a hold committed after the attempt stops the callback.
-- Its subjects are the principal, the company they act for, and for a deal action the parties of its context.
-- `screening_gate_check` serializes with a new hold. The test is the one the occurrence runtime uses (place_hold or
-- suspended). `money_held` also covers people merely not screened yet; the binding money check stays in the
-- commitment's own transaction (ScreeningGate). Only this check is added to 20261130110000.

-- The parties of a deal action, read from its context. Keep the actions in step with GATED_AGENT_ACTIONS plus
-- `negotiate`. Stepping back is never gated (SANC-004): withdrawing, declining and cancelling stay possible whatever
-- the other side's state. Contexts with no deal row, such as a profile, name nobody.
CREATE FUNCTION trustwork.agent_modules_deal_parties(p_intent trustwork.action_intent) RETURNS TABLE (kind text, id uuid)
LANGUAGE sql STABLE SET search_path=trustwork,pg_temp AS $$
  WITH c AS (
    SELECT p_intent.context_id::uuid AS ref WHERE p_intent.context_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND p_intent.action IN ('send_quote','place_order','accept_order','negotiate','release_payment')
      AND p_intent.capability_id NOT IN ('quoting.withdraw_quote','task_marketplace.withdraw_offer','sourcing_desk.withdraw_amendment_request',
        'deal_desk.decline_order','deal_desk.withdraw_agreement','deal_desk.cancel_order')
  ), party(person,company) AS (
    SELECT x.owner_person_id,x.owner_company_id FROM trustwork.project x JOIN c ON x.id=c.ref WHERE p_intent.context_kind='project'
    UNION ALL SELECT x.owner_person_id,x.owner_company_id FROM trustwork.rfq x JOIN c ON x.id=c.ref WHERE p_intent.context_kind='rfq'
    UNION ALL SELECT x.seller_person_id,x.seller_company_id FROM trustwork.quote x JOIN c ON x.id=c.ref WHERE p_intent.context_kind='quote'
    UNION ALL SELECT r.owner_person_id,r.owner_company_id FROM trustwork.quote x JOIN c ON x.id=c.ref JOIN trustwork.rfq r ON r.id=x.rfq_id WHERE p_intent.context_kind='quote'
    UNION ALL SELECT x.buyer_person_id,x.buyer_company_id FROM trustwork.agreement x JOIN c ON x.id=c.ref WHERE p_intent.context_kind='agreement'
    UNION ALL SELECT x.seller_person_id,x.seller_company_id FROM trustwork.agreement x JOIN c ON x.id=c.ref WHERE p_intent.context_kind='agreement'
    UNION ALL SELECT a.buyer_person_id,a.buyer_company_id FROM trustwork.commercial_order x JOIN c ON x.id=c.ref JOIN trustwork.agreement a ON a.id=x.agreement_id WHERE p_intent.context_kind='order'
    UNION ALL SELECT a.seller_person_id,a.seller_company_id FROM trustwork.commercial_order x JOIN c ON x.id=c.ref JOIN trustwork.agreement a ON a.id=x.agreement_id WHERE p_intent.context_kind='order'
  )
  SELECT DISTINCT CASE WHEN person IS NULL THEN 'company' ELSE 'person' END,coalesce(person,company) FROM party WHERE coalesce(person,company) IS NOT NULL
$$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_deal_parties(trustwork.action_intent) FROM PUBLIC,trustwork_app,trustwork_worker;

CREATE OR REPLACE FUNCTION trustwork.agent_modules_effect_authority_refusal(p_intent uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE p trustwork.agent_intent_provenance%ROWTYPE; r trustwork.agent_run_provenance%ROWTYPE;
  i trustwork.action_intent%ROWTYPE; m trustwork.mandate%ROWTYPE; v_epoch integer; v_connection uuid; v_representative uuid; s trustwork.session%ROWTYPE; v_run_state text;
  v_kinds text[]; v_ids uuid[];
BEGIN
  SELECT * INTO p FROM trustwork.agent_intent_provenance WHERE action_intent_id=p_intent;
  IF p.person_authz_epoch IS NULL THEN RETURN 'legacy_authority_unknown'; END IF;
  SELECT * INTO m FROM trustwork.mandate WHERE id=p.mandate_id;
  v_representative := CASE WHEN m.grantee_kind='company_representative' THEN m.grantee_company_id END;
  SELECT connection_id INTO v_connection FROM trustwork.connection_call WHERE action_intent_id=p_intent ORDER BY at LIMIT 1;
  PERFORM trustwork.agent_modules_lock_epochs(p.hub_id,v_representative,p.principal_person_id,v_connection);
  -- MCP-003 has not supplied an immutable original access-token/proof binding for deferred effects.
  -- A connection_call family or caller snapshot cannot enlarge token authority. Immediate owning adapters
  -- retain their existing token/consent transaction; generic deferred connection effects stay unavailable.
  IF v_connection IS NOT NULL THEN RETURN 'connection_dispatch_authority_unavailable'; END IF;
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
  -- FOR UPDATE, not FOR SHARE: this transaction later updates the run (assistant_finish_intent); two dispatches of
  -- one run holding it shared would each wait to upgrade, a deadlock after the provider call.
  SELECT state INTO v_run_state FROM trustwork.run WHERE id=p.run_id FOR UPDATE;
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent FOR UPDATE;
  IF m.valid_until<=clock_timestamp() THEN RETURN 'mandate_expired'; END IF;
  IF m.status<>'active' OR m.revision<>p.mandate_revision OR m.digest<>p.mandate_digest THEN RETURN 'mandate_authority_changed'; END IF;
  IF v_run_state IS NULL OR v_run_state IN ('cancelled','failed') THEN RETURN 'run_cancelled'; END IF;
  -- Takes the gate's shared locks until the transaction ends, so a hold placed during the callback waits for it.
  SELECT array_agg(subject.kind),array_agg(subject.id) INTO v_kinds,v_ids FROM (
    SELECT 'person'::text AS kind,i.principal_person_id AS id
    UNION SELECT 'company',m.on_behalf_company_id WHERE m.on_behalf_company_id IS NOT NULL
    UNION SELECT d.kind,d.id FROM trustwork.agent_modules_deal_parties(i) d) subject;
  -- One answer for anyone and any cause: the principal learns only that the deal cannot go ahead now.
  IF EXISTS(SELECT 1 FROM trustwork.screening_gate_check(v_kinds,v_ids) g WHERE g.place_hold OR g.suspended) THEN RETURN 'party_held'; END IF;
  IF trustwork.agent_modules_dispatch_refusal_internal(p.hub_id,i.module_key,i.capability_id,i.action,i.principal_person_id,v_connection,v_representative) IS NOT NULL THEN RETURN 'kill_switch'; END IF;
  IF trustwork.agent_modules_policy_refusal(p.hub_id,i.capability_id,trustwork.agent_modules_mandate_kind(m.grantee_kind,m.on_behalf_company_id),
    EXISTS(SELECT 1 FROM trustwork.company WHERE id=m.on_behalf_company_id AND claim_status='verified'),'free') IS NOT NULL THEN RETURN 'capability_off'; END IF;
  IF NOT (trustwork.agent_modules_capability_binding(p.hub_id,i.capability_id) -> 'contextKinds') ? i.context_kind THEN RETURN 'capability_binding'; END IF;
  IF NOT trustwork.agent_modules_effect_binding(p.hub_id,i.capability_id,i.effect ->> 'provider',i.effect ->> 'operation') THEN RETURN 'capability_binding'; END IF;
  IF cardinality(i.ask_reasons)>0 THEN
    PERFORM 1 FROM trustwork.approval WHERE action_intent_id=i.id AND action_digest=i.action_digest AND mandate_revision=i.mandate_revision AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
    IF NOT FOUND THEN RETURN 'approval_missing'; END IF;
  END IF;
  IF i.reservation_id IS NOT NULL THEN
    IF NOT trustwork.billing_lock_effect_authority(i.reservation_id) THEN RETURN 'budget_authority_unavailable'; END IF;
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION trustwork.agent_modules_effect_authority_refusal(uuid) FROM PUBLIC,trustwork_app,trustwork_worker;
