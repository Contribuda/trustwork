import type { ColumnType, Generated } from 'kysely';
import type { PaymentKind, PaymentState } from '../../../contracts/src/payments.js';
import { columnsOf, type TableColumns, type Timestamp, type GeneratedTimestamp } from './index.js';
type Json = ColumnType<unknown, string, string>;
export interface PaymentSourceTable {
  agreement_id: string;
  binding: Json;
  revoked_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}
export interface PaymentRailTable {
  connection_id: string;
  currencies: string[];
  countries: string[];
  rails: string[];
  capabilities: string[];
  custody: 'provider_connected_accounts';
  evidence_mode: 'synthetic' | 'licensed_provider';
  approval_ref: string;
  revoked_at: Timestamp | null;
}
export interface PaymentIntentTable {
  id: Generated<string>;
  agreement_id: string;
  binding: Json;
  requested_by: string;
  session_id: string;
  reservation_id: string | null;
  state: PaymentState;
  created_at: GeneratedTimestamp;
}
export interface PaymentOperationTable {
  id: Generated<string>;
  payment_id: string;
  kind: PaymentKind;
  session_id: string;
  admitted_authority: Json | null;
  original_provider_ref: string | null;
  state: Generated<PaymentState>;
  job_id: string | null;
  attempt_id: string | null;
  fencing_token: string | null;
  invoked_at: Timestamp | null;
  provider_ref: string | null;
  customer_action_deadline: Timestamp | null;
  next_reconcile_at: GeneratedTimestamp;
  created_at: GeneratedTimestamp;
}
export interface PaymentReceiptTable {
  connection_id: string;
  event_id: string;
  operation_id: string;
  evidence: Json;
  disposition: 'applied' | 'ignored' | 'conflict';
  received_at: GeneratedTimestamp;
}
export interface PaymentsDatabase {
  payment_source: PaymentSourceTable;
  payment_rail: PaymentRailTable;
  payment_intent: PaymentIntentTable;
  payment_operation: PaymentOperationTable;
  payment_receipt: PaymentReceiptTable;
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module table augmentation
  interface Database extends PaymentsDatabase {}
}
const columns = columnsOf<PaymentsDatabase>();
export const TABLE_COLUMNS: TableColumns<PaymentsDatabase> = {
  payment_source: columns('payment_source', ['agreement_id', 'binding', 'revoked_at', 'created_at']),
  payment_rail: columns('payment_rail', ['connection_id', 'currencies', 'countries', 'rails', 'capabilities', 'custody', 'evidence_mode', 'approval_ref', 'revoked_at']),
  payment_intent: columns('payment_intent', ['id', 'agreement_id', 'binding', 'requested_by', 'session_id', 'reservation_id', 'state', 'created_at']),
  payment_operation: columns('payment_operation', ['id', 'payment_id', 'admitted_authority', 'kind', 'original_provider_ref', 'session_id', 'state', 'job_id', 'attempt_id', 'fencing_token', 'invoked_at', 'provider_ref', 'customer_action_deadline', 'created_at', 'next_reconcile_at']),
  payment_receipt: columns('payment_receipt', ['connection_id', 'event_id', 'operation_id', 'evidence', 'disposition', 'received_at']),
};
