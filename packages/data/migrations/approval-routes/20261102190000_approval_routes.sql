-- PRC-001: approval routes, requests, decisions and delegation (handbook docs/engine/procurement-and-supply.md,
-- "Approval routes"; data model section 18a; contracts packages/contracts/src/supply/approvals.ts).
--
-- * approval_route_version: a company's versioned rules per subject kind. Drafted and activated by members holding
--   procurement.routes.manage (company administrators hold every procurement permission); one active version per
--   company and subject kind; payload and digest are frozen once the version leaves draft; a hub may require a second
--   person to activate. Pending requests keep the version they were resolved against.
-- * approval_request: binds the exact frozen subject version id and digest. One pending request per subject: a new
--   subject version supersedes it (approval_submit, approval_supersede). Outcomes are terminal.
-- * approval_request_step: the steps that applied to this request (conditions are evaluated by the module from the
--   subject facts; the definitions are copied here from the route payload). Steps of the lowest order are pending,
--   later ones wait. A pending step past its due time escalates once to the step's escalation target; a second
--   timeout expires the request. Nothing is ever approved by silence.
-- * approval_decision: append-only, one per voter and step. The decider is a person on the first-party surface: the
--   command requires a live session of the current person; there is no mandate, connection or extension column and
--   the worker role has no grant. Built-in segregation of duties: the requester never decides (no exception); the
--   person who changed a payee's bank details never approves a payment to that payee; the payee-change verifier never
--   alone approves the first payment; the receipt recorder never alone approves the matching invoice above the
--   route's threshold; a payment proposal's preparer never alone approves it. For the "alone" rules a company with
--   exactly one eligible approver gets an audit flag (sod_flag) instead of a silent bypass.
-- * approval_delegation: time-boxed (at most 90 days), audited and revocable; covers chosen subject kinds up to an
--   optional limit and never more than the delegator's own current eligibility for the step; it stops counting when
--   either membership ends. A delegate never re-delegates.
--
-- Entry points (SECURITY DEFINER, pinned search_path):
--   runtime (trustwork_app): approval_draft_route, approval_activate_route, approval_submit, approval_supersede,
--     approval_withdraw, approval_decide, approval_delegate, approval_revoke_delegation, approval_decisions_waiting,
--     approval_viewer_options, approval_request_visible, approval_member_of, approval_holds_permission
--   worker (trustwork_worker): approval_escalate_due
-- The runtime role reads the tables under row-level security and writes nothing directly.

-- 1. Route versions -----------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.approval_subject_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['requisition', 'award', 'order', 'order_change', 'trade_invoice', 'payment_proposal', 'document', 'substitution', 'budget_change', 'payee_change', 'supplier_status']::text[]
$$;

CREATE TABLE trustwork.approval_route_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_company_id uuid NOT NULL REFERENCES trustwork.company (id),
  subject_kind text NOT NULL CHECK (subject_kind = ANY (trustwork.approval_subject_kinds())),
  version integer NOT NULL CHECK (version >= 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'steps') = 'array' AND jsonb_array_length(payload -> 'steps') BETWEEN 1 AND 20),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  template_key text NULL CHECK (template_key IS NULL OR template_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  template_version integer NULL CHECK (template_version IS NULL OR template_version >= 1),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  drafted_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  superseded_at timestamptz NULL,
  second_person_required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_route_version_unique UNIQUE (owner_company_id, subject_kind, version),
  CONSTRAINT approval_route_template_pair CHECK ((template_key IS NULL) = (template_version IS NULL)),
  CONSTRAINT approval_route_activation_shape CHECK ((status = 'draft') = (activated_by IS NULL) AND (activated_by IS NULL) = (activated_at IS NULL)),
  CONSTRAINT approval_route_superseded_shape CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CONSTRAINT approval_route_second_person CHECK (NOT second_person_required OR activated_by IS NULL OR activated_by <> drafted_by)
);
CREATE UNIQUE INDEX approval_route_one_active ON trustwork.approval_route_version (owner_company_id, subject_kind) WHERE status = 'active';

CREATE FUNCTION trustwork.approval_route_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'route versions are history and are never deleted' USING ERRCODE = '23514', HINT = 'approvals.record_permanent';
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_company_id <> OLD.owner_company_id OR NEW.subject_kind <> OLD.subject_kind OR NEW.version <> OLD.version
     OR NEW.payload <> OLD.payload OR NEW.digest <> OLD.digest OR NEW.template_key IS DISTINCT FROM OLD.template_key OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.drafted_by <> OLD.drafted_by OR NEW.drafted_at <> OLD.drafted_at OR NEW.second_person_required <> OLD.second_person_required OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a route version is frozen' USING ERRCODE = '23514', HINT = 'approvals.route_frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status = 'active') OR (OLD.status = 'active' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'route transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'approvals.invalid_transition';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.activated_by IS DISTINCT FROM OLD.activated_by OR NEW.activated_at IS DISTINCT FROM OLD.activated_at) THEN
    RAISE EXCEPTION 'activation is recorded once' USING ERRCODE = '23514', HINT = 'approvals.route_frozen';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER approval_route_version_guard BEFORE UPDATE OR DELETE ON trustwork.approval_route_version FOR EACH ROW EXECUTE FUNCTION trustwork.approval_route_version_guard();
CREATE TRIGGER approval_route_version_no_truncate BEFORE TRUNCATE ON trustwork.approval_route_version FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Requests -------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.approval_request (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_company_id uuid NOT NULL REFERENCES trustwork.company (id),
  subject_kind text NOT NULL CHECK (subject_kind = ANY (trustwork.approval_subject_kinds())),
  subject_id uuid NOT NULL,
  subject_version_id uuid NOT NULL,
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  route_version_id uuid NOT NULL REFERENCES trustwork.approval_route_version (id),
  project_id uuid NULL REFERENCES trustwork.project (id),
  current_step text NOT NULL CHECK (current_step ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  requested_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  amount_minor numeric(38, 0) NULL,
  currency text NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  -- Structured subject facts the conditions and the segregation-of-duties rules read (ApprovalSubjectFactsSchema).
  facts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(facts) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'withdrawn', 'expired', 'superseded')),
  submitted_at timestamptz NOT NULL,
  closed_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_request_amount_pair CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  CONSTRAINT approval_request_closed_shape CHECK ((status = 'pending') = (closed_at IS NULL))
);
CREATE UNIQUE INDEX approval_request_one_pending ON trustwork.approval_request (subject_kind, subject_id) WHERE status = 'pending';
CREATE INDEX approval_request_company_idx ON trustwork.approval_request (owner_company_id, status);
CREATE INDEX approval_request_requester_idx ON trustwork.approval_request (requested_by_person_id);

CREATE FUNCTION trustwork.approval_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval requests are never deleted' USING ERRCODE = '23514', HINT = 'approvals.record_permanent';
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_company_id <> OLD.owner_company_id OR NEW.subject_kind <> OLD.subject_kind OR NEW.subject_id <> OLD.subject_id
     OR NEW.subject_version_id <> OLD.subject_version_id OR NEW.subject_digest <> OLD.subject_digest OR NEW.route_version_id <> OLD.route_version_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.requested_by_person_id <> OLD.requested_by_person_id OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.facts <> OLD.facts OR NEW.submitted_at <> OLD.submitted_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an approval request keeps its binding' USING ERRCODE = '23514', HINT = 'approvals.request_frozen';
  END IF;
  -- Contract APPROVAL_REQUEST_TRANSITIONS: pending -> any outcome; every outcome is terminal.
  IF NEW.status <> OLD.status AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'request transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'approvals.invalid_transition';
  END IF;
  IF OLD.status <> 'pending' AND NEW.current_step <> OLD.current_step THEN
    RAISE EXCEPTION 'a closed request does not move' USING ERRCODE = '23514', HINT = 'approvals.invalid_transition';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER approval_request_guard BEFORE UPDATE OR DELETE ON trustwork.approval_request FOR EACH ROW EXECUTE FUNCTION trustwork.approval_request_guard();
