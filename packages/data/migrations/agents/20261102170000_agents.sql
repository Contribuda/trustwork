-- AGT-001: agent goals, job subscriptions, agent reports, agent-to-agent envelopes, negotiation sessions, the company
-- representative and company mandates (docs/engine/agents.md, docs/data/model.md section 21, ADR 010 decisions 4, 9
-- and 23, ADR 012 decision 32). Builds on AST-001 (packages/data/migrations/assistant): the mandate store, the
-- first-party confirmation (`assistant_confirm_mandate`), narrowing (`assistant_apply_narrowing`), the authority-basis
-- revocation (`assistant_revoke_for_basis`) and the kill-switch check (`assistant_dispatch_blocked`) are reused, never
-- copied.
--
-- Authority rules carried by this file, for every role including the owner-run commands:
--   * a goal never widens authority: it is born `proposed`; it becomes active only through `agents_confirm_goal`,
--     called by its principal inside the same transaction that confirms the goal's mandate proposals on the
--     first-party form, and only for the exact digest the principal was shown;
--   * a company mandate exists only for a mandate its principal confirmed on the first-party form for their active
--     employer while holding `company.deals.manage`; the executor is a colleague's one agent or the company's one
--     representative; a re-confirmation repeats the identical terms (digest) and never widens them;
--   * losing a membership stops dependent authority in the same transaction (trigger on `membership`): the person's
--     company mandates (AST-001), the colleague mandates they execute, the company mandates they granted (which wait for
--     re-confirmation by another authorized member for 7 days and then suspend) and their role as accountable person;
--   * an envelope moves state only through its structured intent and digest-pinned references after the receiver's
--     own mandate check; the note is stored as untrusted text and never parsed; refs must name exact published versions
--     between the two parties of the context, so a buyer's agent cannot relay one seller's quote to another seller;
--   * private constraints (floors, ceilings, cost bases, goal budget ranges) and competitors' prices never enter an
--     envelope: a note that repeats one of the sender's private amounts or a competing seller's price is refused; the
--     receiver's mandate decision and the sender's mandate reference live in party-private tables;
--   * negotiation sessions have a round limit and an expiry; deadlock, expiry and agreement escalate to humans;
--   * every agent dispatch here checks the hub and node kill switches (`assistant_dispatch_blocked`).
--
-- Privacy: every table is under FORCE RLS. Envelopes and sessions are readable by the two parties of the context only
-- (a company party through members holding `company.deals.manage`); receipts, escalations and the sender's mandate
-- reference only by their own party; goals, progress, job subscriptions and reports only by their principal (reports
-- also by colleagues the principal shared them with).

-- 0. Helpers (owner-run, never granted) ------------------------------------------------------------------------------
CREATE FUNCTION trustwork.agents_member_authority(p_person_id uuid, p_company_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_person_id IS NOT NULL AND p_company_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.membership m WHERE m.person_id = p_person_id AND m.company_id = p_company_id AND m.status = 'active'
      AND m.valid_from <= now() AND 'company.deals.manage' = ANY (m.permissions))
$$;
CREATE FUNCTION trustwork.agents_member_admin(p_person_id uuid, p_company_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_person_id IS NOT NULL AND p_company_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.membership m WHERE m.person_id = p_person_id AND m.company_id = p_company_id AND m.status = 'active'
      AND m.valid_from <= now() AND m.role = 'administrator')
$$;
CREATE FUNCTION trustwork.agents_member_active(p_person_id uuid, p_company_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_person_id IS NOT NULL AND p_company_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.membership m WHERE m.person_id = p_person_id AND m.company_id = p_company_id AND m.status = 'active' AND m.valid_from <= now())
$$;

-- Whether an untrusted note repeats one of the given amounts (minor units as decimal strings). Digit groups written with
-- separators (`12,500.00`, `12 500`) are compared without them, against the minor units and, for whole amounts, the
-- major units. Amounts below three digits are ignored (too many false positives); this is defence in depth next to the
-- rule that envelopes carry only digest-pinned references and never constraint fields.
CREATE FUNCTION trustwork.agents_note_leaks(p_note text, p_amounts text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  WITH runs AS (
    SELECT regexp_replace(m[1], '\D', '', 'g') AS digits FROM regexp_matches(coalesce(p_note, ''), '(\d(?:[\d,.''_ ]*\d)?)', 'g') AS m
  ), forms AS (
    SELECT a AS form FROM unnest(coalesce(p_amounts, ARRAY[]::text[])) AS a WHERE a ~ '^\d{3,}$'
    UNION SELECT left(a, length(a) - 2) FROM unnest(coalesce(p_amounts, ARRAY[]::text[])) AS a WHERE a ~ '^\d{5,}$' AND right(a, 2) = '00'
  )
  SELECT EXISTS (SELECT 1 FROM runs r JOIN forms f ON ltrim(r.digits, '0') = ltrim(f.form, '0') AND length(ltrim(f.form, '0')) >= 3)
$$;

-- The mandate action the sender of an envelope needs, and what the receiver's agent would need to act on it.
CREATE FUNCTION trustwork.agents_intent_action(p_intent text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE p_intent
    WHEN 'propose' THEN 'negotiate' WHEN 'counter' THEN 'negotiate' WHEN 'accept' THEN 'negotiate' WHEN 'withdraw' THEN 'negotiate'
    WHEN 'request_confirmation' THEN 'negotiate' WHEN 'schedule_meeting' THEN 'schedule' WHEN 'propose_slots' THEN 'schedule'
    WHEN 'introduce' THEN 'introduce' ELSE 'communicate' END
$$;
CREATE FUNCTION trustwork.agents_receiver_action(p_intent text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE p_intent
    WHEN 'propose' THEN 'negotiate' WHEN 'counter' THEN 'negotiate' WHEN 'request_proposal' THEN 'send_quote'
    WHEN 'clarify' THEN 'communicate' WHEN 'step_question' THEN 'communicate' WHEN 'express_interest' THEN 'communicate'
    WHEN 'schedule_meeting' THEN 'schedule' WHEN 'propose_slots' THEN 'schedule' WHEN 'introduce' THEN 'introduce'
    WHEN 'accept' THEN 'human' WHEN 'request_confirmation' THEN 'human' ELSE 'informational' END
$$;

-- Structural coverage of one action by one mandate (a deterministic, fail-closed subset of evaluateMandateV2 for checks
-- that run where the acting principal is not the mandate's principal): 'allow' when the mandate is active, valid,
-- covers a module key, the action and the exact context (or a selector of that kind without categories, regions or
-- project), and asks nothing (pre-authorized, no conditions, no approver rules); 'ask' when it covers but asks; 'no'.
CREATE FUNCTION trustwork.agents_mandate_covers(p_mandate trustwork.mandate, p_action text, p_module_keys text[], p_context_kind text, p_context_id text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_snapshot jsonb := p_mandate.snapshot;
BEGIN
  IF p_mandate.id IS NULL OR p_mandate.status <> 'active' OR p_mandate.valid_until <= clock_timestamp() OR NOT (p_action = ANY (p_mandate.actions))
     OR NOT (p_mandate.module_keys && p_module_keys) THEN
    RETURN 'no';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM trustwork.mandate_context c WHERE c.mandate_id = p_mandate.id AND c.context_kind = p_context_kind
      AND (c.context_id = p_context_id OR (c.context_id IS NULL AND coalesce(jsonb_array_length(c.selector -> 'categories'), 0) = 0
        AND coalesce(jsonb_array_length(c.selector -> 'regions'), 0) = 0 AND jsonb_typeof(c.selector -> 'projectId') IS DISTINCT FROM 'string'))) THEN
    RETURN 'no';
  END IF;
  IF p_action IN ('confirm_execution', 'approve') OR (v_snapshot -> 'approvalPolicy' ->> 'mode') IS DISTINCT FROM 'pre_authorized'
     OR coalesce(jsonb_array_length(v_snapshot -> 'conditions'), 0) > 0 OR coalesce(jsonb_array_length(v_snapshot -> 'approvers'), 0) > 0 THEN
    RETURN 'ask';
  END IF;
  RETURN 'allow';
END $$;

-- 1. Goals, progress, job subscriptions and reports --------------------------------------------------------------------
CREATE TABLE trustwork.goal (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  on_behalf_company_id uuid NULL REFERENCES trustwork.company (id),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  success_criteria jsonb NOT NULL CHECK (jsonb_typeof(success_criteria) = 'array' AND jsonb_array_length(success_criteria) BETWEEN 1 AND 20),
  allowed_actions text[] NOT NULL CHECK (allowed_actions <@ ARRAY['prepare', 'research', 'communicate', 'send_quote', 'negotiate', 'introduce', 'schedule', 'maintain_profile',
    'publish', 'record_evidence', 'maintain_records']::text[]),
  -- The structured needs (module, actions, contexts, window, approval policy) the goal was created with.
  needs jsonb NOT NULL CHECK (jsonb_typeof(needs) = 'array' AND jsonb_array_length(needs) <= 10),
  -- Owner-private: never in envelopes, shared views, search, notifications or exports.
  budget_range jsonb NULL CHECK (budget_range IS NULL OR jsonb_typeof(budget_range) = 'object'),
  horizon timestamptz NOT NULL,
  report_cadence text NOT NULL CHECK (report_cadence IN ('none', 'daily', 'weekly', 'monthly')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'paused', 'closed')),
  outcome text NULL CHECK (outcome IS NULL OR outcome IN ('achieved', 'partly', 'abandoned')),
  proposed_by text NOT NULL CHECK (proposed_by IN ('principal', 'agent', 'connection')),
  -- Mandates already covering a need, with the revision the confirmation digest bound, and the proposals it made.
  covered jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(covered) = 'array'),
  proposal_ids uuid[] NOT NULL DEFAULT '{}',
  mandate_ids uuid[] NOT NULL DEFAULT '{}',
  confirmation_digest text NOT NULL CHECK (confirmation_digest ~ '^[a-f0-9]{64}$'),
  confirmed_by_person_id uuid NULL REFERENCES trustwork.person (id),
  confirmed_at timestamptz NULL,
  confirmed_step_up boolean NULL,
  closed_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goal_confirmation_shape CHECK ((confirmed_at IS NULL) = (confirmed_by_person_id IS NULL) AND (confirmed_at IS NULL) = (confirmed_step_up IS NULL)),
  CONSTRAINT goal_confirmed_by_principal CHECK (confirmed_by_person_id IS NULL OR confirmed_by_person_id = principal_person_id),
  CONSTRAINT goal_active_confirmed CHECK (status NOT IN ('active', 'paused') OR confirmed_at IS NOT NULL),
  CONSTRAINT goal_proposed_unconfirmed CHECK (status <> 'proposed' OR confirmed_at IS NULL),
  CONSTRAINT goal_closed_shape CHECK ((status = 'closed') = (outcome IS NOT NULL) AND (status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX goal_principal_idx ON trustwork.goal (principal_person_id, status);
CREATE FUNCTION trustwork.agents_goal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'goals are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.confirmed_at IS NOT NULL OR cardinality(NEW.mandate_ids) <> 0 THEN
      RAISE EXCEPTION 'a goal is born proposed and confirmed only by its principal' USING ERRCODE = 'check_violation', HINT = 'goal.not_proposed';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.principal_person_id, NEW.on_behalf_company_id, NEW.text, NEW.success_criteria, NEW.allowed_actions, NEW.needs, NEW.budget_range, NEW.horizon,
         NEW.report_cadence, NEW.proposed_by, NEW.covered, NEW.proposal_ids, NEW.confirmation_digest, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.principal_person_id, OLD.on_behalf_company_id, OLD.text, OLD.success_criteria, OLD.allowed_actions, OLD.needs, OLD.budget_range, OLD.horizon,
         OLD.report_cadence, OLD.proposed_by, OLD.covered, OLD.proposal_ids, OLD.confirmation_digest, OLD.created_at) THEN
    RAISE EXCEPTION 'the terms of a goal never change; close it and create a new one' USING ERRCODE = 'integrity_constraint_violation', HINT = 'goal.immutable';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'a closed goal is final' USING ERRCODE = 'check_violation', HINT = 'goal.final';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'proposed' AND NEW.status IN ('active', 'closed')) OR (OLD.status = 'active' AND NEW.status IN ('paused', 'closed')) OR (OLD.status = 'paused' AND NEW.status IN ('active', 'closed'))) THEN
    RAISE EXCEPTION 'goal cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'goal.invalid_transition';
  END IF;
  IF NOT trustwork.in_maintenance() THEN
    RAISE EXCEPTION 'goals change only through their principal''s commands' USING ERRCODE = 'insufficient_privilege', HINT = 'goal.not_principal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goal_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.goal FOR EACH ROW EXECUTE FUNCTION trustwork.agents_goal_guard();
CREATE TRIGGER goal_touch BEFORE UPDATE ON trustwork.goal FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Evidence-backed progress log (append-only). `detail` is structured (codes, counts, references), never free text.
CREATE TABLE trustwork.goal_progress (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  goal_id uuid NOT NULL REFERENCES trustwork.goal (id),
  event_kind text NOT NULL CHECK (event_kind IN ('created', 'mandate_proposed', 'confirmed', 'mandate_confirmed', 'paused', 'resumed', 'closed', 'evidence', 'report', 'escalated')),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) <= 20),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  recorded_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX goal_progress_goal_idx ON trustwork.goal_progress (goal_id, at);
CREATE TRIGGER goal_progress_append_only BEFORE UPDATE OR DELETE ON trustwork.goal_progress FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- A trigger only starts a run; authority still comes from the mandate.
CREATE TABLE trustwork.job_subscription (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  on_behalf_company_id uuid NULL REFERENCES trustwork.company (id),
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  job_template_key text NOT NULL CHECK (job_template_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  trigger jsonb NOT NULL CHECK (jsonb_typeof(trigger) = 'object' AND trigger ->> 'kind' IN ('schedule', 'event', 'deadline', 'goal', 'request')),
  goal_id uuid NULL REFERENCES trustwork.goal (id),
  mandate_id uuid NULL REFERENCES trustwork.mandate (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_subscription_goal_trigger CHECK ((trigger ->> 'kind' = 'goal') = (goal_id IS NOT NULL) AND (goal_id IS NULL OR trigger ->> 'goalId' = goal_id::text))
);
CREATE INDEX job_subscription_principal_idx ON trustwork.job_subscription (principal_person_id, status);
CREATE FUNCTION trustwork.agents_job_subscription_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'job subscriptions are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.principal_person_id, NEW.on_behalf_company_id, NEW.module_key, NEW.job_template_key, NEW.trigger, NEW.goal_id, NEW.mandate_id, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.principal_person_id, OLD.on_behalf_company_id, OLD.module_key, OLD.job_template_key, OLD.trigger, OLD.goal_id, OLD.mandate_id, OLD.created_at) THEN
      RAISE EXCEPTION 'a job subscription keeps its trigger and mandate' USING ERRCODE = 'integrity_constraint_violation', HINT = 'agents.immutable';
    END IF;
    IF OLD.status = 'ended' AND NEW.status <> 'ended' THEN
      RAISE EXCEPTION 'an ended subscription is final' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'active' THEN
    RAISE EXCEPTION 'a subscription starts active' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
  END IF;
  -- Runs as the inserting principal: the mandate and the goal are visible only when they are the principal's own.
  IF NEW.mandate_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.mandate m WHERE m.id = NEW.mandate_id AND m.principal_person_id = NEW.principal_person_id AND m.status = 'active') THEN
    RAISE EXCEPTION 'a subscription names an active mandate of its principal' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF NEW.goal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.goal g WHERE g.id = NEW.goal_id AND g.principal_person_id = NEW.principal_person_id AND g.status IN ('active', 'paused')) THEN
    RAISE EXCEPTION 'a goal trigger names an active goal of its principal' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_subscription_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.job_subscription FOR EACH ROW EXECUTE FUNCTION trustwork.agents_job_subscription_guard();
CREATE TRIGGER job_subscription_touch BEFORE UPDATE ON trustwork.job_subscription FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- A report is a draft for its author; private unless shared with colleagues; never sent to counterparties.
CREATE TABLE trustwork.agent_report (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  author_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  principal_company_id uuid NULL REFERENCES trustwork.company (id),
  goal_id uuid NULL REFERENCES trustwork.goal (id),
  run_id uuid NULL REFERENCES trustwork.run (id),
  period_from timestamptz NOT NULL,
  period_to timestamptz NOT NULL,
  sections jsonb NOT NULL CHECK (jsonb_typeof(sections) = 'array' AND jsonb_array_length(sections) <= 30),
  audience text NOT NULL DEFAULT 'owner_private' CHECK (audience = 'owner_private'),
  shared_with uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(shared_with) <= 50),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_report_period CHECK (period_to > period_from)
);
CREATE INDEX agent_report_author_idx ON trustwork.agent_report (author_person_id, created_at DESC);
CREATE FUNCTION trustwork.agents_report_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reports are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF cardinality(NEW.shared_with) <> 0 THEN
      RAISE EXCEPTION 'a report is born private' USING ERRCODE = 'check_violation', HINT = 'agents.report_private';
    END IF;
    IF NEW.goal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.goal g WHERE g.id = NEW.goal_id AND g.principal_person_id = NEW.author_person_id) THEN
      RAISE EXCEPTION 'a report covers a goal of its author' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.author_person_id, NEW.principal_company_id, NEW.goal_id, NEW.run_id, NEW.period_from, NEW.period_to, NEW.sections, NEW.audience, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.author_person_id, OLD.principal_company_id, OLD.goal_id, OLD.run_id, OLD.period_from, OLD.period_to, OLD.sections, OLD.audience, OLD.created_at)
     OR NOT trustwork.in_maintenance() THEN
    RAISE EXCEPTION 'a report changes only by sharing it' USING ERRCODE = 'integrity_constraint_violation', HINT = 'agents.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_report_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.agent_report FOR EACH ROW EXECUTE FUNCTION trustwork.agents_report_guard();
