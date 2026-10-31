import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as c from '../../packages/contracts/src/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../packages/contracts/fixtures/rfq-amendment.json', import.meta.url), 'utf8'));
const rfq = c.RfqSchema.parse(fixture.records.Rfq[0]);
const [v1, v2, v3] = fixture.records.RfqVersion.map((v: unknown) => c.RfqVersionSchema.parse(v)) as [c.RfqVersion, c.RfqVersion, c.RfqVersion];
const [q1, q2] = fixture.records.QuoteVersion.map((v: unknown) => c.QuoteVersionSchema.parse(v)) as [c.QuoteVersion, c.QuoteVersion];
const now = new Date('2026-10-07T00:00:00Z');

test('published RFQ versions are immutable; drafts are not', () => {
  assert.equal(c.rfqVersionMutable(v1), false);
  assert.equal(c.rfqVersionMutable(v2), false);
  assert.equal(c.rfqVersionMutable(v3), true);
  assert.ok(c.verifyRfqVersionDigest(v1));
  assert.ok(c.verifyRfqVersionDigest(v2));
  assert.equal(c.verifyRfqVersionDigest({ ...v2, payload: { ...v2.payload, title: 'edited' } }), false);
  assert.equal(c.RfqVersionSchema.safeParse({ ...v2, digest: null }).success, false, 'published without digest');
  assert.equal(c.RfqVersionSchema.safeParse({ ...v2, amendmentReason: null }).success, false, 'amendment without reason');
  assert.equal(c.RfqVersionSchema.safeParse({ ...v1, supersededBy: null }).success, false, 'superseded without pointer');
});
test('old quote against qty10 v1 is stale by version identity after qty100 v2 and cannot be accepted', () => {
  assert.equal(c.isQuoteStale(q1.rfqVersion.id, rfq.currentVersionId!), true);
  assert.equal(c.isQuoteStale(q2.rfqVersion.id, rfq.currentVersionId!), false);
  assert.equal(c.checkAcceptance({ quoteVersion: q1, quoteRef: c.quoteVersionRef(q1), currentRfqVersion: v2, now }), 'commercial.stale_version');
  assert.equal(c.checkAcceptance({ quoteVersion: q2, quoteRef: c.quoteVersionRef(q2), currentRfqVersion: v2, now }), 'ok');
  assert.deepEqual(
    c.comparableQuoteVersions([q1, q2], rfq.currentVersionId!).comparable.map((q) => q.id),
    ['quote-amend-v2'],
  );
  assert.deepEqual(
    c.comparableQuoteVersions([q1, q2], rfq.currentVersionId!).historical.map((q) => q.id),
    ['quote-amend-v1'],
  );
  assert.equal(c.canDraftAgainst(rfq, v1.id), 'commercial.rfq_version_not_current');
  assert.equal(c.canDraftAgainst(rfq, v2.id), 'ok');
});
test('RFQ v3 restoring the v1 scope has an equal digest but a distinct id, so v1 quotes stay stale', () => {
  assert.equal(c.computeRfqVersionDigest(v3.payload).value, v1.digest!.value);
  assert.notEqual(v3.id, v1.id);
  assert.equal(c.isQuoteStale(q1.rfqVersion.id, v3.id), true);
});
test('acceptance binds the exact version digest and rejects substitution, expiry and unsent versions', () => {
  const forgedRef = { ...c.quoteVersionRef(q2), digest: c.computeDigest({ forged: true }) };
  assert.equal(c.checkAcceptance({ quoteVersion: q2, quoteRef: forgedRef, currentRfqVersion: v2, now }), 'commercial.digest_mismatch');
  const repointed = { ...q2, rfqVersion: { ...q2.rfqVersion, digest: c.computeDigest({ other: 1 }) } };
  assert.equal(c.checkAcceptance({ quoteVersion: repointed, quoteRef: c.quoteVersionRef(repointed), currentRfqVersion: v2, now }), 'commercial.digest_mismatch');
  assert.equal(c.checkAcceptance({ quoteVersion: q2, quoteRef: c.quoteVersionRef(q2), currentRfqVersion: v2, now: new Date('2027-01-01T00:00:00Z') }), 'commercial.quote_expired');
  const wrongVersionNumber = { ...c.quoteVersionRef(q2), version: 9 };
  assert.equal(c.checkAcceptance({ quoteVersion: q2, quoteRef: wrongVersionNumber, currentRfqVersion: v2, now }), 'commercial.digest_mismatch', 'version number must match the stored row');
  const tamperedQuote = { ...q2, payload: { ...q2.payload, paymentTerms: 'prepayment 100%' } };
  assert.equal(
    c.checkAcceptance({ quoteVersion: tamperedQuote, quoteRef: c.quoteVersionRef(tamperedQuote), currentRfqVersion: v2, now }),
    'commercial.digest_mismatch',
    'stored quote payload no longer reproduces its digest',
  );
  const tamperedRfq = { ...v2, payload: { ...v2.payload, acceptanceCriteria: 'edited in storage' } };
  assert.equal(c.checkAcceptance({ quoteVersion: q2, quoteRef: c.quoteVersionRef(q2), currentRfqVersion: tamperedRfq, now }), 'commercial.digest_mismatch', 'stored RFQ payload no longer reproduces its digest');
  const mirrorBroken = { ...q2, validUntil: '2099-01-01T00:00:00Z' };
  assert.equal(c.QuoteVersionSchema.safeParse(mirrorBroken).success, false, 'validUntil must mirror payload.validity.until');
  assert.equal(
    c.checkAcceptance({ quoteVersion: mirrorBroken, quoteRef: c.quoteVersionRef(mirrorBroken), currentRfqVersion: v2, now: new Date('2027-01-01T00:00:00Z') }),
    'commercial.quote_expired',
    'expiry is read from the frozen payload, not the mutable column',
  );
  assert.equal(c.checkAcceptance({ quoteVersion: { ...q2, status: 'withdrawn' }, quoteRef: c.quoteVersionRef(q2), currentRfqVersion: v2, now }), 'commercial.quote_not_acceptable');
  assert.equal(c.checkAcceptance({ quoteVersion: q2, quoteRef: c.quoteVersionRef(q2), currentRfqVersion: v1, now }), 'commercial.rfq_version_mismatch');
});
test('quote digest covers the RFQ pin: same payload under another RFQ version is a different digest', () => {
  const a = c.computeQuoteVersionDigest(c.rfqVersionRef(v1), q1.payload);
  const b = c.computeQuoteVersionDigest(c.rfqVersionRef(v2), q1.payload);
  assert.notEqual(a.value, b.value);
  assert.equal(a.value, q1.digest!.value);
  assert.ok(c.verifyQuoteVersionDigest(q1));
  assert.equal(c.verifyQuoteVersionDigest({ ...q1, rfqVersion: c.rfqVersionRef(v2) }), false);
  assert.equal(c.quoteVersionMutable(q1), false);
});
test('agreement digest is computed once over the two version refs and acceptance events must match it', () => {
  const agreement = c.AgreementSchema.parse(fixture.records.Agreement[0]);
  assert.ok(c.AgreementRecordSchema.safeParse({ ...agreement, acceptedTerms: { ...agreement.acceptedTerms, digest: c.computeDigest({}) } }).success, 'the client-safe record schema has no digest refinement');
  const event = c.AcceptanceEventSchema.parse(fixture.records.AcceptanceEvent[0]);
  assert.deepEqual(agreement.acceptedTerms.digest, c.computeAgreementDigest(agreement.acceptedTerms.quoteVersion, agreement.acceptedTerms.rfqVersion));
  assert.equal(c.AgreementSchema.safeParse({ ...agreement, acceptedTerms: { ...agreement.acceptedTerms, digest: c.computeDigest({}) } }).success, false);
  assert.equal(c.AcceptanceEventSchema.safeParse({ ...event, acceptedTermsDigest: c.computeDigest({}) }).success, false);
  assert.equal(c.AcceptanceEventSchema.safeParse({ ...event, rfqVersion: c.rfqVersionRef(v1) }).success, false, 'event pinned to a different RFQ version does not match the agreement digest');
});
test('quote totals are recomputed from lines; mismatch and mixed currencies fail', () => {
  const p = q2.payload;
  assert.equal(c.verifyQuoteTotals(p), 'ok');
  assert.equal(c.verifyQuoteTotals({ ...p, totals: { ...p.totals, gross: { minorUnits: '1', currency: 'UZS' } } }), 'commercial.totals_mismatch');
  assert.equal(c.verifyQuoteTotals({ ...p, lines: [{ ...p.lines[0]!, lineTotal: { minorUnits: '150000000', currency: 'USD' } }] }), 'commercial.currency_mismatch');
  assert.equal(c.QuoteVersionPayloadSchema.safeParse({ ...p, totals: { ...p.totals, net: { minorUnits: '2', currency: 'UZS' } } }).success, false);
});
test('shared RFQ and quote projections strip buyer and seller private data', () => {
  const mixed = JSON.parse(readFileSync(new URL('../../packages/contracts/fixtures/mixed-company.json', import.meta.url), 'utf8'));
  const view = c.RfqOwnerViewSchema.parse({ rfq: mixed.records.Rfq[0], version: mixed.records.RfqVersion[0], privateConstraint: mixed.records.RfqPrivateConstraint[0], invitations: [] });
  const shared = c.toSharedRfqVersion(view.version)!;
  const sharedJson = JSON.stringify(shared);
  for (const forbidden of ['budgetCeiling', 'internalNotes', 'evaluationWeights', 'shortlist', 'invitations', 'publishedBy', 'creatorPersonId']) assert.ok(!sharedJson.includes(forbidden), forbidden);
  assert.equal(c.toSharedRfqVersion(v3), null, 'drafts are never shared');
  const pub = c.toPublicRfq({ rfq: view.rfq, version: view.version })!;
  assert.deepEqual(Object.keys(pub).sort(), ['id', 'openUntil', 'region', 'title']);
  assert.equal(c.toPublicRfq({ rfq: { ...view.rfq, publicProjection: { enabled: false, fields: [] } }, version: view.version }), null);
  const seller = c.QuoteSellerViewSchema.parse({ quote: mixed.records.Quote[0], version: mixed.records.QuoteVersion[0], privateConstraint: mixed.records.QuotePrivateConstraint[0] });
  const sharedQuote = JSON.stringify(c.toSharedQuoteVersion(seller));
  for (const forbidden of ['floorPrices', 'marginTargets', 'costBasis', 'negotiationNotes', 'offeringVersionRef', 'sentBy']) assert.ok(!sharedQuote.includes(forbidden), forbidden);
  assert.ok(sharedQuote.includes('"digest"') && sharedQuote.includes('"rfqVersion"'));
  assert.equal(c.toPublicQuote(), null);
  assert.equal(c.toSharedQuoteVersion({ version: { ...seller.version, status: 'draft', digest: null, sentAt: null, sentBy: null, validUntil: null } }), null);
});
test('shared, buyer and seller agreement projections never cross party-private boundaries', () => {
  const agreement = c.AgreementSchema.parse(fixture.records.Agreement[0]);
  const buyerPrivate = c.AgreementBuyerPrivateSchema.parse(fixture.records.AgreementBuyerPrivate[0]);
  const sellerPrivate = c.AgreementSellerPrivateSchema.parse(fixture.records.AgreementSellerPrivate[0]);
  assert.equal(c.AgreementRecordSchema.safeParse({ ...agreement, transactionBudgetId: 'b' }).success, false, 'private fields are not part of the agreement record');
  const shared = JSON.stringify(c.toSharedAgreement(agreement));
  for (const forbidden of ['transactionBudgetId', 'approvalRefs', 'fulfilmentPlan', 'internalOwnerPersonId', 'notes']) assert.ok(!shared.includes(forbidden), forbidden);
  const buyer = JSON.stringify(c.toBuyerAgreement({ agreement, buyerPrivate }));
  assert.ok(buyer.includes('"transactionBudgetId"') && buyer.includes('"approvalRefs"'));
  for (const forbidden of ['fulfilmentPlan', 'internalOwnerPersonId', 'ownerParty']) assert.ok(!buyer.includes(forbidden), `buyer view leaks ${forbidden}`);
  const seller = JSON.stringify(c.toSellerAgreement({ agreement, sellerPrivate }));
  assert.ok(seller.includes('"fulfilmentPlan"'));
  for (const forbidden of ['transactionBudgetId', 'approvalRefs', 'ownerParty']) assert.ok(!seller.includes(forbidden), `seller view leaks ${forbidden}`);
  assert.equal(c.BuyerAgreementSchema.safeParse({ ...c.toBuyerAgreement({ agreement, buyerPrivate }), sellerPrivate: {} }).success, false);
  assert.equal(c.toPublicAgreement(), null);
});