CREATE TRIGGER approval_request_no_truncate BEFORE TRUNCATE ON trustwork.approval_request FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Steps of a request ---------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.approval_request_step (
  request_id uuid NOT NULL REFERENCES trustwork.approval_request (id),
  step_key text NOT NULL CHECK (step_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  step_order integer NOT NULL CHECK (step_order BETWEEN 1 AND 50),
  quorum integer NOT NULL CHECK (quorum BETWEEN 1 AND 10),
  -- The selector deciding now: the route's selector, or the escalation target after a timeout.
  selector jsonb NOT NULL CHECK (jsonb_typeof(selector) = 'object' AND selector ->> 'kind' IN ('permission_holders', 'named_person', 'project_leader', 'any_of', 'route_owner')),
  escalation jsonb NOT NULL CHECK (jsonb_typeof(escalation) = 'object' AND escalation ->> 'kind' IN ('next_selector', 'route_owner')),
  timeout_hours integer NOT NULL CHECK (timeout_hours BETWEEN 1 AND 1440),
  escalation_level integer NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 1),
  due_at timestamptz NULL,
  approvals integer NOT NULL DEFAULT 0 CHECK (approvals >= 0),
  status text NOT NULL CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'returned', 'expired', 'closed')),
  escalated_at timestamptz NULL,
  completed_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, step_key),
  CONSTRAINT approval_step_due_shape CHECK ((status = 'pending') = (due_at IS NOT NULL) OR status NOT IN ('pending', 'waiting')),
  CONSTRAINT approval_step_escalated_shape CHECK ((escalation_level = 1) = (escalated_at IS NOT NULL)),
  CONSTRAINT approval_step_quorum_reached CHECK (status <> 'approved' OR approvals >= quorum)
);

CREATE FUNCTION trustwork.approval_request_step_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval steps are never deleted' USING ERRCODE = '23514', HINT = 'approvals.record_permanent';
  END IF;
  IF NEW.request_id <> OLD.request_id OR NEW.step_key <> OLD.step_key OR NEW.step_order <> OLD.step_order OR NEW.quorum <> OLD.quorum
     OR NEW.escalation <> OLD.escalation OR NEW.timeout_hours <> OLD.timeout_hours OR NEW.escalation_level < OLD.escalation_level OR NEW.approvals < OLD.approvals THEN
    RAISE EXCEPTION 'an approval step keeps its definition' USING ERRCODE = '23514', HINT = 'approvals.request_frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'waiting' AND NEW.status IN ('pending', 'closed'))
    OR (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'returned', 'expired', 'closed'))
  ) THEN
    RAISE EXCEPTION 'step transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'approvals.invalid_transition';
  END IF;
  IF OLD.status NOT IN ('waiting', 'pending') AND (NEW.selector <> OLD.selector OR NEW.approvals <> OLD.approvals) THEN
    RAISE EXCEPTION 'a finished step does not change' USING ERRCODE = '23514', HINT = 'approvals.invalid_transition';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER approval_request_step_guard BEFORE UPDATE OR DELETE ON trustwork.approval_request_step FOR EACH ROW EXECUTE FUNCTION trustwork.approval_request_step_guard();
CREATE TRIGGER approval_request_step_no_truncate BEFORE TRUNCATE ON trustwork.approval_request_step FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Delegations ------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.approval_delegation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  delegator_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  delegate_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  subject_kinds text[] NOT NULL CHECK (cardinality(subject_kinds) BETWEEN 1 AND 11 AND subject_kinds <@ trustwork.approval_subject_kinds()),
  limit_minor numeric(38, 0) NULL CHECK (limit_minor IS NULL OR limit_minor >= 0),
  limit_currency text NULL CHECK (limit_currency IS NULL OR limit_currency ~ '^[A-Z]{3}$'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'revoked')),
  revoked_at timestamptz NULL,
  revoked_by uuid NULL REFERENCES trustwork.person (id),
  revoked_reason text NULL CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_delegation_other_person CHECK (delegator_person_id <> delegate_person_id),
  CONSTRAINT approval_delegation_window CHECK (valid_until > valid_from AND valid_until - valid_from <= interval '90 days'),
  CONSTRAINT approval_delegation_limit_pair CHECK ((limit_minor IS NULL) = (limit_currency IS NULL)),
  CONSTRAINT approval_delegation_revoked_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL) AND (revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX approval_delegation_delegate_idx ON trustwork.approval_delegation (delegate_person_id, company_id) WHERE status = 'active';
CREATE INDEX approval_delegation_delegator_idx ON trustwork.approval_delegation (delegator_person_id);

CREATE FUNCTION trustwork.approval_delegation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delegations are audit history and are never deleted' USING ERRCODE = '23514', HINT = 'approvals.record_permanent';
  END IF;
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.delegator_person_id <> OLD.delegator_person_id OR NEW.delegate_person_id <> OLD.delegate_person_id
     OR NEW.subject_kinds <> OLD.subject_kinds OR NEW.limit_minor IS DISTINCT FROM OLD.limit_minor OR NEW.limit_currency IS DISTINCT FROM OLD.limit_currency
     OR NEW.valid_from <> OLD.valid_from OR NEW.valid_until <> OLD.valid_until OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a delegation is changed only by revoking it and creating another' USING ERRCODE = '23514', HINT = 'approvals.delegation_frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'active' AND NEW.status IN ('ended', 'revoked')) THEN
    RAISE EXCEPTION 'delegation transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'approvals.invalid_transition';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER approval_delegation_guard BEFORE UPDATE OR DELETE ON trustwork.approval_delegation FOR EACH ROW EXECUTE FUNCTION trustwork.approval_delegation_guard();
CREATE TRIGGER approval_delegation_no_truncate BEFORE TRUNCATE ON trustwork.approval_delegation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 5. Decisions (append-only) -----------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.approval_sod_rules() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['requester_never_approves_own_subject', 'payee_changer_never_approves_payment_to_payee', 'payee_verifier_never_alone_approves_first_payment',
    'receiver_never_alone_approves_matching_invoice_above_threshold', 'preparer_never_alone_approves_payment_proposal']::text[]
$$;

CREATE TABLE trustwork.approval_decision (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  approval_request_id uuid NOT NULL REFERENCES trustwork.approval_request (id),
  step_key text NOT NULL,
  approver_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  -- The person whose authority counts: the approver, or the delegator when the approver decides as a delegate.
  voter_person_id uuid GENERATED ALWAYS AS (coalesce(delegated_from_person_id, approver_person_id)) STORED,
  on_behalf_company_id uuid NOT NULL REFERENCES trustwork.company (id),
  delegated_from_person_id uuid NULL REFERENCES trustwork.person (id),
  delegation_id uuid NULL REFERENCES trustwork.approval_delegation (id),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject', 'return')),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  reason text NULL CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  -- The first-party confirmation (FirstPartyConfirmationSchema): always the decider's own form, in their own session.
  confirmation_via text NOT NULL DEFAULT 'first_party_form' CHECK (confirmation_via = 'first_party_form'),
  session_id uuid NOT NULL REFERENCES trustwork.session (id),
  step_up boolean NOT NULL,
  escalation_level integer NOT NULL CHECK (escalation_level BETWEEN 0 AND 1),
  sod_flag text NULL CHECK (sod_flag IS NULL OR sod_flag = ANY (trustwork.approval_sod_rules())),
  decided_at timestamptz NOT NULL,
  FOREIGN KEY (approval_request_id, step_key) REFERENCES trustwork.approval_request_step (request_id, step_key),
  CONSTRAINT approval_decision_one_vote UNIQUE (approval_request_id, step_key, voter_person_id),
  CONSTRAINT approval_decision_delegation_pair CHECK ((delegated_from_person_id IS NULL) = (delegation_id IS NULL)),
  CONSTRAINT approval_decision_not_self_delegated CHECK (delegated_from_person_id IS DISTINCT FROM approver_person_id),
  CONSTRAINT approval_decision_reason CHECK (decision = 'approve' OR reason IS NOT NULL)
);
CREATE INDEX approval_decision_approver_idx ON trustwork.approval_decision (approver_person_id);

