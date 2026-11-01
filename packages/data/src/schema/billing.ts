import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Billing module (BILL-001, packages/data/migrations/billing): offers and versioned prices, immutable acceptances,
 * subscriptions and entitlements, meters and meter rates, marketplace fee versions, usage records, the two budget
 * kinds with atomic reservations, an append-only balanced ledger and capped credit grants.
 *
 * Money columns are PostgreSQL `bigint` minor units. `pg` returns int8 as a string and the model keeps it a string:
 * no JavaScript number ever carries money.
 */
export type MinorUnits = ColumnType<string, string | bigint, string | bigint>;
export type BudgetKindColumn = 'transaction' | 'platform';
export type VersionStatus = 'draft' | 'active' | 'superseded' | 'cancelled';
export type OfferKind = 'plan' | 'deliverable' | 'credit_pack' | 'marketplace_fee' | 'verification_fee' | 'agent_module';
export type MeterCode = 'model_tokens' | 'agent_actions' | 'checks' | 'document_pages' | 'deliverables' | 'translation_characters' | 'retrieval_queries' | 'external_calls';
export type ProviderClass = 'local' | 'in_country' | 'hosted_external';
export type ReservationStateColumn = 'reserved' | 'settled' | 'released' | 'expired';
export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'cancelled' | 'ended';
export type EntitlementSource = 'free_basic' | 'trial' | 'subscription' | 'credit' | 'sponsorship';
export type LedgerEntryKind = 'settlement' | 'refund' | 'correction' | 'credit';
export type LedgerAccountKind = 'budget' | 'billing_account' | 'hub_revenue' | 'commitment';
type Json = ColumnType<unknown, string, string>;
type Revision = Generated<number>;

