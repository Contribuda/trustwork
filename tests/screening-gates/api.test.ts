import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance, withPrincipal, bindTransaction } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import type { OwnerRfqView } from '../../packages/contracts/src/commerce.js';
import type { BuyerAgreementView, BuyerQuoteView, SellerAgreementView, SellerQuoteView } from '../../packages/contracts/src/deals.js';
import type { ScreeningSubjectRef } from '../../packages/contracts/src/sanctions.js';
import { COUNTERPARTY_FORBIDDEN_GATE_KEYS } from '../../packages/contracts/src/screening-gates.js';
import { AllowListDealMandates } from '../../apps/api/src/modules/sales/mandates.js';
import { ScreenedMandates } from '../../apps/api/src/modules/screening-gates/mandates.js';
import { PayoutGate } from '../../apps/api/src/modules/screening-gates/payout.js';
import { LocalApiError } from '../../apps/api/src/common/errors.js';
import { screenSubject } from '../../apps/worker/src/screening/index.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { principalFor } from '../data/helpers/seed.js';
import { clearHold, decideMatches, holdPerson, LISTED_COMPANY_NAME, LISTED_PERSON_NAME, newBaselineVersion, rename, screen, screenEveryoneClear, setBaselineStale } from './helpers.js';

/**
 * SANC-004 through the HTTP API (real database, runtime role, CSRF, idempotency). Quote sending, acceptance of terms,
 * placing an order and the seller's acceptance are refused whenever a party on either side is held, has an open or
 * confirmed match, is unscreened, or was screened against lists older than the active baseline; the caller's own side
 * gets its own status words, the counterparty's refusal says only that the other party cannot transact now; nothing is
 * written by a refused act; an unreadable screening store or a stale baseline refuses everything; an agent's commit is
 * refused on the mandate path before its mandate is used; a decision racing a commitment is never bound on a stale
 * answer; a restricted payout country is refused before the provider fake is called and holds the declaring person.
 * Every name is synthetic.
 */
const h = await startHarness('screening_gates_api');

const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const PERSON = { via: 'person' as const };
const CONSENT = { consented: true as const, disclosureKey: 'trustwork.electronic-records.v1' };
const RFQ_PAYLOAD = {
  title: 'Retaining wall blocks', currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [], paymentTermsRequested: 'Net 30', acceptanceCriteria: 'Plumb within 5 mm',
  deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } },
  lines: [{ lineId: 'blocks', kind: 'goods', description: 'Concrete blocks', specification: {}, quantity: { value: '10', unit: 'm2' }, alternativesAllowed: false }],
};
const QUOTE_PAYLOAD = {
  currency: 'USD', paymentTerms: 'Net 30', validity: { until: '2027-06-01T00:00:00.000Z' }, exclusions: [], attachments: [],
  deliveryTerms: { milestones: [{ description: 'Delivery', due: bdate('2027-03-20') }], location: 'Site' },
  totals: { net: usd('30000'), tax: usd('0'), gross: usd('30000') },
  lines: [{ lineId: 'q1', rfqLineId: 'blocks', kind: 'goods', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '10', unit: 'm2' }, unitPrice: usd('3000'), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd('30000'), substitution: null, options: [] }],
};
function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
const refOf = (v: { id: string; version: number; digest: { algorithm: 'trustwork-digest-1'; value: string } | null }) => ({ id: v.id, version: v.version, digest: v.digest! });

/** The caller's own refusal: its code and its status words. */
function own(r: Response, keyPart: string): void {
  expectError(r, 403, 'screening.review_pending');
  const details = (r.body as { details?: { messageKeys?: string[] } }).details;
  assert.ok(details?.messageKeys?.some((k) => k.includes(keyPart)), JSON.stringify(r.body));
}
/** The counterparty refusal: one code, no details, nothing about screening (the projection test). */
const counterpartyBodies: unknown[] = [];
function counterparty(r: Response): void {
  expectError(r, 409, 'commercial.counterparty_unavailable');
  counterpartyBodies.push(r.body);
  assert.deepEqual(Object.keys(r.body as object).sort(), ['code', 'message', 'requestId']);
  const json = JSON.stringify(r.body).toLowerCase();
  for (const word of ['screen', 'sanction', 'match', 'hold', 'list', 'review', 'compliance', 'restricted', 'jurisdiction']) assert.ok(!json.includes(word), `${word} leaked: ${json}`);
  for (const key of COUNTERPARTY_FORBIDDEN_GATE_KEYS) assert.ok(!json.includes(`"${key.toLowerCase()}"`), key);
}