CREATE TRIGGER agent_report_touch BEFORE UPDATE ON trustwork.agent_report FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 2. The company representative and company mandates ----------------------------------------------------------------
-- At most one per company (unique company_id); there is no list of representatives and no agent management screen.
CREATE TABLE trustwork.company_representative (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES trustwork.company (id),
  accountable_person_id uuid NULL REFERENCES trustwork.person (id),
  status text NOT NULL CHECK (status IN ('pending_acceptance', 'active', 'suspended', 'disabled')),
  suspension_reason text NULL CHECK (suspension_reason IS NULL OR suspension_reason IN ('no_accountable_person', 'no_confirmed_mandate', 'admin_suspended')),
  enabled_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  accepted_at timestamptz NULL,
  disabled_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_representative_suspension CHECK ((status = 'suspended') = (suspension_reason IS NOT NULL)),
  CONSTRAINT company_representative_active CHECK (status <> 'active' OR (accountable_person_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CONSTRAINT company_representative_pending CHECK (status <> 'pending_acceptance' OR accountable_person_id IS NOT NULL),
  CONSTRAINT company_representative_disabled CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
CREATE TRIGGER company_representative_touch BEFORE UPDATE ON trustwork.company_representative FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.agents_owner_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF NOT trustwork.in_maintenance() THEN
    RAISE EXCEPTION '% changes only through the agents commands', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege', HINT = 'agents.command_only';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER company_representative_owner_only BEFORE INSERT OR UPDATE OR DELETE ON trustwork.company_representative FOR EACH ROW EXECUTE FUNCTION trustwork.agents_owner_only();

-- Who was accountable when (append-only, except that an open row is closed once).
CREATE TABLE trustwork.representative_accountability (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  representative_id uuid NOT NULL REFERENCES trustwork.company_representative (id),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  from_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  to_at timestamptz NULL,
  ended_reason text NULL CHECK (ended_reason IS NULL OR ended_reason IN ('replaced', 'left_company', 'authority_lost', 'disabled')),
  CONSTRAINT representative_accountability_closed CHECK ((to_at IS NULL) = (ended_reason IS NULL))
);
CREATE UNIQUE INDEX representative_accountability_one_open ON trustwork.representative_accountability (representative_id) WHERE to_at IS NULL;
CREATE FUNCTION trustwork.agents_accountability_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (OLD.to_at IS NOT NULL OR ROW(NEW.id, NEW.representative_id, NEW.person_id, NEW.from_at) IS DISTINCT FROM ROW(OLD.id, OLD.representative_id, OLD.person_id, OLD.from_at))) THEN
    RAISE EXCEPTION 'accountability history is append-only' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF NOT trustwork.in_maintenance() THEN
    RAISE EXCEPTION 'accountability changes only through the agents commands' USING ERRCODE = 'insufficient_privilege', HINT = 'agents.command_only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER representative_accountability_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.representative_accountability FOR EACH ROW EXECUTE FUNCTION trustwork.agents_accountability_guard();

-- A company mandate: an AST-001 mandate whose grantee is a colleague's agent or the representative, granted by a member
-- holding company.deals.manage for the active employer. `terms` (visible to authorized members and the executor) is
-- the confirmed draft; `terms_digest` pins it so a re-confirmation repeats exactly the same terms.
CREATE TABLE trustwork.company_mandate (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  mandate_id uuid NOT NULL UNIQUE REFERENCES trustwork.mandate (id),
  granted_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  executor_kind text NOT NULL CHECK (executor_kind IN ('person_agent', 'company_representative')),
  executor_person_id uuid NULL REFERENCES trustwork.person (id),
  representative_id uuid NULL REFERENCES trustwork.company_representative (id),
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  terms_digest text NOT NULL CHECK (terms_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'awaiting_reconfirmation', 'suspended', 'revoked')),
  status_reason text NULL CHECK (status_reason IS NULL OR status_reason ~ '^[a-z][a-z_]{2,60}$'),
  reconfirm_due_at timestamptz NULL,
  reconfirmed_by_person_id uuid NULL REFERENCES trustwork.person (id),
  reconfirmed_at timestamptz NULL,
  previous_mandate_ids uuid[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_mandate_executor CHECK (CASE executor_kind WHEN 'person_agent' THEN executor_person_id IS NOT NULL AND representative_id IS NULL
    ELSE executor_person_id IS NULL AND representative_id IS NOT NULL END),
  CONSTRAINT company_mandate_reconfirmation CHECK ((status = 'awaiting_reconfirmation') = (reconfirm_due_at IS NOT NULL)),
  CONSTRAINT company_mandate_reconfirmed CHECK ((reconfirmed_at IS NULL) = (reconfirmed_by_person_id IS NULL))
);
CREATE INDEX company_mandate_company_idx ON trustwork.company_mandate (company_id, status);
CREATE INDEX company_mandate_executor_idx ON trustwork.company_mandate (executor_person_id) WHERE executor_person_id IS NOT NULL;
CREATE INDEX company_mandate_granter_idx ON trustwork.company_mandate (granted_by_person_id, status);
CREATE FUNCTION trustwork.agents_company_mandate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.company_id, NEW.executor_kind, NEW.executor_person_id, NEW.representative_id, NEW.terms, NEW.terms_digest, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.company_id, OLD.executor_kind, OLD.executor_person_id, OLD.representative_id, OLD.terms, OLD.terms_digest, OLD.created_at) THEN
      RAISE EXCEPTION 'a company mandate keeps its company, executor and terms' USING ERRCODE = 'integrity_constraint_violation', HINT = 'agents.immutable';
    END IF;
    IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
      RAISE EXCEPTION 'a revoked company mandate is final' USING ERRCODE = 'check_violation', HINT = 'mandate.final';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_mandate_guard BEFORE UPDATE ON trustwork.company_mandate FOR EACH ROW EXECUTE FUNCTION trustwork.agents_company_mandate_guard();
CREATE TRIGGER company_mandate_owner_only BEFORE INSERT OR UPDATE OR DELETE ON trustwork.company_mandate FOR EACH ROW EXECUTE FUNCTION trustwork.agents_owner_only();
CREATE TRIGGER company_mandate_touch BEFORE UPDATE ON trustwork.company_mandate FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 3. Negotiation sessions, envelopes, receipts and escalations ------------------------------------------------------
-- One live session per context and pair of parties; the round limit and the expiry are fixed when it opens.
CREATE TABLE trustwork.negotiation_session (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  context_kind text NOT NULL CHECK (context_kind IN ('rfq', 'quote')),
  context_id uuid NOT NULL,
  party_a_kind text NOT NULL CHECK (party_a_kind IN ('person', 'company')),
  party_a_id uuid NOT NULL,
  party_b_kind text NOT NULL CHECK (party_b_kind IN ('person', 'company')),
  party_b_id uuid NOT NULL,
  max_rounds integer NOT NULL CHECK (max_rounds BETWEEN 1 AND 20),
  rounds_used integer NOT NULL DEFAULT 0 CHECK (rounds_used >= 0),
  turn_kind text NULL CHECK (turn_kind IS NULL OR turn_kind IN ('person', 'company')),
  turn_id uuid NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'agreed_pending_confirmation', 'escalated', 'declined', 'withdrawn', 'expired')),
  escalation_reason text NULL CHECK (escalation_reason IS NULL OR escalation_reason IN ('rounds_exhausted', 'expired', 'agreement_needs_confirmation')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT negotiation_session_parties CHECK ((party_a_kind, party_a_id) IS DISTINCT FROM (party_b_kind, party_b_id)),
  CONSTRAINT negotiation_session_rounds CHECK (rounds_used <= max_rounds),
  CONSTRAINT negotiation_session_turn CHECK ((turn_kind IS NULL) = (turn_id IS NULL)),
  CONSTRAINT negotiation_session_escalation CHECK ((status IN ('escalated', 'agreed_pending_confirmation', 'expired')) = (escalation_reason IS NOT NULL))
);
CREATE UNIQUE INDEX negotiation_session_one_live ON trustwork.negotiation_session (context_kind, context_id,
  least(party_a_kind || ':' || party_a_id::text, party_b_kind || ':' || party_b_id::text), greatest(party_a_kind || ':' || party_a_id::text, party_b_kind || ':' || party_b_id::text))
  WHERE status = 'open';
CREATE INDEX negotiation_session_a_idx ON trustwork.negotiation_session (party_a_kind, party_a_id);
CREATE INDEX negotiation_session_b_idx ON trustwork.negotiation_session (party_b_kind, party_b_id);
CREATE INDEX negotiation_session_expiry_idx ON trustwork.negotiation_session (expires_at) WHERE status = 'open';
CREATE FUNCTION trustwork.agents_session_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.context_kind, NEW.context_id, NEW.party_a_kind, NEW.party_a_id, NEW.party_b_kind, NEW.party_b_id, NEW.max_rounds, NEW.expires_at, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.context_kind, OLD.context_id, OLD.party_a_kind, OLD.party_a_id, OLD.party_b_kind, OLD.party_b_id, OLD.max_rounds, OLD.expires_at, OLD.created_at) THEN
      RAISE EXCEPTION 'a session keeps its context, parties, round limit and expiry' USING ERRCODE = 'integrity_constraint_violation', HINT = 'agents.immutable';
    END IF;
    IF NEW.rounds_used < OLD.rounds_used THEN
      RAISE EXCEPTION 'rounds are never given back' USING ERRCODE = 'check_violation', HINT = 'negotiation.invalid_transition';
    END IF;
    IF OLD.status <> 'open' AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'a session that left open is final' USING ERRCODE = 'check_violation', HINT = 'negotiation.closed';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER negotiation_session_guard BEFORE UPDATE ON trustwork.negotiation_session FOR EACH ROW EXECUTE FUNCTION trustwork.agents_session_guard();
