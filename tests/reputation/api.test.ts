import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { appeals } from '../../packages/data/src/repositories/admin.js';
import {
  REPUTATION_EVENT_PAYLOAD_KEYS, type AutomatedLimitation, type ConfirmationInboxView, type ReputationBuilderOwnView, type ReputationBuilderPublicView,
} from '../../packages/contracts/src/reputation-builder.js';
import type { OwnSnapshotView } from '../../apps/api/src/modules/trust/contracts.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { approvedChange, as, baselinePlan, buildAgreement, businessDate, staffWorld, type Fixture } from '../trust/helpers.js';
import { claimAndDecide } from './helpers.js';

/**
 * REP-001 through the HTTP API (real database, runtime role, CSRF, idempotency): the subject records and checks a
 * credential through the fake register, adds portfolio work, asks a real counterparty to confirm (a request without a
 * recorded relationship is refused with a reason code, evidence and an appeal link, and the refusal can be appealed),
 * the counterparty answers in person, timeliness excludes the client-caused delay, appeals reach DATA-002's queue, the
 * public reads checked facts and consented work only, and no entitlement, payment, sponsorship or staff action changes
 * a snapshot or the builder's output.
 */
const HUB_ID = '00000000-0000-4000-8000-0000000e0f02';
process.env.TRUSTWORK_HUB_ID = HUB_ID;
const h = await startHarness('reputation_api');

function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
const details = (r: Response) => (r.body as { details?: { reason?: string; limitation?: AutomatedLimitation } }).details ?? {};
/** Every automated limitation names its reason code, its explanation and a way to appeal. */
function assertLimitation(l: AutomatedLimitation | null | undefined, code: string): AutomatedLimitation {
  assert.ok(l, `limitation ${code} present`);
  assert.equal(l.reasonCode, code);
  assert.equal(l.explanationKey, `reputation.limitation.${code}`);
  assert.equal(l.appeal.method, 'POST');
  assert.match(l.appeal.href, /^\/v1\/reputation-builder\/(appeals|limitations\/appeals)$/);
  assert.ok((l.appeal.subject === null) !== (l.appeal.limitation === null));
  return l;
}

