-- EXE-001: project execution, evidence and fair reputation. Claims, evidence, confirmations, defects, disputes and
-- supersession are recorded independently and never rewritten; performance observations are derived facts with fair
-- delay attribution from recorded plan changes; reviews exist only for completed agreements; reputation snapshots are
-- explainable evidence summaries that reference a method version (no public numeric score: ADR 012 open question O07).
--
-- Everything hangs on an agreement accepted by both parties (COM-002 `agreement`, any terms_kind) and its obligations:
--   execution_claim         a party asserts it fulfilled one of its own obligations (goods delivered, work or service
--                           performed, payment made) or remedied a defect; a claim is never a fact because it was said
--   execution_evidence      files attached to a claim or a defect (FILE-001 evidence artifacts of the agreement)
--   execution_confirmation  the counterparty's person accepts, partially accepts or rejects a claim; there is no agent
--                           path at all (no via or mandate column): a confirmation is never pre-authorized
--   execution_defect        what is wrong, where, how severe; closed only by an accepted remediation claim
--   execution_dispute       a party challenges a confirmation or a defect; a trust reviewer decides, a different
--                           reviewer decides the appeal (staff commands through DATA-002 elevation and audit)
--   performance_observation timing, quality and payment-discipline facts derived by execution_observe() from
--                           confirmations (and from TASK-001 milestone decisions), measured against the plan as agreed
--                           at the time: approved plan changes with their cause and accountable party give allowance, so
--                           a client-caused change never counts as a supplier delay
--   review, review_response opinions about a completed agreement by the other party's person; never mixed with facts
--   reputation_snapshot     subject-computed explainable summary with method version, samples and exclusions
--
-- Task agreements (terms_kind `task`) keep their milestone claims and decisions in TASK-001's task_execution_record;
-- here they get payment claims, defects, remediation, disputes, observations and reviews.
--
-- Payment neutrality: nothing here reads a billing table (tests/billing/policy.test.ts); paying the platform can never
-- add, hide or change an observation, a review or a snapshot (tests/trust). Every table is under FORCE RLS; nothing is
-- ever deleted; the runtime role has no UPDATE except the appeal columns of a dispute.

