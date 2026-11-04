-- AGT-004: the metered step. Usage is appended idempotently per run step, attempt and meter; quota windows are checked
-- per principal, module and meter; usage beyond the included quota is reserved from the platform budget the mandate
-- names and settled on actuals. Without a budget a job stops at its quota: it never runs into debt.
--
-- Protection limits are not here and read nothing here: they belong to the hub agent policy and are identical for every
-- plan. No table or function in this file is read by ranking, matching, recommendations, reputation or alert dispatch.
ALTER TABLE trustwork.usage_record ADD COLUMN price_version_id uuid NULL REFERENCES trustwork.price_version (id);
ALTER TABLE trustwork.usage_record DROP CONSTRAINT usage_record_overage_priced;
ALTER TABLE trustwork.usage_record ADD CONSTRAINT usage_record_overage_priced
  CHECK (within_included_quota OR ((meter_rate_version_id IS NOT NULL OR price_version_id IS NOT NULL) AND reservation_id IS NOT NULL));

-- One row per principal, module, meter and calendar window (UTC). The row lock is what makes "the last included unit"
-- go to exactly one of two concurrent steps. `held_units` are admitted and not yet closed.
CREATE TABLE trustwork.agent_quota_window (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  principal_person_id uuid NULL REFERENCES trustwork.person (id),
  principal_company_id uuid NULL REFERENCES trustwork.company (id),
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  meter text NOT NULL REFERENCES trustwork.meter (code),
  window_kind text NOT NULL CHECK (window_kind IN ('day', 'week', 'month')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  limit_units bigint NOT NULL CHECK (limit_units >= 0),
  used_units bigint NOT NULL DEFAULT 0 CHECK (used_units >= 0),
  held_units bigint NOT NULL DEFAULT 0 CHECK (held_units >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_quota_window_principal_xor CHECK ((principal_person_id IS NULL) <> (principal_company_id IS NULL))
);
CREATE UNIQUE INDEX agent_quota_window_identity ON trustwork.agent_quota_window (hub_id, coalesce(principal_person_id, principal_company_id), module_key, meter, window_kind, window_start);

-- The durable admission of one step: what was held before the work ran, closed once by its outcome.
CREATE TABLE trustwork.metered_step (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  principal_person_id uuid NULL REFERENCES trustwork.person (id),
  principal_company_id uuid NULL REFERENCES trustwork.company (id),
  acting_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  -- Null on a hub with no currency: nothing can be billed there, and the step still runs under the free allowance.
  billing_account_id uuid NULL REFERENCES trustwork.billing_account (id),
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  capability_id text NULL CHECK (capability_id IS NULL OR (capability_id ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' AND length(capability_id) <= 100)),
  run_id uuid NOT NULL,
  run_step_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  connection_id uuid NULL,
  meter text NOT NULL REFERENCES trustwork.meter (code),
  provider_class text NULL CHECK (provider_class IS NULL OR provider_class IN ('local', 'in_country', 'hosted_external')),
  model_key text NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('model_call', 'action_intent', 'direct')),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  plan_version_id uuid NULL REFERENCES trustwork.subscription_plan_version (id),
  window_ids uuid[] NOT NULL DEFAULT '{}',
  estimated_units bigint NOT NULL CHECK (estimated_units >= 0),
  within_units bigint NOT NULL CHECK (within_units >= 0),
  beyond_units bigint NOT NULL CHECK (beyond_units >= 0),
  price_version_id uuid NULL REFERENCES trustwork.price_version (id),
  output_price_version_id uuid NULL REFERENCES trustwork.price_version (id),
  reservation_id uuid NULL REFERENCES trustwork.reservation (id),
  estimate_minor bigint NOT NULL DEFAULT 0 CHECK (estimate_minor >= 0),
  currency text NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  state text NOT NULL DEFAULT 'admitted' CHECK (state IN ('admitted', 'outcome_unknown', 'succeeded', 'failed')),
  actual_units bigint NULL CHECK (actual_units >= 0),
  overrun_units bigint NOT NULL DEFAULT 0 CHECK (overrun_units >= 0),
  charged_minor bigint NOT NULL DEFAULT 0 CHECK (charged_minor >= 0),
  -- Exact amounts in millionths of a minor unit. `charged_minor` is what this step settled: whole minor units are rounded
  -- once per account and billing month (`agent_charge_period`), never per step.
  charged_micro bigint NOT NULL DEFAULT 0 CHECK (charged_micro >= 0),
  cost_micro bigint NOT NULL DEFAULT 0 CHECK (cost_micro >= 0),
  -- The share of `charged_minor` prepaid credits funded, so invoicing bills only the rest.
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  usage_record_id uuid NULL REFERENCES trustwork.usage_record (id),
  evidence_ref text NULL CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz NULL,
  CONSTRAINT metered_step_principal_xor CHECK ((principal_person_id IS NULL) <> (principal_company_id IS NULL)),
  CONSTRAINT metered_step_split CHECK (within_units + beyond_units = estimated_units),
  CONSTRAINT metered_step_billable CHECK (billing_account_id IS NOT NULL OR (currency IS NULL AND reservation_id IS NULL AND price_version_id IS NULL)),
  CONSTRAINT metered_step_closed CHECK ((state IN ('succeeded', 'failed')) = (closed_at IS NOT NULL)),
  CONSTRAINT metered_step_idempotent UNIQUE (run_step_id, attempt_id, meter)
);
CREATE INDEX metered_step_open_idx ON trustwork.metered_step (created_at) WHERE state IN ('admitted', 'outcome_unknown');
CREATE INDEX metered_step_source_idx ON trustwork.metered_step (source_kind, source_ref);
CREATE INDEX metered_step_stats_idx ON trustwork.metered_step (hub_id, module_key, created_at);
-- One step and meter is charged at most once, whatever attempt ids a replay brings.
CREATE UNIQUE INDEX metered_step_one_success ON trustwork.metered_step (run_step_id, meter) WHERE state = 'succeeded';

-- Exact charges accumulate here and round up once per account and calendar month. Each step settles only the whole minor
-- units its charge newly completes, so ten steps at 0.3 settle 3 in total, and the budget never lags the exact sum by a
-- whole unit. An estimate still reserves a whole unit, because a reservation is money held.
CREATE TABLE trustwork.agent_charge_period (
  billing_account_id uuid NOT NULL REFERENCES trustwork.billing_account (id),
  period_start timestamptz NOT NULL,
  accrued_micro bigint NOT NULL DEFAULT 0 CHECK (accrued_micro >= 0),
  settled_minor bigint NOT NULL DEFAULT 0 CHECK (settled_minor >= 0),
  PRIMARY KEY (billing_account_id, period_start)
);

-- Metered spend counts against the mandate's ceilings in the same sum as every other use, and is excluded only from the
-- per-window action count: a metered step is a cost of an action, not one more action.
ALTER TABLE trustwork.mandate_use ADD COLUMN metered_step_id uuid NULL REFERENCES trustwork.metered_step (id);
CREATE UNIQUE INDEX mandate_use_metered_step ON trustwork.mandate_use (metered_step_id) WHERE metered_step_id IS NOT NULL;
CREATE OR REPLACE FUNCTION trustwork.assistant_check_limits(p_mandate trustwork.mandate, p_amount_minor bigint, p_currency text) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_limits jsonb := p_mandate.snapshot -> 'limits';
  v_committed bigint;
  v_window integer;
BEGIN
  IF jsonb_typeof(v_limits -> 'perActionCeiling') = 'object' AND p_amount_minor IS NOT NULL THEN
    IF (v_limits -> 'perActionCeiling' ->> 'currency') <> p_currency OR p_amount_minor > (v_limits -> 'perActionCeiling' ->> 'minorUnits')::bigint THEN
      RAISE EXCEPTION 'outside the per-action ceiling' USING ERRCODE = 'check_violation', HINT = 'mandate.limit';
    END IF;
  END IF;
  IF jsonb_typeof(v_limits -> 'ceiling') = 'object' AND p_amount_minor IS NOT NULL THEN
    IF (v_limits -> 'ceiling' ->> 'currency') <> p_currency THEN
      RAISE EXCEPTION 'currency differs from the ceiling' USING ERRCODE = 'check_violation', HINT = 'mandate.limit';
    END IF;
    SELECT coalesce(sum(amount_minor), 0) INTO v_committed FROM trustwork.mandate_use WHERE mandate_id = p_mandate.id AND voided_at IS NULL AND amount_minor IS NOT NULL;
    IF v_committed + p_amount_minor > (v_limits -> 'ceiling' ->> 'minorUnits')::bigint THEN
      RAISE EXCEPTION 'the cumulative ceiling would be exceeded' USING ERRCODE = 'check_violation', HINT = 'mandate.limit';
    END IF;
  END IF;
  IF jsonb_typeof(v_limits -> 'perWindow') = 'object' THEN
    SELECT count(*) INTO v_window FROM trustwork.mandate_use
    WHERE mandate_id = p_mandate.id AND voided_at IS NULL AND metered_step_id IS NULL AND used_at > clock_timestamp() - make_interval(hours => (v_limits -> 'perWindow' ->> 'windowHours')::integer);
    IF v_window >= (v_limits -> 'perWindow' ->> 'count')::integer THEN
      RAISE EXCEPTION 'the action window is exhausted' USING ERRCODE = 'check_violation', HINT = 'mandate.limit';
    END IF;
  END IF;
END $$;

-- Alerts at 80 and 100 percent: facts for the principal's own decisions list, never mail.
CREATE TABLE trustwork.agent_quota_notice (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  window_id uuid NOT NULL REFERENCES trustwork.agent_quota_window (id),
  threshold integer NOT NULL CHECK (threshold IN (80, 100)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (window_id, threshold)
);
CREATE TRIGGER agent_quota_notice_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_quota_notice FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

ALTER TABLE trustwork.agent_quota_window ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_quota_window FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.metered_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.metered_step FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_charge_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_charge_period FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_quota_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_quota_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.agent_quota_window AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_charge_period AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.metered_step AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_quota_notice AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- A principal reads their own windows and steps; company rows need the billing view of that company, as for accounts.
CREATE POLICY agent_quota_window_read ON trustwork.agent_quota_window FOR SELECT TO trustwork_app USING (
  coalesce(principal_person_id = trustwork.current_person_id(), false)
  OR (coalesce(principal_company_id = trustwork.current_company_id(), false) AND (trustwork.current_membership_has('company.billing.view') OR trustwork.current_membership_has('company.billing.manage'))));
CREATE POLICY metered_step_read ON trustwork.metered_step FOR SELECT TO trustwork_app USING (
  coalesce(principal_person_id = trustwork.current_person_id(), false)
  OR (coalesce(principal_company_id = trustwork.current_company_id(), false) AND (trustwork.current_membership_has('company.billing.view') OR trustwork.current_membership_has('company.billing.manage'))));
CREATE POLICY agent_quota_notice_read ON trustwork.agent_quota_notice FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.agent_quota_window w WHERE w.id = window_id));
GRANT SELECT ON trustwork.agent_quota_window, trustwork.metered_step, trustwork.agent_quota_notice TO trustwork_app;

-- The active agent plan of a principal in a hub. A trial or paid period that has ended is no plan.
CREATE FUNCTION trustwork.billing_meter_plan(p_hub uuid, p_person uuid, p_company uuid, OUT plan_version_id uuid, OUT plan_key text, OUT payload jsonb)
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT v.id, o.code, v.payload
  FROM trustwork.subscription s JOIN trustwork.billing_account a ON a.id = s.billing_account_id
  JOIN trustwork.subscription_plan_version v ON v.id = s.subscription_plan_version_id JOIN trustwork.offer o ON o.id = v.offer_id
  WHERE a.hub_id = p_hub AND a.status = 'active' AND a.owner_person_id IS NOT DISTINCT FROM p_person AND a.owner_company_id IS NOT DISTINCT FROM p_company
    AND s.status IN ('trial', 'active') AND s.current_period_start <= clock_timestamp() AND s.current_period_end > clock_timestamp()
  ORDER BY s.current_period_start DESC, s.id LIMIT 1
$$;

-- Included units per window: the larger of the hub's free quota (or the engine floor when no policy is active) and the
-- plan's quota. Free quota is a floor under a plan, never added to it.
CREATE FUNCTION trustwork.billing_meter_quotas(p_hub uuid, p_plan jsonb, p_module text, p_meter text)
RETURNS TABLE (window_kind text, units bigint) LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  WITH current_policy AS (SELECT document FROM trustwork.agent_policy_current WHERE hub_id = p_hub),
  included AS (
    SELECT q ->> 'window' AS w, (q ->> 'units')::bigint AS u
    FROM current_policy c, jsonb_array_elements(c.document #> '{policy,enabledModules}') e, jsonb_array_elements(e -> 'freeQuota') q
    WHERE e ->> 'moduleKey' = p_module AND q ->> 'meter' = p_meter
    UNION ALL
    SELECT q ->> 'window', (q ->> 'units')::bigint
    FROM trustwork.agent_engine_manifest m, jsonb_array_elements(m.document -> 'freeFloor') q
    WHERE m.module_key = p_module AND q ->> 'meter' = p_meter AND NOT EXISTS (SELECT 1 FROM current_policy)
    UNION ALL
    SELECT q ->> 'window', (q ->> 'units')::bigint
    FROM jsonb_array_elements(coalesce(p_plan -> 'includedQuota', '[]'::jsonb)) q
    WHERE q ->> 'moduleKey' = p_module AND q ->> 'meter' = p_meter
  )
  SELECT w, max(u) FROM included GROUP BY w ORDER BY w
$$;

-- Modules with any free quota in this hub: the active policy's, or the engine floor when no policy is active.
CREATE FUNCTION trustwork.billing_meter_free_modules(p_hub uuid) RETURNS TABLE (module_key text)
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT e ->> 'moduleKey' FROM trustwork.agent_policy_current c, jsonb_array_elements(c.document #> '{policy,enabledModules}') e
  WHERE c.hub_id = p_hub AND jsonb_array_length(coalesce(e -> 'freeQuota', '[]'::jsonb)) > 0
  UNION
  SELECT m.module_key FROM trustwork.agent_engine_manifest m
  WHERE jsonb_array_length(coalesce(m.document -> 'freeFloor', '[]'::jsonb)) > 0 AND NOT EXISTS (SELECT 1 FROM trustwork.agent_policy_current c WHERE c.hub_id = p_hub)
$$;

CREATE FUNCTION trustwork.billing_meter_window_start(p_kind text, p_at timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT date_trunc(p_kind, p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
$$;

-- Creates and row-locks this moment's windows in one fixed order; a later plan change updates the limit in place.
CREATE FUNCTION trustwork.billing_meter_lock_windows(p_hub uuid, p_person uuid, p_company uuid, p_plan jsonb, p_module text, p_meter text) RETURNS uuid[]
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE q record; v_start timestamptz; v_id uuid; v_ids uuid[] := '{}';
BEGIN
  FOR q IN SELECT * FROM trustwork.billing_meter_quotas(p_hub, p_plan, p_module, p_meter) LOOP
    v_start := trustwork.billing_meter_window_start(q.window_kind, clock_timestamp());
    INSERT INTO trustwork.agent_quota_window (hub_id, principal_person_id, principal_company_id, module_key, meter, window_kind, window_start, window_end, limit_units)
    VALUES (p_hub, p_person, p_company, p_module, p_meter, q.window_kind, v_start, v_start + ('1 ' || q.window_kind)::interval, q.units)
    ON CONFLICT (hub_id, coalesce(principal_person_id, principal_company_id), module_key, meter, window_kind, window_start)
    DO UPDATE SET limit_units = EXCLUDED.limit_units, updated_at = now() RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
  END LOOP;
  RETURN v_ids;
END $$;

-- The newest version in force that this account accepted. A later version applies only from the payer's own next
-- acceptance, and an accepted version stops charging at its own end: past it the step asks instead. `lapsed` says a
-- version of this subject was in force and has ended, so the subject is no longer one the hub never priced.
CREATE FUNCTION trustwork.billing_meter_subject_price(p_hub uuid, p_account uuid, p_kind text, p_key text, p_direction text, p_meter text, p_currency text,
  OUT price_version_id uuid, OUT sale bigint, OUT cost bigint, OUT published boolean, OUT lapsed boolean)
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE v_subject uuid; v_now timestamptz := clock_timestamp();
BEGIN
  published := false;
  lapsed := false;
  SELECT id INTO v_subject FROM trustwork.metered_subject WHERE hub_id = p_hub AND kind = p_kind AND subject_key = p_key AND direction IS NOT DISTINCT FROM p_direction AND meter = p_meter;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT p.id, t.sale_micro, t.cost_micro INTO price_version_id, sale, cost
  FROM trustwork.metered_price_term t JOIN trustwork.price_version p ON p.id = t.price_version_id
  WHERE t.subject_id = v_subject AND p.currency = p_currency AND p.status IN ('active', 'superseded') AND p.effective_from <= v_now
    AND (p.effective_to IS NULL OR p.effective_to > v_now)
    AND EXISTS (SELECT 1 FROM trustwork.price_acceptance a WHERE a.price_version_id = p.id AND a.billing_account_id = p_account)
  ORDER BY p.version DESC LIMIT 1;
  -- Any currency: a price this account cannot verify is a question, never a free step.
  published := EXISTS (SELECT 1 FROM trustwork.metered_price_term t JOIN trustwork.price_version p ON p.id = t.price_version_id
    WHERE t.subject_id = v_subject AND p.status = 'active' AND p.effective_from <= v_now AND (p.effective_to IS NULL OR p.effective_to > v_now));
  lapsed := EXISTS (SELECT 1 FROM trustwork.metered_price_term t JOIN trustwork.price_version p ON p.id = t.price_version_id
    WHERE t.subject_id = v_subject AND p.status IN ('active', 'superseded') AND p.effective_to <= v_now);
END $$;

-- Most specific subject first: catalogue model, capability, module, then the hub-wide meter rate. The first subject with
-- a published or accepted version decides; a published price the payer has not accepted is a question, not a charge.
-- An ended version decides nothing, so a broader live price still applies; with none, the state is `lapsed`, never free.
CREATE FUNCTION trustwork.billing_meter_resolve_price(p_hub uuid, p_account uuid, p_module text, p_capability text, p_meter text, p_model text, p_currency text,
  OUT state text, OUT price_version_id uuid, OUT output_price_version_id uuid, OUT sale_in bigint, OUT sale_out bigint, OUT cost_in bigint, OUT cost_out bigint, OUT unit_size bigint)
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE r record; o record; c record; v_lapsed boolean := false;
BEGIN
  state := 'none';
  unit_size := CASE WHEN p_meter = 'model_tokens' THEN 1000 ELSE 1 END;
  IF p_model IS NOT NULL AND p_meter = 'model_tokens' THEN
    SELECT * INTO r FROM trustwork.billing_meter_subject_price(p_hub, p_account, 'model', p_model, 'input', p_meter, p_currency);
    SELECT * INTO o FROM trustwork.billing_meter_subject_price(p_hub, p_account, 'model', p_model, 'output', p_meter, p_currency);
    IF r.price_version_id IS NOT NULL AND o.price_version_id IS NOT NULL THEN
      state := 'accepted'; price_version_id := r.price_version_id; output_price_version_id := o.price_version_id;
      sale_in := r.sale; sale_out := o.sale; cost_in := r.cost; cost_out := o.cost;
      RETURN;
    END IF;
    IF r.published OR o.published THEN state := 'not_accepted'; RETURN; END IF;
    v_lapsed := r.lapsed OR o.lapsed;
  END IF;
  FOR c IN SELECT * FROM (VALUES (1, 'capability', p_capability), (2, 'module', p_module), (3, 'meter', p_meter)) AS x(n, kind, key) WHERE key IS NOT NULL ORDER BY n LOOP
    SELECT * INTO r FROM trustwork.billing_meter_subject_price(p_hub, p_account, c.kind, c.key, NULL, p_meter, p_currency);
    IF r.price_version_id IS NOT NULL THEN
      state := 'accepted'; price_version_id := r.price_version_id; sale_in := r.sale; sale_out := r.sale; cost_in := r.cost; cost_out := r.cost;
      RETURN;
    END IF;
    IF r.published THEN state := 'not_accepted'; RETURN; END IF;
    v_lapsed := v_lapsed OR r.lapsed;
  END LOOP;
  IF v_lapsed THEN state := 'lapsed'; END IF;
END $$;

-- The exact price of a share of a step, in millionths of a minor unit, rounded up only at that resolution. Rates are
-- millionths of a minor unit per priced unit. `p_share_units` of the step's units are beyond the included quota, so a
-- model's two rates blend in proportion. Integer arithmetic only: the quotient and remainder keep the product inside
-- bigint, and an out-of-range step fails rather than undercharging.
CREATE FUNCTION trustwork.billing_meter_micro(p_in bigint, p_out bigint, p_rate_in bigint, p_rate_out bigint, p_unit_size bigint, p_share_units bigint) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_units bigint := coalesce(p_in, 0) + coalesce(p_out, 0);
  v_total bigint;
  v_scaled bigint;
BEGIN
  IF v_units = 0 OR p_share_units = 0 THEN RETURN 0; END IF;
  v_total := coalesce(p_in, 0) * coalesce(p_rate_in, 0) + coalesce(p_out, 0) * coalesce(p_rate_out, 0);
  v_scaled := (v_total / v_units) * p_share_units + ((v_total % v_units) * p_share_units + v_units - 1) / v_units;
  RETURN (v_scaled + p_unit_size - 1) / p_unit_size;
END $$;
-- Whole minor units to hold for an amount. Only a reservation rounds per step.
CREATE FUNCTION trustwork.billing_micro_to_minor(p_micro bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT (p_micro + 999999) / 1000000
$$;
-- Adds an exact charge to this month's total and returns the whole minor units it newly completes. The row lock orders
-- concurrent steps of one account; the month's settled total is the exact sum rounded up once.
CREATE FUNCTION trustwork.billing_meter_accrue(p_account uuid, p_micro bigint) RETURNS bigint
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE v_start timestamptz := trustwork.billing_meter_window_start('month', clock_timestamp()); v_row trustwork.agent_charge_period%ROWTYPE; v_target bigint;
BEGIN
  INSERT INTO trustwork.agent_charge_period (billing_account_id, period_start, accrued_micro) VALUES (p_account, v_start, p_micro)
  ON CONFLICT (billing_account_id, period_start) DO UPDATE SET accrued_micro = agent_charge_period.accrued_micro + EXCLUDED.accrued_micro RETURNING * INTO v_row;
  v_target := trustwork.billing_micro_to_minor(v_row.accrued_micro);
  UPDATE trustwork.agent_charge_period SET settled_minor = v_target WHERE billing_account_id = p_account AND period_start = v_start;
  RETURN v_target - v_row.settled_minor;
END $$;
-- Would this amount fit the mandate's per-action and cumulative ceilings, in the same sum every other use counts in?
CREATE FUNCTION trustwork.billing_meter_within_ceiling(p_mandate uuid, p_amount bigint, p_currency text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE v_limits jsonb; v_committed bigint;
BEGIN
  SELECT m.snapshot -> 'limits' INTO v_limits FROM trustwork.mandate m WHERE m.id = p_mandate;
  IF jsonb_typeof(v_limits -> 'perActionCeiling') = 'object'
    AND ((v_limits -> 'perActionCeiling' ->> 'currency') IS DISTINCT FROM p_currency OR p_amount > (v_limits -> 'perActionCeiling' ->> 'minorUnits')::bigint) THEN RETURN false; END IF;
  IF jsonb_typeof(v_limits -> 'ceiling') = 'object' THEN
    IF (v_limits -> 'ceiling' ->> 'currency') IS DISTINCT FROM p_currency THEN RETURN false; END IF;
    SELECT coalesce(sum(amount_minor), 0) INTO v_committed FROM trustwork.mandate_use WHERE mandate_id = p_mandate AND voided_at IS NULL AND amount_minor IS NOT NULL;
    IF v_committed + p_amount > (v_limits -> 'ceiling' ->> 'minorUnits')::bigint THEN RETURN false; END IF;
  END IF;
  RETURN true;
END $$;
-- Crossing a threshold without multiplying a large limit: used >= ceil(limit * percent / 100).
CREATE FUNCTION trustwork.billing_meter_threshold(p_limit bigint, p_percent integer) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT (p_limit / 100) * p_percent + ((p_limit % 100) * p_percent + 99) / 100
$$;

CREATE FUNCTION trustwork.billing_meter_person(p jsonb) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$ SELECT CASE WHEN p #>> '{principal,kind}' = 'person' THEN (p #>> '{principal,id}')::uuid END $$;
CREATE FUNCTION trustwork.billing_meter_company(p jsonb) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$ SELECT CASE WHEN p #>> '{principal,kind}' = 'company' THEN (p #>> '{principal,id}')::uuid END $$;

-- What a step would do now, without changing anything: the split across the included quota, the price and, when the job
-- has to stop, why. Admission calls this after locking the windows; the estimate shown to a person calls it directly.
CREATE FUNCTION trustwork.billing_meter_quote(p jsonb, p_account uuid, p_currency text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_hub uuid := (p ->> 'hubId')::uuid;
  v_person uuid := trustwork.billing_meter_person(p);
  v_company uuid := trustwork.billing_meter_company(p);
  v_module text := p ->> 'moduleKey';
  v_meter text := p ->> 'meter';
  v_units bigint := (p ->> 'estimatedUnits')::bigint;
  v_in bigint := coalesce((p ->> 'estimatedInputUnits')::bigint, (p ->> 'estimatedUnits')::bigint);
  v_out bigint := coalesce((p ->> 'estimatedOutputUnits')::bigint, 0);
  v_plan record;
  v_quota record;
  v_price record;
  v_defined boolean := false;
  v_left bigint;
  v_room bigint;
  v_within bigint;
  v_beyond bigint;
  v_estimate bigint := 0;
  v_budget uuid := (p ->> 'budgetId')::uuid;
  v_committed record;
  v_row trustwork.budget%ROWTYPE;
  v_stop text;
BEGIN
  SELECT * INTO v_plan FROM trustwork.billing_meter_plan(v_hub, v_person, v_company);
  FOR v_quota IN SELECT * FROM trustwork.billing_meter_quotas(v_hub, v_plan.payload, v_module, v_meter) LOOP
    v_defined := true;
    SELECT greatest(v_quota.units - coalesce(sum(w.used_units + w.held_units), 0), 0) INTO v_room FROM trustwork.agent_quota_window w
    WHERE w.hub_id = v_hub AND coalesce(w.principal_person_id, w.principal_company_id) = coalesce(v_person, v_company) AND w.module_key = v_module AND w.meter = v_meter
      AND w.window_kind = v_quota.window_kind AND w.window_start = trustwork.billing_meter_window_start(v_quota.window_kind, clock_timestamp());
    v_left := least(coalesce(v_left, v_room), v_room);
  END LOOP;
  SELECT * INTO v_price FROM trustwork.billing_meter_resolve_price(v_hub, p_account, v_module, p ->> 'capabilityId', v_meter, p ->> 'modelKey', p_currency);
  -- A meter the hub neither limits nor prices is recorded and free. Priced without a quota, or priced once and lapsed:
  -- every unit is beyond it, and a lapsed price asks. A hub that means a lapsed meter to be free publishes a zero rate.
  v_within := CASE WHEN v_defined THEN least(v_units, v_left) WHEN v_price.state = 'none' THEN v_units ELSE 0 END;
  v_beyond := v_units - v_within;
  IF v_beyond > 0 THEN
    IF v_price.state IN ('none', 'lapsed') THEN v_stop := 'no_price';
    ELSIF v_price.state = 'not_accepted' THEN v_stop := 'price_not_accepted';
    ELSE
      v_estimate := trustwork.billing_micro_to_minor(trustwork.billing_meter_micro(v_in, v_out, v_price.sale_in, v_price.sale_out, v_price.unit_size, v_beyond));
      IF v_estimate > 0 THEN
        IF v_budget IS NULL THEN v_stop := 'no_budget';
        ELSE
          SELECT * INTO v_row FROM trustwork.budget WHERE id = v_budget;
          SELECT * INTO v_committed FROM trustwork.billing_budget_committed(v_budget);
          -- Usage settles on the principal's own platform budget. Refused here, before anything is held.
          IF v_row.id IS NULL OR v_row.kind <> 'platform' OR v_row.owner_person_id IS DISTINCT FROM v_person OR v_row.owner_company_id IS DISTINCT FROM v_company THEN v_stop := 'budget_not_principal';
          -- `billing_reserve` refuses both with an error; a budget that cannot pay this step is a question.
          ELSIF v_row.currency IS DISTINCT FROM p_currency OR (v_row.project_id IS NOT NULL AND v_row.project_id IS DISTINCT FROM (p ->> 'projectId')::uuid) THEN v_stop := 'budget_out_of_scope';
          ELSIF v_row.limit_minor - v_committed.consumed - v_committed.held < v_estimate THEN v_stop := 'budget_insufficient';
          ELSIF (p ->> 'mandateId') IS NOT NULL AND NOT trustwork.billing_meter_within_ceiling((p ->> 'mandateId')::uuid, v_estimate, p_currency) THEN v_stop := 'mandate_ceiling';
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('withinUnits', v_within, 'beyondUnits', v_beyond, 'estimateMinor', v_estimate::text, 'currency', p_currency, 'stop', v_stop,
    'priced', v_price.state = 'accepted', 'quotaDefined', v_defined, 'priceVersionId', v_price.price_version_id, 'outputPriceVersionId', v_price.output_price_version_id,
    'planVersionId', v_plan.plan_version_id);
END $$;

-- The principal's account in the hub currency. Metering opens it, so a free participant needs no billing step of their own.
-- A hub with no currency has nothing to bill: both values stay null and the free allowance still applies. Billing
-- configuration never decides whether a free step may run.
CREATE FUNCTION trustwork.billing_meter_account(p_hub uuid, p_person uuid, p_company uuid, p_actor uuid, OUT id uuid, OUT currency text)
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  SELECT h.currency INTO currency FROM trustwork.hub_profile h WHERE h.hub_id = p_hub;
  IF currency IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.account'), hashtext(p_hub::text || ':' || coalesce(p_person, p_company)::text));
  SELECT a.id INTO id FROM trustwork.billing_account a WHERE a.hub_id = p_hub AND a.currency = billing_meter_account.currency AND a.status = 'active'
    AND a.owner_person_id IS NOT DISTINCT FROM p_person AND a.owner_company_id IS NOT DISTINCT FROM p_company;
  IF id IS NULL THEN
    INSERT INTO trustwork.billing_account (hub_id, owner_person_id, owner_company_id, currency, created_by) VALUES (p_hub, p_person, p_company, currency, p_actor) RETURNING billing_account.id INTO id;
  END IF;
END $$;

CREATE FUNCTION trustwork.billing_meter_step_view(s trustwork.metered_step, p_decision text, p_replayed boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('decision', p_decision, 'replayed', p_replayed, 'stepId', s.id, 'state', s.state, 'withinUnits', s.within_units, 'beyondUnits', s.beyond_units,
    'estimateMinor', s.estimate_minor::text, 'chargedMinor', s.charged_minor::text, 'currency', s.currency, 'reservationId', s.reservation_id, 'priced', s.price_version_id IS NOT NULL,
    'usageRecordId', s.usage_record_id)
$$;

-- Admission. Idempotent per run step, attempt and meter. A step already charged is never charged again, and an attempt
-- whose outcome is open blocks the next one: an unknown outcome is reconciled, not retried.
CREATE FUNCTION trustwork.billing_meter_admit_core(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_hub uuid := (p ->> 'hubId')::uuid;
  v_person uuid := trustwork.billing_meter_person(p);
  v_company uuid := trustwork.billing_meter_company(p);
  v_step uuid := (p ->> 'runStepId')::uuid;
  v_attempt uuid := (p ->> 'attemptId')::uuid;
  v_meter text := p ->> 'meter';
  v_row trustwork.metered_step%ROWTYPE;
  v_account record;
  v_plan record;
  v_windows uuid[];
  v_quote jsonb;
  v_reservation uuid;
  v_estimate bigint;
  v_within bigint;
  v_hint text;
BEGIN
  IF (v_person IS NULL) = (v_company IS NULL) OR (p ->> 'estimatedUnits') IS NULL OR (p ->> 'estimatedUnits')::bigint < 0 THEN
    RAISE EXCEPTION 'invalid metered step' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  -- Mandate, then windows, then budget, as the owning model and action commands lock them.
  PERFORM 1 FROM trustwork.mandate WHERE id = (p ->> 'mandateId')::uuid FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.step'), hashtext(v_step::text || ':' || v_meter));
  SELECT * INTO v_row FROM trustwork.metered_step WHERE run_step_id = v_step AND attempt_id = v_attempt AND meter = v_meter;
  IF FOUND THEN
    IF v_row.estimated_units <> (p ->> 'estimatedUnits')::bigint OR v_row.module_key <> p ->> 'moduleKey' OR v_row.run_id <> (p ->> 'runId')::uuid
       OR v_row.principal_person_id IS DISTINCT FROM v_person OR v_row.principal_company_id IS DISTINCT FROM v_company THEN
      RAISE EXCEPTION 'this step was admitted with other terms' USING ERRCODE = '23505', HINT = 'validation.idempotency_conflict';
    END IF;
    RETURN trustwork.billing_meter_step_view(v_row, 'admitted', true);
  END IF;
  SELECT * INTO v_row FROM trustwork.metered_step WHERE run_step_id = v_step AND meter = v_meter AND state = 'succeeded';
  IF FOUND THEN RETURN trustwork.billing_meter_step_view(v_row, 'already_charged', true); END IF;
  IF EXISTS (SELECT 1 FROM trustwork.metered_step WHERE run_step_id = v_step AND meter = v_meter AND state IN ('admitted', 'outcome_unknown')) THEN
    RAISE EXCEPTION 'an earlier attempt of this step has no final outcome' USING ERRCODE = '23514', HINT = 'billing.attempt_open';
  END IF;
  SELECT * INTO v_account FROM trustwork.billing_meter_account(v_hub, v_person, v_company, (p ->> 'actingPersonId')::uuid);
  SELECT * INTO v_plan FROM trustwork.billing_meter_plan(v_hub, v_person, v_company);
  v_windows := trustwork.billing_meter_lock_windows(v_hub, v_person, v_company, v_plan.payload, p ->> 'moduleKey', v_meter);
  v_quote := trustwork.billing_meter_quote(p, v_account.id, v_account.currency);
  IF v_quote ->> 'stop' IS NOT NULL THEN
    RETURN jsonb_build_object('decision', 'stopped', 'reason', v_quote ->> 'stop', 'replayed', false, 'beyondUnits', (v_quote ->> 'beyondUnits')::bigint,
      'estimateMinor', v_quote ->> 'estimateMinor', 'currency', v_account.currency);
  END IF;
  v_estimate := (v_quote ->> 'estimateMinor')::bigint;
  v_within := (v_quote ->> 'withinUnits')::bigint;
  IF v_estimate > 0 THEN
    BEGIN
      SELECT r.id INTO v_reservation FROM trustwork.billing_reserve((p ->> 'budgetId')::uuid, 'platform', v_estimate, v_account.currency, (p ->> 'runId')::uuid,
        'meter:' || v_step::text || ':' || v_attempt::text || ':' || v_meter, (p ->> 'projectId')::uuid, interval '30 days') r;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IN ('commercial.budget_insufficient', 'billing.budget_inactive') THEN
        RETURN jsonb_build_object('decision', 'stopped', 'reason', 'budget_insufficient', 'replayed', false, 'beyondUnits', (v_quote ->> 'beyondUnits')::bigint,
          'estimateMinor', v_estimate::text, 'currency', v_account.currency);
      END IF;
      RAISE;
    END;
    -- An unknown outcome keeps this hold past any expiry until a final outcome closes it.
    PERFORM trustwork.billing_hold_for_effect(v_reservation);
  END IF;
  UPDATE trustwork.agent_quota_window SET held_units = held_units + v_within, updated_at = now() WHERE id = ANY (v_windows);
  INSERT INTO trustwork.agent_quota_notice (window_id, threshold)
  SELECT w.id, t.threshold FROM trustwork.agent_quota_window w CROSS JOIN (VALUES (80), (100)) AS t(threshold)
  WHERE w.id = ANY (v_windows) AND w.used_units + w.held_units >= trustwork.billing_meter_threshold(w.limit_units, t.threshold)
  ON CONFLICT (window_id, threshold) DO NOTHING;
  INSERT INTO trustwork.metered_step (hub_id, principal_person_id, principal_company_id, acting_person_id, billing_account_id, module_key, capability_id, run_id, run_step_id, attempt_id,
    connection_id, meter, provider_class, model_key, source_kind, source_ref, plan_version_id, window_ids, estimated_units, within_units, beyond_units, price_version_id,
    output_price_version_id, reservation_id, estimate_minor, currency)
  VALUES (v_hub, v_person, v_company, (p ->> 'actingPersonId')::uuid, v_account.id, p ->> 'moduleKey', p ->> 'capabilityId', (p ->> 'runId')::uuid, v_step, v_attempt,
    (p ->> 'connectionId')::uuid, v_meter, p ->> 'providerClass', p ->> 'modelKey', p ->> 'sourceKind', p ->> 'sourceRef', (v_quote ->> 'planVersionId')::uuid, v_windows,
    (p ->> 'estimatedUnits')::bigint, v_within, (v_quote ->> 'beyondUnits')::bigint, (v_quote ->> 'priceVersionId')::uuid, (v_quote ->> 'outputPriceVersionId')::uuid,
    v_reservation, v_estimate, v_account.currency)
  RETURNING * INTO v_row;
  IF v_estimate > 0 AND (p ->> 'mandateId') IS NOT NULL THEN
    INSERT INTO trustwork.mandate_use (mandate_id, mandate_revision, action, amount_minor, currency, metered_step_id)
    SELECT m.id, m.revision, 'metered:' || v_meter, v_estimate, v_account.currency, v_row.id FROM trustwork.mandate m WHERE m.id = (p ->> 'mandateId')::uuid;
  END IF;
  RETURN trustwork.billing_meter_step_view(v_row, 'admitted', false);
END $$;

-- Closes a step from its outcome. Replaying the same outcome returns the first result unchanged. `unknown` keeps every
-- hold; only a later final outcome closes them. Usage above the estimate is recorded honestly but never charged beyond
-- the reservation: an overrun is the hub's, not the participant's surprise.
CREATE FUNCTION trustwork.billing_meter_finish_core(p_step uuid, p_result text, p_units bigint, p_input bigint, p_output bigint, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  s trustwork.metered_step%ROWTYPE;
  v_id uuid;
  v_room bigint;
  v_within bigint;
  v_beyond bigint;
  v_charge bigint := 0;
  v_micro bigint := 0;
  v_credit bigint := 0;
  v_overrun bigint := 0;
  v_cost bigint := 0;
  v_in bigint;
  v_out bigint;
  v_rate_in bigint; v_rate_out bigint; v_cost_in bigint; v_cost_out bigint;
  v_unit bigint := 1;
  v_limit bigint;
  v_usage uuid;
BEGIN
  IF p_result NOT IN ('succeeded', 'failed', 'unknown') OR coalesce(length(p_evidence), 0) NOT BETWEEN 1 AND 200 OR (p_result = 'succeeded' AND coalesce(p_units, -1) < 0) THEN
    RAISE EXCEPTION 'invalid step outcome' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  SELECT * INTO s FROM trustwork.metered_step WHERE id = p_step;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown step' USING ERRCODE = '42501', HINT = 'access.not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.step'), hashtext(s.run_step_id::text || ':' || s.meter));
  -- Windows before the step row, as in admission.
  PERFORM 1 FROM trustwork.agent_quota_window WHERE id = ANY (s.window_ids) ORDER BY window_kind FOR UPDATE;
  SELECT * INTO s FROM trustwork.metered_step WHERE id = p_step FOR UPDATE;
  IF s.state IN ('succeeded', 'failed') THEN
    IF s.state = p_result THEN RETURN trustwork.billing_meter_step_view(s, 'closed', true); END IF;
    RAISE EXCEPTION 'this step already closed as %', s.state USING ERRCODE = '23514', HINT = 'billing.step_closed';
  END IF;
  IF p_result = 'unknown' THEN
    UPDATE trustwork.metered_step SET state = 'outcome_unknown', evidence_ref = p_evidence WHERE id = p_step RETURNING * INTO s;
    RETURN trustwork.billing_meter_step_view(s, 'open', false);
  END IF;
  UPDATE trustwork.agent_quota_window SET held_units = held_units - s.within_units, updated_at = now() WHERE id = ANY (s.window_ids);
  IF p_result = 'failed' THEN
    PERFORM trustwork.billing_close_from_outcome(s.reservation_id, false, NULL, p_evidence);
    UPDATE trustwork.mandate_use SET voided_at = clock_timestamp() WHERE metered_step_id = p_step;
    UPDATE trustwork.metered_step SET state = 'failed', actual_units = 0, evidence_ref = p_evidence, closed_at = clock_timestamp() WHERE id = p_step RETURNING * INTO s;
    RETURN trustwork.billing_meter_step_view(s, 'closed', false);
  END IF;
  SELECT min(greatest(limit_units - used_units - held_units, 0)) INTO v_room FROM trustwork.agent_quota_window WHERE id = ANY (s.window_ids);
  v_within := CASE WHEN v_room IS NOT NULL THEN least(p_units, v_room) WHEN s.price_version_id IS NULL THEN p_units ELSE 0 END;
  v_beyond := p_units - v_within;
  v_in := coalesce(p_input, p_units);
  v_out := coalesce(p_output, 0);
  IF s.price_version_id IS NOT NULL THEN
    SELECT sale_micro, cost_micro INTO v_rate_in, v_cost_in FROM trustwork.metered_price_term WHERE price_version_id = s.price_version_id;
    SELECT sale_micro, cost_micro INTO v_rate_out, v_cost_out FROM trustwork.metered_price_term WHERE price_version_id = coalesce(s.output_price_version_id, s.price_version_id);
    v_unit := CASE WHEN s.meter = 'model_tokens' THEN 1000 ELSE 1 END;
    v_cost := trustwork.billing_meter_micro(v_in, v_out, v_cost_in, v_cost_out, v_unit, p_units);
  END IF;
  IF v_beyond > 0 THEN
    v_micro := trustwork.billing_meter_micro(v_in, v_out, v_rate_in, v_rate_out, v_unit, v_beyond);
    SELECT amount_minor INTO v_limit FROM trustwork.reservation WHERE id = s.reservation_id;
    IF v_micro > coalesce(v_limit, 0) * 1000000 THEN
      v_overrun := v_beyond;
      v_micro := coalesce(v_limit, 0) * 1000000;
    END IF;
  END IF;
  UPDATE trustwork.agent_quota_window SET used_units = used_units + p_units, updated_at = now() WHERE id = ANY (s.window_ids);
  INSERT INTO trustwork.agent_quota_notice (window_id, threshold)
  SELECT w.id, t.threshold FROM trustwork.agent_quota_window w CROSS JOIN (VALUES (80), (100)) AS t(threshold)
  WHERE w.id = ANY (s.window_ids) AND w.used_units + w.held_units >= trustwork.billing_meter_threshold(w.limit_units, t.threshold)
  ON CONFLICT (window_id, threshold) DO NOTHING;
  IF v_micro > 0 THEN v_charge := trustwork.billing_meter_accrue(s.billing_account_id, v_micro); END IF;
  PERFORM trustwork.billing_close_from_outcome(s.reservation_id, v_charge > 0, v_charge, p_evidence);
  UPDATE trustwork.mandate_use SET amount_minor = v_charge, voided_at = CASE WHEN v_charge = 0 THEN clock_timestamp() END WHERE metered_step_id = p_step;
  IF s.billing_account_id IS NULL THEN
    UPDATE trustwork.metered_step SET state = 'succeeded', actual_units = p_units, evidence_ref = p_evidence, closed_at = clock_timestamp() WHERE id = p_step RETURNING * INTO s;
    RETURN trustwork.billing_meter_step_view(s, 'closed', false);
  END IF;
  INSERT INTO trustwork.usage_record (principal_person_id, principal_company_id, billing_account_id, module_key, capability_id, run_id, run_step_id, attempt_id, connection_id, meter,
    provider_class, units, within_included_quota, price_version_id, reservation_id)
  VALUES (s.principal_person_id, s.principal_company_id, s.billing_account_id, s.module_key, s.capability_id, s.run_id, s.run_step_id, s.attempt_id, s.connection_id, s.meter,
    s.provider_class, p_units, v_micro = 0, CASE WHEN v_micro > 0 THEN s.price_version_id END, CASE WHEN v_micro > 0 THEN s.reservation_id END)
  RETURNING id INTO v_usage;
  -- Prepaid credits fund the charge first; what they do not cover stays on the budget for the provider path.
  v_credit := trustwork.billing_credit_consume(s.billing_account_id, s.run_step_id, v_charge);
  UPDATE trustwork.metered_step SET state = 'succeeded', actual_units = p_units, overrun_units = v_overrun, charged_minor = v_charge, charged_micro = v_micro, cost_micro = v_cost, credit_minor = v_credit, usage_record_id = v_usage,
    evidence_ref = p_evidence, closed_at = clock_timestamp() WHERE id = p_step RETURNING * INTO s;
  RETURN trustwork.billing_meter_step_view(s, 'closed', false);
END $$;

-- 2. Runtime bindings: the owning transactions meter themselves, so a crash cannot separate a charge from its outcome ---

-- Whether this capability consumes this meter. Metering follows the manifest, not a caller's claim. An introduction is
-- matching and never metered: no quota, price or plan may decide it, only the hub's protection limits.
CREATE FUNCTION trustwork.billing_meter_declared(p_capability text, p_meter text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.agent_engine_manifest m, jsonb_array_elements(m.document -> 'capabilities') c
    WHERE m.module_key = split_part(p_capability, '.', 1) AND c ->> 'id' = p_capability AND c -> 'meters' ? p_meter AND c ->> 'mandateAction' IS DISTINCT FROM 'introduce')
$$;
CREATE FUNCTION trustwork.billing_meter_stop_raise(p_decision jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_decision ->> 'decision' = 'stopped' THEN
    RAISE EXCEPTION 'quota reached: %', p_decision ->> 'reason' USING ERRCODE = '23514', HINT = 'billing.quota_reached', DETAIL = p_decision ->> 'reason';
  END IF;
END $$;

-- agent_actions: admitted when an intent is queued, counted on final success only. Failed and revoked actions are free,
-- and `outcome_unknown` is charged only if reconciliation ends in `succeeded`, because that is the transition below.
CREATE FUNCTION trustwork.billing_meter_intent_queued() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_hub uuid; m trustwork.mandate%ROWTYPE; v_project uuid;
BEGIN
  IF NEW.origin <> 'run' OR NEW.action = 'introduce' OR NOT trustwork.billing_meter_declared(NEW.capability_id, 'agent_actions') THEN RETURN NEW; END IF;
  SELECT hub_id INTO v_hub FROM trustwork.agent_intent_provenance WHERE action_intent_id = NEW.id;
  IF v_hub IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO m FROM trustwork.mandate WHERE id = NEW.mandate_id;
  -- The project the queue gave the action's own reservation, else the action's project context.
  SELECT r.project_id INTO v_project FROM trustwork.reservation r WHERE r.id = NEW.reservation_id;
  IF v_project IS NULL AND NEW.context_kind = 'project' AND NEW.context_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN v_project := NEW.context_id::uuid; END IF;
  PERFORM trustwork.billing_meter_stop_raise(trustwork.billing_meter_admit_core(jsonb_build_object('hubId', v_hub,
    'principal', CASE WHEN m.on_behalf_company_id IS NOT NULL THEN jsonb_build_object('kind', 'company', 'id', m.on_behalf_company_id) ELSE jsonb_build_object('kind', 'person', 'id', NEW.principal_person_id) END,
    'actingPersonId', NEW.principal_person_id, 'moduleKey', NEW.module_key, 'capabilityId', NEW.capability_id, 'runId', NEW.run_id, 'runStepId', NEW.id, 'attemptId', NEW.id, 'meter', 'agent_actions',
    'estimatedUnits', 1, 'budgetId', m.snapshot #>> '{limits,platformBudgetId}', 'mandateId', NEW.mandate_id, 'projectId', v_project, 'sourceKind', 'action_intent', 'sourceRef', NEW.id::text)));
  RETURN NEW;
END $$;
CREATE TRIGGER action_intent_metering_admit BEFORE UPDATE OF state ON trustwork.action_intent FOR EACH ROW
  WHEN (NEW.state = 'queued' AND OLD.state IS DISTINCT FROM 'queued') EXECUTE FUNCTION trustwork.billing_meter_intent_queued();

CREATE FUNCTION trustwork.billing_meter_intent_closed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_step uuid;
BEGIN
  SELECT id INTO v_step FROM trustwork.metered_step WHERE source_kind = 'action_intent' AND source_ref = NEW.id::text AND meter = 'agent_actions' AND state IN ('admitted', 'outcome_unknown');
  IF v_step IS NULL THEN RETURN NULL; END IF;
  PERFORM trustwork.billing_meter_finish_core(v_step, CASE NEW.state WHEN 'succeeded' THEN 'succeeded' WHEN 'outcome_unknown' THEN 'unknown' ELSE 'failed' END,
    CASE WHEN NEW.state = 'succeeded' THEN 1 END, NULL, NULL, 'action:' || NEW.id::text);
  RETURN NULL;
END $$;
CREATE TRIGGER action_intent_metering_close AFTER UPDATE OF state ON trustwork.action_intent FOR EACH ROW
  WHEN (NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('succeeded', 'failed', 'revoked', 'outcome_unknown')) EXECUTE FUNCTION trustwork.billing_meter_intent_closed();

-- model_tokens: admitted inside models_begin, so a refusal rolls back the mandate use and nothing is dispatched. The
-- participant's charge is the metered sale price; a priced call therefore carries no separate platform estimate.
CREATE FUNCTION trustwork.billing_meter_model_begin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r jsonb := NEW.request; m trustwork.mandate%ROWTYPE; v_step uuid; v_decision jsonb;
BEGIN
  IF NOT trustwork.billing_meter_declared(r ->> 'capabilityId', 'model_tokens') THEN RETURN NEW; END IF;
  SELECT * INTO m FROM trustwork.mandate WHERE id = (r ->> 'mandateId')::uuid;
  v_step := md5('model:' || NEW.operation_id)::uuid;
  v_decision := trustwork.billing_meter_admit_core(jsonb_build_object('hubId', r -> 'hubId',
    'principal', CASE WHEN m.on_behalf_company_id IS NOT NULL THEN jsonb_build_object('kind', 'company', 'id', m.on_behalf_company_id) ELSE jsonb_build_object('kind', 'person', 'id', NEW.principal_id) END,
    'actingPersonId', NEW.principal_id, 'moduleKey', r -> 'moduleKey', 'capabilityId', r -> 'capabilityId', 'runId', NEW.run_id, 'runStepId', v_step, 'attemptId', v_step, 'meter', 'model_tokens',
    'modelKey', lower(NEW.candidate ->> 'modelId'), 'estimatedUnits', (r ->> 'maxInputTokens')::bigint + (r ->> 'maxOutputTokens')::bigint, 'estimatedInputUnits', r -> 'maxInputTokens',
    'estimatedOutputUnits', r -> 'maxOutputTokens', 'budgetId', m.snapshot #>> '{limits,platformBudgetId}', 'mandateId', m.id,
    'projectId', CASE WHEN NEW.binding #>> '{context,kind}' = 'project' THEN NEW.binding #>> '{context,id}' END, 'sourceKind', 'model_call', 'sourceRef', NEW.operation_id));
  PERFORM trustwork.billing_meter_stop_raise(v_decision);
  IF (v_decision ->> 'priced')::boolean AND (r #>> '{estimatedCost,minorUnits}')::bigint > 0 THEN
    RAISE EXCEPTION 'a priced model call carries no separate platform estimate' USING ERRCODE = '23514', HINT = 'billing.priced_twice';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_call_metering_admit BEFORE INSERT ON trustwork.model_call FOR EACH ROW EXECUTE FUNCTION trustwork.billing_meter_model_begin();

CREATE FUNCTION trustwork.billing_meter_model_closed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_step uuid; v_in bigint := (NEW.metadata ->> 'inputTokens')::bigint; v_out bigint := (NEW.metadata ->> 'outputTokens')::bigint;
BEGIN
  SELECT id INTO v_step FROM trustwork.metered_step WHERE source_kind = 'model_call' AND source_ref = NEW.operation_id AND state IN ('admitted', 'outcome_unknown');
  IF v_step IS NULL THEN RETURN NULL; END IF;
  PERFORM trustwork.billing_meter_finish_core(v_step, CASE WHEN NEW.state = 'succeeded' THEN 'succeeded' ELSE 'failed' END, CASE WHEN NEW.state = 'succeeded' THEN v_in + v_out END,
    v_in, v_out, 'model:' || NEW.operation_id);
  RETURN NULL;
END $$;
CREATE TRIGGER model_call_metering_close AFTER UPDATE OF state ON trustwork.model_call FOR EACH ROW
  WHEN (OLD.state = 'outcome_unknown' AND NEW.state <> 'outcome_unknown') EXECUTE FUNCTION trustwork.billing_meter_model_closed();

-- 3. Entry points ----------------------------------------------------------------------------------------------------

-- The caller acts for themself or for their active employer; a run of someone else is unknown.
CREATE FUNCTION trustwork.billing_meter_require_caller(p jsonb) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE v_person uuid := trustwork.current_person_id();
BEGIN
  IF v_person IS NULL THEN RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal'; END IF;
  IF NOT ((p #>> '{principal,kind}' = 'person' AND (p #>> '{principal,id}')::uuid = v_person)
       OR (p #>> '{principal,kind}' = 'company' AND (p #>> '{principal,id}')::uuid = trustwork.current_company_id())) THEN
    RAISE EXCEPTION 'unknown principal' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  RETURN v_person;
END $$;

-- For owning modules that meter a step themselves (`checks`, `document_pages`, `deliverables` and the like).
CREATE FUNCTION trustwork.billing_meter_admit(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid := trustwork.billing_meter_require_caller(p); v_run trustwork.run%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM trustwork.run r WHERE r.id = (p ->> 'runId')::uuid AND r.principal_person_id = v_person AND r.state NOT IN ('completed', 'failed', 'cancelled');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown active run' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.agent_engine_manifest m, jsonb_array_elements(m.document -> 'capabilities') c WHERE c ->> 'id' = p ->> 'capabilityId' AND c ->> 'mandateAction' = 'introduce') THEN
    RAISE EXCEPTION 'an introduction is never metered' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  RETURN trustwork.billing_meter_admit_core(p || jsonb_build_object('actingPersonId', v_person, 'sourceKind', 'direct', 'sourceRef', p ->> 'runStepId', 'mandateId', v_run.mandate_id));
END $$;
CREATE FUNCTION trustwork.billing_meter_finish(p_step uuid, p_result text, p_units bigint, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.metered_step WHERE id = p_step AND acting_person_id = trustwork.current_person_id() AND source_kind = 'direct') THEN
    RAISE EXCEPTION 'unknown step' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  RETURN trustwork.billing_meter_finish_core(p_step, p_result, p_units, NULL, NULL, p_evidence);
END $$;
-- Read-only: what a step would cost now and whether it would stop. This is the estimate shown before a run.
CREATE FUNCTION trustwork.billing_meter_estimate(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_caller uuid := trustwork.billing_meter_require_caller(p); v_currency text; v_account uuid; v_person uuid := trustwork.billing_meter_person(p); v_company uuid := trustwork.billing_meter_company(p);
BEGIN
  -- A mandate's ceilings are read only for the person who holds it, on behalf of the principal it names.
  IF (p ->> 'mandateId') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.mandate m WHERE m.id = (p ->> 'mandateId')::uuid AND m.principal_person_id = v_caller AND m.on_behalf_company_id IS NOT DISTINCT FROM v_company) THEN
    RAISE EXCEPTION 'unknown mandate' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  IF (p ->> 'budgetId') IS NOT NULL AND NOT trustwork.billing_budget_spendable((p ->> 'budgetId')::uuid, 'platform') THEN
    RAISE EXCEPTION 'unknown budget' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  SELECT h.currency INTO v_currency FROM trustwork.hub_profile h WHERE h.hub_id = (p ->> 'hubId')::uuid;
  IF v_currency IS NULL THEN RAISE EXCEPTION 'hub unavailable' USING ERRCODE = '42501', HINT = 'access.not_found'; END IF;
  SELECT a.id INTO v_account FROM trustwork.billing_account a WHERE a.hub_id = (p ->> 'hubId')::uuid AND a.currency = v_currency AND a.status = 'active'
    AND a.owner_person_id IS NOT DISTINCT FROM v_person AND a.owner_company_id IS NOT DISTINCT FROM v_company;
  RETURN trustwork.billing_meter_quote(p, v_account, v_currency) - ARRAY['planVersionId', 'priceVersionId', 'outputPriceVersionId'];
END $$;
-- Why an action of this mandate would stop at its quota now, or NULL. Read-only: the person is asked instead of the
-- action failing in the queue, and the queue rechecks under the window lock. The principal comes from the caller's own
-- mandate, as it does at the queue: nothing the caller passes names a company, and another person's mandate is unknown.
CREATE FUNCTION trustwork.billing_meter_action_stop(p_hub uuid, p_module text, p_capability text, p_mandate uuid, p_project uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid := trustwork.current_person_id(); v_company uuid; v_currency text; v_account uuid; v_budget text;
BEGIN
  IF v_person IS NULL OR NOT trustwork.billing_meter_declared(p_capability, 'agent_actions') THEN RETURN NULL; END IF;
  SELECT m.on_behalf_company_id, m.snapshot #>> '{limits,platformBudgetId}' INTO v_company, v_budget FROM trustwork.mandate m WHERE m.id = p_mandate AND m.principal_person_id = v_person;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown mandate' USING ERRCODE = '42501', HINT = 'access.not_found'; END IF;
  IF v_budget IS NOT NULL AND NOT trustwork.billing_budget_spendable(v_budget::uuid, 'platform') THEN v_budget := NULL; END IF;
  SELECT h.currency INTO v_currency FROM trustwork.hub_profile h WHERE h.hub_id = p_hub;
  SELECT a.id INTO v_account FROM trustwork.billing_account a WHERE a.hub_id = p_hub AND a.currency = v_currency AND a.status = 'active'
    AND a.owner_person_id IS NOT DISTINCT FROM CASE WHEN v_company IS NULL THEN v_person END AND a.owner_company_id IS NOT DISTINCT FROM v_company;
  RETURN trustwork.billing_meter_quote(jsonb_build_object('hubId', p_hub, 'principal', CASE WHEN v_company IS NOT NULL THEN jsonb_build_object('kind', 'company', 'id', v_company) ELSE jsonb_build_object('kind', 'person', 'id', v_person) END,
    'moduleKey', p_module, 'capabilityId', p_capability, 'meter', 'agent_actions', 'estimatedUnits', 1, 'budgetId', v_budget, 'mandateId', p_mandate, 'projectId', p_project), v_account, v_currency) ->> 'stop';
END $$;
-- The plan key for the entitlement port. Own plan, or the active employer's when acting for it.
CREATE FUNCTION trustwork.billing_agent_plan_key(p_hub uuid, p_company uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid := trustwork.current_person_id(); v_key text;
BEGIN
  IF v_person IS NULL OR p_hub IS NULL OR (p_company IS NOT NULL AND p_company IS DISTINCT FROM trustwork.current_company_id()) THEN RETURN NULL; END IF;
  SELECT plan_key INTO v_key FROM trustwork.billing_meter_plan(p_hub, CASE WHEN p_company IS NULL THEN v_person END, p_company);
  RETURN v_key;
END $$;

-- Whether the plan decides against this module for the caller. Everything a hub does not sell stays available, and so
-- does everything with a free quota: a plan can add a module, never take the free floor away.
CREATE FUNCTION trustwork.billing_agent_module_allowed(p_hub uuid, p_company uuid, p_module text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid := trustwork.current_person_id(); v_plan record;
BEGIN
  IF v_person IS NULL OR p_hub IS NULL OR (p_company IS NOT NULL AND p_company IS DISTINCT FROM trustwork.current_company_id()) THEN RETURN false; END IF;
  SELECT * INTO v_plan FROM trustwork.billing_meter_plan(p_hub, CASE WHEN p_company IS NULL THEN v_person END, p_company);
  IF coalesce(v_plan.payload -> 'moduleKeys' ? p_module, false) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM trustwork.billing_meter_free_modules(p_hub) f WHERE f.module_key = p_module) THEN RETURN true; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM trustwork.subscription_plan_version v JOIN trustwork.offer o ON o.id = v.offer_id
    WHERE o.hub_id = p_hub AND o.status = 'active' AND v.status = 'active' AND v.payload -> 'moduleKeys' ? p_module);
END $$;

-- A direct step with no outcome lost its lease: it becomes unknown and keeps its holds, and only a final outcome closes it.
-- Steps bound to a model call or an action follow that source through its own transaction, so a healthy pending action
-- is never parked here.
CREATE FUNCTION trustwork.billing_meter_sweep(p_older_than interval, p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_count integer;
BEGIN
  WITH due AS (SELECT id FROM trustwork.metered_step WHERE state = 'admitted' AND source_kind = 'direct' AND created_at < clock_timestamp() - p_older_than ORDER BY created_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE trustwork.metered_step s SET state = 'outcome_unknown', evidence_ref = 'sweep:lease_expired' FROM due WHERE s.id = due.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
-- Staff close a direct step from evidence. Steps bound to a model call or an action close only through that outcome.
CREATE FUNCTION trustwork.billing_meter_reconcile(p_ctx jsonb, p_hub uuid, p_step uuid, p_result text, p_units bigint, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; s trustwork.metered_step%ROWTYPE; v_result jsonb;
BEGIN
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.assistant.reconcile'], NULL, p_hub);
  SELECT * INTO s FROM trustwork.metered_step WHERE id = p_step AND hub_id = p_hub;
  IF NOT FOUND THEN RAISE EXCEPTION 'step unavailable' USING ERRCODE = 'P0002', HINT = 'admin.not_found'; END IF;
  IF s.source_kind <> 'direct' OR s.state <> 'outcome_unknown' OR p_result NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'this step reconciles through its own outcome' USING ERRCODE = '23514', HINT = 'billing.invalid_transition';
  END IF;
  v_result := trustwork.billing_meter_finish_core(p_step, p_result, p_units, NULL, NULL, p_evidence);
  PERFORM trustwork.admin_record(a, p_ctx, NULL, p_hub, 'billing.metered_step_reconciled', 'metered_step', p_step, NULL, jsonb_build_object('state', p_result));
  RETURN v_result;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_meter_admit(jsonb), trustwork.billing_meter_finish(uuid, text, bigint, text), trustwork.billing_meter_estimate(jsonb),
  trustwork.billing_agent_plan_key(uuid, uuid), trustwork.billing_agent_module_allowed(uuid, uuid, text), trustwork.billing_meter_action_stop(uuid, text, text, uuid, uuid), trustwork.billing_meter_reconcile(jsonb, uuid, uuid, text, bigint, text) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.billing_meter_sweep(interval, integer) TO trustwork_worker;
