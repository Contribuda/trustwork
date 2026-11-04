-- AGT-004: usage statistics without surveillance, and abuse signals that end in a person's decision.
--
-- Statistics cover closed calendar months only. There is no date range, person, company or free filter. A module or plan
-- row with fewer than ten active principals is left out entirely, because a cost for three principals is itself
-- revealing; inside a row every participant count under ten is null. `outcomeUnknown` is an exact integer in the frozen
-- contract and cannot be null, so a row where it falls between 1 and 9 is withheld whole, like a small cohort: it is never
-- rounded and never reported as 0.
--
-- Complementary suppression: the module rows and the plan rows of a month add up to the same total, so one withheld row
-- could be recovered by subtraction. Within each dimension, further rows are withheld, smallest first, until everything
-- withheld together covers at least ten distinct principals.
--
-- What remains possible: a closed month is not frozen, because a step can close after the month ends, so two reads of one
-- month can differ by what such late steps add. That shows that some step closed, and its amount if it was the only one,
-- never whose it was: the rows still describe at least ten principals.
--
-- A signal is a count about one principal, never content. It opens no sanction and throttles nothing: a staff member
-- opens the moderation case, whose ladder and appeals apply. The list staff read carries no identity; the subject reaches
-- the case only when a person decides to open one.
CREATE TABLE trustwork.agent_abuse_signal (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  principal_person_id uuid NULL REFERENCES trustwork.person (id),
  principal_company_id uuid NULL REFERENCES trustwork.company (id),
  kind text NOT NULL CHECK (kind IN ('rate_above_limit', 'outreach_declines', 'injection_attempts', 'confirmation_spam', 'unknown_outcomes')),
  week_start timestamptz NOT NULL,
  observed integer NOT NULL CHECK (observed >= 1),
  threshold integer NOT NULL CHECK (threshold >= 1),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'case_opened')),
  moderation_case_id uuid NULL REFERENCES trustwork.moderation_case (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_abuse_signal_principal_xor CHECK ((principal_person_id IS NULL) <> (principal_company_id IS NULL)),
  CONSTRAINT agent_abuse_signal_case CHECK ((status = 'case_opened') = (moderation_case_id IS NOT NULL))
);
CREATE UNIQUE INDEX agent_abuse_signal_identity ON trustwork.agent_abuse_signal (hub_id, coalesce(principal_person_id, principal_company_id), kind, week_start);
ALTER TABLE trustwork.agent_abuse_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_abuse_signal FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.agent_abuse_signal AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- No runtime read policy: neither the principal nor staff reach this table except through the commands below.

CREATE FUNCTION trustwork.billing_cohort_count(p_count bigint) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE WHEN p_count >= 10 THEN p_count::integer END
$$;

