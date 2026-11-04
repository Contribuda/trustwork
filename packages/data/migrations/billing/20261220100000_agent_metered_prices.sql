-- AGT-004, ADR 010 decision 25: what a hub charges for agent usage, per module, capability, catalogue model or meter.
--
-- A sale price is an ordinary `price_version` of its own offer (kind `agent_metered`), so second-person activation, no
-- back-dating, no overlap and immutable acceptance are the existing BILL-001 rules, not a parallel set. The rows here
-- add what a price version cannot hold: the subject, the exact fractional unit price and the cost beside it.
--
-- Cost is information, never a price. A markup is materialized once, at drafting, into a fixed sale price stored with
-- the cost record it used; nothing recalculates a stored price, and no trigger or job reads a cost record to change one.
-- No amount is seeded here: every price is an operator's decision. No column can reach ranking, matching,
-- recommendations or reputation.
ALTER TABLE trustwork.offer DROP CONSTRAINT offer_kind_check;
ALTER TABLE trustwork.offer ADD CONSTRAINT offer_kind_check
  CHECK (kind IN ('plan', 'deliverable', 'credit_pack', 'marketplace_fee', 'verification_fee', 'agent_module', 'agent_metered', 'model', 'capability'));

-- What can be priced. One subject owns one offer, so "no overlapping active versions" is exactly the offer rule.
CREATE TABLE trustwork.metered_subject (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  offer_id uuid NOT NULL UNIQUE REFERENCES trustwork.offer (id),
  kind text NOT NULL CHECK (kind IN ('module', 'capability', 'model', 'meter')),
  subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 2 AND 100),
  direction text NULL CHECK (direction IS NULL OR direction IN ('input', 'output')),
  meter text NOT NULL REFERENCES trustwork.meter (code),
  unit text NOT NULL CHECK (unit IN ('thousand_tokens', 'action', 'deliverable', 'api_call')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metered_subject_direction CHECK ((kind = 'model') = (direction IS NOT NULL)),
  CONSTRAINT metered_subject_model_tokens CHECK (kind <> 'model' OR meter = 'model_tokens')
);
CREATE UNIQUE INDEX metered_subject_identity ON trustwork.metered_subject (hub_id, kind, subject_key, coalesce(direction, '-'), meter);
CREATE TRIGGER metered_subject_append_only BEFORE UPDATE OR DELETE ON trustwork.metered_subject FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Versioned cost of one unit for subjects that are not catalogue models. Catalogue models keep their cost in
-- KEYS-001's `model_pricing`. Append-only, like that table.
CREATE TABLE trustwork.metered_cost_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  subject_id uuid NOT NULL REFERENCES trustwork.metered_subject (id),
  version integer NOT NULL CHECK (version >= 1),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cost_micro bigint NOT NULL CHECK (cost_micro >= 0),
  basis text NOT NULL CHECK (basis IN ('model_list_price', 'measured_average', 'contract')),
  observed_at timestamptz NOT NULL,
  recorded_by uuid NOT NULL REFERENCES trustwork.person (id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (subject_id, version)
);
CREATE TRIGGER metered_cost_record_append_only BEFORE UPDATE OR DELETE ON trustwork.metered_cost_record FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- The unit terms of one price version. Immutable from its first moment: a correction is a new version.
-- Money is integers throughout: `*_micro` columns are millionths of a minor unit, because a unit price can be a fraction
-- of a cent. The API carries the same value as an exact decimal string.
-- `price_version.amount_minor` is the same price as a whole number of minor units for `per_units` units, which keeps the
-- integer money column honest for prices such as 0.2 minor units per thousand tokens.
CREATE TABLE trustwork.metered_price_term (
  price_version_id uuid PRIMARY KEY REFERENCES trustwork.price_version (id),
  subject_id uuid NOT NULL REFERENCES trustwork.metered_subject (id),
  sale_micro bigint NOT NULL CHECK (sale_micro >= 0),
  per_units bigint NOT NULL CHECK (per_units IN (1, 10, 100, 1000, 10000, 100000, 1000000)),
  basis text NOT NULL CHECK (basis IN ('flat', 'markup')),
  markup_percent integer NULL CHECK (markup_percent BETWEEN 0 AND 1000),
  cost_micro bigint NOT NULL CHECK (cost_micro >= 0),
  cost_basis text NOT NULL CHECK (cost_basis IN ('model_list_price', 'measured_average', 'contract')),
  model_pricing_id uuid NULL REFERENCES trustwork.model_pricing (id),
  cost_record_id uuid NULL REFERENCES trustwork.metered_cost_record (id),
  CONSTRAINT metered_price_term_markup CHECK ((basis = 'markup') = (markup_percent IS NOT NULL)),
  CONSTRAINT metered_price_term_one_cost CHECK ((model_pricing_id IS NULL) <> (cost_record_id IS NULL))
);
CREATE INDEX metered_price_term_subject_idx ON trustwork.metered_price_term (subject_id);
CREATE TRIGGER metered_price_term_append_only BEFORE UPDATE OR DELETE ON trustwork.metered_price_term FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

