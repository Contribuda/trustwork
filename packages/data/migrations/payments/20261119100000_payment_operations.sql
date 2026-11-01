-- PAY-001. No operational rail or source binding is seeded. Owning modules publish payment sources
-- through owner-only composition adapters; runtime clients cannot select identities, hubs or places.
CREATE TABLE trustwork.payment_source (
  agreement_id uuid PRIMARY KEY REFERENCES trustwork.agreement(id),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE trustwork.payment_rail (
  connection_id uuid PRIMARY KEY REFERENCES trustwork.provider_connection(id),
  currencies text[] NOT NULL CHECK (cardinality(currencies)>0),
  countries text[] NOT NULL CHECK (cardinality(countries)>0),
  rails text[] NOT NULL CHECK (cardinality(rails)>0),
  capabilities text[] NOT NULL CHECK (cardinality(capabilities)>0),
  custody text NOT NULL CHECK(custody='provider_connected_accounts'),
  evidence_mode text NOT NULL CHECK(evidence_mode IN ('synthetic','licensed_provider')),
  approval_ref text NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE trustwork.payment_intent (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  agreement_id uuid NOT NULL UNIQUE REFERENCES trustwork.agreement(id),
  binding jsonb NOT NULL,
  requested_by uuid NOT NULL REFERENCES trustwork.person(id),
  session_id uuid NOT NULL REFERENCES trustwork.session(id),
  reservation_id uuid UNIQUE REFERENCES trustwork.reservation(id),
  state text NOT NULL CHECK (state IN ('outside_platform','queued','requires_confirmation','pending_customer_action','outcome_unknown','succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE trustwork.payment_operation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  payment_id uuid NOT NULL REFERENCES trustwork.payment_intent(id),
  kind text NOT NULL CHECK (kind IN ('create','confirm','refund','payout','connected_account')),
  original_provider_ref text,
  session_id uuid NOT NULL REFERENCES trustwork.session(id),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','requires_confirmation','pending_customer_action','outcome_unknown','succeeded','failed')),
  job_id uuid UNIQUE REFERENCES trustwork.job(id),
  attempt_id text,
  fencing_token bigint,
  invoked_at timestamptz,
  provider_ref text,
  customer_action_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(payment_id, kind)
);
CREATE TABLE trustwork.payment_receipt (
  connection_id uuid NOT NULL REFERENCES trustwork.provider_connection(id),
  event_id text NOT NULL,
  operation_id uuid NOT NULL REFERENCES trustwork.payment_operation(id),
  evidence jsonb NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('applied','ignored','conflict')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(connection_id, event_id)
);
CREATE TRIGGER payment_receipt_immutable BEFORE UPDATE OR DELETE ON trustwork.payment_receipt FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.payments_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment history is immutable'; END IF;
  IF TG_TABLE_NAME = 'payment_source' THEN
    IF (NEW.agreement_id <> OLD.agreement_id OR NEW.binding <> OLD.binding OR NEW.created_at <> OLD.created_at OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'payment source is immutable';
      END IF;
  ELSIF TG_TABLE_NAME = 'payment_intent' THEN
    IF (NEW.id <> OLD.id OR NEW.agreement_id <> OLD.agreement_id OR NEW.binding <> OLD.binding OR NEW.requested_by <> OLD.requested_by OR NEW.session_id <> OLD.session_id OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'payment intent is immutable';
      END IF;
  ELSIF TG_TABLE_NAME = 'payment_operation' THEN
    IF (NEW.id <> OLD.id OR NEW.payment_id <> OLD.payment_id OR NEW.kind <> OLD.kind OR NEW.session_id <> OLD.session_id OR NEW.original_provider_ref IS DISTINCT FROM OLD.original_provider_ref OR NEW.created_at <> OLD.created_at OR OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref OR OLD.invoked_at IS NOT NULL AND NEW.invoked_at IS DISTINCT FROM OLD.invoked_at) THEN
    RAISE EXCEPTION 'payment operation is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_source_immutable BEFORE UPDATE OR DELETE ON trustwork.payment_source FOR EACH ROW EXECUTE FUNCTION trustwork.payments_immutable();
CREATE TRIGGER payment_intent_immutable BEFORE UPDATE OR DELETE ON trustwork.payment_intent FOR EACH ROW EXECUTE FUNCTION trustwork.payments_immutable();
CREATE TRIGGER payment_operation_immutable BEFORE UPDATE OR DELETE ON trustwork.payment_operation FOR EACH ROW EXECUTE FUNCTION trustwork.payments_immutable();

-- Fixed source authority, not an untrusted "approved" Boolean. Epoch/session/membership and source
-- locks are held until admission commits. Cross-node screening evidence has no implementation yet;
-- distinct home hubs refuse instead of pretending the local screen is the remote authority.
CREATE FUNCTION trustwork.payments_authority(p_agreement uuid, p_actor uuid, p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE a trustwork.agreement%ROWTYPE; s trustwork.payment_source%ROWTYPE; m trustwork.membership%ROWTYPE; b jsonb;
BEGIN
  PERFORM 1 FROM trustwork.person WHERE id = p_actor FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM trustwork.session WHERE id = p_session AND person_id = p_actor AND revoked_at IS NULL
    AND idle_expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp() FOR SHARE) THEN
    RAISE EXCEPTION 'payment authority unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  SELECT * INTO a FROM trustwork.agreement WHERE id = p_agreement FOR SHARE;
  IF NOT FOUND OR a.status <> 'accepted_by_both' THEN RAISE EXCEPTION 'payment agreement unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  IF a.buyer_person_id IS DISTINCT FROM p_actor THEN
    SELECT * INTO m FROM trustwork.membership WHERE person_id=p_actor AND company_id=a.buyer_company_id AND status='active' AND valid_from <= clock_timestamp() FOR SHARE;
    IF NOT FOUND OR NOT ('company.billing.manage' = ANY(m.permissions)) THEN RAISE EXCEPTION 'payment authority unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  END IF;
  SELECT * INTO s FROM trustwork.payment_source WHERE agreement_id=p_agreement FOR SHARE;
  IF NOT FOUND OR s.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'owning payment projection unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  b := s.binding;
  IF b->>'agreementId' IS DISTINCT FROM a.id::text OR b->>'agreementDigest' IS DISTINCT FROM a.accepted_terms_digest
    OR (b->>'offerVersion')::integer IS DISTINCT FROM a.offer_version OR (b->>'requestVersion')::integer IS DISTINCT FROM a.request_version
    OR b->'payer'->>'id' IS DISTINCT FROM coalesce(a.buyer_person_id,a.buyer_company_id)::text
    OR b->'payee'->>'id' IS DISTINCT FROM coalesce(a.seller_person_id,a.seller_company_id)::text
    OR b->'payer'->>'kind' IS DISTINCT FROM (CASE WHEN a.buyer_person_id IS NOT NULL THEN 'person' ELSE 'company' END)
    OR b->'payee'->>'kind' IS DISTINCT FROM (CASE WHEN a.seller_person_id IS NOT NULL THEN 'person' ELSE 'company' END) THEN
    RAISE EXCEPTION 'payment source mismatch' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  IF a.terms_kind <> 'rfq_quote' OR NOT EXISTS(SELECT 1 FROM trustwork.quote_version q
    WHERE q.id=a.quote_version_id AND q.quote_id=a.quote_id AND q.version=a.offer_version AND q.digest=a.offer_digest
    AND q.payload->'totals'->'gross'->>'minorUnits'=b->>'amountMinor'
    AND q.payload->'totals'->'gross'->>'currency'=b->>'currency') THEN
    RAISE EXCEPTION 'owning payment amount unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  IF trustwork.kernel_place_restricted(b->>'payerCountry') OR trustwork.kernel_place_restricted(b->>'payeeCountry') THEN
    RAISE EXCEPTION 'restricted payment place' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  IF b->>'payerHubId' IS DISTINCT FROM b->>'payeeHubId' THEN RAISE EXCEPTION 'remote screening authority unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  IF EXISTS (SELECT 1 FROM trustwork.screening_gate_check(ARRAY['person', b->'payer'->>'kind', b->'payee'->>'kind'],
    ARRAY[p_actor,(b->'payer'->>'id')::uuid,(b->'payee'->>'id')::uuid]) WHERE money_held OR suspended OR place_hold OR cardinality(reasons)>0) THEN
    RAISE EXCEPTION 'payment screening unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  RETURN b;
END $$;

-- No licensed rail is approved by this migration. Explicit synthetic connections are usable only
-- with an owning synthetic binding. Capability, hub, status, place and current kill switch are real KEYS rows.
CREATE FUNCTION trustwork.payments_route_available(b jsonb,p_kind text DEFAULT 'create') RETURNS boolean LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE c trustwork.provider_connection%ROWTYPE; cfg jsonb;
BEGIN
  LOCK TABLE trustwork.kill_switch IN SHARE MODE;
  SELECT * INTO c FROM trustwork.provider_connection WHERE id=(b->>'connectionId')::uuid FOR SHARE;
  IF NOT FOUND OR c.status <> 'enabled' OR c.hub_id::text IS DISTINCT FROM b->>'collectingHubId'
    OR NOT ('payments' = ANY(c.capabilities)) OR (p_kind='payout' AND NOT ('payouts'=ANY(c.capabilities))) OR c.mode <> 'fake' OR b->>'evidenceMode' <> 'synthetic' THEN RETURN false; END IF;
  IF trustwork.kernel_place_restricted(c.processing_country) OR c.storage_country IS NOT NULL AND trustwork.kernel_place_restricted(c.storage_country) THEN RETURN false; END IF;
  SELECT v.payload INTO cfg FROM trustwork.hub_config_current h JOIN trustwork.hub_config_version v ON v.id=h.version_id
    WHERE h.hub_id=c.hub_id AND h.domain='payments' FOR SHARE OF h;
  IF NOT FOUND OR cfg->>'fundsHeldBy' IS DISTINCT FROM 'licensed_payment_provider'
    OR cfg->'operatorAccountInFundsFlow' IS DISTINCT FROM 'false'::jsonb OR cfg->'demoNoMoneyMoves' IS DISTINCT FROM 'true'::jsonb
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'providers') x WHERE x->>'connectionId'=c.id::text AND x->'capabilities' ? (CASE WHEN p_kind='payout' THEN 'payouts' ELSE 'payments' END)) THEN RETURN false;
  IF b->>'rail'='provider_escrow' AND cfg->>'escrowAndRetainage'<>'provider_managed' THEN RETURN false; END IF; END IF;
  IF EXISTS(SELECT 1 FROM trustwork.kill_switch WHERE state='engaged' AND (scope_kind='node' OR connection_id=c.id)) THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM trustwork.payment_rail r WHERE r.connection_id=c.id AND r.revoked_at IS NULL
    AND r.evidence_mode=b->>'evidenceMode' AND b->>'currency'=ANY(r.currencies)
    AND b->>'payerCountry'=ANY(r.countries) AND b->>'payeeCountry'=ANY(r.countries)
    AND b->>'rail'=ANY(r.rails) AND 'create'=ANY(r.capabilities) FOR SHARE);
END $$;

ALTER TABLE trustwork.payment_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_source FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_intent FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_operation FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.payment_source FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.payment_intent FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.payment_operation FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.payment_receipt FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
REVOKE ALL ON FUNCTION trustwork.payments_immutable(), trustwork.payments_authority(uuid,uuid,uuid), trustwork.payments_route_available(jsonb,text) FROM PUBLIC;

ALTER TABLE trustwork.payment_rail ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_rail FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.payment_rail FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());

