-- REP-001: the reputation builder. Every participant builds and confirms their own reputation from evidence (ADR 010
-- decision 18): checked credentials, a portfolio backed by execution records, confirmations from real counterparties
-- of real interactions, knowledge contributions counted by outcome, and timeliness signals from shared contexts. The
-- tools never change a score directly: snapshots stay EXE-001's explainable summaries under the published method, and
-- there is no public numeric score (O07).
--
--   professional_credential  licences, insurance, bonds, certificates, training, memberships and registrations of a
--                            person or a company; corrections append (supersedes_id); documents are never public
--   credential_check         the hub's register lookup through an adapter (a fake in this slice): "checked on date by
--                            hub X" exists only with a passing check; the status is derived, never stored
--   portfolio_entry          completed work of the holder: a platform context (agreement, completed task, closed
--                            project) or an external description; "client confirmed" only through a confirmation
--   relation_declaration     a person declares a close personal relationship (relative, household); it blocks
--                            confirmations between the two, in both directions
--   confirmation_request     one request per counterparty, context and statement, plus at most one reminder; only
--                            between the two sides of an accepted agreement, a completed task or a closed project;
--                            never between employees and the subject, relatives, or oneself; no incentive field exists
--   confirmation_response    the counterparty's person decides confirmed, partially or declined (human only: no agent
--                            column); final, appealable by the requester through DATA-002's appeal queue
--   contribution_record      derived by reputation_derive() from canonical records only (confirmed advice, completed
--                            consultation agreements); never self-asserted (the runtime role cannot insert)
--   timeliness_observation   derived by reputation_derive() from EXE-001 performance observations only (fair timing:
--                            client-caused and external changes are excluded); never activity tracking or per-employee
--                            metrics: the subject is always the party of the context, never an employee
--   automated_limitation     an automated refusal recorded with its reason code and evidence when the person appeals
--                            it; the appeal goes to DATA-002's queue and is decided by a person
--
-- Payment neutrality: nothing here reads a billing table (tests/billing/policy.test.ts). Staff have no read or write
-- path into these tables; they decide appeals through admin_decide_appeal only. Every table is under FORCE RLS and
-- append-only, except the reminder and withdrawal columns of a request (each set once).

-- 0. Helpers ----------------------------------------------------------------------------------------------------------
-- A maintenance session (seeding, repair): a login that is a member of trustwork_owner with the maintenance flag; the
-- flag alone proves nothing because the runtime role may set it. Invoker copy of trustwork.maintenance_session().
CREATE FUNCTION trustwork.reputation_maintenance() RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT current_setting('trustwork.maintenance', true) = 'on' AND pg_has_role(session_user, 'trustwork_owner', 'MEMBER')
$$;

CREATE FUNCTION trustwork.reputation_lock(p_kind text, p_key text) RETURNS void
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('trustwork.reputation.' || p_kind || ':' || p_key, 0))
$$;