-- Checked for every writer: the decision restates the request's digest; the requester never decides, not even through a delegation.
CREATE FUNCTION trustwork.approval_decision_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  r trustwork.approval_request%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trustwork.approval_request WHERE id = NEW.approval_request_id;
  IF r.subject_digest <> NEW.subject_digest THEN
    RAISE EXCEPTION 'a decision binds the request digest' USING ERRCODE = '23514', HINT = 'approvals.digest_mismatch';
  END IF;
  IF r.requested_by_person_id IN (NEW.approver_person_id, coalesce(NEW.delegated_from_person_id, NEW.approver_person_id)) THEN
    RAISE EXCEPTION 'the requester never decides' USING ERRCODE = '42501', HINT = 'approvals.requester_cannot_decide';
  END IF;
  IF r.owner_company_id <> NEW.on_behalf_company_id THEN
    RAISE EXCEPTION 'a decision is made for the request owner' USING ERRCODE = '23514', HINT = 'approvals.request_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_decision_insert_guard BEFORE INSERT ON trustwork.approval_decision FOR EACH ROW EXECUTE FUNCTION trustwork.approval_decision_insert_guard();
CREATE TRIGGER approval_decision_append_only BEFORE UPDATE OR DELETE ON trustwork.approval_decision FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER approval_decision_no_truncate BEFORE TRUNCATE ON trustwork.approval_decision FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 6. Authority helpers (owner context only; called from the definer commands and the visibility function) -------------
CREATE FUNCTION trustwork.approval_active_member(p_company uuid, p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_company IS NOT NULL AND p_person IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.membership m WHERE m.company_id = p_company AND m.person_id = p_person AND m.status = 'active' AND m.valid_from <= now())
$$;

CREATE FUNCTION trustwork.approval_is_admin(p_company uuid, p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.company_id = p_company AND m.person_id = p_person AND m.status = 'active' AND m.valid_from <= now() AND m.role = 'administrator')
$$;

-- A procurement permission: company administrators hold every procurement permission company-wide; other members hold
-- one through a live permission_grant scoped to the company (and, for project scope, to the project), granted by
-- someone else who is currently an administrator or holds company.members.manage in that company.
CREATE FUNCTION trustwork.approval_holds(p_company uuid, p_person uuid, p_permission text, p_project uuid, p_project_scope boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.approval_active_member(p_company, p_person) AND p_permission ~ '^procurement\.[a-z_.]+$' AND (
    (NOT p_project_scope AND trustwork.approval_is_admin(p_company, p_person))
    OR EXISTS (
      SELECT 1 FROM trustwork.permission_grant g
      WHERE g.principal_person_id = p_person AND g.action = p_permission AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
        AND g.scope ->> 'companyId' = p_company::text
        AND CASE WHEN p_project_scope THEN p_project IS NOT NULL AND g.scope ->> 'projectId' = p_project::text ELSE NOT (g.scope ? 'projectId') END
        AND g.granted_by <> p_person
        AND EXISTS (SELECT 1 FROM trustwork.membership gm WHERE gm.person_id = g.granted_by AND gm.company_id = p_company AND gm.status = 'active' AND gm.valid_from <= now()
          AND (gm.role = 'administrator' OR 'company.members.manage' = ANY (gm.permissions)))
    )
  )
$$;

-- Whether a person is selected by a selector for this request now. Every kind requires an active member of the company.
CREATE FUNCTION trustwork.approval_selector_matches(p_company uuid, p_person uuid, p_selector jsonb, p_project uuid, p_route uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_activator uuid;
BEGIN
  IF NOT trustwork.approval_active_member(p_company, p_person) THEN
    RETURN false;
  END IF;
  CASE p_selector ->> 'kind'
    WHEN 'permission_holders' THEN
      RETURN trustwork.approval_holds(p_company, p_person, p_selector ->> 'permission', p_project, p_selector ->> 'scope' = 'project');
    WHEN 'named_person' THEN
      RETURN p_person::text = p_selector ->> 'personId';
    WHEN 'project_leader' THEN
      RETURN p_project IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.project pr WHERE pr.id = p_project AND pr.leader_person_id = p_person);
    WHEN 'any_of' THEN
      RETURN jsonb_typeof(p_selector -> 'personIds') = 'array' AND (p_selector -> 'personIds') ? p_person::text;
    WHEN 'route_owner' THEN
      -- The member who activated the route version; when they are no longer an active member, the company administrators.
      SELECT activated_by INTO v_activator FROM trustwork.approval_route_version WHERE id = p_route;
      IF v_activator IS NOT NULL AND trustwork.approval_active_member(p_company, v_activator) THEN
        RETURN p_person = v_activator;
      END IF;
      RETURN trustwork.approval_is_admin(p_company, p_person);
    ELSE
      RETURN false;
  END CASE;
END $$;

-- Distinct active members other than the requester whom the selector picks now.
CREATE FUNCTION trustwork.approval_eligible_count(p_company uuid, p_selector jsonb, p_project uuid, p_route uuid, p_requester uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT count(DISTINCT m.person_id)::integer FROM trustwork.membership m
  WHERE m.company_id = p_company AND m.status = 'active' AND m.valid_from <= now() AND m.person_id <> p_requester
    AND trustwork.approval_selector_matches(p_company, m.person_id, p_selector, p_project, p_route)
$$;

-- The selector that decides a pending step at a moment: the stored one, the escalation target once the step is past
-- its due time, NULL once the escalated step timed out too (the request expires; nothing is approved by silence). The
-- sweep and the decision command persist the same result.
CREATE FUNCTION trustwork.approval_effective_selector(s trustwork.approval_request_step, p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF s.status <> 'pending' OR s.due_at > p_now THEN
    RETURN s.selector;
  END IF;
  IF s.escalation_level = 0 AND s.due_at + make_interval(hours => s.timeout_hours) > p_now THEN
    RETURN CASE WHEN s.escalation ->> 'kind' = 'next_selector' THEN s.escalation -> 'selector' ELSE '{"kind":"route_owner"}'::jsonb END;
  END IF;
  RETURN NULL;
END $$;

-- Who may vote on a step: the person directly, or as the delegate of someone whose own current eligibility covers it.
-- A delegation never exceeds the delegator: subject kind, limit, validity, both memberships and the delegator's
-- eligibility are checked at the moment of the decision. Refusals: requester, not_member, delegation_exceeds_rights,
-- not_an_approver.
CREATE FUNCTION trustwork.approval_authority(p_request uuid, p_selector jsonb, p_person uuid, p_now timestamptz, OUT voter uuid, OUT delegation_id uuid, OUT refusal text)
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  r trustwork.approval_request%ROWTYPE;
  d trustwork.approval_delegation%ROWTYPE;
  v_exceeds boolean := false;
BEGIN
  SELECT * INTO r FROM trustwork.approval_request WHERE id = p_request;
  IF r.id IS NULL THEN
    refusal := 'not_found'; RETURN;
  END IF;
  IF p_selector IS NULL THEN
    refusal := 'expired'; RETURN;
  END IF;
  IF p_person = r.requested_by_person_id THEN
    refusal := 'requester'; RETURN;
  END IF;
  IF NOT trustwork.approval_active_member(r.owner_company_id, p_person) THEN
    refusal := 'not_member'; RETURN;
  END IF;
  IF trustwork.approval_selector_matches(r.owner_company_id, p_person, p_selector, r.project_id, r.route_version_id) THEN
    voter := p_person; RETURN;
  END IF;
  FOR d IN SELECT * FROM trustwork.approval_delegation x
           WHERE x.company_id = r.owner_company_id AND x.delegate_person_id = p_person AND x.status = 'active' AND x.valid_from <= p_now AND x.valid_until > p_now
           ORDER BY x.valid_from, x.id LOOP
    IF d.delegator_person_id = r.requested_by_person_id
       OR NOT trustwork.approval_active_member(r.owner_company_id, d.delegator_person_id)
       OR NOT (r.subject_kind = ANY (d.subject_kinds))
       OR (d.limit_minor IS NOT NULL AND (r.amount_minor IS NULL OR r.currency IS DISTINCT FROM d.limit_currency OR r.amount_minor > d.limit_minor))
       OR NOT trustwork.approval_selector_matches(r.owner_company_id, d.delegator_person_id, p_selector, r.project_id, r.route_version_id) THEN
      v_exceeds := true;
      CONTINUE;
    END IF;
    voter := d.delegator_person_id;
    delegation_id := d.id;
    RETURN;
  END LOOP;
  refusal := CASE WHEN v_exceeds THEN 'delegation_exceeds_rights' ELSE 'not_an_approver' END;
END $$;

-- The built-in segregation-of-duties rules for an approval (contract sodViolation; the requester rule is enforced
-- before this, without exception). Returns the broken rule or NULL. `p_completes`: this vote finishes the request.
CREATE FUNCTION trustwork.approval_sod_check(r trustwork.approval_request, p_people uuid[], p_completes boolean) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_alone boolean;
  v_threshold numeric;
  v_threshold_currency text;
  f jsonb := r.facts;
  ids_in text := 'payeeChangedByPersonIds';
BEGIN
  IF r.subject_kind IN ('payment_proposal', 'trade_invoice') AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(coalesce(f -> ids_in, '[]'::jsonb)) x WHERE x::uuid = ANY (p_people)) THEN
    RETURN 'payee_changer_never_approves_payment_to_payee';
  END IF;
  IF NOT p_completes THEN
    RETURN NULL;
  END IF;
  -- Alone: nobody else has approved any step of this request.
  v_alone := NOT EXISTS (
    SELECT 1 FROM trustwork.approval_decision d WHERE d.approval_request_id = r.id AND d.decision = 'approve'
      AND NOT (d.approver_person_id = ANY (p_people)) AND NOT (d.voter_person_id = ANY (p_people)));
  IF NOT v_alone THEN
    RETURN NULL;
  END IF;
  IF r.subject_kind = 'payment_proposal' AND coalesce((f ->> 'firstPaymentToPayee')::boolean, false) AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(coalesce(f -> 'payeeVerifiedByPersonIds', '[]'::jsonb)) x WHERE x::uuid = ANY (p_people)) THEN
    RETURN 'payee_verifier_never_alone_approves_first_payment';
  END IF;
  IF r.subject_kind = 'trade_invoice' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(coalesce(f -> 'receiptRecordedByPersonIds', '[]'::jsonb)) x WHERE x::uuid = ANY (p_people)) THEN
    SELECT (v.payload -> 'receiverSoleApprovalThreshold' ->> 'minorUnits')::numeric, v.payload -> 'receiverSoleApprovalThreshold' ->> 'currency'
      INTO v_threshold, v_threshold_currency FROM trustwork.approval_route_version v WHERE v.id = r.route_version_id;
    -- Unknown amount, no threshold or a threshold in another currency fails closed.
    IF v_threshold IS NULL OR r.amount_minor IS NULL OR r.currency IS DISTINCT FROM v_threshold_currency OR r.amount_minor > v_threshold THEN
      RETURN 'receiver_never_alone_approves_matching_invoice_above_threshold';
    END IF;
  END IF;
  IF r.subject_kind = 'payment_proposal' AND (f ->> 'proposalPreparedByPersonId') IS NOT NULL AND (f ->> 'proposalPreparedByPersonId')::uuid = ANY (p_people) THEN
    RETURN 'preparer_never_alone_approves_payment_proposal';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION trustwork.approval_event(r trustwork.approval_request, p_type text) RETURNS void
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('approval_request', r.id, r.revision, p_type, jsonb_build_object('requestId', r.id, 'subjectKind', r.subject_kind, 'subjectId', r.subject_id,
    'subjectVersionId', r.subject_version_id, 'status', r.status, 'currentStep', r.current_step))
