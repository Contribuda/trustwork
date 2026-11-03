import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, type DataPool } from '@trustwork/data';
import { approvals } from '../../../packages/data/src/repositories/admin.js';
import { staffLifecycle } from '../../../packages/data/src/repositories/staff-lifecycle.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { actors, buildAdminWorld, rejects, type AdminWorld } from '../../data/admin/helpers.js';

const db = await provisionTestDatabase('staff_invitation_expiry');

/**
 * ADM-004 part 2 fix on real PostgreSQL under the runtime role: an accepted invitation that has expired cannot be
 * applied, with or without a second-person approval, and a late approval is never consumed by the invitation path. The
 * invitation's expiry is moved into the past directly (the terms guard forbids any change, so the test database disables
 * it for one statement): nothing else has to run for expiry to take effect. Every person and hub is synthetic.
 */
test('an expired accepted invitation is refused at the apply step (ADM-004 part 2 fix)', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 4 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w: AdminWorld = await buildAdminWorld(db.admin);
  const { as, elevate, owner } = actors(db.admin, runtime, w);
  const p = w.people;
  const hub = { kind: 'hub', hubId: w.hubId } as const;
  const address = (who: string) => `${who}.${randomBytes(3).toString('hex')}@invite.example.invalid`;
  const bind = (personId: string, email: string) => owner((trx) => trx.insertInto('email_binding').values({ person_id: personId, email_normalized: email, is_primary: true, verified_at: new Date() }).execute());
  const enrol = (personId: string) => owner((trx) => trx.insertInto('second_factor').values({
    id: crypto.randomUUID(), person_id: personId, kind: 'totp', state: 'active', secret_sealed: randomBytes(48), activated_at: new Date(),
  } as never).execute());
  const expire = (invitationId: string) => owner(async (trx) => {
    await sql`ALTER TABLE trustwork.staff_invitation DISABLE TRIGGER staff_invitation_guard`.execute(trx);
    await sql`UPDATE trustwork.staff_invitation SET expires_at = now() - interval '1 minute' WHERE id = ${invitationId}::uuid`.execute(trx);
    await sql`ALTER TABLE trustwork.staff_invitation ENABLE TRIGGER staff_invitation_guard`.execute(trx);
  });
  const roles = (personId: string) => owner((trx) => trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', personId).execute());
  const apply = (id: string) => as(p.owner, async (trx) => staffLifecycle.apply(trx, await elevate(p.owner), id));

  await t.test('an accepted non-sensitive invitation that expired is refused; no role is assigned', async () => {
    const email = address('customer');
    await bind(p.customer, email);
    await enrol(p.customer);
    const row = await as(p.owner, async (trx) => staffLifecycle.invite(trx, await elevate(p.owner), { email, role: 'moderator', scope: hub, definitionVersion: 1, validForSeconds: null }));
    await as(p.customer, (trx) => staffLifecycle.respond(trx, row.id, true));
    await expire(row.id);
    await rejects(apply(row.id), '23514', 'admin.invitation_expired');
    assert.deepEqual(await roles(p.customer), []);
    assert.equal((await owner((trx) => trx.selectFrom('staff_invitation').select('status').where('id', '=', row.id).executeTakeFirstOrThrow())).status, 'accepted', 'a refusal writes nothing');
  });

  await t.test('an accepted sensitive invitation that expired while waiting for a second person is refused, before and after the approval', async () => {
    const email = address('employee');
    await bind(p.employee, email);
    await enrol(p.employee);
    const row = await as(p.owner, async (trx) => staffLifecycle.invite(trx, await elevate(p.owner), { email, role: 'hub-owner', scope: hub, definitionVersion: 1, validForSeconds: null }));
    await as(p.employee, (trx) => staffLifecycle.respond(trx, row.id, true));
    const first = await apply(row.id);
    assert.equal(first.outcome, 'pending_second_person');
    await expire(row.id);
    await rejects(apply(row.id), '23514', 'admin.invitation_expired');
    // The second person approves late; the invitation path still never consumes it.
    const approval = await owner((trx) => trx.selectFrom('second_person_approval').selectAll().where('id', '=', first.invitation.approval_id!).executeTakeFirstOrThrow());
    await as(p.admin, async (trx) => approvals.decide(trx, await elevate(p.admin), approval.id, 'approve', approval.action_digest));
    await rejects(apply(row.id), '23514', 'admin.invitation_expired');
    assert.deepEqual(await roles(p.employee), []);
    assert.equal((await owner((trx) => trx.selectFrom('second_person_approval').select('status').where('id', '=', approval.id).executeTakeFirstOrThrow())).status, 'approved', 'untouched by the refusal');
    // Withdrawing the expired invitation revokes the approval it asked for.
    const withdrawn = await as(p.owner, async (trx) => staffLifecycle.withdraw(trx, await elevate(p.owner), row.id));
    assert.equal(withdrawn.status, 'withdrawn');
    assert.equal((await owner((trx) => trx.selectFrom('second_person_approval').select('status').where('id', '=', approval.id).executeTakeFirstOrThrow())).status, 'revoked');
  });
});
