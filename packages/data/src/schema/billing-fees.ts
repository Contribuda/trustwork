import type { ColumnType, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns } from './index.js';

export interface FeeScopeTable {
  id: GeneratedUuid; source_kind: 'consultation' | 'task' | 'marketplace' | 'ticket' | 'course'; source_id: string; source_digest: string;
  fee_kind: 'consultation' | 'task' | 'ticket' | 'course'; category_key: string | null;
  buyer_person_id: string | null; buyer_company_id: string | null; seller_person_id: string | null; seller_company_id: string | null;
  buyer_hub_id: string; seller_hub_id: string; created_at: GeneratedTimestamp;
}
export interface FeeDisclosureTable {
  id: GeneratedUuid; scope_id: string; person_id: string; source_hub_id: string; side: 'buyer' | 'seller';
  buyer_fee_id: string; seller_fee_id: string; snapshot: ColumnType<unknown, string, never>; digest: string; created_at: GeneratedTimestamp;
}
export interface FeeConfirmationTable { id: GeneratedUuid; disclosure_id: string; person_id: string; created_at: GeneratedTimestamp }
export interface FeeBindingTable {
  id: GeneratedUuid; confirmation_id: string; booking_id: string; source_digest: string; person_id: string; source_hub_id: string;
  local_fee_id: string; counterparty_fee_id: string; created_at: GeneratedTimestamp;
}
export interface ConsultationOriginTable { source_kind: 'offering' | 'request'; source_id: string; hub_id: string; created_at: GeneratedTimestamp }
export interface TaskOriginTable { source_kind: 'request' | 'offer'; source_id: string; hub_id: string; created_at: GeneratedTimestamp }
export interface BillingFeesDatabase {
  billing_task_origin: TaskOriginTable;
  billing_consultation_origin: ConsultationOriginTable;
  billing_fee_scope: FeeScopeTable;
  billing_fee_disclosure: FeeDisclosureTable;
  billing_fee_confirmation: FeeConfirmationTable;
  billing_fee_binding: FeeBindingTable;
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module-owned table augmentation
  interface Database extends BillingFeesDatabase {}
}
export type FeeScopeRow = Selectable<FeeScopeTable>;
const columns = columnsOf<BillingFeesDatabase>();
export const TABLE_COLUMNS: TableColumns<BillingFeesDatabase> = {
  billing_task_origin: columns('billing_task_origin', ['source_kind','source_id','hub_id','created_at']),
  billing_consultation_origin: columns('billing_consultation_origin', ['source_kind','source_id','hub_id','created_at']),
  billing_fee_scope: columns('billing_fee_scope', ['id', 'source_kind', 'source_id', 'source_digest', 'fee_kind', 'category_key', 'buyer_person_id', 'buyer_company_id', 'seller_person_id', 'seller_company_id', 'buyer_hub_id', 'seller_hub_id', 'created_at']),
  billing_fee_disclosure: columns('billing_fee_disclosure', ['id', 'scope_id', 'person_id', 'source_hub_id', 'side', 'buyer_fee_id', 'seller_fee_id', 'snapshot', 'digest', 'created_at']),
  billing_fee_confirmation: columns('billing_fee_confirmation', ['id', 'disclosure_id', 'person_id', 'created_at']),
  billing_fee_binding: columns('billing_fee_binding', ['id', 'confirmation_id', 'booking_id', 'source_digest', 'person_id', 'source_hub_id', 'local_fee_id', 'counterparty_fee_id', 'created_at']),
};