CREATE FUNCTION trustwork.payments_request(p_agreement uuid,p_budget uuid,p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE b jsonb; p trustwork.payment_intent%ROWTYPE; r trustwork.reservation%ROWTYPE; op uuid:=trustwork.new_uuid();
BEGIN
  b:=trustwork.payments_authority(p_agreement,trustwork.current_person_id(),p_session);
  PERFORM pg_advisory_xact_lock(hashtext('payments.agreement'),hashtext(p_agreement::text));
  SELECT * INTO p FROM trustwork.payment_intent WHERE agreement_id=p_agreement;
  IF FOUND THEN RETURN jsonb_build_object('id',p.id,'agreementId',p.agreement_id,'state',p.state,'amountMinor',p.binding->>'amountMinor','currency',p.binding->>'currency','funds',CASE p.binding->>'evidenceMode' WHEN 'synthetic' THEN 'synthetic_no_money_moves' ELSE 'provider_evidence_only' END); END IF;
  IF NOT trustwork.payments_route_available(b) THEN
    INSERT INTO trustwork.payment_intent(agreement_id,binding,requested_by,session_id,state)
      VALUES(p_agreement,b,trustwork.current_person_id(),p_session,'outside_platform') RETURNING * INTO p;
  ELSE
    IF b->>'amountMinor' !~ '^[1-9][0-9]{0,17}$' THEN RAISE EXCEPTION 'invalid payment amount'; END IF;
    SELECT r0.* INTO r FROM trustwork.commercial_order co JOIN trustwork.reservation r0 ON r0.id=co.reservation_id
      JOIN trustwork.budget bu ON bu.id=r0.budget_id
      WHERE co.agreement_id=p_agreement AND co.status IN ('accepted','changed','fulfilled')
      AND co.accepted_terms_digest=b->>'agreementDigest' AND co.amount_minor=(b->>'amountMinor')::bigint AND co.currency=b->>'currency'
      AND r0.budget_id=p_budget AND bu.kind='transaction' AND r0.amount_minor=co.amount_minor AND r0.currency=co.currency FOR SHARE OF co;
    IF NOT FOUND THEN RAISE EXCEPTION 'owning order reservation required' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
    PERFORM trustwork.billing_hold_for_effect(r.id);
    INSERT INTO trustwork.payment_intent(agreement_id,binding,requested_by,session_id,reservation_id,state)
      VALUES(p_agreement,b,trustwork.current_person_id(),p_session,r.id,'queued') RETURNING * INTO p;
    INSERT INTO trustwork.payment_operation(id,payment_id,kind,session_id) VALUES(op,p.id,'create',p_session);
    INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload) VALUES('payment',p.id,1,'payments.requested',jsonb_build_object('operationId',op));
  END IF;
  INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis)
    VALUES(trustwork.current_person_id(),'payment.request','payment',p.id,'{}');
  RETURN jsonb_build_object('id',p.id,'agreementId',p.agreement_id,'state',p.state,'amountMinor',b->>'amountMinor','currency',b->>'currency','funds',CASE b->>'evidenceMode' WHEN 'synthetic' THEN 'synthetic_no_money_moves' ELSE 'provider_evidence_only' END);
