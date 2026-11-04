-- AGT-004: agent plan versions and credit-pack versions under staff authority, and prepaid credit lots.
--
-- A plan version buys capacity for the payer's own work. It decides which modules are available and how much is
-- included per module and meter; it never reaches a protection limit, ranking, matching, recommendations or reputation.
-- Amounts, validity and refund policy are the operator's: nothing is seeded here.
--
-- Credits (ADR 012 decision 33): a pack shows its validity and refund policy before purchase and credits never expire
-- silently. A lot with a validity stays usable until it has been announced for the full reminder period.
CREATE TABLE trustwork.credit_pack_term (
  price_version_id uuid PRIMARY KEY REFERENCES trustwork.price_version (id),
  -- Value of the pack in minor units of the price currency.
  credits_minor bigint NOT NULL CHECK (credits_minor > 0),
  validity_days integer NULL CHECK (validity_days BETWEEN 30 AND 3650),
  reminder_days integer NULL CHECK (reminder_days BETWEEN 7 AND 90),
  refund_policy_version integer NOT NULL CHECK (refund_policy_version >= 1),
  CONSTRAINT credit_pack_term_reminder CHECK (validity_days IS NULL OR reminder_days IS NOT NULL)
);
CREATE TRIGGER credit_pack_term_append_only BEFORE UPDATE OR DELETE ON trustwork.credit_pack_term FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Funded only from payment evidence, by an owner-run call (BILL-002): no runtime role can create credit.
CREATE TABLE trustwork.agent_credit_lot (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  billing_account_id uuid NOT NULL REFERENCES trustwork.billing_account (id),
  price_version_id uuid NOT NULL REFERENCES trustwork.credit_pack_term (price_version_id),
  price_acceptance_id uuid NOT NULL UNIQUE REFERENCES trustwork.price_acceptance (id),
  funded_minor bigint NOT NULL CHECK (funded_minor > 0),
  remaining_minor bigint NOT NULL CHECK (remaining_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_until timestamptz NULL,
  reminder_days integer NULL CHECK (reminder_days BETWEEN 7 AND 90),
  notice_sent_at timestamptz NULL,
  evidence_ref text NOT NULL UNIQUE CHECK (length(evidence_ref) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_credit_lot_bounds CHECK (remaining_minor <= funded_minor),
  CONSTRAINT agent_credit_lot_reminder CHECK (valid_until IS NULL OR reminder_days IS NOT NULL)
);
CREATE INDEX agent_credit_lot_account_idx ON trustwork.agent_credit_lot (billing_account_id) WHERE remaining_minor > 0;
CREATE TABLE trustwork.agent_credit_use (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  lot_id uuid NOT NULL REFERENCES trustwork.agent_credit_lot (id),
  run_step_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('consume', 'restore')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lot_id, run_step_id, kind)
);
CREATE TRIGGER agent_credit_use_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_credit_use FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

ALTER TABLE trustwork.credit_pack_term ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.credit_pack_term FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_credit_lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_credit_lot FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_credit_use ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_credit_use FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.credit_pack_term AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_credit_lot AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_credit_use AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY agent_credit_lot_read ON trustwork.agent_credit_lot FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.billing_account a WHERE a.id = billing_account_id));
CREATE POLICY agent_credit_use_read ON trustwork.agent_credit_use FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.agent_credit_lot l WHERE l.id = lot_id));
GRANT SELECT ON trustwork.agent_credit_lot, trustwork.agent_credit_use TO trustwork_app;

-- Usable now: no validity, or not yet past both the validity and a full announced reminder period.
CREATE FUNCTION trustwork.billing_credit_usable(l trustwork.agent_credit_lot) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT l.valid_until IS NULL OR clock_timestamp() < l.valid_until OR l.notice_sent_at IS NULL
    OR clock_timestamp() < l.notice_sent_at + make_interval(days => l.reminder_days)
