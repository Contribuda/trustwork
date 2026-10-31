import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../packages/contracts/src/index.js';
import * as t from '../../packages/contracts/src/tasks.js';
import type { PlanItem, ProjectLocation } from '../../packages/contracts/src/plans.js';

/* Synthetic US demo data (San Diego County homeowner); no real people, companies or prices. */
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const attachment = { evidenceArtifactId: 'artifact-demo-roof-plan', hash: 'a'.repeat(64), audience: 'shared' as const };
const item = (over: Partial<PlanItem> & Pick<PlanItem, 'key' | 'kind'>): PlanItem => ({
  parentKey: null, title: `Step ${over.key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null,
  decisionQuestion: null, sources: [], attachments: [], privateNotes: null, ...over,
});
const roofing = item({
  key: 'roofing', kind: 'task', title: 'Re-roof the house', description: 'Tear off and replace asphalt shingles', stepTerms: ['work.envelope.roofing'], requiredSkills: ['trade.roofer'],
  quantity: { value: '2200', unit: 'ft2' }, estimate: { kind: 'estimate_range', low: usd('1800000'), high: usd('2600000'), basis: 'licensed_source', basisRef: 'dataset-demo-costs', asOf: '2026-10-31' },
  duration: { lowDays: 3, highDays: 6 }, window: { earliestStart: '2027-03-01', latestFinish: '2027-04-15' }, sources: [{ kind: 'own_quote', ref: 'quote-demo-own-1' }], attachments: [attachment],
  privateNotes: 'PRIVATE-ceiling-21000',
});
const tearOff = item({ key: 'tear-off', kind: 'milestone', parentKey: 'roofing', title: 'Old roof removed' });
const permit = item({ key: 'permit', kind: 'permit', title: 'Building permit', stepTerms: ['permit.building'] });
const gutters = item({ key: 'gutters', kind: 'task', title: 'New gutters', stepTerms: ['work.envelope.roofing'] });
const BASELINE = [roofing, tearOff, permit, gutters];
const LOCATION: ProjectLocation = {
  projectId: 'project-demo-1', address: { lines: ['100 Demo Street'], locality: 'Escondido', region: 'CA', postalCode: '92025', countryCode: 'US' }, regionCode: 'US-CA:san-diego-county',
  cadastralRef: 'APN-DEMO-1', siteContact: { name: 'Demo Owner', phone: '+1 555 0100', email: null }, siteAccessNotes: 'Gate code 1234', revision: 1, updatedAt: '2026-10-31T00:00:00.000Z',
};
const TERMS: t.TaskRequestTerms = {
  title: 'Re-roof a single-storey house', fields: ['scope', 'trade', 'locality', 'drawings', 'quantities', 'schedule'], scopeNote: 'Two layers to remove', milestoneItemKeys: ['roofing', 'tear-off'],
  acceptanceCriteria: ['Final inspection passed'], responseDeadline: '2027-02-15T17:00:00.000Z', currency: 'USD',
};
const PRIVATE_STRINGS = ['PRIVATE-', 'quote-demo-own-1', '1800000', '2600000', '100 Demo Street', 'Gate code', 'APN-DEMO', '555 0100'];
const offerPayload = (over: Partial<t.TaskOfferPayload> = {}): t.TaskOfferPayload => ({
  price: usd('2000000'), start: '2027-03-01', durationDays: 5, exclusions: ['Permit fees'], validUntil: '2027-06-01T00:00:00.000Z', note: null,
  milestones: [
    { key: 'tear-off', title: 'Tear-off done', planItemKey: 'tear-off', amount: usd('800000'), due: '2027-03-02' },
    { key: 'final', title: 'Roof complete', planItemKey: 'roofing', amount: usd('1200000'), due: '2027-03-06' },
  ],
  ...over,
});
const issues = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : (r.error?.issues ?? []).map((i) => i.message));
const ref = (id: string, version: number, value: string) => ({ id, version, digest: { algorithm: 'trustwork-digest-1' as const, value } });

/* ---------- The brief ---------- */

test('the brief carries exactly the listed fields of the plan item; private notes, sources, single estimates and the site never', () => {
  const brief = t.buildTaskRequestPayload({ item: roofing, baseline: BASELINE, location: LOCATION, terms: TERMS, timeZone: 'America/Los_Angeles' });
  assert.equal(brief.itemKey, 'roofing');
  assert.equal(brief.description, 'Tear off and replace asphalt shingles');
  assert.equal(brief.regionCode, 'US-CA:san-diego-county', 'locality is the region code only');
  assert.deepEqual(brief.attachments, [attachment]);
  assert.deepEqual(brief.milestoneItems.map((m) => m.key), ['roofing', 'tear-off']);
  assert.equal(brief.budgetRange, undefined, 'the budget range is shared only when chosen');
  const json = JSON.stringify(brief);
  for (const key of t.TASK_BRIEF_FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} reached the brief`);
  for (const secret of PRIVATE_STRINGS) assert.ok(!json.includes(secret), `${secret} leaked`);

  const minimal = t.buildTaskRequestPayload({ item: roofing, baseline: BASELINE, location: LOCATION, terms: { ...TERMS, fields: ['trade'] }, timeZone: 'America/Los_Angeles' });
  assert.deepEqual(Object.keys(minimal).sort(), ['acceptanceCriteria', 'currency', 'fields', 'itemKey', 'kind', 'milestoneItems', 'requiredSkills', 'responseDeadline', 'stepTerms', 'timeZone', 'title']);
  const withRange = t.buildTaskRequestPayload({ item: roofing, baseline: BASELINE, location: null, terms: { ...TERMS, fields: ['budget_range'] }, timeZone: 'UTC' });
  assert.equal(withRange.budgetRange?.kind, 'estimate_range', 'a chosen budget range is the range with its basis, never a single figure');
  assert.equal(t.TaskShareFieldSchema.safeParse('address').success, false, 'the address is never a brief field');
  assert.equal(t.TaskShareFieldSchema.safeParse('contact').success, false, 'the contact is never a brief field');
});