END $$;

CREATE FUNCTION trustwork.payments_read(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE p trustwork.payment_intent%ROWTYPE;
BEGIN
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=p_id;
  IF NOT FOUND OR p.requested_by IS DISTINCT FROM trustwork.current_person_id() THEN RAISE EXCEPTION 'payment unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  IF p.binding->'payer'->>'kind'='company' AND NOT EXISTS(SELECT 1 FROM trustwork.membership
    WHERE company_id=(p.binding->'payer'->>'id')::uuid AND person_id=trustwork.current_person_id() AND status='active'
    AND (permissions @> ARRAY['company.billing.view'] OR permissions @> ARRAY['company.billing.manage']) FOR SHARE) THEN
    RAISE EXCEPTION 'payment unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  RETURN jsonb_build_object('id',p.id,'agreementId',p.agreement_id,'state',p.state,'amountMinor',p.binding->>'amountMinor','currency',p.binding->>'currency','funds',CASE p.binding->>'evidenceMode' WHEN 'synthetic' THEN 'synthetic_no_money_moves' ELSE 'provider_evidence_only' END);
END $$;

-- A single full refund and a single payout, always bound to the exact successful charge and account.
-- Partial/milestone schedules are PAY-002; an arbitrary amount or destination is not accepted here.
CREATE FUNCTION trustwork.payments_action(p_id uuid,p_kind text,p_session uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE p trustwork.payment_intent%ROWTYPE; original trustwork.payment_operation%ROWTYPE; op uuid; b jsonb;
BEGIN
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=p_id;
  IF NOT FOUND OR p.requested_by IS DISTINCT FROM trustwork.current_person_id() THEN RAISE EXCEPTION 'payment unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  b:=trustwork.payments_authority(p.agreement_id,trustwork.current_person_id(),p_session);
  IF b<>p.binding OR NOT trustwork.payments_route_available(b,p_kind) THEN RAISE EXCEPTION 'payment route unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=p_id FOR UPDATE;
  IF p_kind NOT IN ('confirm','refund','payout','connected_account') THEN RAISE EXCEPTION 'invalid payment action'; END IF;
  SELECT id INTO op FROM trustwork.payment_operation WHERE payment_id=p_id AND kind=p_kind;
  IF FOUND THEN RETURN op; END IF;
  SELECT * INTO original FROM trustwork.payment_operation WHERE payment_id=p_id AND kind IN ('create','confirm')
    AND (p_kind='connected_account' AND provider_ref IS NOT NULL OR state=CASE WHEN p_kind='confirm' THEN 'requires_confirmation' ELSE 'succeeded' END) ORDER BY kind LIMIT 1;
  IF NOT FOUND OR original.provider_ref IS NULL THEN RAISE EXCEPTION 'original payment outcome required' USING ERRCODE='23514', HINT='validation.schema'; END IF;
  IF p_kind IN ('refund','payout') AND EXISTS(SELECT 1 FROM trustwork.payment_operation WHERE payment_id=p_id AND kind IN ('refund','payout')) THEN
    RAISE EXCEPTION 'refund or payout already reserved' USING ERRCODE='23514', HINT='validation.schema';
  END IF;
  IF p_kind='payout' AND NOT EXISTS(SELECT 1 FROM trustwork.provider_connection WHERE id=(b->>'connectionId')::uuid AND 'payouts'=ANY(capabilities)) THEN RAISE EXCEPTION 'payout capability unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.payment_rail WHERE connection_id=(b->>'connectionId')::uuid AND p_kind=ANY(capabilities)) THEN RAISE EXCEPTION 'capability unavailable'; END IF;
  INSERT INTO trustwork.payment_operation(payment_id,kind,original_provider_ref,session_id) VALUES(p_id,p_kind,original.provider_ref,p_session) RETURNING id INTO op;
  INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload) VALUES('payment',p.id,1,'payments.requested',jsonb_build_object('operationId',op));
  RETURN op;