-- The month's steps with the two dimensions statistics report on.
CREATE FUNCTION trustwork.billing_stats_steps(p_hub uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (module_key text, plan_key text, principal uuid, run_id uuid, meter text, state text, charged_minor bigint, cost_micro bigint)
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT s.module_key, coalesce(o.code, 'free'), coalesce(s.principal_person_id, s.principal_company_id), s.run_id, s.meter, s.state, s.charged_minor, s.cost_micro
  FROM trustwork.metered_step s LEFT JOIN trustwork.subscription_plan_version v ON v.id = s.plan_version_id LEFT JOIN trustwork.offer o ON o.id = v.offer_id
  WHERE s.hub_id = p_hub AND s.created_at >= p_from AND s.created_at < p_to
$$;
-- Adds rows to a withheld set, smallest first, until the set covers at least ten distinct principals. The union is what
-- subtraction reveals, and one person can appear in several rows, so the rows' own sizes cannot simply be added.
CREATE FUNCTION trustwork.billing_stats_complement(p_hub uuid, p_from timestamptz, p_to timestamptz, p_plan boolean, p_withheld text[], p_published text[]) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE v_withheld text[] := p_withheld; v_rest text[] := p_published; v_covered bigint;
BEGIN
  IF coalesce(cardinality(v_withheld), 0) = 0 THEN RETURN '{}'; END IF;
  LOOP
    SELECT count(DISTINCT x.principal) INTO v_covered FROM trustwork.billing_stats_steps(p_hub, p_from, p_to) x
    WHERE CASE WHEN p_plan THEN x.plan_key ELSE x.module_key END = ANY (v_withheld);
    EXIT WHEN v_covered >= 10 OR coalesce(cardinality(v_rest), 0) = 0;
    v_withheld := v_withheld || v_rest[1];
    v_rest := v_rest[2:];
  END LOOP;
  RETURN v_withheld;
END $$;

-- One closed calendar month, per module and per plan cohort.
CREATE FUNCTION trustwork.billing_agent_usage_stats(p_ctx jsonb, p_hub uuid, p_period text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  a trustwork.admin_actor;
  v_from timestamptz;
  v_to timestamptz;
  v_currency text;
  v_modules jsonb;
  v_cohorts jsonb;
  v_hidden text[];
  v_shown text[];
BEGIN
  PERFORM trustwork.hubs_require_hub(p_hub);
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.usage.read'], NULL, p_hub);
  IF coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'a period is one calendar month' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  v_from := (p_period || '-01T00:00:00Z')::timestamptz;
  v_to := v_from + interval '1 month';
  -- An open month grows between two reads, so comparing them would isolate one person's newest step.
  IF v_to > trustwork.billing_meter_window_start('month', clock_timestamp()) THEN
    RAISE EXCEPTION 'only a closed month is reported' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  SELECT currency INTO v_currency FROM trustwork.hub_profile WHERE hub_id = p_hub;

  SELECT coalesce(array_agg(g.k ORDER BY g.principals, g.k) FILTER (WHERE g.principals < 10 OR g.unknown BETWEEN 1 AND 9), '{}'),
         coalesce(array_agg(g.k ORDER BY g.principals, g.k) FILTER (WHERE NOT (g.principals < 10 OR g.unknown BETWEEN 1 AND 9)), '{}')
  INTO v_hidden, v_shown FROM (
    SELECT x.module_key AS k, count(DISTINCT x.principal) AS principals, count(*) FILTER (WHERE x.state = 'outcome_unknown') AS unknown
    FROM trustwork.billing_stats_steps(p_hub, v_from, v_to) x GROUP BY 1) g;
  v_hidden := trustwork.billing_stats_complement(p_hub, v_from, v_to, false, v_hidden, v_shown);
  WITH escalated AS (
    SELECT i.module_key, count(*) AS n FROM trustwork.action_intent i JOIN trustwork.agent_intent_provenance v ON v.action_intent_id = i.id
    WHERE v.hub_id = p_hub AND i.created_at >= v_from AND i.created_at < v_to AND cardinality(i.ask_reasons) > 0 GROUP BY i.module_key
  ), grouped AS (
    SELECT x.module_key, count(DISTINCT x.principal) AS principals, count(DISTINCT x.run_id) AS runs,
      count(*) FILTER (WHERE x.meter = 'agent_actions' AND x.state = 'succeeded') AS succeeded, count(*) FILTER (WHERE x.state = 'outcome_unknown') AS unknown,
      coalesce(sum(x.cost_micro), 0)::bigint AS cost, coalesce(sum(x.charged_minor), 0)::bigint AS revenue
    FROM trustwork.billing_stats_steps(p_hub, v_from, v_to) x GROUP BY 1
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('hubId', p_hub, 'from', trustwork.billing_iso(v_from), 'to', trustwork.billing_iso(v_to), 'moduleKey', r.module_key,
      'activePrincipals', trustwork.billing_cohort_count(r.principals), 'runs', trustwork.billing_cohort_count(r.runs), 'actionsSucceeded', trustwork.billing_cohort_count(r.succeeded),
      'actionsEscalatedToHumans', trustwork.billing_cohort_count(coalesce(e.n, 0)), 'outcomeUnknown', r.unknown,
      'cost', jsonb_build_object('minorUnits', trustwork.billing_micro_to_minor(r.cost)::text, 'currency', v_currency), 'revenue', jsonb_build_object('minorUnits', r.revenue::text, 'currency', v_currency)) ORDER BY r.module_key), '[]'::jsonb)
  INTO v_modules FROM grouped r LEFT JOIN escalated e ON e.module_key = r.module_key WHERE NOT r.module_key = ANY (v_hidden);

  SELECT coalesce(array_agg(g.k ORDER BY g.principals, g.k) FILTER (WHERE g.principals < 10), '{}'), coalesce(array_agg(g.k ORDER BY g.principals, g.k) FILTER (WHERE g.principals >= 10), '{}')
  INTO v_hidden, v_shown FROM (SELECT x.plan_key AS k, count(DISTINCT x.principal) AS principals FROM trustwork.billing_stats_steps(p_hub, v_from, v_to) x GROUP BY 1) g;
  v_hidden := trustwork.billing_stats_complement(p_hub, v_from, v_to, true, v_hidden, v_shown);
  WITH grouped AS (
    SELECT x.plan_key, count(DISTINCT x.principal) AS principals, count(DISTINCT x.run_id) AS runs, coalesce(sum(x.cost_micro), 0)::bigint AS cost, coalesce(sum(x.charged_minor), 0)::bigint AS revenue
    FROM trustwork.billing_stats_steps(p_hub, v_from, v_to) x GROUP BY 1
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('segment', 'plan', 'key', r.plan_key, 'activePrincipals', trustwork.billing_cohort_count(r.principals), 'runs', trustwork.billing_cohort_count(r.runs),
      'cost', jsonb_build_object('minorUnits', trustwork.billing_micro_to_minor(r.cost)::text, 'currency', v_currency), 'revenue', jsonb_build_object('minorUnits', r.revenue::text, 'currency', v_currency)) ORDER BY r.plan_key), '[]'::jsonb)
  INTO v_cohorts FROM grouped r WHERE NOT r.plan_key = ANY (v_hidden);
  RETURN jsonb_build_object('period', p_period, 'modules', v_modules, 'cohorts', v_cohorts);
