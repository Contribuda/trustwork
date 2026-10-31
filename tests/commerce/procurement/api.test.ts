import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../../packages/data/src/repositories/kernel.js';
import {
  COMMERCE_EVENT_PAYLOAD_KEYS, SUPPLIER_FORBIDDEN_KEYS, type Need, type OwnerOfferingView, type OwnerRfqView, type PublicOffering, type SupplierRfqView,
} from '../../../packages/contracts/src/commerce.js';
import type { PlanContent, PlanItem } from '../../../packages/contracts/src/plans.js';
import { ProcurementService } from '../../../apps/api/src/modules/procurement/procurement.service.js';
import { AllowListCommerceMandates } from '../../../apps/api/src/modules/procurement/mandates.js';
import type { RequestState } from '../../../apps/api/src/common/request.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../../backend/helpers/app.js';
import { login, seedPersonas } from '../../backend/helpers/personas.js';

/**
 * COM-001 through the HTTP API (real database, runtime role, CSRF, idempotency): a company catalogue with immutable
 * versions and private knowledge, a need clarified and converted into an RFQ, an RFQ published, suppliers invited to
 * the exact version, an amendment flagging them stale and their revalidation; forbidden-field checks for every
 * supplier-facing and public read, negative authorization for outsiders, concurrent publishers and inviters, payment
 * equality, agent requests that need a mandate, and a plan item that becomes an RFQ.
 */
const h = await startHarness('commerce_api');

const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
const LINES = (quantity: string) => [
  { lineId: 'pavers', kind: 'goods', description: 'Concrete pavers, grey', specification: { thickness: '60 mm' }, quantity: { value: quantity, unit: 'm2' }, alternativesAllowed: true },
  { lineId: 'laying', kind: 'works', description: 'Lay the pavers on a compacted base', specification: {}, quantity: { value: '1', unit: 'ls' }, alternativesAllowed: false },
  { lineId: 'supervision', kind: 'services', description: 'Site supervision', specification: {}, quantity: { value: '8', unit: 'h' }, alternativesAllowed: false },
];
const PAYLOAD = (quantity = '10', title = 'Patio pavers and laying') => ({
  title, lines: LINES(quantity), deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } },
  acceptanceCriteria: 'Level within 3 mm per metre', paymentTermsRequested: 'Net 30', currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [],
});
const PRIVATE = { budgetCeiling: { minorUnits: '1234500', currency: 'USD' }, evaluationWeights: { price: '0.7', schedule: '0.3' }, internalNotes: 'PRIVATE-buyer-ceiling-note', shortlist: [] as unknown[] };
const SECRETS = ['1234500', 'PRIVATE-', 'budgetCeiling', 'evaluationWeights', 'internalNotes', 'shortlist', 'costBasis', 'marginTarget', 'privateKnowledge', 'privateConstraint'];
const offeringPayload = (title: string, thickness: string, price: string) => ({
  title, description: 'Interlocking concrete pavers', specification: { thickness, colour: 'grey' }, unit: 'm2', listPrice: { minorUnits: price, currency: 'USD' }, options: [],
  availability: { state: 'available', capacity: { value: '800', unit: 'm2' }, observedAt: '2026-10-31T10:00:00.000Z' }, components: [],
});
const PRIVATE_KNOWLEDGE = { costBasis: { minorUnits: '2100', currency: 'USD' }, marginTarget: '0.22', notes: 'PRIVATE-supplier-cost-note' };

