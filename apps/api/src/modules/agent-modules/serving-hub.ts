import { sql } from 'kysely';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';

/** An explicit server routing registration, never a locale, caller payload or default hub. */
export interface ServingHubBinding { id: string; hubId: string }

/**
 * PUBLIC_ORIGIN identifies the first-party server, not a hub. The installation must separately register its exact
 * origin in the database. There is deliberately no fallback to TRUSTWORK_HUB_ID or to a client Host/Origin header.
 * Installing a binding is an operator operation; this participant port can only resolve an existing registration.
 */
export async function servingHub(trx: Transaction, serverOrigin: string): Promise<ServingHubBinding> {
  const origin = new URL(serverOrigin).origin;
  if (origin !== serverOrigin.replace(/\/$/, '')) throw new Error('serving origin must be a bare origin');
  const result = await sql<{ id: string; hub_id: string }>`SELECT id, hub_id FROM trustwork.agent_serving_hub
    WHERE origin = ${origin} AND active`.execute(trx);
  const row = result.rows[0];
  if (!row) throw new ApiError('access.forbidden', 'serving hub authority is unavailable', { reason: 'hub_provenance_unavailable' });
  return { id: row.id, hubId: row.hub_id };
}
