-- AST-001: durable mandates and agent action workflow (docs/engine/agents.md, docs/engine/modules/agent.md,
-- docs/data/model.md section 21, docs/data/lifecycles.md). Mirrors packages/contracts/src/assistant.ts (frozen v1
-- states, outcomes, reconciliation) and packages/contracts/src/agent-catalog.ts (MandateV2, proposals, stop controls).
--
-- Authority rules carried by this file, for every role including the owner-run commands:
--   * a mandate is confirmed only by its principal, inside the principal's own transaction (set_principal), with a
--     first-party confirmation that names the principal; agents, connections and chat only ever insert inert
--     proposals (`mandate_proposal`), which change nothing until the principal confirms them;
--   * a mandate never outlives its authority basis: company mandates end when the membership ends
--     (`assistant_revoke_for_basis`, called by the identity hook) and every dispatch rechecks status, revision,
--     expiry, the active membership, stop controls, kill switches, approvals and reservations;
--   * approvals bind the exact action digest and the mandate revision; `confirm_execution` and `approve` are never
--     authorized without an approval, and money and human-only actions need a recent authentication (step-up);
--   * operation and attempt identity are persisted before an external call (`assistant_begin_attempt`), outcomes are
--     fenced by the job's fencing token, and an ambiguous or crashed call becomes `outcome_unknown`, which keeps the
--     reservation and only a reconciliation record (provider lookup or receipt) turns into a final outcome. Nothing
--     is ever replayed blindly; acknowledged (`pending`) is not success.
--
-- Money: reservations are taken through BILL-001's `billing_reserve` inside the principal's transaction; outcomes
-- settle or release them here with the same rules as `billing_settle`/`billing_release` (evidence required, never above
-- the reservation), because the worker that observes the outcome holds no principal. Trustwork never holds money.
--
-- Privacy: every table is under FORCE RLS and readable only by the principal. The worker role holds no table grant;
-- it reaches the runtime only through the worker entry points below, which return the structured effect (provider,
-- operation, payload already stripped of private constraints by the API) and never limits, conditions or budgets.