-- 1. Credentials and checks -------------------------------------------------------------------------------------------
CREATE TABLE trustwork.professional_credential (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  holder_person_id uuid NULL REFERENCES trustwork.person (id),
  holder_company_id uuid NULL REFERENCES trustwork.company (id),
  kind text NOT NULL CHECK (kind IN ('licence', 'insurance', 'bond', 'certificate', 'training', 'membership', 'registration')),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  credential_type text NOT NULL CHECK (credential_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 200),
  number text NULL CHECK (length(number) BETWEEN 1 AND 100),
  classification text NULL CHECK (length(classification) BETWEEN 1 AND 200),
  coverage_minor bigint NULL CHECK (coverage_minor >= 0),
  coverage_currency text NULL CHECK (coverage_currency ~ '^[A-Z]{3}$'),
  valid_from date NULL,
  valid_until date NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  supersedes_id uuid NULL UNIQUE REFERENCES trustwork.professional_credential (id),
  recorded_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT professional_credential_holder_xor CHECK ((holder_person_id IS NULL) <> (holder_company_id IS NULL)),
  CONSTRAINT professional_credential_coverage CHECK ((coverage_minor IS NULL) = (coverage_currency IS NULL) AND (coverage_minor IS NULL OR kind IN ('insurance', 'bond'))),
  CONSTRAINT professional_credential_period CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until)
);
CREATE INDEX professional_credential_person_idx ON trustwork.professional_credential (holder_person_id) WHERE holder_person_id IS NOT NULL;
CREATE INDEX professional_credential_company_idx ON trustwork.professional_credential (holder_company_id) WHERE holder_company_id IS NOT NULL;
CREATE TRIGGER professional_credential_append_only BEFORE UPDATE OR DELETE ON trustwork.professional_credential FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.credential_check (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  credential_id uuid NOT NULL REFERENCES trustwork.professional_credential (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  register_code text NOT NULL CHECK (register_code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  outcome text NOT NULL CHECK (outcome IN ('match', 'mismatch', 'not_found', 'suspended', 'revoked', 'unavailable')),
  register_valid_until date NULL,
  source_ref text NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  requested_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX credential_check_credential_idx ON trustwork.credential_check (credential_id, checked_at);
CREATE TRIGGER credential_check_append_only BEFORE UPDATE OR DELETE ON trustwork.credential_check FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Portfolio --------------------------------------------------------------------------------------------------------
-- No address column exists: a portfolio entry never carries the site. A platform context links the entry to its
-- execution records; an external description stays self-reported forever.
CREATE TABLE trustwork.portfolio_entry (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  holder_person_id uuid NULL REFERENCES trustwork.person (id),
  holder_company_id uuid NULL REFERENCES trustwork.company (id),
  context_kind text NULL CHECK (context_kind IN ('agreement', 'task_assignment', 'project')),
  context_id uuid NULL,
  external_description text NULL CHECK (length(external_description) BETWEEN 1 AND 500),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (length(role) BETWEEN 1 AND 200),
  period_from date NULL,
  period_to date NULL,
  scope_summary text NULL CHECK (length(scope_summary) BETWEEN 1 AND 2000),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  supersedes_id uuid NULL UNIQUE REFERENCES trustwork.portfolio_entry (id),
  recorded_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT portfolio_entry_holder_xor CHECK ((holder_person_id IS NULL) <> (holder_company_id IS NULL)),
  CONSTRAINT portfolio_entry_context CHECK ((context_kind IS NULL) = (context_id IS NULL) AND (context_id IS NULL) <> (external_description IS NULL)),
  CONSTRAINT portfolio_entry_period CHECK (period_from IS NULL OR period_to IS NULL OR period_from <= period_to)
);
CREATE INDEX portfolio_entry_person_idx ON trustwork.portfolio_entry (holder_person_id) WHERE holder_person_id IS NOT NULL;
CREATE INDEX portfolio_entry_company_idx ON trustwork.portfolio_entry (holder_company_id) WHERE holder_company_id IS NOT NULL;
CREATE TRIGGER portfolio_entry_append_only BEFORE UPDATE OR DELETE ON trustwork.portfolio_entry FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Declared close relationships -------------------------------------------------------------------------------------
CREATE TABLE trustwork.relation_declaration (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  declarer_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  other_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  kind text NOT NULL CHECK (kind IN ('relative', 'household', 'close_personal')),
  declared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT relation_declaration_distinct CHECK (declarer_person_id <> other_person_id),
  CONSTRAINT relation_declaration_once UNIQUE (declarer_person_id, other_person_id)
);
CREATE INDEX relation_declaration_other_idx ON trustwork.relation_declaration (other_person_id);
CREATE TRIGGER relation_declaration_append_only BEFORE UPDATE OR DELETE ON trustwork.relation_declaration FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Confirmation requests and responses ------------------------------------------------------------------------------
CREATE TABLE trustwork.confirmation_request (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  requester_person_id uuid NULL REFERENCES trustwork.person (id),
  requester_company_id uuid NULL REFERENCES trustwork.company (id),
  addressed_person_id uuid NULL REFERENCES trustwork.person (id),
  addressed_company_id uuid NULL REFERENCES trustwork.company (id),
  context_kind text NOT NULL CHECK (context_kind IN ('agreement', 'task_assignment', 'project')),
  context_id uuid NOT NULL,
  portfolio_entry_id uuid NULL REFERENCES trustwork.portfolio_entry (id),
  statement_kind text NOT NULL CHECK (statement_kind IN ('delivered', 'on_time', 'quality_met', 'role_performed', 'paid_on_time', 'advice_delivered')),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 1000),
  -- The requester attests that nothing was offered for the answer and that the addressee is neither an employee nor a
  -- relative; there is deliberately no column for an incentive, a reward or a discount.
  no_incentive boolean NOT NULL CHECK (no_incentive),
  no_conflict boolean NOT NULL CHECK (no_conflict),
  requested_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_at timestamptz NOT NULL,
  reminder_sent_at timestamptz NULL,
  withdrawn_at timestamptz NULL,
  CONSTRAINT confirmation_request_requester_xor CHECK ((requester_person_id IS NULL) <> (requester_company_id IS NULL)),
  CONSTRAINT confirmation_request_addressed_xor CHECK ((addressed_person_id IS NULL) <> (addressed_company_id IS NULL)),
  CONSTRAINT confirmation_request_not_self CHECK (requester_person_id IS DISTINCT FROM addressed_person_id OR requester_person_id IS NULL),
  CONSTRAINT confirmation_request_not_self_company CHECK (requester_company_id IS DISTINCT FROM addressed_company_id OR requester_company_id IS NULL),
  CONSTRAINT confirmation_request_due CHECK (due_at > requested_at),
  CONSTRAINT confirmation_request_reminder CHECK (reminder_sent_at IS NULL OR reminder_sent_at >= requested_at)
);
-- One request per requester, addressee, context and statement, whatever its fate (a declined or withdrawn request is
-- never sent again): two concurrent requests cannot both commit.
CREATE UNIQUE INDEX confirmation_request_once ON trustwork.confirmation_request (
  coalesce(requester_person_id, requester_company_id), coalesce(addressed_person_id, addressed_company_id), context_kind, context_id, statement_kind);
CREATE INDEX confirmation_request_requester_person_idx ON trustwork.confirmation_request (requester_person_id, requested_at) WHERE requester_person_id IS NOT NULL;
CREATE INDEX confirmation_request_requester_company_idx ON trustwork.confirmation_request (requester_company_id, requested_at) WHERE requester_company_id IS NOT NULL;
CREATE INDEX confirmation_request_addressed_person_idx ON trustwork.confirmation_request (addressed_person_id) WHERE addressed_person_id IS NOT NULL;
CREATE INDEX confirmation_request_addressed_company_idx ON trustwork.confirmation_request (addressed_company_id) WHERE addressed_company_id IS NOT NULL;

-- Final once written: a counterparty who changes their mind appeals, they never edit. No agent column exists.
CREATE TABLE trustwork.confirmation_response (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  confirmation_request_id uuid NOT NULL UNIQUE REFERENCES trustwork.confirmation_request (id),
  responder_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  on_behalf_person_id uuid NULL REFERENCES trustwork.person (id),
  on_behalf_company_id uuid NULL REFERENCES trustwork.company (id),
  decision text NOT NULL CHECK (decision IN ('confirmed', 'partially', 'declined')),
  comment text NULL CHECK (length(comment) BETWEEN 1 AND 1000),
  consent_to_show boolean NOT NULL DEFAULT false,
  no_conflict boolean NOT NULL CHECK (no_conflict),
  responded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT confirmation_response_on_behalf_xor CHECK ((on_behalf_person_id IS NULL) <> (on_behalf_company_id IS NULL)),
  CONSTRAINT confirmation_response_reason CHECK (decision = 'confirmed' OR comment IS NOT NULL),
  CONSTRAINT confirmation_response_consent CHECK (decision <> 'declined' OR NOT consent_to_show)
);
CREATE TRIGGER confirmation_response_append_only BEFORE UPDATE OR DELETE ON trustwork.confirmation_response FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 5. Derived records (written only by reputation_derive) -------------------------------------------------------------
CREATE TABLE trustwork.contribution_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  holder_person_id uuid NULL REFERENCES trustwork.person (id),
  holder_company_id uuid NULL REFERENCES trustwork.company (id),
  kind text NOT NULL CHECK (kind IN ('publication', 'accepted_answer', 'consultation_given', 'mentoring', 'course_taught', 'event_talk', 'document_review', 'knowledge_item')),
  source_kind text NOT NULL CHECK (source_kind IN ('confirmation_response', 'agreement')),
  source_id uuid NOT NULL,
  -- The decision a holder appeals if the record is wrong: the counterparty's response or the acceptance observation.
  appeal_subject_kind text NOT NULL CHECK (appeal_subject_kind IN ('confirmation_response', 'performance_observation')),
  appeal_subject_id uuid NOT NULL,
  outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT contribution_record_holder_xor CHECK ((holder_person_id IS NULL) <> (holder_company_id IS NULL)),
  CONSTRAINT contribution_record_once UNIQUE (kind, source_kind, source_id)
);
CREATE INDEX contribution_record_person_idx ON trustwork.contribution_record (holder_person_id) WHERE holder_person_id IS NOT NULL;
CREATE INDEX contribution_record_company_idx ON trustwork.contribution_record (holder_company_id) WHERE holder_company_id IS NOT NULL;
CREATE TRIGGER contribution_record_append_only BEFORE UPDATE OR DELETE ON trustwork.contribution_record FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.timeliness_observation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  kind text NOT NULL CHECK (kind IN ('response', 'delivery', 'payment', 'consultation_start', 'milestone')),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  source_observation_id uuid NOT NULL UNIQUE REFERENCES trustwork.performance_observation (id),
  expected_at timestamptz NULL,
  actual_at timestamptz NULL,
  delta_seconds bigint NULL,
  attribution text NOT NULL CHECK (attribution IN ('subject', 'counterparty', 'external', 'unknown')),
  plan_change_ids uuid[] NOT NULL DEFAULT '{}',
  excluded_reason text NULL CHECK (excluded_reason IN ('client_caused_change', 'external_change', 'unattributed_change', 'no_due_date')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT timeliness_observation_subject_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT timeliness_observation_delta CHECK ((delta_seconds IS NULL) = (expected_at IS NULL OR actual_at IS NULL))
);
CREATE INDEX timeliness_observation_person_idx ON trustwork.timeliness_observation (subject_person_id) WHERE subject_person_id IS NOT NULL;
CREATE INDEX timeliness_observation_company_idx ON trustwork.timeliness_observation (subject_company_id) WHERE subject_company_id IS NOT NULL;
CREATE TRIGGER timeliness_observation_append_only BEFORE UPDATE OR DELETE ON trustwork.timeliness_observation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 6. Automated limitations (written only by reputation_appeal_limitation) ---------------------------------------------
-- Reason codes mirror LIMITATION_REASON_CODES in packages/contracts/src/reputation-builder.ts (tests/reputation).
CREATE TABLE trustwork.automated_limitation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  module text NOT NULL CHECK (module IN ('reputation', 'introductions', 'assistant')),
  scope text NOT NULL CHECK (scope IN ('confirmation_request', 'confirmation_response', 'introductions', 'agent_module', 'observation')),
  reason_code text NOT NULL CHECK (reason_code IN ('no_recorded_relationship', 'self_confirmation', 'employee_of_subject', 'relative_of_subject', 'already_requested', 'rate_limited',
    'excluded_client_caused_change', 'excluded_external_change', 'excluded_unattributed_change', 'excluded_no_due_date', 'excluded_appeal_pending', 'excluded_appeal_overturned',
    'introductions_throttled', 'module_paused')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 20),
  recorded_by_person_id uuid NULL REFERENCES trustwork.person (id),
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ends_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT automated_limitation_subject_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT automated_limitation_period CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX automated_limitation_person_idx ON trustwork.automated_limitation (subject_person_id) WHERE subject_person_id IS NOT NULL;
CREATE INDEX automated_limitation_company_idx ON trustwork.automated_limitation (subject_company_id) WHERE subject_company_id IS NOT NULL;
CREATE TRIGGER automated_limitation_append_only BEFORE UPDATE OR DELETE ON trustwork.automated_limitation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- DATA-002's appeal queue gains the automated-limitation subject (decided by admin_decide_appeal like every trust
-- appeal: admin.trust.appeals.decide, never the original decider or the appellant, conflicts refused).
ALTER TABLE trustwork.appeal DROP CONSTRAINT appeal_subject_kind_check;
ALTER TABLE trustwork.appeal ADD CONSTRAINT appeal_subject_kind_check CHECK (subject_kind IN ('sanction', 'moderation_case', 'verification_check', 'review', 'screening_result',
  'confirmation_response', 'timeliness_observation', 'performance_observation', 'passport_credential', 'recommendation', 'automated_limitation'));

