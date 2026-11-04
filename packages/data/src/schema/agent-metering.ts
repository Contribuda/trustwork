import type { ColumnType, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';
import type { MeterCode } from './billing.js';

/**
 * Agent usage prices (AGT-004, packages/data/migrations/billing). `*_micro` columns are `bigint` millionths of a minor
 * unit and stay strings: no JavaScript number and no decimal column ever carries a price.
 */
type Micro = ColumnType<string, string | bigint, string | bigint>;
export type MeteredSubjectKind = 'module' | 'capability' | 'model' | 'meter';
export type MeteredUnit = 'thousand_tokens' | 'action' | 'deliverable' | 'api_call';
export type CostBasis = 'model_list_price' | 'measured_average' | 'contract';

export interface MeteredSubjectTable {
  id: GeneratedUuid; hub_id: string; offer_id: string; kind: MeteredSubjectKind; subject_key: string; direction: 'input' | 'output' | null; meter: MeterCode; unit: MeteredUnit;
  created_at: GeneratedTimestamp;
}
export interface MeteredCostRecordTable {
  id: GeneratedUuid; subject_id: string; version: number; currency: string; cost_micro: Micro; basis: CostBasis; observed_at: Timestamp; recorded_by: string;
  recorded_at: GeneratedTimestamp;
}
export interface MeteredPriceTermTable {
  price_version_id: string; subject_id: string; sale_micro: Micro; per_units: ColumnType<string, string | bigint, never>; basis: 'flat' | 'markup'; markup_percent: number | null;
  cost_micro: Micro; cost_basis: CostBasis; model_pricing_id: string | null; cost_record_id: string | null;
}
type BigintText = ColumnType<string, string | number | bigint, string | number | bigint>;
type StepState = 'admitted' | 'outcome_unknown' | 'succeeded' | 'failed';
export interface AgentQuotaWindowTable {
  id: GeneratedUuid; hub_id: string; principal_person_id: string | null; principal_company_id: string | null; module_key: string; meter: MeterCode; window_kind: 'day' | 'week' | 'month';
  window_start: Timestamp; window_end: Timestamp; limit_units: BigintText; used_units: BigintText; held_units: BigintText; updated_at: GeneratedTimestamp;
}
export interface MeteredStepTable {
  id: GeneratedUuid; hub_id: string; principal_person_id: string | null; principal_company_id: string | null; acting_person_id: string; billing_account_id: string; module_key: string;
  capability_id: string | null; run_id: string; run_step_id: string; attempt_id: string; connection_id: string | null; meter: MeterCode; provider_class: string | null; model_key: string | null;
  source_kind: 'model_call' | 'action_intent' | 'direct'; source_ref: string; plan_version_id: string | null; window_ids: string[]; estimated_units: BigintText; within_units: BigintText; beyond_units: BigintText;
  price_version_id: string | null; output_price_version_id: string | null; reservation_id: string | null; estimate_minor: BigintText; currency: string; state: StepState; actual_units: BigintText | null;
  overrun_units: BigintText; charged_minor: BigintText; cost_minor: BigintText; usage_record_id: string | null; evidence_ref: string | null; created_at: GeneratedTimestamp; closed_at: Timestamp | null;
}
export interface AgentQuotaNoticeTable { id: GeneratedUuid; window_id: string; threshold: 80 | 100; created_at: GeneratedTimestamp }
export interface CreditPackTermTable { price_version_id: string; credits_minor: BigintText; validity_days: number | null; reminder_days: number | null; refund_policy_version: number }
export interface AgentCreditLotTable {
  id: GeneratedUuid; billing_account_id: string; price_version_id: string; price_acceptance_id: string; funded_minor: BigintText; remaining_minor: BigintText; currency: string; valid_until: Timestamp | null;
  reminder_days: number | null; notice_sent_at: Timestamp | null; evidence_ref: string; created_at: GeneratedTimestamp;
}
export interface AgentCreditUseTable { id: GeneratedUuid; lot_id: string; run_step_id: string; kind: 'consume' | 'restore'; amount_minor: BigintText; created_at: GeneratedTimestamp }
export interface AgentMeteringDatabase {
  metered_subject: MeteredSubjectTable;
  metered_cost_record: MeteredCostRecordTable;
  metered_price_term: MeteredPriceTermTable;
  agent_quota_window: AgentQuotaWindowTable;
  metered_step: MeteredStepTable;
  agent_quota_notice: AgentQuotaNoticeTable;
  credit_pack_term: CreditPackTermTable;
  agent_credit_lot: AgentCreditLotTable;
  agent_credit_use: AgentCreditUseTable;
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module-owned table augmentation
  interface Database extends AgentMeteringDatabase {}
}
export type MeteredSubjectRow = Selectable<MeteredSubjectTable>;
export type MeteredPriceTermRow = Selectable<MeteredPriceTermTable>;

const columns = columnsOf<AgentMeteringDatabase>();
export const TABLE_COLUMNS: TableColumns<AgentMeteringDatabase> = {
  metered_subject: columns('metered_subject', ['id', 'hub_id', 'offer_id', 'kind', 'subject_key', 'direction', 'meter', 'unit', 'created_at']),
  metered_cost_record: columns('metered_cost_record', ['id', 'subject_id', 'version', 'currency', 'cost_micro', 'basis', 'observed_at', 'recorded_by', 'recorded_at']),
  metered_price_term: columns('metered_price_term', ['price_version_id', 'subject_id', 'sale_micro', 'per_units', 'basis', 'markup_percent', 'cost_micro', 'cost_basis', 'model_pricing_id', 'cost_record_id']),
  agent_quota_window: columns('agent_quota_window', ['id', 'hub_id', 'principal_person_id', 'principal_company_id', 'module_key', 'meter', 'window_kind', 'window_start', 'window_end', 'limit_units', 'used_units', 'held_units', 'updated_at']),
  metered_step: columns('metered_step', ['id', 'hub_id', 'principal_person_id', 'principal_company_id', 'acting_person_id', 'billing_account_id', 'module_key', 'capability_id', 'run_id', 'run_step_id', 'attempt_id', 'connection_id', 'meter', 'provider_class', 'model_key',
    'source_kind', 'source_ref', 'plan_version_id', 'window_ids', 'estimated_units', 'within_units', 'beyond_units', 'price_version_id', 'output_price_version_id', 'reservation_id', 'estimate_minor', 'currency', 'state', 'actual_units', 'overrun_units', 'charged_minor', 'cost_minor',
    'usage_record_id', 'evidence_ref', 'created_at', 'closed_at']),
  agent_quota_notice: columns('agent_quota_notice', ['id', 'window_id', 'threshold', 'created_at']),
  credit_pack_term: columns('credit_pack_term', ['price_version_id', 'credits_minor', 'validity_days', 'reminder_days', 'refund_policy_version']),
  agent_credit_lot: columns('agent_credit_lot', ['id', 'billing_account_id', 'price_version_id', 'price_acceptance_id', 'funded_minor', 'remaining_minor', 'currency', 'valid_until', 'reminder_days', 'notice_sent_at', 'evidence_ref', 'created_at']),
  agent_credit_use: columns('agent_credit_use', ['id', 'lot_id', 'run_step_id', 'kind', 'amount_minor', 'created_at']),
};
