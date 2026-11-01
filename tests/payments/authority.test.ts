import test from 'node:test';
import assert from 'node:assert/strict';
import { approvals, killSwitches, adminDigests } from '../../packages/data/src/repositories/admin.js';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { payments } from '../../packages/data/src/repositories/payments.js';
import { hubConfig } from '../../packages/data/src/repositories/hubs.js';
import { configActivationDigestInput } from '../../packages/contracts/src/hub-core.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { screenEveryoneClear, clearHold } from '../screening-gates/helpers.js';
import { workerLogin } from '../assistant/helpers.js';
import { agreement, paymentHub, paymentVerifier, ok } from './helpers.js';
import type { PaymentBinding, PaymentInstruction, PaymentKind, PaymentView } from '../../packages/contracts/src/payments.js';
import { PaymentProviders, DeterministicPaymentFake } from '../../apps/worker/src/payments/provider.js';
import { receivePaymentWebhook, reconcilePayment, registerPayments } from '../../apps/worker/src/payments/index.js';
import { HandlerRegistry } from '../../apps/worker/src/handlers.js';
import { defaultWorkerConfig } from '../../apps/worker/src/config.js';
import { Metrics } from '../../apps/worker/src/metrics.js';
import { OutboxRelay } from '../../apps/worker/src/relay.js';
import { JobRunner } from '../../apps/worker/src/runner.js';