test('reputation builder API: credentials, portfolio, relationship-bound confirmations, fair timeliness, limitations with appeals, payment-blind', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const f: Fixture = { admin: h.db.admin, app: h.db.app, people: { petr: seed.people.petr, boris: seed.people.boris, carl: seed.people.carl, xenia: seed.people.xenia, anna: seed.people.anna }, supplier: seed.companies.supplier, project: seed.project };
  const staff = await staffWorld(f, HUB_ID);
  const login_ = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const [petr, boris, carl] = [await login_('petr'), await login_('boris'), await login_('carl')];
  const anonymous = h.client();
  const petrParty = { kind: 'person' as const, id: f.people.petr };
  const supplierParty = { kind: 'company' as const, id: f.supplier };
  const OWN = `/v1/reputation-builder/companies/${f.supplier}/own`;
  const A = await buildAgreement(f, businessDate(-5), 'Synthetic patio over HTTP');
  let view: ReputationBuilderOwnView;

  await t.test('the subject reads its own builder view; everyone else gets not found', async () => {
    expectError(await anonymous.get(OWN), 401, 'auth.session_invalid');
    for (const outsider of [petr, carl]) expectError(await outsider.get(OWN), 404, 'access.not_found');
    view = ok<ReputationBuilderOwnView>(await boris.get(OWN));
    assert.deepEqual([view.credentials, view.portfolio, view.confirmationsSent, view.publicScore], [[], [], [], null]);
  });

  let credentialId = '';
  await t.test('credentials: recorded by the holder, checked through the hub\'s register adapter (a fake), status derived', async () => {
    const body = {
      holder: supplierParty, kind: 'licence', jurisdiction: 'US-CA', credentialType: 'US-CA-CSLB-C8', issuer: 'Synthetic licence board', number: 'SYN-OK-2031-06-30-77', classification: 'C-8 concrete',
      coverage: null, validFrom: '2026-01-01', validUntil: null, visibility: 'public', supersedesId: null,
    };
    expectError(await petr.post('/v1/reputation-builder/credentials', body), 403, 'access.forbidden');
    expectError(await boris.post('/v1/reputation-builder/credentials', { ...body, coverage: { minorUnits: '100', currency: 'USD' } }), 422, 'validation.schema');
    view = ok<ReputationBuilderOwnView>(await boris.post('/v1/reputation-builder/credentials', body, { idempotencyKey: 'rep-cred-1' }), 201);
    assert.deepEqual(ok<ReputationBuilderOwnView>(await boris.post('/v1/reputation-builder/credentials', body, { idempotencyKey: 'rep-cred-1' }), 201), view, 'a retry replays the result');
    credentialId = view.credentials[0]!.id;
    assert.equal(view.credentials[0]!.status, 'self_declared', 'stated, not checked');
    expectError(await petr.post(`/v1/reputation-builder/credentials/${credentialId}/checks`, {}), 404, 'access.not_found');
    view = ok<ReputationBuilderOwnView>(await boris.post(`/v1/reputation-builder/credentials/${credentialId}/checks`, {}), 201);
    assert.equal(view.credentials[0]!.status, 'checked');
    assert.deepEqual(view.credentials[0]!.checks.map((c) => [c.outcome, c.hubId, c.registerCode, c.registerValidUntil]), [['match', HUB_ID, 'fake.synthetic-register', '2031-06-30']]);
    const suspended = ok<ReputationBuilderOwnView>(await boris.post('/v1/reputation-builder/credentials', { ...body, kind: 'insurance', credentialType: 'US-GL-INSURANCE', number: 'SYN-DOWN-1', coverage: { minorUnits: '100000000', currency: 'USD' }, visibility: 'private' }), 201);
    const insurance = suspended.credentials.find((c) => c.kind === 'insurance')!;
    view = ok<ReputationBuilderOwnView>(await boris.post(`/v1/reputation-builder/credentials/${insurance.id}/checks`, {}), 201);
    const unknown = view.credentials.find((c) => c.id === insurance.id)!;
    assert.deepEqual([unknown.status, unknown.checks[0]!.outcome], ['self_declared', 'unavailable'], 'an unavailable register is unknown, never checked and never a failure');
  });

  let entryId = '';
  let requestId = '';
  await t.test('confirmations: a request without a recorded relationship is refused with a reason, evidence and an appeal link; the refusal can be appealed', async () => {
    view = ok<ReputationBuilderOwnView>(await boris.post('/v1/reputation-builder/portfolio', {
      holder: supplierParty, context: { kind: 'agreement', id: A.agreement.id }, externalDescription: null, title: 'Synthetic patio', role: 'Supplier and installer',
      period: { from: null, to: null }, scopeSummary: 'Pavers delivered and laid', visibility: 'public', supersedesId: null,
    }), 201);
    entryId = view.portfolio[0]!.id;
    assert.deepEqual([view.portfolio[0]!.confirmation, view.portfolio[0]!.publiclyShown], ['self_reported', false], 'platform work waits for the client\'s confirmation and consent');
    const ask = (over: Record<string, unknown> = {}) => ({
      requester: supplierParty, addressedTo: petrParty, context: { kind: 'agreement', id: A.agreement.id }, portfolioEntryId: entryId, statementKind: 'delivered',
      statement: 'Synthetic: 40 m2 of pavers delivered and laid', attestation: { noIncentiveOffered: true, notEmployeeOrRelative: true }, ...over,
    });
    expectError(await boris.post('/v1/reputation-builder/confirmations', ask({ attestation: { noIncentiveOffered: false, notEmployeeOrRelative: true } })), 422, 'validation.schema');
    expectError(await boris.post('/v1/reputation-builder/confirmations', ask({ incentive: { discount: '10%' } })), 422, 'validation.unknown_field');
    const refused = await boris.post('/v1/reputation-builder/confirmations', ask({ addressedTo: { kind: 'person', id: f.people.carl }, portfolioEntryId: null }));
    expectError(refused, 403, 'access.forbidden');
    assert.equal(details(refused).reason, 'no_recorded_relationship');
    const limitation = assertLimitation(details(refused).limitation, 'no_recorded_relationship');
    assert.deepEqual(limitation.evidence, [{ kind: 'agreement', id: A.agreement.id }]);
    assert.equal(limitation.appeal.limitation?.scope, 'confirmation_request');
    const appealed = ok<{ subject: { kind: string }; status: string }>(await boris.post(limitation.appeal.href, { limitation: limitation.appeal.limitation, reason: 'Synthetic: Carl inspected the work for the owner' }), 201);
    assert.deepEqual([appealed.subject.kind, appealed.status], ['automated_limitation', 'submitted']);
    expectError(await carl.post(limitation.appeal.href, { limitation: limitation.appeal.limitation, reason: 'not mine' }), 404, 'access.not_found');
    view = ok<ReputationBuilderOwnView>(await boris.get(OWN));
    assert.deepEqual(view.limitations.map((l) => [l.reasonCode, l.appeal]), [['no_recorded_relationship', 'submitted']]);

    view = ok<ReputationBuilderOwnView>(await boris.post('/v1/reputation-builder/confirmations', ask()), 201);
    const sent = view.confirmationsSent[0]!;
    requestId = sent.id;
    assert.equal(sent.status, 'requested');
    assert.ok(sent.reminderAvailableAt && Date.parse(sent.reminderAvailableAt) - Date.parse(sent.requestedAt) === 3 * 86_400_000, 'one reminder, after three days');
    const again = await boris.post('/v1/reputation-builder/confirmations', ask());
    expectError(again, 409, 'validation.revision_conflict');
    assertLimitation(details(again).limitation, 'already_requested');
    const early = await boris.post(`/v1/reputation-builder/confirmations/${requestId}/reminder`, {});
    expectError(early, 409, 'validation.revision_conflict');
    assert.deepEqual([details(early).reason, details(early).limitation], ['reminder_too_early', undefined], 'a state conflict, not a limitation of the person');
  });

  await t.test('the counterparty answers in person, once; the answer confirms the portfolio entry and, with consent, shows it publicly', async () => {
    const inbox = ok<ConfirmationInboxView>(await petr.get(`/v1/reputation-builder/people/${f.people.petr}/inbox`));
    assert.deepEqual(inbox.requests.map((r) => [r.id, r.statement]), [[requestId, 'Synthetic: 40 m2 of pavers delivered and laid']]);
    expectError(await carl.get(`/v1/reputation-builder/people/${f.people.petr}/inbox`), 404, 'access.not_found');
    const reply = { onBehalfOf: petrParty, decision: 'confirmed', comment: null, consentToShow: true, attestation: { noIncentiveReceived: true, notEmployeeOrRelative: true } };
    expectError(await boris.post(`/v1/reputation-builder/confirmations/${requestId}/response`, reply), 403, 'access.forbidden');
    expectError(await petr.post(`/v1/reputation-builder/confirmations/${requestId}/response`, { ...reply, decision: 'declined', consentToShow: false }), 422, 'validation.schema');
    expectError(await petr.post(`/v1/reputation-builder/confirmations/${requestId}/response`, { ...reply, actor: { via: 'agent', mandateId: 'mandate-synthetic' } }), 422, 'validation.unknown_field');
    const race = await Promise.all([petr.post(`/v1/reputation-builder/confirmations/${requestId}/response`, reply), petr.post(`/v1/reputation-builder/confirmations/${requestId}/response`, reply)]);
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
    view = ok<ReputationBuilderOwnView>(await boris.get(OWN));
    assert.equal(view.confirmationsSent[0]!.status, 'confirmed');
    assert.deepEqual([view.portfolio[0]!.confirmation, view.portfolio[0]!.publiclyShown], ['client_confirmed', true]);
  });

  await t.test('timeliness: derived from execution records; the client-caused delay is excluded with a reason and an appeal path', async () => {
    const B = await buildAgreement(f, businessDate(-5), 'Synthetic change over HTTP');
    const plan = await baselinePlan(f);
    await approvedChange(f, plan, { agreementId: B.agreement.id, cause: 'owner_request', accountable: { person: f.people.petr }, impactDays: 10 });
    await claimAndDecide(f, A.agreement.id, A.byKind.deliver);
    await claimAndDecide(f, B.agreement.id, B.byKind.deliver);
    view = ok<ReputationBuilderOwnView>(await boris.get(OWN));
    const ofB = view.timeliness.observations.find((o) => o.agreementId === B.agreement.id)!;
    const ofA = view.timeliness.observations.find((o) => o.agreementId === A.agreement.id)!;
    assert.deepEqual([ofA.outcome, ofA.counted, ofA.limitation], ['late', true, null]);
    assert.deepEqual([ofB.outcome, ofB.counted, ofB.attribution], ['excused', false, 'counterparty']);
    const excluded = assertLimitation(ofB.limitation, 'excluded_client_caused_change');
    assert.deepEqual(excluded.appeal.subject, { kind: 'timeliness_observation', id: ofB.id });
    assert.ok(excluded.evidence.some((e) => e.kind === 'plan_change'), 'the evidence names the owner\'s plan change');
    assert.deepEqual([view.timeliness.summary.counted, view.timeliness.summary.late, view.timeliness.summary.excluded.excluded_client_caused_change], [1, 1, 1]);
    // The subject appeals the late observation: it goes to EXE-001's appeal on the source observation and stops counting.
    const appeal = ok<{ subject: { kind: string; id: string } }>(await boris.post(ofA.appeal.href, { subject: ofA.appeal.subject, reason: 'Synthetic: the site was closed by the owner' }), 201);
    assert.deepEqual(appeal.subject, { kind: 'performance_observation', id: ofA.sourceObservationId });
    expectError(await petr.post(ofA.appeal.href, { subject: ofA.appeal.subject, reason: 'not mine' }), 404, 'access.not_found');
    view = ok<ReputationBuilderOwnView>(await boris.get(OWN));
    const appealedA = view.timeliness.observations.find((o) => o.id === ofA.id)!;
    assertLimitation(appealedA.limitation, 'excluded_appeal_pending');
    assert.equal(view.timeliness.summary.counted, 0);
    for (const o of view.timeliness.observations) assert.ok(o.counted || o.limitation, 'every excluded observation carries its limitation');
  });

  await t.test('the public reads checked credentials and consented work; never numbers, counterparties, statements or evidence', async () => {
    const pub = ok<ReputationBuilderPublicView>(await anonymous.get(`/v1/reputation-builder/companies/${f.supplier}`));
    assert.deepEqual(pub.credentials.map((c) => [c.credentialType, c.status, c.checkedByHubId]), [['US-CA-CSLB-C8', 'checked', HUB_ID]]);
    assert.deepEqual(pub.portfolio.map((e) => [e.title, e.confirmation]), [['Synthetic patio', 'client_confirmed']]);
    assert.equal(pub.publicScore, null);
    const json = JSON.stringify(pub);
    for (const secret of ['SYN-OK', 'SYN-DOWN', A.agreement.id, f.people.petr, 'Synthetic: 40 m2', 'C-8 concrete', requestId, entryId, credentialId]) assert.ok(!json.includes(secret), `${secret} leaked publicly`);
    assert.deepEqual(ok<ReputationBuilderPublicView>(await anonymous.get(`/v1/reputation-builder/people/${f.people.petr}`)).portfolio, [], 'a private profile shows nothing');
  });

  await t.test('no entitlement, payment, sponsorship or staff action changes a snapshot or the builder\'s output (comparison)', async () => {
    const beforeSnapshot = ok<OwnSnapshotView>(await boris.post('/v1/reputation/snapshots', { subject: supplierParty }), 201);
    const beforeOwn = ok<ReputationBuilderOwnView>(await boris.get(OWN));
    const beforePublic = ok<ReputationBuilderPublicView>(await anonymous.get(`/v1/reputation-builder/companies/${f.supplier}`));
    // Paying the platform: subscription-style entitlements, a sponsorship, credits and a trial for both parties.
    await withMaintenance(h.db.admin, async (trx) => {
      const offer = await trx.insertInto('offer').values({ hub_id: HUB_ID, code: 'synthetic_reputation_boost', name: 'Synthetic reputation boost', kind: 'plan', status: 'active', created_by: f.people.anna }).returningAll().executeTakeFirstOrThrow();
      for (const owner of [{ owner_company_id: f.supplier, owner_person_id: null }, { owner_company_id: null, owner_person_id: f.people.petr }]) {
        const account = await trx.insertInto('billing_account').values({ hub_id: HUB_ID, ...owner, currency: 'USD', created_by: f.people.anna }).returning('id').executeTakeFirstOrThrow();
        for (const source of ['sponsorship', 'credit', 'trial'] as const) {
          await trx.insertInto('entitlement').values({ billing_account_id: account.id, offer_id: offer.id, module_code: 'reputation_builder', limits: JSON.stringify({ boost: 10, priority: 1, score: 100 }), valid_from: new Date('2026-10-01T00:00:00Z'), source }).execute();
        }
      }
    });
    // Staff actions: a trust reviewer decides the limitation appeal and looks for reputation records (no path to them).
    const limitationAppeal = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('appeal').select('id').where('subject_kind', '=', 'automated_limitation').executeTakeFirstOrThrow());
    await as(f, staff.reviewerA, async (trx) => appeals.decide(trx, await staff.elevate(staff.reviewerA), limitationAppeal.id, 'upheld'));
    for (const table of ['timeliness_observation', 'contribution_record', 'confirmation_request', 'professional_credential', 'portfolio_entry', 'automated_limitation'] as const) {
      assert.equal((await as(f, staff.reviewerA, (trx) => trx.selectFrom(table).select('id').execute())).length, 0, `staff read nothing from ${table}`);
    }
    const afterSnapshot = ok<OwnSnapshotView>(await boris.post('/v1/reputation/snapshots', { subject: supplierParty }), 201);
    assert.notEqual(afterSnapshot.id, beforeSnapshot.id);
    assert.equal(afterSnapshot.inputsDigest, beforeSnapshot.inputsDigest, 'the same evidence, whoever pays');
    assert.deepEqual(afterSnapshot.summary, beforeSnapshot.summary);
    assert.equal(afterSnapshot.summary.publicScore, null);
    const afterOwn = ok<ReputationBuilderOwnView>(await boris.get(OWN));
    assert.deepEqual({ ...afterOwn, limitations: [] }, { ...beforeOwn, limitations: [] }, 'credentials, portfolio, confirmations, contributions and timeliness unchanged');
    assert.deepEqual(afterOwn.limitations.map((l) => l.appeal), ['upheld'], 'only the appeal outcome the reviewer decided is visible');
    assert.deepEqual(ok<ReputationBuilderPublicView>(await anonymous.get(`/v1/reputation-builder/companies/${f.supplier}`)), beforePublic);
  });

  await t.test('outbox events and audit carry identifiers only', async () => {
    const events = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('outbox_event').select(['type', 'payload']).where('type', 'like', 'reputation.%').execute());
    assert.ok(events.length >= 6);
    for (const e of events) {
      for (const key of Object.keys(e.payload as object)) assert.ok((REPUTATION_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key), `${e.type} carries ${key}`);
      assert.ok(!JSON.stringify(e.payload).includes('Synthetic'), 'no statement, comment or credential text');
    }
    const audit = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('audit_event').select(['action', 'basis']).where('action', 'like', 'reputation.%').execute());
    assert.ok(audit.length >= 6);
    assert.ok(!JSON.stringify(audit).includes('SYN-OK'), 'audit never carries a credential number');
  });
});
