import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Setup module (HUB-004, packages/data/migrations/setup): the one setup run of a node. Only the setup token's SHA-256
 * and expiry are stored; the runtime role reads and writes the run only through the `setup_*` commands.
 */
export interface SetupRunTable {
  id: Generated<string>;
  token_hash: string | null;
  token_issued_at: Date | null;
  token_expires_at: Date | null;
  completed: Generated<string[]>;
  answers: Generated<Record<string, unknown>>;
  admin_email: string | null;
  first_admin_person_id: string | null;
  first_admin_second_factor: 'totp' | 'webauthn' | null;
  recovery_codes_issued_at: Date | null;
  bootstrap_xact: string | null;
  node_id: string | null;
  hub_id: string | null;
  revision: Generated<number>;
  started_at: Generated<Date>;
  finished_at: Date | null;
  updated_at: Generated<Date>;
}
export type SetupRunRow = Selectable<SetupRunTable>;

export interface SetupDatabase {
  setup_run: SetupRunTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends SetupDatabase {}
}

const columns = columnsOf<SetupDatabase>();
export const TABLE_COLUMNS: TableColumns<SetupDatabase> = {
  setup_run: columns('setup_run', [
    'id', 'token_hash', 'token_issued_at', 'token_expires_at', 'completed', 'answers', 'admin_email', 'first_admin_person_id', 'first_admin_second_factor',
    'recovery_codes_issued_at', 'bootstrap_xact', 'node_id', 'hub_id', 'revision', 'started_at', 'finished_at', 'updated_at',
  ]),
};
