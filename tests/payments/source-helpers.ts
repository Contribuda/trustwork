import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createPool, withMaintenance, withPrincipal } from '@trustwork/data';
import { Client, type Harness, type Response } from '../backend/helpers/app.js';
import { PAYMENT_SOURCE_PERMISSIONS, type PaymentAdapterRegistration, type PaymentAuthorizationView, type PaymentSourceAssertion } from '../../packages/contracts/src/payment-sources.js';
import { approvals, staffAssignments, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { paymentSources } from '../../packages/data/src/repositories/payment-sources.js';
import { hubConfig } from '../../packages/data/src/repositories/hubs.js';
import { configActivationDigestInput } from '../../packages/contracts/src/hub-core.js';
import { paymentHub, paymentVerifier, agreement, ok } from './helpers.js';
import { PROVIDER_DEFINITIONS } from '../providers/helpers.js';
import { workerLogin } from '../assistant/helpers.js';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { addLogins, signIn } from '../admin/helpers.js';
import { sessionElevations } from '../../packages/data/src/repositories/identity.js';
import { PaymentSourceAdapters, SignedSyntheticSourceAdapter } from '../../apps/worker/src/payments/source-adapter.js';
import { DeterministicPaymentFake, PaymentProviders } from '../../apps/worker/src/payments/provider.js';
import { startPaymentIngress } from '../../apps/worker/src/payments/ingress.js';
import { registerPayments } from '../../apps/worker/src/payments/index.js';
import { HandlerRegistry } from '../../apps/worker/src/handlers.js';
import { defaultWorkerConfig } from '../../apps/worker/src/config.js';
import { Metrics } from '../../apps/worker/src/metrics.js';
import { OutboxRelay } from '../../apps/worker/src/relay.js';
import { JobRunner } from '../../apps/worker/src/runner.js';

/** Synthetic signed issuers use installation-only registration; no final source projection is inserted by a test. */
export async function sourceWorld(h: Harness) {
  const hub = await paymentHub(h), { a, w } = hub;
  const q = async (query: string, args: unknown[] = []) => (await h.db.admin.query(query, args)).rows;
  await withMaintenance(h.db.admin, async (trx) => {
    for (const role of ['hub-owner', 'compliance-officer', 'moderator'] as const) {
      const def = PROVIDER_DEFINITIONS.find((d) => d.role === role)!;
      await staffRoleDefinitions.release(trx, { ...def, version: 30, permissions: [...def.permissions, ...PAYMENT_SOURCE_PERMISSIONS], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
  });
  for (const [key, role] of [['owner', 'hub-owner'], ['officer', 'compliance-officer'], ['moderator', 'moderator']] as const) {
    const previous = (await q('SELECT id FROM trustwork.staff_role_assignment WHERE person_id=$1 AND hub_id=$2 AND revoked_at IS NULL', [w.people[key], hub.hubId]))[0]!;
    await a.cmd(w.people.founder, (trx, ctx) => staffAssignments.revoke(trx, ctx, previous.id as string));
    const input = { personId: w.people[key], role, scope: { kind: 'hub' as const, hubId: hub.hubId }, definitionVersion: 30 };
    // Non-sensitive synthetic definitions have no sensitive permissions or conflicts; use the owning assignment command.
    const { adminDigests } = await import('../../packages/data/src/repositories/admin.js');
    const digest = adminDigests.assignment({ ...input, breakglass: false });
    const ctx = await a.elevate(w.people.founder);
    const request = await a.as(w.people.founder, (trx) => approvals.request(trx, ctx, { action: 'staff.assign_sensitive_role', scope: input.scope, actionDigest: digest }));
    await a.cmd(w.people.founder2, (trx, c) => approvals.decide(trx, c, request.id, 'approve', digest));
    await a.as(w.people.founder, (trx) => staffAssignments.assign(trx, ctx, { ...input, approvalId: request.id }));
  }
  const jurisdiction = await a.cmd(w.people.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub.hubId, 'jurisdiction', { addedRestrictedPlaces: [] }));
  const approval = await a.approve(w.people.officer, w.people.owner, 'jurisdiction.activate_settings', hub.hubId,
    configActivationDigestInput({ id: jurisdiction.id, hubId: hub.hubId, domain: 'jurisdiction', version: jurisdiction.version, payloadDigest: jurisdiction.payload_digest }));
  await a.cmd(w.people.officer, (trx, ctx) => hubConfig.activate(trx, ctx, jurisdiction.id, null, approval));
  const approveDigest = async (proposer: string, reviewer: string, action: 'payments.register_source_adapter' | 'payments.accept_participant_binding' | 'payments.activate_account_binding', digest: string) => {
    const request = await a.cmd(proposer, (trx, ctx) => approvals.request(trx, ctx, { action, scope: { kind: 'hub', hubId: hub.hubId }, actionDigest: digest }));
    await a.cmd(reviewer, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    return request.id;
  };
  const install = async <T>(fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(h.db.admin, await a.principal(w.people.owner), fn);
  const issuers = {} as Record<'identity_link' | 'account' | 'publisher', { id: string; input: PaymentAdapterRegistration; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] }>;
  const registerIssuer = async (fact: 'identity_link' | 'account' | 'publisher') => {
    const keys = generateKeyPairSync('ed25519');
    const input: PaymentAdapterRegistration = { schemaVersion: 1, hubId: hub.hubId, connectionId: hub.connectionId, fact,
      implementationDigest: createHash('sha256').update(`synthetic-${fact}-v1`).digest('hex'), algorithm: 'ed25519', keyId: `synthetic-${fact}`,
      publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(), evidenceMode: 'synthetic', expiresAt: new Date(Date.now() + 86400000).toISOString() };
    const ctx = await a.elevate(w.people.owner);
    const proposal = await install((trx) => paymentSources.proposeAdapter(trx, ctx, input));
    const approved = await approveDigest(w.people.owner, w.people.officer, 'payments.register_source_adapter', proposal.digest);
    await install((trx) => paymentSources.activateAdapter(trx, ctx, proposal.id, approved));
    issuers[fact] = { id: proposal.id, input, privateKey: keys.privateKey };
  };
  for (const fact of ['identity_link', 'account', 'publisher'] as const) await registerIssuer(fact);
  const role = `source_verifier_test_${randomBytes(4).toString('hex')}`, password = randomBytes(12).toString('hex');
  await h.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await h.db.admin.query(`GRANT USAGE ON SCHEMA trustwork TO ${role}`);
  await h.db.admin.query(`GRANT EXECUTE ON FUNCTION trustwork.payments_source_verifier_registration(uuid),trustwork.payments_source_record_assertion(jsonb) TO ${role}`);
  const sourcePool = createPool({ ...h.db.appConfig, user: role, password, max: 4 });
  const worker = await workerLogin(h), pool = worker.pool(4), verifier = await paymentVerifier(h);
  const fake = new DeterministicPaymentFake();
  const runtime = { pool, receiptPool: verifier.pool, providers: new PaymentProviders(new Map([[hub.connectionId, fake]])), source: { verifierPool: sourcePool,
    adapters: new PaymentSourceAdapters(new Map((['identity_link', 'account'] as const).map((fact) => [issuers[fact].input.implementationDigest, new SignedSyntheticSourceAdapter(issuers[fact].input.implementationDigest, fact)]))) } };
  const ingress = await startPaymentIngress(runtime, 0);
  const send = async (e: PaymentSourceAssertion, signature?: string) => {
    const raw = Buffer.from(JSON.stringify(e));
    return fetch(`http://127.0.0.1:${ingress.port}/payments/sources/${e.registrationId}`, { method: 'POST', body: raw,
      headers: { 'payment-signature': signature ?? sign(null, raw, issuers[e.fact === 'withdrawal' ? e.issuerFact : e.fact].privateKey).toString('hex') } });
  };
  const challenge = async (client: Client, account = false, create?: (input: unknown) => Promise<Response>) => {
    const input = { hubId: hub.hubId, connectionId: hub.connectionId, identityRegistrationId: issuers.identity_link.id, accountRegistrationId: account ? issuers.account.id : null, purpose: account ? 'payment_account' : 'payment_participant' };
    const c = ok<{ id: string; nonce: string }>(await (create ? create(input) : client.post('/v1/payments/sources/challenges', input)), 201);
    const principal = (await h.services().principals.resolve(client.sessionCookie!))!;
    const row = (await q('SELECT person_epoch FROM trustwork.payment_source_challenge WHERE id=$1', [c.id]))[0]!;
    const base = { schemaVersion: 1 as const, challengeId: c.id, nonceDigest: createHash('sha256').update(c.nonce).digest('hex'),
      personId: principal.session.personId, sessionId: principal.session.id, personEpoch: row.person_epoch as number,
      purpose: account ? 'payment_account' as const : 'payment_participant' as const, evidenceMode: 'synthetic' as const, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      connectionId: hub.connectionId, verifiedSubjectRef: `synthetic-subject-${principal.session.personId}` };
    const identity: PaymentSourceAssertion = { ...base, fact: 'identity_link', registrationId: issuers.identity_link.id, audience: issuers.identity_link.id,
      residenceCountry: 'US', residencePlace: 'US-CA', providerEntityRef: account ? `synthetic-entity-${principal.session.personId}` : null };
    const evidence: PaymentSourceAssertion | null = account ? { ...base, purpose: 'payment_account', fact: 'account', registrationId: issuers.account.id, audience: issuers.account.id,
      identityRegistrationId: issuers.identity_link.id, providerEntityRef: `synthetic-entity-${principal.session.personId}`,
      connectionDigest: (await q('SELECT trustwork.providers_config_digest($1) AS digest', [hub.connectionId]))[0]!.digest as string,
      accountRef: `synthetic-account-${c.id}`, accountCountry: 'US', accountPlace: 'US-CA', capabilities: ['payments', 'payouts'], status: 'active' } : null;
    return { input, c, identity, evidence };
  };
  const staffApps: CreatedApp[] = [];
  const staffClient = async (key: 'officer' | 'moderator') => {
    const email = `synthetic-source-${key}-${randomBytes(4).toString('hex')}@example.invalid`;
    await addLogins(h, [[w.people[key], email]]);
    const app = await createApp({ env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', TRUSTWORK_HUB_ID: hub.hubId, MAIL_SECRET_KEY: randomBytes(32).toString('hex') }, pool: h.pool, clock: h.clock });
    staffApps.push(app);
    const client = new Client(app); await signIn(client, email);
    const resolved = (await h.services().principals.resolve(client.sessionCookie!))!;
    await a.as(w.people[key], (trx) => sessionElevations.insert(trx, { sessionId: resolved.session.id, personId: w.people[key], factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 900000) }));
    return client;
  };
  const bind = async (client: Client, account = false, review = true, expiresInMs?: number) => {
    const proof = await challenge(client, account);
    if (expiresInMs !== undefined) { proof.identity.expiresAt = new Date(Date.now() + expiresInMs).toISOString(); if (proof.evidence) proof.evidence.expiresAt = proof.identity.expiresAt; }
    assert.equal((await send(proof.identity)).status, 204);
    if (proof.evidence) assert.equal((await send(proof.evidence)).status, 204);
    const row = (await q('SELECT p.id AS participant, b.id AS account FROM trustwork.payment_participant_binding_version p JOIN trustwork.payment_identity_link_version i ON i.id=p.identity_link_id LEFT JOIN trustwork.payment_account_binding_version b ON b.participant_binding_id=p.id WHERE i.challenge_id=$1', [proof.c.id]))[0]!;
    if (review) {
    const material = await a.cmd(w.people.officer, (trx, ctx) => paymentSources.reviewMaterial(trx, ctx, row.participant as string));
    const approved = await approveDigest(w.people.officer, w.people.moderator, material.action, material.digest);
    await a.cmd(w.people.officer, (trx, ctx) => paymentSources.acceptBinding(trx, ctx, row.participant as string, approved));
    }
    return { participant: row.participant as string, account: row.account as string | null, proof };
  };
  const fresh = async (buyer: Client, seller: Client, buyerId: string, sellerId: string, expiresInMs?: number) => {
    const payer = await bind(buyer, false, true, expiresInMs), payee = await bind(seller, true, true, expiresInMs);
    const accepted = (await agreement(h, buyer, seller, buyerId, sellerId)).agreement;
    const body = { agreementId: accepted.id, payerBindingId: payer.participant, payeeBindingId: payee.participant, accountBindingId: payee.account!, publisherRegistrationId: issuers.publisher.id, rail: 'qr' };
    const authorization = ok<PaymentAuthorizationView>(await buyer.post('/v1/payments/sources/authorizations', body), 201);
    const budget = (await q('SELECT transaction_budget_id FROM trustwork.commercial_order WHERE agreement_id=$1', [accepted.id]))[0]!;
    return { authorization, body, payment: { agreementId: accepted.id, budgetId: budget.transaction_budget_id as string }, payer, payee };
  };
  const registry = new HandlerRegistry(); registerPayments(registry, runtime);
  const deps = { pool, registry, config: defaultWorkerConfig({ concurrency: 1, relayBatchSize: 1000 }), metrics: new Metrics(), log: () => {} };
  const relay = new OutboxRelay(deps), runner = new JobRunner(deps);
  return { ...hub, issuers, registerIssuer, runtime, pool, fake, q, send, challenge, bind, fresh, staffClient, approveDigest, install, relay, runner,
    tick: async () => { await relay.relayOnce(); await runner.tick(); await runner.idle(); },
    async close() { for (const app of staffApps) await app.close(); await ingress.close(); await sourcePool.end(); await verifier.close(); await pool.end(); await worker.close();
      await h.db.admin.query(`REVOKE ALL ON FUNCTION trustwork.payments_source_verifier_registration(uuid),trustwork.payments_source_record_assertion(jsonb) FROM ${role}`);
      await h.db.admin.query(`REVOKE USAGE ON SCHEMA trustwork FROM ${role}`); await h.db.admin.query(`DROP ROLE ${role}`); },
  };
}
