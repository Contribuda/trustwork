import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { actors, buildAdminWorld } from '../data/admin/helpers.js';

export const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

/** The admin world of tests/data/admin plus compliance officers (two, a sensitive role) and an auditor of the node. */
export async function complianceWorld(admin: DataPool, runtime: DataPool) {
  const w = await buildAdminWorld(admin);
  const a = actors(admin, runtime, w);
  await withMaintenance(admin, (trx) => staffRoleDefinitions.release(trx, { version: 1, role: 'compliance-officer', scopes: ['node', 'hub'], permissions: ['admin.claims.read', 'admin.claims.decide'],
    caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));
  const nodeScope = { kind: 'node', nodeId: w.nodeId } as const;
  await a.assignSensitive({ personId: w.people.moderator, role: 'compliance-officer', scope: nodeScope });
  await a.assignSensitive({ personId: w.people.lead, role: 'compliance-officer', scope: nodeScope });
  await a.assign({ personId: w.people.auditor, role: 'auditor', scope: nodeScope });
  return { w, ...a };
}

/** Ids of the seeded baseline lists. */
export async function baselineIds(admin: DataPool): Promise<{ sdn: string; cons: string }> {
  const { rows } = await admin.query<{ id: string; code: string }>("SELECT id, code FROM trustwork.screening_list WHERE baseline ORDER BY code");
  return { sdn: rows.find((r) => r.code === 'ofac-sdn')?.id as string, cons: rows.find((r) => r.code === 'ofac-cons')?.id as string };
}