CREATE TRIGGER negotiation_session_owner_only BEFORE INSERT OR UPDATE OR DELETE ON trustwork.negotiation_session FOR EACH ROW EXECUTE FUNCTION trustwork.agents_owner_only();
CREATE TRIGGER negotiation_session_touch BEFORE UPDATE ON trustwork.negotiation_session FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- The shared envelope: only what both parties may see (AgentEnvelopeSchema without the sender's connection). The note
-- is untrusted text for the receiver; nothing reads it to decide anything.
CREATE TABLE trustwork.agent_envelope (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  session_id uuid NULL REFERENCES trustwork.negotiation_session (id),
  from_kind text NOT NULL CHECK (from_kind IN ('person', 'company')),
  from_id uuid NOT NULL,
  from_person_id uuid NULL REFERENCES trustwork.person (id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person_agent', 'company_representative')),
  actor_label_key text NOT NULL CHECK (actor_label_key ~ '^[a-z][A-Za-z0-9_.]{2,120}$'),
  accountable_person_id uuid NULL REFERENCES trustwork.person (id),
  to_kind text NOT NULL CHECK (to_kind IN ('person', 'company')),
  to_id uuid NOT NULL,
  context_kind text NOT NULL CHECK (context_kind IN ('rfq', 'quote')),
  context_id uuid NOT NULL,
  intent text NOT NULL CHECK (intent IN ('request_proposal', 'propose', 'counter', 'clarify', 'answer', 'accept', 'decline', 'withdraw', 'schedule_meeting', 'introduce',
    'propose_slots', 'request_confirmation', 'express_interest', 'step_question')),
  refs jsonb NOT NULL CHECK (jsonb_typeof(refs) = 'array' AND jsonb_array_length(refs) <= 50),
  note_text text NULL CHECK (note_text IS NULL OR length(note_text) <= 4000),
  note_locale text NULL CHECK (note_locale IS NULL OR note_locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  mandate_proof jsonb NOT NULL CHECK (jsonb_typeof(mandate_proof) = 'object' AND mandate_proof ->> 'algorithm' = 'hmac-sha256' AND mandate_proof ->> 'value' ~ '^[a-f0-9]{64}$'),
  home_node text NOT NULL CHECK (home_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT agent_envelope_parties CHECK ((from_kind, from_id) IS DISTINCT FROM (to_kind, to_id)),
  CONSTRAINT agent_envelope_representative CHECK (actor_kind <> 'company_representative' OR (from_kind = 'company' AND accountable_person_id IS NOT NULL)),
  CONSTRAINT agent_envelope_person_agent CHECK (actor_kind <> 'person_agent' OR from_person_id IS NOT NULL),
  CONSTRAINT agent_envelope_expiry CHECK (expires_at > created_at),
  CONSTRAINT agent_envelope_refs CHECK (intent NOT IN ('propose', 'counter', 'accept', 'withdraw', 'request_confirmation') OR jsonb_array_length(refs) > 0)
);
CREATE INDEX agent_envelope_pair_idx ON trustwork.agent_envelope (from_kind, from_id, to_kind, to_id, created_at);
CREATE INDEX agent_envelope_to_idx ON trustwork.agent_envelope (to_kind, to_id, created_at DESC);
CREATE INDEX agent_envelope_session_idx ON trustwork.agent_envelope (session_id) WHERE session_id IS NOT NULL;
CREATE TRIGGER agent_envelope_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_envelope FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER agent_envelope_owner_only BEFORE INSERT ON trustwork.agent_envelope FOR EACH ROW EXECUTE FUNCTION trustwork.agents_owner_only();

-- Sender-private: which mandate authorized the envelope. Never visible to the receiver.
CREATE TABLE trustwork.agent_envelope_sender (
  envelope_id uuid PRIMARY KEY REFERENCES trustwork.agent_envelope (id),
  sender_kind text NOT NULL CHECK (sender_kind IN ('person', 'company')),
  sender_id uuid NOT NULL,
  sent_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  mandate_id uuid NOT NULL REFERENCES trustwork.mandate (id),
  mandate_revision integer NOT NULL CHECK (mandate_revision >= 1),
  company_mandate_id uuid NULL REFERENCES trustwork.company_mandate (id)
);
CREATE TRIGGER agent_envelope_sender_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_envelope_sender FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER agent_envelope_sender_owner_only BEFORE INSERT ON trustwork.agent_envelope_sender FOR EACH ROW EXECUTE FUNCTION trustwork.agents_owner_only();

-- Receiver-private: the receiver's own mandate decision on the structured intent. Never visible to the sender (it would
-- reveal the receiver's limits).
CREATE TABLE trustwork.agent_envelope_receipt (
  envelope_id uuid PRIMARY KEY REFERENCES trustwork.agent_envelope (id),
  receiver_kind text NOT NULL CHECK (receiver_kind IN ('person', 'company')),
  receiver_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('informational', 'within_mandate', 'escalated')),
  reason text NOT NULL CHECK (reason IN ('informational', 'covered', 'human_only', 'outside_mandate', 'needs_approval', 'dispatch_blocked', 'no_representative', 'session_closed')),
  mandate_id uuid NULL REFERENCES trustwork.mandate (id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_envelope_receipt_receiver_idx ON trustwork.agent_envelope_receipt (receiver_kind, receiver_id, decided_at DESC);
CREATE TRIGGER agent_envelope_receipt_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_envelope_receipt FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER agent_envelope_receipt_owner_only BEFORE INSERT ON trustwork.agent_envelope_receipt FOR EACH ROW EXECUTE FUNCTION trustwork.agents_owner_only();

-- "Your decision is needed" items that agent-to-agent work produces for one party: an inbound intent outside the
-- receiver's mandate, an outbound one outside the company mandate, a deadlocked, expired or agreed session, a
-- confirmation request. Visible only to that party (a company through members holding company.deals.manage).
CREATE TABLE trustwork.agent_escalation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_kind text NOT NULL CHECK (owner_kind IN ('person', 'company')),
  owner_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('inbound_needs_decision', 'outbound_outside_mandate', 'rounds_exhausted', 'session_expired', 'agreement_needs_confirmation', 'confirmation_requested')),
  envelope_id uuid NULL REFERENCES trustwork.agent_envelope (id),
  session_id uuid NULL REFERENCES trustwork.negotiation_session (id),
  company_mandate_id uuid NULL REFERENCES trustwork.company_mandate (id),
  context_kind text NULL CHECK (context_kind IS NULL OR context_kind IN ('rfq', 'quote')),
  context_id uuid NULL,
  intent text NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by_person_id uuid NULL REFERENCES trustwork.person (id),
  resolved_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_escalation_resolved CHECK ((status = 'open') = (resolved_at IS NULL) AND (resolved_at IS NULL) = (resolved_by_person_id IS NULL))
);
CREATE INDEX agent_escalation_owner_idx ON trustwork.agent_escalation (owner_kind, owner_id, status);
CREATE TRIGGER agent_escalation_owner_only BEFORE INSERT OR UPDATE OR DELETE ON trustwork.agent_escalation FOR EACH ROW EXECUTE FUNCTION trustwork.agents_owner_only();
CREATE TRIGGER agent_escalation_touch BEFORE UPDATE ON trustwork.agent_escalation FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 4. Policy helper (invoker; executed by the runtime role inside policies) ------------------------------------------
-- Whether the current principal acts for a party: the person themself, or a member of the company holding
-- company.deals.manage (COM-001's `commerce_party_acts`).
CREATE FUNCTION trustwork.agents_party_acts(p_kind text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.commerce_party_acts(CASE WHEN p_kind = 'person' THEN p_id END, CASE WHEN p_kind = 'company' THEN p_id END, 'company.deals.manage')
$$;

-- 5. Internal helpers (owner-run, never granted) ----------------------------------------------------------------------
CREATE FUNCTION trustwork.agents_escalate(p_owner_kind text, p_owner_id uuid, p_source text, p_envelope_id uuid, p_session_id uuid, p_company_mandate_id uuid,
  p_context_kind text, p_context_id uuid, p_intent text) RETURNS uuid
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO trustwork.agent_escalation (owner_kind, owner_id, source, envelope_id, session_id, company_mandate_id, context_kind, context_id, intent)
  VALUES (p_owner_kind, p_owner_id, p_source, p_envelope_id, p_session_id, p_company_mandate_id, p_context_kind, p_context_id, p_intent) RETURNING id INTO v_id;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('agent_escalation', v_id::text, 1, 'agents.escalation_opened', jsonb_build_object('escalationId', v_id, 'ownerKind', p_owner_kind, 'ownerId', p_owner_id, 'source', p_source));
  RETURN v_id;
END $$;

-- Recomputes the stored state of the company's representative: suspended without an accountable person holding
-- authority, suspended without an effective company mandate, active otherwise. An administrator's suspension, a pending
-- acceptance and a disabled representative are left as they are.
CREATE FUNCTION trustwork.agents_refresh_representative(p_company_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_rep trustwork.company_representative%ROWTYPE;
  v_status text;
  v_reason text;
BEGIN
  SELECT * INTO v_rep FROM trustwork.company_representative WHERE company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_rep.status IN ('disabled', 'pending_acceptance') OR (v_rep.status = 'suspended' AND v_rep.suspension_reason = 'admin_suspended') THEN
    RETURN;
  END IF;
  IF v_rep.accountable_person_id IS NULL OR v_rep.accepted_at IS NULL OR NOT trustwork.agents_member_authority(v_rep.accountable_person_id, p_company_id) THEN
    v_status := 'suspended';
    v_reason := 'no_accountable_person';
  ELSIF NOT EXISTS (
    SELECT 1 FROM trustwork.company_mandate cm JOIN trustwork.mandate m ON m.id = cm.mandate_id
    WHERE cm.representative_id = v_rep.id AND cm.status = 'active' AND m.status = 'active' AND m.valid_until > clock_timestamp()) THEN
    v_status := 'suspended';
    v_reason := 'no_confirmed_mandate';
  ELSE
    v_status := 'active';
    v_reason := NULL;
  END IF;
  IF v_status IS DISTINCT FROM v_rep.status OR v_reason IS DISTINCT FROM v_rep.suspension_reason THEN
    UPDATE trustwork.company_representative SET status = v_status, suspension_reason = v_reason WHERE id = v_rep.id;
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
    VALUES ('company_representative', v_rep.id::text, v_rep.revision + 1, 'agents.representative_' || v_status, jsonb_build_object('companyId', p_company_id, 'reason', v_reason));
  END IF;
END $$;

-- Stops one company mandate and narrows its AST-001 mandate (revoked) in the same transaction.
CREATE FUNCTION trustwork.agents_stop_company_mandate(p_id uuid, p_status text, p_reason text, p_due timestamptz) RETURNS trustwork.company_mandate
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_cm trustwork.company_mandate%ROWTYPE;
  v_mandate_status text;
BEGIN
  UPDATE trustwork.company_mandate SET status = p_status, status_reason = p_reason, reconfirm_due_at = CASE WHEN p_status = 'awaiting_reconfirmation' THEN p_due END
  WHERE id = p_id RETURNING * INTO v_cm;
  SELECT status INTO v_mandate_status FROM trustwork.mandate WHERE id = v_cm.mandate_id;
  IF v_mandate_status IN ('active', 'suspended') THEN
    PERFORM trustwork.assistant_apply_narrowing(v_cm.mandate_id, 'revoked', 'company_mandate_' || p_reason, NULL, 'system');
  END IF;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('company_mandate', v_cm.id::text, v_cm.revision, 'agents.company_mandate_' || p_status, jsonb_build_object('companyMandateId', v_cm.id, 'companyId', v_cm.company_id, 'reason', p_reason));
  RETURN v_cm;
END $$;

-- The structural decision of a company mandate for one action: 'allow' | 'ask' | 'no' (see agents_mandate_covers),
-- after checking that the company mandate is active, its granter still holds company.deals.manage and the executor
-- still belongs to the company. Anything else is 'no'.
CREATE FUNCTION trustwork.agents_company_mandate_decision(p_cm trustwork.company_mandate, p_action text, p_module_keys text[], p_context_kind text, p_context_id text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_mandate trustwork.mandate%ROWTYPE;
BEGIN
  IF p_cm.id IS NULL OR p_cm.status <> 'active' OR NOT trustwork.agents_member_authority(p_cm.granted_by_person_id, p_cm.company_id) THEN
    RETURN 'no';
  END IF;
  IF p_cm.executor_kind = 'person_agent' AND NOT trustwork.agents_member_active(p_cm.executor_person_id, p_cm.company_id) THEN
    RETURN 'no';
  END IF;
  SELECT * INTO v_mandate FROM trustwork.mandate WHERE id = p_cm.mandate_id;
  IF NOT FOUND OR v_mandate.principal_person_id <> p_cm.granted_by_person_id OR v_mandate.on_behalf_company_id IS DISTINCT FROM p_cm.company_id THEN
    RETURN 'no';
  END IF;
  RETURN trustwork.agents_mandate_covers(v_mandate, p_action, p_module_keys, p_context_kind, p_context_id);
END $$;

-- The two parties of an envelope context, with the RFQ the context belongs to. A quote context has exactly its buyer
-- and seller; an RFQ context has its owner and an invited party or a seller that quoted on it.
CREATE FUNCTION trustwork.agents_context_rfq(p_context_kind text, p_context_id uuid, p_a_kind text, p_a_id uuid, p_b_kind text, p_b_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_rfq trustwork.rfq%ROWTYPE;
  v_quote trustwork.quote%ROWTYPE;
  v_owner_kind text;
  v_owner_id uuid;
  v_other_kind text;
  v_other_id uuid;
BEGIN
  IF p_context_kind = 'quote' THEN
    SELECT * INTO v_quote FROM trustwork.quote WHERE id = p_context_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown context' USING ERRCODE = 'insufficient_privilege', HINT = 'envelope.context_parties';
    END IF;
    IF NOT ((p_a_kind, p_a_id, p_b_kind, p_b_id) IN (
      (CASE WHEN v_quote.buyer_person_id IS NOT NULL THEN 'person' ELSE 'company' END, coalesce(v_quote.buyer_person_id, v_quote.buyer_company_id),
       CASE WHEN v_quote.seller_person_id IS NOT NULL THEN 'person' ELSE 'company' END, coalesce(v_quote.seller_person_id, v_quote.seller_company_id)),
      (CASE WHEN v_quote.seller_person_id IS NOT NULL THEN 'person' ELSE 'company' END, coalesce(v_quote.seller_person_id, v_quote.seller_company_id),
       CASE WHEN v_quote.buyer_person_id IS NOT NULL THEN 'person' ELSE 'company' END, coalesce(v_quote.buyer_person_id, v_quote.buyer_company_id)))) THEN
      RAISE EXCEPTION 'the parties are not the buyer and seller of the quote' USING ERRCODE = 'insufficient_privilege', HINT = 'envelope.context_parties';
    END IF;
    RETURN v_quote.rfq_id;
  END IF;
  SELECT * INTO v_rfq FROM trustwork.rfq WHERE id = p_context_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown context' USING ERRCODE = 'insufficient_privilege', HINT = 'envelope.context_parties';
  END IF;
  v_owner_kind := CASE WHEN v_rfq.owner_person_id IS NOT NULL THEN 'person' ELSE 'company' END;
  v_owner_id := coalesce(v_rfq.owner_person_id, v_rfq.owner_company_id);
  IF (p_a_kind, p_a_id) = (v_owner_kind, v_owner_id) THEN
    v_other_kind := p_b_kind; v_other_id := p_b_id;
  ELSIF (p_b_kind, p_b_id) = (v_owner_kind, v_owner_id) THEN
    v_other_kind := p_a_kind; v_other_id := p_a_id;
  ELSE
    RAISE EXCEPTION 'neither party owns the RFQ' USING ERRCODE = 'insufficient_privilege', HINT = 'envelope.context_parties';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.rfq_invitation i WHERE i.rfq_id = v_rfq.id AND i.status <> 'withdrawn'
                   AND ((v_other_kind = 'person' AND i.party_person_id = v_other_id) OR (v_other_kind = 'company' AND i.party_company_id = v_other_id)))
     AND NOT EXISTS (SELECT 1 FROM trustwork.quote q WHERE q.rfq_id = v_rfq.id AND q.status <> 'draft'
                   AND ((v_other_kind = 'person' AND q.seller_person_id = v_other_id) OR (v_other_kind = 'company' AND q.seller_company_id = v_other_id))) THEN
    RAISE EXCEPTION 'the other party was neither invited to nor quoted on the RFQ' USING ERRCODE = 'insufficient_privilege', HINT = 'envelope.context_parties';
  END IF;
  RETURN v_rfq.id;
END $$;

-- Verifies the references of an envelope: each names an exact published version by digest, inside the context's RFQ,
-- and a quote only when its buyer and seller are exactly the two parties (no relaying of one seller's quote to another).
-- Returns the quote ids referenced and whether the sender is the seller of at least one of them.
CREATE FUNCTION trustwork.agents_verify_refs(p_refs jsonb, p_rfq_id uuid, p_s_kind text, p_s_id uuid, p_r_kind text, p_r_id uuid, OUT quote_refs integer, OUT sender_quote_refs integer)
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_ref jsonb;
  v_id uuid;
  v_quote trustwork.quote%ROWTYPE;
  v_seller_kind text;
  v_seller_id uuid;
  v_buyer_kind text;
  v_buyer_id uuid;
BEGIN
  quote_refs := 0;
  sender_quote_refs := 0;
  FOR v_ref IN SELECT * FROM jsonb_array_elements(p_refs) LOOP
    IF jsonb_typeof(v_ref) <> 'object' OR coalesce(v_ref ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(v_ref -> 'version') <> 'number' OR (v_ref -> 'digest' ->> 'algorithm') IS DISTINCT FROM 'trustwork-digest-1'
       OR coalesce(v_ref -> 'digest' ->> 'value', '') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'malformed reference' USING ERRCODE = 'invalid_parameter_value', HINT = 'envelope.ref_invalid';
    END IF;
    v_id := (v_ref ->> 'id')::uuid;
    IF v_ref ->> 'kind' = 'rfq' THEN
      IF v_id <> p_rfq_id OR NOT EXISTS (SELECT 1 FROM trustwork.rfq_version v WHERE v.rfq_id = v_id AND v.version = (v_ref ->> 'version')::integer AND v.digest = v_ref -> 'digest' ->> 'value') THEN
        RAISE EXCEPTION 'the reference does not name a published version of this RFQ' USING ERRCODE = 'check_violation', HINT = 'envelope.ref_mismatch';
      END IF;
    ELSIF v_ref ->> 'kind' = 'quote' THEN
      SELECT * INTO v_quote FROM trustwork.quote WHERE id = v_id;
      IF NOT FOUND OR v_quote.rfq_id <> p_rfq_id OR NOT EXISTS (
        SELECT 1 FROM trustwork.quote_version v WHERE v.quote_id = v_id AND v.version = (v_ref ->> 'version')::integer AND v.digest = v_ref -> 'digest' ->> 'value' AND v.status <> 'draft') THEN
        RAISE EXCEPTION 'the reference does not name a sent version of a quote on this RFQ' USING ERRCODE = 'check_violation', HINT = 'envelope.ref_mismatch';
      END IF;
      v_seller_kind := CASE WHEN v_quote.seller_person_id IS NOT NULL THEN 'person' ELSE 'company' END;
      v_seller_id := coalesce(v_quote.seller_person_id, v_quote.seller_company_id);
      v_buyer_kind := CASE WHEN v_quote.buyer_person_id IS NOT NULL THEN 'person' ELSE 'company' END;
      v_buyer_id := coalesce(v_quote.buyer_person_id, v_quote.buyer_company_id);
      IF NOT (((v_seller_kind, v_seller_id) = (p_s_kind, p_s_id) AND (v_buyer_kind, v_buyer_id) = (p_r_kind, p_r_id))
              OR ((v_seller_kind, v_seller_id) = (p_r_kind, p_r_id) AND (v_buyer_kind, v_buyer_id) = (p_s_kind, p_s_id))) THEN
        RAISE EXCEPTION 'a quote is referenced only between its buyer and its seller' USING ERRCODE = 'insufficient_privilege', HINT = 'envelope.ref_not_between_parties';
      END IF;
      quote_refs := quote_refs + 1;
      IF (v_seller_kind, v_seller_id) = (p_s_kind, p_s_id) THEN
        sender_quote_refs := sender_quote_refs + 1;
      END IF;
    ELSE
      RAISE EXCEPTION 'references of this kind cannot be verified' USING ERRCODE = 'invalid_parameter_value', HINT = 'envelope.ref_unverifiable';
    END IF;
  END LOOP;
END $$;

-- Amounts the sender must never put into a note for this RFQ: its own private ceiling, floors, margin targets and cost
-- bases, the budget ranges of its goals, and, for the buyer, every price of a competing seller's quote.
CREATE FUNCTION trustwork.agents_sender_private_amounts(p_rfq_id uuid, p_s_kind text, p_s_id uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT a) FILTER (WHERE a ~ '^\d+$'), ARRAY[]::text[]) FROM (
    SELECT c.budget_ceiling_minor::text AS a FROM trustwork.rfq_private_constraint c
    WHERE c.rfq_id = p_rfq_id AND c.budget_ceiling_minor IS NOT NULL AND ((p_s_kind = 'person' AND c.owner_person_id = p_s_id) OR (p_s_kind = 'company' AND c.owner_company_id = p_s_id))
    UNION ALL
    SELECT x #>> '{}' FROM trustwork.quote q JOIN trustwork.quote_private_constraint c ON c.quote_id = q.id,
      LATERAL jsonb_path_query(jsonb_build_array(c.floor_prices, c.margin_targets, c.cost_basis), 'strict $.**.minorUnits') AS x
    WHERE q.rfq_id = p_rfq_id AND ((p_s_kind = 'person' AND q.seller_person_id = p_s_id) OR (p_s_kind = 'company' AND q.seller_company_id = p_s_id))
    UNION ALL
    SELECT x #>> '{}' FROM trustwork.goal g, LATERAL jsonb_path_query(coalesce(g.budget_range, '{}'::jsonb), 'strict $.**.minorUnits') AS x
    WHERE g.status <> 'closed' AND ((p_s_kind = 'person' AND g.principal_person_id = p_s_id AND g.on_behalf_company_id IS NULL) OR (p_s_kind = 'company' AND g.on_behalf_company_id = p_s_id))
  ) amounts
$$;
CREATE FUNCTION trustwork.agents_competitor_amounts(p_rfq_id uuid, p_s_kind text, p_s_id uuid, p_r_kind text, p_r_id uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT x #>> '{}') FILTER (WHERE (x #>> '{}') ~ '^\d+$'), ARRAY[]::text[])
  FROM trustwork.rfq r JOIN trustwork.quote q ON q.rfq_id = r.id JOIN trustwork.quote_version v ON v.quote_id = q.id AND v.status <> 'draft',
    LATERAL jsonb_path_query(v.payload, 'strict $.**.minorUnits') AS x
  WHERE r.id = p_rfq_id
    AND ((p_s_kind = 'person' AND r.owner_person_id = p_s_id) OR (p_s_kind = 'company' AND r.owner_company_id = p_s_id))
    AND NOT coalesce((p_r_kind = 'person' AND q.seller_person_id = p_r_id) OR (p_r_kind = 'company' AND q.seller_company_id = p_r_id), false)
$$;

-- 6. Principal commands (trustwork_app, inside withPrincipal) -------------------------------------------------------------
-- Activates a proposed goal for the exact digest its principal was shown. The service confirms the goal's mandate
-- proposals on the first-party form in the same transaction before calling this; every proposal must now be confirmed by
-- this principal, every covering mandate must still be active at the revision the digest bound.
CREATE FUNCTION trustwork.agents_confirm_goal(p_goal_id uuid, p_digest text, p_step_up boolean) RETURNS trustwork.goal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_goal trustwork.goal%ROWTYPE;
  v_mandates uuid[];
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_goal FROM trustwork.goal WHERE id = p_goal_id FOR UPDATE;
  IF NOT FOUND OR v_goal.principal_person_id <> v_person THEN
    RAISE EXCEPTION 'unknown goal' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_goal.status <> 'proposed' THEN
    RAISE EXCEPTION 'the goal is no longer waiting for confirmation' USING ERRCODE = 'check_violation', HINT = 'goal.not_proposed';
  END IF;
  IF p_digest IS DISTINCT FROM v_goal.confirmation_digest THEN
    RAISE EXCEPTION 'the confirmation does not match what was shown' USING ERRCODE = 'check_violation', HINT = 'access.approval_digest_mismatch';
  END IF;
  IF v_goal.on_behalf_company_id IS NOT NULL AND v_goal.on_behalf_company_id IS DISTINCT FROM trustwork.current_company_id() THEN
    RAISE EXCEPTION 'a company goal needs the principal''s active employment' USING ERRCODE = 'insufficient_privilege', HINT = 'mandate.authority_basis';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_goal.proposal_ids) AS pid LEFT JOIN trustwork.mandate_proposal p ON p.id = pid
             WHERE p.id IS NULL OR p.status <> 'confirmed' OR p.decided_by_person_id <> v_person OR p.principal_person_id <> v_person) THEN
    RAISE EXCEPTION 'every mandate change of the goal is confirmed in the same confirmation' USING ERRCODE = 'check_violation', HINT = 'goal.proposals_unconfirmed';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_goal.covered) AS c LEFT JOIN trustwork.mandate m ON m.id = (c ->> 'mandateId')::uuid
             WHERE m.id IS NULL OR m.principal_person_id <> v_person OR m.status <> 'active' OR m.revision <> (c ->> 'revision')::integer) THEN
    RAISE EXCEPTION 'a mandate the goal relies on changed since it was shown' USING ERRCODE = 'check_violation', HINT = 'goal.basis_changed';
  END IF;
  SELECT coalesce(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_mandates FROM (
    SELECT (c ->> 'mandateId')::uuid AS x FROM jsonb_array_elements(v_goal.covered) AS c
    UNION SELECT (p.proposed ->> 'id')::uuid FROM trustwork.mandate_proposal p WHERE p.id = ANY (v_goal.proposal_ids)) ids;
  UPDATE trustwork.goal SET status = 'active', confirmed_by_person_id = v_person, confirmed_at = clock_timestamp(), confirmed_step_up = p_step_up, mandate_ids = v_mandates
  WHERE id = p_goal_id RETURNING * INTO v_goal;
  INSERT INTO trustwork.goal_progress (goal_id, event_kind, detail, recorded_by_person_id)
  VALUES (v_goal.id, 'confirmed', jsonb_build_object('mandates', cardinality(v_mandates), 'proposalsConfirmed', cardinality(v_goal.proposal_ids)), v_person);
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('goal', v_goal.id::text, v_goal.revision, 'agents.goal_confirmed', jsonb_build_object('goalId', v_goal.id));
  RETURN v_goal;
END $$;

-- Pause, resume or close one's own goal; closing ends its goal-triggered job subscriptions in the same transaction.
CREATE FUNCTION trustwork.agents_set_goal_status(p_goal_id uuid, p_expected_revision integer, p_status text, p_outcome text) RETURNS trustwork.goal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_goal trustwork.goal%ROWTYPE;
  v_before text;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_status NOT IN ('active', 'paused', 'closed') OR (p_status = 'closed') <> (p_outcome IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid goal status' USING ERRCODE = 'invalid_parameter_value', HINT = 'goal.invalid_transition';
  END IF;
  SELECT * INTO v_goal FROM trustwork.goal WHERE id = p_goal_id FOR UPDATE;
  IF NOT FOUND OR v_goal.principal_person_id <> v_person THEN
    RAISE EXCEPTION 'unknown goal' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_goal.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the goal changed meanwhile' USING ERRCODE = 'check_violation', HINT = 'validation.revision_conflict';
  END IF;
  IF p_status = 'active' AND v_goal.status = 'proposed' THEN
    RAISE EXCEPTION 'a proposed goal is activated only by its confirmation' USING ERRCODE = 'check_violation', HINT = 'goal.not_proposed';
  END IF;
  v_before := v_goal.status;
  UPDATE trustwork.goal SET status = p_status, outcome = p_outcome, closed_at = CASE WHEN p_status = 'closed' THEN clock_timestamp() END WHERE id = p_goal_id RETURNING * INTO v_goal;
  IF p_status = 'closed' THEN
    UPDATE trustwork.job_subscription SET status = 'ended' WHERE goal_id = p_goal_id AND status <> 'ended';
  END IF;
  INSERT INTO trustwork.goal_progress (goal_id, event_kind, detail, recorded_by_person_id)
  VALUES (v_goal.id, CASE p_status WHEN 'closed' THEN 'closed' WHEN 'paused' THEN 'paused' ELSE 'resumed' END, jsonb_build_object('from', v_before, 'outcome', p_outcome), v_person);
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('goal', v_goal.id::text, v_goal.revision, 'agents.goal_' || p_status, jsonb_build_object('goalId', v_goal.id));
  RETURN v_goal;
END $$;

-- Shares a report with colleagues: active members of the author's active employer only.
CREATE FUNCTION trustwork.agents_share_report(p_report_id uuid, p_person_ids uuid[]) RETURNS trustwork.agent_report
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_company uuid := trustwork.current_company_id();
  v_report trustwork.agent_report%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_report FROM trustwork.agent_report WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND OR v_report.author_person_id <> v_person THEN
    RAISE EXCEPTION 'unknown report' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF coalesce(cardinality(p_person_ids), 0) > 50 OR v_person = ANY (coalesce(p_person_ids, ARRAY[]::uuid[]))
     OR EXISTS (SELECT 1 FROM unnest(coalesce(p_person_ids, ARRAY[]::uuid[])) AS pid WHERE NOT trustwork.agents_member_active(pid, v_company)) THEN
    RAISE EXCEPTION 'a report is shared only with colleagues of the active employer' USING ERRCODE = 'insufficient_privilege', HINT = 'agents.share_colleagues_only';
  END IF;
  UPDATE trustwork.agent_report SET shared_with = ARRAY(SELECT DISTINCT unnest(coalesce(p_person_ids, ARRAY[]::uuid[])) ORDER BY 1) WHERE id = p_report_id RETURNING * INTO v_report;
  RETURN v_report;
END $$;

-- Enables the company's one representative, re-enables a disabled one, or names a new accountable person. Company
-- administrators only. The named person must hold company.deals.manage; naming oneself accepts at once, anyone else
-- must accept (`agents_accept_representative`).
CREATE FUNCTION trustwork.agents_configure_representative(p_company_id uuid, p_accountable_person_id uuid, p_expected_revision integer) RETURNS trustwork.company_representative
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_rep trustwork.company_representative%ROWTYPE;
  v_self boolean := p_accountable_person_id = v_person;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.agents_member_admin(v_person, p_company_id) THEN
    RAISE EXCEPTION 'only a company administrator configures the representative' USING ERRCODE = 'insufficient_privilege', HINT = 'agents.not_company_admin';
  END IF;
  IF NOT trustwork.agents_member_authority(p_accountable_person_id, p_company_id) THEN
    RAISE EXCEPTION 'the accountable person is a current member holding company.deals.manage' USING ERRCODE = 'check_violation', HINT = 'agents.accountable_without_authority';
  END IF;
  -- Serializes concurrent first enables: the unique company_id makes the loser fail, the lock makes it fail cleanly.
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.agents.representative'), hashtext(p_company_id::text));
  SELECT * INTO v_rep FROM trustwork.company_representative WHERE company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_revision IS NOT NULL THEN
      RAISE EXCEPTION 'no representative to change' USING ERRCODE = 'check_violation', HINT = 'validation.revision_conflict';
    END IF;
    -- A freshly enabled representative is suspended until it holds a confirmed mandate (refresh below).
    INSERT INTO trustwork.company_representative (company_id, accountable_person_id, status, suspension_reason, enabled_by_person_id, accepted_at)
    VALUES (p_company_id, p_accountable_person_id, CASE WHEN v_self THEN 'suspended' ELSE 'pending_acceptance' END, CASE WHEN v_self THEN 'no_confirmed_mandate' END, v_person,
      CASE WHEN v_self THEN clock_timestamp() END)
    RETURNING * INTO v_rep;
  ELSE
    IF p_expected_revision IS DISTINCT FROM v_rep.revision THEN
      RAISE EXCEPTION 'the representative changed meanwhile; a company has at most one' USING ERRCODE = 'check_violation', HINT = 'validation.revision_conflict';
    END IF;
    UPDATE trustwork.representative_accountability SET to_at = clock_timestamp(), ended_reason = 'replaced'
    WHERE representative_id = v_rep.id AND to_at IS NULL AND person_id <> p_accountable_person_id;
    UPDATE trustwork.company_representative SET accountable_person_id = p_accountable_person_id, disabled_at = NULL,
      accepted_at = CASE WHEN v_self OR (v_rep.accountable_person_id = p_accountable_person_id AND v_rep.accepted_at IS NOT NULL) THEN coalesce(CASE WHEN v_rep.accountable_person_id = p_accountable_person_id THEN v_rep.accepted_at END, clock_timestamp()) END,
      status = CASE WHEN v_self OR (v_rep.accountable_person_id = p_accountable_person_id AND v_rep.accepted_at IS NOT NULL) THEN 'suspended' ELSE 'pending_acceptance' END,
      suspension_reason = CASE WHEN v_self OR (v_rep.accountable_person_id = p_accountable_person_id AND v_rep.accepted_at IS NOT NULL) THEN 'no_confirmed_mandate' END
    WHERE id = v_rep.id RETURNING * INTO v_rep;
  END IF;
  IF v_rep.accepted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.representative_accountability WHERE representative_id = v_rep.id AND to_at IS NULL) THEN
    INSERT INTO trustwork.representative_accountability (representative_id, person_id) VALUES (v_rep.id, p_accountable_person_id);
  END IF;
  PERFORM trustwork.agents_refresh_representative(p_company_id);
  SELECT * INTO v_rep FROM trustwork.company_representative WHERE id = v_rep.id;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('company_representative', v_rep.id::text, v_rep.revision, 'agents.representative_configured', jsonb_build_object('companyId', p_company_id));
  RETURN v_rep;
END $$;

-- The named person accepts the accountable role (they must still hold company.deals.manage).
CREATE FUNCTION trustwork.agents_accept_representative(p_company_id uuid) RETURNS trustwork.company_representative
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_rep trustwork.company_representative%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_rep FROM trustwork.company_representative WHERE company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_rep.accountable_person_id IS DISTINCT FROM v_person OR v_rep.status <> 'pending_acceptance' THEN
    RAISE EXCEPTION 'nothing to accept' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF p_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.agents_member_authority(v_person, p_company_id) THEN
    RAISE EXCEPTION 'the accountable person is a current member holding company.deals.manage' USING ERRCODE = 'insufficient_privilege', HINT = 'agents.accountable_without_authority';
  END IF;
  UPDATE trustwork.company_representative SET status = 'suspended', suspension_reason = 'no_confirmed_mandate', accepted_at = clock_timestamp() WHERE id = v_rep.id;
  INSERT INTO trustwork.representative_accountability (representative_id, person_id) VALUES (v_rep.id, v_person);
  PERFORM trustwork.agents_refresh_representative(p_company_id);
  SELECT * INTO v_rep FROM trustwork.company_representative WHERE id = v_rep.id;
  RETURN v_rep;
END $$;

-- Any company administrator suspends the representative instantly (never needs step-up); resuming is an
-- administrator's deliberate act; disabling ends accountability. None of these widen anything.
CREATE FUNCTION trustwork.agents_suspend_representative(p_company_id uuid) RETURNS trustwork.company_representative
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_rep trustwork.company_representative%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.agents_member_admin(v_person, p_company_id) THEN
    RAISE EXCEPTION 'only a company administrator suspends the representative' USING ERRCODE = 'insufficient_privilege', HINT = 'agents.not_company_admin';
  END IF;
  SELECT * INTO v_rep FROM trustwork.company_representative WHERE company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_rep.status = 'disabled' THEN
    RAISE EXCEPTION 'no representative' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_rep.status = 'pending_acceptance' THEN
    UPDATE trustwork.company_representative SET status = 'suspended', suspension_reason = 'admin_suspended' WHERE id = v_rep.id RETURNING * INTO v_rep;
  ELSIF NOT (v_rep.status = 'suspended' AND v_rep.suspension_reason = 'admin_suspended') THEN
    UPDATE trustwork.company_representative SET status = 'suspended', suspension_reason = 'admin_suspended' WHERE id = v_rep.id RETURNING * INTO v_rep;
  END IF;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('company_representative', v_rep.id::text, v_rep.revision, 'agents.representative_suspended', jsonb_build_object('companyId', p_company_id, 'reason', 'admin_suspended'));
  RETURN v_rep;
END $$;
CREATE FUNCTION trustwork.agents_resume_representative(p_company_id uuid, p_expected_revision integer) RETURNS trustwork.company_representative
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_rep trustwork.company_representative%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.agents_member_admin(v_person, p_company_id) THEN
    RAISE EXCEPTION 'only a company administrator resumes the representative' USING ERRCODE = 'insufficient_privilege', HINT = 'agents.not_company_admin';
  END IF;
  SELECT * INTO v_rep FROM trustwork.company_representative WHERE company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR NOT (v_rep.status = 'suspended' AND v_rep.suspension_reason = 'admin_suspended') THEN
    RAISE EXCEPTION 'the representative is not suspended by an administrator' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
  END IF;
  IF v_rep.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the representative changed meanwhile' USING ERRCODE = 'check_violation', HINT = 'validation.revision_conflict';
  END IF;
  IF v_rep.accepted_at IS NULL THEN
    UPDATE trustwork.company_representative SET status = 'pending_acceptance', suspension_reason = NULL WHERE id = v_rep.id;
  ELSE
    UPDATE trustwork.company_representative SET suspension_reason = 'no_confirmed_mandate' WHERE id = v_rep.id;
    PERFORM trustwork.agents_refresh_representative(p_company_id);
  END IF;
  SELECT * INTO v_rep FROM trustwork.company_representative WHERE id = v_rep.id;
  RETURN v_rep;
END $$;
CREATE FUNCTION trustwork.agents_disable_representative(p_company_id uuid) RETURNS trustwork.company_representative
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_rep trustwork.company_representative%ROWTYPE;
  v_cm uuid;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.agents_member_admin(v_person, p_company_id) THEN
    RAISE EXCEPTION 'only a company administrator disables the representative' USING ERRCODE = 'insufficient_privilege', HINT = 'agents.not_company_admin';
  END IF;
  SELECT * INTO v_rep FROM trustwork.company_representative WHERE company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_rep.status = 'disabled' THEN
    RAISE EXCEPTION 'no representative' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  FOR v_cm IN SELECT id FROM trustwork.company_mandate WHERE representative_id = v_rep.id AND status <> 'revoked' ORDER BY id FOR UPDATE LOOP
    PERFORM trustwork.agents_stop_company_mandate(v_cm, 'revoked', 'representative_disabled', NULL);
  END LOOP;
  UPDATE trustwork.representative_accountability SET to_at = clock_timestamp(), ended_reason = 'disabled' WHERE representative_id = v_rep.id AND to_at IS NULL;
  UPDATE trustwork.company_representative SET status = 'disabled', suspension_reason = NULL, accepted_at = NULL, disabled_at = clock_timestamp() WHERE id = v_rep.id RETURNING * INTO v_rep;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('company_representative', v_rep.id::text, v_rep.revision, 'agents.representative_disabled', jsonb_build_object('companyId', p_company_id));
  RETURN v_rep;
END $$;

-- Records a company mandate right after its principal confirmed the AST-001 mandate on the first-party form in the same
-- transaction. The principal holds company.deals.manage at their active employer; the grantee is a colleague's agent
-- (an active member other than the principal) or the company's representative (not disabled).
CREATE FUNCTION trustwork.agents_grant_company_mandate(p_mandate_id uuid, p_terms jsonb, p_terms_digest text) RETURNS trustwork.company_mandate
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_company uuid := trustwork.current_company_id();
  v_mandate trustwork.mandate%ROWTYPE;
  v_rep trustwork.company_representative%ROWTYPE;
  v_cm trustwork.company_mandate%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_mandate FROM trustwork.mandate WHERE id = p_mandate_id FOR UPDATE;
  IF NOT FOUND OR v_mandate.principal_person_id <> v_person OR v_mandate.status <> 'active' OR v_mandate.revision <> 1 THEN
    RAISE EXCEPTION 'unknown mandate' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_mandate.on_behalf_company_id IS NULL OR v_mandate.on_behalf_company_id IS DISTINCT FROM v_company OR NOT trustwork.agents_member_authority(v_person, v_company) THEN
    RAISE EXCEPTION 'a company mandate is granted by a member holding company.deals.manage' USING ERRCODE = 'insufficient_privilege', HINT = 'agents.grant_without_authority';
  END IF;
  IF coalesce(p_terms_digest, '') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_terms) <> 'object' THEN
    RAISE EXCEPTION 'invalid terms' USING ERRCODE = 'invalid_parameter_value', HINT = 'mandate.invalid';
  END IF;
  IF v_mandate.grantee_kind = 'colleague_agent' THEN
    IF v_mandate.grantee_person_id = v_person OR NOT trustwork.agents_member_active(v_mandate.grantee_person_id, v_company) THEN
      RAISE EXCEPTION 'a colleague mandate names another active member' USING ERRCODE = 'check_violation', HINT = 'agents.executor_not_colleague';
    END IF;
    INSERT INTO trustwork.company_mandate (company_id, mandate_id, granted_by_person_id, executor_kind, executor_person_id, terms, terms_digest)
    VALUES (v_company, v_mandate.id, v_person, 'person_agent', v_mandate.grantee_person_id, p_terms, p_terms_digest) RETURNING * INTO v_cm;
  ELSIF v_mandate.grantee_kind = 'company_representative' THEN
    SELECT * INTO v_rep FROM trustwork.company_representative WHERE company_id = v_company FOR UPDATE;
    IF NOT FOUND OR v_rep.status = 'disabled' THEN
      RAISE EXCEPTION 'the company has no representative' USING ERRCODE = 'check_violation', HINT = 'agents.no_representative';
    END IF;
    INSERT INTO trustwork.company_mandate (company_id, mandate_id, granted_by_person_id, executor_kind, representative_id, terms, terms_digest)
    VALUES (v_company, v_mandate.id, v_person, 'company_representative', v_rep.id, p_terms, p_terms_digest) RETURNING * INTO v_cm;
  ELSE
    RAISE EXCEPTION 'own-agent mandates are not company mandates' USING ERRCODE = 'check_violation', HINT = 'agents.not_company_grantee';
  END IF;
  PERFORM trustwork.agents_refresh_representative(v_company);
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('company_mandate', v_cm.id::text, v_cm.revision, 'agents.company_mandate_granted', jsonb_build_object('companyMandateId', v_cm.id, 'companyId', v_company));
  RETURN v_cm;
END $$;

-- Another authorized member re-confirms a company mandate whose granter left or lost authority, within 7 days, by
-- confirming a new AST-001 mandate with exactly the same terms (digest) and grantee in the same transaction. They become
-- the granter. Never widens: the terms digest must be identical.
CREATE FUNCTION trustwork.agents_reconfirm_company_mandate(p_company_mandate_id uuid, p_new_mandate_id uuid, p_terms_digest text) RETURNS trustwork.company_mandate
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_cm trustwork.company_mandate%ROWTYPE;
  v_old trustwork.mandate%ROWTYPE;
  v_new trustwork.mandate%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_cm FROM trustwork.company_mandate WHERE id = p_company_mandate_id FOR UPDATE;
  IF NOT FOUND OR v_cm.company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.agents_member_authority(v_person, v_cm.company_id) THEN
    RAISE EXCEPTION 'unknown company mandate' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_cm.status <> 'awaiting_reconfirmation' THEN
    RAISE EXCEPTION 'the company mandate is not waiting for re-confirmation' USING ERRCODE = 'check_violation', HINT = 'agents.not_awaiting_reconfirmation';
  END IF;
  IF v_cm.reconfirm_due_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'the re-confirmation window has passed' USING ERRCODE = 'check_violation', HINT = 'agents.reconfirmation_lapsed';
  END IF;
  IF p_terms_digest IS DISTINCT FROM v_cm.terms_digest THEN
    RAISE EXCEPTION 'a re-confirmation repeats exactly the same terms' USING ERRCODE = 'check_violation', HINT = 'access.approval_digest_mismatch';
  END IF;
  SELECT * INTO v_old FROM trustwork.mandate WHERE id = v_cm.mandate_id;
  SELECT * INTO v_new FROM trustwork.mandate WHERE id = p_new_mandate_id FOR UPDATE;
  IF NOT FOUND OR v_new.principal_person_id <> v_person OR v_new.status <> 'active' OR v_new.revision <> 1 OR v_new.on_behalf_company_id IS DISTINCT FROM v_cm.company_id
     OR v_new.grantee_kind <> v_old.grantee_kind OR v_new.grantee_person_id IS DISTINCT FROM v_old.grantee_person_id OR v_new.grantee_company_id IS DISTINCT FROM v_old.grantee_company_id
     OR EXISTS (SELECT 1 FROM trustwork.company_mandate o WHERE o.mandate_id = p_new_mandate_id) THEN
    RAISE EXCEPTION 'the re-confirmed mandate has the same grantee and is the re-confirming member''s own' USING ERRCODE = 'check_violation', HINT = 'agents.reconfirmation_mismatch';
  END IF;
  IF v_cm.executor_kind = 'person_agent' AND (v_cm.executor_person_id = v_person OR NOT trustwork.agents_member_active(v_cm.executor_person_id, v_cm.company_id)) THEN
    RAISE EXCEPTION 'a colleague mandate names another active member' USING ERRCODE = 'check_violation', HINT = 'agents.executor_not_colleague';
  END IF;
  UPDATE trustwork.company_mandate SET mandate_id = p_new_mandate_id, granted_by_person_id = v_person, status = 'active', status_reason = NULL, reconfirm_due_at = NULL,
    reconfirmed_by_person_id = v_person, reconfirmed_at = clock_timestamp(), previous_mandate_ids = previous_mandate_ids || v_cm.mandate_id
  WHERE id = v_cm.id RETURNING * INTO v_cm;
  PERFORM trustwork.agents_refresh_representative(v_cm.company_id);
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('company_mandate', v_cm.id::text, v_cm.revision, 'agents.company_mandate_reconfirmed', jsonb_build_object('companyMandateId', v_cm.id, 'companyId', v_cm.company_id));
  RETURN v_cm;
END $$;

-- Any member holding company.deals.manage revokes a company mandate (narrowing is always allowed).
CREATE FUNCTION trustwork.agents_revoke_company_mandate(p_company_mandate_id uuid, p_expected_revision integer) RETURNS trustwork.company_mandate
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_cm trustwork.company_mandate%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_cm FROM trustwork.company_mandate WHERE id = p_company_mandate_id FOR UPDATE;
  IF NOT FOUND OR v_cm.company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.agents_member_authority(v_person, v_cm.company_id) THEN
    RAISE EXCEPTION 'unknown company mandate' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_cm.status = 'revoked' THEN
    RETURN v_cm;
  END IF;
  IF v_cm.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the company mandate changed meanwhile' USING ERRCODE = 'check_violation', HINT = 'validation.revision_conflict';
  END IF;
  v_cm := trustwork.agents_stop_company_mandate(v_cm.id, 'revoked', 'revoked_by_member', NULL);
  PERFORM trustwork.agents_refresh_representative(v_cm.company_id);
  RETURN v_cm;
END $$;

-- Re-confirmation windows that passed suspend their company mandates (idempotent; only narrows).
CREATE FUNCTION trustwork.agents_lapse_reconfirmations(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_cm trustwork.company_mandate%ROWTYPE;
  v_count integer := 0;
BEGIN
  FOR v_cm IN SELECT * FROM trustwork.company_mandate WHERE status = 'awaiting_reconfirmation' AND reconfirm_due_at <= clock_timestamp()
    ORDER BY reconfirm_due_at, id LIMIT greatest(1, least(coalesce(p_limit, 100), 1000)) FOR UPDATE SKIP LOCKED LOOP
    UPDATE trustwork.company_mandate SET status = 'suspended', status_reason = 'reconfirmation_lapsed', reconfirm_due_at = NULL WHERE id = v_cm.id;
    PERFORM trustwork.agents_refresh_representative(v_cm.company_id);
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
    VALUES ('company_mandate', v_cm.id::text, v_cm.revision + 1, 'agents.company_mandate_suspended', jsonb_build_object('companyMandateId', v_cm.id, 'companyId', v_cm.company_id, 'reason', 'reconfirmation_lapsed'));
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- Open sessions past their expiry end as expired and escalate to the people on both sides (idempotent).
CREATE FUNCTION trustwork.agents_expire_sessions(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_session trustwork.negotiation_session%ROWTYPE;
  v_count integer := 0;
BEGIN
  FOR v_session IN SELECT * FROM trustwork.negotiation_session WHERE status = 'open' AND expires_at <= clock_timestamp()
    ORDER BY expires_at, id LIMIT greatest(1, least(coalesce(p_limit, 100), 1000)) FOR UPDATE SKIP LOCKED LOOP
    UPDATE trustwork.negotiation_session SET status = 'expired', escalation_reason = 'expired', turn_kind = NULL, turn_id = NULL WHERE id = v_session.id;
    PERFORM trustwork.agents_escalate(v_session.party_a_kind, v_session.party_a_id, 'session_expired', NULL, v_session.id, NULL, v_session.context_kind, v_session.context_id, NULL);
    PERFORM trustwork.agents_escalate(v_session.party_b_kind, v_session.party_b_id, 'session_expired', NULL, v_session.id, NULL, v_session.context_kind, v_session.context_id, NULL);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- A party resolves or dismisses one of its own escalations.
CREATE FUNCTION trustwork.agents_resolve_escalation(p_escalation_id uuid, p_status text) RETURNS trustwork.agent_escalation
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_row trustwork.agent_escalation%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_status NOT IN ('resolved', 'dismissed') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = 'invalid_parameter_value', HINT = 'agents.invalid_transition';
  END IF;
  SELECT * INTO v_row FROM trustwork.agent_escalation WHERE id = p_escalation_id FOR UPDATE;
  IF NOT FOUND OR NOT ((v_row.owner_kind = 'person' AND v_row.owner_id = v_person)
                       OR (v_row.owner_kind = 'company' AND v_row.owner_id = trustwork.current_company_id() AND trustwork.agents_member_authority(v_person, v_row.owner_id))) THEN
    RAISE EXCEPTION 'unknown escalation' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION 'the escalation is already decided' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
  END IF;
  UPDATE trustwork.agent_escalation SET status = p_status, resolved_by_person_id = v_person, resolved_at = clock_timestamp() WHERE id = v_row.id RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Delivers one agent envelope. The API has already decided the sender's own-agent mandate with evaluateMandateV2 and
-- recorded the mandate use in the same transaction; this command repeats every check the database can see:
--   1. who speaks: the principal's own agent (for the principal, or for their active employer while holding
--      company.deals.manage), a colleague's agent executing a company mandate, or the company's active representative
--      with the principal as its accountable person; the `from` party is derived here, never taken from the caller;
--   2. the company mandate's structural decision (`allow` only; otherwise an outbound escalation for the company's
--      people, and nothing is delivered), the hub and node kill switches, the person's stop control;
--   3. the context and both parties, every reference (exact published versions, quotes only between the two parties),
--      the note against the sender's private amounts and competitors' prices, the per-counterparty daily limit;
--   4. the negotiation session (round limit, turn, expiry, agreement) for state-moving intents;
--   5. the receiver's own mandate decision on the structured intent (receiver-private receipt and escalation).
-- The note is stored and never read. Refusals that reveal an attack (spoofing, references, private amounts, kill switch,
-- rate) raise; outcomes that are themselves state changes (escalation, deadlock, expiry) return a row.
CREATE FUNCTION trustwork.agents_deliver_envelope(p_actor jsonb, p_envelope jsonb, p_settings jsonb)
RETURNS TABLE (envelope_id uuid, session_id uuid, outcome text, reason text)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
#variable_conflict use_column
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_company uuid := trustwork.current_company_id();
  v_now timestamptz := clock_timestamp();
  v_kind text := p_actor ->> 'kind';
  v_intent text := p_envelope ->> 'intent';
  v_action text := trustwork.agents_intent_action(p_envelope ->> 'intent');
  v_modules text[] := ARRAY(SELECT jsonb_array_elements_text(coalesce(p_settings -> 'moduleKeys', '["negotiation"]'::jsonb)));
  v_hub uuid := nullif(p_settings ->> 'hubId', '')::uuid;
  v_mandate trustwork.mandate%ROWTYPE;
  v_cm trustwork.company_mandate%ROWTYPE;
  v_rep trustwork.company_representative%ROWTYPE;
  v_s_kind text;
  v_s_id uuid;
  v_r_kind text := p_envelope -> 'to' ->> 'kind';
  v_r_id uuid;
  v_ctx_kind text := p_envelope -> 'context' ->> 'kind';
  v_ctx_id uuid;
  v_rfq uuid;
  v_refs jsonb := coalesce(p_envelope -> 'refs', '[]'::jsonb);
  v_quote_refs integer;
  v_sender_quote_refs integer;
  v_note text := p_envelope ->> 'note';
  v_actor_kind text;
  v_label text;
  v_from_person uuid;
  v_accountable uuid;
  v_decision text;
  v_session trustwork.negotiation_session%ROWTYPE;
  v_has_session boolean := false;
  v_envelope uuid;
  v_receiver_action text;
  v_receipt_decision text;
  v_receipt_reason text;
  v_receipt_mandate uuid;
  v_candidate trustwork.mandate%ROWTYPE;
  v_candidate_cm trustwork.company_mandate%ROWTYPE;
  v_cover text;
  v_expires timestamptz;
  v_sent integer;
  v_blocked uuid;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF jsonb_typeof(p_actor) <> 'object' OR jsonb_typeof(p_envelope) <> 'object' OR jsonb_typeof(v_refs) <> 'array' OR v_ctx_kind NOT IN ('rfq', 'quote')
     OR v_r_kind NOT IN ('person', 'company') OR coalesce(p_envelope -> 'to' ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR coalesce(p_envelope -> 'context' ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR cardinality(v_modules) = 0 THEN
    RAISE EXCEPTION 'invalid envelope' USING ERRCODE = 'invalid_parameter_value', HINT = 'envelope.invalid';
  END IF;
  v_r_id := (p_envelope -> 'to' ->> 'id')::uuid;
  v_ctx_id := (p_envelope -> 'context' ->> 'id')::uuid;
  v_expires := (p_envelope ->> 'expiresAt')::timestamptz;
  IF v_expires IS NULL OR v_expires <= v_now OR v_expires > v_now + interval '31 days' THEN
    RAISE EXCEPTION 'an envelope expires within 31 days' USING ERRCODE = 'invalid_parameter_value', HINT = 'envelope.invalid';
  END IF;

  -- 1. Who speaks, for which party, under which authority.
  IF v_kind = 'own_agent' THEN
    SELECT * INTO v_mandate FROM trustwork.mandate WHERE id = (p_actor ->> 'mandateId')::uuid FOR UPDATE;
    IF NOT FOUND OR v_mandate.principal_person_id <> v_person OR v_mandate.grantee_kind <> 'own_agent' THEN
      RAISE EXCEPTION 'unknown mandate' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
    END IF;
    IF v_mandate.status <> 'active' OR v_mandate.valid_until <= v_now OR NOT (v_action = ANY (v_mandate.actions)) OR NOT (v_mandate.module_keys && v_modules)
       OR trustwork.agents_mandate_covers(v_mandate, v_action, v_modules, v_ctx_kind, v_ctx_id::text) = 'no' THEN
      RAISE EXCEPTION 'the intent is outside the mandate' USING ERRCODE = 'insufficient_privilege', HINT = 'envelope.outside_mandate';
    END IF;
    IF v_mandate.on_behalf_company_id IS NOT NULL THEN
      IF v_mandate.on_behalf_company_id IS DISTINCT FROM v_company OR NOT trustwork.agents_member_authority(v_person, v_company) THEN
        RAISE EXCEPTION 'speaking for the company needs company.deals.manage at the active employer' USING ERRCODE = 'insufficient_privilege', HINT = 'mandate.authority_basis';
      END IF;
      v_s_kind := 'company'; v_s_id := v_company; v_label := 'agents.label.personAgentForCompany';
    ELSE
      v_s_kind := 'person'; v_s_id := v_person; v_label := 'agents.label.personAgent';
    END IF;
    v_actor_kind := 'person_agent';
    v_from_person := v_person;
  ELSIF v_kind IN ('colleague_agent', 'company_representative') THEN
    SELECT * INTO v_cm FROM trustwork.company_mandate WHERE id = (p_actor ->> 'companyMandateId')::uuid FOR UPDATE;
    IF NOT FOUND OR v_cm.company_id IS DISTINCT FROM v_company THEN
      RAISE EXCEPTION 'unknown company mandate' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
    END IF;
    IF v_kind = 'colleague_agent' THEN
      IF v_cm.executor_kind <> 'person_agent' OR v_cm.executor_person_id <> v_person THEN
        RAISE EXCEPTION 'only the named colleague''s agent executes this company mandate' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
      END IF;
      v_actor_kind := 'person_agent'; v_from_person := v_person; v_label := 'agents.label.personAgentForCompany';
    ELSE
      SELECT * INTO v_rep FROM trustwork.company_representative WHERE company_id = v_company FOR SHARE;
      IF NOT FOUND OR v_cm.executor_kind <> 'company_representative' OR v_cm.representative_id <> v_rep.id OR v_rep.accountable_person_id IS DISTINCT FROM v_person THEN
        RAISE EXCEPTION 'only the representative''s accountable person runs the representative' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
      END IF;
      IF v_rep.status <> 'active' OR NOT trustwork.agents_member_authority(v_person, v_company) THEN
        RAISE EXCEPTION 'the representative is not active' USING ERRCODE = 'check_violation', HINT = 'agents.representative_inactive';
      END IF;
      v_actor_kind := 'company_representative'; v_from_person := NULL; v_accountable := v_person; v_label := 'agents.label.representative';
    END IF;
    v_s_kind := 'company'; v_s_id := v_company;
    v_decision := trustwork.agents_company_mandate_decision(v_cm, v_action, v_modules, v_ctx_kind, v_ctx_id::text);
    IF v_decision <> 'allow' THEN
      -- Decisions go to people: the company's members holding company.deals.manage see it in their own assistant.
      PERFORM trustwork.agents_escalate('company', v_company, 'outbound_outside_mandate', NULL, NULL, v_cm.id, v_ctx_kind, v_ctx_id, v_intent);
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'escalated'::text, CASE v_decision WHEN 'ask' THEN 'needs_approval' ELSE 'outside_mandate' END;
      RETURN;
    END IF;
    SELECT * INTO v_mandate FROM trustwork.mandate WHERE id = v_cm.mandate_id FOR UPDATE;
    PERFORM trustwork.assistant_check_limits(v_mandate, NULL, NULL);
    INSERT INTO trustwork.mandate_use (mandate_id, mandate_revision, action) VALUES (v_mandate.id, v_mandate.revision, v_action);
  ELSE
    RAISE EXCEPTION 'invalid actor' USING ERRCODE = 'invalid_parameter_value', HINT = 'envelope.invalid';
  END IF;

  -- 2. Kill switches (hub, node, module, action, outbound messages) and the person's stop control.
  v_blocked := trustwork.assistant_dispatch_blocked(v_hub, (SELECT k FROM unnest(v_mandate.module_keys) AS k WHERE k = ANY (v_modules) ORDER BY k LIMIT 1), v_action,
    CASE WHEN v_actor_kind = 'person_agent' THEN v_person END, NULL);
  IF v_blocked IS NULL AND v_actor_kind = 'company_representative' THEN
    v_blocked := trustwork.assistant_dispatch_blocked(v_hub, 'representative', v_action, NULL, NULL);
  END IF;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION 'agent dispatch is stopped' USING ERRCODE = 'check_violation', HINT = 'envelope.dispatch_blocked';
  END IF;

  -- 3. Context, parties, references, the note and the daily limit.
  IF (v_s_kind, v_s_id) = (v_r_kind, v_r_id) THEN
    RAISE EXCEPTION 'an envelope goes to the other party' USING ERRCODE = 'invalid_parameter_value', HINT = 'envelope.context_parties';
  END IF;
  v_rfq := trustwork.agents_context_rfq(v_ctx_kind, v_ctx_id, v_s_kind, v_s_id, v_r_kind, v_r_id);
  SELECT r.quote_refs, r.sender_quote_refs INTO v_quote_refs, v_sender_quote_refs FROM trustwork.agents_verify_refs(v_refs, v_rfq, v_s_kind, v_s_id, v_r_kind, v_r_id) r;
  IF v_intent IN ('propose', 'counter', 'accept', 'withdraw', 'request_confirmation') AND v_quote_refs = 0 THEN
    RAISE EXCEPTION 'state-moving intents reference an exact quote version' USING ERRCODE = 'check_violation', HINT = 'envelope.refs_required';
  END IF;
  IF v_intent = 'propose' AND v_sender_quote_refs = 0 THEN
    RAISE EXCEPTION 'a proposal references the sender''s own quote version' USING ERRCODE = 'check_violation', HINT = 'envelope.refs_required';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 4000 THEN
    RAISE EXCEPTION 'note too long' USING ERRCODE = 'invalid_parameter_value', HINT = 'envelope.invalid';
  END IF;
  IF v_note IS NOT NULL AND trustwork.agents_note_leaks(v_note, trustwork.agents_sender_private_amounts(v_rfq, v_s_kind, v_s_id)) THEN
    RAISE EXCEPTION 'the note repeats a private constraint of the sender' USING ERRCODE = 'check_violation', HINT = 'envelope.private_constraint';
  END IF;
  IF v_note IS NOT NULL AND trustwork.agents_note_leaks(v_note, trustwork.agents_competitor_amounts(v_rfq, v_s_kind, v_s_id, v_r_kind, v_r_id)) THEN
    RAISE EXCEPTION 'the note repeats a competing seller''s price' USING ERRCODE = 'check_violation', HINT = 'envelope.competitor_pricing';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.agents.envelope_pair'), hashtext(v_s_kind || v_s_id::text || v_r_kind || v_r_id::text));
  SELECT count(*) INTO v_sent FROM trustwork.agent_envelope e
  WHERE e.from_kind = v_s_kind AND e.from_id = v_s_id AND e.to_kind = v_r_kind AND e.to_id = v_r_id AND e.created_at > v_now - interval '24 hours';
  IF v_sent >= coalesce((p_settings ->> 'perCounterpartyPerDay')::integer, 20) THEN
    RAISE EXCEPTION 'the daily envelope limit for this counterparty is reached' USING ERRCODE = 'check_violation', HINT = 'envelope.rate_limited';
  END IF;

  -- 4. The negotiation session.
  IF p_envelope ->> 'sessionId' IS NOT NULL THEN
    SELECT * INTO v_session FROM trustwork.negotiation_session s WHERE s.id = (p_envelope ->> 'sessionId')::uuid FOR UPDATE;
    IF NOT FOUND OR v_session.context_kind <> v_ctx_kind OR v_session.context_id <> v_ctx_id
       OR NOT (((v_session.party_a_kind, v_session.party_a_id) = (v_s_kind, v_s_id) AND (v_session.party_b_kind, v_session.party_b_id) = (v_r_kind, v_r_id))
            OR ((v_session.party_b_kind, v_session.party_b_id) = (v_s_kind, v_s_id) AND (v_session.party_a_kind, v_session.party_a_id) = (v_r_kind, v_r_id))) THEN
      RAISE EXCEPTION 'unknown session' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
    END IF;
    v_has_session := true;
  ELSIF v_intent IN ('propose', 'counter', 'accept', 'decline', 'withdraw', 'request_confirmation') THEN
    SELECT * INTO v_session FROM trustwork.negotiation_session s WHERE s.context_kind = v_ctx_kind AND s.context_id = v_ctx_id AND s.status = 'open'
      AND (((s.party_a_kind, s.party_a_id) = (v_s_kind, v_s_id) AND (s.party_b_kind, s.party_b_id) = (v_r_kind, v_r_id))
        OR ((s.party_b_kind, s.party_b_id) = (v_s_kind, v_s_id) AND (s.party_a_kind, s.party_a_id) = (v_r_kind, v_r_id))) FOR UPDATE;
    IF FOUND THEN
      v_has_session := true;
    ELSIF v_intent IN ('propose', 'counter') THEN
      INSERT INTO trustwork.negotiation_session (context_kind, context_id, party_a_kind, party_a_id, party_b_kind, party_b_id, max_rounds, expires_at)
      VALUES (v_ctx_kind, v_ctx_id, v_s_kind, v_s_id, v_r_kind, v_r_id, least(greatest(coalesce((p_settings ->> 'maxRounds')::integer, 6), 1), 20),
        v_now + make_interval(secs => least(greatest(coalesce((p_settings ->> 'sessionTtlSeconds')::integer, 1209600), 1), 7776000)))
      ON CONFLICT DO NOTHING;
      SELECT * INTO v_session FROM trustwork.negotiation_session s WHERE s.context_kind = v_ctx_kind AND s.context_id = v_ctx_id AND s.status = 'open'
        AND (((s.party_a_kind, s.party_a_id) = (v_s_kind, v_s_id) AND (s.party_b_kind, s.party_b_id) = (v_r_kind, v_r_id))
          OR ((s.party_b_kind, s.party_b_id) = (v_s_kind, v_s_id) AND (s.party_a_kind, s.party_a_id) = (v_r_kind, v_r_id))) FOR UPDATE;
      v_has_session := FOUND;
    ELSE
      RAISE EXCEPTION 'a negotiation starts with a proposal or a counter' USING ERRCODE = 'check_violation', HINT = 'negotiation.no_session';
    END IF;
  END IF;
  IF v_has_session AND v_intent IN ('propose', 'counter', 'accept', 'decline', 'withdraw', 'request_confirmation') THEN
    IF v_session.status = 'open' AND v_session.expires_at <= v_now THEN
      UPDATE trustwork.negotiation_session SET status = 'expired', escalation_reason = 'expired', turn_kind = NULL, turn_id = NULL WHERE id = v_session.id;
      PERFORM trustwork.agents_escalate(v_session.party_a_kind, v_session.party_a_id, 'session_expired', NULL, v_session.id, NULL, v_ctx_kind, v_ctx_id, NULL);
      PERFORM trustwork.agents_escalate(v_session.party_b_kind, v_session.party_b_id, 'session_expired', NULL, v_session.id, NULL, v_ctx_kind, v_ctx_id, NULL);
      RETURN QUERY SELECT NULL::uuid, v_session.id, 'not_delivered'::text, 'session_expired'::text;
      RETURN;
    END IF;
    IF v_session.status <> 'open' THEN
      RAISE EXCEPTION 'the negotiation session is closed' USING ERRCODE = 'check_violation', HINT = 'negotiation.closed';
    END IF;
    IF v_intent IN ('propose', 'counter') THEN
      IF v_session.turn_kind IS NOT NULL AND (v_session.turn_kind, v_session.turn_id) <> (v_s_kind, v_s_id) THEN
        RAISE EXCEPTION 'the other party has the next move' USING ERRCODE = 'check_violation', HINT = 'negotiation.not_your_turn';
      END IF;
      IF v_session.rounds_used + 1 > v_session.max_rounds THEN
        UPDATE trustwork.negotiation_session SET status = 'escalated', escalation_reason = 'rounds_exhausted', turn_kind = NULL, turn_id = NULL WHERE id = v_session.id;
        PERFORM trustwork.agents_escalate(v_session.party_a_kind, v_session.party_a_id, 'rounds_exhausted', NULL, v_session.id, NULL, v_ctx_kind, v_ctx_id, v_intent);
        PERFORM trustwork.agents_escalate(v_session.party_b_kind, v_session.party_b_id, 'rounds_exhausted', NULL, v_session.id, NULL, v_ctx_kind, v_ctx_id, v_intent);
        RETURN QUERY SELECT NULL::uuid, v_session.id, 'not_delivered'::text, 'rounds_exhausted'::text;
        RETURN;
      END IF;
      UPDATE trustwork.negotiation_session SET rounds_used = rounds_used + 1, turn_kind = v_r_kind, turn_id = v_r_id WHERE id = v_session.id RETURNING * INTO v_session;
    ELSIF v_intent = 'accept' THEN
      IF v_session.turn_kind IS NULL OR (v_session.turn_kind, v_session.turn_id) <> (v_s_kind, v_s_id) THEN
        RAISE EXCEPTION 'only the other side''s last proposal can be accepted' USING ERRCODE = 'check_violation', HINT = 'negotiation.not_your_turn';
      END IF;
      -- Agreement is never formed here: the people on both sides confirm through the commercial acceptance (COM-002).
      UPDATE trustwork.negotiation_session SET status = 'agreed_pending_confirmation', escalation_reason = 'agreement_needs_confirmation', turn_kind = NULL, turn_id = NULL
      WHERE id = v_session.id RETURNING * INTO v_session;
    ELSIF v_intent = 'decline' THEN
      UPDATE trustwork.negotiation_session SET status = 'declined', turn_kind = NULL, turn_id = NULL WHERE id = v_session.id RETURNING * INTO v_session;
    ELSIF v_intent = 'withdraw' THEN
      UPDATE trustwork.negotiation_session SET status = 'withdrawn', turn_kind = NULL, turn_id = NULL WHERE id = v_session.id RETURNING * INTO v_session;
    END IF;
  END IF;

  INSERT INTO trustwork.agent_envelope (session_id, from_kind, from_id, from_person_id, actor_kind, actor_label_key, accountable_person_id, to_kind, to_id, context_kind, context_id,
    intent, refs, note_text, note_locale, mandate_proof, home_node, created_at, expires_at)
  VALUES (CASE WHEN v_has_session THEN v_session.id END, v_s_kind, v_s_id, v_from_person, v_actor_kind, v_label, v_accountable, v_r_kind, v_r_id, v_ctx_kind, v_ctx_id,
    v_intent, v_refs, v_note, p_envelope ->> 'noteLocale', p_envelope -> 'proof', p_envelope ->> 'homeNode', v_now, v_expires)
  RETURNING id INTO v_envelope;
  INSERT INTO trustwork.agent_envelope_sender (envelope_id, sender_kind, sender_id, sent_by_person_id, mandate_id, mandate_revision, company_mandate_id)
  VALUES (v_envelope, v_s_kind, v_s_id, v_person, v_mandate.id, v_mandate.revision, v_cm.id);
  IF v_has_session AND v_session.status = 'agreed_pending_confirmation' THEN
    PERFORM trustwork.agents_escalate(v_session.party_a_kind, v_session.party_a_id, 'agreement_needs_confirmation', v_envelope, v_session.id, NULL, v_ctx_kind, v_ctx_id, v_intent);
    PERFORM trustwork.agents_escalate(v_session.party_b_kind, v_session.party_b_id, 'agreement_needs_confirmation', v_envelope, v_session.id, NULL, v_ctx_kind, v_ctx_id, v_intent);
  END IF;

  -- 5. The receiver's own mandate decision on the structured intent (the note plays no part).
  v_receiver_action := trustwork.agents_receiver_action(v_intent);
  IF v_receiver_action = 'informational' THEN
    v_receipt_decision := 'informational'; v_receipt_reason := 'informational';
  ELSIF v_receiver_action = 'human' THEN
    v_receipt_decision := 'escalated'; v_receipt_reason := 'human_only';
  ELSIF v_r_kind = 'person' THEN
    v_receipt_reason := 'outside_mandate';
    FOR v_candidate IN SELECT * FROM trustwork.mandate m WHERE m.principal_person_id = v_r_id AND m.grantee_kind = 'own_agent' AND m.on_behalf_company_id IS NULL AND m.status = 'active'
      ORDER BY m.id LOOP
      v_cover := trustwork.agents_mandate_covers(v_candidate, v_receiver_action, v_modules, v_ctx_kind, v_ctx_id::text);
      IF v_cover = 'allow' THEN
        v_receipt_reason := 'covered'; v_receipt_mandate := v_candidate.id;
        EXIT;
      ELSIF v_cover = 'ask' THEN
        v_receipt_reason := 'needs_approval'; v_receipt_mandate := v_candidate.id;
      END IF;
    END LOOP;
    IF v_receipt_reason = 'covered' AND trustwork.assistant_dispatch_blocked(v_hub, 'negotiation', v_receiver_action, v_r_id, NULL) IS NOT NULL THEN
      v_receipt_reason := 'dispatch_blocked';
    END IF;
    v_receipt_decision := CASE WHEN v_receipt_reason = 'covered' THEN 'within_mandate' ELSE 'escalated' END;
  ELSE
    SELECT * INTO v_rep FROM trustwork.company_representative WHERE company_id = v_r_id;
    IF NOT FOUND OR v_rep.status <> 'active' THEN
      v_receipt_reason := 'no_representative';
    ELSE
      v_receipt_reason := 'outside_mandate';
      FOR v_candidate_cm IN SELECT * FROM trustwork.company_mandate cm WHERE cm.representative_id = v_rep.id AND cm.status = 'active' ORDER BY cm.id LOOP
        v_cover := trustwork.agents_company_mandate_decision(v_candidate_cm, v_receiver_action, v_modules, v_ctx_kind, v_ctx_id::text);
        IF v_cover = 'allow' THEN
          v_receipt_reason := 'covered'; v_receipt_mandate := v_candidate_cm.mandate_id;
          EXIT;
        ELSIF v_cover = 'ask' THEN
          v_receipt_reason := 'needs_approval'; v_receipt_mandate := v_candidate_cm.mandate_id;
        END IF;
      END LOOP;
      IF v_receipt_reason = 'covered' AND (trustwork.assistant_dispatch_blocked(v_hub, 'representative', v_receiver_action, NULL, NULL) IS NOT NULL
                                           OR trustwork.assistant_dispatch_blocked(v_hub, 'negotiation', v_receiver_action, NULL, NULL) IS NOT NULL) THEN
        v_receipt_reason := 'dispatch_blocked';
      END IF;
    END IF;
    v_receipt_decision := CASE WHEN v_receipt_reason = 'covered' THEN 'within_mandate' ELSE 'escalated' END;
  END IF;
  INSERT INTO trustwork.agent_envelope_receipt (envelope_id, receiver_kind, receiver_id, decision, reason, mandate_id)
  VALUES (v_envelope, v_r_kind, v_r_id, v_receipt_decision, v_receipt_reason, v_receipt_mandate);
  IF v_receipt_decision = 'escalated' AND NOT (v_has_session AND v_session.status = 'agreed_pending_confirmation') THEN
    PERFORM trustwork.agents_escalate(v_r_kind, v_r_id, CASE WHEN v_intent = 'request_confirmation' THEN 'confirmation_requested' ELSE 'inbound_needs_decision' END,
      v_envelope, CASE WHEN v_has_session THEN v_session.id END, NULL, v_ctx_kind, v_ctx_id, v_intent);
  END IF;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('agent_envelope', v_envelope::text, 1, 'agents.envelope_delivered', jsonb_build_object('envelopeId', v_envelope, 'toKind', v_r_kind, 'toId', v_r_id));
  RETURN QUERY SELECT v_envelope, CASE WHEN v_has_session THEN v_session.id END, 'delivered'::text, NULL::text;
END $$;

-- 7. Membership hook: authority that depended on a membership stops in the membership's own transaction -------------------
-- Fires when an active membership ends or loses company.deals.manage. Internal SECURITY DEFINER trigger function (the
-- runtime role cannot read other people's mandates); nobody may call it directly.
CREATE FUNCTION trustwork.agents_membership_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_left boolean := NEW.status <> 'active';
  v_cm trustwork.company_mandate%ROWTYPE;
  v_rep trustwork.company_representative%ROWTYPE;
BEGIN
  -- 1. AST-001: the person's own company mandates and those granted to them (principal or grantee) end with the
  --    membership. Called here so the narrowing happens in the membership's transaction.
  IF v_left THEN
    PERFORM trustwork.assistant_revoke_for_basis(NEW.person_id, NEW.company_id, 'membership ' || NEW.id::text || ' ended');
  END IF;
  -- 2. Colleague mandates this person's agent executes stop now.
  IF v_left THEN
    FOR v_cm IN SELECT * FROM trustwork.company_mandate WHERE company_id = NEW.company_id AND executor_person_id = NEW.person_id AND status <> 'revoked' ORDER BY id FOR UPDATE LOOP
      PERFORM trustwork.agents_stop_company_mandate(v_cm.id, 'revoked', 'executor_left', NULL);
    END LOOP;
  END IF;
  -- 3. Company mandates this person granted stop now and wait 7 days for another authorized member's re-confirmation.
  FOR v_cm IN SELECT * FROM trustwork.company_mandate WHERE company_id = NEW.company_id AND granted_by_person_id = NEW.person_id AND status = 'active' ORDER BY id FOR UPDATE LOOP
    PERFORM trustwork.agents_stop_company_mandate(v_cm.id, 'awaiting_reconfirmation', CASE WHEN v_left THEN 'granter_left' ELSE 'granter_authority_lost' END, clock_timestamp() + interval '7 days');
  END LOOP;
  -- 4. The accountable person of the representative: the representative suspends until another member accepts.
  SELECT * INTO v_rep FROM trustwork.company_representative WHERE company_id = NEW.company_id AND accountable_person_id = NEW.person_id AND status <> 'disabled' FOR UPDATE;
  IF FOUND THEN
    UPDATE trustwork.representative_accountability SET to_at = clock_timestamp(), ended_reason = CASE WHEN v_left THEN 'left_company' ELSE 'authority_lost' END
    WHERE representative_id = v_rep.id AND to_at IS NULL;
    UPDATE trustwork.company_representative SET accountable_person_id = NULL, accepted_at = NULL, status = 'suspended',
      suspension_reason = CASE WHEN v_rep.status = 'suspended' AND v_rep.suspension_reason = 'admin_suspended' THEN 'admin_suspended' ELSE 'no_accountable_person' END
    WHERE id = v_rep.id;
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
    VALUES ('company_representative', v_rep.id::text, v_rep.revision + 1, 'agents.representative_suspended', jsonb_build_object('companyId', NEW.company_id, 'reason', 'no_accountable_person'));
  END IF;
  PERFORM trustwork.agents_refresh_representative(NEW.company_id);
  RETURN NULL;
END $$;
CREATE TRIGGER agents_membership_authority AFTER UPDATE OF status, permissions ON trustwork.membership FOR EACH ROW
  WHEN (OLD.status = 'active' AND (NEW.status <> 'active' OR ('company.deals.manage' = ANY (OLD.permissions) AND NOT ('company.deals.manage' = ANY (NEW.permissions)))))
  EXECUTE FUNCTION trustwork.agents_membership_changed();

-- 8. Row-level security, grants ---------------------------------------------------------------------------------------
ALTER TABLE trustwork.goal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.goal FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.goal_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.goal_progress FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.job_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.job_subscription FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_report FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_representative ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_representative FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.representative_accountability ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.representative_accountability FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_mandate ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_mandate FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.negotiation_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.negotiation_session FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_envelope ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_envelope FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_envelope_sender ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_envelope_sender FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_envelope_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_envelope_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_escalation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_escalation FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.goal AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.goal_progress AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.job_subscription AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_report AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.company_representative AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.representative_accountability AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.company_mandate AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.negotiation_session AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_envelope AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_envelope_sender AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_envelope_receipt AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_escalation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

CREATE POLICY goal_read ON trustwork.goal FOR SELECT TO trustwork_app USING (principal_person_id = trustwork.current_person_id());
CREATE POLICY goal_insert ON trustwork.goal FOR INSERT TO trustwork_app
  WITH CHECK (principal_person_id = trustwork.current_person_id() AND (on_behalf_company_id IS NULL OR on_behalf_company_id = trustwork.current_company_id()));
CREATE POLICY goal_progress_read ON trustwork.goal_progress FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.goal g WHERE g.id = goal_id));
CREATE POLICY goal_progress_insert ON trustwork.goal_progress FOR INSERT TO trustwork_app
  WITH CHECK (recorded_by_person_id = trustwork.current_person_id() AND EXISTS (SELECT 1 FROM trustwork.goal g WHERE g.id = goal_id AND g.status <> 'closed'));
CREATE POLICY job_subscription_read ON trustwork.job_subscription FOR SELECT TO trustwork_app USING (principal_person_id = trustwork.current_person_id());
CREATE POLICY job_subscription_insert ON trustwork.job_subscription FOR INSERT TO trustwork_app
  WITH CHECK (principal_person_id = trustwork.current_person_id() AND (on_behalf_company_id IS NULL OR on_behalf_company_id = trustwork.current_company_id()));
CREATE POLICY job_subscription_update ON trustwork.job_subscription FOR UPDATE TO trustwork_app
  USING (principal_person_id = trustwork.current_person_id()) WITH CHECK (principal_person_id = trustwork.current_person_id());
CREATE POLICY agent_report_read ON trustwork.agent_report FOR SELECT TO trustwork_app
  USING (author_person_id = trustwork.current_person_id() OR trustwork.current_person_id() = ANY (shared_with));
CREATE POLICY agent_report_insert ON trustwork.agent_report FOR INSERT TO trustwork_app
  WITH CHECK (author_person_id = trustwork.current_person_id() AND (principal_company_id IS NULL OR (principal_company_id = trustwork.current_company_id() AND trustwork.current_membership_has('company.deals.manage'))));
CREATE POLICY company_representative_read ON trustwork.company_representative FOR SELECT TO trustwork_app
  USING (company_id = trustwork.current_company_id() OR accountable_person_id = trustwork.current_person_id());
CREATE POLICY representative_accountability_read ON trustwork.representative_accountability FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.company_representative r WHERE r.id = representative_id));
CREATE POLICY company_mandate_read ON trustwork.company_mandate FOR SELECT TO trustwork_app
  USING (trustwork.agents_party_acts('company', company_id) OR executor_person_id = trustwork.current_person_id());
CREATE POLICY negotiation_session_read ON trustwork.negotiation_session FOR SELECT TO trustwork_app
  USING (trustwork.agents_party_acts(party_a_kind, party_a_id) OR trustwork.agents_party_acts(party_b_kind, party_b_id));
CREATE POLICY agent_envelope_read ON trustwork.agent_envelope FOR SELECT TO trustwork_app
  USING (trustwork.agents_party_acts(from_kind, from_id) OR trustwork.agents_party_acts(to_kind, to_id)
    OR EXISTS (SELECT 1 FROM trustwork.agent_envelope_sender s WHERE s.envelope_id = id AND s.sent_by_person_id = trustwork.current_person_id()));
CREATE POLICY agent_envelope_sender_read ON trustwork.agent_envelope_sender FOR SELECT TO trustwork_app
  USING (trustwork.agents_party_acts(sender_kind, sender_id) OR sent_by_person_id = trustwork.current_person_id());
CREATE POLICY agent_envelope_receipt_read ON trustwork.agent_envelope_receipt FOR SELECT TO trustwork_app USING (trustwork.agents_party_acts(receiver_kind, receiver_id));
CREATE POLICY agent_escalation_read ON trustwork.agent_escalation FOR SELECT TO trustwork_app USING (trustwork.agents_party_acts(owner_kind, owner_id));

GRANT SELECT ON trustwork.goal, trustwork.goal_progress, trustwork.job_subscription, trustwork.agent_report, trustwork.company_representative, trustwork.representative_accountability,
  trustwork.company_mandate, trustwork.negotiation_session, trustwork.agent_envelope, trustwork.agent_envelope_sender, trustwork.agent_envelope_receipt, trustwork.agent_escalation TO trustwork_app;
GRANT INSERT ON trustwork.goal, trustwork.goal_progress, trustwork.job_subscription, trustwork.agent_report TO trustwork_app;
GRANT UPDATE (status) ON trustwork.job_subscription TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.agents_party_acts(text, uuid) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.agents_confirm_goal(uuid, text, boolean), trustwork.agents_set_goal_status(uuid, integer, text, text), trustwork.agents_share_report(uuid, uuid[]),
  trustwork.agents_configure_representative(uuid, uuid, integer), trustwork.agents_accept_representative(uuid), trustwork.agents_suspend_representative(uuid),
  trustwork.agents_resume_representative(uuid, integer), trustwork.agents_disable_representative(uuid), trustwork.agents_grant_company_mandate(uuid, jsonb, text),
  trustwork.agents_reconfirm_company_mandate(uuid, uuid, text), trustwork.agents_revoke_company_mandate(uuid, integer), trustwork.agents_resolve_escalation(uuid, text),
  trustwork.agents_deliver_envelope(jsonb, jsonb, jsonb) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.agents_lapse_reconfirmations(integer), trustwork.agents_expire_sessions(integer) TO trustwork_worker;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
