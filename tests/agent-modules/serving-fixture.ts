import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import type { Harness } from '../backend/helpers/app.js';

/** An explicit synthetic installation for owning-service suites; no person, session, policy bypass or deployment. */
export async function installSyntheticServingHub(h: Harness): Promise<string> {
  return withMaintenance(h.db.admin, async trx => {
    const existing = await trx.selectFrom('agent_serving_hub').select('hub_id').where('origin', '=', h.created.config.publicOrigin).where('active', '=', true).executeTakeFirst();
    if (existing) return existing.hub_id;
    const hub = await trx.insertInto('hub').values({ slug: `synthetic-service-${randomUUID().slice(0, 8)}`, lifecycle: 'draft' }).returning('id').executeTakeFirstOrThrow();
    await sql`INSERT INTO trustwork.agent_serving_hub(origin,hub_id) VALUES(${h.created.config.publicOrigin},${hub.id}::uuid)`.execute(trx);
    return hub.id;
  });
}