test('milestone anchors are the item or steps below it; permits, decisions and siblings are refused; goods never become tasks', () => {
  const build = (over: Partial<t.TaskRequestTerms>, it: PlanItem = roofing) => () => t.buildTaskRequestPayload({ item: it, baseline: BASELINE, location: null, terms: { ...TERMS, ...over }, timeZone: 'UTC' });
  assert.throws(build({ milestoneItemKeys: ['gutters'] }), (e: unknown) => e instanceof t.TaskBriefError && e.reason === 'milestone_item_unknown', 'a sibling is not below the item');
  assert.throws(build({ milestoneItemKeys: ['nope'] }), (e: unknown) => e instanceof t.TaskBriefError && e.reason === 'milestone_item_unknown');
  assert.throws(build({}, item({ key: 'tiles', kind: 'purchase', stepTerms: ['material.roofing.asphalt_shingles'] })), (e: unknown) => e instanceof t.TaskBriefError && e.reason === 'item_kind');
  const withPermit = [...BASELINE, item({ key: 'sub-permit', kind: 'permit', parentKey: 'roofing', stepTerms: ['permit.building'] })];
  assert.throws(() => t.buildTaskRequestPayload({ item: roofing, baseline: withPermit, location: null, terms: { ...TERMS, milestoneItemKeys: ['sub-permit'] }, timeZone: 'UTC' }), (e: unknown) => e instanceof t.TaskBriefError && e.reason === 'milestone_item_kind');
  assert.match(issues(t.TaskRequestTermsSchema.safeParse({ ...TERMS, fields: ['scope', 'scope'] })).join(), /distinct/);
});

/* ---------- Offers ---------- */

test('an offer: milestones add up to the price in one currency, fall due after the start and are anchored to listed plan items', () => {
  assert.ok(t.TaskOfferPayloadSchema.safeParse(offerPayload()).success);
  assert.match(issues(t.TaskOfferPayloadSchema.safeParse(offerPayload({ price: usd('1999999') }))).join(), /add up/);
  assert.match(issues(t.TaskOfferPayloadSchema.safeParse(offerPayload({ milestones: [{ key: 'a', title: 'A', planItemKey: 'roofing', amount: { minorUnits: '2000000', currency: 'EUR' }, due: '2027-03-03' }] }))).join(), /one currency/);
  assert.match(issues(t.TaskOfferPayloadSchema.safeParse(offerPayload({ start: '2027-03-05' }))).join(), /after the start/);
  const brief = t.buildTaskRequestPayload({ item: roofing, baseline: BASELINE, location: null, terms: TERMS, timeZone: 'UTC' });
  assert.deepEqual(t.offerMisfits(offerPayload(), brief), []);
  const stray = offerPayload({ milestones: [{ key: 'x', title: 'X', planItemKey: 'gutters', amount: usd('2000000'), due: '2027-03-03' }] });
  assert.deepEqual(t.offerMisfits(stray, brief), ['milestone_item_unknown']);
  assert.deepEqual(t.offerMisfits(offerPayload({ price: { minorUnits: '2000000', currency: 'EUR' }, milestones: [{ key: 'a', title: 'A', planItemKey: 'roofing', amount: { minorUnits: '2000000', currency: 'EUR' }, due: '2027-03-03' }] }), brief), ['currency_mismatch']);
});