$$;

-- Closes the request with an outcome; open steps are closed.
CREATE FUNCTION trustwork.approval_close(p_request uuid, p_status text, p_now timestamptz) RETURNS trustwork.approval_request
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  r trustwork.approval_request%ROWTYPE;
BEGIN
  UPDATE trustwork.approval_request_step SET status = 'closed', due_at = NULL, completed_at = p_now WHERE request_id = p_request AND status IN ('waiting', 'pending');
  UPDATE trustwork.approval_request SET status = p_status, closed_at = p_now WHERE id = p_request RETURNING * INTO r;
  PERFORM trustwork.approval_event(r, 'approval.request_closed');
  RETURN r;
END $$;

-- Escalates the due pending steps of one request: the first timeout hands the step to its escalation target, the second
-- expires the request. The request row must be locked by the caller.
CREATE FUNCTION trustwork.approval_escalate_request(p_request uuid, p_now timestamptz) RETURNS integer
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  s trustwork.approval_request_step%ROWTYPE;
  r trustwork.approval_request%ROWTYPE;
  v_changed integer := 0;
  v_next timestamptz;
BEGIN
  FOR s IN SELECT * FROM trustwork.approval_request_step WHERE request_id = p_request AND status = 'pending' AND due_at <= p_now ORDER BY step_order, step_key LOOP
    v_next := s.due_at + make_interval(hours => s.timeout_hours);
    IF s.escalation_level = 0 AND v_next > p_now THEN
      UPDATE trustwork.approval_request_step
      SET selector = CASE WHEN s.escalation ->> 'kind' = 'next_selector' THEN s.escalation -> 'selector' ELSE '{"kind":"route_owner"}'::jsonb END,
          escalation_level = 1, escalated_at = p_now, due_at = v_next
      WHERE request_id = p_request AND step_key = s.step_key;
      UPDATE trustwork.approval_request SET current_step = current_step WHERE id = p_request RETURNING * INTO r;
      PERFORM trustwork.approval_event(r, 'approval.step_escalated');
      v_changed := v_changed + 1;
    ELSE
      UPDATE trustwork.approval_request_step SET status = 'expired', due_at = NULL, completed_at = p_now WHERE request_id = p_request AND step_key = s.step_key;
      PERFORM trustwork.approval_close(p_request, 'expired', p_now);
      RETURN v_changed + 1;
    END IF;
  END LOOP;
  RETURN v_changed;
END $$;