END $$;

CREATE FUNCTION trustwork.payments_attach_job(p_operation uuid,p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND kind='payments.dispatch' AND payload=jsonb_build_object('operationId',p_operation)) THEN RAISE EXCEPTION 'payment job mismatch'; END IF;
  UPDATE trustwork.payment_operation SET job_id=p_job WHERE id=p_operation AND job_id IS NULL;
END $$;

CREATE FUNCTION trustwork.payments_instruction(p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; p trustwork.payment_intent%ROWTYPE;
BEGIN
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
  IF NOT FOUND OR o.invoked_at IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=o.payment_id;
  RETURN jsonb_build_object('operationId',o.id,'kind',o.kind,'binding',p.binding,'originalProviderRef',o.original_provider_ref);
END $$;

-- Fresh dispatch also needs the original order and current budget; late evidence deliberately does not.
CREATE FUNCTION trustwork.payments_funds_guard(p_id uuid,p_kind text) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE p trustwork.payment_intent%ROWTYPE; r trustwork.reservation%ROWTYPE; b trustwork.budget%ROWTYPE;
BEGIN
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=p_id;
  SELECT * INTO r FROM trustwork.reservation WHERE id=p.reservation_id;
  SELECT * INTO b FROM trustwork.budget WHERE id=r.budget_id FOR SHARE;
  SELECT * INTO r FROM trustwork.reservation WHERE id=p.reservation_id FOR SHARE;
  IF NOT FOUND OR NOT r.effect_pending OR b.kind<>'transaction' OR b.status<>'active'
    OR b.period_from>clock_timestamp() OR b.period_to<=clock_timestamp()
    OR r.amount_minor::text IS DISTINCT FROM p.binding->>'amountMinor' OR r.currency IS DISTINCT FROM p.binding->>'currency'
    OR (p_kind IN ('create','confirm') AND r.state<>'reserved')
    OR (p_kind IN ('refund','payout') AND r.state<>'settled') THEN
    RAISE EXCEPTION 'payment budget authority unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.commercial_order WHERE agreement_id=p.agreement_id AND reservation_id=r.id
    AND status IN ('accepted','changed','fulfilled') AND accepted_terms_digest=p.binding->>'agreementDigest' FOR SHARE) THEN
    RAISE EXCEPTION 'owning order authority unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_funds_guard(uuid,text) FROM PUBLIC;