test('sent offers are digest-bound: the digest covers the pinned request version, the offeror, the version number and the payload', () => {
  const requestVersion = ref('version-demo-1', 1, 'b'.repeat(64));
  const base = { taskRequestId: 'request-demo-1', requestVersion, offeror: { kind: 'person' as const, id: 'person-demo-carl' }, version: 1, payload: offerPayload() };
  const d = c.computeDigest(t.taskOfferDigestInput(base));
  assert.deepEqual(c.computeDigest(t.taskOfferDigestInput(structuredClone(base))), d, 'deterministic');
  const changed = [
    { ...base, payload: offerPayload({ price: usd('2100000'), milestones: [{ key: 'final', title: 'All', planItemKey: 'roofing', amount: usd('2100000'), due: '2027-03-06' }] }) },
    { ...base, requestVersion: ref('version-demo-2', 2, 'c'.repeat(64)) },
    { ...base, offeror: { kind: 'company' as const, id: 'company-demo-1' } },
    { ...base, version: 2 },
  ];
  for (const variant of changed) assert.notEqual(c.computeDigest(t.taskOfferDigestInput(variant)).value, d.value);
  assert.ok(c.verifyDigest(t.taskOfferDigestInput(base), d));
  const tampered = { ...base, payload: { ...base.payload, exclusions: [] } };
  assert.equal(c.verifyDigest(t.taskOfferDigestInput(tampered), d), false, 'a stored payload that changed no longer reproduces its digest');
  const brief = t.buildTaskRequestPayload({ item: roofing, baseline: BASELINE, location: null, terms: TERMS, timeZone: 'UTC' });
  const rd = c.computeDigest(t.taskRequestVersionDigestInput({ taskRequestId: 'request-demo-1', version: 1, payload: brief }));
  assert.notEqual(c.computeDigest(t.taskRequestVersionDigestInput({ taskRequestId: 'request-demo-1', version: 2, payload: brief })).value, rd.value);
  // The agreement digest of kind task differs from the same refs as an RFQ quote (ADR 012 decision 19).
  assert.notEqual(c.computeAgreementDigest(ref('o', 1, d.value), requestVersion, 'task').value, c.computeAgreementDigest(ref('o', 1, d.value), requestVersion, 'rfq_quote').value);
});

test('acceptance: the offer must be sent, valid, unflagged and pinned to the current request version by id and digest', () => {
  const now = new Date('2027-02-01T00:00:00.000Z');
  const current = { id: 'v2', version: 2, digest: 'c'.repeat(64) };
  const offer = { id: 'o1', version: 1, status: 'sent' as const, digest: 'd'.repeat(64), staleReason: null, requestVersionId: 'v2', requestVersionDigest: 'c'.repeat(64), payload: offerPayload() };
  const input = { offer, offerRef: ref('o1', 1, 'd'.repeat(64)), requestRef: ref('v2', 2, 'c'.repeat(64)), current, now };
  assert.equal(t.checkTaskAcceptance(input), 'ok');
  assert.equal(t.checkTaskAcceptance({ ...input, requestRef: ref('v1', 1, 'b'.repeat(64)) }), 'commercial.rfq_version_mismatch');
  assert.equal(t.checkTaskAcceptance({ ...input, offer: { ...offer, requestVersionId: 'v1' } }), 'commercial.stale_version', 'an offer for v1 is never accepted as v2');
  assert.equal(t.checkTaskAcceptance({ ...input, offer: { ...offer, staleReason: 'request_amended' } }), 'commercial.stale_version');
  assert.equal(t.checkTaskAcceptance({ ...input, offer: { ...offer, status: 'withdrawn' } }), 'commercial.quote_not_acceptable');
  assert.equal(t.checkTaskAcceptance({ ...input, now: new Date('2027-07-01T00:00:00.000Z') }), 'commercial.quote_expired');
  assert.equal(t.checkTaskAcceptance({ ...input, offerRef: ref('o1', 1, 'e'.repeat(64)) }), 'commercial.digest_mismatch');
  assert.equal(t.checkTaskAcceptance({ ...input, current: null }), 'commercial.rfq_version_mismatch');
});

