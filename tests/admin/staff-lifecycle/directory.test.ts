import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { staffLifecycle } from '../../../packages/data/src/repositories/staff-lifecycle.js';
import { EffectiveAccessSchema, StaffDirectorySchema, type StaffDirectory } from '../../../packages/contracts/src/staff-lifecycle.js';
import { Client, SKIP_REASON, startHarness } from '../../backend/helpers/app.js';
import { buildHttpWorld, expectRefusal, type AdminWorldHttp } from '../helpers.js';

const h = await startHarness('staff_directory');

/** Field names that would describe what a staff member does rather than who they are and what they may do. */
const ACTIVITY = /(activ(e|ity)At|last|seen|signIn|login|elevat|count|decision|response|productiv|behavio|duration|minutes|hours|score|rank)/i;
function fieldNames(schema: z.ZodType, out: string[] = []): string[] {
  const def = (schema as unknown as { def: { type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType; innerType?: z.ZodType; options?: z.ZodType[] } }).def;
  if (def.type === 'object' && def.shape) for (const [k, v] of Object.entries(def.shape)) { out.push(k); fieldNames(v, out); }
  if (def.type === 'array' && def.element) fieldNames(def.element, out);
  if ((def.type === 'nullable' || def.type === 'optional') && def.innerType) fieldNames(def.innerType, out);
  if (def.type === 'union' && def.options) for (const o of def.options) fieldNames(o, out);
  return out;
}

/**
 * ADM-004 part 1 on real PostgreSQL under the runtime role, through the HTTP API with elevated sessions: staff of the
 * hub read the names of the staff covering it; roles and second-factor state only with `admin.staff.read`; anyone else
 * gets "not found"; the effective access of one person needs `admin.staff.read`. Every person and hub is synthetic.
 */
test('staff directory and effective access (ADM-004 part 1)', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: AdminWorldHttp = await buildHttpWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const hubId = w.world.hubId;
  const directory = (client: Client) => client.get(`/v1/admin/staff/directory?hubId=${hubId}`);

  await t.test('negative: anonymous, participants, other-hub staff and unelevated staff never read the directory', async () => {
    expectRefusal(await new Client(w.app).get(`/v1/admin/staff/directory?hubId=${hubId}`), 401, 'auth.session_invalid');
    expectRefusal(await directory(c.customer), 403, 'access.forbidden', 'staff');
    expectRefusal(await directory(c.otherAgent), 403, 'access.forbidden', 'staff');
    expectRefusal(await directory(c.moderator), 403, 'access.forbidden', 'elevation');
  });

  await w.elevateAll();

  await t.test('a staff member without admin.staff.read reads names only, of the staff covering this hub', async () => {
    const r = await directory(c.moderator);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const view: StaffDirectory = StaffDirectorySchema.parse(r.body);
    assert.equal(view.detail, false);
    const ids = view.entries.map((e) => e.personId);
    for (const key of ['owner', 'admin', 'admin2', 'hubOwner', 'moderator', 'lead', 'lead2', 'agent', 'ops', 'auditor'] as const) assert.ok(ids.includes(p[key]), key);
    for (const key of ['otherAgent', 'customer', 'employee', 'candidate'] as const) assert.ok(!ids.includes(p[key]), `${key} is not staff of this hub`);
    assert.ok(view.entries.every((e) => e.roles === null && e.secondFactor === null), 'no roles or second-factor state without admin.staff.read');
    assert.equal(view.entries.find((e) => e.personId === p.moderator)?.displayName, 'Synthetic Moderator');
  });

  await t.test('a reader with admin.staff.read sees roles with their scope and whether a second factor is enrolled', async () => {
    const view = StaffDirectorySchema.parse((await directory(c.hubOwner)).body);
    assert.equal(view.detail, true);
    const moderator = view.entries.find((e) => e.personId === p.moderator)!;
    assert.deepEqual(moderator.roles?.map((r) => [r.role, r.scope]), [['moderator', { kind: 'hub', hubId }]]);
    assert.equal(moderator.secondFactor, 'enrolled');
    const owner = view.entries.find((e) => e.personId === p.owner)!;
    assert.deepEqual(owner.roles?.map((r) => [r.role, r.scope.kind]), [['platform-owner', 'platform']]);
  });

  await t.test('the database itself refuses the directory to a participant, to staff of another hub and for an unknown hub', async () => {
    const refused = async (personId: string, hub: string) => {
      await assert.rejects(w.actors.as(personId, (trx) => staffLifecycle.directory(trx, hub)), (e: { hint?: string }) => e.hint === 'admin.not_found');
    };
    await refused(p.customer, hubId);
    await refused(p.otherAgent, hubId);
    await refused(p.moderator, randomUUID());
    // Staff of the other hub read that hub's directory, which never lists this hub's hub-scoped staff.
    const other = await w.actors.as(p.otherAgent, (trx) => staffLifecycle.directory(trx, w.world.otherHubId));
    assert.ok(other.some((r) => r.person_id === p.otherAgent));
    assert.ok(!other.some((r) => r.person_id === p.moderator || r.person_id === p.hubOwner));
  });

  await t.test('effective access: admin.staff.read at the hub is needed, and a person who is not staff is not found', async () => {
    const read = (client: Client, personId: string) => client.get(`/v1/admin/staff/effective-access?hubId=${hubId}&personId=${personId}`);
    const r = await read(c.hubOwner, p.moderator);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const access = EffectiveAccessSchema.parse(r.body);
    assert.deepEqual(access.roles, ['moderator']);
    assert.ok(access.permissions.includes('admin.moderation.decide'));
    assert.ok(!access.permissions.includes('admin.staff.assign'));
    assert.deepEqual(EffectiveAccessSchema.parse((await read(c.hubOwner, p.owner)).body).roles, ['platform-owner']);
    expectRefusal(await read(c.moderator, p.hubOwner), 404, 'access.not_found');
    expectRefusal(await read(c.hubOwner, p.candidate), 404, 'access.not_found');
    expectRefusal(await read(c.hubOwner, p.otherAgent), 404, 'access.not_found');
  });

  await t.test('no field of these reads describes what a staff member does (schema walk)', () => {
    const names = [...fieldNames(StaffDirectorySchema), ...fieldNames(EffectiveAccessSchema)];
    assert.ok(names.length > 10);
    assert.deepEqual(names.filter((n) => ACTIVITY.test(n)), []);
  });
});