END $$;

-- Worker: principals whose truly unknown outcomes this week reached the threshold. A count, never content; it changes
-- nothing about what the principal may do. A step counts only past its deadline, and only if the cause could be theirs:
-- `lease_expired` and `crash` are infrastructure, so a worker outage raises no signal about anyone.
CREATE FUNCTION trustwork.billing_abuse_sweep(p_threshold integer, p_deadline interval) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_week timestamptz := trustwork.billing_meter_window_start('week', clock_timestamp()); v_count integer;
BEGIN
  INSERT INTO trustwork.agent_abuse_signal (hub_id, principal_person_id, principal_company_id, kind, week_start, observed, threshold)
  SELECT s.hub_id, s.principal_person_id, s.principal_company_id, 'unknown_outcomes', v_week, count(*), p_threshold
  FROM trustwork.metered_step s
  WHERE s.state = 'outcome_unknown' AND s.created_at >= v_week AND s.created_at <= clock_timestamp() - p_deadline
    AND CASE s.source_kind
      WHEN 'direct' THEN s.evidence_ref IS DISTINCT FROM 'sweep:lease_expired'
      WHEN 'action_intent' THEN EXISTS (SELECT 1 FROM trustwork.action_intent i WHERE i.id::text = s.source_ref AND i.state IN ('outcome_unknown', 'reconciling')
        AND (SELECT o.reason FROM trustwork.action_outcome o WHERE o.action_intent_id = i.id AND o.kind = 'unknown' ORDER BY o.observed_at DESC, o.id DESC LIMIT 1) IN ('timeout', 'ambiguous_response'))
      ELSE false END
  GROUP BY s.hub_id, s.principal_person_id, s.principal_company_id HAVING count(*) >= p_threshold
  ON CONFLICT (hub_id, coalesce(principal_person_id, principal_company_id), kind, week_start)
  DO UPDATE SET observed = EXCLUDED.observed, updated_at = clock_timestamp();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- What staff read: kind, count and status. No principal, because a signal is not yet anybody's case.
CREATE FUNCTION trustwork.billing_abuse_list(p_ctx jsonb, p_hub uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; v_rows jsonb;
BEGIN
  a := trustwork.admin_authorize(p_ctx, ARRAY['admin.moderation.read', 'admin.moderation.case.open'], NULL, p_hub);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'weekStart', trustwork.billing_iso(s.week_start), 'observed', s.observed, 'threshold', s.threshold, 'status', s.status,
    'moderationCaseId', s.moderation_case_id) ORDER BY s.week_start DESC, s.id), '[]'::jsonb) INTO v_rows FROM trustwork.agent_abuse_signal s WHERE s.hub_id = p_hub;
  RETURN v_rows;
END $$;

-- A person opens the case. The moderation command checks elevation, permission and conflict of interest, and audits.
CREATE FUNCTION trustwork.billing_abuse_open_case(p_ctx jsonb, p_hub uuid, p_signal uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE s trustwork.agent_abuse_signal%ROWTYPE; c trustwork.moderation_case%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_authorize(p_ctx, ARRAY['admin.moderation.case.open'], NULL, p_hub);
  SELECT * INTO s FROM trustwork.agent_abuse_signal WHERE id = p_signal AND hub_id = p_hub FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'signal unavailable' USING ERRCODE = 'P0002', HINT = 'admin.not_found'; END IF;
  IF s.status <> 'open' THEN RAISE EXCEPTION 'a case is already open' USING ERRCODE = '23514', HINT = 'billing.invalid_transition'; END IF;
  c := trustwork.admin_open_moderation_case(p_ctx, p_hub, 'agent_abuse_signal', s.id, s.principal_person_id, s.principal_company_id, '{}'::uuid[], ARRAY['agent.abuse.' || s.kind], false);
  UPDATE trustwork.agent_abuse_signal SET status = 'case_opened', moderation_case_id = c.id, updated_at = clock_timestamp() WHERE id = s.id;
  RETURN jsonb_build_object('id', s.id, 'moderationCaseId', c.id);
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_agent_usage_stats(jsonb, uuid, text), trustwork.billing_abuse_list(jsonb, uuid), trustwork.billing_abuse_open_case(jsonb, uuid, uuid) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.billing_abuse_sweep(integer, interval) TO trustwork_worker;