/* ---------- Execution, completion and reviews ---------- */

test('milestones: a claim is asserted until the owner decides; the task completes only when every milestone is accepted; reviews only then', () => {
  const ms = offerPayload().milestones;
  const at = (n: number) => `2027-03-0${n}T00:00:00.000Z`;
  assert.equal(t.assignmentStatusFor(t.milestoneStates(ms, []), false), 'assigned');
  const claim = { id: 'r1', milestoneKey: 'tear-off', kind: 'delivery_claim' as const, claimId: null, createdAt: at(1) };
  let states = t.milestoneStates(ms, [claim]);
  assert.deepEqual(states.map((s) => s.state), ['asserted', 'open']);
  assert.equal(t.assignmentStatusFor(states, true), 'in_progress');
  const rejection = { id: 'r2', milestoneKey: 'tear-off', kind: 'rejection' as const, claimId: 'r1', createdAt: at(2) };
  assert.deepEqual(t.milestoneStates(ms, [claim, rejection]).map((s) => s.state), ['open', 'open'], 'a rejected claim reopens the milestone');
  const reclaim = { id: 'r3', milestoneKey: 'tear-off', kind: 'delivery_claim' as const, claimId: null, createdAt: at(3) };
  const final = { id: 'r4', milestoneKey: 'final', kind: 'delivery_claim' as const, claimId: null, createdAt: at(4) };
  states = t.milestoneStates(ms, [claim, rejection, reclaim, final]);
  assert.equal(t.assignmentStatusFor(states, true), 'delivered');
  const accepts = [{ id: 'r5', milestoneKey: 'tear-off', kind: 'acceptance' as const, claimId: 'r3', createdAt: at(5) }, { id: 'r6', milestoneKey: 'final', kind: 'acceptance' as const, claimId: 'r4', createdAt: at(6) }];
  const stale = { id: 'r7', milestoneKey: 'final', kind: 'acceptance' as const, claimId: 'r1', createdAt: at(7) };
  assert.equal(t.assignmentStatusFor(t.milestoneStates(ms, [claim, rejection, reclaim, final, accepts[0]!, stale]), true), 'delivered', 'an acceptance of another claim confirms nothing');
  assert.equal(t.assignmentStatusFor(t.milestoneStates(ms, [claim, rejection, reclaim, final, ...accepts]), true), 'accepted');
  for (const status of t.TaskAssignmentStatusSchema.options) assert.equal(t.reviewAllowed(status), status === 'accepted', status);
  assert.equal(t.SubmitTaskReviewCommandSchema.safeParse({ rating: 6, text: null }).success, false);
  assert.equal(t.RecordTaskExecutionCommandSchema.safeParse({ kind: 'acceptance', expectedRevision: 1, milestoneKey: 'final', claimId: 'r4', note: null, actor: { via: 'agent', mandateId: 'm1' } }).success, false, 'accepting work names no agent');
  assert.equal(t.RecordTaskExecutionCommandSchema.safeParse({ kind: 'delivery_claim', expectedRevision: 1, milestoneKey: 'final', evidence: [], note: null, actor: { via: 'person' } }).success, false, 'a claim carries evidence');
});

test('obligations per milestone: the assignee performs, the owner pays the milestone amount and accepts by the last one', () => {
  const owner = { kind: 'person' as const, id: 'petr' };
  const assignee = { kind: 'company' as const, id: 'roofers' };
  const obligations = t.deriveTaskObligations({ owner, assignee }, offerPayload(), 'America/Los_Angeles');
  assert.deepEqual(obligations.map((o) => [o.party.id, o.kind, o.amount?.minorUnits ?? null]), [['roofers', 'perform', null], ['petr', 'pay', '800000'], ['roofers', 'perform', null], ['petr', 'pay', '1200000'], ['petr', 'accept', null]]);
  assert.equal(obligations[0]?.due, '2027-03-02T08:00:00.000Z', 'start of the local business day');
  assert.equal(obligations.at(-1)?.due, '2027-03-06T08:00:00.000Z');
});