-- Commit before invoking the adapter. Once invoked_at exists, dispatch can only query the same operation.
CREATE FUNCTION trustwork.payments_begin(p_operation uuid,p_job uuid,p_fence bigint,p_attempt text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; p trustwork.payment_intent%ROWTYPE; b jsonb;
BEGIN
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment unavailable'; END IF;
  IF o.invoked_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=o.payment_id;
  b:=trustwork.payments_authority(p.agreement_id,p.requested_by,o.session_id);
  IF b<>p.binding OR NOT trustwork.payments_route_available(b,o.kind) THEN RAISE EXCEPTION 'payment route unavailable'; END IF;
  PERFORM trustwork.payments_funds_guard(p.id,o.kind);
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND state='leased' AND leased_until>clock_timestamp()
    AND fencing_token=p_fence AND p_attempt=id::text||':'||attempt::text AND kind='payments.dispatch'
    AND payload=jsonb_build_object('operationId',p_operation) FOR UPDATE) THEN RAISE EXCEPTION 'stale payment attempt'; END IF;
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation FOR UPDATE;
  IF o.job_id IS DISTINCT FROM p_job OR o.invoked_at IS NOT NULL OR o.state<>'queued' THEN RETURN NULL; END IF;
  IF o.kind='payout' AND NOT EXISTS(SELECT 1 FROM trustwork.provider_connection WHERE id=(b->>'connectionId')::uuid AND 'payouts'=ANY(capabilities) FOR SHARE) THEN RAISE EXCEPTION 'payout capability unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.payment_rail WHERE connection_id=(b->>'connectionId')::uuid AND o.kind=ANY(capabilities) FOR SHARE) THEN RAISE EXCEPTION 'capability unavailable'; END IF;
  UPDATE trustwork.payment_operation SET state='outcome_unknown',invoked_at=clock_timestamp(),attempt_id=p_attempt,fencing_token=p_fence WHERE id=o.id;
  IF o.kind IN ('create','confirm') THEN UPDATE trustwork.payment_intent SET state='outcome_unknown' WHERE id=p.id; END IF;
  RETURN jsonb_build_object('operationId',o.id,'kind',o.kind,'binding',b,'originalProviderRef',o.original_provider_ref);