-- 7. Relationship and conflict rules (owner-run: they read canonical records across row security) -------------------
-- True when the two parties stood on opposite sides of the context:
--   agreement        accepted by both (or superseded by an accepted order change), one buyer and one seller
--   task_assignment  accepted (the completed booking), the owner and the assignee
--   project          completed; one is the project owner, the other took part through an accepted agreement on the
--                    project's plan, an accepted task of the project, or a live participation granted by the owner
CREATE FUNCTION trustwork.reputation_shared_context(p_kind text, p_id uuid, p_a_person uuid, p_a_company uuid, p_b_person uuid, p_b_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_project trustwork.project%ROWTYPE;
  v_owner_is_a boolean;
  v_other_person uuid;
  v_other_company uuid;
BEGIN
  IF p_id IS NULL OR num_nonnulls(p_a_person, p_a_company) <> 1 OR num_nonnulls(p_b_person, p_b_company) <> 1 THEN
    RETURN false;
  END IF;
  IF p_kind = 'agreement' THEN
    RETURN EXISTS (
      SELECT 1 FROM trustwork.agreement a WHERE a.id = p_id AND a.status IN ('accepted_by_both', 'superseded')
        AND ((trustwork.execution_same_party(p_a_person, p_a_company, a.buyer_person_id, a.buyer_company_id) AND trustwork.execution_same_party(p_b_person, p_b_company, a.seller_person_id, a.seller_company_id))
          OR (trustwork.execution_same_party(p_a_person, p_a_company, a.seller_person_id, a.seller_company_id) AND trustwork.execution_same_party(p_b_person, p_b_company, a.buyer_person_id, a.buyer_company_id))));
  ELSIF p_kind = 'task_assignment' THEN
    RETURN EXISTS (
      SELECT 1 FROM trustwork.task_assignment t WHERE t.id = p_id AND t.status = 'accepted'
        AND ((trustwork.execution_same_party(p_a_person, p_a_company, t.owner_person_id, NULL) AND trustwork.execution_same_party(p_b_person, p_b_company, t.assignee_person_id, t.assignee_company_id))
          OR (trustwork.execution_same_party(p_a_person, p_a_company, t.assignee_person_id, t.assignee_company_id) AND trustwork.execution_same_party(p_b_person, p_b_company, t.owner_person_id, NULL))));
  ELSIF p_kind = 'project' THEN
    SELECT * INTO v_project FROM trustwork.project WHERE id = p_id AND status = 'completed';
    IF v_project.id IS NULL THEN
      RETURN false;
    END IF;
    IF trustwork.execution_same_party(p_a_person, p_a_company, v_project.owner_person_id, v_project.owner_company_id) THEN
      v_owner_is_a := true; v_other_person := p_b_person; v_other_company := p_b_company;
    ELSIF trustwork.execution_same_party(p_b_person, p_b_company, v_project.owner_person_id, v_project.owner_company_id) THEN
      v_owner_is_a := false; v_other_person := p_a_person; v_other_company := p_a_company;
    ELSE
      RETURN false;
    END IF;
    RETURN EXISTS (
        SELECT 1 FROM trustwork.agreement a JOIN trustwork.rfq r ON r.id = a.rfq_id
        WHERE r.plan_project_id = p_id AND a.status IN ('accepted_by_both', 'superseded')
          AND ((trustwork.execution_same_party(v_other_person, v_other_company, a.seller_person_id, a.seller_company_id)
                AND trustwork.execution_same_party(v_project.owner_person_id, v_project.owner_company_id, a.buyer_person_id, a.buyer_company_id))
            OR (trustwork.execution_same_party(v_other_person, v_other_company, a.buyer_person_id, a.buyer_company_id)
                AND trustwork.execution_same_party(v_project.owner_person_id, v_project.owner_company_id, a.seller_person_id, a.seller_company_id))))
      OR EXISTS (
        SELECT 1 FROM trustwork.task_assignment t WHERE t.project_id = p_id AND t.status = 'accepted'
          AND trustwork.execution_same_party(v_other_person, v_other_company, t.assignee_person_id, t.assignee_company_id))
      OR EXISTS (
        SELECT 1 FROM trustwork.object_participation op
        WHERE op.resource_kind = 'project' AND op.resource_id = p_id AND op.side IN ('participant', 'buyer', 'seller') AND op.revoked_at IS NULL
          AND trustwork.execution_same_party(v_other_person, v_other_company, op.party_person_id, op.party_company_id));
  END IF;
  RETURN false;
END $$;

-- True when one person is or was employed by the other party's company (an active or ended membership).
CREATE FUNCTION trustwork.reputation_employed(p_person uuid, p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_person IS NOT NULL AND p_company IS NOT NULL
    AND EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.person_id = p_person AND m.company_id = p_company AND m.status IN ('active', 'ended'))
$$;

-- True when either person declared a close personal relationship with the other.
CREATE FUNCTION trustwork.reputation_related(p_a uuid, p_b uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.relation_declaration d
    WHERE (d.declarer_person_id = p_a AND d.other_person_id = p_b) OR (d.declarer_person_id = p_b AND d.other_person_id = p_a))
$$;

-- Why a confirmation request may not be sent, or NULL when it may. Answers only for a requester the caller acts for.
-- VOLATILE on purpose: called after the requester's lock, it sees requests committed in the meantime.
CREATE FUNCTION trustwork.reputation_request_refusal(p_requester_person uuid, p_requester_company uuid, p_addressed_person uuid, p_addressed_company uuid, p_context_kind text,
  p_context_id uuid, p_statement_kind text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
BEGIN
  IF v_actor IS NULL OR NOT trustwork.commerce_party_acts(p_requester_person, p_requester_company, 'company.deals.manage') THEN
    RETURN 'not_authorised';
  END IF;
  IF trustwork.execution_same_party(p_requester_person, p_requester_company, p_addressed_person, p_addressed_company) OR p_addressed_person = v_actor THEN
    RETURN 'self_confirmation';
  END IF;
  IF NOT trustwork.reputation_shared_context(p_context_kind, p_context_id, p_requester_person, p_requester_company, p_addressed_person, p_addressed_company) THEN
    RETURN 'no_recorded_relationship';
  END IF;
  IF trustwork.reputation_employed(p_addressed_person, p_requester_company) OR trustwork.reputation_employed(p_requester_person, p_addressed_company)
     OR trustwork.reputation_employed(v_actor, p_addressed_company) THEN
    RETURN 'employee_of_subject';
  END IF;
  IF trustwork.reputation_related(p_addressed_person, coalesce(p_requester_person, v_actor)) OR trustwork.reputation_related(p_addressed_person, v_actor) THEN
    RETURN 'relative_of_subject';
  END IF;
  IF EXISTS (
    SELECT 1 FROM trustwork.confirmation_request r
    WHERE coalesce(r.requester_person_id, r.requester_company_id) = coalesce(p_requester_person, p_requester_company)
      AND coalesce(r.addressed_person_id, r.addressed_company_id) = coalesce(p_addressed_person, p_addressed_company)
      AND r.context_kind = p_context_kind AND r.context_id = p_context_id AND r.statement_kind = p_statement_kind
  ) THEN
    RETURN 'already_requested';
  END IF;
  IF (SELECT count(*) FROM trustwork.confirmation_request r
      WHERE trustwork.execution_same_party(r.requester_person_id, r.requester_company_id, p_requester_person, p_requester_company)
        AND r.requested_at > clock_timestamp() - interval '1 day') >= 20 THEN
    RETURN 'rate_limited';
  END IF;
  RETURN NULL;
END $$;

-- Why the caller may not answer this request for the party it names, or NULL when it may.
CREATE FUNCTION trustwork.reputation_response_refusal(p_request_id uuid, p_on_behalf_person uuid, p_on_behalf_company uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  v_request trustwork.confirmation_request%ROWTYPE;
BEGIN
  SELECT * INTO v_request FROM trustwork.confirmation_request WHERE id = p_request_id;
  IF v_actor IS NULL OR v_request.id IS NULL
     OR NOT trustwork.execution_same_party(p_on_behalf_person, p_on_behalf_company, v_request.addressed_person_id, v_request.addressed_company_id)
     OR NOT trustwork.commerce_party_acts(p_on_behalf_person, p_on_behalf_company, 'company.deals.manage') THEN
    RETURN 'not_authorised';
  END IF;
  IF v_actor = v_request.requested_by_person_id OR v_actor = v_request.requester_person_id THEN
    RETURN 'self_confirmation';
  END IF;
  IF trustwork.reputation_employed(v_actor, v_request.requester_company_id) OR trustwork.reputation_employed(v_request.requester_person_id, v_request.addressed_company_id)
     OR trustwork.reputation_employed(v_request.requested_by_person_id, v_request.addressed_company_id) THEN
    RETURN 'employee_of_subject';
  END IF;
  IF trustwork.reputation_related(v_actor, v_request.requested_by_person_id) OR trustwork.reputation_related(v_actor, v_request.requester_person_id) THEN
    RETURN 'relative_of_subject';
  END IF;
  IF v_request.withdrawn_at IS NOT NULL OR clock_timestamp() > v_request.due_at THEN
    RETURN 'request_closed';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.confirmation_response x WHERE x.confirmation_request_id = p_request_id) THEN
    RETURN 'already_answered';
  END IF;
  RETURN NULL;
END $$;

-- 8. Guards -----------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.professional_credential_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_previous trustwork.professional_credential%ROWTYPE;
BEGIN
  IF trustwork.reputation_maintenance() THEN
    RETURN NEW;
  END IF;
  IF NEW.recorded_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NOT trustwork.commerce_party_acts(NEW.holder_person_id, NEW.holder_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'credentials are recorded for the holder the principal acts for' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_authorised';
  END IF;
  NEW.created_at := clock_timestamp();
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO v_previous FROM trustwork.professional_credential WHERE id = NEW.supersedes_id;
    IF v_previous.id IS NULL OR NOT trustwork.execution_same_party(v_previous.holder_person_id, v_previous.holder_company_id, NEW.holder_person_id, NEW.holder_company_id) THEN
      RAISE EXCEPTION 'a correction names a credential of the same holder' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_found';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER professional_credential_guard BEFORE INSERT ON trustwork.professional_credential FOR EACH ROW EXECUTE FUNCTION trustwork.professional_credential_guard();

CREATE FUNCTION trustwork.credential_check_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_credential trustwork.professional_credential%ROWTYPE;
BEGIN
  IF trustwork.reputation_maintenance() THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_credential FROM trustwork.professional_credential WHERE id = NEW.credential_id;
  IF v_credential.id IS NULL OR NEW.requested_by_person_id IS DISTINCT FROM trustwork.current_person_id()
     OR NOT trustwork.commerce_party_acts(v_credential.holder_person_id, v_credential.holder_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'checks are requested by the holder' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_found';
  END IF;
  NEW.checked_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER credential_check_guard BEFORE INSERT ON trustwork.credential_check FOR EACH ROW EXECUTE FUNCTION trustwork.credential_check_guard();

-- The holder took part in the context it names (a portfolio entry is about the holder's own work).
CREATE FUNCTION trustwork.reputation_took_part(p_kind text, p_id uuid, p_person uuid, p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.commerce_party_acts(p_person, p_company, 'company.deals.manage') AND CASE p_kind
    WHEN 'agreement' THEN EXISTS (SELECT 1 FROM trustwork.agreement a WHERE a.id = p_id AND a.status IN ('accepted_by_both', 'superseded')
      AND (trustwork.execution_same_party(p_person, p_company, a.buyer_person_id, a.buyer_company_id) OR trustwork.execution_same_party(p_person, p_company, a.seller_person_id, a.seller_company_id)))
    WHEN 'task_assignment' THEN EXISTS (SELECT 1 FROM trustwork.task_assignment t WHERE t.id = p_id AND t.status = 'accepted'
      AND (trustwork.execution_same_party(p_person, p_company, t.owner_person_id, NULL) OR trustwork.execution_same_party(p_person, p_company, t.assignee_person_id, t.assignee_company_id)))
    WHEN 'project' THEN EXISTS (SELECT 1 FROM trustwork.project p WHERE p.id = p_id AND p.status = 'completed'
      AND (trustwork.execution_same_party(p_person, p_company, p.owner_person_id, p.owner_company_id)
        OR EXISTS (SELECT 1 FROM trustwork.task_assignment t WHERE t.project_id = p.id AND t.status = 'accepted' AND trustwork.execution_same_party(p_person, p_company, t.assignee_person_id, t.assignee_company_id))
        OR EXISTS (SELECT 1 FROM trustwork.agreement a JOIN trustwork.rfq r ON r.id = a.rfq_id WHERE r.plan_project_id = p.id AND a.status IN ('accepted_by_both', 'superseded')
             AND (trustwork.execution_same_party(p_person, p_company, a.buyer_person_id, a.buyer_company_id) OR trustwork.execution_same_party(p_person, p_company, a.seller_person_id, a.seller_company_id)))
        OR EXISTS (SELECT 1 FROM trustwork.object_participation op WHERE op.resource_kind = 'project' AND op.resource_id = p.id AND op.side IN ('participant', 'buyer', 'seller')
             AND op.revoked_at IS NULL AND trustwork.execution_same_party(p_person, p_company, op.party_person_id, op.party_company_id))))
    ELSE false END
$$;

CREATE FUNCTION trustwork.portfolio_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_previous trustwork.portfolio_entry%ROWTYPE;
BEGIN
  IF trustwork.reputation_maintenance() THEN
    RETURN NEW;
  END IF;
  IF NEW.recorded_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NOT trustwork.commerce_party_acts(NEW.holder_person_id, NEW.holder_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'portfolio entries are recorded for the holder the principal acts for' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_authorised';
  END IF;
  IF NEW.context_id IS NOT NULL AND NOT trustwork.reputation_took_part(NEW.context_kind, NEW.context_id, NEW.holder_person_id, NEW.holder_company_id) THEN
    RAISE EXCEPTION 'the holder took no part in this context' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.no_recorded_relationship';
  END IF;
  NEW.created_at := clock_timestamp();
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO v_previous FROM trustwork.portfolio_entry WHERE id = NEW.supersedes_id;
    IF v_previous.id IS NULL OR NOT trustwork.execution_same_party(v_previous.holder_person_id, v_previous.holder_company_id, NEW.holder_person_id, NEW.holder_company_id) THEN
      RAISE EXCEPTION 'a correction names an entry of the same holder' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_found';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portfolio_entry_guard BEFORE INSERT ON trustwork.portfolio_entry FOR EACH ROW EXECUTE FUNCTION trustwork.portfolio_entry_guard();

CREATE FUNCTION trustwork.relation_declaration_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.reputation_maintenance() THEN
    RETURN NEW;
  END IF;
  IF NEW.declarer_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'a person declares their own relationships' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_authorised';
  END IF;
  NEW.declared_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER relation_declaration_guard BEFORE INSERT ON trustwork.relation_declaration FOR EACH ROW EXECUTE FUNCTION trustwork.relation_declaration_guard();

-- Requests: the requester acts; the clock and the deadline are the server's; the requester's lock serializes the
-- one-request rule and the daily limit; the refusal function decides relationship and conflicts.
CREATE FUNCTION trustwork.confirmation_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_reason text;
  v_entry trustwork.portfolio_entry%ROWTYPE;
BEGIN
  IF trustwork.reputation_maintenance() THEN
    RETURN NEW;
  END IF;
  IF NEW.requested_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the requester is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_authorised';
  END IF;
  PERFORM trustwork.reputation_lock('requester', coalesce(NEW.requester_person_id, NEW.requester_company_id)::text);
  v_reason := trustwork.reputation_request_refusal(NEW.requester_person_id, NEW.requester_company_id, NEW.addressed_person_id, NEW.addressed_company_id, NEW.context_kind,
    NEW.context_id, NEW.statement_kind);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation request refused: %', v_reason USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.' || v_reason;
  END IF;
  IF NEW.portfolio_entry_id IS NOT NULL THEN
    SELECT * INTO v_entry FROM trustwork.portfolio_entry WHERE id = NEW.portfolio_entry_id;
    IF v_entry.id IS NULL OR NOT trustwork.execution_same_party(v_entry.holder_person_id, v_entry.holder_company_id, NEW.requester_person_id, NEW.requester_company_id) THEN
      RAISE EXCEPTION 'no such portfolio entry of the requester' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_found';
    END IF;
    IF v_entry.context_kind IS DISTINCT FROM NEW.context_kind OR v_entry.context_id IS DISTINCT FROM NEW.context_id THEN
      RAISE EXCEPTION 'a portfolio entry is confirmed in its own context' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.no_recorded_relationship';
    END IF;
  END IF;
  NEW.requested_at := clock_timestamp();
  NEW.due_at := NEW.requested_at + interval '30 days';
  NEW.reminder_sent_at := NULL;
  NEW.withdrawn_at := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER confirmation_request_guard BEFORE INSERT ON trustwork.confirmation_request FOR EACH ROW EXECUTE FUNCTION trustwork.confirmation_request_guard();

-- Only the reminder and the withdrawal move, each once, by the requester; never after an answer or the deadline.
CREATE FUNCTION trustwork.confirmation_request_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'confirmation requests are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'reputation.append_only';
  END IF;
  IF ROW(NEW.id, NEW.requester_person_id, NEW.requester_company_id, NEW.addressed_person_id, NEW.addressed_company_id, NEW.context_kind, NEW.context_id, NEW.portfolio_entry_id,
         NEW.statement_kind, NEW.statement, NEW.no_incentive, NEW.no_conflict, NEW.requested_by_person_id, NEW.requested_at, NEW.due_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.requester_person_id, OLD.requester_company_id, OLD.addressed_person_id, OLD.addressed_company_id, OLD.context_kind, OLD.context_id,
         OLD.portfolio_entry_id, OLD.statement_kind, OLD.statement, OLD.no_incentive, OLD.no_conflict, OLD.requested_by_person_id, OLD.requested_at, OLD.due_at) THEN
    RAISE EXCEPTION 'a confirmation request is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'reputation.append_only';
  END IF;
  IF trustwork.reputation_maintenance() THEN
    RETURN NEW;
  END IF;
  IF NOT trustwork.commerce_party_acts(OLD.requester_person_id, OLD.requester_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'the requester reminds or withdraws' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_found';
  END IF;
  PERFORM trustwork.reputation_lock('request', OLD.id::text);
  IF OLD.withdrawn_at IS NOT NULL OR clock_timestamp() > OLD.due_at OR EXISTS (SELECT 1 FROM trustwork.confirmation_response x WHERE x.confirmation_request_id = OLD.id) THEN
    RAISE EXCEPTION 'the request is answered, withdrawn or expired' USING ERRCODE = 'check_violation', HINT = 'reputation.request_closed';
  END IF;
  IF NEW.reminder_sent_at IS DISTINCT FROM OLD.reminder_sent_at THEN
    IF OLD.reminder_sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'one reminder only' USING ERRCODE = 'check_violation', HINT = 'reputation.reminder_already_sent';
    END IF;
    IF clock_timestamp() < OLD.requested_at + interval '3 days' THEN
      RAISE EXCEPTION 'a reminder waits three days' USING ERRCODE = 'check_violation', HINT = 'reputation.reminder_too_early';
    END IF;
    NEW.reminder_sent_at := clock_timestamp();
  END IF;
  IF NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
    NEW.withdrawn_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER confirmation_request_update_guard BEFORE UPDATE OR DELETE ON trustwork.confirmation_request FOR EACH ROW EXECUTE FUNCTION trustwork.confirmation_request_update_guard();

-- Responses: the addressed party's person, in person, once, before the deadline; never an employee of the subject, a
-- relative of the requester, or the requester itself.
CREATE FUNCTION trustwork.confirmation_response_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_reason text;
BEGIN
  IF trustwork.reputation_maintenance() THEN
    RETURN NEW;
  END IF;
  IF NEW.responder_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the responder is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_authorised';
  END IF;
  PERFORM trustwork.reputation_lock('request', NEW.confirmation_request_id::text);
  v_reason := trustwork.reputation_response_refusal(NEW.confirmation_request_id, NEW.on_behalf_person_id, NEW.on_behalf_company_id);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation response refused: %', v_reason USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.' || v_reason;
  END IF;
  NEW.responded_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER confirmation_response_guard BEFORE INSERT ON trustwork.confirmation_response FOR EACH ROW EXECUTE FUNCTION trustwork.confirmation_response_guard();

-- 9. Derivation from canonical records ------------------------------------------------------------------------------
-- Materializes the contribution and timeliness records of one subject the caller acts for. Inputs are immutable
-- (responses are final, performance observations append-only), so the result is the same whenever it runs; existing
-- rows are kept. Sources, and nothing else:
--   consultation_given  a confirmed `advice_delivered` response to the holder's request (the counterparty's person
--                       confirmed the outcome), and a completed consultation agreement where the holder is the seller
--                       (consultation agreements open with CONS-001)
--   timeliness          EXE-001 timing and payment observations about the subject: expected at the end of the due day
--                       plus the allowance of approved plan changes, with their attribution and exclusion
CREATE FUNCTION trustwork.reputation_derive(p_person uuid, p_company uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_count integer := 0;
  v_n integer;
BEGIN
  IF num_nonnulls(p_person, p_company) <> 1 OR NOT trustwork.commerce_party_acts(p_person, p_company, 'company.deals.manage') THEN
    RAISE EXCEPTION 'records are derived for the subject the principal acts for' USING ERRCODE = 'insufficient_privilege', HINT = 'reputation.not_authorised';
  END IF;
  PERFORM trustwork.reputation_lock('derive', coalesce(p_person, p_company)::text);

  INSERT INTO trustwork.contribution_record (holder_person_id, holder_company_id, kind, source_kind, source_id, appeal_subject_kind, appeal_subject_id, outcome, occurred_at)
  SELECT r.requester_person_id, r.requester_company_id, 'consultation_given', 'confirmation_response', x.id, 'confirmation_response', x.id,
         jsonb_build_object('confirmedBy', 'counterparty', 'contextKind', r.context_kind), x.responded_at
  FROM trustwork.confirmation_request r JOIN trustwork.confirmation_response x ON x.confirmation_request_id = r.id
  WHERE r.statement_kind = 'advice_delivered' AND x.decision = 'confirmed'
    AND trustwork.execution_same_party(r.requester_person_id, r.requester_company_id, p_person, p_company)
  ON CONFLICT (kind, source_kind, source_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;

  INSERT INTO trustwork.contribution_record (holder_person_id, holder_company_id, kind, source_kind, source_id, appeal_subject_kind, appeal_subject_id, outcome, occurred_at)
  SELECT a.seller_person_id, a.seller_company_id, 'consultation_given', 'agreement', a.id, 'performance_observation', o.id,
         jsonb_build_object('deliverableAccepted', true), o.created_at
  FROM trustwork.agreement a
  JOIN LATERAL (
    SELECT po.id, po.created_at FROM trustwork.performance_observation po
    WHERE po.agreement_id = a.id AND po.dimension = 'quality' AND po.outcome = 'accepted'
      AND trustwork.execution_same_party(po.subject_person_id, po.subject_company_id, a.seller_person_id, a.seller_company_id)
    ORDER BY po.created_at DESC, po.id DESC LIMIT 1) o ON true
  WHERE a.terms_kind = 'consultation' AND a.status = 'accepted_by_both'
    AND trustwork.execution_same_party(a.seller_person_id, a.seller_company_id, p_person, p_company)
    AND trustwork.execution_agreement_completed(a.id)
  ON CONFLICT (kind, source_kind, source_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;

  INSERT INTO trustwork.timeliness_observation (subject_person_id, subject_company_id, kind, agreement_id, source_observation_id, expected_at, actual_at, delta_seconds, attribution,
    plan_change_ids, excluded_reason)
  SELECT o.subject_person_id, o.subject_company_id,
         CASE WHEN o.dimension = 'payment' THEN 'payment' WHEN c.kind = 'goods_delivery' THEN 'delivery' ELSE 'milestone' END,
         o.agreement_id, o.id, e.expected_at, o.performed_at,
         CASE WHEN e.expected_at IS NULL OR o.performed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM (o.performed_at - e.expected_at)))::bigint END,
         o.attribution, o.plan_change_ids, o.excluded_reason
  FROM trustwork.performance_observation o
  LEFT JOIN trustwork.execution_claim c ON c.id = o.claim_id
  CROSS JOIN LATERAL (SELECT CASE WHEN o.due_at IS NULL THEN NULL ELSE o.due_at + interval '1 day' + make_interval(days => o.allowance_days) END AS expected_at) e
  WHERE o.dimension IN ('timing', 'payment') AND trustwork.execution_same_party(o.subject_person_id, o.subject_company_id, p_person, p_company)
  ON CONFLICT (source_observation_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;
  RETURN v_count;
END $$;

-- 10. Appeals ---------------------------------------------------------------------------------------------------------
-- The requester appeals a counterparty's response; the original decider is the responder.
CREATE FUNCTION trustwork.reputation_file_appeal(p_hub_id uuid, p_subject_kind text, p_subject_id uuid, p_reason text) RETURNS trustwork.appeal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_request trustwork.confirmation_request%ROWTYPE;
  v_response trustwork.confirmation_response%ROWTYPE;
  v_row trustwork.appeal%ROWTYPE;
BEGIN
  IF p_subject_kind <> 'confirmation_response' THEN
    RAISE EXCEPTION 'this function files appeals on confirmation responses' USING ERRCODE = 'feature_not_supported', HINT = 'reputation.appeal_kind';
  END IF;
  SELECT * INTO v_response FROM trustwork.confirmation_response WHERE id = p_subject_id;
  SELECT * INTO v_request FROM trustwork.confirmation_request WHERE id = v_response.confirmation_request_id;
  IF v_response.id IS NULL OR NOT trustwork.commerce_party_acts(v_request.requester_person_id, v_request.requester_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'no such response to the caller' USING ERRCODE = 'no_data_found', HINT = 'reputation.not_found';
  END IF;
  INSERT INTO trustwork.appeal (hub_id, subject_kind, subject_id, appellant_person_id, appellant_company_id, reason, original_decided_by)
  VALUES (p_hub_id, 'confirmation_response', p_subject_id, v_person, v_request.requester_company_id, p_reason, v_response.responder_person_id) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- The person refused by an automated rule appeals it: the rule is evaluated again (a limitation that does not apply
-- cannot be appealed into existence), the limitation is recorded with its reason code and evidence, and the appeal
-- joins DATA-002's queue. An automated decision has no human decider: the appellant is recorded as the original
-- decider, so admin_decide_appeal always routes it to someone else.
CREATE FUNCTION trustwork.reputation_appeal_limitation(p_hub_id uuid, p_reason_code text, p_scope text, p_requester_person uuid, p_requester_company uuid, p_addressed_person uuid,
  p_addressed_company uuid, p_context_kind text, p_context_id uuid, p_statement_kind text, p_request_id uuid, p_reason text) RETURNS trustwork.appeal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_actual text;
  v_subject_person uuid;
  v_subject_company uuid;
  v_evidence jsonb;
  v_limitation trustwork.automated_limitation%ROWTYPE;
  v_row trustwork.appeal%ROWTYPE;
BEGIN
  IF p_scope = 'confirmation_request' THEN
    v_actual := trustwork.reputation_request_refusal(p_requester_person, p_requester_company, p_addressed_person, p_addressed_company, p_context_kind, p_context_id, p_statement_kind);
    v_subject_person := p_requester_person; v_subject_company := p_requester_company;
    v_evidence := jsonb_build_array(jsonb_build_object('kind', p_context_kind, 'id', p_context_id),
      jsonb_build_object('kind', CASE WHEN p_addressed_person IS NULL THEN 'company' ELSE 'person' END, 'id', coalesce(p_addressed_person, p_addressed_company)));
  ELSIF p_scope = 'confirmation_response' THEN
    v_actual := trustwork.reputation_response_refusal(p_request_id, p_addressed_person, p_addressed_company);
    v_subject_person := v_person; v_subject_company := NULL;
    v_evidence := jsonb_build_array(jsonb_build_object('kind', 'confirmation_request', 'id', p_request_id));
  ELSE
    RAISE EXCEPTION 'this function appeals confirmation refusals' USING ERRCODE = 'feature_not_supported', HINT = 'reputation.appeal_kind';
  END IF;
  IF v_actual IS NULL OR v_actual = 'not_authorised' OR v_actual IS DISTINCT FROM p_reason_code THEN
    RAISE EXCEPTION 'no such limitation applies to the caller' USING ERRCODE = 'no_data_found', HINT = 'reputation.limitation_not_found';
  END IF;
  INSERT INTO trustwork.automated_limitation (subject_person_id, subject_company_id, module, scope, reason_code, evidence, recorded_by_person_id)
  VALUES (v_subject_person, v_subject_company, 'reputation', p_scope, v_actual, v_evidence, v_person) RETURNING * INTO v_limitation;
  INSERT INTO trustwork.appeal (hub_id, subject_kind, subject_id, appellant_person_id, appellant_company_id, reason, original_decided_by)
  VALUES (p_hub_id, 'automated_limitation', v_limitation.id, v_person, v_subject_company, p_reason, v_person) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- The live appeal status of the caller's responses-to-appeal and limitations (withdrawn appeals are omitted).
CREATE FUNCTION trustwork.reputation_appeal_states(p_subject_kind text, p_subject_ids uuid[]) RETURNS TABLE (subject_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT a.subject_id, a.status FROM trustwork.appeal a
  WHERE a.subject_kind = p_subject_kind AND a.subject_id = ANY (p_subject_ids) AND a.status <> 'withdrawn'
    AND CASE p_subject_kind
      WHEN 'confirmation_response' THEN EXISTS (
        SELECT 1 FROM trustwork.confirmation_response x JOIN trustwork.confirmation_request r ON r.id = x.confirmation_request_id
        WHERE x.id = a.subject_id AND (trustwork.commerce_party_acts(r.requester_person_id, r.requester_company_id, 'company.deals.manage')
          OR trustwork.commerce_party_acts(r.addressed_person_id, r.addressed_company_id, 'company.deals.manage')))
      WHEN 'automated_limitation' THEN EXISTS (
        SELECT 1 FROM trustwork.automated_limitation l WHERE l.id = a.subject_id AND trustwork.commerce_party_acts(l.subject_person_id, l.subject_company_id, 'company.deals.manage'))
      ELSE false END
$$;

-- 11. Public reads ----------------------------------------------------------------------------------------------------
-- Public credentials of a company, or of a person whose profile is public: kind, type, jurisdiction, issuer, expiry
-- and the latest check (outcome, date, hub); never the number, the coverage or any document. Corrected rows drop out.
CREATE FUNCTION trustwork.reputation_public_credentials(p_person_id uuid, p_company_id uuid)
RETURNS TABLE (id uuid, kind text, jurisdiction text, credential_type text, issuer text, valid_until date, check_outcome text, checked_at timestamptz, check_hub_id uuid, register_valid_until date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT c.id, c.kind, c.jurisdiction, c.credential_type, c.issuer, c.valid_until, k.outcome, k.checked_at, k.hub_id, k.register_valid_until
  FROM trustwork.professional_credential c
  LEFT JOIN LATERAL (SELECT ck.outcome, ck.checked_at, ck.hub_id, ck.register_valid_until FROM trustwork.credential_check ck WHERE ck.credential_id = c.id
                     ORDER BY ck.checked_at DESC, ck.id DESC LIMIT 1) k ON true
  WHERE num_nonnulls(p_person_id, p_company_id) = 1 AND c.visibility = 'public'
    AND trustwork.execution_same_party(c.holder_person_id, c.holder_company_id, p_person_id, p_company_id)
    AND NOT EXISTS (SELECT 1 FROM trustwork.professional_credential s WHERE s.supersedes_id = c.id)
    AND (p_person_id IS NULL OR EXISTS (SELECT 1 FROM trustwork.person p WHERE p.id = p_person_id AND p.profile_visibility = 'public'))
  ORDER BY c.created_at, c.id
$$;

-- Public portfolio entries: an external entry as self-reported; an entry on a platform context only with the
-- counterparty's consent given in a confirmed or partial answer (then labelled client confirmed). Never the context id,
-- the counterparty or any address.
CREATE FUNCTION trustwork.reputation_public_portfolio(p_person_id uuid, p_company_id uuid)
RETURNS TABLE (id uuid, title text, role text, period_from date, period_to date, scope_summary text, external boolean, confirmation text, confirmed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT e.id, e.title, e.role, e.period_from, e.period_to, e.scope_summary, e.context_id IS NULL,
         CASE WHEN x.id IS NULL THEN 'self_reported' ELSE 'client_confirmed' END, x.responded_at
  FROM trustwork.portfolio_entry e
  LEFT JOIN LATERAL (
    SELECT xr.id, xr.responded_at FROM trustwork.confirmation_request r JOIN trustwork.confirmation_response xr ON xr.confirmation_request_id = r.id
    WHERE r.portfolio_entry_id = e.id AND xr.decision IN ('confirmed', 'partially') AND xr.consent_to_show
      AND NOT EXISTS (SELECT 1 FROM trustwork.appeal ap WHERE ap.subject_kind = 'confirmation_response' AND ap.subject_id = xr.id AND ap.status IN ('overturned'))
    ORDER BY xr.responded_at DESC, xr.id DESC LIMIT 1) x ON true
  WHERE num_nonnulls(p_person_id, p_company_id) = 1 AND e.visibility = 'public'
    AND trustwork.execution_same_party(e.holder_person_id, e.holder_company_id, p_person_id, p_company_id)
    AND NOT EXISTS (SELECT 1 FROM trustwork.portfolio_entry s WHERE s.supersedes_id = e.id)
    AND (e.context_id IS NULL OR x.id IS NOT NULL)
    AND (p_person_id IS NULL OR EXISTS (SELECT 1 FROM trustwork.person p WHERE p.id = p_person_id AND p.profile_visibility = 'public'))
  ORDER BY coalesce(e.period_to, e.period_from) DESC NULLS LAST, e.created_at, e.id
$$;

-- 12. Row-level security ----------------------------------------------------------------------------------------------
ALTER TABLE trustwork.professional_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.professional_credential FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.credential_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.credential_check FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.portfolio_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.portfolio_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.relation_declaration ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.relation_declaration FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.confirmation_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.confirmation_request FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.confirmation_response ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.confirmation_response FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.contribution_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.contribution_record FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.timeliness_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.timeliness_observation FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.automated_limitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.automated_limitation FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.professional_credential AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.credential_check AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.portfolio_entry AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.relation_declaration AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.confirmation_request AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.confirmation_response AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.contribution_record AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.timeliness_observation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.automated_limitation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- The holder (the subject) reads and writes its own records; nobody else, staff included.
CREATE POLICY professional_credential_holder ON trustwork.professional_credential FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(holder_person_id, holder_company_id, 'company.deals.manage'));
CREATE POLICY professional_credential_insert ON trustwork.professional_credential FOR INSERT TO trustwork_app
  WITH CHECK (trustwork.commerce_party_acts(holder_person_id, holder_company_id, 'company.deals.manage'));
CREATE POLICY credential_check_holder ON trustwork.credential_check FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.professional_credential c WHERE c.id = credential_id));
CREATE POLICY credential_check_insert ON trustwork.credential_check FOR INSERT TO trustwork_app
  WITH CHECK (EXISTS (SELECT 1 FROM trustwork.professional_credential c WHERE c.id = credential_id));
CREATE POLICY portfolio_entry_holder ON trustwork.portfolio_entry FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(holder_person_id, holder_company_id, 'company.deals.manage'));
CREATE POLICY portfolio_entry_insert ON trustwork.portfolio_entry FOR INSERT TO trustwork_app
  WITH CHECK (trustwork.commerce_party_acts(holder_person_id, holder_company_id, 'company.deals.manage'));
CREATE POLICY relation_declaration_declarer ON trustwork.relation_declaration FOR SELECT TO trustwork_app USING (declarer_person_id = trustwork.current_person_id());
CREATE POLICY relation_declaration_insert ON trustwork.relation_declaration FOR INSERT TO trustwork_app WITH CHECK (declarer_person_id = trustwork.current_person_id());
-- Requests and responses: both sides of the request.
CREATE POLICY confirmation_request_parties ON trustwork.confirmation_request FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(requester_person_id, requester_company_id, 'company.deals.manage') OR trustwork.commerce_party_acts(addressed_person_id, addressed_company_id, 'company.deals.manage'));
CREATE POLICY confirmation_request_insert ON trustwork.confirmation_request FOR INSERT TO trustwork_app
  WITH CHECK (trustwork.commerce_party_acts(requester_person_id, requester_company_id, 'company.deals.manage'));
CREATE POLICY confirmation_request_update ON trustwork.confirmation_request FOR UPDATE TO trustwork_app
  USING (trustwork.commerce_party_acts(requester_person_id, requester_company_id, 'company.deals.manage'))
  WITH CHECK (trustwork.commerce_party_acts(requester_person_id, requester_company_id, 'company.deals.manage'));
CREATE POLICY confirmation_response_parties ON trustwork.confirmation_response FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.confirmation_request r WHERE r.id = confirmation_request_id));
CREATE POLICY confirmation_response_insert ON trustwork.confirmation_response FOR INSERT TO trustwork_app
  WITH CHECK (trustwork.commerce_party_acts(on_behalf_person_id, on_behalf_company_id, 'company.deals.manage'));
-- Derived records and limitations: the subject only (it sees every observation about it); never inserted at runtime.
CREATE POLICY contribution_record_holder ON trustwork.contribution_record FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(holder_person_id, holder_company_id, 'company.deals.manage'));
CREATE POLICY timeliness_observation_subject ON trustwork.timeliness_observation FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(subject_person_id, subject_company_id, 'company.deals.manage'));
CREATE POLICY automated_limitation_subject ON trustwork.automated_limitation FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(subject_person_id, subject_company_id, 'company.deals.manage'));

-- 13. Grants ----------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON trustwork.professional_credential, trustwork.credential_check, trustwork.portfolio_entry, trustwork.relation_declaration, trustwork.confirmation_request,
  trustwork.confirmation_response TO trustwork_app;
GRANT UPDATE (reminder_sent_at, withdrawn_at) ON trustwork.confirmation_request TO trustwork_app;
GRANT SELECT ON trustwork.contribution_record, trustwork.timeliness_observation, trustwork.automated_limitation TO trustwork_app;
-- reputation_shared_context, reputation_employed and reputation_related are invoker helpers of the owner-run functions
-- and stay without a grant.
GRANT EXECUTE ON FUNCTION trustwork.reputation_maintenance(), trustwork.reputation_lock(text, text),
  trustwork.reputation_request_refusal(uuid, uuid, uuid, uuid, text, uuid, text), trustwork.reputation_response_refusal(uuid, uuid, uuid), trustwork.reputation_took_part(text, uuid, uuid, uuid),
  trustwork.reputation_derive(uuid, uuid), trustwork.reputation_file_appeal(uuid, text, uuid, text),
  trustwork.reputation_appeal_limitation(uuid, text, text, uuid, uuid, uuid, uuid, text, uuid, text, uuid, text), trustwork.reputation_appeal_states(text, uuid[]),
  trustwork.reputation_public_credentials(uuid, uuid), trustwork.reputation_public_portfolio(uuid, uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
