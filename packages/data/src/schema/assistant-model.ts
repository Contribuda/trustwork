import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type TableColumns } from './index.js';
export interface AssistantModelTurnTable {
  id: Generated<string>;
  person_id: string;
  request_key: string;
  input_digest: string;
  run_id: string;
  asked_id: string;
  state: Generated<'pending' | 'completed'>;
  dispatch_closed: Generated<boolean>;
  result: ColumnType<unknown, string | null, string | null>;
  created_at: GeneratedTimestamp;
}
export type AssistantModelTurnRow = Selectable<AssistantModelTurnTable>;
export interface AssistantModelDatabase {
  assistant_model_turn: AssistantModelTurnTable;
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module table augmentation
  interface Database extends AssistantModelDatabase {}
}
const columns = columnsOf<AssistantModelDatabase>();
export const TABLE_COLUMNS: TableColumns<AssistantModelDatabase> = {
  assistant_model_turn: columns('assistant_model_turn', [
    'id',
    'person_id',
    'request_key',
    'input_digest',
    'run_id',
    'asked_id',
    'state',
    'dispatch_closed',
    'result',
    'created_at',
  ]),
};
