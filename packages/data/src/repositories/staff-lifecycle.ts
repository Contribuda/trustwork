import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { StaffRoleAssignmentRow } from '../schema/admin.js';
import type { StaffDirectoryRow } from '../schema/staff-lifecycle.js';

/**
 * Staff lifecycle and access governance (ADM-004, migration packages/data/migrations/staff-lifecycle; contract
 * packages/contracts/src/staff-lifecycle.ts).
 *
 * - **Reads** under `withPrincipal`: the staff directory of a hub (names for every staff member covering it; roles and
 *   second-factor state only with `admin.staff.read`) and one person's active assignments covering the hub for the
 *   effective-access query. Both answer "not found" (`admin.not_found`) to anyone who is not staff of the hub.
 */
export const staffLifecycle = {
  async directory(trx: Transaction, hubId: string): Promise<StaffDirectoryRow[]> {
    const { rows } = await sql<StaffDirectoryRow>`SELECT * FROM trustwork.staff_directory(${hubId}::uuid)`.execute(trx);
    return rows;
  },
  async effectiveAssignments(trx: Transaction, hubId: string, personId: string): Promise<StaffRoleAssignmentRow[]> {
    const { rows } = await sql<StaffRoleAssignmentRow>`SELECT * FROM trustwork.staff_effective_assignments(${hubId}::uuid, ${personId}::uuid)`.execute(trx);
    return rows;
  },
};