-- 0. Helpers -----------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.assistant_iso(p_ts timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
CREATE FUNCTION trustwork.assistant_budget_kind(p_action text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE WHEN p_action IN ('place_order', 'accept_order', 'register', 'release_payment') THEN 'transaction'
              WHEN p_action = 'generate_deliverable' THEN 'platform' ELSE NULL END
$$;
CREATE FUNCTION trustwork.assistant_needs_step_up(p_action text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT p_action IN ('confirm_execution', 'approve') OR trustwork.assistant_budget_kind(p_action) IS NOT NULL
$$;

-- 1. Mandates ----------------------------------------------------------------------------------------------------------
-- The current confirmed revision of a mandate. Drafts are proposals (below), never rows here. `snapshot` is the
-- MandateV2 of the current revision; `digest` is the trustwork-digest-1 of the snapshot the principal confirmed (NULL for
-- revisions produced by narrowing: suspension, revocation, expiry).
CREATE TABLE trustwork.mandate (
  id uuid PRIMARY KEY,
  principal_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  on_behalf_company_id uuid NULL REFERENCES trustwork.company (id),
  grantee_kind text NOT NULL CHECK (grantee_kind IN ('own_agent', 'colleague_agent', 'company_representative')),
  grantee_person_id uuid NULL REFERENCES trustwork.person (id),
  grantee_company_id uuid NULL REFERENCES trustwork.company (id),
  module_keys text[] NOT NULL CHECK (cardinality(module_keys) BETWEEN 1 AND 50),
  actions text[] NOT NULL CHECK (cardinality(actions) >= 1 AND actions <@ ARRAY['prepare', 'research', 'communicate', 'send_quote', 'negotiate', 'place_order', 'accept_order',
    'generate_deliverable', 'introduce', 'schedule', 'maintain_profile', 'publish', 'register', 'record_evidence', 'confirm_execution', 'approve', 'release_payment', 'maintain_records']::text[]),
  revision integer NOT NULL CHECK (revision >= 1),
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  status_reason text NULL CHECK (status_reason IS NULL OR length(status_reason) BETWEEN 1 AND 500),
  valid_until timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  digest text NULL CHECK (digest IS NULL OR digest ~ '^[a-f0-9]{64}$'),
  confirmed_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  confirmed_at timestamptz NOT NULL,
  confirmed_step_up boolean NOT NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mandate_confirmed_by_principal CHECK (confirmed_by_person_id = principal_person_id),
  CONSTRAINT mandate_revoked_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT mandate_grantee_shape CHECK (CASE grantee_kind
    WHEN 'own_agent' THEN grantee_person_id IS NULL AND grantee_company_id IS NULL
    WHEN 'colleague_agent' THEN grantee_person_id IS NOT NULL AND grantee_company_id IS NOT NULL AND grantee_company_id = on_behalf_company_id
    ELSE grantee_person_id IS NULL AND grantee_company_id IS NOT NULL AND grantee_company_id = on_behalf_company_id END),
  CONSTRAINT mandate_snapshot_matches CHECK ((snapshot ->> 'id') = id::text AND (snapshot ->> 'revision')::integer = revision AND (snapshot ->> 'status') = status
    AND (snapshot -> 'principal' ->> 'personId') = principal_person_id::text)
);
CREATE INDEX mandate_principal_idx ON trustwork.mandate (principal_person_id, status);
CREATE INDEX mandate_company_idx ON trustwork.mandate (on_behalf_company_id) WHERE on_behalf_company_id IS NOT NULL;

-- Contexts of the current revision as rows, so a lost context basis is found by query. A row is an exact reference or
-- a standing selector (categories, regions, project) resolved at action time.
CREATE TABLE trustwork.mandate_context (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  mandate_id uuid NOT NULL REFERENCES trustwork.mandate (id),
  context_kind text NOT NULL CHECK (context_kind IN ('project', 'rfq', 'quote', 'agreement', 'order', 'introduction', 'open_need', 'partner_post', 'event', 'course',
    'publication', 'profile', 'catalogue_offering', 'opportunity', 'company', 'plan_item', 'consultation', 'task_request', 'goal')),
  context_id text NULL CHECK (context_id IS NULL OR context_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  selector jsonb NULL CHECK (selector IS NULL OR jsonb_typeof(selector) = 'object'),
  CONSTRAINT mandate_context_shape CHECK ((context_id IS NULL) <> (selector IS NULL))
);
CREATE INDEX mandate_context_mandate_idx ON trustwork.mandate_context (mandate_id);
CREATE INDEX mandate_context_ref_idx ON trustwork.mandate_context (context_kind, context_id) WHERE context_id IS NOT NULL;

-- History: what was authorized when. Approvals and actions bind (mandate_id, revision).
CREATE TABLE trustwork.mandate_revision (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  mandate_id uuid NOT NULL REFERENCES trustwork.mandate (id),
  revision integer NOT NULL CHECK (revision >= 1),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  snapshot jsonb NOT NULL,
  digest text NULL CHECK (digest IS NULL OR digest ~ '^[a-f0-9]{64}$'),
  change_kind text NOT NULL CHECK (change_kind IN ('confirm', 'narrow', 'system')),
  changed_by_person_id uuid NULL REFERENCES trustwork.person (id),
  reason text NULL CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (mandate_id, revision),
  CONSTRAINT mandate_revision_confirm_shape CHECK (change_kind <> 'confirm' OR (digest IS NOT NULL AND changed_by_person_id = principal_person_id))
);
CREATE TRIGGER mandate_revision_append_only BEFORE UPDATE OR DELETE ON trustwork.mandate_revision FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Proposed mandate changes (MandateChangeProposalSchema). Agents, chat intents, goals, module templates, connections and
-- settings produce these; the proposed mandate is an inert draft until the principal confirms it on the first-party form.
CREATE TABLE trustwork.mandate_proposal (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  mandate_id uuid NULL,
  basis_revision integer NULL CHECK (basis_revision IS NULL OR basis_revision >= 1),
  origin_kind text NOT NULL CHECK (origin_kind IN ('chat_intent', 'agent', 'module_template', 'goal', 'connection', 'settings')),
  origin jsonb NOT NULL CHECK (jsonb_typeof(origin) = 'object'),
  proposed jsonb NOT NULL CHECK (jsonb_typeof(proposed) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'expired', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz NULL,
  decided_by_person_id uuid NULL REFERENCES trustwork.person (id),
  CONSTRAINT mandate_proposal_basis CHECK ((mandate_id IS NULL) = (basis_revision IS NULL)),
  CONSTRAINT mandate_proposal_inert CHECK ((proposed ->> 'status') = 'draft' AND jsonb_typeof(proposed -> 'confirmation') = 'null'
    AND (proposed -> 'principal' ->> 'personId') = principal_person_id::text),
  CONSTRAINT mandate_proposal_decided CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX mandate_proposal_principal_idx ON trustwork.mandate_proposal (principal_person_id, status);
CREATE FUNCTION trustwork.assistant_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a proposal is born pending' USING ERRCODE = 'check_violation', HINT = 'mandate.proposal_not_pending';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'proposals are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF OLD.status <> 'pending' OR ROW(NEW.id, NEW.principal_person_id, NEW.mandate_id, NEW.basis_revision, NEW.origin_kind, NEW.origin, NEW.proposed, NEW.digest, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.principal_person_id, OLD.mandate_id, OLD.basis_revision, OLD.origin_kind, OLD.origin, OLD.proposed, OLD.digest, OLD.created_at) THEN
    RAISE EXCEPTION 'a decided proposal is final and its content never changes' USING ERRCODE = 'check_violation', HINT = 'mandate.proposal_not_pending';
  END IF;
  -- Confirmation happens only inside assistant_confirm_mandate (owner-run); the principal may decline directly.
  IF NEW.status = 'confirmed' AND NOT trustwork.in_maintenance() THEN
    RAISE EXCEPTION 'a proposal is confirmed only through the first-party confirmation' USING ERRCODE = 'insufficient_privilege', HINT = 'mandate.proposal_only';
  END IF;
  IF NEW.status IN ('declined', 'confirmed') AND NEW.decided_by_person_id IS DISTINCT FROM trustwork.current_person_id() AND NOT trustwork.in_maintenance() THEN
    RAISE EXCEPTION 'only the principal decides a proposal' USING ERRCODE = 'insufficient_privilege', HINT = 'mandate.not_principal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mandate_proposal_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.mandate_proposal FOR EACH ROW EXECUTE FUNCTION trustwork.assistant_proposal_guard();

-- Authorizations consumed under a mandate (both run intents and synchronous module checks): the cumulative ceiling,
-- the per-window count and ask-first counts are computed from these rows under the mandate row lock.
CREATE TABLE trustwork.mandate_use (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  mandate_id uuid NOT NULL REFERENCES trustwork.mandate (id),
  mandate_revision integer NOT NULL,
  action_intent_id uuid NULL,
  action text NOT NULL,
  amount_minor bigint NULL CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency text NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  approved boolean NOT NULL DEFAULT false,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_at timestamptz NULL,
  CONSTRAINT mandate_use_money CHECK ((amount_minor IS NULL) = (currency IS NULL))
);
CREATE INDEX mandate_use_mandate_idx ON trustwork.mandate_use (mandate_id, used_at);

-- Participant stop control (ParticipantStopSchema). This slice ships the person's own stop; representative and
-- connection stops arrive with AGT-001 and the MCP packages.
CREATE TABLE trustwork.participant_stop (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('person_stop')),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  state text NOT NULL DEFAULT 'engaged' CHECK (state IN ('engaged', 'released')),
  engaged_by uuid NOT NULL REFERENCES trustwork.person (id),
  engaged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz NULL,
  CONSTRAINT participant_stop_own CHECK (engaged_by = person_id),
  CONSTRAINT participant_stop_release_shape CHECK ((state = 'released') = (released_at IS NOT NULL))
);
CREATE UNIQUE INDEX participant_stop_one_engaged ON trustwork.participant_stop (person_id, scope_kind) WHERE state = 'engaged';

-- 2. Runs and steps ----------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.run (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  mandate_id uuid NULL REFERENCES trustwork.mandate (id),
  goal_id uuid NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('queued', 'running', 'waiting_approval', 'waiting_event', 'completed', 'failed', 'cancelled')),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  cost_counters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cost_counters) = 'object'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz NULL,
  ended_reason text NULL CHECK (ended_reason IS NULL OR length(ended_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_ended_shape CHECK ((state IN ('completed', 'failed', 'cancelled')) = (ended_at IS NOT NULL))
);
CREATE INDEX run_principal_idx ON trustwork.run (principal_person_id, created_at DESC);
CREATE FUNCTION trustwork.assistant_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'runs are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('queued', 'running') THEN
      RAISE EXCEPTION 'a run starts queued or running' USING ERRCODE = 'check_violation', HINT = 'assistant.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.principal_person_id, NEW.mandate_id, NEW.goal_id, NEW.kind, NEW.started_at) IS DISTINCT FROM ROW(OLD.id, OLD.principal_person_id, OLD.mandate_id, OLD.goal_id, OLD.kind, OLD.started_at) THEN
    RAISE EXCEPTION 'a run keeps its principal, mandate and kind' USING ERRCODE = 'integrity_constraint_violation', HINT = 'assistant.immutable';
  END IF;
  IF OLD.state IN ('completed', 'failed', 'cancelled') AND (NEW.state <> OLD.state OR NEW.ended_at IS DISTINCT FROM OLD.ended_at) THEN
    RAISE EXCEPTION 'a finished run is final' USING ERRCODE = 'check_violation', HINT = 'assistant.invalid_transition';
  END IF;
  -- Cancelling revokes the run's pending intents and releases their reservations: only assistant_cancel_run does that.
  IF NEW.state = 'cancelled' AND OLD.state <> 'cancelled' AND NOT trustwork.in_maintenance() THEN
    RAISE EXCEPTION 'cancel a run through assistant_cancel_run' USING ERRCODE = 'insufficient_privilege', HINT = 'assistant.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.run FOR EACH ROW EXECUTE FUNCTION trustwork.assistant_run_guard();
CREATE TRIGGER run_touch BEFORE UPDATE ON trustwork.run FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Append-only activity log of a run: decisions, model and tool calls, checkpoints. Inputs by digest, outputs by
-- reference; never the model's private reasoning.
CREATE TABLE trustwork.run_step (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  run_id uuid NOT NULL REFERENCES trustwork.run (id),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (kind IN ('tool_call', 'model_call', 'decision', 'checkpoint')),
  tool text NULL CHECK (tool IS NULL OR tool ~ '^[a-z][a-z0-9_.]{1,100}$'),
  input_digest text NULL CHECK (input_digest IS NULL OR input_digest ~ '^[a-f0-9]{64}$'),
  output_ref jsonb NULL CHECK (output_ref IS NULL OR jsonb_typeof(output_ref) = 'object'),
  state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'allowed', 'asked', 'denied', 'recorded')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz NULL
);
CREATE INDEX run_step_run_idx ON trustwork.run_step (run_id, seq);
CREATE TRIGGER run_step_append_only BEFORE UPDATE OR DELETE ON trustwork.run_step FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Action intents, attempts, outcomes, approvals and reconciliation ---------------------------------------------------
CREATE TABLE trustwork.action_intent (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  run_id uuid NULL REFERENCES trustwork.run (id),
  origin text NOT NULL CHECK (origin IN ('run', 'module_check')),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  mandate_id uuid NOT NULL REFERENCES trustwork.mandate (id),
  mandate_revision integer NOT NULL CHECK (mandate_revision >= 1),
  capability_id text NOT NULL CHECK (capability_id ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' AND length(capability_id) <= 100),
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  action text NOT NULL,
  context_kind text NOT NULL,
  context_id text NOT NULL CHECK (context_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  resolved_from_selector boolean NOT NULL DEFAULT false,
  amount_minor bigint NULL CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency text NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  ask_reasons text[] NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('proposed', 'authorized', 'reserved', 'queued', 'executing', 'pending', 'succeeded', 'failed', 'outcome_unknown', 'reconciling', 'revoked')),
  state_reason text NULL CHECK (state_reason IS NULL OR length(state_reason) BETWEEN 1 AND 200),
  reservation_id uuid NULL REFERENCES trustwork.reservation (id),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  effect_correlation_key text NOT NULL UNIQUE CHECK (length(effect_correlation_key) BETWEEN 1 AND 200),
  -- The structured effect handed to the provider adapter: {"provider", "operation", "payload"}. Built by the API from
  -- first-party records with private constraints removed; never free text from chat, files or other agents.
  effect jsonb NULL CHECK (effect IS NULL OR (jsonb_typeof(effect) = 'object' AND effect ? 'provider' AND effect ? 'operation' AND effect ? 'payload')),
  outcome_kind text NULL CHECK (outcome_kind IS NULL OR outcome_kind IN ('unknown', 'acknowledged', 'final')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT action_intent_money CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  CONSTRAINT action_intent_origin CHECK ((origin = 'run') = (run_id IS NOT NULL)),
  CONSTRAINT action_intent_run_effect CHECK (origin <> 'run' OR effect IS NOT NULL),
  CONSTRAINT action_intent_budget_held CHECK (trustwork.assistant_budget_kind(action) IS NULL OR state NOT IN ('reserved', 'queued', 'executing', 'pending', 'succeeded', 'outcome_unknown', 'reconciling') OR reservation_id IS NOT NULL)
);
CREATE INDEX action_intent_principal_idx ON trustwork.action_intent (principal_person_id, state);
CREATE INDEX action_intent_run_idx ON trustwork.action_intent (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX action_intent_mandate_idx ON trustwork.action_intent (mandate_id, state);
CREATE INDEX action_intent_digest_idx ON trustwork.action_intent (mandate_id, mandate_revision, action_digest) WHERE state = 'proposed';

-- actionTransitionAllowed (packages/contracts/src/assistant.ts) for every role, plus immutable terms. `failed -> queued`
-- (safely retryable) is not offered by this runtime: a new intent is proposed instead.
CREATE FUNCTION trustwork.assistant_intent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'action intents are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('proposed', 'authorized') OR NEW.attempt_count <> 0 OR NEW.reservation_id IS NOT NULL OR NEW.outcome_kind IS NOT NULL THEN
      RAISE EXCEPTION 'an intent is born proposed or authorized' USING ERRCODE = 'check_violation', HINT = 'assistant.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.run_id, NEW.origin, NEW.principal_person_id, NEW.mandate_id, NEW.mandate_revision, NEW.capability_id, NEW.module_key, NEW.action, NEW.context_kind, NEW.context_id,
         NEW.resolved_from_selector, NEW.amount_minor, NEW.currency, NEW.action_digest, NEW.effect_correlation_key, NEW.effect, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.run_id, OLD.origin, OLD.principal_person_id, OLD.mandate_id, OLD.mandate_revision, OLD.capability_id, OLD.module_key, OLD.action, OLD.context_kind, OLD.context_id,
         OLD.resolved_from_selector, OLD.amount_minor, OLD.currency, OLD.action_digest, OLD.effect_correlation_key, OLD.effect, OLD.created_at) THEN
    RAISE EXCEPTION 'the terms of an action intent never change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'assistant.immutable';
  END IF;
  IF OLD.reservation_id IS NOT NULL AND NEW.reservation_id IS DISTINCT FROM OLD.reservation_id THEN
    RAISE EXCEPTION 'an intent keeps its reservation' USING ERRCODE = 'integrity_constraint_violation', HINT = 'assistant.immutable';
  END IF;
  IF NEW.state <> OLD.state THEN
    v_allowed := CASE OLD.state
      WHEN 'proposed' THEN ARRAY['authorized', 'revoked']
      WHEN 'authorized' THEN ARRAY['reserved', 'queued', 'revoked']
      WHEN 'reserved' THEN ARRAY['queued', 'revoked']
      WHEN 'queued' THEN ARRAY['executing', 'revoked']
      WHEN 'executing' THEN ARRAY['pending', 'succeeded', 'failed', 'outcome_unknown', 'revoked']
      WHEN 'pending' THEN ARRAY['succeeded', 'failed', 'outcome_unknown']
      WHEN 'outcome_unknown' THEN ARRAY['reconciling']
      WHEN 'reconciling' THEN ARRAY['succeeded', 'failed', 'outcome_unknown']
      ELSE ARRAY[]::text[] END;
    -- authorized -> queued only for actions that need no budget; executing -> revoked only when the pre-dispatch
    -- recheck refused before any call (the attempt is not persisted in that case, so this branch is unused).
    IF NOT (NEW.state = ANY (v_allowed)) OR (OLD.state = 'authorized' AND NEW.state = 'queued' AND trustwork.assistant_budget_kind(NEW.action) IS NOT NULL)
       OR (OLD.state = 'executing' AND NEW.state = 'revoked') THEN
      RAISE EXCEPTION 'action intent cannot move from % to %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'assistant.invalid_transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER action_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.action_intent FOR EACH ROW EXECUTE FUNCTION trustwork.assistant_intent_guard();
CREATE TRIGGER action_intent_touch BEFORE UPDATE ON trustwork.action_intent FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- One row per dispatch attempt, persisted before the external call. Each attempt has its own operation id and the
-- job's fencing token; every attempt reuses the intent's stable effect correlation key.
CREATE TABLE trustwork.action_attempt (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  action_intent_id uuid NOT NULL REFERENCES trustwork.action_intent (id),
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  operation_id uuid NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,40}$'),
  job_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 0),
  state text NOT NULL DEFAULT 'executing' CHECK (state IN ('executing', 'ended', 'abandoned')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz NULL,
  UNIQUE (action_intent_id, attempt_no),
  CONSTRAINT action_attempt_ended_shape CHECK ((state = 'executing') = (ended_at IS NULL))
);
CREATE INDEX action_attempt_executing_idx ON trustwork.action_attempt (job_id) WHERE state = 'executing';

CREATE TABLE trustwork.reconciliation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  action_intent_id uuid NOT NULL REFERENCES trustwork.action_intent (id),
  attempt_id uuid NOT NULL REFERENCES trustwork.action_attempt (id),
  operation_id uuid NOT NULL,
  lookup_reference text NOT NULL CHECK (length(lookup_reference) BETWEEN 1 AND 200),
  outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object' AND outcome ->> 'kind' IN ('unknown', 'acknowledged', 'final')),
  reconciled_by text NOT NULL CHECK (reconciled_by IN ('worker', 'staff')),
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reconciliation_intent_idx ON trustwork.reconciliation (action_intent_id);
CREATE TRIGGER reconciliation_append_only BEFORE UPDATE OR DELETE ON trustwork.reconciliation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- External outcomes (ExternalOutcomeSchema), append-only. outcomeTransitionAllowed: unknown -> final only through a
-- reconciliation record for this exact intent and attempt; nothing follows a final outcome.
CREATE TABLE trustwork.action_outcome (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  action_intent_id uuid NOT NULL REFERENCES trustwork.action_intent (id),
  attempt_id uuid NULL REFERENCES trustwork.action_attempt (id),
  kind text NOT NULL CHECK (kind IN ('unknown', 'acknowledged', 'final')),
  reason text NULL CHECK (reason IS NULL OR reason IN ('timeout', 'crash', 'lease_expired', 'ambiguous_response')),
  result text NULL CHECK (result IS NULL OR result IN ('succeeded', 'failed')),
  provider_reference text NULL CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 200),
  evidence text NULL CHECK (evidence IS NULL OR length(evidence) BETWEEN 1 AND 2000),
  reconciliation_id uuid NULL REFERENCES trustwork.reconciliation (id),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT action_outcome_shape CHECK (CASE kind
    WHEN 'unknown' THEN reason IS NOT NULL AND result IS NULL
    WHEN 'acknowledged' THEN provider_reference IS NOT NULL AND result IS NULL AND reason IS NULL
    ELSE result IS NOT NULL AND evidence IS NOT NULL AND reason IS NULL END)
);
CREATE INDEX action_outcome_intent_idx ON trustwork.action_outcome (action_intent_id, observed_at);
CREATE FUNCTION trustwork.assistant_outcome_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_previous text;
  v_unknown_seen boolean;
  v_reconciliation trustwork.reconciliation%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'outcomes are append-only' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  SELECT kind INTO v_previous FROM trustwork.action_outcome WHERE action_intent_id = NEW.action_intent_id ORDER BY observed_at DESC, id DESC LIMIT 1;
  IF v_previous = 'final' THEN
    RAISE EXCEPTION 'a final outcome is final' USING ERRCODE = 'check_violation', HINT = 'assistant.invalid_transition';
  END IF;
  SELECT EXISTS (SELECT 1 FROM trustwork.action_outcome WHERE action_intent_id = NEW.action_intent_id AND kind = 'unknown') INTO v_unknown_seen;
  IF NEW.kind = 'final' AND v_unknown_seen THEN
    SELECT * INTO v_reconciliation FROM trustwork.reconciliation WHERE id = NEW.reconciliation_id;
    IF NOT FOUND OR v_reconciliation.action_intent_id <> NEW.action_intent_id OR v_reconciliation.attempt_id IS DISTINCT FROM NEW.attempt_id OR (v_reconciliation.outcome ->> 'kind') <> 'final' THEN
      RAISE EXCEPTION 'an unknown outcome becomes final only through a reconciliation of this intent and attempt' USING ERRCODE = 'check_violation', HINT = 'assistant.reconciliation_required';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER action_outcome_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.action_outcome FOR EACH ROW EXECUTE FUNCTION trustwork.assistant_outcome_guard();

CREATE TABLE trustwork.approval (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  action_intent_id uuid NOT NULL REFERENCES trustwork.action_intent (id),
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  mandate_revision integer NOT NULL CHECK (mandate_revision >= 1),
  approver_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  step_up boolean NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  consumed_at timestamptz NULL,
  CONSTRAINT approval_expiry CHECK (expires_at > approved_at)
);
CREATE UNIQUE INDEX approval_one_live ON trustwork.approval (action_intent_id) WHERE revoked_at IS NULL;
CREATE FUNCTION trustwork.assistant_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approvals are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF ROW(NEW.id, NEW.action_intent_id, NEW.action_digest, NEW.mandate_revision, NEW.approver_person_id, NEW.step_up, NEW.approved_at, NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.action_intent_id, OLD.action_digest, OLD.mandate_revision, OLD.approver_person_id, OLD.step_up, OLD.approved_at, OLD.expires_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
    RAISE EXCEPTION 'an approval binds its digest once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'assistant.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_guard BEFORE UPDATE OR DELETE ON trustwork.approval FOR EACH ROW EXECUTE FUNCTION trustwork.assistant_approval_guard();

-- 4. Conversation, notes and the service backlog ------------------------------------------------------------------------
-- One conversation per person shared by the page and the overlay. Content is data, never an instruction: nothing here
-- can create, confirm or widen a mandate. No chain-of-thought is stored; turns expire (retention class conversation).
CREATE TABLE trustwork.conversation_turn (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  role text NOT NULL CHECK (role IN ('person', 'agent', 'system')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  run_id uuid NULL REFERENCES trustwork.run (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '90 days'),
  CONSTRAINT conversation_turn_expiry CHECK (expires_at > created_at)
);
CREATE INDEX conversation_turn_person_idx ON trustwork.conversation_turn (person_id, created_at);
CREATE TRIGGER conversation_turn_append_only BEFORE UPDATE ON trustwork.conversation_turn FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.assistant_note (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  source_dependencies jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_dependencies) = 'array'),
  retained_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX assistant_note_person_idx ON trustwork.assistant_note (person_id, retained_at DESC);

CREATE TABLE trustwork.service_backlog_item (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  company_id uuid NULL REFERENCES trustwork.company (id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal) = 'object'),
  source_run_id uuid NULL REFERENCES trustwork.run (id),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'dismissed', 'done')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_backlog_item_person_idx ON trustwork.service_backlog_item (person_id, status);
CREATE TRIGGER service_backlog_item_touch BEFORE UPDATE ON trustwork.service_backlog_item FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 5. Internal helpers (owner-run, never granted) -------------------------------------------------------------------------
-- Settle or release one reservation from outcome evidence, with BILL-001's rules (never above the reservation; release
-- needs evidence; a closed reservation is left alone, so the call is idempotent).
CREATE FUNCTION trustwork.assistant_close_reservation(p_reservation_id uuid, p_settle boolean, p_actual_minor bigint, p_evidence text) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_reservation trustwork.reservation%ROWTYPE;
  v_budget trustwork.budget%ROWTYPE;
  v_amount bigint;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = v_reservation.budget_id FOR UPDATE;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id FOR UPDATE;
  IF v_reservation.state <> 'reserved' THEN
    RETURN;
  END IF;
  IF p_settle THEN
    v_amount := least(coalesce(p_actual_minor, v_reservation.amount_minor), v_reservation.amount_minor);
    UPDATE trustwork.reservation SET state = 'settled', settled_minor = v_amount, closed_at = clock_timestamp(), evidence_ref = left(p_evidence, 200) WHERE id = p_reservation_id;
    PERFORM trustwork.billing_post_budget_movement(v_budget, p_reservation_id, 'settlement', -v_amount, left(p_evidence, 500));
  ELSE
    UPDATE trustwork.reservation SET state = 'released', closed_at = clock_timestamp(), evidence_ref = left(p_evidence, 200) WHERE id = p_reservation_id;
  END IF;
END $$;

-- Recomputes the state of a run from its intents (never touches a finished run).
CREATE FUNCTION trustwork.assistant_refresh_run(p_run_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_run trustwork.run%ROWTYPE;
  v_proposed integer;
  v_active integer;
BEGIN
  IF p_run_id IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO v_run FROM trustwork.run WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.state IN ('completed', 'failed', 'cancelled') THEN
    RETURN;
  END IF;
  SELECT count(*) FILTER (WHERE state = 'proposed'), count(*) FILTER (WHERE state NOT IN ('proposed', 'succeeded', 'failed', 'revoked'))
  INTO v_proposed, v_active FROM trustwork.action_intent WHERE run_id = p_run_id;
  IF v_proposed > 0 THEN
    UPDATE trustwork.run SET state = 'waiting_approval' WHERE id = p_run_id AND state <> 'waiting_approval';
  ELSIF v_active > 0 THEN
    UPDATE trustwork.run SET state = 'waiting_event' WHERE id = p_run_id AND state <> 'waiting_event';
  ELSE
    UPDATE trustwork.run SET state = 'completed', ended_at = clock_timestamp(), ended_reason = 'all actions finished' WHERE id = p_run_id;
  END IF;
END $$;

-- Ends an intent definitively (succeeded, failed or revoked): settles or releases its reservation, returns its
-- mandate use to the ceiling when nothing happened, and refreshes its run.
CREATE FUNCTION trustwork.assistant_finish_intent(p_intent_id uuid, p_state text, p_reason text, p_evidence text) RETURNS trustwork.action_intent
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_intent trustwork.action_intent%ROWTYPE;
BEGIN
  UPDATE trustwork.action_intent SET state = p_state, state_reason = left(p_reason, 200) WHERE id = p_intent_id RETURNING * INTO v_intent;
  IF p_state = 'succeeded' THEN
    PERFORM trustwork.assistant_close_reservation(v_intent.reservation_id, true, v_intent.amount_minor, coalesce(p_evidence, 'assistant:' || v_intent.id::text));
  ELSE
    PERFORM trustwork.assistant_close_reservation(v_intent.reservation_id, false, NULL, coalesce(p_evidence, p_state || ':' || coalesce(p_reason, 'no effect')));
    UPDATE trustwork.mandate_use SET voided_at = clock_timestamp() WHERE action_intent_id = p_intent_id AND voided_at IS NULL;
  END IF;
  PERFORM trustwork.assistant_refresh_run(v_intent.run_id);
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('action_intent', v_intent.id::text, v_intent.revision, 'assistant.action_' || p_state, jsonb_build_object('actionIntentId', v_intent.id, 'runId', v_intent.run_id));
  RETURN v_intent;
END $$;

-- Revokes the not yet started intents (proposed, authorized, reserved, queued) of one mandate, one run or every mandate
-- of a person; in-flight and unknown outcomes are left to finish or reconcile.
CREATE FUNCTION trustwork.assistant_revoke_pending(p_mandate_id uuid, p_run_id uuid, p_person_id uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_id uuid;
  v_count integer := 0;
BEGIN
  FOR v_id IN SELECT id FROM trustwork.action_intent
    WHERE state IN ('proposed', 'authorized', 'reserved', 'queued')
      AND (p_mandate_id IS NULL OR mandate_id = p_mandate_id) AND (p_run_id IS NULL OR run_id = p_run_id) AND (p_person_id IS NULL OR principal_person_id = p_person_id)
    ORDER BY id FOR UPDATE LOOP
    PERFORM trustwork.assistant_finish_intent(v_id, 'revoked', p_reason, 'revoked:' || p_reason);
    UPDATE trustwork.approval SET revoked_at = clock_timestamp() WHERE action_intent_id = v_id AND revoked_at IS NULL AND consumed_at IS NULL;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- Narrows one mandate (suspended, revoked or expired) as a new revision; the system and the principal both use it.
CREATE FUNCTION trustwork.assistant_apply_narrowing(p_mandate_id uuid, p_status text, p_reason text, p_actor uuid, p_kind text) RETURNS trustwork.mandate
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_mandate trustwork.mandate%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_snapshot jsonb;
BEGIN
  SELECT * INTO v_mandate FROM trustwork.mandate WHERE id = p_mandate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown mandate' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  IF v_mandate.status = p_status THEN
    RETURN v_mandate;
  END IF;
  IF NOT ((v_mandate.status = 'active' AND p_status IN ('suspended', 'revoked', 'expired')) OR (v_mandate.status = 'suspended' AND p_status IN ('revoked', 'expired'))) THEN
    RAISE EXCEPTION 'mandate cannot move from % to %', v_mandate.status, p_status USING ERRCODE = 'check_violation', HINT = 'mandate.final';
  END IF;
  v_snapshot := jsonb_set(jsonb_set(jsonb_set(v_mandate.snapshot, '{status}', to_jsonb(p_status)), '{revision}', to_jsonb(v_mandate.revision + 1)),
    '{revokedAt}', CASE WHEN p_status = 'revoked' THEN to_jsonb(trustwork.assistant_iso(v_now)) ELSE 'null'::jsonb END);
  UPDATE trustwork.mandate SET status = p_status, status_reason = left(p_reason, 500), revision = revision + 1, snapshot = v_snapshot, digest = NULL,
    revoked_at = CASE WHEN p_status = 'revoked' THEN v_now ELSE NULL END, updated_at = v_now
  WHERE id = p_mandate_id RETURNING * INTO v_mandate;
  INSERT INTO trustwork.mandate_revision (mandate_id, revision, principal_person_id, snapshot, digest, change_kind, changed_by_person_id, reason)
  VALUES (v_mandate.id, v_mandate.revision, v_mandate.principal_person_id, v_snapshot, NULL, p_kind, p_actor, left(p_reason, 500));
  PERFORM trustwork.assistant_revoke_pending(p_mandate_id, NULL, NULL, 'mandate_' || p_status);
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('mandate', v_mandate.id::text, v_mandate.revision, 'assistant.mandate_' || p_status, jsonb_build_object('mandateId', v_mandate.id));
  RETURN v_mandate;
END $$;

-- Rechecks the authorization numbers of one action under the mandate row lock: per-action ceiling, cumulative ceiling
-- over every non-voided use of the mandate, and the per-window count. Raises when a limit would be exceeded.
CREATE FUNCTION trustwork.assistant_check_limits(p_mandate trustwork.mandate, p_amount_minor bigint, p_currency text) RETURNS void
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
    WHERE mandate_id = p_mandate.id AND voided_at IS NULL AND used_at > clock_timestamp() - make_interval(hours => (v_limits -> 'perWindow' ->> 'windowHours')::integer);
    IF v_window >= (v_limits -> 'perWindow' ->> 'count')::integer THEN
      RAISE EXCEPTION 'the action window is exhausted' USING ERRCODE = 'check_violation', HINT = 'mandate.limit';
    END IF;
  END IF;
END $$;

-- The mandate row of the caller, locked, active at the expected revision, not expired, covering the action.
CREATE FUNCTION trustwork.assistant_lock_live_mandate(p_mandate_id uuid, p_revision integer, p_action text) RETURNS trustwork.mandate
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_mandate trustwork.mandate%ROWTYPE;
BEGIN
  SELECT * INTO v_mandate FROM trustwork.mandate WHERE id = p_mandate_id FOR UPDATE;
  IF NOT FOUND OR v_mandate.principal_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'unknown mandate' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_mandate.status <> 'active' OR v_mandate.valid_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'mandate is not active' USING ERRCODE = 'check_violation', HINT = 'mandate.not_active';
  END IF;
  IF p_revision IS NOT NULL AND v_mandate.revision <> p_revision THEN
    RAISE EXCEPTION 'mandate revision changed' USING ERRCODE = 'check_violation', HINT = 'mandate.revision_changed';
  END IF;
  IF p_action IS NOT NULL AND NOT (p_action = ANY (v_mandate.actions)) THEN
    RAISE EXCEPTION 'action outside the mandate' USING ERRCODE = 'check_violation', HINT = 'mandate.limit';
  END IF;
  IF v_mandate.on_behalf_company_id IS NOT NULL AND v_mandate.on_behalf_company_id IS DISTINCT FROM trustwork.current_company_id() THEN
    RAISE EXCEPTION 'the company basis of the mandate is gone' USING ERRCODE = 'check_violation', HINT = 'mandate.not_active';
  END IF;
  RETURN v_mandate;
END $$;

CREATE FUNCTION trustwork.assistant_enqueue(p_kind text, p_intent_id uuid, p_delay_seconds integer) RETURNS void
LANGUAGE sql SET search_path = trustwork, pg_temp AS $$
  INSERT INTO trustwork.job (kind, payload, next_at, max_attempts)
  VALUES (p_kind, jsonb_build_object('intentId', p_intent_id), now() + make_interval(secs => p_delay_seconds), 8)
$$;

-- 6. Principal commands (trustwork_app, inside withPrincipal) --------------------------------------------------------------
-- First-party confirmation of a new mandate or of its next revision. The API validates the snapshot with
-- MandateV2Schema and mandateChangeAllowed (person, first_party_form) before calling; this command repeats the authority
-- rules the database can see: the caller is the principal and the confirming person, the company basis is the caller's
-- active employer, every named budget is one the caller may spend from, and the revision is the next one.
CREATE FUNCTION trustwork.assistant_confirm_mandate(p_snapshot jsonb, p_contexts jsonb, p_digest text, p_expected_revision integer, p_step_up boolean, p_proposal_id uuid)
RETURNS trustwork.mandate LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_id uuid;
  v_revision integer;
  v_existing trustwork.mandate%ROWTYPE;
  v_result trustwork.mandate%ROWTYPE;
  v_on_behalf jsonb;
  v_company uuid;
  v_grantee jsonb;
  v_budget trustwork.budget%ROWTYPE;
  v_key text;
  v_kind text;
  v_context jsonb;
  v_now timestamptz := clock_timestamp();
  v_proposal trustwork.mandate_proposal%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF jsonb_typeof(p_snapshot) <> 'object' OR jsonb_typeof(p_contexts) <> 'array' OR jsonb_array_length(p_contexts) < 1 OR coalesce(p_digest, '') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid mandate' USING ERRCODE = 'invalid_parameter_value', HINT = 'mandate.invalid';
  END IF;
  v_id := (p_snapshot ->> 'id')::uuid;
  v_revision := (p_snapshot ->> 'revision')::integer;
  IF (p_snapshot -> 'principal' ->> 'personId') IS DISTINCT FROM v_person::text
     OR (p_snapshot -> 'confirmation' ->> 'personId') IS DISTINCT FROM v_person::text OR (p_snapshot -> 'confirmation' ->> 'via') IS DISTINCT FROM 'first_party_form' THEN
    RAISE EXCEPTION 'only the principal confirms a mandate on the first-party form' USING ERRCODE = 'insufficient_privilege', HINT = 'mandate.not_principal';
  END IF;
  IF (p_snapshot ->> 'status') IS DISTINCT FROM 'active' OR (p_snapshot -> 'confirmation' ->> 'stepUp')::boolean IS DISTINCT FROM p_step_up THEN
    RAISE EXCEPTION 'a confirmation activates the mandate and records its step-up' USING ERRCODE = 'invalid_parameter_value', HINT = 'mandate.invalid';
  END IF;
  IF (p_snapshot ->> 'validUntil')::timestamptz <= v_now THEN
    RAISE EXCEPTION 'mandate validity has passed' USING ERRCODE = 'check_violation', HINT = 'mandate.invalid';
  END IF;
  v_on_behalf := p_snapshot -> 'principal' -> 'onBehalfOf';
  IF jsonb_typeof(v_on_behalf) = 'object' THEN
    IF v_on_behalf ->> 'kind' = 'company' THEN
      v_company := (v_on_behalf ->> 'id')::uuid;
      IF v_company IS DISTINCT FROM trustwork.current_company_id() THEN
        RAISE EXCEPTION 'a company mandate needs the principal''s active employment' USING ERRCODE = 'insufficient_privilege', HINT = 'mandate.authority_basis';
      END IF;
    ELSIF (v_on_behalf ->> 'id') IS DISTINCT FROM v_person::text THEN
      RAISE EXCEPTION 'a personal mandate acts for the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'mandate.authority_basis';
    END IF;
  END IF;
  v_grantee := p_snapshot -> 'grantee';
  FOREACH v_key IN ARRAY ARRAY['transactionBudgetId', 'platformBudgetId'] LOOP
    IF jsonb_typeof(p_snapshot -> 'limits' -> v_key) = 'string' THEN
      v_kind := CASE v_key WHEN 'transactionBudgetId' THEN 'transaction' ELSE 'platform' END;
      SELECT * INTO v_budget FROM trustwork.budget WHERE id = (p_snapshot -> 'limits' ->> v_key)::uuid;
      IF NOT FOUND OR v_budget.status <> 'active' OR v_budget.kind <> v_kind OR NOT trustwork.billing_may_spend(v_budget) THEN
        RAISE EXCEPTION 'the mandate names a budget the principal cannot spend from' USING ERRCODE = 'insufficient_privilege', HINT = 'mandate.budget_authority';
      END IF;
    END IF;
  END LOOP;

  SELECT * INTO v_existing FROM trustwork.mandate WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_revision IS NOT NULL OR v_revision <> 1 THEN
      RAISE EXCEPTION 'a new mandate starts at revision 1' USING ERRCODE = 'check_violation', HINT = 'validation.revision_conflict';
    END IF;
    INSERT INTO trustwork.mandate (id, principal_person_id, on_behalf_company_id, grantee_kind, grantee_person_id, grantee_company_id, module_keys, actions, revision, status,
      valid_until, snapshot, digest, confirmed_by_person_id, confirmed_at, confirmed_step_up)
    VALUES (v_id, v_person, v_company, v_grantee ->> 'kind', (v_grantee ->> 'personId')::uuid, (v_grantee ->> 'companyId')::uuid,
      ARRAY(SELECT jsonb_array_elements_text(p_snapshot -> 'moduleKeys')), ARRAY(SELECT jsonb_array_elements_text(p_snapshot -> 'actions')), 1, 'active',
      (p_snapshot ->> 'validUntil')::timestamptz, p_snapshot, p_digest, v_person, v_now, p_step_up)
    RETURNING * INTO v_result;
  ELSE
    IF v_existing.principal_person_id <> v_person THEN
      RAISE EXCEPTION 'unknown mandate' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
    END IF;
    IF v_existing.status IN ('revoked', 'expired') THEN
      RAISE EXCEPTION 'a revoked or expired mandate is final' USING ERRCODE = 'check_violation', HINT = 'mandate.final';
    END IF;
    IF p_expected_revision IS DISTINCT FROM v_existing.revision OR v_revision <> v_existing.revision + 1 THEN
      RAISE EXCEPTION 'mandate revision conflict' USING ERRCODE = 'check_violation', HINT = 'validation.revision_conflict';
    END IF;
    IF v_existing.on_behalf_company_id IS DISTINCT FROM v_company OR v_existing.grantee_kind <> (v_grantee ->> 'kind')
       OR v_existing.grantee_person_id IS DISTINCT FROM (v_grantee ->> 'personId')::uuid OR v_existing.grantee_company_id IS DISTINCT FROM (v_grantee ->> 'companyId')::uuid THEN
      RAISE EXCEPTION 'principal, company and grantee of a mandate never change; create a new mandate' USING ERRCODE = 'check_violation', HINT = 'mandate.immutable';
    END IF;
    UPDATE trustwork.mandate SET module_keys = ARRAY(SELECT jsonb_array_elements_text(p_snapshot -> 'moduleKeys')), actions = ARRAY(SELECT jsonb_array_elements_text(p_snapshot -> 'actions')),
      revision = v_revision, status = 'active', status_reason = NULL, valid_until = (p_snapshot ->> 'validUntil')::timestamptz, snapshot = p_snapshot, digest = p_digest,
      confirmed_by_person_id = v_person, confirmed_at = v_now, confirmed_step_up = p_step_up, revoked_at = NULL, updated_at = v_now
    WHERE id = v_id RETURNING * INTO v_result;
    DELETE FROM trustwork.mandate_context WHERE mandate_id = v_id;
    -- Approvals bind (mandate, revision): not yet started intents of earlier revisions are void.
    PERFORM trustwork.assistant_revoke_pending(v_id, NULL, NULL, 'mandate_revised');
  END IF;
  FOR v_context IN SELECT * FROM jsonb_array_elements(p_contexts) LOOP
    INSERT INTO trustwork.mandate_context (mandate_id, context_kind, context_id, selector)
    VALUES (v_id, v_context ->> 'kind', CASE WHEN v_context ? 'categories' THEN NULL ELSE v_context ->> 'id' END, CASE WHEN v_context ? 'categories' THEN v_context ELSE NULL END);
  END LOOP;
  INSERT INTO trustwork.mandate_revision (mandate_id, revision, principal_person_id, snapshot, digest, change_kind, changed_by_person_id)
  VALUES (v_id, v_revision, v_person, p_snapshot, p_digest, 'confirm', v_person);
  IF p_proposal_id IS NOT NULL THEN
    SELECT * INTO v_proposal FROM trustwork.mandate_proposal WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND OR v_proposal.principal_person_id <> v_person OR v_proposal.status <> 'pending' OR (v_proposal.proposed ->> 'id') <> v_id::text THEN
      RAISE EXCEPTION 'the proposal is not pending for this mandate' USING ERRCODE = 'check_violation', HINT = 'mandate.proposal_not_pending';
    END IF;
    UPDATE trustwork.mandate_proposal SET status = 'confirmed', decided_at = v_now, decided_by_person_id = v_person WHERE id = p_proposal_id;
  END IF;
  UPDATE trustwork.mandate_proposal SET status = 'superseded', decided_at = v_now, decided_by_person_id = v_person
  WHERE principal_person_id = v_person AND status = 'pending' AND (proposed ->> 'id') = v_id::text AND id IS DISTINCT FROM p_proposal_id;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('mandate', v_id::text, v_revision, 'assistant.mandate_confirmed', jsonb_build_object('mandateId', v_id));
  RETURN v_result;
END $$;

-- The principal suspends or revokes their own mandate (narrowing is always allowed and never needs step-up).
CREATE FUNCTION trustwork.assistant_narrow_mandate(p_mandate_id uuid, p_expected_revision integer, p_status text, p_reason text)
RETURNS trustwork.mandate LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_mandate trustwork.mandate%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_status NOT IN ('suspended', 'revoked') OR coalesce(length(p_reason), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid narrowing' USING ERRCODE = 'invalid_parameter_value', HINT = 'mandate.invalid';
  END IF;
  SELECT * INTO v_mandate FROM trustwork.mandate WHERE id = p_mandate_id FOR UPDATE;
  IF NOT FOUND OR v_mandate.principal_person_id <> v_person THEN
    RAISE EXCEPTION 'unknown mandate' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> v_mandate.revision AND v_mandate.status <> p_status THEN
    RAISE EXCEPTION 'mandate revision conflict' USING ERRCODE = 'check_violation', HINT = 'validation.revision_conflict';
  END IF;
  RETURN trustwork.assistant_apply_narrowing(p_mandate_id, p_status, p_reason, v_person, 'narrow');
END $$;

-- System narrowing when an authority basis is lost (identity hook after a membership end or a participation
-- revocation). It needs no principal because the actor may be another member, and it can only narrow, only when the
-- basis is really gone: with a company, when the person holds no active membership there any more; without one, for
-- personal mandates whose project contexts the person neither owns nor still participates in.
CREATE FUNCTION trustwork.assistant_revoke_for_basis(p_person_id uuid, p_company_id uuid, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_id uuid;
  v_count integer := 0;
BEGIN
  IF p_person_id IS NULL OR coalesce(length(p_reason), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid revocation' USING ERRCODE = 'invalid_parameter_value', HINT = 'mandate.invalid';
  END IF;
  IF p_company_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM trustwork.membership WHERE person_id = p_person_id AND company_id = p_company_id AND status = 'active') THEN
      RETURN 0;
    END IF;
    FOR v_id IN SELECT id FROM trustwork.mandate
      WHERE status IN ('active', 'suspended') AND on_behalf_company_id = p_company_id AND (principal_person_id = p_person_id OR grantee_person_id = p_person_id)
      ORDER BY id LOOP
      PERFORM trustwork.assistant_apply_narrowing(v_id, 'revoked', 'authority_basis_lost: ' || p_reason, NULL, 'system');
      v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
  END IF;
  FOR v_id IN SELECT DISTINCT m.id FROM trustwork.mandate m JOIN trustwork.mandate_context c ON c.mandate_id = m.id AND c.context_kind = 'project' AND c.context_id IS NOT NULL
    WHERE m.principal_person_id = p_person_id AND m.status = 'active' AND m.on_behalf_company_id IS NULL
      AND c.context_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND NOT EXISTS (SELECT 1 FROM trustwork.project p WHERE p.id = c.context_id::uuid AND p.owner_person_id = p_person_id)
      AND NOT EXISTS (SELECT 1 FROM trustwork.object_participation o WHERE o.resource_kind = 'project' AND o.resource_id = c.context_id::uuid AND o.party_person_id = p_person_id
                        AND o.revoked_at IS NULL AND (o.valid_until IS NULL OR o.valid_until > clock_timestamp()))
    ORDER BY m.id LOOP
    PERFORM trustwork.assistant_apply_narrowing(v_id, 'suspended', 'authority_basis_lost: ' || p_reason, NULL, 'system');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- First engaged switch or stop that blocks agent dispatch for this target, or NULL (agentDispatchBlocked).
-- A node switch blocks every hub of the node (one node per deployment); without a configured hub id every hub-scoped
-- switch applies (fail-closed).
CREATE FUNCTION trustwork.assistant_dispatch_blocked(p_hub_id uuid, p_module_key text, p_action text, p_person_id uuid, p_connection_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT id FROM (
    SELECT k.id, 1 AS rank FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND (
      k.scope_kind = 'node'
      OR ((p_hub_id IS NULL OR k.hub_id = p_hub_id) AND (
           k.scope_kind = 'hub_agent_dispatch'
        OR (k.scope_kind = 'agent_module' AND k.module_key = p_module_key)
        OR (k.scope_kind = 'agent_action' AND k.action = p_action)
        OR (k.scope_kind = 'external_agent_api' AND p_connection_id IS NOT NULL)
        OR (k.scope_kind = 'outbound_messages' AND p_action IN ('communicate', 'send_quote', 'negotiate', 'introduce', 'schedule')))))
    UNION ALL
    SELECT s.id, 2 FROM trustwork.participant_stop s WHERE s.state = 'engaged' AND s.scope_kind = 'person_stop' AND s.person_id = p_person_id
  ) blocking ORDER BY rank, id LIMIT 1
$$;

-- Records one action decided by the API policy (evaluateMandateV2) and repeats its numbers under the mandate lock.
-- `allow` consumes a mandate use (a module check stops there; a run intent is born authorized); `ask` records a
-- proposed intent for the person's decision. A module check that was asked before and approved by the person for
-- exactly this digest is authorized on the identical retry, which consumes the approval.
CREATE FUNCTION trustwork.assistant_record_intent(p_run_id uuid, p_mandate_id uuid, p_revision integer, p_capability_id text, p_module_key text, p_action text, p_context_kind text,
  p_context_id text, p_from_selector boolean, p_amount_minor bigint, p_currency text, p_digest text, p_effect jsonb, p_decision text, p_ask_reasons text[])
RETURNS TABLE (intent_id uuid, state text) LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
#variable_conflict use_column
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_mandate trustwork.mandate%ROWTYPE;
  v_run trustwork.run%ROWTYPE;
  v_existing trustwork.action_intent%ROWTYPE;
  v_approval trustwork.approval%ROWTYPE;
  v_id uuid;
  v_state text;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_decision NOT IN ('allow', 'ask') OR coalesce(p_digest, '') !~ '^[a-f0-9]{64}$' OR (p_amount_minor IS NULL) <> (p_currency IS NULL) THEN
    RAISE EXCEPTION 'invalid action' USING ERRCODE = 'invalid_parameter_value', HINT = 'mandate.invalid';
  END IF;
  IF trustwork.assistant_budget_kind(p_action) IS NOT NULL AND p_amount_minor IS NULL THEN
    RAISE EXCEPTION 'a money action names its amount' USING ERRCODE = 'invalid_parameter_value', HINT = 'mandate.invalid';
  END IF;
  -- Human-only actions are never authorized by a mandate alone (HUMAN_ONLY_ACTIONS).
  IF p_decision = 'allow' AND p_action IN ('confirm_execution', 'approve') THEN
    RAISE EXCEPTION 'human-only actions always ask the person' USING ERRCODE = 'check_violation', HINT = 'mandate.human_only';
  END IF;
  v_mandate := trustwork.assistant_lock_live_mandate(p_mandate_id, p_revision, p_action);
  IF p_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM trustwork.run WHERE id = p_run_id FOR UPDATE;
    IF NOT FOUND OR v_run.principal_person_id <> v_person THEN
      RAISE EXCEPTION 'unknown run' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
    END IF;
    IF v_run.state IN ('completed', 'failed', 'cancelled') THEN
      RAISE EXCEPTION 'the run has finished' USING ERRCODE = 'check_violation', HINT = 'assistant.invalid_transition';
    END IF;
    IF p_effect IS NULL THEN
      RAISE EXCEPTION 'a run action names its structured effect' USING ERRCODE = 'invalid_parameter_value', HINT = 'mandate.invalid';
    END IF;
  ELSE
    SELECT * INTO v_existing FROM trustwork.action_intent i
    WHERE i.mandate_id = p_mandate_id AND i.mandate_revision = p_revision AND i.action_digest = p_digest AND i.state = 'proposed' AND i.origin = 'module_check'
    ORDER BY i.created_at LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      SELECT * INTO v_approval FROM trustwork.approval a
      WHERE a.action_intent_id = v_existing.id AND a.action_digest = p_digest AND a.mandate_revision = p_revision AND a.revoked_at IS NULL AND a.consumed_at IS NULL AND a.expires_at > clock_timestamp()
      FOR UPDATE;
      IF FOUND THEN
        PERFORM trustwork.assistant_check_limits(v_mandate, p_amount_minor, p_currency);
        UPDATE trustwork.approval SET consumed_at = clock_timestamp() WHERE id = v_approval.id;
        UPDATE trustwork.action_intent SET state = 'authorized' WHERE id = v_existing.id;
        INSERT INTO trustwork.mandate_use (mandate_id, mandate_revision, action_intent_id, action, amount_minor, currency, approved)
        VALUES (p_mandate_id, p_revision, v_existing.id, p_action, p_amount_minor, p_currency, true);
        RETURN QUERY SELECT v_existing.id, 'authorized'::text;
        RETURN;
      END IF;
      RETURN QUERY SELECT v_existing.id, 'proposed'::text;
      RETURN;
    END IF;
  END IF;
  IF p_decision = 'allow' THEN
    PERFORM trustwork.assistant_check_limits(v_mandate, p_amount_minor, p_currency);
    IF p_run_id IS NULL THEN
      INSERT INTO trustwork.mandate_use (mandate_id, mandate_revision, action_intent_id, action, amount_minor, currency)
      VALUES (p_mandate_id, p_revision, NULL, p_action, p_amount_minor, p_currency);
      RETURN QUERY SELECT NULL::uuid, 'allowed'::text;
      RETURN;
    END IF;
  END IF;
  v_id := trustwork.new_uuid();
  v_state := CASE p_decision WHEN 'allow' THEN 'authorized' ELSE 'proposed' END;
  INSERT INTO trustwork.action_intent (id, run_id, origin, principal_person_id, mandate_id, mandate_revision, capability_id, module_key, action, context_kind, context_id,
    resolved_from_selector, amount_minor, currency, action_digest, ask_reasons, state, effect_correlation_key, effect)
  VALUES (v_id, p_run_id, CASE WHEN p_run_id IS NULL THEN 'module_check' ELSE 'run' END, v_person, p_mandate_id, p_revision, p_capability_id, p_module_key, p_action, p_context_kind, p_context_id,
    coalesce(p_from_selector, false), p_amount_minor, p_currency, p_digest, coalesce(p_ask_reasons, '{}'), v_state, 'assistant:' || v_id::text, p_effect);
  IF v_state = 'authorized' THEN
    INSERT INTO trustwork.mandate_use (mandate_id, mandate_revision, action_intent_id, action, amount_minor, currency)
    VALUES (p_mandate_id, p_revision, v_id, p_action, p_amount_minor, p_currency);
  END IF;
  PERFORM trustwork.assistant_refresh_run(p_run_id);
  RETURN QUERY SELECT v_id, v_state;
END $$;

-- The person approves exactly the action they were shown (digest) at the current mandate revision. A run intent is
-- authorized at once (its limits rechecked under the mandate lock); a module-check intent keeps the approval until
-- the identical retry. Money and human-only actions need a recent authentication.
CREATE FUNCTION trustwork.assistant_approve_intent(p_intent_id uuid, p_digest text, p_ttl_seconds integer, p_step_up boolean)
RETURNS trustwork.action_intent LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_intent trustwork.action_intent%ROWTYPE;
  v_mandate trustwork.mandate%ROWTYPE;
  v_approval uuid;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 7 * 86400 THEN
    RAISE EXCEPTION 'invalid approval lifetime' USING ERRCODE = 'invalid_parameter_value', HINT = 'mandate.invalid';
  END IF;
  SELECT * INTO v_intent FROM trustwork.action_intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.principal_person_id <> v_person THEN
    RAISE EXCEPTION 'unknown decision' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_intent.state <> 'proposed' THEN
    RAISE EXCEPTION 'the decision is no longer waiting' USING ERRCODE = 'check_violation', HINT = 'assistant.invalid_transition';
  END IF;
  IF p_digest IS DISTINCT FROM v_intent.action_digest THEN
    RAISE EXCEPTION 'the approval does not match the proposed action' USING ERRCODE = 'check_violation', HINT = 'access.approval_digest_mismatch';
  END IF;
  IF trustwork.assistant_needs_step_up(v_intent.action) AND NOT coalesce(p_step_up, false) THEN
    RAISE EXCEPTION 'recent authentication required' USING ERRCODE = 'insufficient_privilege', HINT = 'auth.step_up_required';
  END IF;
  v_mandate := trustwork.assistant_lock_live_mandate(v_intent.mandate_id, v_intent.mandate_revision, v_intent.action);
  INSERT INTO trustwork.approval (action_intent_id, action_digest, mandate_revision, approver_person_id, step_up, expires_at)
  VALUES (v_intent.id, v_intent.action_digest, v_intent.mandate_revision, v_person, coalesce(p_step_up, false), clock_timestamp() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_approval;
  IF v_intent.origin = 'run' THEN
    PERFORM trustwork.assistant_check_limits(v_mandate, v_intent.amount_minor, v_intent.currency);
    UPDATE trustwork.approval SET consumed_at = clock_timestamp() WHERE id = v_approval;
    UPDATE trustwork.action_intent SET state = 'authorized' WHERE id = v_intent.id RETURNING * INTO v_intent;
    INSERT INTO trustwork.mandate_use (mandate_id, mandate_revision, action_intent_id, action, amount_minor, currency, approved)
    VALUES (v_intent.mandate_id, v_intent.mandate_revision, v_intent.id, v_intent.action, v_intent.amount_minor, v_intent.currency, true);
    PERFORM trustwork.assistant_refresh_run(v_intent.run_id);
  END IF;
  RETURN v_intent;
END $$;

CREATE FUNCTION trustwork.assistant_decline_intent(p_intent_id uuid, p_reason text)
RETURNS trustwork.action_intent LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_intent trustwork.action_intent%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_intent FROM trustwork.action_intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.principal_person_id <> v_person THEN
    RAISE EXCEPTION 'unknown decision' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_intent.state <> 'proposed' THEN
    RAISE EXCEPTION 'the decision is no longer waiting' USING ERRCODE = 'check_violation', HINT = 'assistant.invalid_transition';
  END IF;
  RETURN trustwork.assistant_finish_intent(p_intent_id, 'revoked', 'declined: ' || coalesce(left(p_reason, 180), 'by the person'), 'declined');
END $$;

-- Reserves the budget a money action needs (BILL-001 `billing_reserve`, atomic under the budget row lock, with the
-- intent's correlation key) and queues the dispatch job in the same transaction (transactional outbox).
CREATE FUNCTION trustwork.assistant_queue_intent(p_intent_id uuid, p_ttl_seconds integer, p_project_id uuid)
RETURNS trustwork.action_intent LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_intent trustwork.action_intent%ROWTYPE;
  v_mandate trustwork.mandate%ROWTYPE;
  v_kind text;
  v_budget uuid;
  v_reservation trustwork.reservation%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_intent FROM trustwork.action_intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.principal_person_id <> v_person THEN
    RAISE EXCEPTION 'unknown action' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_intent.state <> 'authorized' OR v_intent.origin <> 'run' THEN
    RAISE EXCEPTION 'only an authorized run action is queued' USING ERRCODE = 'check_violation', HINT = 'assistant.invalid_transition';
  END IF;
  v_mandate := trustwork.assistant_lock_live_mandate(v_intent.mandate_id, v_intent.mandate_revision, v_intent.action);
  v_kind := trustwork.assistant_budget_kind(v_intent.action);
  IF v_kind IS NOT NULL THEN
    v_budget := (v_mandate.snapshot -> 'limits' ->> CASE v_kind WHEN 'transaction' THEN 'transactionBudgetId' ELSE 'platformBudgetId' END)::uuid;
    IF v_budget IS NULL THEN
      RAISE EXCEPTION 'the mandate names no budget for this action' USING ERRCODE = 'check_violation', HINT = 'mandate.limit';
    END IF;
    v_reservation := trustwork.billing_reserve(v_budget, v_kind, v_intent.amount_minor, v_intent.currency, v_intent.id, v_intent.effect_correlation_key, p_project_id,
      make_interval(secs => coalesce(p_ttl_seconds, 30 * 86400)));
    UPDATE trustwork.action_intent SET state = 'reserved', reservation_id = v_reservation.id WHERE id = p_intent_id;
  END IF;
  UPDATE trustwork.action_intent SET state = 'queued' WHERE id = p_intent_id RETURNING * INTO v_intent;
  PERFORM trustwork.assistant_enqueue('assistant.dispatch', v_intent.id, 0);
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('action_intent', v_intent.id::text, v_intent.revision, 'assistant.action_queued', jsonb_build_object('actionIntentId', v_intent.id, 'runId', v_intent.run_id));
  PERFORM trustwork.assistant_refresh_run(v_intent.run_id);
  RETURN v_intent;
END $$;

CREATE FUNCTION trustwork.assistant_cancel_run(p_run_id uuid, p_reason text)
RETURNS trustwork.run LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_run trustwork.run%ROWTYPE;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_run FROM trustwork.run WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.principal_person_id <> v_person THEN
    RAISE EXCEPTION 'unknown run' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_run.state IN ('completed', 'failed', 'cancelled') THEN
    RETURN v_run;
  END IF;
  UPDATE trustwork.run SET state = 'cancelled', ended_at = clock_timestamp(), ended_reason = left(coalesce(p_reason, 'cancelled by the person'), 500) WHERE id = p_run_id;
  PERFORM trustwork.assistant_revoke_pending(NULL, p_run_id, NULL, 'run_cancelled');
  SELECT * INTO v_run FROM trustwork.run WHERE id = p_run_id;
  RETURN v_run;
END $$;

-- The person's stop control: one action suspends every active mandate of the person (they come back only through a
-- new first-party confirmation) and revokes every not yet started action. Never needs step-up; never disabled.
CREATE FUNCTION trustwork.assistant_engage_stop()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_stop trustwork.participant_stop%ROWTYPE;
  v_id uuid;
  v_suspended integer := 0;
  v_revoked integer;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.assistant.stop'), hashtext(v_person::text));
  SELECT * INTO v_stop FROM trustwork.participant_stop WHERE person_id = v_person AND scope_kind = 'person_stop' AND state = 'engaged';
  IF NOT FOUND THEN
    INSERT INTO trustwork.participant_stop (scope_kind, person_id, engaged_by) VALUES ('person_stop', v_person, v_person) RETURNING * INTO v_stop;
  END IF;
  FOR v_id IN SELECT id FROM trustwork.mandate WHERE principal_person_id = v_person AND status = 'active' ORDER BY id LOOP
    PERFORM trustwork.assistant_apply_narrowing(v_id, 'suspended', 'person_stop', v_person, 'narrow');
    v_suspended := v_suspended + 1;
  END LOOP;
  v_revoked := trustwork.assistant_revoke_pending(NULL, NULL, v_person, 'person_stop');
  RETURN jsonb_build_object('stopId', v_stop.id, 'engagedAt', trustwork.assistant_iso(v_stop.engaged_at), 'suspendedMandates', v_suspended, 'revokedActions', v_revoked);
END $$;

CREATE FUNCTION trustwork.assistant_release_stop()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_count integer;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  UPDATE trustwork.participant_stop SET state = 'released', released_at = clock_timestamp() WHERE person_id = v_person AND scope_kind = 'person_stop' AND state = 'engaged';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('released', v_count > 0);
END $$;

-- 7. Worker entry points (trustwork_worker only) -------------------------------------------------------------------------
-- Pre-dispatch recheck and attempt identity, committed before the external call. Refusals end the intent as revoked
-- (nothing was called) and release its reservation.
CREATE FUNCTION trustwork.assistant_begin_attempt(p_intent_id uuid, p_job_id uuid, p_hub_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_job trustwork.job%ROWTYPE;
  v_intent trustwork.action_intent%ROWTYPE;
  v_mandate trustwork.mandate%ROWTYPE;
  v_reservation trustwork.reservation%ROWTYPE;
  v_attempt trustwork.action_attempt%ROWTYPE;
  v_refusal text;
BEGIN
  SELECT * INTO v_job FROM trustwork.job WHERE id = p_job_id;
  IF NOT FOUND OR v_job.state <> 'leased' OR v_job.kind <> 'assistant.dispatch' OR (v_job.payload ->> 'intentId') IS DISTINCT FROM p_intent_id::text THEN
    RAISE EXCEPTION 'the dispatch job does not hold a lease for this intent' USING ERRCODE = 'lock_not_available', HINT = 'assistant.fenced_out';
  END IF;
  SELECT * INTO v_intent FROM trustwork.action_intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skip', 'state', 'missing');
  END IF;
  IF v_intent.state <> 'queued' THEN
    RETURN jsonb_build_object('status', 'skip', 'state', v_intent.state);
  END IF;
  SELECT * INTO v_mandate FROM trustwork.mandate WHERE id = v_intent.mandate_id FOR SHARE;
  IF v_mandate.status <> 'active' THEN
    v_refusal := 'mandate_not_active';
  ELSIF v_mandate.revision <> v_intent.mandate_revision THEN
    v_refusal := 'mandate_revised';
  ELSIF v_mandate.valid_until <= clock_timestamp() THEN
    v_refusal := 'mandate_expired';
  ELSIF v_mandate.on_behalf_company_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustwork.membership WHERE person_id = v_intent.principal_person_id AND company_id = v_mandate.on_behalf_company_id AND status = 'active') THEN
    v_refusal := 'authority_basis_lost';
  ELSIF trustwork.assistant_dispatch_blocked(p_hub_id, v_intent.module_key, v_intent.action, v_intent.principal_person_id, NULL) IS NOT NULL THEN
    v_refusal := 'kill_switch';
  ELSIF cardinality(v_intent.ask_reasons) > 0 AND NOT EXISTS (
      SELECT 1 FROM trustwork.approval WHERE action_intent_id = v_intent.id AND action_digest = v_intent.action_digest AND mandate_revision = v_intent.mandate_revision AND revoked_at IS NULL) THEN
    v_refusal := 'approval_missing';
  ELSIF v_intent.reservation_id IS NOT NULL THEN
    SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = v_intent.reservation_id;
    IF v_reservation.state <> 'reserved' OR v_reservation.expires_at <= clock_timestamp() THEN
      v_refusal := 'reservation_closed';
    END IF;
  END IF;
  IF v_refusal IS NOT NULL THEN
    PERFORM trustwork.assistant_finish_intent(v_intent.id, 'revoked', 'recheck: ' || v_refusal, 'recheck:' || v_refusal);
    RETURN jsonb_build_object('status', 'refused', 'reason', v_refusal);
  END IF;
  INSERT INTO trustwork.action_attempt (action_intent_id, attempt_no, operation_id, provider, job_id, fencing_token)
  VALUES (v_intent.id, v_intent.attempt_count + 1, trustwork.new_uuid(), v_intent.effect ->> 'provider', v_job.id, v_job.fencing_token)
  RETURNING * INTO v_attempt;
  UPDATE trustwork.action_intent SET state = 'executing', attempt_count = attempt_count + 1 WHERE id = v_intent.id;
  RETURN jsonb_build_object('status', 'dispatch', 'attemptId', v_attempt.id, 'attemptNo', v_attempt.attempt_no, 'operationId', v_attempt.operation_id,
    'correlationKey', v_intent.effect_correlation_key, 'provider', v_intent.effect ->> 'provider', 'operation', v_intent.effect ->> 'operation', 'payload', v_intent.effect -> 'payload',
    'amount', CASE WHEN v_intent.amount_minor IS NULL THEN NULL ELSE jsonb_build_object('minorUnits', v_intent.amount_minor::text, 'currency', v_intent.currency) END);
END $$;

-- Applies one observed outcome to an intent (shared by dispatch results, receipts and reconciliations).
CREATE FUNCTION trustwork.assistant_apply_outcome(p_intent trustwork.action_intent, p_attempt_id uuid, p_kind text, p_result text, p_reason text, p_provider_ref text, p_evidence text, p_reconciliation_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_attempt trustwork.action_attempt%ROWTYPE;
BEGIN
  INSERT INTO trustwork.action_outcome (action_intent_id, attempt_id, kind, reason, result, provider_reference, evidence, reconciliation_id)
  VALUES (p_intent.id, p_attempt_id, p_kind, p_reason, p_result, p_provider_ref, p_evidence, p_reconciliation_id);
  UPDATE trustwork.action_intent SET outcome_kind = p_kind WHERE id = p_intent.id;
  IF p_kind = 'final' THEN
    PERFORM trustwork.assistant_finish_intent(p_intent.id, p_result, p_kind || ':' || p_result, coalesce(p_provider_ref, left(p_evidence, 200)));
    -- A dispatch job parked by an expired lease is closed with the reconciliation that proved its outcome.
    SELECT * INTO v_attempt FROM trustwork.action_attempt WHERE id = p_attempt_id;
    IF p_reconciliation_id IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.job WHERE id = v_attempt.job_id AND state = 'outcome_unknown') THEN
      PERFORM trustwork.reconcile_job(v_attempt.job_id, CASE p_result WHEN 'succeeded' THEN 'succeeded' ELSE 'failed' END, 'assistant.reconciliation:' || p_reconciliation_id::text);
    END IF;
    RETURN p_result;
  ELSIF p_kind = 'acknowledged' THEN
    IF p_intent.state = 'executing' THEN
      UPDATE trustwork.action_intent SET state = 'pending' WHERE id = p_intent.id;
      RETURN 'pending';
    END IF;
    IF p_intent.state = 'reconciling' THEN
      UPDATE trustwork.action_intent SET state = 'outcome_unknown', state_reason = 'acknowledged; awaiting a final outcome' WHERE id = p_intent.id;
      PERFORM trustwork.assistant_enqueue('assistant.reconcile', p_intent.id, 60);
      RETURN 'outcome_unknown';
    END IF;
    RETURN p_intent.state;
  END IF;
  IF p_intent.state IN ('executing', 'pending', 'reconciling') THEN
    UPDATE trustwork.action_intent SET state = 'outcome_unknown', state_reason = 'outcome unknown: ' || coalesce(p_reason, 'ambiguous') WHERE id = p_intent.id;
    PERFORM trustwork.assistant_enqueue('assistant.reconcile', p_intent.id, CASE WHEN p_intent.state = 'reconciling' THEN 60 ELSE 1 END);
  END IF;
  RETURN 'outcome_unknown';
END $$;

-- The result of the provider call, fenced by the dispatch job's token: a worker that lost its lease cannot record an
-- outcome (the intent is parked by the sweep and reconciled instead).
CREATE FUNCTION trustwork.assistant_record_outcome(p_attempt_id uuid, p_kind text, p_result text, p_reason text, p_provider_ref text, p_evidence text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_attempt trustwork.action_attempt%ROWTYPE;
  v_intent trustwork.action_intent%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('unknown', 'acknowledged', 'final') THEN
    RAISE EXCEPTION 'invalid outcome' USING ERRCODE = 'invalid_parameter_value', HINT = 'assistant.invalid_outcome';
  END IF;
  SELECT * INTO v_attempt FROM trustwork.action_attempt WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown attempt' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  SELECT * INTO v_intent FROM trustwork.action_intent WHERE id = v_attempt.action_intent_id FOR UPDATE;
  -- A receipt already ended this attempt: the dispatcher's own view of the call is superseded, not an error.
  IF v_attempt.state = 'ended' AND v_intent.state NOT IN ('executing', 'outcome_unknown', 'reconciling') THEN
    RETURN 'superseded';
  END IF;
  IF v_attempt.state <> 'executing' OR v_intent.state <> 'executing'
     OR NOT EXISTS (SELECT 1 FROM trustwork.job WHERE id = v_attempt.job_id AND state = 'leased' AND fencing_token = v_attempt.fencing_token) THEN
    RAISE EXCEPTION 'the attempt lost its lease; the outcome goes to reconciliation' USING ERRCODE = 'lock_not_available', HINT = 'assistant.fenced_out';
  END IF;
  UPDATE trustwork.action_attempt SET state = 'ended', ended_at = clock_timestamp() WHERE id = p_attempt_id;
  RETURN trustwork.assistant_apply_outcome(v_intent, p_attempt_id, p_kind, p_result, CASE WHEN p_kind = 'unknown' THEN coalesce(p_reason, 'ambiguous_response') ELSE NULL END,
    p_provider_ref, p_evidence, NULL);
END $$;

-- Sweep: an executing attempt whose dispatch job no longer holds a live lease (crashed or stalled worker; the REL-001
-- lease expiry parked the job as outcome_unknown) becomes outcome_unknown and gets a reconciliation job. Never a replay.
CREATE FUNCTION trustwork.assistant_park_stale_attempts(p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_attempt trustwork.action_attempt%ROWTYPE;
  v_intent trustwork.action_intent%ROWTYPE;
  v_count integer := 0;
BEGIN
  FOR v_attempt IN SELECT a.* FROM trustwork.action_attempt a JOIN trustwork.job j ON j.id = a.job_id
    WHERE a.state = 'executing' AND (j.state <> 'leased' OR j.fencing_token <> a.fencing_token OR j.leased_until < now())
    ORDER BY a.started_at LIMIT greatest(1, least(coalesce(p_limit, 100), 1000)) FOR UPDATE OF a SKIP LOCKED LOOP
    SELECT * INTO v_intent FROM trustwork.action_intent WHERE id = v_attempt.action_intent_id FOR UPDATE;
    UPDATE trustwork.action_attempt SET state = 'abandoned', ended_at = clock_timestamp() WHERE id = v_attempt.id;
    IF v_intent.state = 'executing' THEN
      PERFORM trustwork.assistant_apply_outcome(v_intent, v_attempt.id, 'unknown', NULL, 'lease_expired', NULL, NULL, NULL);
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END $$;

-- Reconciliation target: moves an unknown outcome to `reconciling` and returns what the provider lookup needs.
CREATE FUNCTION trustwork.assistant_begin_reconciliation(p_intent_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_intent trustwork.action_intent%ROWTYPE;
  v_attempt trustwork.action_attempt%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM trustwork.action_intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.state NOT IN ('outcome_unknown', 'reconciling') THEN
    RETURN jsonb_build_object('status', 'skip', 'state', coalesce(v_intent.state, 'missing'));
  END IF;
  SELECT * INTO v_attempt FROM trustwork.action_attempt WHERE action_intent_id = p_intent_id ORDER BY attempt_no DESC LIMIT 1;
  IF v_intent.state = 'outcome_unknown' THEN
    UPDATE trustwork.action_intent SET state = 'reconciling' WHERE id = p_intent_id;
  END IF;
  RETURN jsonb_build_object('status', 'reconcile', 'attemptId', v_attempt.id, 'operationId', v_attempt.operation_id, 'correlationKey', v_intent.effect_correlation_key,
    'provider', v_intent.effect ->> 'provider', 'operation', v_intent.effect ->> 'operation');
END $$;

CREATE FUNCTION trustwork.assistant_record_reconciliation(p_intent_id uuid, p_lookup_reference text, p_kind text, p_result text, p_provider_ref text, p_evidence text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_intent trustwork.action_intent%ROWTYPE;
  v_attempt trustwork.action_attempt%ROWTYPE;
  v_reconciliation uuid;
BEGIN
  IF p_kind NOT IN ('unknown', 'acknowledged', 'final') OR coalesce(length(p_lookup_reference), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid reconciliation' USING ERRCODE = 'invalid_parameter_value', HINT = 'assistant.invalid_outcome';
  END IF;
  SELECT * INTO v_intent FROM trustwork.action_intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.state <> 'reconciling' THEN
    RAISE EXCEPTION 'the action is not being reconciled' USING ERRCODE = 'check_violation', HINT = 'assistant.invalid_transition';
  END IF;
  SELECT * INTO v_attempt FROM trustwork.action_attempt WHERE action_intent_id = p_intent_id ORDER BY attempt_no DESC LIMIT 1;
  INSERT INTO trustwork.reconciliation (action_intent_id, attempt_id, operation_id, lookup_reference, outcome, reconciled_by)
  VALUES (p_intent_id, v_attempt.id, v_attempt.operation_id, p_lookup_reference,
    jsonb_strip_nulls(jsonb_build_object('kind', p_kind, 'result', p_result, 'providerReference', p_provider_ref, 'evidence', p_evidence, 'observedAt', trustwork.assistant_iso(clock_timestamp()))), 'worker')
  RETURNING id INTO v_reconciliation;
  RETURN trustwork.assistant_apply_outcome(v_intent, v_attempt.id, p_kind, p_result, CASE WHEN p_kind = 'unknown' THEN 'ambiguous_response' ELSE NULL END,
    p_provider_ref, p_evidence, CASE WHEN p_kind = 'final' THEN v_reconciliation ELSE NULL END);
END $$;

-- Asynchronous provider receipt (webhook), deduplicated by (provider, account, event id). A receipt for a pending action
-- finishes it (accepted then rejected ends as failed and releases the reservation); a receipt for an unknown outcome is
-- reconciliation evidence and goes through a reconciliation record.
CREATE FUNCTION trustwork.assistant_record_receipt(p_provider text, p_account text, p_event_id text, p_correlation_key text, p_kind text, p_result text, p_provider_ref text, p_evidence text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_intent trustwork.action_intent%ROWTYPE;
  v_attempt trustwork.action_attempt%ROWTYPE;
  v_inserted integer;
  v_reconciliation uuid;
BEGIN
  IF p_kind NOT IN ('acknowledged', 'final') THEN
    RAISE EXCEPTION 'a receipt is an acknowledgement or a final outcome' USING ERRCODE = 'invalid_parameter_value', HINT = 'assistant.invalid_outcome';
  END IF;
  INSERT INTO trustwork.inbox_receipt (provider, account, event_id) VALUES (p_provider, p_account, p_event_id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN 'duplicate';
  END IF;
  SELECT * INTO v_intent FROM trustwork.action_intent WHERE effect_correlation_key = p_correlation_key FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unknown_action';
  END IF;
  IF (v_intent.effect ->> 'provider') IS DISTINCT FROM p_provider THEN
    RETURN 'provider_mismatch';
  END IF;
  SELECT * INTO v_attempt FROM trustwork.action_attempt WHERE action_intent_id = v_intent.id ORDER BY attempt_no DESC LIMIT 1;
  IF v_intent.state IN ('pending', 'executing') THEN
    IF v_intent.state = 'executing' THEN
      UPDATE trustwork.action_attempt SET state = 'ended', ended_at = clock_timestamp() WHERE id = v_attempt.id AND state = 'executing';
    END IF;
    RETURN trustwork.assistant_apply_outcome(v_intent, v_attempt.id, p_kind, p_result, NULL, p_provider_ref, p_evidence, NULL);
  END IF;
  IF v_intent.state IN ('outcome_unknown', 'reconciling') THEN
    IF v_intent.state = 'outcome_unknown' THEN
      UPDATE trustwork.action_intent SET state = 'reconciling' WHERE id = v_intent.id RETURNING * INTO v_intent;
    END IF;
    INSERT INTO trustwork.reconciliation (action_intent_id, attempt_id, operation_id, lookup_reference, outcome, reconciled_by)
    VALUES (v_intent.id, v_attempt.id, v_attempt.operation_id, left('receipt:' || p_provider || ':' || p_event_id, 200),
      jsonb_strip_nulls(jsonb_build_object('kind', p_kind, 'result', p_result, 'providerReference', p_provider_ref, 'evidence', p_evidence, 'observedAt', trustwork.assistant_iso(clock_timestamp()))), 'worker')
    RETURNING id INTO v_reconciliation;
    RETURN trustwork.assistant_apply_outcome(v_intent, v_attempt.id, p_kind, p_result, NULL, p_provider_ref, p_evidence, CASE WHEN p_kind = 'final' THEN v_reconciliation ELSE NULL END);
  END IF;
  RETURN 'stale';
END $$;

-- 8. Row-level security --------------------------------------------------------------------------------------------------
ALTER TABLE trustwork.mandate ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mandate FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mandate_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mandate_context FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mandate_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mandate_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mandate_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mandate_proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mandate_use ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mandate_use FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.participant_stop ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.participant_stop FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.run ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.run FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.run_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.run_step FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.action_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.action_intent FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.action_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.action_attempt FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.action_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.action_outcome FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.reconciliation FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.conversation_turn ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.conversation_turn FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.assistant_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.assistant_note FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.service_backlog_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.service_backlog_item FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.mandate AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.mandate_context AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.mandate_revision AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.mandate_proposal AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.mandate_use AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.participant_stop AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.run AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.run_step AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.action_intent AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.action_attempt AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.action_outcome AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.approval AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.reconciliation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.conversation_turn AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.assistant_note AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.service_backlog_item AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Everything here is the principal's own (owner_private). Company members' views of company mandates and the staff
-- diagnostic subset (toMandateStaffCaseView) arrive with AGT-001 and the case-grant projections.
CREATE POLICY mandate_read ON trustwork.mandate FOR SELECT TO trustwork_app USING (principal_person_id = trustwork.current_person_id());
CREATE POLICY mandate_context_read ON trustwork.mandate_context FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.mandate m WHERE m.id = mandate_id));
CREATE POLICY mandate_revision_read ON trustwork.mandate_revision FOR SELECT TO trustwork_app USING (principal_person_id = trustwork.current_person_id());
CREATE POLICY mandate_use_read ON trustwork.mandate_use FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.mandate m WHERE m.id = mandate_id));
CREATE POLICY mandate_proposal_read ON trustwork.mandate_proposal FOR SELECT TO trustwork_app USING (principal_person_id = trustwork.current_person_id());
CREATE POLICY mandate_proposal_insert ON trustwork.mandate_proposal FOR INSERT TO trustwork_app WITH CHECK (principal_person_id = trustwork.current_person_id());
CREATE POLICY mandate_proposal_decline ON trustwork.mandate_proposal FOR UPDATE TO trustwork_app
  USING (principal_person_id = trustwork.current_person_id()) WITH CHECK (principal_person_id = trustwork.current_person_id() AND status = 'declined');
CREATE POLICY participant_stop_read ON trustwork.participant_stop FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());
CREATE POLICY run_read ON trustwork.run FOR SELECT TO trustwork_app USING (principal_person_id = trustwork.current_person_id());
CREATE POLICY run_insert ON trustwork.run FOR INSERT TO trustwork_app WITH CHECK (principal_person_id = trustwork.current_person_id()
  AND (mandate_id IS NULL OR EXISTS (SELECT 1 FROM trustwork.mandate m WHERE m.id = mandate_id)));
CREATE POLICY run_update ON trustwork.run FOR UPDATE TO trustwork_app USING (principal_person_id = trustwork.current_person_id()) WITH CHECK (principal_person_id = trustwork.current_person_id());
CREATE POLICY run_step_read ON trustwork.run_step FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.run r WHERE r.id = run_id));
CREATE POLICY run_step_insert ON trustwork.run_step FOR INSERT TO trustwork_app WITH CHECK (EXISTS (SELECT 1 FROM trustwork.run r WHERE r.id = run_id AND r.state NOT IN ('completed', 'failed', 'cancelled')));
CREATE POLICY action_intent_read ON trustwork.action_intent FOR SELECT TO trustwork_app USING (principal_person_id = trustwork.current_person_id());
CREATE POLICY action_attempt_read ON trustwork.action_attempt FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.action_intent i WHERE i.id = action_intent_id));
CREATE POLICY action_outcome_read ON trustwork.action_outcome FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.action_intent i WHERE i.id = action_intent_id));
CREATE POLICY approval_read ON trustwork.approval FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.action_intent i WHERE i.id = action_intent_id));
CREATE POLICY reconciliation_read ON trustwork.reconciliation FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.action_intent i WHERE i.id = action_intent_id));
CREATE POLICY conversation_turn_read ON trustwork.conversation_turn FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());
CREATE POLICY conversation_turn_insert ON trustwork.conversation_turn FOR INSERT TO trustwork_app WITH CHECK (person_id = trustwork.current_person_id()
  AND (run_id IS NULL OR EXISTS (SELECT 1 FROM trustwork.run r WHERE r.id = run_id)));
