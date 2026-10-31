import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../../packages/contracts/src/index.js';
import * as m from '../../../packages/contracts/src/commerce.js';
import { SUPPLY_CAPABILITIES } from '../../../packages/contracts/src/supply/index.js';

/**
 * COM-001 contracts: the capability registry entries (AGT-002 shape, ADR 010 decision 23), the need clarification
 * rules, explicit units on mixed goods/works/services lines, catalogue snapshots that later edits cannot touch, and the
 * payment-blind ordering of catalogues and invitations.
 */
const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
const line = (lineId: string, kind: 'goods' | 'works' | 'services', value: string, unit: string) => ({ lineId, kind, description: `Line ${lineId}`, specification: { grade: 'A' }, quantity: { value, unit }, alternativesAllowed: false });
const payload = (lines = [line('l1', 'goods', '120', 'ft2'), line('l2', 'works', '1', 'ls'), line('l3', 'services', '16', 'h')]) => ({
  title: 'Deck rebuild', lines, deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } },
  acceptanceCriteria: 'Inspected by the owner', paymentTermsRequested: null, currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [],
});

test('every commerce capability is a valid AGT-002 entry, reachable from the interface and the agent, and resolves its contracts', async () => {
  const modules: Record<string, Record<string, unknown>> = {};
  for (const entry of m.COMMERCE_CAPABILITIES) {
    const cap = entry.capability;
    assert.deepEqual(c.capabilityViolations(cap), [], cap.id);
    assert.ok(c.AgentCapabilitySchema.safeParse(cap).success, cap.id);
    for (const ref of [cap.input, cap.output]) {
      modules[ref.contract] ??= await import(`../../../packages/contracts/src/${ref.contract}.js`) as Record<string, unknown>;
      assert.ok(modules[ref.contract]?.[ref.schema], `${cap.id}: ${ref.contract}.${ref.schema} is exported`);
    }
    assert.match(entry.apiRoute, /^(GET|POST) \/v1\//, cap.id);
  }
  const caps = m.COMMERCE_CAPABILITIES.map((e) => e.capability);
  assert.deepEqual(c.parityGaps(caps), [], 'every capability is in the interface and the agent');
  assert.equal(new Set(caps.map((x) => x.id)).size, caps.length, 'ids are unique');
  const supplyIds = new Set(SUPPLY_CAPABILITIES.map((e) => e.capability.id));
  assert.deepEqual(caps.filter((x) => supplyIds.has(x.id)).map((x) => x.id), [], 'no id is declared twice next to the procurement suite');
  for (const id of Object.keys(m.COMMERCE_IMPLEMENTED_SUPPLY_CAPABILITIES)) assert.ok(supplyIds.has(id), `${id} is declared by PRC-000 and implemented here`);
  // A registry can be built from these entries without widening anything: commits name mandates, nothing spends money.
  for (const cap of caps) {
    assert.equal(cap.budgetKind, null, `${cap.id} commits no money`);
    if (cap.kind === 'commit') assert.ok(cap.mandateAction !== null && !cap.acceptsUntrustedText, `${cap.id} needs a mandate and structured input`);
    if (cap.privateDataClasses.length > 0) assert.ok(!cap.reads.includes('public'), `${cap.id}: private data never on a public read`);
  }
  const byId = new Map(caps.map((x) => [x.id, x]));
  assert.equal(byId.get('discovery.search_catalogue')?.reads.join(), 'public');
  assert.deepEqual(byId.get('quoting.get_invited_rfq')?.reads, ['shared_party'], 'the supplier reads only the shared projection');
  assert.deepEqual(byId.get('sourcing_desk.invite_supplier')?.sideEffects, ['state_change', 'outbound_message']);
});

test('needs: missing scope, quantity, unit, location, schedule and acceptance are listed; a ready need drafts an RFQ with the same lines', () => {
  const empty = { region: null, window: null, acceptanceCriteria: null, lines: [] };
  assert.deepEqual(m.needMissingFields(empty), ['lines', 'region', 'window', 'acceptanceCriteria']);
  assert.equal(m.needStatusFor(empty), 'draft');
  const vague = { region: 'US-CA', window: null, acceptanceCriteria: null, lines: [{ kind: null, description: 'Pavers', quantity: null, specification: {}, alternativesAllowed: true, evidence: { source: 'spreadsheet' as const, ref: 'upload-1', locator: 'Sheet1!B4' } }] };
  assert.deepEqual(m.needMissingFields(vague), ['lines.0.kind', 'lines.0.quantity', 'window', 'acceptanceCriteria']);
  assert.equal(m.needStatusFor(vague), 'clarifying');
  assert.equal(m.NeedLineInputSchema.safeParse({ ...vague.lines[0], quantity: { value: '10', unit: 'furlong' } }).success, false, 'units come from the catalogue');
  assert.equal(m.NeedFieldsSchema.safeParse({ title: 'x', description: null, region: null, window: { from: bdate('2027-04-02'), to: bdate('2027-04-01') }, acceptanceCriteria: null, lines: [] }).success, false, 'windows end after they start');

  const ready: m.Need = {
    projection: 'owner_private', id: 'need-1', owner: { kind: 'person', id: 'p1' }, projectId: null, source: 'manual', status: 'ready', title: 'Patio', description: null, region: 'US-CA',
    window: { from: bdate('2027-05-01'), to: bdate('2027-05-20') }, acceptanceCriteria: 'Level within 3 mm per metre', missingFields: [], rfqId: null, revision: 2,
    createdAt: '2026-10-31T10:00:00.000Z', updatedAt: '2026-10-31T10:00:00.000Z',
    lines: [
      { lineId: 'nl-1', position: 0, kind: 'goods', description: 'Concrete pavers', quantity: { value: '30.5', unit: 'm2' }, specification: { colour: 'grey' }, alternativesAllowed: true, evidence: null },
      { lineId: 'nl-2', position: 1, kind: 'works', description: 'Lay pavers', quantity: { value: '1', unit: 'ls' }, specification: {}, alternativesAllowed: false, evidence: null },
    ],
  };
  const rfq = m.needToRfqPayload(ready, { currency: 'USD', responseDeadline: '2027-04-01T00:00:00.000Z', paymentTermsRequested: null, attachments: [], category: null });
  assert.deepEqual(rfq.lines.map((l) => [l.lineId, l.kind, l.quantity.value, l.quantity.unit]), [['nl-1', 'goods', '30.5', 'm2'], ['nl-2', 'works', '1', 'ls']]);
  assert.equal(rfq.deliveryTerms.location.region, 'US-CA');
  assert.throws(() => m.needToRfqPayload({ ...ready, status: 'clarifying' }, { currency: 'USD', responseDeadline: '2027-04-01T00:00:00.000Z', paymentTermsRequested: null, attachments: [], category: null }), /only a ready need/);
});

test('RFQ payloads mix goods, works and services lines with explicit catalogue units; unknown units and duplicate line ids fail', () => {
  assert.ok(m.RfqPayloadWithKnownUnitsSchema.safeParse(payload()).success, 'mixed lines with units ft2, ls and h');
  assert.equal(m.RfqPayloadWithKnownUnitsSchema.safeParse(payload([line('l1', 'goods', '3', 'bushel')])).success, false, 'bushel is not in the unit catalogue');
  assert.equal(m.RfqPayloadWithKnownUnitsSchema.safeParse(payload([line('l1', 'goods', '3', 'm2'), line('l1', 'works', '1', 'ls')])).success, false);
  assert.equal(m.RfqPayloadWithKnownUnitsSchema.safeParse(payload([line('l1', 'goods', '3.0000001', 'm2')])).success, false, 'quantities are exact decimals with at most six digits');
  assert.ok(m.CreateRfqCommandSchema.safeParse({ owner: { kind: 'person', id: 'p1' }, projectId: null, payload: payload(), category: null, publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: { via: 'person' } }).success);
  assert.equal(c.computeRfqVersionDigest(payload()).value, c.computeRfqVersionDigest(structuredClone(payload())).value, 'digests are canonical');
  assert.notEqual(c.computeRfqVersionDigest(payload()).value, c.computeRfqVersionDigest(payload([line('l1', 'goods', '120.0', 'ft2'), line('l2', 'works', '1', 'ls'), line('l3', 'services', '16', 'h')])).value, '120 and 120.0 are distinct digest inputs');
});

test('a quote line snapshot copies the catalogue version; later catalogue edits never rewrite it', () => {
  const v1: m.OwnerOfferingVersion = {
    id: 'ov-1', offeringId: 'off-1', version: 1, status: 'published', digest: null, publishedAt: '2026-10-31T10:00:00.000Z', publicFields: ['title'],
    privateKnowledge: { costBasis: { minorUnits: '900', currency: 'USD' }, marginTarget: '0.25', notes: 'PRIVATE' },
    payload: { title: 'Cedar decking', description: null, specification: { species: 'western red cedar', thickness: '5/4 in' }, unit: 'lm', listPrice: { minorUnits: '1500', currency: 'USD' }, options: [], availability: { state: 'available', capacity: null, observedAt: '2026-10-31T10:00:00.000Z' }, components: [] },
  };
  const snapshot = m.offeringQuoteSnapshot({ kind: 'goods' }, v1, 'goods');
  assert.deepEqual(snapshot, { kind: 'goods', specSnapshot: { species: 'western red cedar', thickness: '5/4 in' }, unit: 'lm', offeringVersionRef: { offeringId: 'off-1', version: 1 } });
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE') && !JSON.stringify(snapshot).includes('costBasis'), 'no private knowledge in a snapshot');
  v1.payload.specification.species = 'pressure-treated pine';
  assert.equal(snapshot.specSnapshot.species, 'western red cedar', 'the snapshot is a copy, not a reference');
  assert.throws(() => m.offeringQuoteSnapshot({ kind: 'goods' }, { ...v1, status: 'draft' }, 'goods'), /only published/);
  assert.throws(() => m.offeringQuoteSnapshot({ kind: 'services' }, v1, 'goods'), /line kind/);
  assert.deepEqual(m.offeringDraftViolations('bundle', { payload: v1.payload }), ['a bundle lists at least one component']);
  assert.deepEqual(m.offeringDraftViolations('goods', { payload: { ...v1.payload, components: [{ offeringId: 'x', version: 1, quantity: { value: '1', unit: 'pc' } }] } }), ['only a bundle lists components']);
});

test('payment never reorders: catalogue and invitation order ignore entitlements, plans and sponsorship', () => {
  const offerings = [
    { offeringId: 'b', publishedAt: '2026-10-30T10:00:00.000Z' },
    { offeringId: 'a', publishedAt: '2026-10-30T10:00:00.000Z' },
    { offeringId: 'c', publishedAt: '2026-10-31T10:00:00.000Z' },
  ];
  const base = m.orderPublicOfferings(offerings).map((o) => o.offeringId);
  assert.deepEqual(base, ['c', 'a', 'b']);
  // The same items carrying payment facts (as a careless caller might attach them) come back in the same order.
  const paid = offerings.map((o, i) => ({ ...o, sponsored: i === 2 ? false : true, subscriptionTier: i === 1 ? 'pro' : 'free', entitlementCount: 10 - i }));
  assert.deepEqual(m.orderPublicOfferings(paid).map((o) => o.offeringId), base);
  const invitations = [{ id: 'i1', sentAt: '2026-10-31T09:00:00.000Z' }, { id: 'i2', sentAt: '2026-10-31T11:00:00.000Z' }, { id: 'i0', sentAt: '2026-10-31T09:00:00.000Z' }];
  const order = m.orderInvitations(invitations).map((i) => i.id);
  assert.deepEqual(order, ['i2', 'i0', 'i1']);
  assert.deepEqual(m.orderInvitations(invitations.map((i) => ({ ...i, buyerPaysPlatform: i.id === 'i1', priority: i.id === 'i1' ? 1 : 0 }))).map((i) => i.id), order);
});

test('the supplier view and event payloads have no place for buyer-private or seller-private fields', () => {
  const shape = (schema: { shape: Record<string, unknown> }): string[] => Object.keys(schema.shape);
  const supplierKeys = [...shape(m.SupplierRfqViewSchema), ...shape(m.SupplierRfqViewSchema.shape.rfq), ...shape(c.SharedRfqVersionSchema), ...shape(m.SupplierInvitationSchema)];
  for (const key of m.SUPPLIER_FORBIDDEN_KEYS) assert.ok(!supplierKeys.includes(key), `${key} has no place in the supplier view`);
  for (const key of ['budgetCeiling', 'evaluationWeights', 'internalNotes', 'shortlist', 'privateConstraint', 'privateKnowledge', 'costBasis', 'marginTarget', 'payload', 'title']) {
    assert.ok(!(m.COMMERCE_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key), `${key} never enters an outbox payload (identifiers only)`);
  }
  assert.ok(!shape(m.PublicOfferingSchema).includes('privateKnowledge'));
  assert.equal(m.SupplierRfqViewSchema.safeParse({ projection: 'shared_party', rfq: { id: 'r', buyer: { kind: 'person', id: 'p' }, status: 'published', category: null, budgetCeiling: null }, versions: [], invitations: [] }).success, false, 'strict: an extra key is refused');
  assert.equal(m.COMMERCE_EGRESS.notificationPayload, 'identifiers_only');
});