CREATE FUNCTION trustwork.approval_first_party_session(p_session uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.current_person_id() IS NULL OR p_session IS NULL OR NOT EXISTS (
    SELECT 1 FROM trustwork.session s WHERE s.id = p_session AND s.person_id = trustwork.current_person_id() AND s.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a person decides in their own first-party session' USING ERRCODE = '42501', HINT = 'approvals.first_party_required';
  END IF;
END $$;

-- 7. Commands (runtime role) ------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.approval_member_of(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p_company = trustwork.current_company_id() AND trustwork.approval_active_member(p_company, trustwork.current_person_id())
$$;

CREATE FUNCTION trustwork.approval_holds_permission(p_company uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p_company = trustwork.current_company_id() AND trustwork.approval_holds(p_company, trustwork.current_person_id(), p_permission, NULL, false)
$$;

CREATE FUNCTION trustwork.approval_require_routes_manager(p_company uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_company IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.approval_holds(p_company, trustwork.current_person_id(), 'procurement.routes.manage', NULL, false) THEN
    RAISE EXCEPTION 'routes are managed by members holding procurement.routes.manage' USING ERRCODE = '42501', HINT = 'approvals.not_authorised';
  END IF;
END $$;

CREATE FUNCTION trustwork.approval_draft_route(p_company uuid, p_subject_kind text, p_payload jsonb, p_digest text, p_template_key text, p_template_version integer, p_second_person boolean)
RETURNS trustwork.approval_route_version
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.approval_route_version%ROWTYPE;
  v_version integer;
BEGIN
  PERFORM trustwork.approval_require_routes_manager(p_company);
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.approval_route:' || p_company::text || ':' || p_subject_kind));
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM trustwork.approval_route_version WHERE owner_company_id = p_company AND subject_kind = p_subject_kind;
  INSERT INTO trustwork.approval_route_version (owner_company_id, subject_kind, version, payload, digest, template_key, template_version, drafted_by, second_person_required)
  VALUES (p_company, p_subject_kind, v_version, p_payload, p_digest, p_template_key, p_template_version, trustwork.current_person_id(), coalesce(p_second_person, false))
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.approval_activate_route(p_route uuid, p_digest text, p_expected_revision integer, p_session uuid) RETURNS trustwork.approval_route_version
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.approval_route_version%ROWTYPE;
BEGIN
  PERFORM trustwork.approval_first_party_session(p_session);
  SELECT * INTO v_row FROM trustwork.approval_route_version WHERE id = p_route;
  IF v_row.id IS NULL OR v_row.owner_company_id IS DISTINCT FROM trustwork.current_company_id() THEN
    RAISE EXCEPTION 'route version not found' USING ERRCODE = '42704', HINT = 'approvals.not_found';
  END IF;
  PERFORM trustwork.approval_require_routes_manager(v_row.owner_company_id);
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.approval_route:' || v_row.owner_company_id::text || ':' || v_row.subject_kind));
  SELECT * INTO v_row FROM trustwork.approval_route_version WHERE id = p_route FOR UPDATE;
  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft is activated' USING ERRCODE = '23514', HINT = 'approvals.invalid_transition';
  END IF;
  IF v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'route version changed' USING ERRCODE = '40001', HINT = 'approvals.revision_conflict';
  END IF;
  IF v_row.digest <> p_digest THEN
    RAISE EXCEPTION 'the reviewed digest differs from the draft' USING ERRCODE = '23514', HINT = 'approvals.digest_mismatch';
  END IF;
  IF v_row.second_person_required AND v_row.drafted_by = trustwork.current_person_id() THEN
    RAISE EXCEPTION 'a second person activates this route' USING ERRCODE = '42501', HINT = 'approvals.second_person_required';
  END IF;
  UPDATE trustwork.approval_route_version SET status = 'superseded', superseded_at = now()
  WHERE owner_company_id = v_row.owner_company_id AND subject_kind = v_row.subject_kind AND status = 'active';
  UPDATE trustwork.approval_route_version SET status = 'active', activated_by = trustwork.current_person_id(), activated_at = now() WHERE id = p_route RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Submission by the subject's module, in its own transaction, as the requester. The module evaluates the route
-- conditions against the subject facts and names the applicable steps; their definitions come from the stored route.
CREATE FUNCTION trustwork.approval_submit(p_company uuid, p_subject_kind text, p_subject_id uuid, p_subject_version_id uuid, p_subject_digest text,
  p_amount_minor numeric, p_currency text, p_project uuid, p_facts jsonb, p_route_version uuid, p_step_keys text[], p_now timestamptz) RETURNS trustwork.approval_request
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  v_route trustwork.approval_route_version%ROWTYPE;
  v_request trustwork.approval_request%ROWTYPE;
  v_step jsonb;
  v_min integer;
  v_first text;
  v_key text;
  v_found boolean;
BEGIN
  IF v_actor IS NULL OR p_company IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.approval_active_member(p_company, v_actor) THEN
    RAISE EXCEPTION 'a member of the company submits its subjects' USING ERRCODE = '42501', HINT = 'approvals.not_authorised';
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.project WHERE id = p_project AND owner_company_id = p_company) THEN
    RAISE EXCEPTION 'the project belongs to the company' USING ERRCODE = '23514', HINT = 'approvals.project_mismatch';
  END IF;
  SELECT * INTO v_route FROM trustwork.approval_route_version WHERE owner_company_id = p_company AND subject_kind = p_subject_kind AND status = 'active';
  IF v_route.id IS NULL THEN
    RAISE EXCEPTION 'no active approval route for %', p_subject_kind USING ERRCODE = '23514', HINT = 'approvals.no_active_route';
  END IF;
  IF v_route.id IS DISTINCT FROM p_route_version THEN
    RAISE EXCEPTION 'the active route changed while the steps were resolved' USING ERRCODE = '40001', HINT = 'approvals.revision_conflict';
  END IF;
  IF p_step_keys IS NULL OR cardinality(p_step_keys) = 0 THEN
    RAISE EXCEPTION 'no step of the route applies; nothing is approved by silence' USING ERRCODE = '23514', HINT = 'approvals.no_applicable_step';
  END IF;
  -- One pending request per subject: the same version is refused, an earlier version is superseded.
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.approval_subject:' || p_subject_kind || ':' || p_subject_id::text));
  IF EXISTS (SELECT 1 FROM trustwork.approval_request WHERE subject_kind = p_subject_kind AND subject_id = p_subject_id AND status = 'pending' AND subject_version_id = p_subject_version_id) THEN
    RAISE EXCEPTION 'this subject version already waits for approval' USING ERRCODE = '23505', HINT = 'approvals.already_pending';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.approval_request WHERE subject_kind = p_subject_kind AND subject_id = p_subject_id AND owner_company_id <> p_company) THEN
    RAISE EXCEPTION 'the subject belongs to another company' USING ERRCODE = '42501', HINT = 'approvals.not_authorised';
  END IF;
  PERFORM trustwork.approval_close(x.id, 'superseded', p_now) FROM trustwork.approval_request x
  WHERE x.subject_kind = p_subject_kind AND x.subject_id = p_subject_id AND x.status = 'pending';

  SELECT min((e ->> 'order')::integer) INTO v_min FROM jsonb_array_elements(v_route.payload -> 'steps') e WHERE e ->> 'key' = ANY (p_step_keys);
  SELECT e ->> 'key' INTO v_first FROM jsonb_array_elements(v_route.payload -> 'steps') e WHERE e ->> 'key' = ANY (p_step_keys) AND (e ->> 'order')::integer = v_min ORDER BY e ->> 'key' LIMIT 1;
  INSERT INTO trustwork.approval_request (owner_company_id, subject_kind, subject_id, subject_version_id, subject_digest, route_version_id, project_id, current_step,
    requested_by_person_id, amount_minor, currency, facts, submitted_at)
  VALUES (p_company, p_subject_kind, p_subject_id, p_subject_version_id, p_subject_digest, v_route.id, p_project, coalesce(v_first, 'none'),
    v_actor, p_amount_minor, p_currency, coalesce(p_facts, '{}'::jsonb), p_now)
  RETURNING * INTO v_request;

  FOREACH v_key IN ARRAY p_step_keys LOOP
    v_found := false;
    FOR v_step IN SELECT e FROM jsonb_array_elements(v_route.payload -> 'steps') e WHERE e ->> 'key' = v_key LOOP
      v_found := true;
      INSERT INTO trustwork.approval_request_step (request_id, step_key, step_order, quorum, selector, escalation, timeout_hours, due_at, status)
      VALUES (v_request.id, v_key, (v_step ->> 'order')::integer, (v_step ->> 'quorum')::integer, v_step -> 'selector', v_step -> 'escalation', (v_step ->> 'timeoutHours')::integer,
        CASE WHEN (v_step ->> 'order')::integer = v_min THEN p_now + make_interval(hours => (v_step ->> 'timeoutHours')::integer) END,
        CASE WHEN (v_step ->> 'order')::integer = v_min THEN 'pending' ELSE 'waiting' END)
      ON CONFLICT (request_id, step_key) DO NOTHING;
      -- Never a step nobody can decide: the quorum must be reachable by people other than the requester.
      IF trustwork.approval_eligible_count(p_company, v_step -> 'selector', p_project, v_route.id, v_actor) < (v_step ->> 'quorum')::integer THEN
        RAISE EXCEPTION 'step % has fewer eligible approvers than its quorum (the requester never approves)', v_key USING ERRCODE = '23514', HINT = 'approvals.no_eligible_approver';
      END IF;
    END LOOP;
    IF NOT v_found THEN
      RAISE EXCEPTION 'step % is not in the active route', v_key USING ERRCODE = '23514', HINT = 'approvals.unknown_step';
    END IF;
  END LOOP;
  PERFORM trustwork.approval_event(v_request, 'approval.request_submitted');
  RETURN v_request;
END $$;

-- A new subject version without a new submission: pending requests for older versions are superseded.
CREATE FUNCTION trustwork.approval_supersede(p_subject_kind text, p_subject_id uuid, p_new_version_id uuid, p_now timestamptz) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_count integer := 0;
  x trustwork.approval_request%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.approval_subject:' || p_subject_kind || ':' || p_subject_id::text));
  FOR x IN SELECT * FROM trustwork.approval_request WHERE subject_kind = p_subject_kind AND subject_id = p_subject_id AND status = 'pending' AND subject_version_id <> p_new_version_id FOR UPDATE LOOP
    IF x.owner_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.approval_active_member(x.owner_company_id, trustwork.current_person_id()) THEN
      RAISE EXCEPTION 'a member of the company changes its subjects' USING ERRCODE = '42501', HINT = 'approvals.not_authorised';
    END IF;
    PERFORM trustwork.approval_close(x.id, 'superseded', p_now);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE FUNCTION trustwork.approval_lock_request(p_request uuid, p_now timestamptz) RETURNS trustwork.approval_request
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  r trustwork.approval_request%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trustwork.approval_request WHERE id = p_request FOR UPDATE;
  -- Existence never leaks: who cannot read the request gets "not found", including other members of the company.
  IF r.id IS NULL OR r.owner_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.approval_request_visible_at(p_request, p_now) THEN
    RAISE EXCEPTION 'approval request not found' USING ERRCODE = '42704', HINT = 'approvals.not_found';
  END IF;
  RETURN r;
END $$;

CREATE FUNCTION trustwork.approval_withdraw(p_request uuid, p_expected_revision integer, p_now timestamptz) RETURNS trustwork.approval_request
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.approval_request%ROWTYPE := trustwork.approval_lock_request(p_request, p_now);
BEGIN
  IF r.requested_by_person_id <> trustwork.current_person_id() THEN
    RAISE EXCEPTION 'only the requester withdraws' USING ERRCODE = '42501', HINT = 'approvals.not_authorised';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'the request is %', r.status USING ERRCODE = '23514', HINT = 'approvals.not_pending';
  END IF;
  IF r.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'request changed' USING ERRCODE = '40001', HINT = 'approvals.revision_conflict';
  END IF;
  RETURN trustwork.approval_close(p_request, 'withdrawn', p_now);
END $$;

-- One person's decision on one step, on the first-party surface. Serialised by the request row lock: concurrent
-- decisions on the same step resolve once (the loser sees a new revision or a closed step).
CREATE FUNCTION trustwork.approval_decide(p_request uuid, p_step text, p_decision text, p_digest text, p_reason text, p_expected_revision integer,
  p_session uuid, p_step_up boolean, p_now timestamptz) RETURNS trustwork.approval_decision
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  r trustwork.approval_request%ROWTYPE;
  s trustwork.approval_request_step%ROWTYPE;
  v_auth record;
  v_decision trustwork.approval_decision%ROWTYPE;
  v_completes boolean := false;
  v_rule text;
  v_flag text;
  v_next integer;
BEGIN
  PERFORM trustwork.approval_first_party_session(p_session);
  IF p_decision NOT IN ('approve', 'reject', 'return') THEN
    RAISE EXCEPTION 'decision is approve, reject or return' USING ERRCODE = '22023', HINT = 'approvals.invalid_decision';
  END IF;
  IF p_decision <> 'approve' AND (p_reason IS NULL OR length(btrim(p_reason)) = 0) THEN
    RAISE EXCEPTION 'rejecting or returning needs a reason' USING ERRCODE = '22023', HINT = 'approvals.reason_required';
  END IF;
  r := trustwork.approval_lock_request(p_request, p_now);
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'the request is %', r.status USING ERRCODE = '23514', HINT = 'approvals.not_pending';
  END IF;
  IF r.subject_digest <> p_digest THEN
    RAISE EXCEPTION 'the digest on the decision card differs from the request' USING ERRCODE = '23514', HINT = 'approvals.digest_mismatch';
  END IF;
  IF r.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'request changed' USING ERRCODE = '40001', HINT = 'approvals.revision_conflict';
  END IF;
  -- Timeouts first: an escalated step is decided by its escalation target; an expired request is decided by nobody.
  PERFORM trustwork.approval_escalate_request(p_request, p_now);
  SELECT * INTO r FROM trustwork.approval_request WHERE id = p_request;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'the request is %', r.status USING ERRCODE = '23514', HINT = 'approvals.not_pending';
  END IF;
  SELECT * INTO s FROM trustwork.approval_request_step WHERE request_id = p_request AND step_key = p_step FOR UPDATE;
  IF s.request_id IS NULL OR s.status <> 'pending' THEN
    RAISE EXCEPTION 'step % is not waiting for a decision', p_step USING ERRCODE = '23514', HINT = 'approvals.step_not_pending';
  END IF;
  SELECT * INTO v_auth FROM trustwork.approval_authority(p_request, s.selector, v_actor, p_now);
  IF v_auth.refusal IS NOT NULL THEN
    RAISE EXCEPTION 'not allowed to decide this step: %', v_auth.refusal USING ERRCODE = '42501',
      HINT = CASE v_auth.refusal WHEN 'requester' THEN 'approvals.requester_cannot_decide' WHEN 'delegation_exceeds_rights' THEN 'approvals.delegation_exceeds_rights' WHEN 'not_member' THEN 'approvals.not_authorised' ELSE 'approvals.not_an_approver' END;
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.approval_decision d WHERE d.approval_request_id = p_request AND d.step_key = p_step AND d.voter_person_id = v_auth.voter) THEN
    RAISE EXCEPTION 'this vote was already cast' USING ERRCODE = '23505', HINT = 'approvals.already_decided';
  END IF;
  IF p_decision = 'approve' THEN
    IF r.amount_minor IS NOT NULL AND NOT coalesce(p_step_up, false) THEN
      RAISE EXCEPTION 'approving money needs a recent authentication' USING ERRCODE = '42501', HINT = 'approvals.step_up_required';
    END IF;
    v_completes := s.approvals + 1 >= s.quorum AND NOT EXISTS (
      SELECT 1 FROM trustwork.approval_request_step o WHERE o.request_id = p_request AND o.step_key <> p_step AND o.status IN ('waiting', 'pending'));
    v_rule := trustwork.approval_sod_check(r, ARRAY[v_actor, v_auth.voter]::uuid[], v_completes);
    IF v_rule IS NOT NULL THEN
      IF v_rule <> 'payee_changer_never_approves_payment_to_payee'
         AND trustwork.approval_eligible_count(r.owner_company_id, s.selector, r.project_id, r.route_version_id, r.requested_by_person_id) = 1 THEN
        v_flag := v_rule;
      ELSE
        RAISE EXCEPTION 'segregation of duties: %', v_rule USING ERRCODE = '42501', HINT = 'approvals.sod_violation', DETAIL = v_rule;
      END IF;
    END IF;
  END IF;
  INSERT INTO trustwork.approval_decision (approval_request_id, step_key, approver_person_id, on_behalf_company_id, delegated_from_person_id, delegation_id, decision,
    subject_digest, reason, session_id, step_up, escalation_level, sod_flag, decided_at)
  VALUES (p_request, p_step, v_actor, r.owner_company_id, CASE WHEN v_auth.delegation_id IS NOT NULL THEN v_auth.voter END, v_auth.delegation_id, p_decision,
    p_digest, NULLIF(btrim(coalesce(p_reason, '')), ''), p_session, coalesce(p_step_up, false), s.escalation_level, v_flag, p_now)
  RETURNING * INTO v_decision;

  IF p_decision = 'approve' THEN
    UPDATE trustwork.approval_request_step SET approvals = approvals + 1,
      status = CASE WHEN approvals + 1 >= quorum THEN 'approved' ELSE status END,
      due_at = CASE WHEN approvals + 1 >= quorum THEN NULL ELSE due_at END,
      completed_at = CASE WHEN approvals + 1 >= quorum THEN p_now END
    WHERE request_id = p_request AND step_key = p_step;
    IF NOT EXISTS (SELECT 1 FROM trustwork.approval_request_step WHERE request_id = p_request AND status = 'pending') THEN
      SELECT min(step_order) INTO v_next FROM trustwork.approval_request_step WHERE request_id = p_request AND status = 'waiting';
      IF v_next IS NULL THEN
        PERFORM trustwork.approval_close(p_request, 'approved', p_now);
      ELSE
        UPDATE trustwork.approval_request_step SET status = 'pending', due_at = p_now + make_interval(hours => timeout_hours)
        WHERE request_id = p_request AND status = 'waiting' AND step_order = v_next;
        UPDATE trustwork.approval_request SET current_step = (SELECT step_key FROM trustwork.approval_request_step WHERE request_id = p_request AND status = 'pending' ORDER BY step_key LIMIT 1)
        WHERE id = p_request;
      END IF;
    ELSE
      UPDATE trustwork.approval_request SET current_step = (SELECT step_key FROM trustwork.approval_request_step WHERE request_id = p_request AND status = 'pending' ORDER BY step_order, step_key LIMIT 1)
      WHERE id = p_request;
    END IF;
  ELSE
    UPDATE trustwork.approval_request_step SET status = CASE WHEN p_decision = 'reject' THEN 'rejected' ELSE 'returned' END, due_at = NULL, completed_at = p_now
    WHERE request_id = p_request AND step_key = p_step;
    PERFORM trustwork.approval_close(p_request, CASE WHEN p_decision = 'reject' THEN 'rejected' ELSE 'returned' END, p_now);
  END IF;
  RETURN v_decision;
END $$;

CREATE FUNCTION trustwork.approval_delegate(p_delegate uuid, p_subject_kinds text[], p_limit_minor numeric, p_limit_currency text, p_valid_from timestamptz, p_valid_until timestamptz, p_now timestamptz)
RETURNS trustwork.approval_delegation
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  v_company uuid := trustwork.current_company_id();
  v_row trustwork.approval_delegation%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR v_company IS NULL OR NOT trustwork.approval_active_member(v_company, v_actor) THEN
    RAISE EXCEPTION 'a member of the company delegates' USING ERRCODE = '42501', HINT = 'approvals.not_authorised';
  END IF;
  IF p_delegate = v_actor OR NOT trustwork.approval_active_member(v_company, p_delegate) THEN
    RAISE EXCEPTION 'the delegate is another active member of the same company' USING ERRCODE = '23514', HINT = 'approvals.invalid_delegate';
  END IF;
  IF (SELECT count(DISTINCT k) FROM unnest(p_subject_kinds) k) <> cardinality(p_subject_kinds) THEN
    RAISE EXCEPTION 'subject kinds are distinct' USING ERRCODE = '22023', HINT = 'approvals.invalid_delegation';
  END IF;
  IF p_valid_until <= p_now OR p_valid_until <= p_valid_from OR p_valid_until - p_valid_from > interval '90 days' THEN
    RAISE EXCEPTION 'a delegation ends in the future, after it starts and within 90 days' USING ERRCODE = '22023', HINT = 'approvals.invalid_delegation';
  END IF;
  INSERT INTO trustwork.approval_delegation (company_id, delegator_person_id, delegate_person_id, subject_kinds, limit_minor, limit_currency, valid_from, valid_until)
  VALUES (v_company, v_actor, p_delegate, p_subject_kinds, p_limit_minor, p_limit_currency, p_valid_from, p_valid_until)
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.approval_revoke_delegation(p_delegation uuid, p_reason text, p_expected_revision integer) RETURNS trustwork.approval_delegation
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  v_row trustwork.approval_delegation%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.approval_delegation WHERE id = p_delegation FOR UPDATE;
  IF v_row.id IS NULL OR v_row.company_id IS DISTINCT FROM trustwork.current_company_id()
     OR NOT (v_row.delegator_person_id = v_actor OR v_row.delegate_person_id = v_actor OR trustwork.approval_is_admin(v_row.company_id, v_actor)) THEN
    RAISE EXCEPTION 'delegation not found' USING ERRCODE = '42704', HINT = 'approvals.not_found';
  END IF;
  IF v_row.status <> 'active' THEN
    RAISE EXCEPTION 'the delegation is %', v_row.status USING ERRCODE = '23514', HINT = 'approvals.invalid_transition';
  END IF;
  IF v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'delegation changed' USING ERRCODE = '40001', HINT = 'approvals.revision_conflict';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a revocation names its reason' USING ERRCODE = '22023', HINT = 'approvals.reason_required';
  END IF;
  UPDATE trustwork.approval_delegation SET status = 'revoked', revoked_at = now(), revoked_by = v_actor, revoked_reason = btrim(p_reason) WHERE id = p_delegation RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- 8. Reads (runtime role) ----------------------------------------------------------------------------------------------------
-- Who sees a request: the requester, company administrators and route managers, anyone who decided on it, and anyone
-- the request's steps select now (directly or through a live delegation). Other members, other companies and staff
-- without a case grant see nothing.
CREATE FUNCTION trustwork.approval_request_visible_at(p_request uuid, p_now timestamptz) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_me uuid := trustwork.current_person_id();
  r trustwork.approval_request%ROWTYPE;
  s trustwork.approval_request_step%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trustwork.approval_request WHERE id = p_request;
  IF v_me IS NULL OR r.id IS NULL OR r.owner_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.approval_active_member(r.owner_company_id, v_me) THEN
    RETURN false;
  END IF;
  IF r.requested_by_person_id = v_me OR trustwork.approval_is_admin(r.owner_company_id, v_me) OR trustwork.approval_holds(r.owner_company_id, v_me, 'procurement.routes.manage', NULL, false)
     OR EXISTS (SELECT 1 FROM trustwork.approval_decision d WHERE d.approval_request_id = p_request AND d.approver_person_id = v_me) THEN
    RETURN true;
  END IF;
  FOR s IN SELECT * FROM trustwork.approval_request_step WHERE request_id = p_request LOOP
    IF (trustwork.approval_authority(p_request, trustwork.approval_effective_selector(s, p_now), v_me, p_now)).voter IS NOT NULL THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END $$;

CREATE FUNCTION trustwork.approval_request_visible(p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.approval_request_visible_at(p_request, now())
$$;

-- The viewer's options on one request: per pending step, whether they may decide, as whose voter, or why not.
CREATE FUNCTION trustwork.approval_viewer_options(p_request uuid, p_now timestamptz)
RETURNS TABLE (step_key text, may_decide boolean, delegated_from_person_id uuid, delegation_id uuid, refusal text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  s trustwork.approval_request_step%ROWTYPE;
  a record;
BEGIN
  IF NOT trustwork.approval_request_visible_at(p_request, p_now) THEN
    RETURN;
  END IF;
  FOR s IN SELECT * FROM trustwork.approval_request_step x WHERE x.request_id = p_request AND x.status = 'pending' ORDER BY x.step_order, x.step_key LOOP
    SELECT * INTO a FROM trustwork.approval_authority(p_request, trustwork.approval_effective_selector(s, p_now), trustwork.current_person_id(), p_now);
    step_key := s.step_key;
    IF a.refusal IS NULL AND EXISTS (SELECT 1 FROM trustwork.approval_decision d WHERE d.approval_request_id = p_request AND d.step_key = s.step_key AND d.voter_person_id = a.voter) THEN
      a.refusal := 'already_decided';
    END IF;
    may_decide := a.refusal IS NULL;
    delegated_from_person_id := CASE WHEN a.delegation_id IS NOT NULL THEN a.voter END;
    delegation_id := a.delegation_id;
    refusal := a.refusal;
    RETURN NEXT;
  END LOOP;
END $$;

-- Decisions waiting for the current person ("Your decision is needed"): pending steps they may decide now.
CREATE FUNCTION trustwork.approval_decisions_waiting(p_now timestamptz, p_limit integer)
RETURNS TABLE (request_id uuid, step_key text, delegated_from_person_id uuid, due_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.current_person_id();
  v_company uuid := trustwork.current_company_id();
  s trustwork.approval_request_step%ROWTYPE;
  a record;
  v_n integer := 0;
BEGIN
  IF v_me IS NULL OR v_company IS NULL THEN
    RETURN;
  END IF;
  FOR s IN SELECT x.* FROM trustwork.approval_request_step x JOIN trustwork.approval_request r ON r.id = x.request_id
           WHERE r.owner_company_id = v_company AND r.status = 'pending' AND x.status = 'pending' AND r.requested_by_person_id <> v_me
           ORDER BY x.due_at, x.request_id, x.step_key LOOP
    SELECT * INTO a FROM trustwork.approval_authority(s.request_id, trustwork.approval_effective_selector(s, p_now), v_me, p_now);
    CONTINUE WHEN a.refusal IS NOT NULL;
    CONTINUE WHEN EXISTS (SELECT 1 FROM trustwork.approval_decision d WHERE d.approval_request_id = s.request_id AND d.step_key = s.step_key AND d.voter_person_id = a.voter);
    request_id := s.request_id;
    step_key := s.step_key;
    delegated_from_person_id := CASE WHEN a.delegation_id IS NOT NULL THEN a.voter END;
    due_at := s.due_at;
    RETURN NEXT;
    v_n := v_n + 1;
    EXIT WHEN v_n >= least(greatest(coalesce(p_limit, 50), 1), 200);
  END LOOP;
END $$;

-- 9. Worker sweep -------------------------------------------------------------------------------------------------------------
-- Escalates due steps and expires requests after the second timeout; marks delegations past their end as ended.
CREATE FUNCTION trustwork.approval_escalate_due(p_now timestamptz, p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_id uuid;
  v_changed integer := 0;
BEGIN
  FOR v_id IN SELECT DISTINCT x.request_id FROM trustwork.approval_request_step x JOIN trustwork.approval_request r ON r.id = x.request_id
              WHERE r.status = 'pending' AND x.status = 'pending' AND x.due_at <= p_now LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000) LOOP
    PERFORM 1 FROM trustwork.approval_request WHERE id = v_id AND status = 'pending' FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    v_changed := v_changed + trustwork.approval_escalate_request(v_id, p_now);
  END LOOP;
  UPDATE trustwork.approval_delegation d SET status = 'ended'
  WHERE d.status = 'active' AND (d.valid_until <= p_now OR NOT trustwork.approval_active_member(d.company_id, d.delegator_person_id) OR NOT trustwork.approval_active_member(d.company_id, d.delegate_person_id));
  RETURN v_changed;
END $$;

-- 10. Row-level security and grants ---------------------------------------------------------------------------------------------
ALTER TABLE trustwork.approval_route_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval_route_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval_request FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval_request_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval_request_step FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval_delegation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.approval_delegation FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.approval_route_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.approval_request AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.approval_request_step AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.approval_decision AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.approval_delegation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Routes are company rules every active member may read (explainability); requests, steps and decisions follow
-- approval_request_visible; delegations are visible to the delegator, the delegate and the company administrators.
CREATE POLICY approval_route_version_members ON trustwork.approval_route_version FOR SELECT TO trustwork_app USING (trustwork.approval_member_of(owner_company_id));
CREATE POLICY approval_request_visible ON trustwork.approval_request FOR SELECT TO trustwork_app USING (trustwork.approval_request_visible(id));
CREATE POLICY approval_request_step_visible ON trustwork.approval_request_step FOR SELECT TO trustwork_app USING (trustwork.approval_request_visible(request_id));
CREATE POLICY approval_decision_visible ON trustwork.approval_decision FOR SELECT TO trustwork_app USING (trustwork.approval_request_visible(approval_request_id));
CREATE POLICY approval_delegation_parties ON trustwork.approval_delegation FOR SELECT TO trustwork_app
  USING (trustwork.approval_member_of(company_id) AND (delegator_person_id = trustwork.current_person_id() OR delegate_person_id = trustwork.current_person_id()
    OR trustwork.approval_holds_permission(company_id, 'procurement.routes.manage')));

GRANT SELECT ON trustwork.approval_route_version, trustwork.approval_request, trustwork.approval_request_step, trustwork.approval_decision, trustwork.approval_delegation TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.approval_member_of(uuid), trustwork.approval_holds_permission(uuid, text), trustwork.approval_request_visible(uuid),
  trustwork.approval_draft_route(uuid, text, jsonb, text, text, integer, boolean), trustwork.approval_activate_route(uuid, text, integer, uuid),
  trustwork.approval_submit(uuid, text, uuid, uuid, text, numeric, text, uuid, jsonb, uuid, text[], timestamptz), trustwork.approval_supersede(text, uuid, uuid, timestamptz),
  trustwork.approval_withdraw(uuid, integer, timestamptz), trustwork.approval_decide(uuid, text, text, text, text, integer, uuid, boolean, timestamptz),
  trustwork.approval_delegate(uuid, text[], numeric, text, timestamptz, timestamptz, timestamptz), trustwork.approval_revoke_delegation(uuid, text, integer),
  trustwork.approval_viewer_options(uuid, timestamptz), trustwork.approval_decisions_waiting(timestamptz, integer) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.approval_escalate_due(timestamptz, integer) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
