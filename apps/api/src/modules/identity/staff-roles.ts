import { sql } from 'kysely';
import { HUB_STAFF_ROLES } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import type { StaffRoleResolver } from './ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN: ReadonlySet<string> = new Set(HUB_STAFF_ROLES);

/**
 * The hub this API serves (`TRUSTWORK_HUB_ID`, the `hub.id` of the hub configured by the setup wizard). Unset: no
 * hub-scoped assignment counts (fail closed); platform and node assignments still do. A malformed value is refused
 * at startup rather than silently ignored.
 */
export function staffHubFromEnv(env: { TRUSTWORK_HUB_ID?: string | undefined }): string | null {
  const raw = env.TRUSTWORK_HUB_ID?.trim();
  if (!raw) return null;
  if (!UUID.test(raw)) throw new Error('TRUSTWORK_HUB_ID must be the uuid of the hub this API serves');
  return raw.toLowerCase();
}

/**
 * Staff roles from DATA-002's `staff_role_assignment` (BE-004 follow-up): an assignment counts when it is not
 * revoked, has started and has not expired (database clock), its scope is one its released role definition allows,
 * and its scope covers this deployment: `platform`, `node` (one database is one node), or `hub` for `hubId` only, so
 * a role in another hub of the same node grants nothing here. Runs inside the principal transaction, where row-level
 * security shows a person their own assignments only; without a transaction (no database) it answers no role.
 * Revoking or expiring an assignment therefore takes effect on the next request, and with it every staff route,
 * elevation and support action of that person (the elevation guard re-checks the role on each request).
 */
export function assignmentStaffRoles(options: { hubId: string | null }): StaffRoleResolver {
  return async (personId: string, trx?: Transaction): Promise<readonly string[]> => {
    if (!trx) return [];
    const { rows } = await sql<{ role: string }>`
      SELECT DISTINCT a.role
      FROM trustwork.staff_role_assignment a
      JOIN trustwork.staff_role_definition_version d ON d.role = a.role AND d.version = a.definition_version
      WHERE a.person_id = ${personId}::uuid
        AND a.revoked_at IS NULL
        AND a.valid_from <= now()
        AND (a.valid_until IS NULL OR a.valid_until > now())
        AND a.scope_kind = ANY (d.scopes)
        AND (a.scope_kind IN ('platform', 'node') OR (a.scope_kind = 'hub' AND a.hub_id = ${options.hubId}::uuid))
      ORDER BY a.role`.execute(trx);
    return rows.map((r) => r.role).filter((role) => KNOWN.has(role));
  };
}
