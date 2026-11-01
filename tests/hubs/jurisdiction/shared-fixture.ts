import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { adminDigests, approvals, staffAssignments, staffRoleDefinitions } from '../../../packages/data/src/repositories/admin.js';
import { actors, DEFINITIONS, KEYS, type HubWorld } from '../helpers.js';

/** A fresh HUB world alongside the existing BE-005 world; no existing role, node or bootstrap record is modified. */
export async function sharedAuthorityFixture(admin: DataPool, runtime: DataPool) {
  const version = 51;
  const world = await withMaintenance(admin, async trx => {
    for (const def of DEFINITIONS) {
      await staffRoleDefinitions.release(trx, { version, role: def.role, scopes: def.scopes, permissions: def.permissions,
        caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
    const node = await trx.selectFrom('admin_node').select('id').executeTakeFirstOrThrow();
    const founders = await trx.selectFrom('staff_role_assignment').select(['person_id', 'role']).where('setup_bootstrap', '=', true).execute();
    const people = {} as HubWorld['people']; const sessions = {} as HubWorld['sessions'];
    for (const key of KEYS) {
      people[key] = key === 'founder' ? founders.find(r => r.role === 'platform-owner')!.person_id
        : key === 'founder2' ? founders.find(r => r.role === 'staff-admin')!.person_id
        : (await trx.insertInto('person').values({ display_name: `Synthetic jurisdiction crash ${key}` }).returning('id').executeTakeFirstOrThrow()).id;
      sessions[key] = (await trx.insertInto('session').values({ person_id: people[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow()).id;
    }
    return { nodeId: node.id, people, sessions };
  });
  const base = actors(admin, runtime, world);
  const assign: typeof base.assign = input => base.cmd(world.people.founder, (trx, ctx) => staffAssignments.assign(trx, ctx, { ...input, definitionVersion: version }));
  const assignSensitive: typeof base.assignSensitive = async input => {
    const digest = adminDigests.assignment({ breakglass: false, ...input, definitionVersion: version });
    const ctx = await base.elevate(world.people.founder);
    const request = await base.as(world.people.founder, trx => approvals.request(trx, ctx, { action: 'staff.assign_sensitive_role', scope: input.scope, actionDigest: digest }));
    await base.cmd(world.people.founder2, (trx, command) => approvals.decide(trx, command, request.id, 'approve', digest));
    return base.as(world.people.founder, trx => staffAssignments.assign(trx, { ...ctx, requestId: randomUUID() }, { ...input, definitionVersion: version, approvalId: request.id }));
  };
  return { world, a: { ...base, assign, assignSensitive } };
}
