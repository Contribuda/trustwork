import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { hubConfig } from '../../../packages/data/src/repositories/hubs.js';
import { staffAssignments, type CommandContext } from '../../../packages/data/src/repositories/admin.js';
import { startHarness } from '../../backend/helpers/app.js';
import { authorityFixture } from './authority-fixture.js';

function barrier() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const h = await startHarness('jurisdiction_activation_current');
test('executable policy activation rechecks current authority after domain waits in both orders', { skip: !h }, async t => {
  if (!h) return; t.after(() => h.close()); const f = await authorityFixture(h.db.admin, h.pool); const { a, p, world } = f;
  async function waiting() {
    for (let n = 0; n < 100; n++) {
      if ((await h!.db.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rowCount) return;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail('competing connection did not reach a lock');
  }
  const setup = async () => { const v = await f.draft(); return { v, ap: await f.approvalFor(v), ctx: await a.elevate(p.officer) }; };
  const change = async (kind: string, ctx: CommandContext) => {
    if (kind === 'epoch') await h.db.admin.query('UPDATE trustwork.person SET authz_epoch=authz_epoch+1 WHERE id=$1', [p.officer]);
    if (kind === 'elevation') await h.db.admin.query("UPDATE trustwork.session_elevation SET revoked_at=clock_timestamp(),revoked_reason='ended' WHERE id=$1", [ctx.elevationId]);
    if (kind === 'role') {
      const id = (await h.db.admin.query("SELECT id FROM trustwork.staff_role_assignment WHERE person_id=$1 AND role='compliance-officer' AND revoked_at IS NULL", [p.officer])).rows[0]!.id as string;
      await a.cmd(p.founder, (trx, command) => staffAssignments.revoke(trx, command, id));
    }
  };
  for (const kind of ['elevation', 'role', 'epoch']) {
    await t.test(`${kind} change wins: waiting activation refuses`, async () => {
      const { v, ap, ctx } = await setup(); const entered = barrier(), release = barrier();
      const first = withMaintenance(h.db.admin, async trx => { await sql`SELECT trustwork.jurisdiction_lock()`.execute(trx); entered.resolve(); await release.promise; });
      await entered.promise;
      const second = a.as(p.officer, trx => hubConfig.activate(trx, ctx, v.id, v.revision, ap)).then(() => null, e => e as { code: string });
      try { await waiting(); await change(kind, ctx); } finally { release.resolve(); }
      await first; assert.equal((await second)?.code, '42501');
      if (kind === 'role') await a.assignSensitive({ personId: p.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId: f.hubId } });
    });
    await t.test(`activation wins: ${kind} change waits and cannot precede the committed decision`, async () => {
      const { v, ap, ctx } = await setup(); const entered = barrier(), release = barrier();
      const first = a.as(p.officer, async trx => { const result = await hubConfig.activate(trx, ctx, v.id, v.revision, ap); entered.resolve(); await release.promise; return result; });
      await entered.promise;
      const second = change(kind, ctx);
      try { await waiting(); } finally { release.resolve(); }
      assert.equal((await first).status, 'active'); await second;
      if (kind === 'role') await a.assignSensitive({ personId: p.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId: f.hubId } });
    });
  }
  await t.test('missing exact session and an elevation from a different session fail closed', async () => {
    const { v, ap, ctx } = await setup();
    const { sessionId, ...missing } = ctx; void sessionId;
    await assert.rejects(a.as(p.officer, trx => hubConfig.activate(trx, missing, v.id, v.revision, ap)), { code: '42501' });
    await assert.rejects(a.as(p.officer, trx => hubConfig.activate(trx, { ...ctx, ...{ sessionId: world.sessions.owner } }, v.id, v.revision, ap)), { code: '42501' });
  });
  await t.test('registered hub activation supplies the resolved request session', async () => {
    const { v, ap } = await setup(); const token = randomBytes(32).toString('base64url');
    await h.db.admin.query('UPDATE trustwork.session SET token_hash=$1 WHERE id=$2', [createHash('sha256').update(token).digest(), world.sessions.officer]);
    h.staff.set(p.officer, ['compliance-officer']); const client = h.client(); client.setSessionCookie(token);
    const key = randomUUID();
    const r = await client.post(`/v1/admin/hubs/${f.hubId}/config/${v.id}/activate`, {
      contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: key, reason: 'Synthetic current-session activation', expectedRevision: v.revision, approvalId: ap,
    }, { idempotencyKey: key });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});