export interface MeterTable { code: MeterCode; unit: string; description_key: string; created_at: GeneratedTimestamp }
export interface BillingAccountTable {
  id: GeneratedUuid; hub_id: string; owner_person_id: string | null; owner_company_id: string | null; currency: string; tax_registration_id: string | null;
  billing_address: Json | null; status: Generated<'active' | 'closed'>; created_by: string; revision: Revision; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp;
}
export interface OfferTable {
  id: GeneratedUuid; hub_id: string; code: string; name: string; kind: OfferKind; status: Generated<'draft' | 'active' | 'retired'>; created_by: string;
  revision: Revision; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp;
}
interface VersionColumns {
  status: Generated<VersionStatus>; drafted_by: string; activated_by: string | null; activated_at: Timestamp | null;
  revision: Revision; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp;
}
export interface PriceVersionTable extends VersionColumns {
  id: GeneratedUuid; offer_id: string; version: number; amount_minor: MinorUnits; currency: string; effective_from: Timestamp; effective_to: Timestamp | null;
  acceptance_text_version: string; tax_rule_ref: string | null;
}
export interface SubscriptionPlanVersionTable extends VersionColumns {
  id: GeneratedUuid; offer_id: string; version: number; payer_kind: 'person' | 'company'; payload: Json; price_version_id: string;
}
export interface MeterRateVersionTable extends VersionColumns {
  id: GeneratedUuid; hub_id: string; version: number; meter: MeterCode; provider_class: ProviderClass | null; currency: string; price_per_thousand_minor: MinorUnits;
  pass_through: boolean; effective_from: Timestamp; effective_to: Timestamp | null;
}
export interface MarketplaceFeeVersionTable extends VersionColumns {
  id: GeneratedUuid; hub_id: string; kind: 'consultation' | 'task' | 'ticket' | 'course'; category_key: string | null; version: number; currency: string;
  basis_points: number | null; fixed_minor: MinorUnits | null; payer: 'buyer' | 'seller'; effective_from: Timestamp; effective_to: Timestamp | null;
  acceptance_text_version: string; approval_id: string | null;
}
export interface PriceAcceptanceTable {
  id: GeneratedUuid; price_version_id: string; acceptance_text_version: string; billing_account_id: string; payer_person_id: string | null; payer_company_id: string | null;
  accepted_by_person_id: string; accepted_at: GeneratedTimestamp; amount_minor: MinorUnits; currency: string;
}
export interface SubscriptionTable {
  id: GeneratedUuid; billing_account_id: string; offer_id: string; subscription_plan_version_id: string | null; price_version_id: string; price_acceptance_id: string;
  status: SubscriptionStatus; current_period_start: Timestamp; current_period_end: Timestamp; renews_at: Timestamp | null; cancelled_at: Timestamp | null;
  cancelled_by: string | null; revision: Revision; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp;
}
export interface EntitlementTable {
  id: GeneratedUuid; billing_account_id: string; offer_id: string; subscription_id: string | null; module_code: string | null; limits: ColumnType<unknown, string | undefined, string>;
  valid_from: Timestamp; valid_until: Timestamp | null; source: EntitlementSource; revoked_at: Timestamp | null; revoked_reason: string | null;
  revision: Revision; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp;
}
export interface BudgetTable {
  id: GeneratedUuid; kind: BudgetKindColumn; owner_person_id: string | null; owner_company_id: string | null; project_id: string | null; employee_person_id: string | null;
  period_from: Timestamp; period_to: Timestamp; limit_minor: MinorUnits; currency: string; status: Generated<'active' | 'closed'>; granted_by: string;
  closed_at: Timestamp | null; closed_by: string | null; revision: Revision; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp;
}
export interface ReservationTable {
  effect_pending: Generated<boolean>;
  id: GeneratedUuid; budget_id: string; action_intent_id: string; project_id: string | null; amount_minor: MinorUnits; currency: string; state: Generated<ReservationStateColumn>;
  settled_minor: MinorUnits | null; refunded_minor: ColumnType<string, string | bigint | undefined, string | bigint>; reserved_by: string; reserved_at: GeneratedTimestamp;
  expires_at: Timestamp; closed_at: Timestamp | null; evidence_ref: string | null; effect_correlation_key: string; revision: Revision; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp;
}
export interface LedgerEntryTable {
  id: GeneratedUuid; batch_id: string; entry_kind: LedgerEntryKind; account_kind: LedgerAccountKind; account_id: string | null; owner_person_id: string | null; owner_company_id: string | null;
  amount_minor: MinorUnits; currency: string; reservation_id: string | null; payment_id: string | null; credit_grant_id: string | null; correcting_entry_of: string | null;
  reason: string | null; occurred_at: GeneratedTimestamp;
}
export interface UsageRecordTable {
  id: GeneratedUuid; principal_person_id: string | null; principal_company_id: string | null; billing_account_id: string; module_key: string; capability_id: string | null;
  run_id: string; run_step_id: string; attempt_id: string; connection_id: string | null; meter: MeterCode; provider_class: ProviderClass | null; units: MinorUnits;
  within_included_quota: boolean; meter_rate_version_id: string | null; reservation_id: string | null; recorded_at: GeneratedTimestamp;
}
export interface CreditGrantTable {
  id: GeneratedUuid; billing_account_id: string; amount_minor: MinorUnits; currency: string; reason_code: string; issued_by: string; cap_check: Json; case_id: string | null;
  valid_until: Timestamp | null; expiry_disclosure_key: string | null; created_at: GeneratedTimestamp;
}

export type BillingAccountRow = Selectable<BillingAccountTable>;
export type OfferRow = Selectable<OfferTable>;
export type PriceVersionRow = Selectable<PriceVersionTable>;
export type SubscriptionPlanVersionRow = Selectable<SubscriptionPlanVersionTable>;
export type MeterRateVersionRow = Selectable<MeterRateVersionTable>;
export type MarketplaceFeeVersionRow = Selectable<MarketplaceFeeVersionTable>;
export type PriceAcceptanceRow = Selectable<PriceAcceptanceTable>;
export type SubscriptionRow = Selectable<SubscriptionTable>;
export type EntitlementRow = Selectable<EntitlementTable>;
export type BudgetRow = Selectable<BudgetTable>;
export type ReservationRow = Selectable<ReservationTable>;
export type LedgerEntryRow = Selectable<LedgerEntryTable>;
export type UsageRecordRow = Selectable<UsageRecordTable>;
export type CreditGrantRow = Selectable<CreditGrantTable>;

export interface BillingDatabase {
  meter: MeterTable;
  billing_account: BillingAccountTable;
  offer: OfferTable;
  price_version: PriceVersionTable;
  subscription_plan_version: SubscriptionPlanVersionTable;
  meter_rate_version: MeterRateVersionTable;
  marketplace_fee_version: MarketplaceFeeVersionTable;
  price_acceptance: PriceAcceptanceTable;
  subscription: SubscriptionTable;
  entitlement: EntitlementTable;
  budget: BudgetTable;
  reservation: ReservationTable;
  ledger_entry: LedgerEntryTable;
  usage_record: UsageRecordTable;
  credit_grant: CreditGrantTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends BillingDatabase {}
}

