import { login } from '../backend/helpers/personas.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { EnvelopesService } from '../../apps/api/src/modules/assistant-goals/envelopes.service.js';
import { SendEnvelopeCommandSchema } from '../../packages/contracts/src/agents.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { as, stateOf } from '../assistant/helpers.js';
import { buildWorld, envelope, terms } from '../assistant-goals/helpers.js';
import { activatePolicy, buildAgentWorld, ok } from './helpers.js';
import { negotiationPolicy } from './fixtures.js';

for (const kind of ['raw_permissions', 'owning_end'] as const) for (const order of ['delivery_first', 'revoker_first'] as const) test(`actual membership withdrawal with a company representative: ${kind}/${order}`, { timeout: 90_000 }, async t => {
  const h = await startHarness(`agent_membership_${kind}_${order}`);
  if (!h) { t.skip(SKIP_REASON); return; }
  t.after(() => h.close());
  for (const role of ['trustwork_app', 'trustwork_worker']) {
    const raw = await h.db.admin.connect();
    try {
      await raw.query('BEGIN'); await raw.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(raw.query('SELECT trustwork.agent_modules_membership_envelope_order()'), (error: unknown) => (error as { code?: string }).code === '42501');
    } finally { await raw.query('ROLLBACK'); raw.release(); }
  }
  await assert.rejects(h.pool.query('SELECT trustwork.agent_modules_lock_envelope_boundary()'), (error: unknown) => (error as { code?: string }).code === '28000');
  const world = await buildAgentWorld(h);
  await activatePolicy(h, world, negotiationPolicy(world.hubId));
  const w = await buildWorld(h);
  const personId = w.seed.people.boris;
  const company = w.seed.companies.supplier;
  const client = w.clients.boris;
  ok(await client.post(`/v1/companies/${company}/representative`, { accountablePersonId: personId, expectedRevision: null }));
  const cm = ok<{ id: string }>(await client.post(`/v1/companies/${company}/agent-mandates`, { executor: { kind: 'company_representative' }, terms: terms(w.rfq.rfq.id, ['communicate']) }), 201);
  await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.membership SET role='administrator',permissions=ARRAY['company.members.manage','company.deals.manage']::text[] WHERE person_id=${w.seed.people.xenia}::uuid`.execute(trx));
  let state = await stateOf(h, client, `membership-${order}`);
  const service = h.created.app.get(EnvelopesService);
  const body = SendEnvelopeCommandSchema.parse(envelope({ actingAs: { kind: 'company_representative', companyMandateId: cm.id }, to: w.petrParty, context: { kind: 'rfq', id: w.rfq.rfq.id }, intent: 'clarify' }));
  const end = async () => {
    const row = (await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.membership WHERE id=$1', [w.seed.memberships.boris])).rows[0]!;
    await h.services().memberships.end(company, { membershipId: w.seed.memberships.boris, expectedRevision: row.revision, reason: 'Synthetic membership ended' }, state);
  };
  const revoke = (afterWrite: () => Promise<void> = async () => {}) => withMaintenance(h.db.admin, async trx => {
    await sql`UPDATE trustwork.membership SET permissions=ARRAY['company.members.manage']::text[] WHERE id=${w.seed.memberships.boris}::uuid`.execute(trx);
    await afterWrite();
  });
  const waitBlocked = async (pattern: string) => {
    for (let i = 0; i < 200; i++) {
      const row = (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [pattern])).rows[0]!;
      if (row.n > 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`missing lock barrier: ${pattern}`);
  };
  if (kind === 'raw_permissions' && order === 'delivery_first') {
    await assert.rejects(revoke(async () => { throw new Error('synthetic writer crash'); }), /synthetic writer crash/);
    assert.equal((await h.db.admin.query('SELECT status FROM trustwork.company_mandate WHERE id=$1', [cm.id])).rows[0].status, 'active');
    await service.listEnvelopes(state);
    // Role alone is not a blanket revoker: an authorized member retaining deals authority still runs the exact mandate.
    const member = (await h.db.admin.query<{ revision: number; permissions: ('company.deals.manage' | 'company.members.manage')[] }>('SELECT revision,permissions FROM trustwork.membership WHERE id=$1', [w.seed.memberships.boris])).rows[0]!;
    await h.services().memberships.change(company, { membershipId: w.seed.memberships.boris, role: 'member', permissions: member.permissions, expectedRevision: member.revision }, await stateOf(h, w.clients.xenia, 'owning-role-change'));
    await service.listEnvelopes(state);
    assert.equal((await h.db.admin.query('SELECT status FROM trustwork.company_mandate WHERE id=$1', [cm.id])).rows[0].status, 'active');
    const blocker = await h.db.admin.connect();
    let refused: Promise<boolean> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('trustwork.agent-envelope-authority.v1',0))");
      // The ordering helper honors the caller's existing statement budget; no timeout becomes delivery evidence.
      await assert.rejects(as(h, personId, async trx => {
        await sql`SET LOCAL statement_timeout='100ms'`.execute(trx);
        await sql`SELECT trustwork.agent_modules_lock_envelope_boundary()`.execute(trx);
      }), (error: unknown) => (error as { code?: string }).code === '57014');
      await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.session SET idle_expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=${state.session!.id}::uuid`.execute(trx));
      refused = service.send(body, state).then(() => false, (error: unknown) => (error as { code?: string }).code === 'auth.session_invalid');
      await waitBlocked('%agent_modules_lock_envelope_boundary%');
      await new Promise(resolve => setTimeout(resolve, 200));
      await blocker.query('COMMIT');
      assert.equal(await refused, true, 'current session expiry is checked after the ordering wait');
      assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.agent_envelope')).rows[0].n, 0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await refused; }
    // A fresh real login supplies the following independent race; the expired session is never revived.
    await login(client, 'boris'); state = await stateOf(h, client, 'membership-after-expiry');
  }
  if (order === 'delivery_first') {
    // Pause after the shared epoch gate but before the owning command locks its company mandate.
    // This exercises the previous inverse order: membership hook -> CM/representative -> AGT epoch.
    const blocker = await h.db.admin.connect();
    let delivery: Promise<Awaited<ReturnType<typeof service.send>> | Error> | undefined;
    let withdrawal: Promise<void | Error> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM trustwork.session WHERE id=$1 FOR UPDATE', [state.session!.id]);
      delivery = service.send(body, state).catch(error => error as Error);
      await waitBlocked('%agent_modules_lock_authenticated_invocation%');
      withdrawal = (kind === 'owning_end' ? end() : revoke()).catch(error => error as Error);
      await waitBlocked(kind === 'owning_end' ? '%end_membership%' : '%UPDATE trustwork.membership SET permissions%');
      await blocker.query('COMMIT');
      const sent = await delivery;
      assert.ok(!(sent instanceof Error), `delivery failed instead of serializing: ${sent instanceof Error ? sent.message : ''}`);
      assert.equal(sent.status, 'delivered');
      const revoked = await withdrawal;
      assert.ok(!(revoked instanceof Error), `membership withdrawal failed instead of serializing: ${revoked instanceof Error ? revoked.message : ''}`);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await delivery; await withdrawal;
    }
  } else if (kind === 'owning_end') {
    // Hold the owning command after its revocation hooks, before its audit/COMMIT; delivery must wait for that commit.
    const blocker = await h.db.admin.connect();
    let withdrawal: Promise<void | Error> | undefined;
    let delivery: Promise<boolean> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('LOCK TABLE trustwork.audit_event IN EXCLUSIVE MODE');
      withdrawal = end().catch(error => error as Error);
      await waitBlocked('%audit_event%');
      delivery = service.send(body, state).then(() => false, () => true);
      await waitBlocked('%agent_modules_lock_envelope_boundary%');
      await blocker.query('COMMIT');
      assert.equal(await withdrawal, undefined, 'owning withdrawal commits before the waiting delivery rechecks');
      assert.equal(await delivery, true);
      assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.agent_envelope')).rows[0].n, 0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await withdrawal; await delivery; }
  } else {
    let entered!: () => void; const written = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
    const withdrawal = revoke(async () => { entered(); await barrier; });
    await written;
    let ended = false;
    const delivery = service.send(body, state).then(() => { ended = true; return false; }, () => { ended = true; return true; });
    try { await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(ended, false); } finally { finish(); }
    await withdrawal; assert.equal(await delivery, true);
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.agent_envelope')).rows[0].n, 0);
  }
  await assert.rejects(service.send(body, state));
  const stopped = (await h.db.admin.query('SELECT status,accountable_person_id FROM trustwork.company_representative WHERE company_id=$1', [company])).rows[0];
  assert.deepEqual(stopped, { status: 'suspended', accountable_person_id: null });
});