const h = await startHarness('payment_authority');
test('PAY-001 current authority: actual HTTP and registered worker, competing owning writes', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  let cleanup = () => h.close();
  t.after(() => cleanup());
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  await withMaintenance(h.db.admin, async (trx) => { const m = await trx.selectFrom('membership').select('permissions').where('id', '=', seed.memberships.anna).executeTakeFirstOrThrow(); await trx.updateTable('membership').set({ permissions: [...new Set([...m.permissions, 'company.billing.manage'])] }).where('id', '=', seed.memberships.anna).execute(); });
  const hub = await paymentHub(h);
  await screenEveryoneClear(h.db.admin);
  const buyer = h.client(), seller = h.client();
  await login(buyer, 'anna'); await login(seller, 'carl');
  const worker = await workerLogin(h), pool = worker.pool(4), verifier = await paymentVerifier(h);
  cleanup = async () => { await pool.end(); await worker.close(); await verifier.close(); await h.close(); };
  const q = async (query: string, args: unknown[] = []) => (await h.db.admin.query(query, args)).rows;
  const wait = async (condition: () => Promise<boolean>, label: string) => {
    for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise((r) => setTimeout(r, 10)); }
    assert.fail(label);
  };
  const blocked = (pid: number) => wait(async () => (await q("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).length > 0, 'owning writer must actually wait');
  const pendingPayment = () => wait(async () => (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%trustwork.payments_%'")).length > 0, 'payment must actually wait');
  let releaseEffect: (() => void) | undefined;
  let enteredEffect: (() => void) | undefined;
  let effectBarrier: Promise<void> | undefined;
  class GatedFake extends DeterministicPaymentFake {
    private async gate() { enteredEffect?.(); if (effectBarrier) await effectBarrier; }
    override async create(i: PaymentInstruction, signal: AbortSignal) { await this.gate(); return super.create(i, signal); }
    override async confirm(i: PaymentInstruction, signal: AbortSignal) { await this.gate(); return super.confirm(i, signal); }
    override async refund(i: PaymentInstruction, signal: AbortSignal) { await this.gate(); return super.refund(i, signal); }
    override async payout(i: PaymentInstruction, signal: AbortSignal) { await this.gate(); return super.payout(i, signal); }
    override async connectedAccount(i: PaymentInstruction, signal: AbortSignal) { await this.gate(); return super.connectedAccount(i, signal); }
  }
  const fake = new GatedFake();
  const runtime = { pool, receiptPool: verifier.pool, providers: new PaymentProviders(new Map([[hub.connectionId, fake]])) };
  const registry = new HandlerRegistry(); registerPayments(registry, runtime);
  const deps = { pool, registry, config: defaultWorkerConfig({ concurrency: 1, relayBatchSize: 1000 }), metrics: new Metrics(), log: () => {} };
  const relay = new OutboxRelay(deps), runner = new JobRunner(deps);
  const tick = async () => { await relay.relayOnce(); await runner.tick(); await runner.idle(); };
  // Only test payment outbox inserts pause; the actual HTTP transaction retains all owning locks.
  await q(`CREATE FUNCTION trustwork.payment_test_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.type='payments.requested' THEN PERFORM pg_advisory_xact_lock(827001,1); END IF; RETURN NEW; END $$`);
  await q('CREATE TRIGGER payment_test_barrier BEFORE INSERT ON trustwork.outbox_event FOR EACH ROW EXECUTE FUNCTION trustwork.payment_test_barrier()');
  const fresh = async () => {
    await login(buyer, 'anna');
    const a = (await agreement(h, buyer, seller, seed.people.anna, seed.people.carl, '1250', seed.companies.mixed)).agreement;
    const binding: PaymentBinding = { agreementId: a.id, agreementDigest: a.acceptedTerms.digest.value,
      offerVersion: a.acceptedTerms.quoteVersion.version, requestVersion: a.acceptedTerms.rfqVersion.version,
      payer: { kind: 'company', id: seed.companies.mixed }, payee: { kind: 'person', id: seed.people.carl },
      collectingHubId: hub.hubId, payerHubId: hub.hubId, payeeHubId: hub.hubId, payerCountry: 'US', payeeCountry: 'US', currency: 'USD', amountMinor: '1250',
      connectionId: hub.connectionId, connectedAccountCountry: 'US', connectedAccountRef: 'synthetic-authority-account', rail: 'qr', evidenceMode: 'synthetic' };
    await q('INSERT INTO trustwork.payment_source(agreement_id,binding) VALUES($1,$2)', [a.id, binding]);
    const order = (await q('SELECT * FROM trustwork.commercial_order WHERE agreement_id=$1', [a.id]))[0]!;
    const session = await h.services().principals.resolve(buyer.sessionCookie!); assert.ok(session);
    return { kind: 'create' as PaymentKind, agreementId: a.id, budgetId: order.transaction_budget_id as string, sessionId: session.session.id, reservationId: order.reservation_id as string };
  };
  type Fixture = Awaited<ReturnType<typeof fresh>>;
  type Mutation = { name: string; actor?: string; prepare?(): Promise<void>; route?: boolean; epochOnly?: boolean; kinds?: PaymentKind[]; sql(f: Fixture): [string, unknown[]]; restore?(f: Fixture): Promise<unknown> };
  const mutations: Mutation[] = [
    { name: 'exact session revocation', sql: (f) => ["UPDATE trustwork.session SET revoked_at=clock_timestamp(),revoked_reason='logout' WHERE id=$1", [f.sessionId]] },
    { name: 'person epoch', epochOnly: true, sql: () => ['UPDATE trustwork.person SET authz_epoch=authz_epoch+1 WHERE id=$1', [seed.people.anna]] },
    { name: 'company epoch', epochOnly: true, sql: () => ['UPDATE trustwork.company SET authz_epoch=authz_epoch+1 WHERE id=$1', [seed.companies.mixed]] },
    { name: 'billing membership permission', sql: () => ["UPDATE trustwork.membership SET permissions=array_remove(permissions,'company.billing.manage') WHERE id=$1", [seed.memberships.anna]], restore: () => withMaintenance(h.db.admin, async (trx) => { const m = await trx.selectFrom('membership').select('permissions').where('id', '=', seed.memberships.anna).executeTakeFirstOrThrow(); await trx.updateTable('membership').set({ permissions: [...new Set([...m.permissions, 'company.billing.manage'])] }).where('id', '=', seed.memberships.anna).execute(); }) },
    { name: 'owning source revocation', sql: (f) => ['UPDATE trustwork.payment_source SET revoked_at=clock_timestamp() WHERE agreement_id=$1', [f.agreementId]] },
    { name: 'provider connection disable', route: true, sql: () => ["UPDATE trustwork.provider_connection SET status='disabled',enabled_by=NULL,enabled_at=NULL,approval_id=NULL WHERE id=$1", [hub.connectionId]], restore: () => q("UPDATE trustwork.provider_connection SET status='enabled',enabled_by=$2,enabled_at=clock_timestamp() WHERE id=$1", [hub.connectionId, hub.w.people.owner]) },
    { name: 'rail capability removal', route: true, sql: (f) => ["UPDATE trustwork.payment_rail SET capabilities=array_remove(capabilities,$2) WHERE connection_id=$1", [hub.connectionId, f.kind]], restore: () => q("UPDATE trustwork.payment_rail SET capabilities=ARRAY['create','confirm','refund','payout','connected_account'] WHERE connection_id=$1", [hub.connectionId]) },
    { name: 'provider payment capability removal', route: true, sql: () => ["UPDATE trustwork.provider_connection SET capabilities=array_remove(capabilities,'payments') WHERE id=$1", [hub.connectionId]], restore: () => q("UPDATE trustwork.provider_connection SET capabilities=ARRAY['payments','payouts'] WHERE id=$1", [hub.connectionId]) },
    { name: 'provider payout capability removal', route: true, kinds: ['payout'], sql: () => ["UPDATE trustwork.provider_connection SET capabilities=array_remove(capabilities,'payouts') WHERE id=$1", [hub.connectionId]], restore: () => q("UPDATE trustwork.provider_connection SET capabilities=ARRAY['payments','payouts'] WHERE id=$1", [hub.connectionId]) },
    { name: 'rail revocation', route: true, sql: () => ['UPDATE trustwork.payment_rail SET revoked_at=clock_timestamp() WHERE connection_id=$1', [hub.connectionId]], restore: () => q('UPDATE trustwork.payment_rail SET revoked_at=NULL WHERE connection_id=$1', [hub.connectionId]) },
    ...[seed.people.anna, seed.people.carl].map((id, i): Mutation => ({ name: `${i ? 'payee' : 'actor'} screening`, sql: () => ["UPDATE trustwork.screening_subject_state SET last_outcome='not_screened' WHERE subject_person_id=$1", [id]], restore: () => screenEveryoneClear(h.db.admin) })),
    { name: 'company screening', sql: () => ["UPDATE trustwork.screening_subject_state SET last_outcome='not_screened' WHERE subject_company_id=$1", [seed.companies.mixed]], restore: () => screenEveryoneClear(h.db.admin) },
    { name: 'baseline freshness', sql: () => ["UPDATE trustwork.screening_list SET last_checked_at=clock_timestamp()-interval '30 days' WHERE baseline", []], restore: () => q('UPDATE trustwork.screening_list SET last_checked_at=clock_timestamp() WHERE baseline') },
    ...[seed.people.anna, seed.people.carl].map((id, i): Mutation => ({ name: `${i ? 'payee' : 'actor'} jurisdiction hold`, sql: () => ["INSERT INTO trustwork.jurisdiction_hold(person_id,place,source,dataset) VALUES($1,'CU','staff_report','synthetic-payment-race')", [id]], restore: () => clearHold(h.db.admin, id, seed.people.petr) })),
  ];
  mutations.push({ name: 'membership ended', sql: () => ["UPDATE trustwork.membership SET status='ended',ended_at=clock_timestamp(),ended_by=$2,ended_reason='synthetic revocation' WHERE id=$1", [seed.memberships.anna, seed.people.anna]],
    restore: async () => { await withMaintenance(h.db.admin, async (trx) => { const prior = await trx.selectFrom('membership').selectAll().where('id', '=', seed.memberships.anna).executeTakeFirstOrThrow(); const next = await trx.insertInto('membership').values({ person_id: prior.person_id, company_id: prior.company_id, role: prior.role, permissions: prior.permissions, status: 'active', valid_from: new Date() }).returning('id').executeTakeFirstOrThrow(); seed.memberships.anna = next.id; }); } });
  mutations.push({ name: 'transaction budget closed', sql: (f) => ["UPDATE trustwork.budget SET status='closed',closed_at=clock_timestamp(),closed_by=$2 WHERE id=$1", [f.budgetId, seed.people.anna]] });
  // The accepted version is immutable. The owning revoker supersedes it with another stored agreement.
  const successor = await fresh();
  mutations.push({ name: 'accepted agreement superseded', sql: (f) => ["UPDATE trustwork.agreement SET status='superseded',superseded_by=$2 WHERE id=$1", [f.agreementId, successor.agreementId]] });
  const configPayload = (await q("SELECT v.payload FROM trustwork.hub_config_current c JOIN trustwork.hub_config_version v ON v.id=c.version_id WHERE c.hub_id=$1 AND c.domain='payments'", [hub.hubId]))[0]!.payload as Record<string, unknown>;
  const configuration = async (enabled: boolean): Promise<[string, unknown[]]> => {
    const v = await hub.a.cmd(hub.w.people.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub.hubId, 'payments', { ...configPayload, providers: enabled ? configPayload.providers : [] }));
    const approval = await hub.a.approve(hub.w.people.officer, hub.w.people.owner, 'payments.change_settings', hub.hubId, configActivationDigestInput({ id: v.id, hubId: hub.hubId, domain: 'payments', version: v.version, payloadDigest: v.payload_digest }));
    const ctx = await hub.a.elevate(hub.w.people.officer);
    return ['SELECT trustwork.hubs_activate_config($1,$2,NULL,$3)', [JSON.stringify(ctx), v.id, approval]];
  };
  let configWrite: [string, unknown[]];
  mutations.push({ name: 'current hub configuration activation', route: true, actor: hub.w.people.officer,
    prepare: async () => { configWrite = await configuration(false); }, sql: () => configWrite,
    restore: async () => { const statement = await configuration(true); await hub.a.as(hub.w.people.officer, async (trx) => { const { sql } = await import('kysely'); await sql`SELECT trustwork.hubs_activate_config(${statement[1][0]}::jsonb,${statement[1][1]}::uuid,NULL,${statement[1][2]}::uuid)`.execute(trx); }); } });

  for (const personId of [hub.w.people.owner, hub.w.people.officer]) await hub.a.assignSensitive({ personId, role: 'compliance-officer', scope: { kind: 'node', nodeId: hub.w.nodeId } });
  for (const scopeKind of ['provider_connection', 'node'] as const) {
    let killCommand: [string, unknown[]];
    mutations.push({ name: `${scopeKind} kill switch`, route: true, actor: hub.w.people.owner,
      prepare: async () => { const ctx = await hub.a.elevate(hub.w.people.owner); killCommand = ['SELECT trustwork.admin_engage_kill_switch($1,$2,$3,$4,$5,NULL)', [JSON.stringify(ctx), scopeKind, scopeKind === 'node' ? hub.w.nodeId : null, scopeKind === 'node' ? null : hub.hubId, JSON.stringify(scopeKind === 'node' ? {} : { connectionId: hub.connectionId })]]; },
      sql: () => killCommand,
      restore: async () => {
        const k = (await q("SELECT id FROM trustwork.kill_switch WHERE scope_kind=$1 AND state='engaged'", [scopeKind]))[0];
        if (!k) return;
        const note = 'Synthetic matrix release after independent review';
        const scope = scopeKind === 'node' ? { kind: 'node' as const, nodeId: hub.w.nodeId } : { kind: 'hub' as const, hubId: hub.hubId };
        const digest = adminDigests.killSwitchRelease(k.id as string, note);
        const approval = await hub.a.cmd(hub.w.people.owner, (trx, ctx) => approvals.request(trx, ctx, { action: 'kill_switch.release', scope, actionDigest: digest }));
        await hub.a.cmd(hub.w.people.officer, (trx, ctx) => approvals.decide(trx, ctx, approval.id, 'approve', digest));
        await hub.a.cmd(hub.w.people.owner, (trx, ctx) => killSwitches.release(trx, ctx, k.id as string, approval.id, note));
      } });
  }
  await fresh();
  for (const mutation of mutations) for (const surface of ['create', 'confirm', 'refund', 'payout', 'connected_account', 'worker', 'worker_confirm', 'worker_refund', 'worker_payout', 'worker_connected_account'] as const) for (const revokerFirst of [true, false]) {
    // Epoch-only changes invalidate queued admission, while a newly resolved HTTP command may use current authority.
    const isWorker = surface.startsWith('worker');
    const kind = (surface === 'worker' ? 'create' : surface.replace(/^worker_/, '')) as PaymentKind;
    if (mutation.epochOnly && !isWorker || mutation.kinds && !mutation.kinds.includes(kind)) continue;
    await t.test(`${mutation.name}; ${surface}; ${revokerFirst ? 'revoker' : 'payment'} first`, async () => {
      const f = await fresh(); f.kind = kind;
      await mutation.prepare?.();
      let view: PaymentView | undefined;
      if (surface !== 'create') view = ok(await buyer.post('/v1/payments', { agreementId: f.agreementId, budgetId: f.budgetId }), 201);
      if (kind !== 'create') {
        const original = (await q("SELECT id FROM trustwork.payment_operation WHERE payment_id=$1 AND kind='create'", [view!.id]))[0]!;
        fake.plan(original.id as string, kind === 'confirm' ? 'requires_confirmation' : 'succeeded'); await tick();
        if (isWorker) ok(await buyer.post(`/v1/payments/${view!.id}/${kind === 'connected_account' ? 'connected-account' : kind}`, {}));
      }
      let workerOperation: Record<string, unknown> | undefined;
      if (isWorker) {
        await relay.relayOnce();
        workerOperation = (await q('SELECT * FROM trustwork.payment_operation WHERE payment_id=$1 AND kind=$2', [view!.id, kind]))[0]!;
        fake.plan(workerOperation!.id as string, 'outcome_unknown');
      }
      const before = fake.calls.length;
      const writer = await h.db.admin.connect(), barrier = await h.db.admin.connect();
      let task: Promise<unknown> | undefined, write: Promise<unknown> | undefined;
      const originalGuard = payments.dispatchGuard;
      let resumeGuard: (() => void) | undefined;
      let response: Awaited<ReturnType<typeof buyer.post>> | undefined;
      const run = async () => {
        if (isWorker) { await runner.tick(); await runner.idle(); }
        else response = await buyer.post(surface === 'create' ? '/v1/payments' : `/v1/payments/${view!.id}/${surface === 'connected_account' ? 'connected-account' : surface}`, surface === 'create' ? { agreementId: f.agreementId, budgetId: f.budgetId } : {});
      };
      try {
        await writer.query('BEGIN'); await writer.query("SET LOCAL statement_timeout='5s'");
        await writer.query('SET LOCAL ROLE trustwork_owner'); await writer.query("SET LOCAL trustwork.maintenance='on'");
        const actor = mutation.actor ?? seed.people.anna;
        await writer.query('SELECT trustwork.set_principal($1,(SELECT authz_epoch FROM trustwork.person WHERE id=$1))', [actor]);
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number;
        if (revokerFirst) {
          if (isWorker) {
            let reached!: () => void;
            const ready = new Promise<void>((r) => { reached = r; });
            const resume = new Promise<void>((r) => { resumeGuard = r; });
            // Scheduling only: the registered handler commits its real durable marker, then executes the
            // unchanged final SQL guard after the competing writer has acquired the owning lock.
            payments.dispatchGuard = async (...args) => { reached(); await resume; return originalGuard(...args); };
            task = run(); void task.catch(() => {});
            await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('worker did not reach final guard')), 3000))]);
            await writer.query(...mutation.sql(f)); resumeGuard!();
          } else {
            await writer.query(...mutation.sql(f)); task = run(); void task.catch(() => {});
          }
          await pendingPayment();
          await writer.query('COMMIT'); await task;
          if (isWorker) assert.equal(fake.calls.length, before);
          else if (surface === 'create' && mutation.route) assert.equal(ok<PaymentView>(response!, 201).state, 'outside_platform');
          else assert.ok([401, 403].includes(response!.status), JSON.stringify(response));
        } else {
          let entered: Promise<void> | undefined;
          if (isWorker) {
            entered = new Promise<void>((r) => { enteredEffect = r; });
            effectBarrier = new Promise<void>((r) => { releaseEffect = r; });
          } else await barrier.query('SELECT pg_advisory_lock(827001,1)');
          task = run(); void task.catch(() => {});
          if (entered) await Promise.race([entered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('worker did not reach provider')), 3000))]);
          else await pendingPayment();
          write = writer.query(...mutation.sql(f)); void write.catch(() => {}); await blocked(pid);
          if (isWorker) releaseEffect!();
          else await barrier.query('SELECT pg_advisory_unlock(827001,1)');
          await task; await write; await writer.query('COMMIT');
          if (isWorker) assert.equal(fake.calls.length, before + 1);
          else assert.equal(response!.status, surface === 'create' ? 201 : 200, JSON.stringify(response));
        }
        if (isWorker) {
          const r = (await q('SELECT state,effect_pending FROM trustwork.reservation WHERE id=$1', [f.reservationId]))[0]!;
          assert.deepEqual(r, { state: ['create', 'confirm'].includes(kind) ? 'reserved' : 'settled', effect_pending: true });
          const op = workerOperation!;
          await runner.tick(); await runner.idle();
          assert.equal(fake.calls.length, before + (revokerFirst ? 0 : 1), 'no duplicate dispatch');
          if (!revokerFirst) {
            const evidence = fake.sign(fake.complete(op.id as string, 'succeeded', `late:${op.id}`));
            assert.equal(await receivePaymentWebhook(runtime, hub.connectionId, evidence.raw, evidence.signature), 'applied');
            assert.equal((await q('SELECT state FROM trustwork.reservation WHERE id=$1', [f.reservationId]))[0]!.state, 'settled');
          }
        }
      } finally {
        resumeGuard?.(); payments.dispatchGuard = originalGuard;
        releaseEffect?.(); enteredEffect = undefined; effectBarrier = undefined; releaseEffect = undefined;
        await barrier.query('SELECT pg_advisory_unlock_all()');
        await writer.query('ROLLBACK');
        await Promise.allSettled([task, write]); writer.release(); barrier.release();
        await mutation.restore?.(f);
        // API tests leave real queued effects; park only their jobs so the next worker case selects its own operation.
        await relay.relayOnce();
        await q("UPDATE trustwork.job SET state='dead' WHERE kind='payments.dispatch' AND state='queued'");
      }
    });
  }

  for (const expiry of ['idle session', 'absolute session', 'budget', 'screening', 'lease'] as const) {
    await t.test(`actual worker final attempt rejects ${expiry} expiring after domain locks`, async () => {
      const f = await fresh();
      const v = ok<PaymentView>(await buyer.post('/v1/payments', { agreementId: f.agreementId, budgetId: f.budgetId }), 201);
      await relay.relayOnce();
      const op = (await q('SELECT * FROM trustwork.payment_operation WHERE payment_id=$1', [v.id]))[0]!;
      const originalGuard = payments.dispatchGuard;
      let reached!: () => void, resume!: () => void;
      const ready = new Promise<void>((r) => { reached = r; }), proceed = new Promise<void>((r) => { resume = r; });
      payments.dispatchGuard = async (...args) => { reached(); await proceed; return originalGuard(...args); };
      const blocker = await h.db.admin.connect();
      const before = fake.calls.length;
      const running = (async () => { await runner.tick(); await runner.idle(); })(); void running.catch(() => {});
      try {
        await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('final guard not reached')), 3000))]);
        if (expiry === 'idle session' || expiry === 'absolute session') {
          await q(`UPDATE trustwork.session SET ${expiry === 'idle session' ? 'idle_expires_at' : "idle_expires_at=clock_timestamp()+interval '1 second',absolute_expires_at"}=clock_timestamp()+interval '1 second' WHERE id=$1`, [f.sessionId]);
        } else if (expiry === 'budget') await q("UPDATE trustwork.budget SET period_to=clock_timestamp()+interval '1 second' WHERE id=$1", [f.budgetId]);
        else if (expiry === 'screening') await q("UPDATE trustwork.screening_list SET last_checked_at=clock_timestamp()-least(stale_after,interval '14 days') WHERE baseline");
        else await q("UPDATE trustwork.job SET leased_until=clock_timestamp()+interval '1 second' WHERE id=$1", [op.job_id]);
        await blocker.query('BEGIN');
        // Funds guard evaluates budget time before waiting for this original owning order.
        // The final pass must use wall time again when this lock is released.
        if (expiry === 'budget') await blocker.query('SELECT id FROM trustwork.commercial_order WHERE agreement_id=$1 FOR UPDATE', [f.agreementId]);
        else await blocker.query('SELECT connection_id FROM trustwork.payment_rail WHERE connection_id=$1 FOR UPDATE', [hub.connectionId]);
        resume(); await pendingPayment();
        await wait(async () => {
          if (expiry === 'screening') return (await q('SELECT trustwork.screening_available(clock_timestamp()) AS available'))[0]!.available === false;
          if (expiry === 'budget') return (await q('SELECT period_to<=clock_timestamp() AS expired FROM trustwork.budget WHERE id=$1', [f.budgetId]))[0]!.expired === true;
          if (expiry === 'lease') return (await q('SELECT leased_until<=clock_timestamp() AS expired FROM trustwork.job WHERE id=$1', [op.job_id]))[0]!.expired === true;
          return (await q(`SELECT ${expiry === 'idle session' ? 'idle_expires_at' : 'absolute_expires_at'}<=clock_timestamp() AS expired FROM trustwork.session WHERE id=$1`, [f.sessionId]))[0]!.expired === true;
        }, 'authority must expire on the database clock');
        await blocker.query('COMMIT'); await running;
        assert.equal(fake.calls.length, before);
        assert.deepEqual((await q('SELECT state,effect_pending FROM trustwork.reservation WHERE id=$1', [f.reservationId]))[0], { state: 'reserved', effect_pending: true });
        assert.equal((await q('SELECT state FROM trustwork.payment_operation WHERE id=$1', [op.id]))[0]!.state, 'outcome_unknown');
        assert.equal(await reconcilePayment(runtime, op.id as string, AbortSignal.timeout(1000)), 'outcome_unknown');
        await runner.tick(); await runner.idle(); assert.equal(fake.calls.length, before);
      } finally {
        resume(); payments.dispatchGuard = originalGuard; await blocker.query('ROLLBACK'); blocker.release(); await running;
        if (expiry === 'screening') await q('UPDATE trustwork.screening_list SET last_checked_at=clock_timestamp() WHERE baseline');
      }
    });
  }
  for (const surface of ['create', 'confirm', 'refund', 'payout', 'connected-account'] as const) for (const expiry of ['session', 'budget', 'screening'] as const) {
    await t.test(`HTTP ${surface} rechecks ${expiry} time after domain wait`, async () => {
      const f = await fresh();
      let v: PaymentView | undefined;
      if (surface !== 'create') { v = ok(await buyer.post('/v1/payments', { agreementId: f.agreementId, budgetId: f.budgetId }), 201); const op = (await q("SELECT id FROM trustwork.payment_operation WHERE payment_id=$1 AND kind='create'", [v!.id]))[0]!; fake.plan(op.id as string, surface === 'confirm' ? 'requires_confirmation' : 'succeeded'); await tick(); }
      if (expiry === 'session') await q("UPDATE trustwork.session SET idle_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.sessionId]);
      else if (expiry === 'budget') await q("UPDATE trustwork.budget SET period_to=clock_timestamp()+interval '1 second' WHERE id=$1", [f.budgetId]);
      else await q("UPDATE trustwork.screening_list SET last_checked_at=clock_timestamp()-least(stale_after,interval '14 days') WHERE baseline");
      const blocker = await h.db.admin.connect();
      let pending: ReturnType<typeof buyer.post> | undefined;
      try {
        await blocker.query('BEGIN');
        // The final durable outbox append can wait after all authority and funds locks were taken.
        await blocker.query('SELECT pg_advisory_xact_lock(827001,1)');
        pending = buyer.post(surface === 'create' ? '/v1/payments' : `/v1/payments/${v!.id}/${surface}`, surface === 'create' ? { agreementId: f.agreementId, budgetId: f.budgetId } : {});
        await pendingPayment();
        await wait(async () => expiry === 'screening'
          ? (await q('SELECT trustwork.screening_available(clock_timestamp()) AS available'))[0]!.available === false
          : expiry === 'budget' ? (await q('SELECT period_to<=clock_timestamp() AS expired FROM trustwork.budget WHERE id=$1', [f.budgetId]))[0]!.expired === true
            : (await q('SELECT idle_expires_at<=clock_timestamp() AS expired FROM trustwork.session WHERE id=$1', [f.sessionId]))[0]!.expired === true, 'authority clock expiry');
        await blocker.query('COMMIT');
        assert.equal((await pending).status, 403);
        assert.equal((await q("SELECT o.id FROM trustwork.payment_operation o JOIN trustwork.payment_intent p ON p.id=o.payment_id WHERE p.agreement_id=$1 AND o.kind=$2", [f.agreementId, surface === 'connected-account' ? 'connected_account' : surface])).length, 0);
      } finally {
        await blocker.query('ROLLBACK'); blocker.release(); await pending;
        if (expiry === 'screening') await q('UPDATE trustwork.screening_list SET last_checked_at=clock_timestamp() WHERE baseline');
      }
    });
  }
  await t.test('actual worker cancellation between durable marker and final attempt retains unknown hold', async () => {
    const f = await fresh();
    const v = ok<PaymentView>(await buyer.post('/v1/payments', { agreementId: f.agreementId, budgetId: f.budgetId }), 201);
    await relay.relayOnce();
    const originalGuard = payments.dispatchGuard;
    let resume!: () => void, reached!: () => void;
    const proceed = new Promise<void>((r) => { resume = r; }), ready = new Promise<void>((r) => { reached = r; });
    payments.dispatchGuard = async (...args) => { reached(); await proceed; return originalGuard(...args); };
    const timed = new JobRunner({ ...deps, config: defaultWorkerConfig({ concurrency: 1, externalTimeoutMs: 200 }) });
    const before = fake.calls.length;
    const running = (async () => { await timed.tick(); await timed.idle(); })(); void running.catch(() => {});
    try {
      await ready;
      await new Promise((r) => setTimeout(r, 250)); resume(); await running;
      assert.equal(fake.calls.length, before);
      assert.equal((await q('SELECT state FROM trustwork.payment_operation WHERE payment_id=$1', [v.id]))[0]!.state, 'outcome_unknown');
      assert.deepEqual((await q('SELECT state,effect_pending FROM trustwork.reservation WHERE id=$1', [f.reservationId]))[0], { state: 'reserved', effect_pending: true });
      await runner.tick(); await runner.idle(); assert.equal(fake.calls.length, before);
    } finally { resume(); payments.dispatchGuard = originalGuard; await running; }
  });

  await t.test('raw app and worker cannot fabricate source, rail, account or receipt evidence', async () => {
    for (const raw of [h.pool, pool]) {
      for (const statement of [
        "SELECT trustwork.payments_receipt('{}'::jsonb)",
        "INSERT INTO trustwork.payment_source(agreement_id,binding) VALUES(gen_random_uuid(),'{}')",
        "UPDATE trustwork.payment_rail SET approval_ref='forged'",
        "INSERT INTO trustwork.payment_receipt(connection_id,event_id,operation_id,evidence,disposition) VALUES(gen_random_uuid(),'forged',gen_random_uuid(),'{}','applied')",
      ]) await assert.rejects(raw.query(statement), /permission denied/);
    }
    await assert.rejects(verifier.pool.query('SELECT * FROM trustwork.payment_source'), /permission denied/);
    await assert.rejects(verifier.pool.query('SELECT trustwork.payments_begin(gen_random_uuid(),gen_random_uuid(),1,\'forged\')'), /permission denied/);
    assert.throws(() => new PaymentProviders().get(hub.connectionId), /unavailable/);
    const f = await fresh();
    const v = ok<PaymentView>(await buyer.post('/v1/payments', { agreementId: f.agreementId, budgetId: f.budgetId }), 201); await tick();
    const op = (await q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1', [v.id]))[0]!;
    const evidence = fake.sign({ ...fake.complete(op.id as string, 'succeeded', 'mismatch'), connectedAccountRef: 'forged-account' });
    await assert.rejects(receivePaymentWebhook(runtime, hub.connectionId, evidence.raw, evidence.signature), /binding mismatch/);
    assert.equal((await q('SELECT state,effect_pending FROM trustwork.reservation WHERE id=$1', [f.reservationId]))[0]!.effect_pending, true);
    await assert.rejects(reconcilePayment({ pool, providers: runtime.providers }, op.id as string, AbortSignal.timeout(1000)), /verifier unavailable|binding mismatch/);
  });
});