$$;
-- Consumes a settled charge from the account's lots, earliest validity first. What the lots do not cover stays a charge
-- on the budget for the provider path. Idempotent per step: a replay finds its uses.
CREATE FUNCTION trustwork.billing_credit_consume(p_account uuid, p_step uuid, p_amount bigint) RETURNS bigint
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE l trustwork.agent_credit_lot%ROWTYPE; v_left bigint := p_amount; v_take bigint;
BEGIN
  IF p_amount <= 0 OR EXISTS (SELECT 1 FROM trustwork.agent_credit_use u JOIN trustwork.agent_credit_lot x ON x.id = u.lot_id WHERE u.run_step_id = p_step AND x.billing_account_id = p_account) THEN
    RETURN 0;
  END IF;
  FOR l IN SELECT * FROM trustwork.agent_credit_lot WHERE billing_account_id = p_account AND remaining_minor > 0 ORDER BY valid_until NULLS LAST, created_at, id FOR UPDATE LOOP
    EXIT WHEN v_left = 0;
    CONTINUE WHEN NOT trustwork.billing_credit_usable(l);
    v_take := least(v_left, l.remaining_minor);
    UPDATE trustwork.agent_credit_lot SET remaining_minor = remaining_minor - v_take WHERE id = l.id;
    INSERT INTO trustwork.agent_credit_use (lot_id, run_step_id, kind, amount_minor) VALUES (l.id, p_step, 'consume', v_take);
    v_left := v_left - v_take;
  END LOOP;
  RETURN p_amount - v_left;
END $$;
-- Owner-run, from payment evidence of an accepted pack version. Validity starts at funding and is copied from the
-- version the payer accepted, so a later pack version never changes it.
CREATE FUNCTION trustwork.billing_credit_fund(p_acceptance uuid, p_evidence text) RETURNS trustwork.agent_credit_lot
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE a trustwork.price_acceptance%ROWTYPE; t trustwork.credit_pack_term%ROWTYPE; l trustwork.agent_credit_lot%ROWTYPE;
BEGIN
  SELECT * INTO a FROM trustwork.price_acceptance WHERE id = p_acceptance;
  SELECT * INTO t FROM trustwork.credit_pack_term WHERE price_version_id = a.price_version_id;
  IF a.id IS NULL OR t.price_version_id IS NULL OR coalesce(length(p_evidence), 0) = 0 THEN
    RAISE EXCEPTION 'funding needs an accepted credit pack and payment evidence' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  SELECT * INTO l FROM trustwork.agent_credit_lot WHERE evidence_ref = p_evidence;
  IF FOUND THEN RETURN l; END IF;
  INSERT INTO trustwork.agent_credit_lot (billing_account_id, price_version_id, price_acceptance_id, funded_minor, remaining_minor, currency, valid_until, reminder_days, evidence_ref)
  VALUES (a.billing_account_id, a.price_version_id, a.id, t.credits_minor, t.credits_minor, a.currency, CASE WHEN t.validity_days IS NOT NULL THEN clock_timestamp() + make_interval(days => t.validity_days) END,
    t.reminder_days, p_evidence) RETURNING * INTO l;
  RETURN l;
END $$;
-- Announces lots inside their reminder period, once each, as decisions-waiting facts through the outbox.
CREATE FUNCTION trustwork.billing_credit_notice_sweep(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE l trustwork.agent_credit_lot%ROWTYPE; v_count integer := 0;
BEGIN
  FOR l IN SELECT * FROM trustwork.agent_credit_lot WHERE valid_until IS NOT NULL AND notice_sent_at IS NULL AND remaining_minor > 0
      AND valid_until - make_interval(days => reminder_days) <= clock_timestamp() ORDER BY valid_until LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE trustwork.agent_credit_lot SET notice_sent_at = clock_timestamp() WHERE id = l.id;
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
    VALUES ('agent_credit_lot', l.id::text, 1, 'billing.credit_expiry_notice', jsonb_build_object('lotId', l.id, 'billingAccountId', l.billing_account_id));
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- Plans ---------------------------------------------------------------------------------------------------------------

CREATE FUNCTION trustwork.billing_plan_digest(p trustwork.subscription_plan_version, q trustwork.price_version) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'commerce.activate_price_version', 'id', p.id, 'offerId', p.offer_id, 'version', p.version, 'plan', p.payload,
    'price', jsonb_build_object('id', q.id, 'amountMinor', q.amount_minor::text, 'currency', q.currency, 'effectiveFrom', trustwork.billing_iso(q.effective_from),
      'effectiveTo', trustwork.billing_iso(q.effective_to), 'acceptanceTextVersion', q.acceptance_text_version)))