const versionColumns = ['status', 'drafted_by', 'activated_by', 'activated_at', 'revision', 'created_at', 'updated_at'] as const;
const columns = columnsOf<BillingDatabase>();
export const TABLE_COLUMNS: TableColumns<BillingDatabase> = {
  meter: columns('meter', ['code', 'unit', 'description_key', 'created_at']),
  billing_account: columns('billing_account', ['id', 'hub_id', 'owner_person_id', 'owner_company_id', 'currency', 'tax_registration_id', 'billing_address', 'status', 'created_by', 'revision', 'created_at', 'updated_at']),
  offer: columns('offer', ['id', 'hub_id', 'code', 'name', 'kind', 'status', 'created_by', 'revision', 'created_at', 'updated_at']),
  price_version: columns('price_version', ['id', 'offer_id', 'version', 'amount_minor', 'currency', 'effective_from', 'effective_to', 'acceptance_text_version', 'tax_rule_ref', ...versionColumns]),
  subscription_plan_version: columns('subscription_plan_version', ['id', 'offer_id', 'version', 'payer_kind', 'payload', 'price_version_id', ...versionColumns]),
  meter_rate_version: columns('meter_rate_version', ['id', 'hub_id', 'version', 'meter', 'provider_class', 'currency', 'price_per_thousand_minor', 'pass_through', 'effective_from', 'effective_to', ...versionColumns]),
  marketplace_fee_version: columns('marketplace_fee_version', ['id', 'hub_id', 'kind', 'category_key', 'version', 'currency', 'basis_points', 'fixed_minor', 'payer', 'effective_from', 'effective_to', 'acceptance_text_version', 'approval_id', ...versionColumns]),
  price_acceptance: columns('price_acceptance', ['id', 'price_version_id', 'acceptance_text_version', 'billing_account_id', 'payer_person_id', 'payer_company_id', 'accepted_by_person_id', 'accepted_at', 'amount_minor', 'currency']),
  subscription: columns('subscription', ['id', 'billing_account_id', 'offer_id', 'subscription_plan_version_id', 'price_version_id', 'price_acceptance_id', 'status', 'current_period_start', 'current_period_end', 'renews_at', 'cancelled_at', 'cancelled_by', 'revision', 'created_at', 'updated_at']),
  entitlement: columns('entitlement', ['id', 'billing_account_id', 'offer_id', 'subscription_id', 'module_code', 'limits', 'valid_from', 'valid_until', 'source', 'revoked_at', 'revoked_reason', 'revision', 'created_at', 'updated_at']),
  budget: columns('budget', ['id', 'kind', 'owner_person_id', 'owner_company_id', 'project_id', 'employee_person_id', 'period_from', 'period_to', 'limit_minor', 'currency', 'status', 'granted_by', 'closed_at', 'closed_by', 'revision', 'created_at', 'updated_at']),
  reservation: columns('reservation', ['effect_pending', 'id', 'budget_id', 'action_intent_id', 'project_id', 'amount_minor', 'currency', 'state', 'settled_minor', 'refunded_minor', 'reserved_by', 'reserved_at', 'expires_at', 'closed_at', 'evidence_ref', 'effect_correlation_key', 'revision', 'created_at', 'updated_at']),
  ledger_entry: columns('ledger_entry', ['id', 'batch_id', 'entry_kind', 'account_kind', 'account_id', 'owner_person_id', 'owner_company_id', 'amount_minor', 'currency', 'reservation_id', 'payment_id', 'credit_grant_id', 'correcting_entry_of', 'reason', 'occurred_at']),
  usage_record: columns('usage_record', ['id', 'principal_person_id', 'principal_company_id', 'billing_account_id', 'module_key', 'capability_id', 'run_id', 'run_step_id', 'attempt_id', 'connection_id', 'meter', 'provider_class', 'units', 'within_included_quota', 'meter_rate_version_id', 'reservation_id', 'recorded_at']),
  credit_grant: columns('credit_grant', ['id', 'billing_account_id', 'amount_minor', 'currency', 'reason_code', 'issued_by', 'cap_check', 'case_id', 'valid_until', 'expiry_disclosure_key', 'created_at']),
};