-- 0. Helpers ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.execution_same_party(p_a_person uuid, p_a_company uuid, p_b_person uuid, p_b_company uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT (p_a_person IS NOT NULL OR p_a_company IS NOT NULL) AND p_a_person IS NOT DISTINCT FROM p_b_person AND p_a_company IS NOT DISTINCT FROM p_b_company
$$;

-- 'buyer' or 'seller' for a party of the agreement row, otherwise NULL.
CREATE FUNCTION trustwork.execution_party_side(p_agreement trustwork.agreement, p_person uuid, p_company uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE
    WHEN trustwork.execution_same_party(p_person, p_company, (p_agreement).buyer_person_id, (p_agreement).buyer_company_id) THEN 'buyer'
    WHEN trustwork.execution_same_party(p_person, p_company, (p_agreement).seller_person_id, (p_agreement).seller_company_id) THEN 'seller'
  END
$$;

-- Serializes claims and decisions on one obligation (or one defect) across concurrent transactions of every role.
CREATE FUNCTION trustwork.execution_lock(p_kind text, p_id uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('trustwork.execution.' || p_kind || ':' || p_id::text, 0))
$$;

-- 1. Defects (append-only) --------------------------------------------------------------------------------------------
CREATE TABLE trustwork.execution_defect (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  obligation_id uuid NULL REFERENCES trustwork.obligation (id),
  claim_id uuid NULL,
  reporter_person_id uuid NULL REFERENCES trustwork.person (id),
  reporter_company_id uuid NULL REFERENCES trustwork.company (id),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  reported_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  via text NOT NULL CHECK (via IN ('person', 'agent')),
  mandate_id text NULL CHECK (mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  severity text NOT NULL CHECK (severity IN ('minor', 'major', 'critical')),
  location text NULL CHECK (length(location) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT execution_defect_reporter_xor CHECK ((reporter_person_id IS NULL) <> (reporter_company_id IS NULL)),
  CONSTRAINT execution_defect_subject_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT execution_defect_mandate CHECK ((via = 'agent') = (mandate_id IS NOT NULL))
);
CREATE INDEX execution_defect_agreement_idx ON trustwork.execution_defect (agreement_id, created_at);
CREATE INDEX execution_defect_subject_person_idx ON trustwork.execution_defect (subject_person_id) WHERE subject_person_id IS NOT NULL;
CREATE INDEX execution_defect_subject_company_idx ON trustwork.execution_defect (subject_company_id) WHERE subject_company_id IS NOT NULL;
CREATE TRIGGER execution_defect_append_only BEFORE UPDATE OR DELETE ON trustwork.execution_defect FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Claims (append-only; supersession appends a correcting claim) ---------------------------------------------------
CREATE TABLE trustwork.execution_claim (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  obligation_id uuid NULL REFERENCES trustwork.obligation (id),
  defect_id uuid NULL REFERENCES trustwork.execution_defect (id),
  kind text NOT NULL CHECK (kind IN ('goods_delivery', 'work_performed', 'service_delivered', 'payment_made', 'remediation')),
  claimant_person_id uuid NULL REFERENCES trustwork.person (id),
  claimant_company_id uuid NULL REFERENCES trustwork.company (id),
  counterparty_person_id uuid NULL REFERENCES trustwork.person (id),
  counterparty_company_id uuid NULL REFERENCES trustwork.company (id),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) <= 100),
  period_from date NULL,
  period_to date NULL,
  performed_at timestamptz NOT NULL,
  statement text NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  supersedes_claim_id uuid NULL UNIQUE REFERENCES trustwork.execution_claim (id),
  recorded_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  via text NOT NULL CHECK (via IN ('person', 'agent')),
  mandate_id text NULL CHECK (mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT execution_claim_claimant_xor CHECK ((claimant_person_id IS NULL) <> (claimant_company_id IS NULL)),
  CONSTRAINT execution_claim_counterparty_xor CHECK ((counterparty_person_id IS NULL) <> (counterparty_company_id IS NULL)),
  CONSTRAINT execution_claim_target CHECK ((kind = 'remediation') = (defect_id IS NOT NULL) AND (kind = 'remediation') = (obligation_id IS NULL)),
  CONSTRAINT execution_claim_goods_lines CHECK (kind <> 'goods_delivery' OR jsonb_array_length(lines) >= 1),
  CONSTRAINT execution_claim_period CHECK ((period_from IS NULL) = (period_to IS NULL) AND (period_from IS NULL OR period_from <= period_to)),
  CONSTRAINT execution_claim_mandate CHECK ((via = 'agent') = (mandate_id IS NOT NULL))
);
CREATE INDEX execution_claim_agreement_idx ON trustwork.execution_claim (agreement_id, created_at);
CREATE INDEX execution_claim_obligation_idx ON trustwork.execution_claim (obligation_id) WHERE obligation_id IS NOT NULL;
CREATE INDEX execution_claim_defect_idx ON trustwork.execution_claim (defect_id) WHERE defect_id IS NOT NULL;
CREATE TRIGGER execution_claim_append_only BEFORE UPDATE OR DELETE ON trustwork.execution_claim FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.execution_defect ADD CONSTRAINT execution_defect_claim FOREIGN KEY (claim_id) REFERENCES trustwork.execution_claim (id);

-- 3. Evidence (append-only) -------------------------------------------------------------------------------------------
-- Links a FILE-001 evidence artifact of the agreement to a claim or a defect. The artifact keeps its own owner and
-- classification; evidence never becomes public through this link.
CREATE TABLE trustwork.execution_evidence (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  claim_id uuid NULL REFERENCES trustwork.execution_claim (id),
  defect_id uuid NULL REFERENCES trustwork.execution_defect (id),
  artifact_id uuid NOT NULL REFERENCES trustwork.evidence_artifact (id),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('photo', 'delivery_note', 'acceptance_act', 'inspection_report', 'test_report', 'e_document', 'invoice', 'other')),
  observed_at timestamptz NULL,
  note text NULL CHECK (length(note) BETWEEN 1 AND 500),
  attached_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  via text NOT NULL CHECK (via IN ('person', 'agent')),
  mandate_id text NULL CHECK (mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT execution_evidence_parent CHECK (num_nonnulls(claim_id, defect_id) = 1),
  CONSTRAINT execution_evidence_mandate CHECK ((via = 'agent') = (mandate_id IS NOT NULL))
);
CREATE UNIQUE INDEX execution_evidence_claim_once ON trustwork.execution_evidence (claim_id, artifact_id) WHERE claim_id IS NOT NULL;
CREATE UNIQUE INDEX execution_evidence_defect_once ON trustwork.execution_evidence (defect_id, artifact_id) WHERE defect_id IS NOT NULL;
CREATE INDEX execution_evidence_agreement_idx ON trustwork.execution_evidence (agreement_id);
CREATE TRIGGER execution_evidence_append_only BEFORE UPDATE OR DELETE ON trustwork.execution_evidence FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Confirmations (append-only, human-only by construction) ----------------------------------------------------------
CREATE TABLE trustwork.execution_confirmation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  claim_id uuid NOT NULL UNIQUE REFERENCES trustwork.execution_claim (id),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  decision text NOT NULL CHECK (decision IN ('accepted', 'partially_accepted', 'rejected')),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) <= 100),
  note text NULL CHECK (length(note) BETWEEN 1 AND 2000),
  stage_code text NULL CHECK (stage_code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  decided_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  on_behalf_person_id uuid NULL REFERENCES trustwork.person (id),
  on_behalf_company_id uuid NULL REFERENCES trustwork.company (id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT execution_confirmation_on_behalf_xor CHECK ((on_behalf_person_id IS NULL) <> (on_behalf_company_id IS NULL)),
  CONSTRAINT execution_confirmation_reason CHECK (decision = 'accepted' OR note IS NOT NULL)
);
CREATE INDEX execution_confirmation_agreement_idx ON trustwork.execution_confirmation (agreement_id);
CREATE TRIGGER execution_confirmation_append_only BEFORE UPDATE OR DELETE ON trustwork.execution_confirmation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 5. Disputes (a case: opened by a party, decided by a trust reviewer, appealed once, decided by another reviewer) ---
CREATE TABLE trustwork.execution_dispute (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  target_kind text NOT NULL CHECK (target_kind IN ('confirmation', 'defect')),
  target_id uuid NOT NULL,
  opened_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  opener_person_id uuid NULL REFERENCES trustwork.person (id),
  opener_company_id uuid NULL REFERENCES trustwork.company (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decided', 'appealed', 'appeal_decided')),
  decision text NULL CHECK (decision IN ('upheld', 'overturned', 'partially')),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  decision_reason text NULL CHECK (length(decision_reason) BETWEEN 1 AND 500),
  appealed_by_person_id uuid NULL REFERENCES trustwork.person (id),
  appeal_reason text NULL CHECK (length(appeal_reason) BETWEEN 1 AND 2000),
  appealed_at timestamptz NULL,
  appeal_decision text NULL CHECK (appeal_decision IN ('upheld', 'overturned', 'partially_overturned')),
  appeal_decided_by uuid NULL REFERENCES trustwork.person (id),
  appeal_decided_at timestamptz NULL,
  appeal_decision_reason text NULL CHECK (length(appeal_decision_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_dispute_target_once UNIQUE (target_kind, target_id),
  CONSTRAINT execution_dispute_opener_xor CHECK ((opener_person_id IS NULL) <> (opener_company_id IS NULL)),
  CONSTRAINT execution_dispute_decision CHECK ((status = 'open') = (decided_by IS NULL) AND (decided_by IS NULL) = (decision IS NULL)
    AND (decided_by IS NULL) = (decided_at IS NULL) AND (decided_by IS NULL OR decision_reason IS NOT NULL)),
  CONSTRAINT execution_dispute_appeal CHECK ((status IN ('appealed', 'appeal_decided')) = (appealed_by_person_id IS NOT NULL)
    AND (appealed_by_person_id IS NULL) = (appeal_reason IS NULL) AND (appealed_by_person_id IS NULL) = (appealed_at IS NULL)),
  CONSTRAINT execution_dispute_appeal_decision CHECK ((status = 'appeal_decided') = (appeal_decided_by IS NOT NULL)
    AND (appeal_decided_by IS NULL) = (appeal_decision IS NULL) AND (appeal_decided_by IS NULL) = (appeal_decided_at IS NULL)
    AND (appeal_decided_by IS NULL OR appeal_decision_reason IS NOT NULL)),
  -- The appeal is decided by a different person than the original decider and than the appellant.
  CONSTRAINT execution_dispute_different_reviewer CHECK (appeal_decided_by IS NULL OR (appeal_decided_by <> decided_by AND appeal_decided_by <> appealed_by_person_id))
);
CREATE INDEX execution_dispute_agreement_idx ON trustwork.execution_dispute (agreement_id);
CREATE INDEX execution_dispute_hub_idx ON trustwork.execution_dispute (hub_id, status);
CREATE TRIGGER execution_dispute_touch BEFORE UPDATE ON trustwork.execution_dispute FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 6. Performance observations (append-only, written only by execution_observe) ---------------------------------------
CREATE TABLE trustwork.performance_observation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  source_kind text NOT NULL CHECK (source_kind IN ('execution_confirmation', 'task_acceptance', 'task_rejection')),
  source_id uuid NOT NULL,
  obligation_id uuid NULL REFERENCES trustwork.obligation (id),
  claim_id uuid NULL REFERENCES trustwork.execution_claim (id),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  counterparty_person_id uuid NULL REFERENCES trustwork.person (id),
  counterparty_company_id uuid NULL REFERENCES trustwork.company (id),
  dimension text NOT NULL CHECK (dimension IN ('timing', 'quality', 'payment')),
  outcome text NOT NULL CHECK (outcome IN ('on_time', 'late', 'excused_delay', 'unknown', 'accepted', 'partially_accepted', 'rejected')),
  due_at timestamptz NULL,
  performed_at timestamptz NULL,
  allowance_days integer NOT NULL DEFAULT 0 CHECK (allowance_days >= 0),
  late_days integer NULL CHECK (late_days >= 0),
  attribution text NOT NULL CHECK (attribution IN ('subject', 'counterparty', 'external', 'unknown')),
  excluded_reason text NULL CHECK (excluded_reason IN ('client_caused_change', 'external_change', 'unattributed_change', 'no_due_date')),
  plan_change_ids uuid[] NOT NULL DEFAULT '{}',
  baseline_plan_version_id uuid NULL REFERENCES trustwork.plan_version (id),
  decided_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT performance_observation_once UNIQUE (source_kind, source_id, dimension),
  CONSTRAINT performance_observation_subject_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT performance_observation_counterparty_xor CHECK ((counterparty_person_id IS NULL) <> (counterparty_company_id IS NULL)),
  CONSTRAINT performance_observation_outcome CHECK (CASE dimension
    WHEN 'quality' THEN outcome IN ('accepted', 'partially_accepted', 'rejected')
    ELSE outcome IN ('on_time', 'late', 'excused_delay', 'unknown') END),
  -- Excused and unattributed delays never count against the subject; missing dates are unknown, never late.
  CONSTRAINT performance_observation_excluded CHECK ((outcome IN ('excused_delay') OR (outcome = 'unknown' AND dimension <> 'quality')) = (excluded_reason IS NOT NULL))
);
CREATE INDEX performance_observation_agreement_idx ON trustwork.performance_observation (agreement_id);
CREATE INDEX performance_observation_subject_person_idx ON trustwork.performance_observation (subject_person_id) WHERE subject_person_id IS NOT NULL;
CREATE INDEX performance_observation_subject_company_idx ON trustwork.performance_observation (subject_company_id) WHERE subject_company_id IS NOT NULL;
CREATE TRIGGER performance_observation_append_only BEFORE UPDATE OR DELETE ON trustwork.performance_observation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 7. Reviews and responses (append-only; a correction is a new review that names the one it corrects) ---------------
CREATE TABLE trustwork.review (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  author_side text NOT NULL CHECK (author_side IN ('buyer', 'seller')),
  author_person_id uuid NULL REFERENCES trustwork.person (id),
  author_company_id uuid NULL REFERENCES trustwork.company (id),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  written_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  ratings jsonb NOT NULL CHECK (jsonb_typeof(ratings) = 'object' AND jsonb_typeof(ratings -> 'overall') = 'number'),
  text text NULL CHECK (length(text) BETWEEN 1 AND 4000),
  language text NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  corrects_review_id uuid NULL UNIQUE REFERENCES trustwork.review (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT review_author_xor CHECK ((author_person_id IS NULL) <> (author_company_id IS NULL)),
  CONSTRAINT review_subject_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT review_not_self CHECK (NOT trustwork.execution_same_party(author_person_id, author_company_id, subject_person_id, subject_company_id)
    AND written_by_person_id IS DISTINCT FROM subject_person_id)
);
-- One original review per side and agreement: two concurrent reviews of the same side cannot both commit.
CREATE UNIQUE INDEX review_once_per_side ON trustwork.review (agreement_id, author_side) WHERE corrects_review_id IS NULL;
CREATE INDEX review_subject_person_idx ON trustwork.review (subject_person_id) WHERE subject_person_id IS NOT NULL;
CREATE INDEX review_subject_company_idx ON trustwork.review (subject_company_id) WHERE subject_company_id IS NOT NULL;
CREATE TRIGGER review_append_only BEFORE UPDATE OR DELETE ON trustwork.review FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.review_response (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  review_id uuid NOT NULL UNIQUE REFERENCES trustwork.review (id),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  responder_person_id uuid NULL REFERENCES trustwork.person (id),
  responder_company_id uuid NULL REFERENCES trustwork.company (id),
  written_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT review_response_responder_xor CHECK ((responder_person_id IS NULL) <> (responder_company_id IS NULL))
);
CREATE TRIGGER review_response_append_only BEFORE UPDATE OR DELETE ON trustwork.review_response FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 8. Reputation snapshots (append-only) -------------------------------------------------------------------------------
-- summary: the subject's full evidence summary; public_summary: the masked public projection (counts only, dimensions
-- below the method's minimum sample say "not enough data"); explanation: the observation, review and defect ids
-- behind every count, for the subject only. No numeric score column: public scoring waits for O07.
CREATE TABLE trustwork.reputation_snapshot (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  method_version text NOT NULL CHECK (method_version ~ '^[a-z][a-z0-9.-]{0,63}$'),
  method_digest text NOT NULL CHECK (method_digest ~ '^[a-f0-9]{64}$'),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  public_summary jsonb NOT NULL CHECK (jsonb_typeof(public_summary) = 'object'),
  explanation jsonb NOT NULL CHECK (jsonb_typeof(explanation) = 'object'),
  inputs_digest text NOT NULL CHECK (inputs_digest ~ '^[a-f0-9]{64}$'),
  computed_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reputation_snapshot_subject_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL))
);
CREATE INDEX reputation_snapshot_person_idx ON trustwork.reputation_snapshot (subject_person_id, computed_at DESC) WHERE subject_person_id IS NOT NULL;
CREATE INDEX reputation_snapshot_company_idx ON trustwork.reputation_snapshot (subject_company_id, computed_at DESC) WHERE subject_company_id IS NOT NULL;
CREATE TRIGGER reputation_snapshot_append_only BEFORE UPDATE OR DELETE ON trustwork.reputation_snapshot FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 9. Derived state helpers (invoker; they read under the caller's row security) ---------------------------------------
-- A claim is open while it has no decision and no superseding claim.
CREATE FUNCTION trustwork.execution_claim_open(p_claim_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM trustwork.execution_confirmation f WHERE f.claim_id = p_claim_id)
     AND NOT EXISTS (SELECT 1 FROM trustwork.execution_claim s WHERE s.supersedes_claim_id = p_claim_id)
$$;

-- Completed: a task agreement whose assignment is accepted; otherwise every live deliver/perform obligation has an
-- accepted (fully) claim that was not superseded. Reviews are allowed only then.
CREATE FUNCTION trustwork.execution_agreement_completed(p_agreement_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce((
    SELECT CASE WHEN a.terms_kind = 'task'
      THEN EXISTS (SELECT 1 FROM trustwork.task_assignment t WHERE t.agreement_id = a.id AND t.status = 'accepted')
      ELSE EXISTS (SELECT 1 FROM trustwork.obligation o WHERE o.agreement_id = a.id AND o.kind IN ('deliver', 'perform') AND o.status <> 'waived')
       AND NOT EXISTS (
         SELECT 1 FROM trustwork.obligation o
         WHERE o.agreement_id = a.id AND o.kind IN ('deliver', 'perform') AND o.status <> 'waived'
           AND NOT EXISTS (
             SELECT 1 FROM trustwork.execution_claim c JOIN trustwork.execution_confirmation f ON f.claim_id = c.id
             WHERE c.obligation_id = o.id AND f.decision = 'accepted'
               AND NOT EXISTS (SELECT 1 FROM trustwork.execution_claim s WHERE s.supersedes_claim_id = c.id)))
      END
    FROM trustwork.agreement a WHERE a.id = p_agreement_id AND a.status = 'accepted_by_both'), false)
$$;

-- 10. Owner-run reads for parties -------------------------------------------------------------------------------------
-- The sha256 of a FILE-001 artifact attached to this agreement, when the caller is a party and the scan did not
-- quarantine it; NULL otherwise (the caller learns nothing about artifacts of other parents).
CREATE FUNCTION trustwork.execution_artifact_digest(p_artifact_id uuid, p_agreement_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT e.sha256 FROM trustwork.evidence_artifact e
  WHERE e.id = p_artifact_id AND e.parent_kind = 'agreement' AND e.parent_id = p_agreement_id AND e.scan_state <> 'quarantined'
    AND e.classification IN ('shared', 'party_private') AND trustwork.agreement_side(p_agreement_id) IS NOT NULL
$$;

-- The approved plan changes that can move the dates of an agreement: changes that name it, and changes without an
-- agreement on the plan the agreement executes (the task's plan, or the plan of the RFQ's project), decided after the
-- agreement was formed. Invoker helper used inside execution_observe and execution_timing_facts only.
CREATE FUNCTION trustwork.execution_relevant_changes(p_agreement_id uuid, p_until timestamptz)
RETURNS TABLE (change_id uuid, plan_id uuid, cause text, accountable_person_id uuid, accountable_company_id uuid, schedule_impact_days integer, decided_at timestamptz)
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT pc.id, pc.plan_id, pc.cause, pc.accountable_person_id, pc.accountable_company_id, pc.schedule_impact_days, pc.decided_at
  FROM trustwork.plan_change pc JOIN trustwork.agreement a ON a.id = p_agreement_id
  WHERE pc.status = 'approved' AND pc.decided_at >= a.created_at AND (p_until IS NULL OR pc.decided_at <= p_until)
    AND (pc.agreement_id = a.id::text
         OR (pc.agreement_id IS NULL AND pc.plan_id IN (
               SELECT t.plan_id FROM trustwork.task_assignment t WHERE t.agreement_id = a.id
               UNION SELECT pl.id FROM trustwork.plan pl JOIN trustwork.rfq r ON r.plan_project_id = pl.project_id WHERE r.id = a.rfq_id)))
  ORDER BY pc.decided_at, pc.id
$$;

-- Timing facts a party may see about its agreement: cause, accountable party, impact and decision time of each
-- relevant change; never the change's reason text or the plan itself (owner-private).
CREATE FUNCTION trustwork.execution_timing_facts(p_agreement_id uuid)
RETURNS TABLE (change_id uuid, cause text, accountable_person_id uuid, accountable_company_id uuid, schedule_impact_days integer, decided_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT c.change_id, c.cause, c.accountable_person_id, c.accountable_company_id, c.schedule_impact_days, c.decided_at
  FROM trustwork.execution_relevant_changes(p_agreement_id, NULL) c
  WHERE trustwork.agreement_side(p_agreement_id) IS NOT NULL
$$;

-- 11. Fair timing ------------------------------------------------------------------------------------------------------
-- Measures one performance against the obligation's due date as agreed, plus allowance from approved plan changes
-- decided before the performance. Classification of a change for this subject: the accountable party decides first
-- (the subject itself gives no allowance); otherwise the cause, read from the plan owner's side (the buyer): site
-- conditions, regulators and external events are external; the owner's request is the client's; the plan owner's
-- counterparty is the seller; an unknown cause is unattributed. Allowance from the counterparty or external events
-- excuses the delay (excluded, never counted against the subject); unattributed allowance makes the outcome unknown;
-- only what exceeds all allowance is a delay of the subject. No due date: unknown, never late.
CREATE FUNCTION trustwork.execution_measure_timing(p_agreement_id uuid, p_subject_person uuid, p_subject_company uuid, p_due timestamptz, p_performed timestamptz,
  OUT outcome text, OUT allowance_days integer, OUT late_days integer, OUT attribution text, OUT excluded_reason text, OUT plan_change_ids uuid[])
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_agreement trustwork.agreement%ROWTYPE;
  v_subject_side text;
  v_cp_person uuid;
  v_cp_company uuid;
  v_change record;
  v_class text;
  v_excused integer := 0;
  v_unknown integer := 0;
  v_counterparty boolean := false;
  v_late integer;
BEGIN
  plan_change_ids := '{}';
  allowance_days := 0;
  IF p_due IS NULL OR p_performed IS NULL THEN
    outcome := 'unknown'; late_days := NULL; attribution := 'unknown'; excluded_reason := 'no_due_date';
    RETURN;
  END IF;
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = p_agreement_id;
  v_subject_side := trustwork.execution_party_side(v_agreement, p_subject_person, p_subject_company);
  IF v_subject_side = 'buyer' THEN
    v_cp_person := v_agreement.seller_person_id; v_cp_company := v_agreement.seller_company_id;
  ELSE
    v_cp_person := v_agreement.buyer_person_id; v_cp_company := v_agreement.buyer_company_id;
  END IF;
  FOR v_change IN SELECT * FROM trustwork.execution_relevant_changes(p_agreement_id, p_performed) c WHERE c.schedule_impact_days > 0 LOOP
    v_class := CASE
      WHEN trustwork.execution_same_party(v_change.accountable_person_id, v_change.accountable_company_id, p_subject_person, p_subject_company) THEN 'subject'
      WHEN trustwork.execution_same_party(v_change.accountable_person_id, v_change.accountable_company_id, v_cp_person, v_cp_company) THEN 'counterparty'
      WHEN v_change.cause IN ('site_condition', 'regulatory', 'external') THEN 'external'
      WHEN v_change.cause = 'owner_request' THEN CASE WHEN v_subject_side = 'buyer' THEN 'subject' ELSE 'counterparty' END
      WHEN v_change.cause = 'counterparty' THEN CASE WHEN v_subject_side = 'buyer' THEN 'counterparty' ELSE 'subject' END
      ELSE 'unknown' END;
    plan_change_ids := plan_change_ids || v_change.change_id;
    IF v_class IN ('counterparty', 'external') THEN
      v_excused := v_excused + v_change.schedule_impact_days;
      v_counterparty := v_counterparty OR v_class = 'counterparty';
    ELSIF v_class = 'unknown' THEN
      v_unknown := v_unknown + v_change.schedule_impact_days;
    END IF;
  END LOOP;
  allowance_days := v_excused + v_unknown;
  -- The due date is the start of the due day in the agreed time zone; the whole day is on time.
  v_late := CASE WHEN p_performed > p_due + interval '1 day' THEN ceil(extract(epoch FROM (p_performed - (p_due + interval '1 day'))) / 86400)::integer ELSE 0 END;
  IF v_late = 0 THEN
    outcome := 'on_time'; late_days := 0; attribution := 'subject'; excluded_reason := NULL;
  ELSIF v_late <= v_excused THEN
    outcome := 'excused_delay'; late_days := v_late;
    attribution := CASE WHEN v_counterparty THEN 'counterparty' ELSE 'external' END;
    excluded_reason := CASE WHEN v_counterparty THEN 'client_caused_change' ELSE 'external_change' END;
  ELSIF v_late <= v_excused + v_unknown THEN
    outcome := 'unknown'; late_days := v_late; attribution := 'unknown'; excluded_reason := 'unattributed_change';
  ELSE
    outcome := 'late'; late_days := v_late - v_excused - v_unknown; attribution := 'subject'; excluded_reason := NULL;
  END IF;
END $$;

-- The approved plan version the agreement was measured against: the task's version, or for an RFQ the version of the
-- project plan that was approved when the agreement was formed.
CREATE FUNCTION trustwork.execution_baseline(p_agreement_id uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(
    (SELECT t.plan_version_id FROM trustwork.task_assignment t WHERE t.agreement_id = p_agreement_id LIMIT 1),
    (SELECT v.id FROM trustwork.agreement a JOIN trustwork.rfq r ON r.id = a.rfq_id JOIN trustwork.plan pl ON pl.project_id = r.plan_project_id
       JOIN trustwork.plan_version v ON v.plan_id = pl.id
     WHERE a.id = p_agreement_id AND v.approved_at IS NOT NULL AND v.approved_at <= a.created_at AND (v.superseded_at IS NULL OR v.superseded_at > a.created_at)
     ORDER BY v.version DESC LIMIT 1))
$$;

-- Materializes the observations of one agreement: for every confirmation (and, for task agreements, every TASK-001
-- milestone decision) a quality fact, and for accepted performance a timing or payment fact measured as above. Inputs
-- are immutable (decisions are append-only; plan changes are never rewritten and only those decided before the
-- performance count), so the result is the same whenever and by whichever party it runs; existing rows are kept.
CREATE FUNCTION trustwork.execution_observe(p_agreement_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_agreement trustwork.agreement%ROWTYPE;
  v_row record;
  v_timing record;
  v_obligation trustwork.obligation%ROWTYPE;
  v_baseline uuid;
  v_count integer := 0;
  v_n integer;
BEGIN
  IF trustwork.agreement_side(p_agreement_id) IS NULL THEN
    RAISE EXCEPTION 'only the parties observe their agreement' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_found';
  END IF;
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = p_agreement_id;
  PERFORM trustwork.execution_lock('agreement', p_agreement_id);
  v_baseline := trustwork.execution_baseline(p_agreement_id);

  -- Confirmations of claims on obligations (remediation is reflected through its defect, not as an observation).
  FOR v_row IN
    SELECT f.id AS confirmation_id, f.decision, f.decided_by_person_id, c.id AS claim_id, c.kind, c.obligation_id, c.performed_at,
           c.claimant_person_id, c.claimant_company_id, c.counterparty_person_id, c.counterparty_company_id
    FROM trustwork.execution_confirmation f JOIN trustwork.execution_claim c ON c.id = f.claim_id
    WHERE f.agreement_id = p_agreement_id AND c.kind <> 'remediation'
  LOOP
    SELECT * INTO v_obligation FROM trustwork.obligation WHERE id = v_row.obligation_id;
    IF v_row.kind <> 'payment_made' THEN
      INSERT INTO trustwork.performance_observation (agreement_id, source_kind, source_id, obligation_id, claim_id, subject_person_id, subject_company_id, counterparty_person_id,
        counterparty_company_id, dimension, outcome, due_at, performed_at, attribution, baseline_plan_version_id, decided_by_person_id)
      VALUES (p_agreement_id, 'execution_confirmation', v_row.confirmation_id, v_row.obligation_id, v_row.claim_id, v_row.claimant_person_id, v_row.claimant_company_id,
        v_row.counterparty_person_id, v_row.counterparty_company_id, 'quality', v_row.decision, v_obligation.due, v_row.performed_at, 'subject', v_baseline, v_row.decided_by_person_id)
      ON CONFLICT (source_kind, source_id, dimension) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;
    END IF;
    IF v_row.decision IN ('accepted', 'partially_accepted') THEN
      SELECT * INTO v_timing FROM trustwork.execution_measure_timing(p_agreement_id, v_row.claimant_person_id, v_row.claimant_company_id, v_obligation.due, v_row.performed_at);
      INSERT INTO trustwork.performance_observation (agreement_id, source_kind, source_id, obligation_id, claim_id, subject_person_id, subject_company_id, counterparty_person_id,
        counterparty_company_id, dimension, outcome, due_at, performed_at, allowance_days, late_days, attribution, excluded_reason, plan_change_ids, baseline_plan_version_id, decided_by_person_id)
      VALUES (p_agreement_id, 'execution_confirmation', v_row.confirmation_id, v_row.obligation_id, v_row.claim_id, v_row.claimant_person_id, v_row.claimant_company_id,
        v_row.counterparty_person_id, v_row.counterparty_company_id, CASE WHEN v_row.kind = 'payment_made' THEN 'payment' ELSE 'timing' END, v_timing.outcome, v_obligation.due,
        v_row.performed_at, v_timing.allowance_days, v_timing.late_days, v_timing.attribution, v_timing.excluded_reason, v_timing.plan_change_ids, v_baseline, v_row.decided_by_person_id)
      ON CONFLICT (source_kind, source_id, dimension) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;
    END IF;
  END LOOP;

  -- TASK-001 milestone decisions: the owner's acceptance or rejection of the assignee's delivery claim. The perform
  -- obligation of milestone i is at position 2*i (deriveTaskObligations: perform, pay per milestone, then accept).
  IF v_agreement.terms_kind = 'task' THEN
    FOR v_row IN
      SELECT r.id AS record_id, r.kind, r.recorded_by_person_id, claim.created_at AS claimed_at, t.owner_person_id, t.assignee_person_id, t.assignee_company_id,
             (SELECT m.ord - 1 FROM jsonb_array_elements(t.milestones) WITH ORDINALITY m(value, ord) WHERE m.value ->> 'key' = r.milestone_key) AS milestone_index
      FROM trustwork.task_execution_record r
      JOIN trustwork.task_assignment t ON t.id = r.assignment_id
      JOIN trustwork.task_execution_record claim ON claim.id = r.claim_id
      WHERE t.agreement_id = p_agreement_id AND r.kind IN ('acceptance', 'rejection')
    LOOP
      SELECT * INTO v_obligation FROM trustwork.obligation WHERE agreement_id = p_agreement_id AND position = 2 * v_row.milestone_index AND kind = 'perform';
      INSERT INTO trustwork.performance_observation (agreement_id, source_kind, source_id, obligation_id, subject_person_id, subject_company_id, counterparty_person_id,
        counterparty_company_id, dimension, outcome, due_at, performed_at, attribution, baseline_plan_version_id, decided_by_person_id)
      VALUES (p_agreement_id, CASE WHEN v_row.kind = 'acceptance' THEN 'task_acceptance' ELSE 'task_rejection' END, v_row.record_id, v_obligation.id, v_row.assignee_person_id,
        v_row.assignee_company_id, v_row.owner_person_id, NULL, 'quality', CASE WHEN v_row.kind = 'acceptance' THEN 'accepted' ELSE 'rejected' END, v_obligation.due,
        v_row.claimed_at, 'subject', v_baseline, v_row.recorded_by_person_id)
      ON CONFLICT (source_kind, source_id, dimension) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;
      IF v_row.kind = 'acceptance' THEN
        SELECT * INTO v_timing FROM trustwork.execution_measure_timing(p_agreement_id, v_row.assignee_person_id, v_row.assignee_company_id, v_obligation.due, v_row.claimed_at);
        INSERT INTO trustwork.performance_observation (agreement_id, source_kind, source_id, obligation_id, subject_person_id, subject_company_id, counterparty_person_id,
          counterparty_company_id, dimension, outcome, due_at, performed_at, allowance_days, late_days, attribution, excluded_reason, plan_change_ids, baseline_plan_version_id,
          decided_by_person_id)
        VALUES (p_agreement_id, 'task_acceptance', v_row.record_id, v_obligation.id, v_row.assignee_person_id, v_row.assignee_company_id, v_row.owner_person_id, NULL, 'timing',
          v_timing.outcome, v_obligation.due, v_row.claimed_at, v_timing.allowance_days, v_timing.late_days, v_timing.attribution, v_timing.excluded_reason,
          v_timing.plan_change_ids, v_baseline, v_row.recorded_by_person_id)
        ON CONFLICT (source_kind, source_id, dimension) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;
      END IF;
    END LOOP;
  END IF;
  RETURN v_count;
END $$;

-- 12. Guards ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.execution_defect_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_agreement trustwork.agreement%ROWTYPE;
  v_side text;
  v_obligation trustwork.obligation%ROWTYPE;
  v_claim trustwork.execution_claim%ROWTYPE;
BEGIN
  IF NEW.reported_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the reporter is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
  END IF;
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = NEW.agreement_id;
  IF v_agreement.id IS NULL OR trustwork.agreement_side(NEW.agreement_id) IS NULL THEN
    RAISE EXCEPTION 'no such agreement for the caller' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_found';
  END IF;
  IF v_agreement.status <> 'accepted_by_both' THEN
    RAISE EXCEPTION 'execution records follow an agreement accepted by both' USING ERRCODE = 'check_violation', HINT = 'execution.agreement_not_live';
  END IF;
  v_side := trustwork.execution_party_side(v_agreement, NEW.reporter_person_id, NEW.reporter_company_id);
  IF v_side IS NULL OR NOT trustwork.commerce_party_acts(NEW.reporter_person_id, NEW.reporter_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'a party reports defects for its own side' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
  END IF;
  IF v_side = 'buyer' THEN
    NEW.subject_person_id := v_agreement.seller_person_id; NEW.subject_company_id := v_agreement.seller_company_id;
  ELSE
    NEW.subject_person_id := v_agreement.buyer_person_id; NEW.subject_company_id := v_agreement.buyer_company_id;
  END IF;
  IF NEW.obligation_id IS NOT NULL THEN
    SELECT * INTO v_obligation FROM trustwork.obligation WHERE id = NEW.obligation_id;
    IF v_obligation.agreement_id IS DISTINCT FROM NEW.agreement_id OR NOT trustwork.execution_same_party(v_obligation.obligor_person_id, v_obligation.obligor_company_id, NEW.subject_person_id, NEW.subject_company_id) THEN
      RAISE EXCEPTION 'a defect names an obligation of the other party' USING ERRCODE = 'check_violation', HINT = 'execution.unknown_obligation';
    END IF;
  END IF;
  IF NEW.claim_id IS NOT NULL THEN
    SELECT * INTO v_claim FROM trustwork.execution_claim WHERE id = NEW.claim_id;
    IF v_claim.agreement_id IS DISTINCT FROM NEW.agreement_id OR NOT trustwork.execution_same_party(v_claim.claimant_person_id, v_claim.claimant_company_id, NEW.subject_person_id, NEW.subject_company_id) THEN
      RAISE EXCEPTION 'a defect names a claim of the other party' USING ERRCODE = 'check_violation', HINT = 'execution.unknown_claim';
    END IF;
  END IF;
  IF NEW.observed_at > clock_timestamp() + interval '10 minutes' THEN
    RAISE EXCEPTION 'a defect is observed, not foreseen' USING ERRCODE = 'check_violation', HINT = 'execution.in_future';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_defect_guard BEFORE INSERT ON trustwork.execution_defect FOR EACH ROW EXECUTE FUNCTION trustwork.execution_defect_guard();

-- Claims: the principal acts for the claimant, the claimant owes the obligation (or is the subject of the defect it
-- remedies), the kind fits the obligation, one open claim per obligation or defect at a time (serialized), nothing
-- after a full acceptance or a resolved defect. Task milestones are claimed through TASK-001 records.
CREATE FUNCTION trustwork.execution_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_agreement trustwork.agreement%ROWTYPE;
  v_side text;
  v_obligation trustwork.obligation%ROWTYPE;
  v_defect trustwork.execution_defect%ROWTYPE;
  v_target trustwork.execution_claim%ROWTYPE;
BEGIN
  IF NEW.recorded_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the recorder is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
  END IF;
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = NEW.agreement_id;
  IF v_agreement.id IS NULL OR trustwork.agreement_side(NEW.agreement_id) IS NULL THEN
    RAISE EXCEPTION 'no such agreement for the caller' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_found';
  END IF;
  IF v_agreement.status <> 'accepted_by_both' THEN
    RAISE EXCEPTION 'execution records follow an agreement accepted by both' USING ERRCODE = 'check_violation', HINT = 'execution.agreement_not_live';
  END IF;
  v_side := trustwork.execution_party_side(v_agreement, NEW.claimant_person_id, NEW.claimant_company_id);
  IF v_side IS NULL OR NOT trustwork.commerce_party_acts(NEW.claimant_person_id, NEW.claimant_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'a party claims for its own side' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
  END IF;
  IF v_side = 'buyer' THEN
    NEW.counterparty_person_id := v_agreement.seller_person_id; NEW.counterparty_company_id := v_agreement.seller_company_id;
  ELSE
    NEW.counterparty_person_id := v_agreement.buyer_person_id; NEW.counterparty_company_id := v_agreement.buyer_company_id;
  END IF;
  IF NEW.performed_at > clock_timestamp() + interval '10 minutes' THEN
    RAISE EXCEPTION 'a claim states what happened, not what will' USING ERRCODE = 'check_violation', HINT = 'execution.in_future';
  END IF;
  IF NEW.kind = 'remediation' THEN
    SELECT * INTO v_defect FROM trustwork.execution_defect WHERE id = NEW.defect_id;
    IF v_defect.agreement_id IS DISTINCT FROM NEW.agreement_id OR NOT trustwork.execution_same_party(v_defect.subject_person_id, v_defect.subject_company_id, NEW.claimant_person_id, NEW.claimant_company_id) THEN
      RAISE EXCEPTION 'the party a defect names remedies it' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_obligor';
    END IF;
    PERFORM trustwork.execution_lock('defect', NEW.defect_id);
    IF EXISTS (SELECT 1 FROM trustwork.execution_claim c JOIN trustwork.execution_confirmation f ON f.claim_id = c.id
               WHERE c.defect_id = NEW.defect_id AND f.decision = 'accepted' AND NOT EXISTS (SELECT 1 FROM trustwork.execution_claim s WHERE s.supersedes_claim_id = c.id)) THEN
      RAISE EXCEPTION 'the defect is resolved' USING ERRCODE = 'check_violation', HINT = 'execution.defect_resolved';
    END IF;
  ELSE
    SELECT * INTO v_obligation FROM trustwork.obligation WHERE id = NEW.obligation_id;
    IF v_obligation.agreement_id IS DISTINCT FROM NEW.agreement_id OR v_obligation.status = 'waived' THEN
      RAISE EXCEPTION 'no such live obligation of the agreement' USING ERRCODE = 'check_violation', HINT = 'execution.unknown_obligation';
    END IF;
    IF NOT trustwork.execution_same_party(v_obligation.obligor_person_id, v_obligation.obligor_company_id, NEW.claimant_person_id, NEW.claimant_company_id) THEN
      RAISE EXCEPTION 'only the obligor claims an obligation' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_obligor';
    END IF;
    IF NOT ((v_obligation.kind = 'deliver' AND NEW.kind = 'goods_delivery') OR (v_obligation.kind = 'perform' AND NEW.kind IN ('work_performed', 'service_delivered'))
            OR (v_obligation.kind = 'pay' AND NEW.kind = 'payment_made')) THEN
      RAISE EXCEPTION 'a % claim does not fit a % obligation', NEW.kind, v_obligation.kind USING ERRCODE = 'check_violation', HINT = 'execution.kind_mismatch';
    END IF;
    IF v_agreement.terms_kind = 'task' AND NEW.kind <> 'payment_made' THEN
      RAISE EXCEPTION 'task milestones are claimed through the task assignment' USING ERRCODE = 'check_violation', HINT = 'execution.task_records';
    END IF;
    PERFORM trustwork.execution_lock('obligation', NEW.obligation_id);
    IF EXISTS (SELECT 1 FROM trustwork.execution_claim c JOIN trustwork.execution_confirmation f ON f.claim_id = c.id
               WHERE c.obligation_id = NEW.obligation_id AND f.decision = 'accepted' AND NOT EXISTS (SELECT 1 FROM trustwork.execution_claim s WHERE s.supersedes_claim_id = c.id)) THEN
      RAISE EXCEPTION 'the obligation is fulfilled' USING ERRCODE = 'check_violation', HINT = 'execution.obligation_fulfilled';
    END IF;
  END IF;
  IF NEW.supersedes_claim_id IS NOT NULL THEN
    SELECT * INTO v_target FROM trustwork.execution_claim WHERE id = NEW.supersedes_claim_id;
    IF v_target.id IS NULL OR v_target.obligation_id IS DISTINCT FROM NEW.obligation_id OR v_target.defect_id IS DISTINCT FROM NEW.defect_id
       OR NOT trustwork.execution_same_party(v_target.claimant_person_id, v_target.claimant_company_id, NEW.claimant_person_id, NEW.claimant_company_id)
       OR NOT trustwork.execution_claim_open(v_target.id) THEN
      RAISE EXCEPTION 'only an open claim of the same party and obligation is superseded' USING ERRCODE = 'check_violation', HINT = 'execution.not_supersedable';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.execution_claim c
             WHERE (c.obligation_id = NEW.obligation_id OR c.defect_id = NEW.defect_id) AND c.id IS DISTINCT FROM NEW.supersedes_claim_id AND trustwork.execution_claim_open(c.id)) THEN
    RAISE EXCEPTION 'an open claim awaits a decision' USING ERRCODE = 'check_violation', HINT = 'execution.claim_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_claim_guard BEFORE INSERT ON trustwork.execution_claim FOR EACH ROW EXECUTE FUNCTION trustwork.execution_claim_guard();

-- Evidence: attached by a person acting for the claimant (or the defect's reporter), to a claim not superseded, from
-- an artifact of this agreement whose digest the link repeats.
CREATE FUNCTION trustwork.execution_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_claim trustwork.execution_claim%ROWTYPE;
  v_defect trustwork.execution_defect%ROWTYPE;
  v_sha text;
BEGIN
  IF NEW.attached_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the attacher is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
  END IF;
  IF NEW.claim_id IS NOT NULL THEN
    SELECT * INTO v_claim FROM trustwork.execution_claim WHERE id = NEW.claim_id;
    IF v_claim.id IS NULL OR v_claim.agreement_id <> NEW.agreement_id OR NOT trustwork.commerce_party_acts(v_claim.claimant_person_id, v_claim.claimant_company_id, 'company.deals.manage') THEN
      RAISE EXCEPTION 'the claimant attaches evidence to its claim' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
    END IF;
    IF EXISTS (SELECT 1 FROM trustwork.execution_claim s WHERE s.supersedes_claim_id = NEW.claim_id) THEN
      RAISE EXCEPTION 'the claim was superseded' USING ERRCODE = 'check_violation', HINT = 'execution.claim_superseded';
    END IF;
  ELSE
    SELECT * INTO v_defect FROM trustwork.execution_defect WHERE id = NEW.defect_id;
    IF v_defect.id IS NULL OR v_defect.agreement_id <> NEW.agreement_id OR NOT trustwork.commerce_party_acts(v_defect.reporter_person_id, v_defect.reporter_company_id, 'company.deals.manage') THEN
      RAISE EXCEPTION 'the reporter attaches evidence to its defect' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
    END IF;
  END IF;
  v_sha := trustwork.execution_artifact_digest(NEW.artifact_id, NEW.agreement_id);
  IF v_sha IS NULL OR v_sha <> NEW.artifact_sha256 THEN
    RAISE EXCEPTION 'evidence comes from an artifact of this agreement with the stated digest' USING ERRCODE = 'check_violation', HINT = 'execution.artifact_not_attachable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_evidence_guard BEFORE INSERT ON trustwork.execution_evidence FOR EACH ROW EXECUTE FUNCTION trustwork.execution_evidence_guard();

-- Confirmations: a person acting for the claim's counterparty decides the open claim; never the claimant side and
-- never the person who recorded the claim; one decision per claim (unique), serialized with new claims.
CREATE FUNCTION trustwork.execution_confirmation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_claim trustwork.execution_claim%ROWTYPE;
  v_status text;
BEGIN
  IF NEW.decided_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the decider is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
  END IF;
  SELECT * INTO v_claim FROM trustwork.execution_claim WHERE id = NEW.claim_id;
  IF v_claim.id IS NULL OR v_claim.agreement_id <> NEW.agreement_id OR trustwork.agreement_side(NEW.agreement_id) IS NULL THEN
    RAISE EXCEPTION 'no such claim for the caller' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_found';
  END IF;
  SELECT status INTO v_status FROM trustwork.agreement WHERE id = NEW.agreement_id;
  IF v_status <> 'accepted_by_both' THEN
    RAISE EXCEPTION 'execution records follow an agreement accepted by both' USING ERRCODE = 'check_violation', HINT = 'execution.agreement_not_live';
  END IF;
  IF NEW.decided_by_person_id = v_claim.recorded_by_person_id OR trustwork.commerce_party_acts(v_claim.claimant_person_id, v_claim.claimant_company_id, 'company.deals.manage')
     OR (v_claim.claimant_company_id IS NOT NULL AND v_claim.claimant_company_id IS NOT DISTINCT FROM trustwork.current_company_id()) THEN
    RAISE EXCEPTION 'nobody confirms their own claim' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.self_confirmation';
  END IF;
  IF NOT trustwork.execution_same_party(NEW.on_behalf_person_id, NEW.on_behalf_company_id, v_claim.counterparty_person_id, v_claim.counterparty_company_id)
     OR NOT trustwork.commerce_party_acts(NEW.on_behalf_person_id, NEW.on_behalf_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'the counterparty decides on a claim' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
  END IF;
  IF v_claim.defect_id IS NOT NULL THEN
    PERFORM trustwork.execution_lock('defect', v_claim.defect_id);
  ELSE
    PERFORM trustwork.execution_lock('obligation', v_claim.obligation_id);
  END IF;
  IF NOT trustwork.execution_claim_open(NEW.claim_id) THEN
    RAISE EXCEPTION 'the claim is decided or superseded' USING ERRCODE = 'check_violation', HINT = 'execution.claim_not_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_confirmation_guard BEFORE INSERT ON trustwork.execution_confirmation FOR EACH ROW EXECUTE FUNCTION trustwork.execution_confirmation_guard();

-- Disputes: opened by the party a confirmation or a defect went against (the claimant of a decided claim, the subject
-- of a defect), once per target. Parties may only appeal a decision; decisions are written by the owner-run staff
-- commands below (the runtime role has no grant on the decision columns).
CREATE FUNCTION trustwork.execution_dispute_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_person uuid;
  v_company uuid;
  v_agreement uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disputes are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.opened_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.status <> 'open' OR NEW.decided_by IS NOT NULL OR NEW.appealed_by_person_id IS NOT NULL THEN
      RAISE EXCEPTION 'a dispute is opened by the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
    END IF;
    IF NEW.target_kind = 'confirmation' THEN
      SELECT c.claimant_person_id, c.claimant_company_id, f.agreement_id INTO v_person, v_company, v_agreement
        FROM trustwork.execution_confirmation f JOIN trustwork.execution_claim c ON c.id = f.claim_id WHERE f.id = NEW.target_id;
    ELSE
      SELECT d.subject_person_id, d.subject_company_id, d.agreement_id INTO v_person, v_company, v_agreement FROM trustwork.execution_defect d WHERE d.id = NEW.target_id;
    END IF;
    IF v_agreement IS DISTINCT FROM NEW.agreement_id OR trustwork.agreement_side(NEW.agreement_id) IS NULL THEN
      RAISE EXCEPTION 'no such record for the caller' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_found';
    END IF;
    IF NOT trustwork.execution_same_party(NEW.opener_person_id, NEW.opener_company_id, v_person, v_company)
       OR NOT trustwork.commerce_party_acts(NEW.opener_person_id, NEW.opener_company_id, 'company.deals.manage') THEN
      RAISE EXCEPTION 'the party the record went against disputes it' USING ERRCODE = 'insufficient_privilege', HINT = 'execution.not_authorised';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.agreement_id, NEW.hub_id, NEW.target_kind, NEW.target_id, NEW.opened_by_person_id, NEW.opener_person_id, NEW.opener_company_id, NEW.reason, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.agreement_id, OLD.hub_id, OLD.target_kind, OLD.target_id, OLD.opened_by_person_id, OLD.opener_person_id, OLD.opener_company_id, OLD.reason, OLD.created_at)
     OR (OLD.decided_by IS NOT NULL AND ROW(NEW.decision, NEW.decided_by, NEW.decided_at, NEW.decision_reason) IS DISTINCT FROM ROW(OLD.decision, OLD.decided_by, OLD.decided_at, OLD.decision_reason))
     OR (OLD.appealed_by_person_id IS NOT NULL AND ROW(NEW.appealed_by_person_id, NEW.appeal_reason, NEW.appealed_at) IS DISTINCT FROM ROW(OLD.appealed_by_person_id, OLD.appeal_reason, OLD.appealed_at)) THEN
    RAISE EXCEPTION 'a dispute and its decisions are never rewritten' USING ERRCODE = 'integrity_constraint_violation', HINT = 'execution.dispute_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status = 'decided')
    OR (OLD.status = 'decided' AND NEW.status = 'appealed' AND NEW.appealed_by_person_id = trustwork.current_person_id() AND trustwork.agreement_side(OLD.agreement_id) IS NOT NULL)
    OR (OLD.status = 'appealed' AND NEW.status = 'appeal_decided')
  ) THEN
    RAISE EXCEPTION 'dispute transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'execution.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_dispute_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.execution_dispute FOR EACH ROW EXECUTE FUNCTION trustwork.execution_dispute_guard();

-- Reviews: a person acting for one party of a completed agreement reviews the other party, once per side (a later
-- correction names the original); never oneself; never twice for a task already reviewed through TASK-001.
CREATE FUNCTION trustwork.review_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_agreement trustwork.agreement%ROWTYPE;
  v_original trustwork.review%ROWTYPE;
BEGIN
  IF NEW.written_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the writer is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'trust.not_authorised';
  END IF;
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = NEW.agreement_id;
  IF v_agreement.id IS NULL OR trustwork.agreement_side(NEW.agreement_id) IS NULL THEN
    RAISE EXCEPTION 'no such agreement for the caller' USING ERRCODE = 'insufficient_privilege', HINT = 'trust.not_found';
  END IF;
  IF trustwork.execution_party_side(v_agreement, NEW.author_person_id, NEW.author_company_id) IS DISTINCT FROM NEW.author_side
     OR NOT trustwork.commerce_party_acts(NEW.author_person_id, NEW.author_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'a party reviews for its own side' USING ERRCODE = 'insufficient_privilege', HINT = 'trust.not_authorised';
  END IF;
  IF NOT ((NEW.author_side = 'buyer' AND trustwork.execution_same_party(NEW.subject_person_id, NEW.subject_company_id, v_agreement.seller_person_id, v_agreement.seller_company_id))
       OR (NEW.author_side = 'seller' AND trustwork.execution_same_party(NEW.subject_person_id, NEW.subject_company_id, v_agreement.buyer_person_id, v_agreement.buyer_company_id))) THEN
    RAISE EXCEPTION 'a review is about the other party' USING ERRCODE = 'check_violation', HINT = 'trust.not_authorised';
  END IF;
  IF trustwork.commerce_party_acts(NEW.subject_person_id, NEW.subject_company_id, 'company.deals.manage') OR NEW.written_by_person_id IS NOT DISTINCT FROM NEW.subject_person_id
     OR (NEW.subject_company_id IS NOT NULL AND NEW.subject_company_id IS NOT DISTINCT FROM trustwork.current_company_id()) THEN
    RAISE EXCEPTION 'nobody reviews their own side' USING ERRCODE = 'insufficient_privilege', HINT = 'trust.self_review';
  END IF;
  IF NOT trustwork.execution_agreement_completed(NEW.agreement_id) THEN
    RAISE EXCEPTION 'reviews follow completed work' USING ERRCODE = 'check_violation', HINT = 'trust.review_not_allowed';
  END IF;
  IF v_agreement.terms_kind = 'task' AND EXISTS (
    SELECT 1 FROM trustwork.task_review tr JOIN trustwork.task_assignment t ON t.id = tr.assignment_id
    WHERE t.agreement_id = NEW.agreement_id AND tr.author_side = CASE NEW.author_side WHEN 'buyer' THEN 'owner' ELSE 'assignee' END
  ) THEN
    RAISE EXCEPTION 'this side already reviewed the task' USING ERRCODE = 'unique_violation', HINT = 'trust.review_exists';
  END IF;
  IF NEW.corrects_review_id IS NOT NULL THEN
    SELECT * INTO v_original FROM trustwork.review WHERE id = NEW.corrects_review_id;
    IF v_original.agreement_id IS DISTINCT FROM NEW.agreement_id OR v_original.author_side IS DISTINCT FROM NEW.author_side THEN
      RAISE EXCEPTION 'a correction names a review of the same side' USING ERRCODE = 'check_violation', HINT = 'trust.not_authorised';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_guard BEFORE INSERT ON trustwork.review FOR EACH ROW EXECUTE FUNCTION trustwork.review_guard();

-- A public response by the reviewed party (once): it answers a review, it never removes it.
CREATE FUNCTION trustwork.review_response_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_review trustwork.review%ROWTYPE;
BEGIN
  SELECT * INTO v_review FROM trustwork.review WHERE id = NEW.review_id;
  IF NEW.written_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR v_review.id IS NULL OR v_review.agreement_id <> NEW.agreement_id
     OR NOT trustwork.execution_same_party(NEW.responder_person_id, NEW.responder_company_id, v_review.subject_person_id, v_review.subject_company_id)
     OR NOT trustwork.commerce_party_acts(NEW.responder_person_id, NEW.responder_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'the reviewed party responds' USING ERRCODE = 'insufficient_privilege', HINT = 'trust.not_authorised';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_response_guard BEFORE INSERT ON trustwork.review_response FOR EACH ROW EXECUTE FUNCTION trustwork.review_response_guard();

-- Snapshots: computed by a person acting for the subject (the worker path is a later slice).
CREATE FUNCTION trustwork.reputation_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.computed_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NOT trustwork.commerce_party_acts(NEW.subject_person_id, NEW.subject_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'a snapshot is computed for the subject the principal acts for' USING ERRCODE = 'insufficient_privilege', HINT = 'trust.not_authorised';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reputation_snapshot_guard BEFORE INSERT ON trustwork.reputation_snapshot FOR EACH ROW EXECUTE FUNCTION trustwork.reputation_snapshot_guard();

-- 13. Staff commands: disputes decided by a trust reviewer, appeals by a different reviewer (DATA-002 plumbing) -------
CREATE FUNCTION trustwork.execution_decide_dispute(p_ctx jsonb, p_dispute_id uuid, p_decision text) RETURNS trustwork.execution_dispute
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.execution_dispute%ROWTYPE;
  v_row trustwork.execution_dispute%ROWTYPE;
  v_agreement trustwork.agreement%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_before FROM trustwork.execution_dispute WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such dispute' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.trust.evidence.decide'], NULL, v_before.hub_id);
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = v_before.agreement_id;
  IF trustwork.admin_conflicted(v_actor.person_id, v_agreement.buyer_person_id, v_agreement.buyer_company_id)
     OR trustwork.admin_conflicted(v_actor.person_id, v_agreement.seller_person_id, v_agreement.seller_company_id) THEN
    RAISE EXCEPTION 'staff never decide disputes of their own, their employer or declared parties' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  IF v_before.status <> 'open' THEN
    RAISE EXCEPTION 'the dispute is already %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('upheld', 'overturned', 'partially') THEN
    RAISE EXCEPTION 'decision is upheld, overturned or partially' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  UPDATE trustwork.execution_dispute SET status = 'decided', decision = p_decision, decided_by = v_actor.person_id, decided_at = now(), decision_reason = p_ctx ->> 'reasonText'
   WHERE id = p_dispute_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'trust.dispute.decide', 'execution_dispute', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.execution_decide_dispute_appeal(p_ctx jsonb, p_dispute_id uuid, p_decision text) RETURNS trustwork.execution_dispute
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.execution_dispute%ROWTYPE;
  v_row trustwork.execution_dispute%ROWTYPE;
  v_agreement trustwork.agreement%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_before FROM trustwork.execution_dispute WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such dispute' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.trust.appeals.decide'], NULL, v_before.hub_id);
  IF v_actor.person_id = v_before.decided_by THEN
    RAISE EXCEPTION 'an appeal is decided by someone other than the original decider' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.same_decider';
  END IF;
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = v_before.agreement_id;
  IF trustwork.admin_conflicted(v_actor.person_id, v_agreement.buyer_person_id, v_agreement.buyer_company_id)
     OR trustwork.admin_conflicted(v_actor.person_id, v_agreement.seller_person_id, v_agreement.seller_company_id) THEN
    RAISE EXCEPTION 'staff never decide appeals of their own, their employer or declared parties' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  IF v_before.status <> 'appealed' THEN
    RAISE EXCEPTION 'the dispute is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('upheld', 'overturned', 'partially_overturned') THEN
    RAISE EXCEPTION 'decision is upheld, overturned or partially_overturned' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  UPDATE trustwork.execution_dispute SET status = 'appeal_decided', appeal_decision = p_decision, appeal_decided_by = v_actor.person_id, appeal_decided_at = now(),
         appeal_decision_reason = p_ctx ->> 'reasonText'
   WHERE id = p_dispute_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'trust.dispute.appeal_decide', 'execution_dispute', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- 14. Appeals of reviews and observations (filed into DATA-002 `appeal`, decided by admin_decide_appeal) -------------
-- The reviewed or observed party appeals; the original decider is the review's writer or the observation's confirmer,
-- so admin_decide_appeal refuses them as reviewers.
CREATE FUNCTION trustwork.trust_file_appeal(p_hub_id uuid, p_subject_kind text, p_subject_id uuid, p_reason text) RETURNS trustwork.appeal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_subject_person uuid;
  v_subject_company uuid;
  v_decider uuid;
  v_row trustwork.appeal%ROWTYPE;
BEGIN
  IF p_subject_kind = 'review' THEN
    SELECT r.subject_person_id, r.subject_company_id, r.written_by_person_id INTO v_subject_person, v_subject_company, v_decider FROM trustwork.review r WHERE r.id = p_subject_id;
  ELSIF p_subject_kind = 'performance_observation' THEN
    SELECT o.subject_person_id, o.subject_company_id, o.decided_by_person_id INTO v_subject_person, v_subject_company, v_decider FROM trustwork.performance_observation o WHERE o.id = p_subject_id;
  ELSE
    RAISE EXCEPTION 'this module files appeals on reviews and observations' USING ERRCODE = 'feature_not_supported', HINT = 'trust.appeal_kind';
  END IF;
  IF v_decider IS NULL OR NOT trustwork.commerce_party_acts(v_subject_person, v_subject_company, 'company.deals.manage') THEN
    RAISE EXCEPTION 'no such record about the caller' USING ERRCODE = 'no_data_found', HINT = 'trust.not_found';
  END IF;
  INSERT INTO trustwork.appeal (hub_id, subject_kind, subject_id, appellant_person_id, appellant_company_id, reason, original_decided_by)
  VALUES (p_hub_id, p_subject_kind, p_subject_id, v_person, v_subject_company, p_reason, v_decider) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- The live appeal status of reviews or observations the caller is a party to (NULL rows are omitted).
CREATE FUNCTION trustwork.trust_appeal_states(p_subject_kind text, p_subject_ids uuid[]) RETURNS TABLE (subject_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT a.subject_id, a.status FROM trustwork.appeal a
  WHERE a.subject_kind = p_subject_kind AND a.subject_id = ANY (p_subject_ids) AND a.status <> 'withdrawn'
    AND p_subject_kind IN ('review', 'performance_observation')
    AND trustwork.agreement_side(CASE p_subject_kind
          WHEN 'review' THEN (SELECT r.agreement_id FROM trustwork.review r WHERE r.id = a.subject_id)
          ELSE (SELECT o.agreement_id FROM trustwork.performance_observation o WHERE o.id = a.subject_id) END) IS NOT NULL
$$;

-- 15. Public reads ----------------------------------------------------------------------------------------------------
-- The latest public summary of a subject (anyone, signed in or not): the masked counts only, with the method version
-- and whether evidence about the subject arrived after it was computed. Never the explanation or any evidence.
CREATE FUNCTION trustwork.trust_public_snapshot(p_person_id uuid, p_company_id uuid)
RETURNS TABLE (id uuid, method_version text, method_digest text, public_summary jsonb, computed_at timestamptz, newer_evidence boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT s.id, s.method_version, s.method_digest, s.public_summary, s.computed_at,
    EXISTS (SELECT 1 FROM trustwork.performance_observation o WHERE trustwork.execution_same_party(o.subject_person_id, o.subject_company_id, p_person_id, p_company_id) AND o.created_at > s.computed_at)
    OR EXISTS (SELECT 1 FROM trustwork.review r WHERE trustwork.execution_same_party(r.subject_person_id, r.subject_company_id, p_person_id, p_company_id) AND r.created_at > s.computed_at)
    OR EXISTS (SELECT 1 FROM trustwork.execution_defect d WHERE trustwork.execution_same_party(d.subject_person_id, d.subject_company_id, p_person_id, p_company_id) AND d.created_at > s.computed_at)
  FROM trustwork.reputation_snapshot s
  WHERE num_nonnulls(p_person_id, p_company_id) = 1 AND trustwork.execution_same_party(s.subject_person_id, s.subject_company_id, p_person_id, p_company_id)
  ORDER BY s.computed_at DESC, s.id DESC
  LIMIT 1
$$;

-- 16. Row-level security ----------------------------------------------------------------------------------------------
ALTER TABLE trustwork.execution_defect ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.execution_defect FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.execution_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.execution_claim FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.execution_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.execution_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.execution_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.execution_confirmation FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.execution_dispute ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.execution_dispute FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.performance_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.performance_observation FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.review ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.review FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.review_response ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.review_response FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.reputation_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.reputation_snapshot FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.execution_defect AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.execution_claim AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.execution_evidence AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.execution_confirmation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.execution_dispute AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.performance_observation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.review AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.review_response AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.reputation_snapshot AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- The two parties of the agreement read and write its execution records; nobody else, staff included (a dispute's
-- evidence reaches a reviewer only through a DATA-002 case access grant).
CREATE POLICY execution_defect_read ON trustwork.execution_defect FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY execution_defect_insert ON trustwork.execution_defect FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY execution_claim_read ON trustwork.execution_claim FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY execution_claim_insert ON trustwork.execution_claim FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY execution_evidence_read ON trustwork.execution_evidence FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY execution_evidence_insert ON trustwork.execution_evidence FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY execution_confirmation_read ON trustwork.execution_confirmation FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY execution_confirmation_insert ON trustwork.execution_confirmation FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);
-- Disputes: the parties, and trust reviewers of the dispute's hub (the case itself, not the private records behind it).
CREATE POLICY execution_dispute_read ON trustwork.execution_dispute FOR SELECT TO trustwork_app
  USING (trustwork.agreement_side(agreement_id) IS NOT NULL OR trustwork.admin_has_any_permission(ARRAY['admin.trust.evidence.decide', 'admin.trust.appeals.decide'], NULL, hub_id));
CREATE POLICY execution_dispute_insert ON trustwork.execution_dispute FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY execution_dispute_update ON trustwork.execution_dispute FOR UPDATE TO trustwork_app
  USING (trustwork.agreement_side(agreement_id) IS NOT NULL) WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY performance_observation_read ON trustwork.performance_observation FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY review_read ON trustwork.review FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY review_insert ON trustwork.review FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY review_response_read ON trustwork.review_response FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY review_response_insert ON trustwork.review_response FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);
-- Snapshots with their explanation: the subject only; the public reads the masked summary through trust_public_snapshot.
CREATE POLICY reputation_snapshot_read ON trustwork.reputation_snapshot FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(subject_person_id, subject_company_id, 'company.deals.manage'));
CREATE POLICY reputation_snapshot_insert ON trustwork.reputation_snapshot FOR INSERT TO trustwork_app
  WITH CHECK (trustwork.commerce_party_acts(subject_person_id, subject_company_id, 'company.deals.manage'));

-- 17. Grants ----------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON trustwork.execution_defect, trustwork.execution_claim, trustwork.execution_evidence, trustwork.execution_confirmation, trustwork.execution_dispute,
  trustwork.review, trustwork.review_response, trustwork.reputation_snapshot TO trustwork_app;
GRANT SELECT ON trustwork.performance_observation TO trustwork_app;
GRANT UPDATE (status, appealed_by_person_id, appeal_reason, appealed_at) ON trustwork.execution_dispute TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.execution_same_party(uuid, uuid, uuid, uuid), trustwork.execution_party_side(trustwork.agreement, uuid, uuid), trustwork.execution_lock(text, uuid),
  trustwork.execution_claim_open(uuid), trustwork.execution_agreement_completed(uuid), trustwork.execution_artifact_digest(uuid, uuid), trustwork.execution_timing_facts(uuid),
  trustwork.execution_observe(uuid), trustwork.execution_decide_dispute(jsonb, uuid, text), trustwork.execution_decide_dispute_appeal(jsonb, uuid, text),
  trustwork.trust_file_appeal(uuid, text, uuid, text), trustwork.trust_appeal_states(text, uuid[]), trustwork.trust_public_snapshot(uuid, uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