CREATE POLICY assistant_note_read ON trustwork.assistant_note FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());
CREATE POLICY assistant_note_insert ON trustwork.assistant_note FOR INSERT TO trustwork_app WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY service_backlog_item_read ON trustwork.service_backlog_item FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());
CREATE POLICY service_backlog_item_insert ON trustwork.service_backlog_item FOR INSERT TO trustwork_app WITH CHECK (person_id = trustwork.current_person_id()
  AND status = 'proposed' AND (company_id IS NULL OR company_id = trustwork.current_company_id()) AND (source_run_id IS NULL OR EXISTS (SELECT 1 FROM trustwork.run r WHERE r.id = source_run_id)));
CREATE POLICY service_backlog_item_update ON trustwork.service_backlog_item FOR UPDATE TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());

-- 9. Grants --------------------------------------------------------------------------------------------------------------
GRANT SELECT ON trustwork.mandate, trustwork.mandate_context, trustwork.mandate_revision, trustwork.mandate_proposal, trustwork.mandate_use, trustwork.participant_stop,
  trustwork.run, trustwork.run_step, trustwork.action_intent, trustwork.action_attempt, trustwork.action_outcome, trustwork.approval, trustwork.reconciliation,
  trustwork.conversation_turn, trustwork.assistant_note, trustwork.service_backlog_item TO trustwork_app;