ALTER TABLE trustwork.metered_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.metered_subject FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.metered_cost_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.metered_cost_record FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.metered_price_term ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.metered_price_term FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.metered_subject AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.metered_cost_record AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.metered_price_term AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- The runtime role has no read policy: cost never leaves through a table. Readers below are explicit allowlists.

-- ISO 4217 minor-unit exponent; a model cost is recorded in major units per million tokens.
CREATE FUNCTION trustwork.billing_currency_exponent(p_currency text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE WHEN p_currency IN ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF') THEN 0
              WHEN p_currency IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 3 ELSE 2 END
$$;
-- Rounded up: a markup never falls below the cost it was set against.
CREATE FUNCTION trustwork.billing_ceil_percent(p_micro bigint, p_percent integer) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT (p_micro * p_percent + 99) / 100
$$;
-- Millionths of a minor unit to and from the exact decimal text of the API. Integer arithmetic only.
CREATE FUNCTION trustwork.billing_micro_text(p_micro bigint) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT (p_micro / 1000000)::text || CASE WHEN p_micro % 1000000 = 0 THEN '' ELSE '.' || rtrim(lpad((p_micro % 1000000)::text, 6, '0'), '0') END
$$;
CREATE FUNCTION trustwork.billing_micro_parse(p_text text) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE WHEN p_text ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$'
    THEN split_part(p_text, '.', 1)::bigint * 1000000 + rpad(split_part(p_text, '.', 2), 6, '0')::bigint END
$$;
-- The meter's priced unit (METER_TO_METERING_UNIT in agent-catalog.ts); meters without one are reported, never priced.
CREATE FUNCTION trustwork.billing_meter_unit(p_meter text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE p_meter WHEN 'model_tokens' THEN 'thousand_tokens' WHEN 'agent_actions' THEN 'action' WHEN 'checks' THEN 'action'
    WHEN 'deliverables' THEN 'deliverable' WHEN 'retrieval_queries' THEN 'api_call' WHEN 'external_calls' THEN 'api_call' END
$$;
CREATE FUNCTION trustwork.billing_iso(p_value timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT to_char(p_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- A hub prices only what the engine ships. A meter must be one the subject actually consumes. An introduction is
-- matching, and payment never changes matching, so a capability with the `introduce` action is never a priced subject.
CREATE FUNCTION trustwork.billing_metered_subject_valid(p_kind text, p_key text, p_meter text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE p_kind
    WHEN 'module' THEN EXISTS (SELECT 1 FROM trustwork.agent_engine_manifest m WHERE m.module_key = p_key AND m.document -> 'meters' ? p_meter)
    WHEN 'capability' THEN EXISTS (SELECT 1 FROM trustwork.agent_engine_manifest m, jsonb_array_elements(m.document -> 'capabilities') c
      WHERE m.module_key = split_part(p_key, '.', 1) AND c ->> 'id' = p_key AND c -> 'meters' ? p_meter AND c ->> 'mandateAction' IS DISTINCT FROM 'introduce')
    WHEN 'model' THEN p_meter = 'model_tokens' AND p_key ~ '^[a-z0-9][a-z0-9._-]{1,80}$'
    WHEN 'meter' THEN p_key = p_meter
    ELSE false END
$$;

-- Finds or creates the subject and its offer. Called only by the authorized commands below.
CREATE FUNCTION trustwork.billing_metered_subject(p_hub uuid, p_subject jsonb, p_person uuid) RETURNS trustwork.metered_subject
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_kind text := p_subject ->> 'kind';
  v_key text := p_subject ->> 'key';
  v_direction text := p_subject ->> 'direction';
  v_meter text := p_subject ->> 'meter';
  v_unit text := trustwork.billing_meter_unit(p_subject ->> 'meter');
  v_row trustwork.metered_subject%ROWTYPE;
  v_offer uuid;
  v_code text;
BEGIN
  IF v_unit IS NULL THEN
    RAISE EXCEPTION 'this meter has no priced unit' USING ERRCODE = '22023', HINT = 'billing.meter_unpriced';
  END IF;
  IF (v_kind = 'model') <> (v_direction IS NOT NULL) OR NOT coalesce(trustwork.billing_metered_subject_valid(v_kind, v_key, v_meter), false) THEN
    RAISE EXCEPTION 'unknown priced subject' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.metered'), hashtext(p_hub::text || ':' || v_kind || ':' || v_key || ':' || coalesce(v_direction, '-') || ':' || v_meter));
  SELECT * INTO v_row FROM trustwork.metered_subject WHERE hub_id = p_hub AND kind = v_kind AND subject_key = v_key AND direction IS NOT DISTINCT FROM v_direction AND meter = v_meter;
  IF FOUND THEN RETURN v_row; END IF;
  -- The digest keeps the code unique for keys that differ only in punctuation; people read the disclosed name.
  v_code := 'metered_' || left(md5(v_kind || ':' || v_key || ':' || coalesce(v_direction, '-') || ':' || v_meter), 24);
  INSERT INTO trustwork.offer (hub_id, code, name, kind, status, created_by)
  VALUES (p_hub, v_code, v_key, 'agent_metered', 'draft', p_person)
  RETURNING id INTO v_offer;
  INSERT INTO trustwork.metered_subject (hub_id, offer_id, kind, subject_key, direction, meter, unit)
  VALUES (p_hub, v_offer, v_kind, v_key, v_direction, v_meter, v_unit) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- The current cost of one subject in one currency. Model costs convert from major units per million tokens to minor
-- units per thousand; a direction without a recorded price has no cost.
CREATE FUNCTION trustwork.billing_metered_current_cost(p_subject trustwork.metered_subject, p_currency text,
  OUT cost_micro bigint, OUT cost_basis text, OUT model_pricing_id uuid, OUT cost_record_id uuid, OUT observed_at timestamptz)
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE v_model trustwork.model_pricing%ROWTYPE; v_cost trustwork.metered_cost_record%ROWTYPE;
BEGIN
  IF p_subject.kind = 'model' THEN
    SELECT * INTO v_model FROM trustwork.model_pricing WHERE hub_id = p_subject.hub_id AND lower(model_id) = p_subject.subject_key AND currency = p_currency
      ORDER BY recorded_at DESC, version DESC, id LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    -- Major units per million tokens to millionths of a minor unit per thousand: exact integer scale, rounded up once.
    cost_micro := ceil(CASE p_subject.direction WHEN 'input' THEN v_model.input_per_million_tokens ELSE v_model.output_per_million_tokens END
      * CASE trustwork.billing_currency_exponent(p_currency) WHEN 0 THEN 1000 WHEN 3 THEN 1000000 ELSE 100000 END)::bigint;
    IF cost_micro IS NULL THEN RETURN; END IF;
    cost_basis := CASE v_model.basis WHEN 'provider_list' THEN 'model_list_price' WHEN 'contract' THEN 'contract' ELSE 'measured_average' END;
    model_pricing_id := v_model.id;
    observed_at := v_model.observed_at;
    RETURN;
  END IF;
  SELECT * INTO v_cost FROM trustwork.metered_cost_record WHERE subject_id = p_subject.id AND currency = p_currency ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  cost_micro := v_cost.cost_micro;
  cost_basis := v_cost.basis;
  cost_record_id := v_cost.id;
  observed_at := v_cost.observed_at;
END $$;

CREATE FUNCTION trustwork.billing_metered_terms(p_price trustwork.price_version) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object(
    'subject', jsonb_strip_nulls(jsonb_build_object('kind', s.kind, 'key', s.subject_key, 'direction', s.direction, 'meter', s.meter)),
    'unit', s.unit, 'currency', p_price.currency, 'salePerUnitMinor', trustwork.billing_micro_text(t.sale_micro), 'amountMinor', p_price.amount_minor::text, 'perUnits', t.per_units,
    'basis', t.basis, 'markupPercent', t.markup_percent, 'costPerUnitMinor', trustwork.billing_micro_text(t.cost_micro), 'costBasis', t.cost_basis,
    'modelPricingId', t.model_pricing_id, 'costRecordId', t.cost_record_id, 'effectiveFrom', trustwork.billing_iso(p_price.effective_from),
    'effectiveTo', trustwork.billing_iso(p_price.effective_to), 'acceptanceTextVersion', p_price.acceptance_text_version)
  FROM trustwork.metered_price_term t JOIN trustwork.metered_subject s ON s.id = t.subject_id WHERE t.price_version_id = p_price.id
$$;
CREATE FUNCTION trustwork.billing_metered_digest(p_price trustwork.price_version) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'commerce.activate_price_version', 'id', p_price.id, 'offerId', p_price.offer_id,
    'version', p_price.version, 'terms', trustwork.billing_metered_terms(p_price)))
$$;
-- The staff view of one version: cost beside sale, and whether a newer cost record calls for a new draft. It only
-- reports; nothing here or anywhere else rewrites the stored sale price.
CREATE FUNCTION trustwork.billing_metered_staff_view(p_price trustwork.price_version) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_term trustwork.metered_price_term%ROWTYPE;
  v_subject trustwork.metered_subject%ROWTYPE;
  v_cost record;
  v_changed boolean;
BEGIN
  SELECT * INTO v_term FROM trustwork.metered_price_term WHERE price_version_id = p_price.id;
  SELECT * INTO v_subject FROM trustwork.metered_subject WHERE id = v_term.subject_id;
  SELECT * INTO v_cost FROM trustwork.billing_metered_current_cost(v_subject, p_price.currency);
  v_changed := v_cost.cost_micro IS NOT NULL AND (v_cost.model_pricing_id IS DISTINCT FROM v_term.model_pricing_id OR v_cost.cost_record_id IS DISTINCT FROM v_term.cost_record_id);
  RETURN jsonb_build_object('id', p_price.id, 'hubId', v_subject.hub_id, 'offerId', p_price.offer_id, 'version', p_price.version, 'status', p_price.status,
    'digest', trustwork.billing_metered_digest(p_price), 'terms', trustwork.billing_metered_terms(p_price), 'draftedBy', p_price.drafted_by, 'activatedBy', p_price.activated_by,
    'acceptances', (SELECT count(*) FROM trustwork.price_acceptance a WHERE a.price_version_id = p_price.id),
    'currentCost', CASE WHEN v_changed THEN jsonb_build_object('costPerUnitMinor', trustwork.billing_micro_text(v_cost.cost_micro), 'costBasis', v_cost.cost_basis,
      'modelPricingId', v_cost.model_pricing_id, 'costRecordId', v_cost.cost_record_id, 'observedAt', trustwork.billing_iso(v_cost.observed_at),
      'suggestedSalePerUnitMinor', CASE WHEN v_term.basis = 'markup' THEN trustwork.billing_micro_text(trustwork.billing_ceil_percent(v_cost.cost_micro, 100 + v_term.markup_percent)) END) END);
END $$;

CREATE FUNCTION trustwork.billing_metered_require_hub(p_hub uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM trustwork.hubs_require_hub(p_hub);
  IF (SELECT lifecycle FROM trustwork.hub WHERE id = p_hub) = 'closed' THEN
    RAISE EXCEPTION 'closed hub' USING ERRCODE = '23514', HINT = 'billing.unavailable';
  END IF;
END $$;

-- Records what one unit costs the hub. A cost is information: this command never touches a price version.
CREATE FUNCTION trustwork.billing_metered_record_cost(p_ctx jsonb, p_hub uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  a trustwork.admin_actor;
  v_subject trustwork.metered_subject%ROWTYPE;
  v_row trustwork.metered_cost_record%ROWTYPE;
BEGIN
  PERFORM trustwork.billing_metered_require_hub(p_hub);
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.draft'], NULL, p_hub);
  IF p_input #>> '{subject,kind}' = 'model' THEN
    RAISE EXCEPTION 'model cost lives in the provider cost records' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  v_subject := trustwork.billing_metered_subject(p_hub, p_input -> 'subject', a.person_id);
  INSERT INTO trustwork.metered_cost_record (subject_id, version, currency, cost_micro, basis, observed_at, recorded_by)
  VALUES (v_subject.id, coalesce((SELECT max(version) FROM trustwork.metered_cost_record WHERE subject_id = v_subject.id), 0) + 1, p_input ->> 'currency',
    trustwork.billing_micro_parse(p_input ->> 'costPerUnitMinor'), p_input ->> 'basis', (p_input ->> 'observedAt')::timestamptz, a.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(a, p_ctx, NULL, p_hub, 'billing.metered_cost_recorded', 'metered_cost_record', v_row.id, NULL, to_jsonb(v_row));
  RETURN jsonb_build_object('id', v_row.id, 'version', v_row.version, 'costPerUnitMinor', trustwork.billing_micro_text(v_row.cost_micro), 'currency', v_row.currency, 'basis', v_row.basis,
    'observedAt', trustwork.billing_iso(v_row.observed_at));
END $$;

-- Drafts one version. A markup is computed here, once, from the current cost record; the caller never supplies the
-- result of that calculation. A flat price names its amount and still stores the cost it was set against.
CREATE FUNCTION trustwork.billing_metered_draft(p_ctx jsonb, p_hub uuid, p_terms jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  a trustwork.admin_actor;
  v_subject trustwork.metered_subject%ROWTYPE;
  v_cost record;
  v_kind text := p_terms #>> '{basis,kind}';
  v_percent integer := (p_terms #>> '{basis,percent}')::integer;
  v_sale bigint;
  v_amount bigint;
  v_per bigint := 1000000;
  v_price trustwork.price_version%ROWTYPE;
BEGIN
  PERFORM trustwork.billing_metered_require_hub(p_hub);
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.draft'], NULL, p_hub);
  v_subject := trustwork.billing_metered_subject(p_hub, p_terms -> 'subject', a.person_id);
  SELECT * INTO v_cost FROM trustwork.billing_metered_current_cost(v_subject, p_terms ->> 'currency');
  IF v_cost.cost_micro IS NULL THEN
    RAISE EXCEPTION 'no cost record for this subject and currency' USING ERRCODE = '23514', HINT = 'billing.cost_record_missing';
  END IF;
  IF v_kind = 'markup' AND v_percent IS NOT NULL THEN
    v_sale := trustwork.billing_ceil_percent(v_cost.cost_micro, 100 + v_percent);
  ELSIF v_kind = 'flat' AND v_percent IS NULL THEN
    v_sale := trustwork.billing_micro_parse(p_terms #>> '{basis,salePerUnitMinor}');
  END IF;
  IF v_sale IS NULL THEN
    RAISE EXCEPTION 'invalid price basis' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  -- The smallest whole-number form of the price: 0.3 minor units per unit is 3 for 10 units.
  v_amount := v_sale;
  WHILE v_per > 1 AND v_amount % 10 = 0 LOOP
    v_amount := v_amount / 10;
    v_per := v_per / 10;
  END LOOP;
  INSERT INTO trustwork.price_version (offer_id, version, amount_minor, currency, effective_from, effective_to, acceptance_text_version, drafted_by)
  VALUES (v_subject.offer_id, coalesce((SELECT max(version) FROM trustwork.price_version WHERE offer_id = v_subject.offer_id), 0) + 1,
    v_amount, p_terms ->> 'currency', (p_terms ->> 'effectiveFrom')::timestamptz, (p_terms ->> 'effectiveTo')::timestamptz,
    p_terms ->> 'acceptanceTextVersion', a.person_id)
  RETURNING * INTO v_price;
  INSERT INTO trustwork.metered_price_term (price_version_id, subject_id, sale_micro, per_units, basis, markup_percent, cost_micro, cost_basis, model_pricing_id, cost_record_id)
  VALUES (v_price.id, v_subject.id, v_sale, v_per, v_kind, v_percent, v_cost.cost_micro, v_cost.cost_basis, v_cost.model_pricing_id, v_cost.cost_record_id);
  PERFORM trustwork.admin_record(a, p_ctx, NULL, p_hub, 'billing.metered_price_drafted', 'price_version', v_price.id, NULL, to_jsonb(v_price));
  RETURN trustwork.billing_metered_staff_view(v_price);
END $$;

-- Activation consumes one second-person approval bound to the exact digest of the stored terms. The version guard of
-- BILL-001 then refuses the drafter, a date that is not after activation and any overlap. An earlier open-ended
-- version is end-dated at the new start, so a payer's accepted version stays whole and the published interval is exact.
CREATE FUNCTION trustwork.billing_metered_activate(p_ctx jsonb, p_hub uuid, p_id uuid, p_digest text, p_approval uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  a trustwork.admin_actor;
  v_price trustwork.price_version%ROWTYPE;
  v_before jsonb;
BEGIN
  PERFORM trustwork.billing_metered_require_hub(p_hub);
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.activate'], NULL, p_hub);
  SELECT p.* INTO v_price FROM trustwork.price_version p JOIN trustwork.metered_price_term t ON t.price_version_id = p.id
    JOIN trustwork.metered_subject s ON s.id = t.subject_id WHERE p.id = p_id AND s.hub_id = p_hub;
  IF NOT FOUND THEN RAISE EXCEPTION 'price unavailable' USING ERRCODE = 'P0002', HINT = 'admin.not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.version'), hashtext('price:' || v_price.offer_id::text));
  SELECT * INTO v_price FROM trustwork.price_version WHERE id = p_id FOR UPDATE;
  IF a.person_id = v_price.drafted_by THEN
    RAISE EXCEPTION 'the drafter cannot activate' USING ERRCODE = '42501', HINT = 'admin.self_approval';
  END IF;
  IF p_digest IS DISTINCT FROM trustwork.billing_metered_digest(v_price) THEN
    RAISE EXCEPTION 'the digest does not match the stored terms' USING ERRCODE = '42501', HINT = 'admin.approval_mismatch';
  END IF;
  IF v_price.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft is activated' USING ERRCODE = '23514', HINT = 'billing.invalid_transition';
  END IF;
  PERFORM trustwork.admin_consume_approval(p_approval, 'commerce.activate_price_version', 'hub', NULL, p_hub, p_digest, v_price.id);
  v_before := to_jsonb(v_price);
  UPDATE trustwork.price_version SET effective_to = v_price.effective_from
  WHERE offer_id = v_price.offer_id AND status = 'active' AND id <> v_price.id AND effective_from < v_price.effective_from AND effective_to IS NULL;
  UPDATE trustwork.price_version SET status = 'active', activated_by = a.person_id WHERE id = v_price.id RETURNING * INTO v_price;
  UPDATE trustwork.offer SET status = 'active' WHERE id = v_price.offer_id AND status = 'draft';
  PERFORM trustwork.admin_record(a, p_ctx, NULL, p_hub, 'billing.metered_price_activated', 'price_version', v_price.id, v_before, to_jsonb(v_price), NULL, p_approval);
  RETURN trustwork.billing_metered_staff_view(v_price);
END $$;

CREATE FUNCTION trustwork.billing_metered_cancel(p_ctx jsonb, p_hub uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  a trustwork.admin_actor;
  v_price trustwork.price_version%ROWTYPE;
  v_before jsonb;
BEGIN
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.draft'], NULL, p_hub);
  SELECT p.* INTO v_price FROM trustwork.price_version p JOIN trustwork.metered_price_term t ON t.price_version_id = p.id
    JOIN trustwork.metered_subject s ON s.id = t.subject_id WHERE p.id = p_id AND s.hub_id = p_hub FOR UPDATE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'price unavailable' USING ERRCODE = 'P0002', HINT = 'admin.not_found'; END IF;
  IF v_price.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft is cancelled' USING ERRCODE = '23514', HINT = 'billing.invalid_transition';
  END IF;
  v_before := to_jsonb(v_price);
  UPDATE trustwork.price_version SET status = 'cancelled' WHERE id = p_id RETURNING * INTO v_price;
  PERFORM trustwork.admin_record(a, p_ctx, NULL, p_hub, 'billing.metered_price_cancelled', 'price_version', v_price.id, v_before, to_jsonb(v_price));
  RETURN trustwork.billing_metered_staff_view(v_price);
END $$;

CREATE FUNCTION trustwork.billing_metered_staff_list(p_ctx jsonb, p_hub uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; v_rows jsonb;
BEGIN
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.draft', 'admin.commerce.price.activate', 'admin.commerce.usage.read'], NULL, p_hub);
  SELECT coalesce(jsonb_agg(trustwork.billing_metered_staff_view(p) ORDER BY s.kind, s.subject_key, s.direction, s.meter, p.version), '[]'::jsonb) INTO v_rows
  FROM trustwork.price_version p JOIN trustwork.metered_price_term t ON t.price_version_id = p.id JOIN trustwork.metered_subject s ON s.id = t.subject_id
  WHERE s.hub_id = p_hub;
  RETURN v_rows;
END $$;

-- The public allowlist: subject, unit, sale price, interval and acceptance text. No cost, basis, drafter or approval.
CREATE FUNCTION trustwork.billing_metered_public(p_hub uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'version', p.version, 'offerId', o.id, 'code', o.code, 'name', o.name, 'kind', s.kind, 'key', s.subject_key,
      'direction', s.direction, 'meter', s.meter, 'unit', s.unit, 'currency', p.currency, 'amountMinor', p.amount_minor::text, 'perUnits', t.per_units,
      'salePerUnitMinor', trustwork.billing_micro_text(t.sale_micro), 'effectiveFrom', trustwork.billing_iso(p.effective_from), 'effectiveTo', trustwork.billing_iso(p.effective_to),
      'acceptanceTextVersion', p.acceptance_text_version) ORDER BY s.kind, s.subject_key, s.direction, s.meter, p.effective_from), '[]'::jsonb)
  FROM trustwork.price_version p JOIN trustwork.metered_price_term t ON t.price_version_id = p.id JOIN trustwork.metered_subject s ON s.id = t.subject_id
  JOIN trustwork.offer o ON o.id = p.offer_id JOIN trustwork.hub h ON h.id = s.hub_id
  WHERE s.hub_id = p_hub AND p.status = 'active' AND o.status = 'active' AND h.lifecycle <> 'closed' AND (p.effective_to IS NULL OR p.effective_to > p_at)
$$;

-- One thing has one live price. BILL-003's sale versions and these metered prices can both name a model or a capability;
-- until the two designs merge, activating either is refused while the other prices the same subject in an overlapping
-- interval. A trigger on the transition covers every path, owner-run included, and a clean handover at an end date stays
-- allowed. Locks: BILL-003 activation holds `billing.sale_subject` on hub, meter and subject, so the metered side takes that
-- same lock first. Both sides then take one lock on the case-folded subject without the meter, because the rule is about
-- the model or capability, and BILL-003 keeps the case of a model id that a metered key folds. Always in that order.
CREATE FUNCTION trustwork.billing_one_live_price() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE o trustwork.offer%ROWTYPE; v_kind text; v_subject text; v_meter text;
BEGIN
  IF NOT (OLD.status = 'draft' AND NEW.status = 'active') THEN RETURN NEW; END IF;
  SELECT * INTO o FROM trustwork.offer WHERE id = NEW.offer_id;
  IF o.kind = 'agent_metered' THEN
    SELECT s.kind, s.subject_key, s.meter INTO v_kind, v_subject, v_meter
    FROM trustwork.metered_price_term t JOIN trustwork.metered_subject s ON s.id = t.subject_id WHERE t.price_version_id = NEW.id;
    IF v_kind IS NULL OR v_kind NOT IN ('model', 'capability') THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.sale_subject'), hashtext(o.hub_id::text || ':' || v_meter || ':' || v_subject));
  ELSIF o.kind IN ('model', 'capability') THEN
    SELECT t.sale_kind, coalesce(t.model_id, t.capability_id) INTO v_kind, v_subject FROM trustwork.price_sale_terms t WHERE t.price_version_id = NEW.id;
    IF v_kind IS NULL THEN RETURN NEW; END IF;
  ELSE
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.sale_subject'), hashtext(o.hub_id::text || ':' || v_kind || ':' || lower(v_subject)));
  IF o.kind = 'agent_metered' THEN
    IF EXISTS (SELECT 1 FROM trustwork.price_sale_terms t JOIN trustwork.price_version v ON v.id = t.price_version_id JOIN trustwork.offer f ON f.id = v.offer_id
        LEFT JOIN trustwork.price_sale_supersession y ON y.price_version_id = v.id
      WHERE f.hub_id = o.hub_id AND f.status <> 'retired' AND t.sale_kind = v_kind AND lower(coalesce(t.model_id, t.capability_id)) = lower(v_subject)
        AND (v.status = 'active' OR (v.status = 'superseded' AND y.price_version_id IS NOT NULL))
        AND tstzrange(v.effective_from, coalesce(y.ends_at, v.effective_to), '[)') && tstzrange(NEW.effective_from, NEW.effective_to, '[)')) THEN
      RAISE EXCEPTION 'a sale version already prices this subject in that interval' USING ERRCODE = '23P01', HINT = 'billing.subject_priced_elsewhere';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM trustwork.metered_price_term t JOIN trustwork.metered_subject s ON s.id = t.subject_id JOIN trustwork.price_version v ON v.id = t.price_version_id
      WHERE s.hub_id = o.hub_id AND s.kind = v_kind AND lower(s.subject_key) = lower(v_subject) AND v.status = 'active'
        AND tstzrange(v.effective_from, v.effective_to, '[)') && tstzrange(NEW.effective_from, NEW.effective_to, '[)')) THEN
    RAISE EXCEPTION 'a metered price already prices this subject in that interval' USING ERRCODE = '23P01', HINT = 'billing.subject_priced_elsewhere';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_version_single_source BEFORE UPDATE ON trustwork.price_version FOR EACH ROW EXECUTE FUNCTION trustwork.billing_one_live_price();

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_metered_record_cost(jsonb, uuid, jsonb), trustwork.billing_metered_draft(jsonb, uuid, jsonb),
  trustwork.billing_metered_activate(jsonb, uuid, uuid, text, uuid), trustwork.billing_metered_cancel(jsonb, uuid, uuid),
  trustwork.billing_metered_staff_list(jsonb, uuid), trustwork.billing_metered_public(uuid, timestamptz) TO trustwork_app;