END $$;

-- Recheck after the durable unknown marker and hold the actual authority rows through the adapter call.
-- A crash between the two transactions can only reconcile, never redispatch. The worker supplies no authority Boolean.
CREATE FUNCTION trustwork.payments_dispatch_guard(p_operation uuid,p_job uuid,p_fence bigint,p_attempt text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; p trustwork.payment_intent%ROWTYPE; b jsonb;
BEGIN
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=o.payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment unavailable'; END IF;
  b:=trustwork.payments_authority(p.agreement_id,p.requested_by,o.session_id);
  IF b<>p.binding OR NOT trustwork.payments_route_available(b,o.kind) THEN RAISE EXCEPTION 'payment route unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND state='leased' AND leased_until>clock_timestamp()
    AND fencing_token=p_fence AND p_attempt=id::text||':'||attempt::text AND kind='payments.dispatch'
    AND payload=jsonb_build_object('operationId',p_operation) FOR SHARE) THEN RAISE EXCEPTION 'stale payment attempt'; END IF;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=p.id FOR SHARE;
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation FOR SHARE;
  PERFORM trustwork.payments_funds_guard(p.id,o.kind);
  IF o.job_id IS DISTINCT FROM p_job OR o.fencing_token IS DISTINCT FROM p_fence OR o.attempt_id IS DISTINCT FROM p_attempt
    OR o.invoked_at IS NULL OR o.state<>'outcome_unknown' THEN RAISE EXCEPTION 'stale payment dispatch'; END IF;
  IF o.kind='payout' AND NOT EXISTS(SELECT 1 FROM trustwork.provider_connection WHERE id=(b->>'connectionId')::uuid AND 'payouts'=ANY(capabilities) FOR SHARE) THEN RAISE EXCEPTION 'payout capability unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.payment_rail WHERE connection_id=(b->>'connectionId')::uuid AND o.kind=ANY(capabilities) FOR SHARE) THEN RAISE EXCEPTION 'capability unavailable'; END IF;
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_dispatch_guard(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_dispatch_guard(uuid,uuid,bigint,text) TO trustwork_worker;

-- Worker-only evidence command. Sender authentication is the adapter boundary, before this function.
-- Semantic idempotency is distinct from inbox delivery idempotency; every conflicting receipt is retained.
CREATE FUNCTION trustwork.payments_receipt(e jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; p trustwork.payment_intent%ROWTYPE; prior jsonb; disposition text:='applied'; st text:=e->>'state';
BEGIN
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=(e->>'operationId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment unavailable'; END IF;
  -- Intent first: create and confirm share a single settlement boundary.
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=o.payment_id FOR UPDATE;
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=o.id FOR UPDATE;
  IF o.invoked_at IS NULL OR st NOT IN ('succeeded','failed','pending_customer_action','requires_confirmation','outcome_unknown')
    OR e->>'kind' IS DISTINCT FROM o.kind OR e->>'connectionId' IS DISTINCT FROM p.binding->>'connectionId'
    OR e->>'connectedAccountRef' IS DISTINCT FROM p.binding->>'connectedAccountRef'
    OR e->>'amountMinor' IS DISTINCT FROM p.binding->>'amountMinor' OR e->>'currency' IS DISTINCT FROM p.binding->>'currency'
    OR e->>'evidenceMode' IS DISTINCT FROM p.binding->>'evidenceMode'
    OR e->>'originalProviderRef' IS DISTINCT FROM o.original_provider_ref
    OR coalesce(length(e->>'providerRef'),0) NOT BETWEEN 1 AND 180 OR coalesce(length(e->>'eventId'),0) NOT BETWEEN 1 AND 180 THEN
    RAISE EXCEPTION 'payment evidence binding mismatch';
  END IF;
  SELECT evidence INTO prior FROM trustwork.payment_receipt WHERE connection_id=(e->>'connectionId')::uuid AND event_id=e->>'eventId';
  IF FOUND THEN
    IF prior<>e THEN RAISE EXCEPTION 'payment delivery conflict'; END IF;
    RETURN 'duplicate';
  END IF;
  IF o.provider_ref IS NOT NULL AND o.provider_ref IS DISTINCT FROM e->>'providerRef' THEN disposition:='conflict';
  ELSIF o.state IN ('succeeded','failed') THEN
    disposition:=CASE WHEN st IN ('succeeded','failed') AND st<>o.state THEN 'conflict' ELSE 'ignored' END;
  ELSIF o.kind IN ('create','confirm') AND p.state IN ('succeeded','failed') THEN
    disposition:=CASE WHEN st IN ('succeeded','failed') AND st<>p.state THEN 'conflict' ELSE 'ignored' END;
  ELSIF o.state='pending_customer_action' AND st='requires_confirmation' THEN disposition:='ignored';
  END IF;
  INSERT INTO trustwork.inbox_receipt(provider,account,event_id) VALUES('payments',e->>'connectionId',e->>'eventId') ON CONFLICT DO NOTHING;
  INSERT INTO trustwork.payment_receipt(connection_id,event_id,operation_id,evidence,disposition) VALUES((e->>'connectionId')::uuid,e->>'eventId',o.id,e,disposition);
  IF disposition<>'applied' THEN RETURN disposition; END IF;
  UPDATE trustwork.payment_operation SET state=st,provider_ref=e->>'providerRef',customer_action_deadline=(e->>'customerActionDeadline')::timestamptz WHERE id=o.id;
  IF o.kind IN ('create','confirm') THEN
    UPDATE trustwork.payment_intent SET state=st WHERE id=p.id;
    IF st IN ('succeeded','failed') THEN
      PERFORM trustwork.billing_close_from_outcome(p.reservation_id,st='succeeded',(p.binding->>'amountMinor')::bigint,'payment:'||o.id::text);
    END IF;
  ELSIF o.kind='refund' AND st='succeeded' THEN
    PERFORM trustwork.billing_refund(p.reservation_id,(p.binding->>'amountMinor')::bigint,'payment:'||o.id::text);
  END IF;
  RETURN disposition;
END $$;

REVOKE ALL ON FUNCTION trustwork.payments_request(uuid,uuid,uuid),trustwork.payments_read(uuid),trustwork.payments_action(uuid,text,uuid),trustwork.payments_attach_job(uuid,uuid),trustwork.payments_instruction(uuid),trustwork.payments_begin(uuid,uuid,bigint,text),trustwork.payments_receipt(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_request(uuid,uuid,uuid),trustwork.payments_read(uuid),trustwork.payments_action(uuid,text,uuid) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.payments_attach_job(uuid,uuid),trustwork.payments_instruction(uuid),trustwork.payments_begin(uuid,uuid,bigint,text),trustwork.payments_receipt(jsonb) TO trustwork_worker;

-- Bounded recurring lookup, including phone/QR waits. A deadline never queues a new charge.
ALTER TABLE trustwork.payment_operation ADD COLUMN next_reconcile_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE FUNCTION trustwork.payments_reconcile_due() RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  RETURN QUERY WITH due AS (
    SELECT o.id FROM trustwork.payment_operation o WHERE o.invoked_at IS NOT NULL
      AND o.state NOT IN ('succeeded','failed') AND o.next_reconcile_at<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM trustwork.job j WHERE j.kind='payments.reconcile'
        AND j.payload=jsonb_build_object('operationId',o.id) AND j.state IN ('queued','leased'))
      ORDER BY o.next_reconcile_at,o.id LIMIT 100 FOR UPDATE OF o SKIP LOCKED
  ) UPDATE trustwork.payment_operation o SET next_reconcile_at=clock_timestamp()+interval '5 minutes'
    FROM due WHERE o.id=due.id RETURNING o.id;
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_reconcile_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_reconcile_due() TO trustwork_worker;
