import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Agent goals, job subscriptions, reports, agent-to-agent envelopes, negotiation sessions, the company representative and
 * company mandates (AGT-001, packages/data/migrations/agents). Every table is under FORCE RLS. Goals, progress, job
 * subscriptions and reports belong to their principal; envelopes and sessions are visible to the two parties of their
 * context; receipts, escalations and the sender's mandate reference only to their own party. State changes go through
 * the owner-run commands of the migration.
 */
export type GoalStatusValue = 'proposed' | 'active' | 'paused' | 'closed';
export type GoalOutcomeValue = 'achieved' | 'partly' | 'abandoned';
export type PartyKindValue = 'person' | 'company';
export type RepresentativeStatusValue = 'pending_acceptance' | 'active' | 'suspended' | 'disabled';
export type RepresentativeSuspensionValue = 'no_accountable_person' | 'no_confirmed_mandate' | 'admin_suspended';
export type CompanyMandateStatusValue = 'active' | 'awaiting_reconfirmation' | 'suspended' | 'revoked';
export type NegotiationStatusValue = 'open' | 'agreed_pending_confirmation' | 'escalated' | 'declined' | 'withdrawn' | 'expired';
export type ReceiptDecisionValue = 'informational' | 'within_mandate' | 'escalated';
export type EscalationStatusValue = 'open' | 'resolved' | 'dismissed';
/** jsonb: read as parsed JSON, written as a JSON string. */
type Jsonb = ColumnType<unknown, string, string>;
type JsonbDefault = ColumnType<unknown, string | undefined, string>;