function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
function noLeak(value: unknown, extra: readonly string[] = []): void {
  const json = JSON.stringify(value);
  for (const key of SUPPLIER_FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} reached a supplier or the public: ${json.slice(0, 300)}`);
  for (const secret of [...SECRETS, ...extra]) assert.ok(!json.includes(secret), `${secret} leaked: ${json.slice(0, 300)}`);
}

test('commerce API: catalogue, needs, RFQs and invitations with negative authorization, staleness and concurrency', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  // Anna (mixed company administrator) may also publish; everyone else keeps the fixture permissions.
  await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.page.edit', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit', 'company.publish'] }).where('id', '=', seed.memberships.anna).execute());
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const [petr, anna, boris, carl, xenia] = [await as('petr'), await as('anna'), await as('boris'), await as('carl'), await as('xenia')];
  const anonymous = h.client();
  const mixed = { kind: 'company' as const, id: seed.companies.mixed };
  const supplier = { kind: 'company' as const, id: seed.companies.supplier };

  /* ---------- Catalogue ---------- */
  let offering: OwnerOfferingView;
  await t.test('catalogue: owner side only; a published version never changes; the public sees allowlisted fields only', async () => {
    const body = { owner: mixed, kind: 'goods', draft: { payload: offeringPayload('Patio pavers', '60 mm', '3200'), publicFields: ['title', 'unit', 'specification', 'listPrice'], privateKnowledge: PRIVATE_KNOWLEDGE }, actor: { via: 'person' } };
    expectError(await anonymous.post('/v1/catalogue', body, { idempotencyKey: null }), 401, 'auth.session_invalid');
    expectError(await carl.post('/v1/catalogue', body), 403, 'access.forbidden');
    expectError(await boris.post('/v1/catalogue', body), 403, 'access.forbidden');
    expectError(await anna.post('/v1/catalogue', { ...body, kind: 'bundle' }), 422, 'validation.schema');
    expectError(await anna.post('/v1/catalogue', { ...body, draft: { ...body.draft, payload: { ...body.draft.payload, unit: 'cubit' } } }), 422, 'validation.schema');
    offering = ok<OwnerOfferingView>(await anna.post('/v1/catalogue', body), 201);
    assert.equal(offering.offering.status, 'draft');
    assert.deepEqual(offering.versions[0]?.privateKnowledge, PRIVATE_KNOWLEDGE);
    const id = offering.offering.id;
    for (const outsider of [boris, carl, xenia, anonymous]) expectError(await outsider.get(`/v1/catalogue/${id}`), 404, 'access.not_found');
    const v1 = offering.versions[0]!;
    expectError(await boris.post(`/v1/catalogue/${id}/versions/${v1.id}/publish`, { expectedRevision: offering.offering.revision, actor: { via: 'person' } }), 404, 'access.not_found');
    offering = ok<OwnerOfferingView>(await anna.post(`/v1/catalogue/${id}/versions/${v1.id}/publish`, { expectedRevision: offering.offering.revision, actor: { via: 'person' } }));
    assert.equal(offering.offering.status, 'active');
    assert.equal(offering.versions[0]?.status, 'published');
    assert.equal(offering.versions[0]?.digest?.algorithm, 'trustwork-digest-1');
    expectError(await anna.post(`/v1/catalogue/${id}/versions/${v1.id}`, { expectedRevision: offering.offering.revision, draft: body.draft, actor: { via: 'person' } }), 409, 'commercial.version_immutable');

    const listing = ok<{ offerings: PublicOffering[] }>(await anonymous.get(`/v1/catalogue?ownerKind=company&ownerId=${mixed.id}`));
    assert.equal(listing.offerings.length, 1);
    assert.deepEqual(Object.keys(listing.offerings[0]!.fields).sort(), ['listPrice', 'specification', 'title', 'unit']);
    noLeak(listing, ['2100', 'Interlocking', 'availability']);
    noLeak(ok(await boris.get(`/v1/catalogue/${id}`)), ['2100']);

    // A catalogue edit: a new version; the old one stays exactly what quotes cited.
    offering = ok<OwnerOfferingView>(await anna.post(`/v1/catalogue/${id}/versions`, { expectedRevision: offering.offering.revision, actor: { via: 'person' } }), 201);
    const v2 = offering.versions.find((v) => v.version === 2)!;
    expectError(await anna.post(`/v1/catalogue/${id}/versions/${v2.id}`, { expectedRevision: offering.offering.revision - 1, draft: body.draft, actor: { via: 'person' } }), 409, 'validation.revision_conflict');
    offering = ok<OwnerOfferingView>(await anna.post(`/v1/catalogue/${id}/versions/${v2.id}`, { expectedRevision: offering.offering.revision, draft: { ...body.draft, payload: offeringPayload('Patio pavers', '80 mm', '3900') }, actor: { via: 'person' } }));
    offering = ok<OwnerOfferingView>(await anna.post(`/v1/catalogue/${id}/versions/${v2.id}/publish`, { expectedRevision: offering.offering.revision, actor: { via: 'person' } }));
    assert.deepEqual(offering.versions.map((v) => [v.version, v.status]), [[1, 'superseded'], [2, 'published']]);
    const old = ok<PublicOffering>(await anonymous.get(`/v1/catalogue/${id}?version=1`));
    assert.deepEqual(old.fields.specification, { thickness: '60 mm', colour: 'grey' }, 'version 1 still reads as it was published');
    assert.equal(old.current, false);
    assert.deepEqual(ok<PublicOffering>(await anonymous.get(`/v1/catalogue/${id}`)).fields.listPrice, { minorUnits: '3900', currency: 'USD' });
    offering = ok<OwnerOfferingView>(await anna.post(`/v1/catalogue/${id}/versions/${v1.id}/private`, { expectedRevision: offering.offering.revision, privateKnowledge: { ...PRIVATE_KNOWLEDGE, notes: 'PRIVATE-updated-note' } }));
    noLeak(ok(await anonymous.get(`/v1/catalogue?ownerKind=company&ownerId=${mixed.id}`)), ['updated-note']);
  });

  /* ---------- Needs ---------- */
  let convertedRfq: OwnerRfqView;
  await t.test('needs: clarification lists what is missing; a ready need converts once into an RFQ draft; outsiders see nothing', async () => {
    const vague = {
      owner: { kind: 'person', id: seed.people.petr }, projectId: seed.project, source: 'file', actor: { via: 'person' },
      fields: { title: 'Back patio', description: 'From the drawing', region: 'US-CA', window: null, acceptanceCriteria: null, lines: [{ kind: null, description: 'Pavers', quantity: null, specification: {}, alternativesAllowed: true, evidence: { source: 'photo', ref: 'upload-demo-1', locator: 'top left' } }] },
    };
    expectError(await boris.post('/v1/needs', vague), 403, 'access.forbidden');
    let need = ok<Need>(await petr.post('/v1/needs', vague), 201);
    assert.equal(need.status, 'clarifying');
    assert.deepEqual(need.missingFields, ['lines.0.kind', 'lines.0.quantity', 'window', 'acceptanceCriteria']);
    for (const outsider of [boris, carl, anna]) expectError(await outsider.get(`/v1/needs/${need.id}`), 404, 'access.not_found');
    expectError(await anonymous.get(`/v1/needs/${need.id}`), 401, 'auth.session_invalid');
    expectError(await petr.post(`/v1/needs/${need.id}/convert`, { expectedRevision: need.revision, rfq: { currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', paymentTermsRequested: null, attachments: [], category: null }, privateConstraint: null, actor: { via: 'person' } }), 422, 'validation.schema');
    need = ok<Need>(await petr.post(`/v1/needs/${need.id}`, {
      expectedRevision: need.revision, actor: { via: 'person' },
      fields: { ...vague.fields, window: { from: bdate('2027-04-01'), to: bdate('2027-04-30') }, acceptanceCriteria: 'Owner walk-through', lines: [{ ...vague.fields.lines[0], kind: 'goods', quantity: { value: '30', unit: 'm2' } }, { kind: 'works', description: 'Laying', quantity: { value: '1', unit: 'ls' }, specification: {}, alternativesAllowed: false, evidence: null }] },
    }));
    assert.equal(need.status, 'ready');
    assert.deepEqual(need.missingFields, []);
    convertedRfq = ok<OwnerRfqView>(await petr.post(`/v1/needs/${need.id}/convert`, { expectedRevision: need.revision, rfq: { currency: 'USD', responseDeadline: '2027-03-15T17:00:00.000Z', paymentTermsRequested: null, attachments: [], category: 'landscaping' }, privateConstraint: PRIVATE, actor: { via: 'person' } }), 201);
    assert.equal(convertedRfq.origin.needId, need.id);
    assert.deepEqual(convertedRfq.versions[0]?.payload.lines.map((l) => l.lineId), need.lines.map((l) => l.lineId), 'RFQ lines keep the need line ids');
    const after = ok<Need>(await petr.get(`/v1/needs/${need.id}`));
    assert.equal(after.status, 'converted');
    assert.equal(after.rfqId, convertedRfq.rfq.id);
    expectError(await petr.post(`/v1/needs/${need.id}`, { expectedRevision: after.revision, fields: vague.fields, actor: { via: 'person' } }), 409, 'commercial.version_immutable');
    assert.equal(ok<{ needs: unknown[] }>(await carl.get('/v1/needs')).needs.length, 0);
    const mine = ok<{ needs: { id: string; status: string }[] }>(await petr.get('/v1/needs'));
    assert.deepEqual(mine.needs.map((n) => [n.id, n.status]), [[need.id, 'converted']]);
  });

  /* ---------- RFQ journey ---------- */
  let rfq: OwnerRfqView;
  const R = () => `/v1/rfqs/${rfq.rfq.id}`;
  await t.test('RFQ: the buyer drafts with mixed lines and private constraints, publishes an immutable digested version and invites the exact version', async () => {
    const create = { owner: mixed, projectId: null, payload: PAYLOAD(), category: 'landscaping', publicProjection: { enabled: false, fields: [] }, privateConstraint: PRIVATE, source: null, actor: { via: 'person' } };
    expectError(await boris.post('/v1/rfqs', create), 403, 'access.forbidden');
    expectError(await carl.post('/v1/rfqs', create), 403, 'access.forbidden');
    expectError(await anna.post('/v1/rfqs', { ...create, payload: { ...PAYLOAD(), lines: [{ ...LINES('5')[0], quantity: { value: '5', unit: 'acre-foot' } }] } }), 422, 'validation.schema');
    rfq = ok<OwnerRfqView>(await anna.post('/v1/rfqs', create), 201);
    assert.deepEqual(rfq.versions[0]?.payload.lines.map((l) => [l.kind, l.quantity.unit]), [['goods', 'm2'], ['works', 'ls'], ['services', 'h']], 'goods, works and services with explicit units');
    assert.equal(rfq.privateConstraint.budgetCeiling?.minorUnits, '1234500');
    for (const outsider of [boris, carl, xenia]) expectError(await outsider.get(R()), 404, 'access.not_found');
    expectError(await anonymous.get(R()), 404, 'access.not_found');
    const v1 = rfq.versions[0]!;
    expectError(await anna.post(`${R()}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: v1.id, party: supplier, channel: 'platform', actor: { via: 'person' } }), 409, 'commercial.rfq_version_not_current');
    expectError(await boris.post(`${R()}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: { via: 'person' } }), 404, 'access.not_found');
    expectError(await anna.post(`${R()}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: 'not an amendment', actor: { via: 'person' } }), 422, 'validation.schema');
    rfq = ok<OwnerRfqView>(await anna.post(`${R()}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: { via: 'person' } }));
    assert.equal(rfq.rfq.status, 'published');
    assert.equal(rfq.rfq.currentVersionId, v1.id);
    assert.equal(rfq.versions[0]?.digest?.algorithm, 'trustwork-digest-1');
    expectError(await anna.post(`${R()}/versions/${v1.id}`, { expectedRevision: rfq.rfq.revision, payload: PAYLOAD('11'), actor: { via: 'person' } }), 409, 'commercial.version_immutable');

    const invite = (party: { kind: 'person' | 'company'; id: string }, versionId = v1.id) => anna.post(`${R()}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: versionId, party, channel: 'platform', actor: { via: 'person' } });
    expectError(await boris.post(`${R()}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: v1.id, party: supplier, channel: 'platform', actor: { via: 'person' } }), 404, 'access.not_found');
    expectError(await invite(mixed), 422, 'validation.schema');
    const sent = ok<{ id: string; rfqVersion: { id: string; version: number }; staleReason: null }>(await invite(supplier), 201);
    assert.deepEqual([sent.rfqVersion.id, sent.rfqVersion.version, sent.staleReason], [v1.id, 1, null], 'the invitation pins the exact version');
    ok(await invite({ kind: 'person', id: seed.people.pure }), 201);
    expectError(await invite(supplier), 409, 'validation.revision_conflict');
  });

  await t.test('forbidden fields: the supplier view, the invitation list, the public read and the event payloads carry no buyer-private data', async () => {
    const view = ok<SupplierRfqView>(await boris.get(R()));
    assert.equal(view.projection, 'shared_party');
    assert.equal(view.versions.length, 1);
    assert.equal(view.invitations.length, 1, 'only its own invitation, never the other invitees');
    assert.ok(!JSON.stringify(view).includes(seed.people.pure), 'other invitees are not revealed');
    noLeak(view, [seed.people.anna]);
    const list = ok<{ invitations: { invitation: { id: string }; title: string }[] }>(await boris.get('/v1/rfq-invitations'));
    assert.equal(list.invitations.length, 1);
    noLeak(list);
    assert.equal(ok<{ invitations: unknown[] }>(await carl.get('/v1/rfq-invitations')).invitations.length, 0);
    expectError(await anonymous.get(`${R()}/public`), 404, 'access.not_found');
    expectError(await boris.post(`${R()}/private`, { ...PRIVATE, expectedRevision: rfq.privateConstraint.revision }), 404, 'access.not_found');
    const events = await h.db.admin.query<{ type: string; payload: Record<string, unknown> }>("SELECT type, payload FROM trustwork.outbox_event WHERE aggregate_kind IN ('rfq', 'need', 'offering') ORDER BY id");
    assert.ok(events.rows.some((e) => e.type === 'rfq.invitation_sent'), 'invitations notify through the outbox');
    for (const event of events.rows) {
      for (const key of Object.keys(event.payload)) assert.ok((COMMERCE_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key), `${event.type}: ${key} is not an identifier`);
      const json = JSON.stringify(event.payload);
      for (const secret of [...SECRETS, '2100', 'Patio', 'Level within']) assert.ok(!json.includes(secret), `${event.type}: ${secret} in an event`);
    }
    const audit = await h.db.admin.query<{ basis: unknown }>("SELECT basis FROM trustwork.audit_event WHERE action = 'rfq.private_constraint_saved' OR action = 'rfq.created'");
    noLeak(audit.rows);
  });

  await t.test('amendment: a new version flags earlier invitations stale; the supplier sees only what it was sent until revalidated', async () => {
    const supplierInvitation = rfq.invitations.length ? rfq.invitations : ok<OwnerRfqView>(await anna.get(R())).invitations;
    rfq = ok<OwnerRfqView>(await anna.get(R()));
    const boriss = rfq.invitations.find((i) => i.party.kind === 'company')!;
    assert.ok(supplierInvitation.length === 2);
    const viewed = ok<{ status: string; id: string }>(await boris.post(`/v1/rfq-invitations/${boriss.id}/respond`, { status: 'viewed' }));
    assert.equal(viewed.status, 'viewed');
    expectError(await carl.post(`/v1/rfq-invitations/${boriss.id}/respond`, { status: 'declined' }), 404, 'access.not_found');
    rfq = ok<OwnerRfqView>(await anna.post(`${R()}/versions`, { expectedRevision: rfq.rfq.revision, amendmentReason: 'Quantity changed from 10 to 100 m2', actor: { via: 'person' } }), 201);
    const draft = rfq.versions.find((v) => v.status === 'draft')!;
    rfq = ok<OwnerRfqView>(await anna.post(`${R()}/versions/${draft.id}`, { expectedRevision: rfq.rfq.revision, payload: PAYLOAD('100'), actor: { via: 'person' } }));
    assert.equal(ok<SupplierRfqView>(await boris.get(R())).versions.length, 1, 'the open amendment is invisible to suppliers');
    expectError(await anna.post(`${R()}/publish`, { rfqId: rfq.rfq.id, version: 2, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: { via: 'person' } }), 422, 'validation.schema');
    rfq = ok<OwnerRfqView>(await anna.post(`${R()}/publish`, { rfqId: rfq.rfq.id, version: 2, expectedRevision: rfq.rfq.revision, amendmentReason: 'Quantity changed from 10 to 100 m2', actor: { via: 'person' } }));
    assert.deepEqual(rfq.versions.map((v) => [v.version, v.status]), [[1, 'superseded'], [2, 'published']]);
    assert.ok(rfq.invitations.every((i) => i.staleReason === 'rfq_amended' && i.rfqVersion.version === 1), 'both v1 invitations are flagged');
    assert.deepEqual(rfq.invitations.map((i) => i.status).sort(), ['sent', 'viewed'], 'staleness is a flag, not a status');
    const stale = ok<SupplierRfqView>(await boris.get(R()));
    assert.deepEqual(stale.versions.map((v) => v.version), [1], 'the supplier still sees only v1');
    assert.equal(stale.invitations[0]?.staleReason, 'rfq_amended');
    assert.ok(!JSON.stringify(stale).includes('"100"'), 'the amended quantity is not revealed before revalidation');
    expectError(await boris.post(`/v1/rfq-invitations/${boriss.id}/respond`, { status: 'declined' }), 409, 'commercial.rfq_version_not_current');
    expectError(await anna.post(`${R()}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.versions[0]!.id, party: { kind: 'person', id: seed.people.carl }, channel: 'platform', actor: { via: 'person' } }), 409, 'commercial.rfq_version_not_current');
    const renewed = ok<{ id: string; rfqVersion: { version: number }; staleReason: null }>(await anna.post(`${R()}/invitations/${boriss.id}/revalidate`, { actor: { via: 'person' } }), 201);
    assert.deepEqual([renewed.rfqVersion.version, renewed.staleReason], [2, null]);
    expectError(await anna.post(`${R()}/invitations/${renewed.id}/revalidate`, { actor: { via: 'person' } }), 422, 'validation.schema');
    const fresh = ok<SupplierRfqView>(await boris.get(R()));
    assert.deepEqual(fresh.versions.map((v) => v.version), [1, 2]);
    assert.equal(fresh.invitations.length, 2, 'the stale invitation stays as history beside the renewed one');
    noLeak(fresh, [seed.people.pure]);
    ok(await boris.post(`/v1/rfq-invitations/${renewed.id}/respond`, { status: 'viewed' }));
  });

  await t.test('public projection only when the buyer enables it; closing flags the remaining invitations', async () => {
    rfq = ok<OwnerRfqView>(await anna.get(R()));
    expectError(await boris.post(`${R()}/projection`, { expectedRevision: rfq.rfq.revision, publicProjection: { enabled: true, fields: ['title'] }, category: null }), 404, 'access.not_found');
    rfq = ok<OwnerRfqView>(await anna.post(`${R()}/projection`, { expectedRevision: rfq.rfq.revision, publicProjection: { enabled: true, fields: ['title', 'region', 'lineSummary'] }, category: 'landscaping' }));
    const pub = ok<Record<string, unknown>>(await anonymous.get(`${R()}/public`));
    assert.deepEqual(Object.keys(pub).sort(), ['id', 'lineSummary', 'region', 'title']);
    noLeak(pub, ['Net 30', 'Level within']);
    rfq = ok<OwnerRfqView>(await anna.post(`${R()}/close`, { expectedRevision: rfq.rfq.revision, outcome: 'closed', reason: 'Awarded' }));
    assert.equal(rfq.rfq.status, 'closed');
    assert.ok(rfq.invitations.every((i) => i.staleReason !== null));
    assert.ok(rfq.invitations.some((i) => i.staleReason === 'rfq_closed'));
    expectError(await anonymous.get(`${R()}/public`), 404, 'access.not_found');
    expectError(await anna.post(`${R()}/versions`, { expectedRevision: rfq.rfq.revision, amendmentReason: 'late', actor: { via: 'person' } }), 422, 'validation.schema');
  });

  /* ---------- Concurrency ---------- */
  await t.test('concurrency: two publishers, duplicate inviters, and invitations racing an amendment', async () => {
    let r = ok<OwnerRfqView>(await anna.post('/v1/rfqs', { owner: mixed, projectId: null, payload: PAYLOAD('20', 'Race RFQ'), category: null, publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: { via: 'person' } }), 201);
    const P = `/v1/rfqs/${r.rfq.id}`;
    const publishBody = { rfqId: r.rfq.id, version: 1, expectedRevision: r.rfq.revision, amendmentReason: null, actor: { via: 'person' } };
    const publishes = await Promise.all([anna.post(`${P}/publish`, publishBody), anna.post(`${P}/publish`, publishBody)]);
    assert.deepEqual(publishes.map((x) => x.status).sort(), [200, 409], 'one publication wins, the other is a revision conflict');
    r = ok<OwnerRfqView>(await anna.get(P));
    const invite = (party: { kind: 'person' | 'company'; id: string }) => anna.post(`${P}/invitations`, { rfqId: r.rfq.id, rfqVersionId: r.rfq.currentVersionId, party, channel: 'platform', actor: { via: 'person' } });
    const dupes = await Promise.all([invite(supplier), invite(supplier), invite(supplier)]);
    assert.deepEqual(dupes.map((x) => x.status).sort(), [201, 409, 409], 'one invitation per party and version');
    r = ok<OwnerRfqView>(await anna.post(`${P}/versions`, { expectedRevision: r.rfq.revision, amendmentReason: 'Race amendment', actor: { via: 'person' } }), 201);
    const amendment = anna.post(`${P}/publish`, { rfqId: r.rfq.id, version: 2, expectedRevision: r.rfq.revision, amendmentReason: 'Race amendment', actor: { via: 'person' } });
    const racing = [seed.people.petr, seed.people.carl, seed.people.xenia, seed.people.pure].map((id) => invite({ kind: 'person', id }));
    const [published, ...invites] = await Promise.all([amendment, ...racing]);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    for (const x of invites) assert.ok(x.status === 201 || (x.status === 409 && (x.body as { code: string }).code === 'commercial.rfq_version_not_current'), JSON.stringify(x.body));
    r = ok<OwnerRfqView>(await anna.get(P));
    for (const i of r.invitations) assert.ok(i.rfqVersion.id === r.rfq.currentVersionId || i.staleReason === 'rfq_amended', `invitation ${i.id} is pinned to the current version or flagged`);
  });

  /* ---------- Payment equality ---------- */
  await t.test('payment never buys order: catalogue listings and invitation lists are identical with and without entitlements or sponsorship', async () => {
    const second = ok<OwnerOfferingView>(await anna.post('/v1/catalogue', { owner: mixed, kind: 'services', draft: { payload: { ...offeringPayload('Paver sealing', 'n/a', '900'), unit: 'm2' }, publicFields: ['title'], privateKnowledge: { costBasis: null, marginTarget: null, notes: null } }, actor: { via: 'person' } }), 201);
    ok(await anna.post(`/v1/catalogue/${second.offering.id}/versions/${second.versions[0]!.id}/publish`, { expectedRevision: second.offering.revision, actor: { via: 'person' } }));
    const petrRfq = ok<OwnerRfqView>(await petr.post('/v1/rfqs', { owner: { kind: 'person', id: seed.people.petr }, projectId: null, payload: PAYLOAD('12', 'Petr pavers'), category: null, publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: { via: 'person' } }), 201);
    const published = ok<OwnerRfqView>(await petr.post(`/v1/rfqs/${petrRfq.rfq.id}/publish`, { rfqId: petrRfq.rfq.id, version: 1, expectedRevision: petrRfq.rfq.revision, amendmentReason: null, actor: { via: 'person' } }));
    ok(await petr.post(`/v1/rfqs/${petrRfq.rfq.id}/invitations`, { rfqId: petrRfq.rfq.id, rfqVersionId: published.rfq.currentVersionId, party: supplier, channel: 'platform', actor: { via: 'person' } }), 201);
    const before = { catalogue: ok(await anonymous.get(`/v1/catalogue?ownerKind=company&ownerId=${mixed.id}`)), invitations: ok(await boris.get('/v1/rfq-invitations')), signedIn: ok(await carl.get(`/v1/catalogue?ownerKind=company&ownerId=${mixed.id}`)) };
    assert.equal((before.catalogue as { offerings: unknown[] }).offerings.length, 2);
    assert.ok((before.invitations as { invitations: unknown[] }).invitations.length >= 3);
    // Every party pays: subscriptions, sponsorship and credits are recorded for the buyer companies, the person and the supplier.
    await withMaintenance(h.db.admin, async (trx) => {
      const hub = '00000000-0000-4000-8000-00000000c001';
      const offer = await trx.insertInto('offer').values({ hub_id: hub, code: 'premium_supplier', name: 'Premium', kind: 'plan', status: 'active', created_by: seed.people.anna }).returning('id').executeTakeFirstOrThrow();
      for (const owner of [{ owner_company_id: seed.companies.mixed, owner_person_id: null }, { owner_company_id: seed.companies.supplier, owner_person_id: null }, { owner_company_id: null, owner_person_id: seed.people.petr }]) {
        const account = await trx.insertInto('billing_account').values({ hub_id: hub, ...owner, currency: 'USD', created_by: seed.people.anna }).returning('id').executeTakeFirstOrThrow();
        for (const source of ['sponsorship', 'credit'] as const) {
          await trx.insertInto('entitlement').values({ billing_account_id: account.id, offer_id: offer.id, module_code: 'procurement', limits: JSON.stringify({ priority: 1, boost: 10 }), valid_from: new Date('2026-10-01T00:00:00Z'), source }).execute();
        }
      }
    });
    const after = { catalogue: ok(await anonymous.get(`/v1/catalogue?ownerKind=company&ownerId=${mixed.id}`)), invitations: ok(await boris.get('/v1/rfq-invitations')), signedIn: ok(await carl.get(`/v1/catalogue?ownerKind=company&ownerId=${mixed.id}`)) };
    assert.deepEqual(after, before, 'identical results and order with and without payment');
  });

  /* ---------- Agents ---------- */
  await t.test('an agent drafts under a prepare mandate and invites under a communicate mandate; without a mandate it is refused', async () => {
    expectError(await petr.post('/v1/rfqs', { owner: { kind: 'person', id: seed.people.petr }, projectId: null, payload: PAYLOAD(), category: null, publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: { via: 'agent', mandateId: 'mandate-demo' } }), 403, 'access.mandate_scope');
    const token = petr.sessionCookie as string;
    const resolved = await h.services().principals.resolve(token);
    assert.ok(resolved);
    const state: RequestState = { requestId: 'commerce-agent-test', principal: resolved.principal, session: resolved.session, sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
    const mandates = new AllowListCommerceMandates([{ personId: seed.people.petr, mandateId: 'mandate-demo-buy', action: 'prepare' }, { personId: seed.people.petr, mandateId: 'mandate-demo-buy', action: 'communicate' }]);
    const service = new ProcurementService(h.created.ctx!, h.services().principals, h.services().participations, mandates);
    const agent = { via: 'agent' as const, mandateId: 'mandate-demo-buy' };
    const drafted = await service.createRfq({ owner: { kind: 'person', id: seed.people.petr }, projectId: null, payload: PAYLOAD('7', 'Agent RFQ') as never, category: null, publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: agent }, state);
    await assert.rejects(service.publish(drafted.rfq.id, { rfqId: drafted.rfq.id, version: 1, expectedRevision: drafted.rfq.revision, amendmentReason: null, actor: agent }, state), (e: { code?: string }) => e.code === 'access.mandate_scope', 'publishing needs a publish mandate');
    const published = await service.publish(drafted.rfq.id, { rfqId: drafted.rfq.id, version: 1, expectedRevision: drafted.rfq.revision, amendmentReason: null, actor: { via: 'person' } }, state);
    const invitation = await service.invite(published.rfq.id, { rfqId: published.rfq.id, rfqVersionId: published.rfq.currentVersionId as string, party: supplier, channel: 'assistant', actor: agent }, state);
    assert.deepEqual(invitation.sentBy, { personId: seed.people.petr, mandateId: 'mandate-demo-buy' });
    assert.deepEqual(mandates.checks.map((c) => [c.action, c.context.kind]), [['prepare', 'profile'], ['publish', 'rfq'], ['communicate', 'rfq']]);
  });

  /* ---------- Plan item to RFQ ---------- */
  await t.test('a homeowner plan item of kind purchase becomes an RFQ once; works and company owners do not', async () => {
    const project = ok<{ id: string }>(await petr.post('/v1/projects', { owner: { kind: 'person', id: seed.people.petr }, name: 'Demo patio in Escondido', summary: null, leaderPersonId: null }), 201);
    const item = (over: Partial<PlanItem> & Pick<PlanItem, 'key' | 'kind'>): PlanItem => ({ parentKey: null, title: `Step ${over.key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null, decisionQuestion: null, sources: [], attachments: [], privateNotes: null, ...over });
    const content: PlanContent = {
      summary: 'Patio', assumptions: [], budget: null, timeline: null, dependencies: [],
      items: [item({ key: 'shingles', kind: 'purchase', title: 'Buy shingles', stepTerms: ['material.roofing.asphalt_shingles'], quantity: { value: '22', unit: 'sq' } }), item({ key: 'roofing', kind: 'task', title: 'Re-roof', stepTerms: ['work.envelope.roofing'] })],
    };
    const P = `/v1/projects/${project.id}/plan`;
    const plan = ok<{ draft: { id: string; revision: number } }>(await petr.post(P, { timeZone: 'America/Los_Angeles', actor: { via: 'person' }, content }), 201);
    const proposed = ok<{ revision: number; digest: unknown }>(await petr.post(`${P}/versions/${plan.draft.id}/propose`, { expectedRevision: plan.draft.revision, actor: { via: 'person' } }));
    ok(await petr.post(`${P}/versions/${plan.draft.id}/approve`, { expectedRevision: proposed.revision, digest: proposed.digest }));
    const body = (itemKey: string, owner: { kind: 'person' | 'company'; id: string } = { kind: 'person', id: seed.people.petr }) => ({
      owner, projectId: null, payload: PAYLOAD('22', 'Asphalt shingles'), category: null, publicProjection: { enabled: false, fields: [] }, privateConstraint: null,
      source: { kind: 'plan_item', projectId: project.id, itemKey }, actor: { via: 'person' },
    });
    expectError(await petr.post('/v1/rfqs', body('roofing')), 422, 'validation.schema');
    expectError(await anna.post('/v1/rfqs', body('shingles', mixed)), 422, 'validation.schema');
    expectError(await carl.post('/v1/rfqs', body('shingles', { kind: 'person', id: seed.people.carl })), 422, 'validation.schema');
    const created = ok<OwnerRfqView>(await petr.post('/v1/rfqs', body('shingles')), 201);
    assert.deepEqual(created.origin.planItem, { projectId: project.id, itemKey: 'shingles' });
    type ItemStates = { items: { itemKey: string; status: string; path: string | null; link: { kind: string; id: string } | null }[] };
    const linked = ok<ItemStates>(await petr.get(`${P}/items/states`)).items.find((s) => s.itemKey === 'shingles');
    assert.deepEqual([linked?.status, linked?.path, linked?.link?.kind, linked?.link?.id], ['accepted', 'rfq', 'rfq', created.rfq.id]);
    expectError(await petr.post('/v1/rfqs', body('shingles')), 409, 'validation.revision_conflict');
    ok(await petr.post(`/v1/rfqs/${created.rfq.id}/publish`, { rfqId: created.rfq.id, version: 1, expectedRevision: created.rfq.revision, amendmentReason: null, actor: { via: 'person' } }));
    assert.equal(ok<ItemStates>(await petr.get(`${P}/items/states`)).items.find((s) => s.itemKey === 'shingles')?.status, 'requested', 'publishing the RFQ requests the item');
  });
});
