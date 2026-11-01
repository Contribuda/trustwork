import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type TableColumns, type Timestamp } from './index.js';
type Json = ColumnType<unknown, string, string>;
export interface ModelCallTable {
  operation_id: string;
  principal_id: string;
  run_id: string;
  request_digest: string;
  request: Json;
  binding: Json;
  route: Json;
  candidate: Json;
  dispatch_token: Generated<string>;
  invoked: Generated<boolean>;
  reservation_id: string | null;
  mandate_use_id: string;
  provider_decision_id: string;
  state: Generated<'outcome_unknown' | 'succeeded' | 'failed' | 'refused'>;
  metadata: Json | null;
  created_at: GeneratedTimestamp;
  settled_at: Timestamp | null;
}
export type ModelCallRow = Selectable<ModelCallTable>;
export interface ModelAttemptReceiptTable {
  operation_id: string;
  dispatch_token: string;
  principal_id: string;
  candidate: Json;
  receipt: Json;
  recorded_at: GeneratedTimestamp;
}
export interface ModelsDatabase {
  model_call: ModelCallTable;
  model_attempt_receipt: ModelAttemptReceiptTable;
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module table augmentation
  interface Database extends ModelsDatabase {}
}
const columns = columnsOf<ModelsDatabase>();
export const TABLE_COLUMNS: TableColumns<ModelsDatabase> = {
  model_attempt_receipt: columns('model_attempt_receipt', ['operation_id', 'dispatch_token', 'principal_id', 'candidate', 'receipt', 'recorded_at']),
  model_call: columns('model_call', [
    'operation_id',
    'principal_id',
    'run_id',
    'request_digest',
    'request',
    'binding',
    'route',
    'candidate',
    'dispatch_token',
    'invoked',
    'reservation_id',
    'mandate_use_id',
    'provider_decision_id',
    'state',
    'metadata',
    'created_at',
    'settled_at',
  ]),
};