GRANT INSERT ON trustwork.mandate_proposal, trustwork.run, trustwork.run_step, trustwork.conversation_turn, trustwork.assistant_note, trustwork.service_backlog_item TO trustwork_app;
GRANT UPDATE (status, decided_at, decided_by_person_id) ON trustwork.mandate_proposal TO trustwork_app;
GRANT UPDATE (state, checkpoint, cost_counters, ended_at, ended_reason) ON trustwork.run TO trustwork_app;
GRANT UPDATE (status) ON trustwork.service_backlog_item TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.assistant_confirm_mandate(jsonb, jsonb, text, integer, boolean, uuid), trustwork.assistant_narrow_mandate(uuid, integer, text, text),
  trustwork.assistant_revoke_for_basis(uuid, uuid, text), trustwork.assistant_dispatch_blocked(uuid, text, text, uuid, uuid),
  trustwork.assistant_record_intent(uuid, uuid, integer, text, text, text, text, text, boolean, bigint, text, text, jsonb, text, text[]),
  trustwork.assistant_approve_intent(uuid, text, integer, boolean), trustwork.assistant_decline_intent(uuid, text), trustwork.assistant_queue_intent(uuid, integer, uuid),
  trustwork.assistant_cancel_run(uuid, text), trustwork.assistant_engage_stop(), trustwork.assistant_release_stop() TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.assistant_dispatch_blocked(uuid, text, text, uuid, uuid), trustwork.assistant_begin_attempt(uuid, uuid, uuid),
  trustwork.assistant_record_outcome(uuid, text, text, text, text, text), trustwork.assistant_park_stale_attempts(integer), trustwork.assistant_begin_reconciliation(uuid),
  trustwork.assistant_record_reconciliation(uuid, text, text, text, text, text), trustwork.assistant_record_receipt(text, text, text, text, text, text, text, text) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