$$;
CREATE FUNCTION trustwork.billing_plan_view(p trustwork.subscription_plan_version, q trustwork.price_version, p_key text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'offerId', p.offer_id, 'planKey', p_key, 'version', p.version, 'status', p.status, 'digest', trustwork.billing_plan_digest(p, q), 'plan', p.payload - 'status',
    'priceVersionId', q.id, 'amountMinor', q.amount_minor::text, 'currency', q.currency, 'effectiveFrom', trustwork.billing_iso(q.effective_from), 'effectiveTo', trustwork.billing_iso(q.effective_to),
    'acceptanceTextVersion', q.acceptance_text_version, 'draftedBy', p.drafted_by, 'activatedBy', p.activated_by)
$$;

-- Drafts a plan version and its price version together: what a payer accepts is one set of terms.
CREATE FUNCTION trustwork.billing_plan_draft(p_ctx jsonb, p_hub uuid, p_terms jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  a trustwork.admin_actor;
  v_key text := p_terms ->> 'planKey';
  v_offer uuid;
  v_price trustwork.price_version%ROWTYPE;
  v_plan trustwork.subscription_plan_version%ROWTYPE;
  v_id uuid := trustwork.new_uuid();
  v_version integer;
BEGIN
  PERFORM trustwork.billing_metered_require_hub(p_hub);
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.draft'], NULL, p_hub);
  IF coalesce(v_key, '') !~ '^[a-z][a-z0-9_]{1,40}$' OR v_key = 'free' THEN
    RAISE EXCEPTION 'invalid plan key' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.metered'), hashtext(p_hub::text || ':plan:' || v_key));
  SELECT id INTO v_offer FROM trustwork.offer WHERE hub_id = p_hub AND code = v_key AND kind = 'plan';
  IF v_offer IS NULL THEN
    INSERT INTO trustwork.offer (hub_id, code, name, kind, status, created_by) VALUES (p_hub, v_key, p_terms ->> 'name', 'plan', 'draft', a.person_id) RETURNING id INTO v_offer;
  END IF;
  INSERT INTO trustwork.price_version (offer_id, version, amount_minor, currency, effective_from, effective_to, acceptance_text_version, drafted_by)
  VALUES (v_offer, coalesce((SELECT max(version) FROM trustwork.price_version WHERE offer_id = v_offer), 0) + 1, (p_terms #>> '{price,amountMinor}')::bigint, p_terms #>> '{price,currency}',
    (p_terms #>> '{price,effectiveFrom}')::timestamptz, (p_terms #>> '{price,effectiveTo}')::timestamptz, p_terms #>> '{price,acceptanceTextVersion}', a.person_id) RETURNING * INTO v_price;
  v_version := coalesce((SELECT max(version) FROM trustwork.subscription_plan_version WHERE offer_id = v_offer), 0) + 1;
  INSERT INTO trustwork.subscription_plan_version (id, offer_id, version, payer_kind, payload, price_version_id, drafted_by)
  VALUES (v_id, v_offer, v_version, p_terms #>> '{plan,payerKind}', (p_terms -> 'plan') || jsonb_build_object('id', v_id, 'offerId', v_offer, 'version', v_version, 'priceVersionId', v_price.id, 'status', 'draft'),
    v_price.id, a.person_id) RETURNING * INTO v_plan;
  PERFORM trustwork.admin_record(a, p_ctx, NULL, p_hub, 'billing.plan_drafted', 'subscription_plan_version', v_plan.id, NULL, to_jsonb(v_plan));
  RETURN trustwork.billing_plan_view(v_plan, v_price, v_key);
END $$;

-- One approval covers the plan and its price. The earlier version stays in force for the published interval and for
-- everyone who accepted it; only new acceptances see the new one.
CREATE FUNCTION trustwork.billing_plan_activate(p_ctx jsonb, p_hub uuid, p_id uuid, p_digest text, p_approval uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  a trustwork.admin_actor;
  v_plan trustwork.subscription_plan_version%ROWTYPE;
  v_price trustwork.price_version%ROWTYPE;
  v_key text;
  v_before jsonb;
BEGIN
  PERFORM trustwork.billing_metered_require_hub(p_hub);
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.plan.activate'], NULL, p_hub);
  SELECT p.* INTO v_plan FROM trustwork.subscription_plan_version p JOIN trustwork.offer o ON o.id = p.offer_id WHERE p.id = p_id AND o.hub_id = p_hub;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan unavailable' USING ERRCODE = 'P0002', HINT = 'admin.not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.version'), hashtext('price:' || v_plan.offer_id::text));
  SELECT * INTO v_plan FROM trustwork.subscription_plan_version WHERE id = p_id FOR UPDATE;
  SELECT * INTO v_price FROM trustwork.price_version WHERE id = v_plan.price_version_id FOR UPDATE;
  SELECT code INTO v_key FROM trustwork.offer WHERE id = v_plan.offer_id;
  IF a.person_id = v_plan.drafted_by THEN RAISE EXCEPTION 'the drafter cannot activate' USING ERRCODE = '42501', HINT = 'admin.self_approval'; END IF;
  IF p_digest IS DISTINCT FROM trustwork.billing_plan_digest(v_plan, v_price) THEN
    RAISE EXCEPTION 'the digest does not match the stored terms' USING ERRCODE = '42501', HINT = 'admin.approval_mismatch';
  END IF;
  IF v_plan.status <> 'draft' THEN RAISE EXCEPTION 'only a draft is activated' USING ERRCODE = '23514', HINT = 'billing.invalid_transition'; END IF;
  PERFORM trustwork.admin_consume_approval(p_approval, 'commerce.activate_price_version', 'hub', NULL, p_hub, p_digest, v_plan.id);
  v_before := to_jsonb(v_plan);
  UPDATE trustwork.price_version SET effective_to = v_price.effective_from
  WHERE offer_id = v_plan.offer_id AND status = 'active' AND id <> v_price.id AND effective_from < v_price.effective_from AND effective_to IS NULL;
  UPDATE trustwork.price_version SET status = 'active', activated_by = a.person_id WHERE id = v_price.id RETURNING * INTO v_price;
  UPDATE trustwork.subscription_plan_version SET status = 'superseded' WHERE offer_id = v_plan.offer_id AND status = 'active' AND id <> v_plan.id;
  UPDATE trustwork.subscription_plan_version SET status = 'active', activated_by = a.person_id WHERE id = v_plan.id RETURNING * INTO v_plan;
  UPDATE trustwork.offer SET status = 'active' WHERE id = v_plan.offer_id AND status = 'draft';
  PERFORM trustwork.admin_record(a, p_ctx, NULL, p_hub, 'billing.plan_activated', 'subscription_plan_version', v_plan.id, v_before, to_jsonb(v_plan), NULL, p_approval);
  RETURN trustwork.billing_plan_view(v_plan, v_price, v_key);
END $$;

-- Credit packs --------------------------------------------------------------------------------------------------------

CREATE FUNCTION trustwork.billing_pack_digest(q trustwork.price_version, t trustwork.credit_pack_term) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'commerce.activate_price_version', 'id', q.id, 'offerId', q.offer_id, 'version', q.version, 'amountMinor', q.amount_minor::text,
    'currency', q.currency, 'creditsMinor', t.credits_minor::text, 'validityDays', t.validity_days, 'reminderDays', t.reminder_days, 'refundPolicyVersion', t.refund_policy_version,
    'effectiveFrom', trustwork.billing_iso(q.effective_from), 'effectiveTo', trustwork.billing_iso(q.effective_to), 'acceptanceTextVersion', q.acceptance_text_version))
$$;
CREATE FUNCTION trustwork.billing_pack_view(q trustwork.price_version, t trustwork.credit_pack_term, p_key text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', q.id, 'offerId', q.offer_id, 'packKey', p_key, 'version', q.version, 'status', q.status, 'digest', trustwork.billing_pack_digest(q, t), 'amountMinor', q.amount_minor::text,
    'currency', q.currency, 'creditsMinor', t.credits_minor::text, 'validityDays', t.validity_days, 'reminderDays', t.reminder_days, 'refundPolicyVersion', t.refund_policy_version,
    'effectiveFrom', trustwork.billing_iso(q.effective_from), 'effectiveTo', trustwork.billing_iso(q.effective_to), 'acceptanceTextVersion', q.acceptance_text_version,
    'draftedBy', q.drafted_by, 'activatedBy', q.activated_by)
$$;
CREATE FUNCTION trustwork.billing_pack_draft(p_ctx jsonb, p_hub uuid, p_terms jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; v_key text := p_terms ->> 'packKey'; v_offer uuid; q trustwork.price_version%ROWTYPE; t trustwork.credit_pack_term%ROWTYPE;
BEGIN
  PERFORM trustwork.billing_metered_require_hub(p_hub);
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.draft'], NULL, p_hub);
  IF coalesce(v_key, '') !~ '^[a-z][a-z0-9_]{1,40}$' THEN RAISE EXCEPTION 'invalid pack key' USING ERRCODE = '22023', HINT = 'billing.invalid_terms'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.metered'), hashtext(p_hub::text || ':pack:' || v_key));
  SELECT id INTO v_offer FROM trustwork.offer WHERE hub_id = p_hub AND code = v_key AND kind = 'credit_pack';
  IF v_offer IS NULL THEN
    INSERT INTO trustwork.offer (hub_id, code, name, kind, status, created_by) VALUES (p_hub, v_key, p_terms ->> 'name', 'credit_pack', 'draft', a.person_id) RETURNING id INTO v_offer;
  END IF;
  INSERT INTO trustwork.price_version (offer_id, version, amount_minor, currency, effective_from, effective_to, acceptance_text_version, drafted_by)
  VALUES (v_offer, coalesce((SELECT max(version) FROM trustwork.price_version WHERE offer_id = v_offer), 0) + 1, (p_terms ->> 'amountMinor')::bigint, p_terms ->> 'currency',
    (p_terms ->> 'effectiveFrom')::timestamptz, (p_terms ->> 'effectiveTo')::timestamptz, p_terms ->> 'acceptanceTextVersion', a.person_id) RETURNING * INTO q;
  INSERT INTO trustwork.credit_pack_term (price_version_id, credits_minor, validity_days, reminder_days, refund_policy_version)
  VALUES (q.id, (p_terms ->> 'creditsMinor')::bigint, (p_terms ->> 'validityDays')::integer, (p_terms ->> 'reminderDays')::integer, (p_terms ->> 'refundPolicyVersion')::integer) RETURNING * INTO t;
  PERFORM trustwork.admin_record(a, p_ctx, NULL, p_hub, 'billing.credit_pack_drafted', 'price_version', q.id, NULL, to_jsonb(q));
  RETURN trustwork.billing_pack_view(q, t, v_key);
END $$;
CREATE FUNCTION trustwork.billing_pack_activate(p_ctx jsonb, p_hub uuid, p_id uuid, p_digest text, p_approval uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; q trustwork.price_version%ROWTYPE; t trustwork.credit_pack_term%ROWTYPE; v_key text; v_before jsonb;
BEGIN
  PERFORM trustwork.billing_metered_require_hub(p_hub);
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.activate'], NULL, p_hub);
  SELECT p.* INTO q FROM trustwork.price_version p JOIN trustwork.credit_pack_term x ON x.price_version_id = p.id JOIN trustwork.offer o ON o.id = p.offer_id WHERE p.id = p_id AND o.hub_id = p_hub;
  IF NOT FOUND THEN RAISE EXCEPTION 'pack unavailable' USING ERRCODE = 'P0002', HINT = 'admin.not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.version'), hashtext('price:' || q.offer_id::text));
  SELECT * INTO q FROM trustwork.price_version WHERE id = p_id FOR UPDATE;
  SELECT * INTO t FROM trustwork.credit_pack_term WHERE price_version_id = p_id;
  SELECT code INTO v_key FROM trustwork.offer WHERE id = q.offer_id;
  IF a.person_id = q.drafted_by THEN RAISE EXCEPTION 'the drafter cannot activate' USING ERRCODE = '42501', HINT = 'admin.self_approval'; END IF;
  IF p_digest IS DISTINCT FROM trustwork.billing_pack_digest(q, t) THEN RAISE EXCEPTION 'the digest does not match the stored terms' USING ERRCODE = '42501', HINT = 'admin.approval_mismatch'; END IF;
  IF q.status <> 'draft' THEN RAISE EXCEPTION 'only a draft is activated' USING ERRCODE = '23514', HINT = 'billing.invalid_transition'; END IF;
  PERFORM trustwork.admin_consume_approval(p_approval, 'commerce.activate_price_version', 'hub', NULL, p_hub, p_digest, q.id);
  v_before := to_jsonb(q);
  UPDATE trustwork.price_version SET effective_to = q.effective_from WHERE offer_id = q.offer_id AND status = 'active' AND id <> q.id AND effective_from < q.effective_from AND effective_to IS NULL;
  UPDATE trustwork.price_version SET status = 'active', activated_by = a.person_id WHERE id = q.id RETURNING * INTO q;
  UPDATE trustwork.offer SET status = 'active' WHERE id = q.offer_id AND status = 'draft';
  PERFORM trustwork.admin_record(a, p_ctx, NULL, p_hub, 'billing.credit_pack_activated', 'price_version', q.id, v_before, to_jsonb(q), NULL, p_approval);
  RETURN trustwork.billing_pack_view(q, t, v_key);
END $$;
-- Public allowlist of active and upcoming packs: price, value, validity and refund policy version.
CREATE FUNCTION trustwork.billing_pack_public(p_hub uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'version', q.version, 'offerId', o.id, 'code', o.code, 'name', o.name, 'currency', q.currency, 'amountMinor', q.amount_minor::text,
      'creditsMinor', t.credits_minor::text, 'validityDays', t.validity_days, 'reminderDays', t.reminder_days, 'refundPolicyVersion', t.refund_policy_version,
      'effectiveFrom', trustwork.billing_iso(q.effective_from), 'effectiveTo', trustwork.billing_iso(q.effective_to), 'acceptanceTextVersion', q.acceptance_text_version)
      ORDER BY o.code, q.effective_from), '[]'::jsonb)
  FROM trustwork.price_version q JOIN trustwork.credit_pack_term t ON t.price_version_id = q.id JOIN trustwork.offer o ON o.id = q.offer_id JOIN trustwork.hub h ON h.id = o.hub_id
  WHERE o.hub_id = p_hub AND q.status = 'active' AND o.status = 'active' AND h.lifecycle <> 'closed' AND (q.effective_to IS NULL OR q.effective_to > p_at)
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_plan_draft(jsonb, uuid, jsonb), trustwork.billing_plan_activate(jsonb, uuid, uuid, text, uuid), trustwork.billing_pack_draft(jsonb, uuid, jsonb),
  trustwork.billing_pack_activate(jsonb, uuid, uuid, text, uuid), trustwork.billing_pack_public(uuid, timestamptz) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.billing_credit_notice_sweep(integer) TO trustwork_worker;
