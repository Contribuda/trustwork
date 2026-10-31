import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { computeAgreementDigest, computeQuoteVersionDigest, computeRfqVersionDigest, type QuoteVersionPayload } from '@trustwork/contracts';
import { kernelReference, kernelSync } from '../../../packages/data/src/repositories/kernel.js';
import { rfqInvitations, rfqPrivate, rfqs, rfqVersions } from '../../../packages/data/src/repositories/commerce.js';
import { budgets, reservations } from '../../../packages/data/src/repositories/billing.js';
import {
  acceptanceEvents, agreementBuyerPrivate, agreements, agreementSellerPrivate, obligations, orders, quoteLines, quotePrivate, quotes, quoteVersions, taxDeterminations,
} from '../../../packages/data/src/repositories/transactions.js';
import type { AgreementRow, QuoteRow, QuoteVersionRow } from '../../../packages/data/src/schema/transactions.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { principalFor, seedFixtures } from '../../data/helpers/seed.js';

/**
 * COM-002 database layer under the real runtime role (FORCE RLS, no mocks): quotes drafted and sent only against the
 * current published RFQ version and only by an invited seller; sent versions frozen for every role; amendments flag
 * sent versions and quotes stale in the same transaction; agreements pinned to stored digests, one live agreement per
 * RFQ under concurrency, acceptance events that must repeat the agreement digest; private halves that never cross;
 * orders that need the buyer side and a matching reservation; and the RFQ publish decision (company.deals.manage).
 */
const db = await provisionTestDatabase('transactions_db');

interface PgError { code?: string; hint?: string; message?: string }
async function fails(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as PgError;
    assert.ok(e.hint === expected || e.code === expected, `expected ${expected}, got ${e.code} ${e.hint ?? ''} ${e.message ?? ''}`);
    return;
  }
  assert.fail(`expected ${expected}, but it succeeded`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
const digest = (value: string) => ({ algorithm: 'trustwork-digest-1' as const, value });
const rfqPayload = (quantity: string) => ({
  title: 'Patio pavers and laying', currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [], paymentTermsRequested: null, acceptanceCriteria: 'Level within 3 mm per metre',
  deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } },
  lines: [
    { lineId: 'l1', kind: 'goods', description: 'Concrete pavers', specification: { colour: 'grey' }, quantity: { value: quantity, unit: 'm2' }, alternativesAllowed: true },
    { lineId: 'l2', kind: 'works', description: 'Lay the pavers', specification: {}, quantity: { value: '1', unit: 'ls' }, alternativesAllowed: false },
  ],
});
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
function quotePayload(quantity: string, unitPrice = '3000', validUntil = '2027-06-01T00:00:00.000Z'): QuoteVersionPayload {
  const goods = BigInt(quantity) * BigInt(unitPrice);
  const total = goods + 50000n;
  return {
    currency: 'USD', paymentTerms: 'Net 30', validity: { until: validUntil }, exclusions: ['Permits'], attachments: [],
    deliveryTerms: { milestones: [{ description: 'Delivery and laying', due: bdate('2027-03-20') }], location: 'Site, San Diego County' },
    totals: { net: usd(total.toString()), tax: usd('0'), gross: usd(total.toString()) },
    lines: [
      { lineId: 'q1', rfqLineId: 'l1', kind: 'goods', specSnapshot: { colour: 'grey' }, offeringVersionRef: null, quantity: { value: quantity, unit: 'm2' }, unitPrice: usd(unitPrice), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd(goods.toString()), substitution: null, options: [] },
      { lineId: 'q2', rfqLineId: 'l2', kind: 'works', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '1', unit: 'ls' }, unitPrice: usd('50000'), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd('50000'), substitution: null, options: [] },
    ],
  };
}