/* ---------- Payment neutrality, egress and the registry ---------- */

test('payment never buys order: the board, invitations and offers are ordered by time and id only', () => {
  const plain = [{ id: 'b', at: '2027-01-02T00:00:00.000Z' }, { id: 'a', at: '2027-01-02T00:00:00.000Z' }, { id: 'c', at: '2027-01-03T00:00:00.000Z' }];
  const paid = plain.map((x, i) => ({ ...x, sponsored: i === 0, entitlement: { boost: 10 * i }, subscription: 'premium', reputation: 5 - i }));
  assert.deepEqual(t.paymentBlindOrder(plain).map((x) => x.id), ['c', 'a', 'b']);
  assert.deepEqual(t.paymentBlindOrder(paid).map((x) => x.id), t.paymentBlindOrder(plain).map((x) => x.id), 'identical order with and without payment attributes');
  assert.equal(t.paymentBlindOrder.length, 1, 'the only input is the list');
});

test('what each side must never receive; events carry identifiers only; nothing reaches search or a public projection', () => {
  for (const key of t.TASK_OWNER_FORBIDDEN_KEYS) assert.ok(!(t.TASK_OFFEROR_FORBIDDEN_KEYS as readonly string[]).includes(key), key);
  for (const key of t.TASK_EVENT_PAYLOAD_KEYS) assert.ok(!/budget|note|address|title|price|floor|ceiling|contact|reason|text|rating/i.test(key), key);
  assert.equal(t.TASK_EGRESS.taskOfferPrivate.sharedProjection, false);
  assert.equal(t.TASK_EGRESS.taskRequestPrivate.search, false);
  assert.equal(t.TASK_EGRESS.notificationPayload, 'identifiers_only');
  for (const kind of ['task_request', 'task_offer', 'task_assignment']) assert.equal((c.SourceKindSchema.options as readonly string[]).includes(kind), false, `${kind} is not a retrieval source`);
  const offer = t.TaskOfferSchema.shape;
  assert.equal('sentBy' in offer || 'floorPrice' in offer || 'mandateId' in offer, false, 'the offer the owner sees names no sender, floor or mandate');
});

test('the task marketplace registers every task operation once in the AGT-002 shape: parity, mandate kinds, human-only decisions', async () => {
  const manifest = t.TASK_MARKETPLACE_MANIFEST;
  assert.ok(c.AgentModuleManifestSchema.safeParse(manifest).success);
  const registry = c.buildCapabilityRegistry({ registryVersion: 1, hubId: null, manifests: [manifest], extensionCapabilities: [] });
  assert.deepEqual(c.parityGaps(registry.capabilities), [], 'every capability is in the interface and the agent');
  for (const cap of registry.capabilities) {
    assert.deepEqual(c.capabilityViolations(cap), [], cap.id);
    for (const r of [cap.input, cap.output]) {
      const mod = (await import(`../../packages/contracts/src/${r.contract}.js`)) as Record<string, unknown>;
      assert.ok(mod[r.schema] && typeof (mod[r.schema] as { safeParse?: unknown }).safeParse === 'function', `${cap.id}: ${r.contract}.${r.schema}`);
    }
    if (cap.kind === 'commit') assert.ok(cap.mandateAction !== null && !cap.acceptsUntrustedText, `${cap.id} needs a mandate and structured input`);
    assert.notEqual(cap.budgetKind, 'platform', `${cap.id} charges no platform budget`);
  }
  const byId = new Map(registry.capabilities.map((x) => [x.id, x]));
  assert.equal(byId.get('task_marketplace.accept_offer')?.confirmation, 'person_each', 'a consumer accepts in person');
  assert.equal(byId.get('task_marketplace.accept_offer')?.budgetKind, 'transaction');
  assert.equal(byId.get('task_marketplace.decide_delivery')?.mandateAction, 'confirm_execution');
  assert.ok(byId.get('task_marketplace.review')?.sideEffects.includes('reputation_signal'));
  assert.equal(byId.get('task_marketplace.review')?.confirmation, 'person_each');
  assert.equal(byId.get('task_marketplace.draft_offer')?.mandateAction, 'prepare');
  assert.equal(byId.get('task_marketplace.send_offer')?.mandateAction, 'send_quote');
  assert.equal(byId.get('task_marketplace.get_brief')?.reads.join(), 'shared_party', 'offerors read the brief as a shared projection');
  const ids = registry.capabilities.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});
