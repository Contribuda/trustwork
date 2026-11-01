import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { paymentSources } from '../../packages/data/src/repositories/payment-sources.js';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import { payments } from '../../packages/data/src/repositories/payments.js';
import { receivePaymentWebhook, reconcilePayment } from '../../apps/worker/src/payments/index.js';
import type { PaymentSourceAssertion } from '../../packages/contracts/src/payment-sources.js';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { screenEveryoneClear } from '../screening-gates/helpers.js';
import type { PaymentView } from '../../packages/contracts/src/payments.js';
import { sourceWorld } from './source-helpers.js';
import { ok } from './helpers.js';
const h = await startHarness('payment_sources');
test('PAY-001 registered synthetic source through actual API, signed ingress and final worker', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const w = await sourceWorld(h).catch(async (e: unknown) => { await h.close(); throw e; }); t.after(async () => { await w.close(); await h.close(); });
  await screenEveryoneClear(h.db.admin);
  const buyer = h.client(), seller = h.client(), outsider = h.client();
  await login(buyer, 'petr'); await login(seller, 'carl'); await login(outsider, 'anna');
  await t.test('separate immutable bilateral authorization is required; source publication is an actual command effect', async () => {
    const f = await w.fresh(buyer, seller, seed.people.petr, seed.people.carl);
    assert.equal((await buyer.post('/v1/payments', f.payment)).status, 403);
    assert.equal((await outsider.get(`/v1/payments/sources/authorizations/${f.authorization.id}`)).status, 403);
    assert.equal((await outsider.post(`/v1/payments/sources/authorizations/${f.authorization.id}/accept`, { digest: f.authorization.digest })).status, 403);
    ok(await buyer.post(`/v1/payments/sources/authorizations/${f.authorization.id}/accept`, { digest: f.authorization.digest }));
    assert.equal((await buyer.post('/v1/payments', f.payment)).status, 403);
    assert.equal((await seller.post(`/v1/payments/sources/authorizations/${f.authorization.id}/accept`, { digest: 'a'.repeat(64) })).status, 403);
    ok(await seller.post(`/v1/payments/sources/authorizations/${f.authorization.id}/accept`, { digest: f.authorization.digest }));
    const payment = ok<PaymentView>(await buyer.post('/v1/payments', f.payment), 201);
    await w.tick();
    assert.equal(w.fake.calls.length, 1);
    assert.equal(ok<PaymentView>(await buyer.get(`/v1/payments/${payment.id}`)).state, 'outcome_unknown');
    assert.equal((await w.q('SELECT * FROM trustwork.payment_source')).length, 0);
    assert.equal((await w.q('SELECT * FROM trustwork.payment_source_version')).length, 1);
  });

  await t.test('signed ingress binds exact actor, session, epoch, challenge, issuer, subject and provider entity; replay is immutable', async () => {
    const proof = await w.challenge(seller, true);
    assert.equal((await w.send(proof.identity, '0'.repeat(128))).status, 400);
    for (const patch of [{ personId: seed.people.petr }, { sessionId: randomUUID() }, { personEpoch: 900 }, { challengeId: randomUUID() },
      { nonceDigest: 'a'.repeat(64) }, { audience: randomUUID() }, { connectionId: randomUUID() }, { purpose: 'payment_participant' },
      { issuedAt: new Date(Date.now() + 60000).toISOString() }, { expiresAt: new Date(Date.now() - 1000).toISOString() },
      { residencePlace: 'US' }, { residenceCountry: 'CA' }, { verified: true }]) {
      assert.equal((await w.send({ ...proof.identity, ...patch } as PaymentSourceAssertion)).status, 400, JSON.stringify(patch));
    }
    assert.equal((await w.q('SELECT * FROM trustwork.payment_identity_link_version WHERE challenge_id=$1', [proof.c.id])).length, 0);
    assert.equal((await w.send(proof.identity)).status, 204);
    assert.equal((await w.send(proof.identity)).status, 204);
    assert.equal((await w.send({ ...proof.identity, verifiedSubjectRef: 'synthetic-other' } as PaymentSourceAssertion)).status, 400);
    for (const patch of [{ verifiedSubjectRef: 'synthetic-other' }, { providerEntityRef: 'synthetic-other' }, { identityRegistrationId: randomUUID() },
      { connectionDigest: 'a'.repeat(64) }, { accountCountry: 'CA' }, { accountPlace: 'US' }, { status: 'revoked' }, { capabilities: [] }, { capabilities: ['payments'] }]) {
      assert.equal((await w.send({ ...proof.evidence!, ...patch } as PaymentSourceAssertion)).status, 400, JSON.stringify(patch));
    }
    assert.equal((await w.send(proof.evidence!)).status, 204);
    assert.equal((await w.send(proof.evidence!)).status, 204);
    assert.equal((await w.send({ ...proof.evidence!, accountRef: 'synthetic-replacement' } as PaymentSourceAssertion)).status, 400);
    const own = ok<unknown>(await seller.get('/v1/payments/sources/bindings'));
    assert.doesNotMatch(JSON.stringify(own), /synthetic-(?:account|subject|entity)|residenceCountry|accountCountry|publicKey/);
    for (const pool of [h.pool, w.pool]) {
      for (const fn of ['payments_source_record_assertion($1::jsonb)', 'payments_source_verifier_registration($1::uuid)',
        "payments_propose_source_adapter('{}'::jsonb,$1::jsonb)", "payments_activate_source_adapter('{}'::jsonb,$1::uuid,NULL)"])
        await assert.rejects(pool.query(`SELECT trustwork.${fn}`, [fn.includes('jsonb)') ? JSON.stringify(proof.identity) : w.issuers.identity_link.id]), /permission denied/);
      for (const table of ['payment_source_registration', 'payment_adapter_activation', 'payment_source_challenge', 'payment_identity_link_version',
        'payment_participant_binding_version', 'payment_account_evidence', 'payment_account_binding_version', 'payment_binding_review',
        'payment_authorization_version', 'payment_authorization_acceptance', 'payment_source_version', 'payment_source_current']) {
        await assert.rejects(pool.query(`SELECT * FROM trustwork.${table}`), /permission denied/);
        await assert.rejects(pool.query(`INSERT INTO trustwork.${table} DEFAULT VALUES`), /permission denied/);
      }
    }
  });
  await t.test('staff HTTP independent review and exact issuer withdrawal never expose private evidence', async () => {
    const staff = await w.staffClient('officer');
    const proof = await w.challenge(seller, true);
    assert.equal((await w.send(proof.identity)).status, 204); assert.equal((await w.send(proof.evidence!)).status, 204);
    const [row] = await w.q('SELECT p.id,e.id AS evidence,e.digest FROM trustwork.payment_participant_binding_version p JOIN trustwork.payment_identity_link_version i ON i.id=p.identity_link_id JOIN trustwork.payment_account_evidence e ON e.identity_link_id=i.id WHERE i.challenge_id=$1', [proof.c.id]);
    const url = `/v1/admin/payments/source-bindings/${row!.id}`;
    assert.equal((await outsider.post(`${url}/review`, { reason: 'Synthetic negative' })).status, 403);
    const material = ok<{ digest: string; action: 'payments.activate_account_binding' }>(await staff.post(`${url}/review`, { reason: 'Synthetic independent technical review' }));
    assert.doesNotMatch(JSON.stringify(material), /synthetic-(?:account|subject|entity)|residenceCountry|accountCountry|publicKey/);
    const bad = await w.approveDigest(w.w.people.officer, w.w.people.owner, material.action, material.digest);
    assert.equal((await staff.post(`${url}/activate`, { reason: 'Synthetic issuer cannot independently review', approvalId: bad })).status, 403);
    const good = await w.approveDigest(w.w.people.officer, w.w.people.moderator, material.action, material.digest);
    ok(await staff.post(`${url}/activate`, { reason: 'Synthetic distinct reviewer', approvalId: good }));
    const withdrawal: PaymentSourceAssertion = { schemaVersion: 1, fact: 'withdrawal', issuerFact: 'account', registrationId: w.issuers.account.id,
      audience: w.issuers.account.id, recordId: row!.evidence as string, digest: row!.digest as string, issuedAt: new Date().toISOString(), evidenceMode: 'synthetic' };
    assert.equal((await w.send({ ...withdrawal, digest: 'a'.repeat(64) })).status, 400);
    assert.equal((await w.send(withdrawal)).status, 204); assert.equal((await w.send(withdrawal)).status, 204);
    assert.ok((await w.q('SELECT revoked_at FROM trustwork.payment_account_evidence WHERE id=$1', [row!.evidence]))[0]!.revoked_at);
    ok(await staff.post(`/v1/admin/payments/source-bindings/${w.issuers.account.id}/revoke`, { reason: 'Synthetic issuer withdrawal', kind: 'registration' }));
    assert.equal((await w.send(proof.evidence!)).status, 400);
    await w.registerIssuer('account');
  });
  await t.test('installation activation consumes only the exact current independent action and digest', async () => {
    for (const wrong of ['digest', 'action', 'reviewer expiry', 'proposer epoch'] as const) {
      const ctx = await w.a.elevate(w.w.people.owner);
      const proposal = await w.install((trx) => paymentSources.proposeAdapter(trx, ctx, w.issuers.account.input));
      const digest = wrong === 'digest' ? 'a'.repeat(64) : proposal.digest;
      const action = wrong === 'action' ? 'payments.activate_account_binding' : 'payments.register_source_adapter';
      const requested = await w.a.cmd(w.w.people.owner, (trx, c) => approvals.request(trx, c, { action, scope: { kind: 'hub', hubId: w.hubId }, actionDigest: digest }));
      const review = await w.a.elevate(w.w.people.officer, wrong === 'reviewer expiry' ? 1 : 900);
      await w.a.as(w.w.people.officer, (trx) => approvals.decide(trx, review, requested.id, 'approve', digest));
      if (wrong === 'reviewer expiry') await delay(1050);
      if (wrong === 'proposer epoch') await w.q('UPDATE trustwork.person SET authz_epoch=authz_epoch+1 WHERE id=$1', [w.w.people.owner]);
      await assert.rejects(w.install((trx) => paymentSources.activateAdapter(trx, ctx, proposal.id, requested.id)));
      assert.equal((await w.q('SELECT * FROM trustwork.payment_adapter_activation WHERE registration_id=$1', [proposal.id])).length, 0);
    }
  });
  const publish = async (f: Awaited<ReturnType<typeof w.fresh>>) => {
    for (const client of [buyer, seller]) ok(await client.post(`/v1/payments/sources/authorizations/${f.authorization.id}/accept`, { digest: f.authorization.digest }));
  };
  const wait = async (predicate: () => Promise<boolean>) => { for (let n = 0; n < 200; n++) { if (await predicate()) return; await delay(10); } assert.fail('expected observed database wait'); };
  type F = Awaited<ReturnType<typeof w.fresh>>;
  await w.q(`CREATE FUNCTION trustwork.source_api_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='payments.requested' THEN PERFORM pg_advisory_xact_lock(827003,1); END IF; RETURN NEW; END $$`);
  await w.q('CREATE TRIGGER source_api_barrier BEFORE INSERT ON trustwork.outbox_event FOR EACH ROW EXECUTE FUNCTION trustwork.source_api_barrier()');
  const targets: Array<{ name: string; target(f: F): Promise<[string, string]>; rotate?: 'identity_link' | 'account' | 'publisher' }> = [
    ...(['identity_link', 'account', 'publisher'] as const).map((fact) => ({ name: `${fact} registration`, target: async (): Promise<[string, string]> => ['payment_source_registration', w.issuers[fact].id], rotate: fact })),
    ...(['payer', 'payee'] as const).flatMap((side) => [
      { name: `${side} identity`, target: async (f: F): Promise<[string, string]> => ['payment_identity_link_version', (await w.q('SELECT id FROM trustwork.payment_identity_link_version WHERE challenge_id=$1', [f[side].proof.c.id]))[0]!.id as string] },
      { name: `${side} participant`, target: async (f: F): Promise<[string, string]> => ['payment_participant_binding_version', f[side].participant] },
      { name: `${side} independent review`, target: async (f: F): Promise<[string, string]> => ['payment_binding_review', (await w.q('SELECT id FROM trustwork.payment_binding_review WHERE participant_binding_id=$1', [f[side].participant]))[0]!.id as string] },
    ]),
    { name: 'account evidence', target: async (f): Promise<[string, string]> => ['payment_account_evidence', (await w.q('SELECT account_evidence_id FROM trustwork.payment_account_binding_version WHERE id=$1', [f.payee.account]))[0]!.account_evidence_id as string] },
    { name: 'account binding', target: async (f): Promise<[string, string]> => ['payment_account_binding_version', f.payee.account!] },
    { name: 'bilateral authorization', target: async (f): Promise<[string, string]> => ['payment_authorization_version', f.authorization.id] },
    { name: 'published source', target: async (f): Promise<[string, string]> => ['payment_source_version', (await w.q('SELECT id FROM trustwork.payment_source_version WHERE authorization_id=$1', [f.authorization.id]))[0]!.id as string] },
  ];
  for (const target of targets) for (const surface of ['create', 'confirm', 'refund', 'payout', 'connected_account', 'worker', 'worker_confirm', 'worker_refund', 'worker_payout', 'worker_connected_account'] as const) for (const revokeFirst of [true, false]) {
    await t.test(`${target.name}; real ${surface}; ${revokeFirst ? 'revoker' : 'payment'} first`, async () => {
      const f = await w.fresh(buyer, seller, seed.people.petr, seed.people.carl); await publish(f);
      const [table, id] = await target.target(f);
      const isWorker = surface.startsWith('worker');
      const kind = surface === 'worker' ? 'create' : surface.replace(/^worker_/, '') as 'create' | 'confirm' | 'refund' | 'payout' | 'connected_account';
      const method = kind === 'connected_account' ? 'connectedAccount' : kind;
      let payment: PaymentView | undefined;
      if (isWorker || kind !== 'create') payment = ok<PaymentView>(await buyer.post('/v1/payments', f.payment), 201);
      if (kind !== 'create') {
        const [op] = await w.q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1', [payment!.id]);
        w.fake.plan(op!.id as string, kind === 'confirm' ? 'requires_confirmation' : 'succeeded'); await w.tick();
        if (isWorker) ok(await buyer.post(`/v1/payments/${payment!.id}/${kind === 'connected_account' ? 'connected-account' : kind}`, {}));
      }
      if (isWorker) {
        const [op] = await w.q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1 AND kind=$2', [payment!.id, kind]);
        w.fake.plan(op!.id as string, 'outcome_unknown');
      }
      const request = () => buyer.post(kind === 'create' ? '/v1/payments' : `/v1/payments/${payment!.id}/${kind === 'connected_account' ? 'connected-account' : kind}`, kind === 'create' ? f.payment : {});
      const writer = await h.db.admin.connect(), barrier = await h.db.admin.connect();
      let run: Promise<unknown> | undefined, write: Promise<unknown> | undefined, resume: (() => void) | undefined;
      const original = payments.dispatchGuard, invoke = w.fake[method].bind(w.fake);
      const before = w.fake.calls.length;
      let response: Awaited<ReturnType<typeof buyer.post>> | undefined;
      try {
        await writer.query('BEGIN'); await writer.query("SET LOCAL statement_timeout='5s'");
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number;
        let reached!: () => void;
        const ready = new Promise<void>((r) => { reached = r; }), proceed = new Promise<void>((r) => { resume = r; });
        if (isWorker) {
          if (revokeFirst) payments.dispatchGuard = async (...args) => { reached(); await proceed; return original(...args); };
          else w.fake[method] = async (i, signal) => { reached(); await proceed; return invoke(i, signal); };
          run = w.tick();
          await Promise.race([ready, delay(3000).then(() => { throw new Error('actual worker boundary not reached'); })]);
        }
        if (revokeFirst) {
          await writer.query(`UPDATE trustwork.${table} SET revoked_at=clock_timestamp() WHERE id=$1`, [id]);
          if (isWorker) { resume!(); await run; }
          else response = await request();
          await writer.query('COMMIT');
          assert.equal(w.fake.calls.length, before);
          if (response) assert.equal(response.status, 403, JSON.stringify(response));
        } else {
          if (!isWorker) {
            await barrier.query('SELECT pg_advisory_lock(827003,1)');
            run = request().then((r) => { response = r; });
            await wait(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%payments_%'")).length > 0);
          }
          write = writer.query(`UPDATE trustwork.${table} SET revoked_at=clock_timestamp() WHERE id=$1`, [id]);
          await wait(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).length > 0);
          if (isWorker) resume!(); else await barrier.query('SELECT pg_advisory_unlock(827003,1)');
          await run; await write; await writer.query('COMMIT');
          if (response) assert.equal(response.status, kind === 'create' ? 201 : 200, JSON.stringify(response));
          if (isWorker) assert.equal(w.fake.calls.length, before + 1);
        }
        if (isWorker) {
          const [op] = await w.q('SELECT * FROM trustwork.payment_operation WHERE payment_id=$1 AND kind=$2', [payment!.id, kind]);
          const [hold] = await w.q('SELECT r.state,r.effect_pending FROM trustwork.reservation r JOIN trustwork.payment_intent p ON p.reservation_id=r.id WHERE p.id=$1', [payment!.id]);
          assert.deepEqual(hold, { state: kind === 'create' || kind === 'confirm' ? 'reserved' : 'settled', effect_pending: true });
          await w.runner.tick(); await w.runner.idle(); assert.equal(w.fake.calls.length, before + (revokeFirst ? 0 : 1));
          if (!revokeFirst) {
            const signed = w.fake.sign(w.fake.complete(op!.id as string, 'succeeded', `late-source-${op!.id}`));
            assert.equal(await receivePaymentWebhook(w.runtime, w.connectionId, signed.raw, signed.signature), 'applied');
          }
        }
      } finally {
        resume?.(); payments.dispatchGuard = original; w.fake[method] = invoke;
        await barrier.query('SELECT pg_advisory_unlock_all()'); await writer.query('ROLLBACK');
        await Promise.allSettled([run, write]); writer.release(); barrier.release();
        if (target.rotate) await w.registerIssuer(target.rotate);
        await w.relay.relayOnce(); await w.q("UPDATE trustwork.job SET state='dead' WHERE kind='payments.dispatch' AND state='queued'");
      }
    });
  }

  await t.test('unknown original holds survive source withdrawal, replacement attempts and conflicting provider evidence', async () => {
    const f = await w.fresh(buyer, seller, seed.people.petr, seed.people.carl); await publish(f);
    const payment = ok<PaymentView>(await buyer.post('/v1/payments', f.payment), 201);
    const op = (await w.q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1', [payment.id]))[0]!.id as string;
    w.fake.plan(op, 'succeeded', true); await w.tick();
    const before = w.fake.calls.length;
    ok(await buyer.post(`/v1/payments/sources/${f.authorization.id}/revoke`, { kind: 'authorization' }));
    const replacement = ok<{ id: string; digest: string }>(await buyer.post('/v1/payments/sources/authorizations', f.body), 201);
    ok(await buyer.post(`/v1/payments/sources/authorizations/${replacement.id}/accept`, { digest: replacement.digest }));
    assert.equal((await seller.post(`/v1/payments/sources/authorizations/${replacement.id}/accept`, { digest: replacement.digest })).status, 403);
    assert.equal((await buyer.post('/v1/payments', f.payment)).status, 403);
    const original = w.fake.effects.get(op)!;
    const mismatch = w.fake.sign({ ...original, eventId: `wrong-source-${op}`, connectedAccountRef: 'synthetic-other-account' });
    await assert.rejects(receivePaymentWebhook(w.runtime, w.connectionId, mismatch.raw, mismatch.signature), /evidence binding mismatch/);
    assert.equal((await w.q('SELECT event_id FROM trustwork.payment_receipt WHERE event_id=$1', [`wrong-source-${op}`])).length, 0);
    assert.deepEqual((await w.q('SELECT r.state,r.effect_pending FROM trustwork.reservation r JOIN trustwork.payment_intent p ON p.reservation_id=r.id WHERE p.id=$1', [payment.id]))[0], { state: 'reserved', effect_pending: true });
    assert.equal(await reconcilePayment(w.runtime, op, AbortSignal.timeout(1000)), 'applied');
    assert.equal(w.fake.calls.length, before);
    assert.equal((await w.q('SELECT id FROM trustwork.payment_intent WHERE agreement_id=$1', [f.payment.agreementId])).length, 1);
  });
  for (const surface of ['create', 'confirm', 'refund', 'payout', 'connected_account', 'worker'] as const) {
    await t.test(`signed source deadline passes during actual ${surface} domain wait`, async () => {
      const f = await w.fresh(buyer, seller, seed.people.petr, seed.people.carl, 3000); await publish(f);
      let payment: PaymentView | undefined;
      if (surface !== 'create') payment = ok(await buyer.post('/v1/payments', f.payment), 201);
      if (surface !== 'create' && surface !== 'worker') {
        const [op] = await w.q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1', [payment!.id]);
        w.fake.plan(op!.id as string, surface === 'confirm' ? 'requires_confirmation' : 'succeeded'); await w.tick();
      }
      const before = w.fake.calls.length, blocker = await h.db.admin.connect();
      let run: Promise<unknown> | undefined, resume: (() => void) | undefined;
      const original = payments.dispatchGuard;
      try {
        await blocker.query('BEGIN');
        if (surface === 'worker') {
          let reached!: () => void;
          const ready = new Promise<void>((r) => { reached = r; }), proceed = new Promise<void>((r) => { resume = r; });
          payments.dispatchGuard = async (...args) => { reached(); await proceed; return original(...args); };
          run = w.tick(); await ready;
          await blocker.query('SELECT connection_id FROM trustwork.payment_rail WHERE connection_id=$1 FOR UPDATE', [w.connectionId]);
          resume!();
        } else {
          await blocker.query('SELECT pg_advisory_xact_lock(827003,1)');
          run = buyer.post(surface === 'create' ? '/v1/payments' : `/v1/payments/${payment!.id}/${surface === 'connected_account' ? 'connected-account' : surface}`, surface === 'create' ? f.payment : {});
        }
        await wait(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%payments_%'")).length > 0);
        await delay(Math.max(0, Date.parse(f.authorization.expiresAt) - Date.now() + 40));
        await blocker.query('COMMIT'); const response = await run;
        if (surface !== 'worker') assert.equal((response as { status: number }).status, 403, JSON.stringify(response));
        else assert.deepEqual((await w.q('SELECT r.state,r.effect_pending FROM trustwork.reservation r JOIN trustwork.payment_intent p ON p.reservation_id=r.id WHERE p.id=$1', [payment!.id]))[0], { state: 'reserved', effect_pending: true });
        assert.equal(w.fake.calls.length, before);
      } finally { resume?.(); payments.dispatchGuard = original; await blocker.query('ROLLBACK'); blocker.release(); await run; }
    });
  }
});