test('screening gates through the API: every party side, every commitment, fail closed, no detail for the counterparty', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const admin = h.db.admin;
  await withMaintenance(admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const [petr, boris, carl] = [await as('petr'), await as('boris'), await as('carl')];
  const P = (id: string): ScreeningSubjectRef => ({ kind: 'person', id });
  const petrS = P(seed.people.petr);
  const carlS = P(seed.people.carl);
  const supplierS: ScreeningSubjectRef = { kind: 'company', id: seed.companies.supplier };
  const names = new Map((await admin.query<{ id: string; display_name: string }>('SELECT id, display_name FROM trustwork.person UNION ALL SELECT id, display_name FROM trustwork.company')).rows.map((r) => [r.id, r.display_name]));
  /** Back to clear: original name, matches decided not the same person, screened again. */
  const restore = async (subject: ScreeningSubjectRef) => {
    await rename(admin, subject, names.get(subject.id)!);
    await decideMatches(admin, subject, 'not_same_person');
    assert.equal((await screen(admin, subject)).outcome, 'clear');
  };
  const unscreen = async (subject: ScreeningSubjectRef) => {
    await setBaselineStale(admin, true);
    assert.equal((await screen(admin, subject)).outcome, 'not_screened');
    await setBaselineStale(admin, false);
  };
  const auditCount = async (action: string) => Number((await admin.query<{ n: string }>('SELECT count(*)::text AS n FROM trustwork.audit_event WHERE action = $1', [action])).rows[0]!.n);
  const grantBudget = async (limit: string) => withPrincipal(h.pool, await principalFor(admin, seed.people.petr), (trx) => budgets.grant(trx, {
    kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null, periodFrom: '2026-01-01T00:00:00Z', periodTo: '2030-01-01T00:00:00Z', limitMinor: limit, currency: 'USD',
  }));
  const publishRfq = async () => {
    let rfq = ok<OwnerRfqView>(await petr.post('/v1/rfqs', { owner: { kind: 'person', id: seed.people.petr }, projectId: null, payload: RFQ_PAYLOAD, category: 'landscaping', publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: PERSON }), 201);
    rfq = ok<OwnerRfqView>(await petr.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: PERSON }));
    for (const party of [carlS, supplierS]) ok(await petr.post(`/v1/rfqs/${rfq.rfq.id}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, party, channel: 'platform', actor: PERSON }), 201);
    return ok<OwnerRfqView>(await petr.get(`/v1/rfqs/${rfq.rfq.id}`));
  };
  const draft = async (client: Client, rfq: OwnerRfqView, seller: ScreeningSubjectRef) =>
    ok<SellerQuoteView>(await client.post('/v1/quotes', { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, seller, payload: QUOTE_PAYLOAD, privateConstraint: null, actor: PERSON }), 201);
  const send = (client: Client, q: SellerQuoteView) => client.post(`/v1/quotes/${q.quote.id}/send`, { quoteId: q.quote.id, version: 1, expectedRevision: q.quote.revision, actor: PERSON });
  const acceptBody = async (rfq: OwnerRfqView, quoteId: string) => {
    const shared = ok<BuyerQuoteView>(await petr.get(`/v1/quotes/${quoteId}`));
    const rfqv = rfq.versions.find((v) => v.id === rfq.rfq.currentVersionId)!;
    return { rfqId: rfq.rfq.id, quoteVersion: refOf(shared.versions.find((v) => v.status === 'sent')!), rfqVersion: refOf(rfqv), expectedRevision: shared.quote.revision, electronicRecords: CONSENT, actor: PERSON };
  };

  await t.test('nobody screened yet: the first commitment is refused, never assumed clear', async () => {
    const rfq = await publishRfq();
    const q = await draft(carl, rfq, carlS);
    expectError(await send(carl, q), 409, 'screening.unavailable');
    assert.equal(await auditCount('quote.sent'), 0);
  });

  await screenEveryoneClear(admin);
  const rfq = await publishRfq();
  let carlQuote = await draft(carl, rfq, carlS);
  const supplierQuote = await draft(boris, rfq, supplierS);

  await t.test('quote sending: the seller side and the buyer side are each refused', async () => {
    // Own side, a person: insufficient name.
    await rename(admin, carlS, 'Carlmonoword');
    assert.equal((await screen(admin, carlS)).outcome, 'insufficient_name');
    own(await send(carl, carlQuote), 'nameNeeded');
    await restore(carlS);
    // Counterparty: the buyer is unscreened.
    await unscreen(petrS);
    counterparty(await send(carl, carlQuote));
    assert.equal(await auditCount('quote.sent'), 0, 'a refused send writes nothing');
    assert.equal(ok<SellerQuoteView>(await carl.get(`/v1/quotes/${carlQuote.quote.id}`)).versions[0]!.status, 'draft');
    assert.equal((await screen(admin, petrS)).outcome, 'clear');
    // Own side, a company: an open possible match; the member gets the company's words.
    await rename(admin, supplierS, LISTED_COMPANY_NAME);
    assert.equal((await screen(admin, supplierS)).outcome, 'possible_match');
    own(await send(boris, supplierQuote), 'companyPaused');
    await restore(supplierS);
    // All clear: both quotes go out.
    carlQuote = ok<SellerQuoteView>(await send(carl, carlQuote));
    ok<SellerQuoteView>(await send(boris, supplierQuote));
  });

  let agreement: BuyerAgreementView;
  await t.test('accepting terms: the seller side and the buyer side are each refused; no agreement is written', async () => {
    const body = await acceptBody(rfq, carlQuote.quote.id);
    // Counterparty: the seller is held (a jurisdiction sighting).
    await holdPerson(admin, seed.people.carl);
    counterparty(await petr.post('/v1/agreements', body));
    await clearHold(admin, seed.people.carl, seed.people.boris);
    // Own side: the buyer was screened against lists older than the active baseline.
    await newBaselineVersion(admin, '950301');
    for (const subject of [carlS, supplierS, P(seed.people.boris)]) assert.equal((await screen(admin, subject)).outcome, 'clear');
    own(await petr.post('/v1/agreements', body), 'checking');
    assert.equal(ok<{ agreements: unknown[] }>(await petr.get('/v1/agreements')).agreements.length, 0);
    assert.equal((await screen(admin, petrS)).outcome, 'clear');
    agreement = ok<BuyerAgreementView>(await petr.post('/v1/agreements', body), 201);
  });

  await t.test('placing the order: the seller side and the buyer side are each refused; nothing is reserved', async () => {
    const budget = await grantBudget('100000000');
    const body = { action: 'place_order', context: { kind: 'rfq', id: rfq.rfq.id }, agreementId: agreement.agreement.id, quoteVersion: agreement.agreement.acceptedTerms.quoteVersion, rfqVersion: agreement.agreement.acceptedTerms.rfqVersion,
      expectedRevision: agreement.agreement.revision, transactionBudgetId: budget, platformBudgetId: null, externalReference: 'PO-SANC-1', actor: PERSON };
    // Counterparty: the seller's match was confirmed.
    await rename(admin, carlS, LISTED_PERSON_NAME);
    assert.equal((await screen(admin, carlS)).outcome, 'possible_match');
    await decideMatches(admin, carlS, 'confirmed');
    counterparty(await petr.post(`/v1/agreements/${agreement.agreement.id}/orders`, body));
    await restore(carlS);
    // Own side: the buyer has an open possible match.
    await rename(admin, petrS, LISTED_PERSON_NAME);
    assert.equal((await screen(admin, petrS)).outcome, 'possible_match');
    own(await petr.post(`/v1/agreements/${agreement.agreement.id}/orders`, body), 'review');
    const reserved = await admin.query('SELECT 1 FROM trustwork.reservation WHERE budget_id = $1', [budget]);
    assert.equal(reserved.rowCount, 0, 'no reservation for a refused order');
    assert.equal(await auditCount('order.placed'), 0);
    await restore(petrS);
    agreement = ok<BuyerAgreementView>(await petr.post(`/v1/agreements/${agreement.agreement.id}/orders`, body), 201);
  });

  await t.test('the seller accepting the order: the buyer side and the seller side are each refused', async () => {
    const seller = ok<SellerAgreementView>(await carl.get(`/v1/agreements/${agreement.agreement.id}`));
    const body = { expectedRevision: seller.agreement.revision, acceptedTermsDigest: seller.agreement.acceptedTerms.digest, electronicRecords: CONSENT, actor: PERSON };
    // Counterparty: the buyer is held.
    await holdPerson(admin, seed.people.petr);
    counterparty(await carl.post(`/v1/agreements/${agreement.agreement.id}/accept`, body));
    await clearHold(admin, seed.people.petr, seed.people.boris);
    // Own side: the seller is unscreened.
    await unscreen(carlS);
    own(await carl.post(`/v1/agreements/${agreement.agreement.id}/accept`, body), 'checking');
    assert.equal(await auditCount('agreement.accepted_by_both'), 0);
    assert.equal((await screen(admin, carlS)).outcome, 'clear');
    const accepted = ok<SellerAgreementView>(await carl.post(`/v1/agreements/${agreement.agreement.id}/accept`, body));
    assert.equal(accepted.agreement.status, 'accepted_by_both');
    // Neither side's view carries anything of the gate.
    for (const view of [accepted, ok(await petr.get(`/v1/agreements/${agreement.agreement.id}`))]) {
      const json = JSON.stringify(view);
      for (const key of ['moneyHeld', 'placeHold', 'messageKeys', 'screening', 'lastOutcome']) assert.ok(!json.includes(key), key);
    }
  });

  await t.test('a decision racing a commitment: the commitment waits and is refused on the fresh answer', async () => {
    const rfq2 = await publishRfq();
    const q = await draft(carl, rfq2, carlS);
    // A screening of the buyer that opens a match is recorded and not yet committed.
    const client = await admin.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE trustwork_owner');
      await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      // A name matching another synthetic entry (the earlier entry was decided "not the same person" for Petr).
      await client.query('UPDATE trustwork.person SET display_name = $1 WHERE id = $2', ['Petra Samplewood', seed.people.petr]);
      assert.equal((await screenSubject(bindTransaction(client), petrS, 'name_change', { fuzzyThreshold: null, vesselsAndAircraft: false, sweepBatch: 500 })).outcome, 'possible_match');
      const sending = send(carl, q);
      // The send waits on the buyer's state row while the decision is open.
      let waited = false;
      for (let i = 0; i < 200 && !waited; i += 1) {
        const { rows } = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
        waited = Number(rows[0]!.n) > 0;
        if (!waited) await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(waited, 'the send waited for the open decision');
      await client.query('COMMIT');
      committed = true;
      counterparty(await sending);
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    await restore(petrS);
    ok<SellerQuoteView>(await send(carl, ok<SellerQuoteView>(await carl.get(`/v1/quotes/${q.quote.id}`))));
  });

  await t.test('the screening store unavailable, or a stale baseline: every commitment is refused', async () => {
    const rfq3 = await publishRfq();
    const q = await draft(carl, rfq3, carlS);
    await admin.query('REVOKE EXECUTE ON FUNCTION trustwork.screening_gate_check(text[], uuid[]) FROM trustwork_app');
    try {
      expectError(await send(carl, q), 409, 'screening.unavailable');
    } finally {
      await admin.query('GRANT EXECUTE ON FUNCTION trustwork.screening_gate_check(text[], uuid[]) TO trustwork_app');
    }
    await setBaselineStale(admin, true);
    try {
      expectError(await send(carl, q), 409, 'screening.unavailable');
    } finally {
      await setBaselineStale(admin, false);
    }
    ok<SellerQuoteView>(await send(carl, q));
  });

  await t.test('an agent commit is refused on the mandate path before its mandate is used; other actions are not', async () => {
    const inner = new AllowListDealMandates([{ personId: seed.people.carl, mandateId: '00000000-0000-4000-8000-0000000000aa', action: 'send_quote' }, { personId: seed.people.carl, mandateId: '00000000-0000-4000-8000-0000000000aa', action: 'negotiate' }]);
    const port = new ScreenedMandates(inner, h.pool);
    const check = (action: 'send_quote' | 'negotiate') => ({ personId: seed.people.carl, mandateId: '00000000-0000-4000-8000-0000000000aa', action, context: { kind: 'quote' as const, id: 'q-1' }, amount: null, at: new Date() });
    await holdPerson(admin, seed.people.carl);
    await assert.rejects(port.allows(check('send_quote')), (e: unknown) => e instanceof LocalApiError && e.code === 'jurisdiction.restricted');
    await clearHold(admin, seed.people.carl, seed.people.boris);
    await unscreen(carlS);
    await assert.rejects(port.allows(check('send_quote')), (e: unknown) => e instanceof LocalApiError && e.code === 'screening.review_pending');
    assert.equal(inner.checks.length, 0, 'the mandate store never saw the refused commit');
    assert.equal(await port.allows(check('negotiate')), true);
    assert.equal((await screen(admin, carlS)).outcome, 'clear');
    assert.equal(await port.allows(check('send_quote')), true);
    assert.deepEqual(inner.checks.map((c) => c.action), ['negotiate', 'send_quote']);
  });

  await t.test('payouts: a restricted payout country is refused before the provider is called and holds the declaring person', async () => {
    // Earlier baseline versions made every result stale; the payees are screened again first.
    for (const id of [seed.people.anna, seed.people.xenia]) assert.equal((await screen(admin, P(id))).outcome, 'clear');
    const gate = new PayoutGate(h.pool);
    const calls: string[] = [];
    const provider = (label: string) => async () => { calls.push(label); return label; };
    const run = async (personId: string, payoutCountry: string, label: string) => {
      const declarer = await principalFor(admin, personId);
      return withPrincipal(h.pool, declarer, (trx) => gate.guardPayout({ declarer, trx, payee: { subject: P(personId), payoutCountry, declaredBy: personId }, purpose: 'payout_account' }, provider(label)));
    };
    assert.equal(await run(seed.people.anna, 'US', 'anna-us'), 'anna-us');
    await assert.rejects(run(seed.people.xenia, 'CU', 'xenia-cu'), (e: unknown) => e instanceof LocalApiError && e.code === 'jurisdiction.restricted');
    const holds = await admin.query<{ person_id: string; place: string; source: string }>("SELECT person_id, place, source FROM trustwork.jurisdiction_hold WHERE source = 'payout_country'");
    assert.deepEqual(holds.rows, [{ person_id: seed.people.xenia, place: 'CU', source: 'payout_country' }], 'the declaring person is held, nobody else');
    // A payee with an open match is refused before the provider too.
    await rename(admin, P(seed.people.anna), LISTED_PERSON_NAME);
    assert.equal((await screen(admin, P(seed.people.anna))).outcome, 'possible_match');
    await assert.rejects(run(seed.people.anna, 'US', 'anna-matched'), (e: unknown) => e instanceof LocalApiError && e.code === 'screening.review_pending');
    assert.deepEqual(calls, ['anna-us']);
    // The held person's session is now refused everywhere (SANC-001).
    const xenia = h.client();
    const signIn = await xenia.post('/v1/auth/login', { email: 'xenia@example.invalid', password: 'fixture-password-xenia-001' }, { idempotencyKey: null });
    assert.notEqual(signIn.status, 200);
  });

  await t.test('projection: no counterparty refusal carried any screening detail', () => {
    assert.ok(counterpartyBodies.length >= 5, `${counterpartyBodies.length} counterparty refusals seen`);
    const messages = new Set(counterpartyBodies.map((b) => (b as { message: string }).message));
    assert.equal(messages.size, 1, 'hold, match, unscreened and stale all read the same to the counterparty');
  });
});