test('transactions database: RLS, frozen quotes, staleness, digests, one live agreement, private halves and orders', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const seed = await seedFixtures(db.admin);
  await withMaintenance(db.admin, (trx) => kernelReference.fromRepository().then((reference) => kernelSync.apply(trx, reference)));
  const { petr, boris, carl, xenia, anna } = seed.people;
  const { supplier } = seed.companies;
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(db.app, await principalFor(db.admin, personId), fn);

  /** Petr's RFQ: version 1 published with the given quantity; returns the RFQ id and the published version row. */
  const publishRfq = async (quantity: string) => as(petr, async (trx) => {
    const rfq = await rfqs.insert(trx, { owner_person_id: petr, owner_company_id: null, project_id: null, creator_person_id: petr, need_id: null, plan_project_id: null, plan_item_key: null, public_projection_enabled: false, public_projection_fields: [], category: null });
    await rfqPrivate.insert(trx, { rfq_id: rfq.id, owner_person_id: petr, owner_company_id: null, budget_ceiling_minor: '9000000', budget_ceiling_currency: 'USD', evaluation_weights: {}, internal_notes: 'PRIVATE-ceiling', shortlist: [], updated_by_person_id: petr });
    const v1 = await rfqVersions.insertDraft(trx, { rfq_id: rfq.id, version: 1, payload: rfqPayload(quantity), drafted_by_person_id: petr, amendment_reason: null });
    await rfqs.lock(trx, rfq.id);
    const published = await rfqVersions.publish(trx, v1.id, { digest: computeRfqVersionDigest(rfqPayload(quantity) as never).value, personId: petr, via: 'person', mandateId: null, amendmentReason: null, at: new Date() });
    await rfqs.setCurrent(trx, rfq.id, { current_version: 1, current_version_id: v1.id });
    return { rfqId: rfq.id, version: published! };
  });
  const amendRfq = async (rfqId: string, previous: string, quantity: string, version: number) => as(petr, async (trx) => {
    await rfqs.lock(trx, rfqId);
    const draft = await rfqVersions.insertDraft(trx, { rfq_id: rfqId, version, payload: rfqPayload(quantity), drafted_by_person_id: petr, amendment_reason: 'Quantity changed' });
    await rfqVersions.supersede(trx, previous, version, new Date());
    const published = await rfqVersions.publish(trx, draft.id, { digest: computeRfqVersionDigest(rfqPayload(quantity) as never).value, personId: petr, via: 'person', mandateId: null, amendmentReason: 'Quantity changed', at: new Date() });
    await rfqs.setCurrent(trx, rfqId, { current_version: version, current_version_id: draft.id });
    return published!;
  });
  const invite = async (rfqId: string, versionId: string, party: { person?: string; company?: string }, revalidates: string | null = null) => as(petr, (trx) => rfqInvitations.insert(trx, {
    rfq_id: rfqId, rfq_version_id: versionId, party_person_id: party.person ?? null, party_company_id: party.company ?? null, channel: 'platform', sent_by_person_id: petr, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: revalidates,
  }));
  /** Drafts (and optionally sends) a quote version as the seller; lines and tax determinations are written before the send. */
  const draftVersion = async (personId: string, quote: QuoteRow, version: number, rfqVersion: { id: string; version: number; digest: string }, payload: QuoteVersionPayload, revalidatedFrom: number | null = null) =>
    as(personId, (trx) => quoteVersions.insertDraft(trx, { quote_id: quote.id, version, rfq_id: quote.rfq_id, rfq_version_id: rfqVersion.id, rfq_version: rfqVersion.version, rfq_version_digest: rfqVersion.digest, payload, drafted_by_person_id: personId, revalidated_from: revalidatedFrom, answers_amendment_request_id: null }));
  const sendVersion = async (personId: string, quote: QuoteRow, draft: QuoteVersionRow, rfqVersion: { id: string; version: number; digest: string }, payload: QuoteVersionPayload, invitationId: string) => as(personId, async (trx) => {
    await quotes.lock(trx, quote.id);
    const previous = await quoteVersions.inStatus(trx, quote.id, 'sent');
    if (previous) await quoteVersions.supersede(trx, previous.id, new Date());
    const taxes = await taxDeterminations.insertMany(trx, quote.id, draft.id, personId, payload.lines.map((l) => ({ line_id: l.lineId, jurisdiction: 'US-CA', rule_ref: 'seller-stated:none', rate: null, included: false, taxability: 'not_applicable' as const, exemption_ref: null, provider: 'seller_stated' as const })));
    await quoteLines.insertMany(trx, quote.id, draft.id, payload.lines.map((l, position) => ({
      position, line_id: l.lineId, rfq_line_id: l.rfqLineId, kind: l.kind, spec_snapshot: l.specSnapshot, offering_ref: null, offering_version: null, quantity_value: l.quantity.value, quantity_unit: l.quantity.unit,
      currency: 'USD', unit_price_minor: l.unitPrice.minorUnits, tax_determination_id: taxes.find((x) => x.line_id === l.lineId)!.id, tax_amount_minor: l.taxAmount.minorUnits, line_total_minor: l.lineTotal.minorUnits,
    })));
    const ref = { id: rfqVersion.id, version: rfqVersion.version, digest: digest(rfqVersion.digest) };
    const sent = await quoteVersions.send(trx, draft.id, { digest: computeQuoteVersionDigest(ref, payload).value, personId, via: 'person', mandateId: null, validUntil: payload.validity.until, at: new Date() });
    await quotes.setCurrent(trx, quote.id, { status: 'sent', current_version: sent!.version, current_version_id: sent!.id, invitation_id: invitationId, clearStale: true });
    return sent!;
  });
  const agreementRow = (quote: QuoteRow, qv: QuoteVersionRow, rv: { id: string; version: number; digest: string }, overrides: Partial<Parameters<typeof agreements.insert>[1]> = {}) => ({
    buyer_person_id: petr, buyer_company_id: null, seller_person_id: quote.seller_person_id, seller_company_id: quote.seller_company_id, rfq_id: quote.rfq_id, quote_id: quote.id,
    quote_version_id: qv.id, rfq_version_id: rv.id, offer_version: qv.version, offer_digest: qv.digest as string, request_version: rv.version, request_digest: rv.digest,
    accepted_terms_digest: computeAgreementDigest({ id: qv.id, version: qv.version, digest: digest(qv.digest as string) }, { id: rv.id, version: rv.version, digest: digest(rv.digest) }).value,
    status: 'accepted_by_buyer' as const, supersedes_id: null, created_by_person_id: petr, ...overrides,
  });
  const eventRow = (a: AgreementRow, kind: 'buyer_accepts_terms' | 'seller_accepts_order' | 'seller_declines' | 'withdrawn', actor: string, party: { person: string | null; company: string | null }, key: string) => ({
    agreement_id: a.id, kind, terms_kind: a.terms_kind, quote_version_id: a.quote_version_id, rfq_version_id: a.rfq_version_id, offer_version: a.offer_version, offer_digest: a.offer_digest,
    request_version: a.request_version, request_digest: a.request_digest, accepted_terms_digest: a.accepted_terms_digest, actor_person_id: actor, on_behalf_person_id: party.person,
    on_behalf_company_id: party.company, via: 'person' as const, mandate_id: null, transaction_budget_id: null, reservation_id: null, platform_budget_id: null, e_records_required: true,
    e_records_disclosure_key: 'us.electronic-records.v1', e_records_basis: ['US:eSignature/esign-act'], e_records_consented_at: new Date(), reason: null, idempotency_key: key,
  });

  /* ---------- Integrator decision: RFQ publication needs company.deals.manage only ---------- */
  await t.test('a company member with company.deals.manage publishes a company RFQ; the public projection still needs company.publish', async () => {
    const id = await as(boris, async (trx) => {
      const rfq = await rfqs.insert(trx, { owner_person_id: null, owner_company_id: supplier, project_id: null, creator_person_id: boris, need_id: null, plan_project_id: null, plan_item_key: null, public_projection_enabled: false, public_projection_fields: [], category: null });
      const v1 = await rfqVersions.insertDraft(trx, { rfq_id: rfq.id, version: 1, payload: rfqPayload('5'), drafted_by_person_id: boris, amendment_reason: null });
      await rfqs.lock(trx, rfq.id);
      await rfqVersions.publish(trx, v1.id, { digest: computeRfqVersionDigest(rfqPayload('5') as never).value, personId: boris, via: 'person', mandateId: null, amendmentReason: null, at: new Date() });
      await rfqs.setCurrent(trx, rfq.id, { current_version: 1, current_version_id: v1.id });
      return rfq.id;
    });
    const published = await as(boris, (trx) => rfqs.get(trx, id));
    assert.equal(published?.status, 'published');
    await fails(as(boris, (trx) => rfqs.setProjection(trx, id, published!.revision, { enabled: true, fields: ['title'], category: null })), 'commerce.not_authorised');
  });

  /* ---------- Quotes ---------- */
  const first = await publishRfq('10');
  const rv1 = { id: first.version.id, version: 1, digest: first.version.digest as string };
  const borisInvitation = await invite(first.rfqId, rv1.id, { company: supplier });
  const carlInvitation = await invite(first.rfqId, rv1.id, { person: carl });
  let borisQuote: QuoteRow;
  let carlQuote: QuoteRow;
  let bv1: QuoteVersionRow;
  let cv1: QuoteVersionRow;

  await t.test('quotes: only an invited seller drafts, against the current version; the buyer reads sent versions only; nobody else reads anything', async () => {
    await fails(as(xenia, (trx) => quotes.insert(trx, { rfq_id: first.rfqId, seller_person_id: xenia, seller_company_id: null, invitation_id: borisInvitation.id, creator_person_id: xenia })), 'transactions.not_invited');
    await fails(as(carl, (trx) => quotes.insert(trx, { rfq_id: first.rfqId, seller_person_id: null, seller_company_id: supplier, invitation_id: borisInvitation.id, creator_person_id: carl })), 'transactions.not_invited');
    borisQuote = await as(boris, (trx) => quotes.insert(trx, { rfq_id: first.rfqId, seller_person_id: null, seller_company_id: supplier, invitation_id: borisInvitation.id, creator_person_id: boris }));
    assert.equal(borisQuote.buyer_person_id, petr, 'the buyer comes from the RFQ');
    await as(boris, (trx) => quotePrivate.insert(trx, { quote_id: borisQuote.id, owner_person_id: null, owner_company_id: supplier, floor_prices: { q1: usd('2800') }, margin_targets: {}, cost_basis: { q1: usd('2100') }, negotiation_notes: 'PRIVATE-floor-note', updated_by_person_id: boris }));
    await fails(as(boris, (trx) => quoteVersions.insertDraft(trx, { quote_id: borisQuote.id, version: 1, rfq_id: first.rfqId, rfq_version_id: rv1.id, rfq_version: 1, rfq_version_digest: 'f'.repeat(64), payload: quotePayload('10'), drafted_by_person_id: boris, revalidated_from: null, answers_amendment_request_id: null })), 'commercial.digest_mismatch');
    const draft = await draftVersion(boris, borisQuote, 1, rv1, quotePayload('10'));
    assert.deepEqual(await as(petr, (trx) => quoteVersions.listFor(trx, borisQuote.id)), [], 'the buyer never reads a draft');
    bv1 = await sendVersion(boris, borisQuote, draft, rv1, quotePayload('10'), borisInvitation.id);
    assert.equal(bv1.status, 'sent');
    const buyerRead = await as(petr, (trx) => quoteVersions.listFor(trx, borisQuote.id));
    assert.deepEqual(buyerRead.map((v) => v.status), ['sent']);
    assert.equal((await as(petr, (trx) => quoteLines.listFor(trx, bv1.id))).length, 2, 'the buyer reads the frozen lines of a sent version');
    assert.equal(await as(petr, (trx) => quotePrivate.get(trx, borisQuote.id)), undefined, 'the seller floor never reaches the buyer');
    carlQuote = await as(carl, (trx) => quotes.insert(trx, { rfq_id: first.rfqId, seller_person_id: carl, seller_company_id: null, invitation_id: carlInvitation.id, creator_person_id: carl }));
    await as(carl, (trx) => quotePrivate.insert(trx, { quote_id: carlQuote.id, owner_person_id: carl, owner_company_id: null, floor_prices: {}, margin_targets: {}, cost_basis: {}, negotiation_notes: '', updated_by_person_id: carl }));
    cv1 = await sendVersion(carl, carlQuote, await draftVersion(carl, carlQuote, 1, rv1, quotePayload('10', '2900')), rv1, quotePayload('10', '2900'), carlInvitation.id);
    for (const outsider of [carl, xenia, anna]) {
      assert.equal(await as(outsider, (trx) => quotes.get(trx, borisQuote.id)), undefined, 'another seller and outsiders do not see the quote');
      assert.deepEqual(await as(outsider, (trx) => quoteVersions.listFor(trx, borisQuote.id)), []);
      assert.equal(await as(outsider, (trx) => quotePrivate.get(trx, borisQuote.id)), undefined);
    }
    assert.equal((await db.app.query('SELECT count(*)::int AS n FROM trustwork.quote')).rows[0].n, 0, 'raw rows stay closed without identity');
  });

  await t.test('a sent quote version, its lines and its tax determinations are frozen for every role', async () => {
    await fails(as(boris, (trx) => trx.updateTable('quote_version').set({ payload: JSON.stringify(quotePayload('11')) }).where('id', '=', bv1.id).execute()), 'commercial.version_frozen');
    await fails(as(boris, (trx) => trx.updateTable('quote_version').set({ valid_until: '2030-01-01T00:00:00.000Z' }).where('id', '=', bv1.id).execute()), 'commercial.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('quote_version').set({ digest: 'e'.repeat(64) }).where('id', '=', bv1.id).execute()), 'commercial.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('quote_version').set({ rfq_version_id: rv1.id, rfq_version: 2 }).where('id', '=', bv1.id).execute()), 'commercial.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('quote_line').set({ quantity_value: '100' }).where('quote_version_id', '=', bv1.id).execute()), 'commerce.retained');
    await fails(withMaintenance(db.admin, (trx) => sql`DELETE FROM trustwork.quote_version WHERE id = ${bv1.id}`.execute(trx)), 'commerce.retained');
    const taxes = await as(petr, (trx) => taxDeterminations.listFor(trx, bv1.id));
    assert.equal(taxes.length, 2, 'the buyer reads how each sent line was taxed');
    const taxId = taxes[0]?.id as string;
    await fails(as(boris, (trx) => quoteLines.insertMany(trx, borisQuote.id, bv1.id, [{ position: 9, line_id: 'q9', rfq_line_id: null, kind: 'goods', spec_snapshot: {}, offering_ref: null, offering_version: null, quantity_value: '1', quantity_unit: 'm2', currency: 'USD', unit_price_minor: '1', tax_determination_id: taxId, tax_amount_minor: '0', line_total_minor: '1' }])), 'commerce.version_frozen');
  });

  /* ---------- Amendment: quantity 10 in v1, 100 in v2 ---------- */
  let rv2: { id: string; version: number; digest: string };
  await t.test('an amendment flags sent quote versions and quotes stale in the same transaction; old versions are never sent or accepted as v2', async () => {
    const v2 = await amendRfq(first.rfqId, rv1.id, '100', 2);
    rv2 = { id: v2.id, version: 2, digest: v2.digest as string };
    const flagged = await as(boris, (trx) => quoteVersions.get(trx, bv1.id));
    assert.equal(flagged?.stale_reason, 'rfq_amended');
    assert.equal(flagged?.status, 'sent', 'stale is a flag, not a status');
    assert.equal((await as(boris, (trx) => quotes.get(trx, borisQuote.id)))?.stale_reason, 'rfq_amended');
    await fails(as(boris, (trx) => trx.updateTable('quote_version').set({ stale_reason: null, stale_at: null }).where('id', '=', bv1.id).execute()), '42501');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('quote_version').set({ stale_reason: null, stale_at: null }).where('id', '=', bv1.id).execute()), 'commerce.stale_immutable');
    await fails(draftVersion(boris, borisQuote, 2, rv1, quotePayload('10')), 'commerce.rfq_version_not_current');
    // A v2 version cannot be drafted before the seller's invitation is revalidated.
    await fails(draftVersion(boris, borisQuote, 2, rv2, quotePayload('100'), 1), 'transactions.not_invited');
    const renewed = await invite(first.rfqId, rv2.id, { company: supplier }, borisInvitation.id);
    const draft = await draftVersion(boris, borisQuote, 2, rv2, quotePayload('100'), 1);
    const bv2 = await sendVersion(boris, borisQuote, draft, rv2, quotePayload('100'), renewed.id);
    assert.equal(bv2.revalidated_from, 1);
    const quote = await as(boris, (trx) => quotes.get(trx, borisQuote.id));
    assert.equal(quote?.stale_reason, null, 'the quote flag clears with a version pinned to the current RFQ version');
    assert.equal((await as(boris, (trx) => quoteVersions.get(trx, bv1.id)))?.status, 'superseded');
    assert.equal((await as(boris, (trx) => quoteVersions.get(trx, bv1.id)))?.stale_reason, 'rfq_amended', 'the version flag is never cleared');
    // Carl's v1 answer (quantity 10) stays pinned to v1: it cannot become an agreement on v2.
    await fails(as(petr, (trx) => agreements.insert(trx, agreementRow(carlQuote, cv1, rv2))), 'commercial.rfq_version_mismatch');
    await fails(as(petr, (trx) => agreements.insert(trx, agreementRow(carlQuote, cv1, rv1))), 'commercial.stale_version');
  });

  /* ---------- Agreements ---------- */
  let agreement: AgreementRow;
  await t.test('agreements: only the buyer side, only stored digests, events must repeat the agreement digest; other kinds wait for their slices', async () => {
    const bv2 = (await as(petr, (trx) => quoteVersions.listFor(trx, borisQuote.id))).find((v) => v.version === 2)!;
    await fails(as(boris, (trx) => agreements.insert(trx, { ...agreementRow(borisQuote, bv2, rv2), created_by_person_id: boris })), '42501');
    await fails(as(petr, (trx) => agreements.insert(trx, agreementRow(borisQuote, bv2, rv2, { offer_digest: 'a'.repeat(64) }))), 'commercial.digest_mismatch');
    await fails(as(petr, (trx) => agreements.insert(trx, agreementRow(borisQuote, bv2, rv2, { seller_person_id: carl, seller_company_id: null }))), 'commerce.not_authorised');
    // Consultation agreements wait for CONS-001; task agreements (TASK-001) need a sent offer on the owner's request.
    await fails(as(petr, (trx) => sql`INSERT INTO trustwork.agreement (terms_kind, buyer_person_id, seller_person_id, offer_ref_id, request_ref_id, offer_version, offer_digest, request_version, request_digest, accepted_terms_digest, status, created_by_person_id)
      VALUES ('consultation', ${petr}, ${carl}, gen_random_uuid(), gen_random_uuid(), 1, ${'a'.repeat(64)}, 1, ${'b'.repeat(64)}, ${'c'.repeat(64)}, 'proposed', ${petr})`.execute(trx)), 'transactions.terms_kind_unavailable');
    await fails(as(petr, (trx) => sql`INSERT INTO trustwork.agreement (terms_kind, buyer_person_id, seller_person_id, offer_ref_id, request_ref_id, offer_version, offer_digest, request_version, request_digest, accepted_terms_digest, status, created_by_person_id)
      VALUES ('task', ${petr}, ${carl}, gen_random_uuid(), gen_random_uuid(), 1, ${'a'.repeat(64)}, 1, ${'b'.repeat(64)}, ${'c'.repeat(64)}, 'accepted_by_buyer', ${petr})`.execute(trx)), 'commerce.not_authorised');
    // An acceptance status without its event is refused at commit.
    await fails(as(petr, (trx) => agreements.insert(trx, agreementRow(borisQuote, bv2, rv2))), 'transactions.event_missing');
    await fails(as(petr, async (trx) => {
      const row = await agreements.insert(trx, agreementRow(borisQuote, bv2, rv2));
      await acceptanceEvents.insert(trx, { ...eventRow(row, 'buyer_accepts_terms', petr, { person: petr, company: null }, 'accept-0'), accepted_terms_digest: 'd'.repeat(64) });
    }), 'commercial.digest_mismatch');
    agreement = await as(petr, async (trx) => {
      const row = await agreements.insert(trx, agreementRow(borisQuote, bv2, rv2));
      await acceptanceEvents.insert(trx, eventRow(row, 'buyer_accepts_terms', petr, { person: petr, company: null }, 'accept-1'));
      await agreementBuyerPrivate.insert(trx, { agreement_id: row.id, owner_person_id: petr, owner_company_id: null, transaction_budget_id: null, approval_refs: ['approval-PRIVATE'], notes: 'PRIVATE-buyer-note', updated_by_person_id: petr });
      return row;
    });
    assert.equal(agreement.status, 'accepted_by_buyer');
    await fails(as(petr, (trx) => trx.updateTable('agreement').set({ status: 'accepted_by_both' }).where('id', '=', agreement.id).execute()), 'commerce.invalid_transition');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('agreement').set({ accepted_terms_digest: 'f'.repeat(64) }).where('id', '=', agreement.id).execute()), 'commerce.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('acceptance_event').set({ reason: 'rewrite' }).where('agreement_id', '=', agreement.id).execute()), 'audit.append_only');
    await fails(as(boris, (trx) => acceptanceEvents.insert(trx, eventRow(agreement, 'buyer_accepts_terms', boris, { person: null, company: supplier }, 'forged'))), 'commerce.not_authorised');
    // Both parties read the same shared record and the same digest.
    const bySeller = await as(boris, (trx) => agreements.get(trx, agreement.id));
    const byBuyer = await as(petr, (trx) => agreements.get(trx, agreement.id));
    assert.equal(bySeller?.accepted_terms_digest, byBuyer?.accepted_terms_digest);
    for (const outsider of [carl, xenia, anna]) assert.equal(await as(outsider, (trx) => agreements.get(trx, agreement.id)), undefined);
  });

  await t.test('private halves never cross', async () => {
    assert.equal(await as(boris, (trx) => agreementBuyerPrivate.get(trx, agreement.id)), undefined, 'the seller never reads the buyer half');
    await fails(as(boris, (trx) => agreementBuyerPrivate.insert(trx, { agreement_id: agreement.id, owner_person_id: petr, owner_company_id: null, transaction_budget_id: null, approval_refs: [], notes: null, updated_by_person_id: boris })), '42501');
    await as(boris, (trx) => agreementSellerPrivate.insert(trx, { agreement_id: agreement.id, owner_person_id: null, owner_company_id: supplier, fulfilment_plan: [{ step: 'PRIVATE-crew-plan', internalOwnerPersonId: boris }], notes: null, updated_by_person_id: boris }));
    assert.equal(await as(petr, (trx) => agreementSellerPrivate.get(trx, agreement.id)), undefined, 'the buyer never reads the seller half');
    await fails(as(petr, (trx) => agreementSellerPrivate.update(trx, agreement.id, 1, { fulfilment_plan: [], notes: 'x', updated_by_person_id: petr }).then((r) => { if (!r) throw Object.assign(new Error('no row'), { code: '42501' }); })), '42501');
    assert.equal((await as(petr, (trx) => agreementBuyerPrivate.get(trx, agreement.id)))?.notes, 'PRIVATE-buyer-note');
  });

  await t.test('orders: the buyer side with a matching reservation; the seller accepts a placed order only; obligations follow', async () => {
    const bv2 = (await as(petr, (trx) => quoteVersions.listFor(trx, borisQuote.id))).find((v) => v.version === 2)!;
    const gross = (bv2.payload as QuoteVersionPayload).totals.gross.minorUnits;
    await fails(as(boris, async (trx) => {
      await acceptanceEvents.insert(trx, eventRow(agreement, 'seller_accepts_order', boris, { person: null, company: supplier }, 'accept-early'));
    }), 'transactions.order_missing');
    const budgetId = await as(petr, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null, periodFrom: '2026-01-01T00:00:00Z', periodTo: '2030-01-01T00:00:00Z', limitMinor: '100000000', currency: 'USD' }));
    const orderRow = (reservationId: string | null, amount = gross) => ({
      agreement_id: agreement.id, accepted_terms_digest: agreement.accepted_terms_digest, context_kind: 'rfq' as const, context_id: first.rfqId, external_reference: null, amount_minor: amount, currency: 'USD',
      transaction_budget_id: budgetId, reservation_id: reservationId, placed_by_person_id: petr, placed_via: 'person' as const, placed_mandate_id: null,
    });
    await fails(as(boris, (trx) => orders.insert(trx, { ...orderRow(null, '0'), placed_by_person_id: boris })), '42501');
    await fails(as(petr, (trx) => orders.insert(trx, { ...orderRow(null), amount_minor: gross })), '23514');
    const order = await as(petr, async (trx) => {
      const r = await reservations.reserve(trx, { budgetId, kind: 'transaction', amountMinor: gross, currency: 'USD', actionIntentId: agreement.id, correlationKey: 'order-1', projectId: null, ttlSeconds: 3600 });
      return orders.insert(trx, orderRow(r.id));
    });
    await fails(as(petr, async (trx) => {
      const r = await reservations.reserve(trx, { budgetId, kind: 'transaction', amountMinor: gross, currency: 'USD', actionIntentId: agreement.id, correlationKey: 'order-2', projectId: null, ttlSeconds: 3600 });
      await orders.insert(trx, orderRow(r.id));
    }), '23505');
    await as(boris, async (trx) => {
      await acceptanceEvents.insert(trx, eventRow(agreement, 'seller_accepts_order', boris, { person: null, company: supplier }, 'accept-2'));
      const accepted = await agreements.setStatus(trx, agreement.id, agreement.revision, { status: 'accepted_by_both' });
      await orders.setStatus(trx, order.id, order.revision, { status: 'accepted' });
      await quoteVersions.setStatus(trx, bv2.id, 'sent', 'accepted');
      await quotes.setStatus(trx, borisQuote.id, null, { status: 'accepted', withdrawn_reason: null });
      await obligations.insertMany(trx, agreement.id, [{ position: 0, obligor_person_id: null, obligor_company_id: supplier, kind: 'deliver', due: null, amount_minor: null, currency: null, scope_value: null, scope_unit: null }]);
      assert.equal(accepted?.status, 'accepted_by_both');
    });
    await fails(as(boris, (trx) => obligations.insertMany(trx, agreement.id, [{ position: 1, obligor_person_id: xenia, obligor_company_id: null, kind: 'pay', due: null, amount_minor: '1', currency: 'USD', scope_value: null, scope_unit: null }])), 'commerce.not_authorised');
    await fails(as(boris, (trx) => trx.updateTable('obligation').set({ status: 'fulfilled' }).where('agreement_id', '=', agreement.id).execute()), 'commerce.invalid_transition');
    const events = await as(petr, (trx) => acceptanceEvents.listFor(trx, agreement.id));
    assert.deepEqual(events.map((e) => e.kind), ['buyer_accepts_terms', 'seller_accepts_order']);
    assert.ok(events.every((e) => e.accepted_terms_digest === agreement.accepted_terms_digest), 'both acceptances carry the same digest');
    await fails(as(boris, (trx) => quotes.setStatus(trx, borisQuote.id, null, { status: 'withdrawn', withdrawn_reason: 'too late' })), 'commerce.version_frozen');
  });

  /* ---------- Concurrency ---------- */
  await t.test('two concurrent acceptances of different quotes on one RFQ: exactly one agreement commits', async () => {
    const rfq = await publishRfq('20');
    const rv = { id: rfq.version.id, version: 1, digest: rfq.version.digest as string };
    const sellers = [{ person: boris, company: supplier, key: 'company' as const }, { person: carl, company: null, key: 'person' as const }];
    const sent: { quote: QuoteRow; version: QuoteVersionRow }[] = [];
    for (const s of sellers) {
      const inv = await invite(rfq.rfqId, rv.id, s.key === 'company' ? { company: supplier } : { person: carl });
      const quote = await as(s.person, (trx) => quotes.insert(trx, { rfq_id: rfq.rfqId, seller_person_id: s.key === 'person' ? carl : null, seller_company_id: s.key === 'company' ? supplier : null, invitation_id: inv.id, creator_person_id: s.person }));
      await as(s.person, (trx) => quotePrivate.insert(trx, { quote_id: quote.id, owner_person_id: s.key === 'person' ? carl : null, owner_company_id: s.key === 'company' ? supplier : null, floor_prices: {}, margin_targets: {}, cost_basis: {}, negotiation_notes: '', updated_by_person_id: s.person }));
      const version = await sendVersion(s.person, quote, await draftVersion(s.person, quote, 1, rv, quotePayload('20')), rv, quotePayload('20'), inv.id);
      sent.push({ quote, version });
    }
    const accept = (i: number, pause: number) => as(petr, async (trx) => {
      const row = await agreements.insert(trx, agreementRow(sent[i]!.quote, sent[i]!.version, rv));
      await acceptanceEvents.insert(trx, eventRow(row, 'buyer_accepts_terms', petr, { person: petr, company: null }, `race-${i}`));
      await sleep(pause);
      return row.id;
    });
    const results = await Promise.allSettled([accept(0, 150), accept(1, 0)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status === 'rejected' ? (r.reason as PgError).code : 'ok')));
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal((rejected.reason as PgError).code, '23505');
    const live = await withMaintenance(db.admin, (trx) => trx.selectFrom('agreement').select('id').where('rfq_id', '=', rfq.rfqId).execute());
    assert.equal(live.length, 1);
  });

  await t.test('a send racing an amendment: either the send commits first and is flagged stale, or it is refused', async () => {
    const rfq = await publishRfq('30');
    const rv = { id: rfq.version.id, version: 1, digest: rfq.version.digest as string };
    const inv = await invite(rfq.rfqId, rv.id, { person: carl });
    const quote = await as(carl, (trx) => quotes.insert(trx, { rfq_id: rfq.rfqId, seller_person_id: carl, seller_company_id: null, invitation_id: inv.id, creator_person_id: carl }));
    await as(carl, (trx) => quotePrivate.insert(trx, { quote_id: quote.id, owner_person_id: carl, owner_company_id: null, floor_prices: {}, margin_targets: {}, cost_basis: {}, negotiation_notes: '', updated_by_person_id: carl }));
    const draft = await draftVersion(carl, quote, 1, rv, quotePayload('30'));
    const [sendResult, amendResult] = await Promise.allSettled([sendVersion(carl, quote, draft, rv, quotePayload('30'), inv.id), (async () => { await sleep(20); return amendRfq(rfq.rfqId, rv.id, '300', 2); })()]);
    assert.equal(amendResult.status, 'fulfilled');
    const after = await as(carl, (trx) => quoteVersions.get(trx, draft.id));
    if (sendResult.status === 'fulfilled') assert.equal(after?.stale_reason, 'rfq_amended', 'a send that committed first is flagged by the amendment');
    else assert.equal((sendResult.reason as PgError).hint, 'commerce.rfq_version_not_current', String(sendResult.reason));
  });
});