export interface GoalTable {
  id: GeneratedUuid;
  principal_person_id: string;
  on_behalf_company_id: string | null;
  text: string;
  success_criteria: Jsonb;
  allowed_actions: string[];
  needs: Jsonb;
  budget_range: ColumnType<unknown, string | null, string | null>;
  horizon: Timestamp;
  report_cadence: 'none' | 'daily' | 'weekly' | 'monthly';
  status: Generated<GoalStatusValue>;
  outcome: GoalOutcomeValue | null;
  proposed_by: 'principal' | 'agent' | 'connection';
  covered: JsonbDefault;
  proposal_ids: Generated<string[]>;
  mandate_ids: Generated<string[]>;
  confirmation_digest: string;
  confirmed_by_person_id: string | null;
  confirmed_at: Timestamp | null;
  confirmed_step_up: boolean | null;
  closed_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface GoalProgressTable {
  id: GeneratedUuid;
  goal_id: string;
  event_kind: string;
  evidence_refs: JsonbDefault;
  detail: JsonbDefault;
  recorded_by_person_id: string;
  at: GeneratedTimestamp;
}
export interface JobSubscriptionTable {
  id: GeneratedUuid;
  principal_person_id: string;
  on_behalf_company_id: string | null;
  module_key: string;
  job_template_key: string;
  trigger: Jsonb;
  goal_id: string | null;
  mandate_id: string | null;
  status: Generated<'active' | 'paused' | 'ended'>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface AgentReportTable {
  id: GeneratedUuid;
  author_person_id: string;
  principal_company_id: string | null;
  goal_id: string | null;
  run_id: string | null;
  period_from: Timestamp;
  period_to: Timestamp;
  sections: Jsonb;
  audience: Generated<'owner_private'>;
  shared_with: Generated<string[]>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface CompanyRepresentativeTable {
  id: GeneratedUuid;
  company_id: string;
  accountable_person_id: string | null;
  status: RepresentativeStatusValue;
  suspension_reason: RepresentativeSuspensionValue | null;
  enabled_by_person_id: string;
  accepted_at: Timestamp | null;
  disabled_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface RepresentativeAccountabilityTable {
  id: GeneratedUuid;
  representative_id: string;
  person_id: string;
  from_at: GeneratedTimestamp;
  to_at: Timestamp | null;
  ended_reason: 'replaced' | 'left_company' | 'authority_lost' | 'disabled' | null;
}
export interface CompanyMandateTable {
  id: GeneratedUuid;
  company_id: string;
  mandate_id: string;
  granted_by_person_id: string;
  executor_kind: 'person_agent' | 'company_representative';
  executor_person_id: string | null;
  representative_id: string | null;
  terms: Jsonb;
  terms_digest: string;
  status: Generated<CompanyMandateStatusValue>;
  status_reason: string | null;
  reconfirm_due_at: Timestamp | null;
  reconfirmed_by_person_id: string | null;
  reconfirmed_at: Timestamp | null;
  previous_mandate_ids: Generated<string[]>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface NegotiationSessionTable {
  id: GeneratedUuid;
  context_kind: 'rfq' | 'quote';
  context_id: string;
  party_a_kind: PartyKindValue;
  party_a_id: string;
  party_b_kind: PartyKindValue;
  party_b_id: string;
  max_rounds: number;
  rounds_used: Generated<number>;
  turn_kind: PartyKindValue | null;
  turn_id: string | null;
  expires_at: Timestamp;
  status: Generated<NegotiationStatusValue>;
  escalation_reason: 'rounds_exhausted' | 'expired' | 'agreement_needs_confirmation' | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface AgentEnvelopeTable {
  id: GeneratedUuid;
  session_id: string | null;
  from_kind: PartyKindValue;
  from_id: string;
  from_person_id: string | null;
  actor_kind: 'person_agent' | 'company_representative';
  actor_label_key: string;
  accountable_person_id: string | null;
  to_kind: PartyKindValue;
  to_id: string;
  context_kind: 'rfq' | 'quote';
  context_id: string;
  intent: string;
  refs: Jsonb;
  note_text: string | null;
  note_locale: string | null;
  mandate_proof: Jsonb;
  home_node: string;
  created_at: GeneratedTimestamp;
  expires_at: Timestamp;
}
export interface AgentEnvelopeSenderTable {
  envelope_id: string;
  sender_kind: PartyKindValue;
  sender_id: string;
  sent_by_person_id: string;
  mandate_id: string;
  mandate_revision: number;
  company_mandate_id: string | null;
}
export interface AgentEnvelopeReceiptTable {
  envelope_id: string;
  receiver_kind: PartyKindValue;
  receiver_id: string;
  decision: ReceiptDecisionValue;
  reason: string;
  mandate_id: string | null;
  decided_at: GeneratedTimestamp;
}
export interface AgentEscalationTable {
  id: GeneratedUuid;
  owner_kind: PartyKindValue;
  owner_id: string;
  source: string;
  envelope_id: string | null;
  session_id: string | null;
  company_mandate_id: string | null;
  context_kind: 'rfq' | 'quote' | null;
  context_id: string | null;
  intent: string | null;
  status: Generated<EscalationStatusValue>;
  resolved_by_person_id: string | null;
  resolved_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AgentsDatabase {
  goal: GoalTable;
  goal_progress: GoalProgressTable;
  job_subscription: JobSubscriptionTable;
  agent_report: AgentReportTable;
  company_representative: CompanyRepresentativeTable;
  representative_accountability: RepresentativeAccountabilityTable;
  company_mandate: CompanyMandateTable;
  negotiation_session: NegotiationSessionTable;
  agent_envelope: AgentEnvelopeTable;
  agent_envelope_sender: AgentEnvelopeSenderTable;
  agent_envelope_receipt: AgentEnvelopeReceiptTable;
  agent_escalation: AgentEscalationTable;
}

export type GoalRow = Selectable<GoalTable>;
export type GoalProgressRow = Selectable<GoalProgressTable>;
export type JobSubscriptionRow = Selectable<JobSubscriptionTable>;
export type AgentReportRow = Selectable<AgentReportTable>;
export type CompanyRepresentativeRow = Selectable<CompanyRepresentativeTable>;
export type RepresentativeAccountabilityRow = Selectable<RepresentativeAccountabilityTable>;
export type CompanyMandateRow = Selectable<CompanyMandateTable>;
export type NegotiationSessionRow = Selectable<NegotiationSessionTable>;
export type AgentEnvelopeRow = Selectable<AgentEnvelopeTable>;
export type AgentEnvelopeSenderRow = Selectable<AgentEnvelopeSenderTable>;
export type AgentEnvelopeReceiptRow = Selectable<AgentEnvelopeReceiptTable>;
export type AgentEscalationRow = Selectable<AgentEscalationTable>;

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends AgentsDatabase {}
}

const columns = columnsOf<AgentsDatabase>();
export const TABLE_COLUMNS: TableColumns<AgentsDatabase> = {
  goal: columns('goal', [
    'id', 'principal_person_id', 'on_behalf_company_id', 'text', 'success_criteria', 'allowed_actions', 'needs', 'budget_range', 'horizon', 'report_cadence', 'status', 'outcome',
    'proposed_by', 'covered', 'proposal_ids', 'mandate_ids', 'confirmation_digest', 'confirmed_by_person_id', 'confirmed_at', 'confirmed_step_up', 'closed_at', 'revision', 'created_at', 'updated_at',
  ]),
  goal_progress: columns('goal_progress', ['id', 'goal_id', 'event_kind', 'evidence_refs', 'detail', 'recorded_by_person_id', 'at']),
  job_subscription: columns('job_subscription', [
    'id', 'principal_person_id', 'on_behalf_company_id', 'module_key', 'job_template_key', 'trigger', 'goal_id', 'mandate_id', 'status', 'revision', 'created_at', 'updated_at',
  ]),
  agent_report: columns('agent_report', [
    'id', 'author_person_id', 'principal_company_id', 'goal_id', 'run_id', 'period_from', 'period_to', 'sections', 'audience', 'shared_with', 'revision', 'created_at', 'updated_at',
  ]),
  company_representative: columns('company_representative', [
    'id', 'company_id', 'accountable_person_id', 'status', 'suspension_reason', 'enabled_by_person_id', 'accepted_at', 'disabled_at', 'revision', 'created_at', 'updated_at',
  ]),
  representative_accountability: columns('representative_accountability', ['id', 'representative_id', 'person_id', 'from_at', 'to_at', 'ended_reason']),
  company_mandate: columns('company_mandate', [
    'id', 'company_id', 'mandate_id', 'granted_by_person_id', 'executor_kind', 'executor_person_id', 'representative_id', 'terms', 'terms_digest', 'status', 'status_reason',
    'reconfirm_due_at', 'reconfirmed_by_person_id', 'reconfirmed_at', 'previous_mandate_ids', 'revision', 'created_at', 'updated_at',
  ]),
  negotiation_session: columns('negotiation_session', [
    'id', 'context_kind', 'context_id', 'party_a_kind', 'party_a_id', 'party_b_kind', 'party_b_id', 'max_rounds', 'rounds_used', 'turn_kind', 'turn_id', 'expires_at', 'status',
    'escalation_reason', 'revision', 'created_at', 'updated_at',
  ]),
  agent_envelope: columns('agent_envelope', [
    'id', 'session_id', 'from_kind', 'from_id', 'from_person_id', 'actor_kind', 'actor_label_key', 'accountable_person_id', 'to_kind', 'to_id', 'context_kind', 'context_id', 'intent',
    'refs', 'note_text', 'note_locale', 'mandate_proof', 'home_node', 'created_at', 'expires_at',
  ]),
  agent_envelope_sender: columns('agent_envelope_sender', ['envelope_id', 'sender_kind', 'sender_id', 'sent_by_person_id', 'mandate_id', 'mandate_revision', 'company_mandate_id']),
  agent_envelope_receipt: columns('agent_envelope_receipt', ['envelope_id', 'receiver_kind', 'receiver_id', 'decision', 'reason', 'mandate_id', 'decided_at']),
  agent_escalation: columns('agent_escalation', [
    'id', 'owner_kind', 'owner_id', 'source', 'envelope_id', 'session_id', 'company_mandate_id', 'context_kind', 'context_id', 'intent', 'status', 'resolved_by_person_id', 'resolved_at',
    'revision', 'created_at', 'updated_at',
  ]),
};
