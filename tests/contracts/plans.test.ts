import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../packages/contracts/src/index.js';
import * as p from '../../packages/contracts/src/plans.js';

/* Synthetic US demo data (San Diego County homeowner); no real people, companies or prices. */
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const range = (low: string, high: string, basis: p.BudgetRange['basis'] = 'owner_estimate', basisRef: string | null = null): p.BudgetRange => ({ kind: 'estimate_range', low: usd(low), high: usd(high), basis, basisRef, asOf: '2026-10-31' });
const attachment = { evidenceArtifactId: 'artifact-demo-roof-plan', hash: 'a'.repeat(64), audience: 'shared' as const };
const item = (over: Partial<p.PlanItem> & Pick<p.PlanItem, 'key' | 'kind'>): p.PlanItem => ({
  parentKey: null, title: `Step ${over.key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null,
  decisionQuestion: null, sources: [], attachments: [], privateNotes: null, ...over,
});
const roofing = item({
  key: 'roofing', kind: 'task', title: 'Re-roof the house', description: 'Tear off and replace asphalt shingles', stepTerms: ['work.envelope.roofing', 'material.roofing.asphalt_shingles'],
  requiredSkills: ['trade.roofer'], quantity: { value: '2200', unit: 'ft2' }, estimate: range('1800000', '2600000', 'licensed_source', 'dataset-demo-costs-2026'),
  duration: { lowDays: 3, highDays: 6 }, window: { earliestStart: '2027-03-01', latestFinish: '2027-04-15' }, riskLevel: null, sources: [{ kind: 'own_quote', ref: 'quote-demo-owner-1' }],
  attachments: [attachment], privateNotes: 'Owner budget ceiling is 21000 USD; do not reveal',
});
const content = (items: p.PlanItem[], dependencies: p.PlanDependency[] = []): p.PlanContent => ({ summary: 'Replace the roof', assumptions: ['Single storey'], budget: null, timeline: null, items, dependencies });
const issues = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : (r.error?.issues ?? []).map((i) => i.message));

test('budget ranges are ranges with a basis, never a single figure or a quote', () => {
  assert.ok(p.BudgetRangeSchema.safeParse(range('100', '200')).success);
  assert.ok(p.BudgetRangeSchema.safeParse(range('100', '200', 'licensed_source', 'dataset-1')).success);
  assert.match(issues(p.BudgetRangeSchema.safeParse(range('200', '200'))).join(), /single figure/);
  assert.equal(p.BudgetRangeSchema.safeParse(range('300', '200')).success, false);
  assert.equal(p.BudgetRangeSchema.safeParse({ ...range('100', '200'), high: { minorUnits: '200', currency: 'EUR' } }).success, false, 'one currency');
  assert.match(issues(p.BudgetRangeSchema.safeParse(range('100', '200', 'licensed_source', null))).join(), /names its source/);
  assert.equal(p.BudgetRangeSchema.safeParse({ ...range('100', '200'), kind: 'quote' }).success, false);
  assert.equal(p.BudgetRangeSchema.safeParse({ price: usd('100'), validUntil: '2027-01-01T00:00:00Z' }).success, false, 'a quote shape is not a range');
  assert.equal(p.BudgetRangeSchema.safeParse({ ...range('100', '200'), basis: 'competitor_quote' }).success, false, 'other participants quotes are no basis');
  assert.equal(p.BudgetRangeSchema.safeParse({ ...range('100', '200'), low: usd('-1') }).success, false);
});

test('plan items are keyed by the plan-step taxonomy: each kind carries a term of its scheme', () => {
  assert.ok(p.PlanItemSchema.safeParse(roofing).success, issues(p.PlanItemSchema.safeParse(roofing)).join());
  const bad: [Partial<p.PlanItem> & Pick<p.PlanItem, 'key' | 'kind'>, RegExp][] = [
    [{ key: 'permit', kind: 'permit', stepTerms: ['work.envelope.roofing'] }, /term of its taxonomy scheme/],
    [{ key: 'task', kind: 'task', stepTerms: [] }, /term of its taxonomy scheme/],
    [{ key: 'phase', kind: 'phase', stepTerms: ['work.envelope.roofing'] }, /term of its taxonomy scheme/],
    [{ key: 'buy', kind: 'purchase', stepTerms: ['work.envelope.roofing'] }, /term of its taxonomy scheme/],
    [{ key: 'risk', kind: 'risk' }, /names its level/],
    [{ key: 'own', kind: 'milestone', parentKey: 'own' }, /own parent/],
  ];
  for (const [over, message] of bad) assert.match(issues(p.PlanItemSchema.safeParse(item(over))).join(), message, over.key);
  assert.equal(p.PlanItemSchema.safeParse(item({ key: 'x', kind: 'task', stepTerms: ['work.envelope.roofing'], requiredSkills: ['work.envelope.roofing'] })).success, false, 'skills are trades');
  assert.equal(p.PlanItemSchema.safeParse(item({ key: 'x', kind: 'milestone', stepTerms: ['masterformat.07'] })).success, false, 'proprietary schemes are not plan-step terms');
  assert.equal(p.PlanItemSchema.safeParse(item({ key: 'Bad Key', kind: 'milestone' })).success, false);
  for (const [kind, term] of [['permit', 'permit.building'], ['inspection', 'inspection.framing'], ['decision', 'decision.go_ahead'], ['phase', 'stage.foundation'], ['material', 'material.roofing'], ['self', 'work.planning.brief']] as const) {
    assert.ok(p.PlanItemSchema.safeParse(item({ key: 'k', kind, stepTerms: [term] })).success, kind);
  }
  assert.ok(p.PlanItemSchema.safeParse(item({ key: 'risk', kind: 'risk', riskLevel: 'high' })).success);
});

test('plan content: unique keys, known parents, acyclic parents and dependencies (with the cycle path), one currency', () => {
  const a = item({ key: 'a', kind: 'milestone' });
  const b = item({ key: 'b', kind: 'milestone' });
  const d = item({ key: 'd', kind: 'milestone' });
  const dep = (x: string, y: string): p.PlanDependency => ({ predecessorKey: x, successorKey: y, type: 'fs', lagDays: 0 });
  assert.ok(p.PlanContentSchema.safeParse(content([a, b, d], [dep('a', 'b'), dep('b', 'd'), dep('a', 'd')])).success);
  assert.match(issues(p.PlanContentSchema.safeParse(content([a, a]))).join(), /duplicate item key a/);
  assert.match(issues(p.PlanContentSchema.safeParse(content([{ ...a, parentKey: 'zz' }]))).join(), /unknown parent zz/);
  assert.match(issues(p.PlanContentSchema.safeParse(content([{ ...a, parentKey: 'b' }, { ...b, parentKey: 'a' }]))).join(), /parent cycle/);
  assert.match(issues(p.PlanContentSchema.safeParse(content([a], [dep('a', 'q')]))).join(), /unknown item q/);
  assert.match(issues(p.PlanContentSchema.safeParse(content([a, b], [dep('a', 'b'), dep('a', 'b')]))).join(), /duplicate dependency/);
  const cyclic = p.PlanContentSchema.safeParse(content([a, b, d], [dep('a', 'b'), dep('b', 'd'), dep('d', 'a')]));
  assert.match(issues(cyclic).join(), /dependency cycle a -> b -> d -> a/);
  assert.equal(p.PlanDependencySchema.safeParse(dep('a', 'a')).success, false);
  assert.equal(p.PlanDependencySchema.safeParse({ ...dep('a', 'b'), lagDays: 400 }).success, false);
  const eur = { ...roofing, key: 'eur', estimate: { ...range('1', '2'), low: { minorUnits: '1', currency: 'EUR' }, high: { minorUnits: '2', currency: 'EUR' } } };
  assert.match(issues(p.PlanContentSchema.safeParse(content([roofing, eur]))).join(), /one currency/);
  assert.deepEqual(p.findCycle([{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }]), ['x', 'y', 'x']);
  assert.equal(p.findCycle([{ from: 'x', to: 'y' }, { from: 'y', to: 'z' }]), null);
});

test('version digests are order-independent and bind plan, number and content', () => {
  const x = item({ key: 'x', kind: 'milestone' });
  const y = item({ key: 'y', kind: 'milestone' });
  const one = c.computeDigest(p.planVersionDigestInput({ planId: 'plan-1', version: 2, content: content([x, y], [{ predecessorKey: 'x', successorKey: 'y', type: 'fs', lagDays: 0 }]) }));
  const two = c.computeDigest(p.planVersionDigestInput({ planId: 'plan-1', version: 2, content: content([y, x], [{ predecessorKey: 'x', successorKey: 'y', type: 'fs', lagDays: 0 }]) }));
  assert.deepEqual(one, two);
  assert.notDeepEqual(one, c.computeDigest(p.planVersionDigestInput({ planId: 'plan-1', version: 3, content: content([x, y]) })));
  assert.notDeepEqual(one, c.computeDigest(p.planVersionDigestInput({ planId: 'plan-1', version: 2, content: content([x, { ...y, title: 'Changed' }], [{ predecessorKey: 'x', successorKey: 'y', type: 'fs', lagDays: 0 }]) })));
});

test('version lifecycle: draft -> proposed -> approved -> superseded; frozen once proposed; agents need a mandate', () => {
  const allowed = [['draft', 'proposed'], ['proposed', 'approved'], ['proposed', 'superseded'], ['approved', 'superseded']];
  for (const from of p.PLAN_VERSION_STATUSES) for (const to of p.PLAN_VERSION_STATUSES) {
    assert.equal(p.planVersionTransitionAllowed(from, to), allowed.some(([f, t]) => f === from && t === to), `${from} -> ${to}`);
  }
  const digest = { algorithm: 'trustwork-digest-1' as const, value: 'b'.repeat(64) };
  const base: p.PlanVersion = {
    id: 'v1', planId: 'plan-1', projectId: 'project-1', version: 1, status: 'draft', content: content([roofing]), digest: null, basedOnVersionId: null,
    drafted: { via: 'person', personId: 'person-ana', mandateId: null }, proposed: null, approved: null, superseded: null, changeId: null, revision: 1, createdAt: '2026-10-31T10:00:00Z',
  };
  assert.ok(p.PlanVersionSchema.safeParse(base).success);
  assert.equal(p.PlanVersionSchema.safeParse({ ...base, digest }).success, false, 'a draft has no digest');
  const proposed = { ...base, status: 'proposed' as const, digest, proposed: { actor: { via: 'agent' as const, personId: 'person-ana', mandateId: 'mandate-demo-plan' }, at: '2026-10-31T11:00:00Z' } };
  assert.ok(p.PlanVersionSchema.safeParse(proposed).success);
  assert.equal(p.PlanVersionSchema.safeParse({ ...proposed, digest: null }).success, false, 'proposed is digest-bound');
  assert.equal(p.PlanActorSchema.safeParse({ via: 'agent', personId: 'person-ana', mandateId: null }).success, false, 'an agent names its mandate');
  assert.equal(p.PlanVersionSchema.safeParse({ ...proposed, status: 'approved' }).success, false, 'approval recorded');
  assert.ok(p.PlanVersionSchema.safeParse({ ...proposed, status: 'approved', approved: { personId: 'person-ana', at: '2026-10-31T12:00:00Z' } }).success);
  assert.equal(p.PlanVersionSchema.safeParse({ ...proposed, approved: { personId: 'person-ana', at: '2026-10-31T12:00:00Z' } }).success, false, 'a proposal is not approved');
  assert.ok(p.PlanVersionSchema.safeParse({ ...proposed, status: 'superseded', superseded: { at: '2026-11-01T00:00:00Z', byVersionId: 'v2', reason: 'returned' } }).success);
  // Governance commands carry no actor: an agent cannot even express an approval.
  assert.equal(p.ApprovePlanVersionCommandSchema.safeParse({ expectedRevision: 2, digest, actor: { via: 'agent', mandateId: 'm' } }).success, false);
  assert.equal(p.DecidePlanChangeCommandSchema.safeParse({ decision: 'approve', expectedRevision: 1, digest, actor: { via: 'agent', mandateId: 'm' } }).success, false);
  assert.ok(c.CONNECTION_FORBIDDEN_OPERATIONS.includes('approve_plan_version'));
});

test('execution state: transitions, blocked returns where it came from, one path per item, links match the path', () => {
  assert.ok(p.planItemTransitionAllowed('proposed', 'accepted'));
  assert.ok(p.planItemTransitionAllowed('requested', 'blocked'));
  assert.ok(p.planItemTransitionAllowed('blocked', 'requested', 'requested'));
  assert.equal(p.planItemTransitionAllowed('blocked', 'in_progress', 'requested'), false, 'back only to the previous state');
  assert.equal(p.planItemTransitionAllowed('done', 'in_progress'), false);
  assert.equal(p.planItemTransitionAllowed('proposed', 'done'), false);
  assert.ok(p.pathChangeAllowed(null, 'task'));
  assert.ok(p.pathChangeAllowed('rfq', 'rfq'));
  assert.equal(p.pathChangeAllowed('rfq', 'task'), false, 'an item cannot take two paths');
  assert.equal(p.pathChangeAllowed('requisition', null), false);
  const state: p.PlanItemState = { planId: 'plan-1', itemKey: 'roofing', status: 'requested', path: 'task', link: { kind: 'task_request', id: 'task-demo-1' }, blockedFrom: null, actualStart: null, actualEnd: null, updatedBy: 'person-ana', revision: 1, updatedAt: '2026-10-31T10:00:00Z' };
  assert.ok(p.PlanItemStateSchema.safeParse(state).success);
  assert.equal(p.PlanItemStateSchema.safeParse({ ...state, link: { kind: 'rfq', id: 'rfq-1' } }).success, false, 'an RFQ link on a task path');
  assert.equal(p.PlanItemStateSchema.safeParse({ ...state, link: null }).success, false, 'requested needs a link');
  assert.equal(p.PlanItemStateSchema.safeParse({ ...state, path: 'self', link: null }).success, false);
  assert.equal(p.PlanItemStateSchema.safeParse({ ...state, status: 'blocked' }).success, false, 'blocked records its origin');
  assert.deepEqual(Object.keys(p.PATH_LINK_KINDS).sort(), [...p.PLAN_ITEM_PATHS].sort());
});

test('changes: attribution for fair timing; only approved changes become timing facts', () => {
  assert.equal(p.attributeDelay('owner_request'), 'client');
  assert.equal(p.attributeDelay('counterparty'), 'counterparty');
  assert.equal(p.attributeDelay('site_condition'), 'neutral');
  assert.equal(p.attributeDelay('unknown'), 'unattributed');
  const change = (id: string, status: p.PlanChange['status'], cause: p.PlanChangeCause): p.PlanChange => ({
    id, planId: 'plan-1', fromVersionId: 'v1', toVersionId: 'v2', reason: 'Owner added a skylight', cause, requestedBy: { kind: 'person', id: 'person-ana' }, accountable: { kind: 'person', id: 'person-ana' },
    agreementId: 'agreement-demo-roof', scheduleImpactDays: 7, status, createdBy: 'person-ana', decidedBy: status === 'proposed' ? null : 'person-ana', decidedAt: status === 'proposed' ? null : '2026-11-02T10:00:00Z', revision: 1, createdAt: '2026-11-01T10:00:00Z',
  });
  const facts = p.toTimingFacts([change('c1', 'approved', 'owner_request'), change('c2', 'rejected', 'owner_request'), change('c3', 'proposed', 'counterparty'), change('c4', 'approved', 'counterparty')], new Map([['v1', 1], ['v2', 2]]));
  assert.deepEqual(facts.map((f) => [f.changeId, f.fromVersion, f.toVersion, f.attribution, f.excludedFromCounterpartyTiming]), [['c1', 1, 2, 'client', true], ['c4', 1, 2, 'counterparty', false]]);
  assert.equal(p.PlanChangeSchema.safeParse({ ...change('c', 'approved', 'owner_request'), decidedAt: null }).success, false);
});

test('shares: one item, one audience, exactly listed fields; address and contact only after acceptance', () => {
  const share = (over: Partial<p.PlanShare>): unknown => ({
    id: 'share-1', planId: 'plan-1', itemKey: 'roofing', audience: 'invited', invitee: { kind: 'person', id: 'person-roofer' }, fields: ['scope', 'trade'], acceptanceRef: null,
    previewDigest: { algorithm: 'trustwork-digest-1', value: 'c'.repeat(64) }, confirmedBy: 'person-ana', confirmedAt: '2026-10-31T10:00:00Z', validUntil: null, revokedAt: null, revision: 1, ...over,
  });
  assert.ok(p.PlanShareSchema.safeParse(share({})).success);
  assert.ok(p.PlanShareSchema.safeParse(share({ audience: 'public', invitee: null, fields: ['scope', 'trade', 'locality', 'schedule'] })).success);
  const bad: [Partial<p.PlanShare>, string][] = [
    [{ audience: 'public', invitee: null, fields: ['scope', 'address'] }, 'public address'],
    [{ audience: 'public', invitee: null, fields: ['budget_range'] }, 'public budget'],
    [{ audience: 'public' }, 'public names no invitee'],
    [{ invitee: null }, 'invited names one invitee'],
    [{ fields: ['scope', 'address'] }, 'address before acceptance'],
    [{ fields: ['contact'] }, 'contact before acceptance'],
    [{ audience: 'after_acceptance', fields: ['address'] }, 'acceptance reference missing'],
    [{ fields: [] }, 'no fields'],
    [{ fields: ['scope', 'scope'] }, 'duplicate fields'],
    [{ acceptanceRef: { kind: 'task_assignment', id: 'a-1' } }, 'acceptance only for after_acceptance'],
  ];
  for (const [over, label] of bad) assert.equal(p.PlanShareSchema.safeParse(share(over)).success, false, label);
  assert.ok(p.PlanShareSchema.safeParse(share({ audience: 'after_acceptance', fields: ['address', 'contact'], acceptanceRef: { kind: 'consultation_booking', id: 'booking-demo-1' } })).success);
  assert.equal(p.SharePlanItemCommandSchema.safeParse({ itemKey: 'roofing', audience: 'invited', invitee: { kind: 'person', id: 'x' }, fields: ['address'], acceptanceRef: null, validUntil: null, previewDigest: { algorithm: 'trustwork-digest-1', value: 'c'.repeat(64) } }).success, false);
});

/* ---------- The invited serializer ---------- */

const location: p.ProjectLocation = {
  projectId: 'project-1', address: { lines: ['100 Demo Street'], locality: 'Escondido', region: 'CA', postalCode: '92025', countryCode: 'US' }, regionCode: 'US-CA',
  cadastralRef: '123-456-78-00', siteContact: { name: 'Demo Owner', phone: '+1 555 0100', email: null }, siteAccessNotes: 'Gate code 4321', revision: 1, updatedAt: '2026-10-31T10:00:00Z',
};
const permit = item({ key: 'permit', kind: 'permit', title: 'Building permit', stepTerms: ['permit.building'], privateNotes: 'Owner note on the permit', estimate: range('50000', '90000') });
const share = (over: Partial<p.PlanShare>): p.PlanShare => ({
  id: `share-${Math.random().toString(16).slice(2)}`, planId: 'plan-1', itemKey: 'roofing', audience: 'invited', invitee: { kind: 'person', id: 'person-roofer' }, fields: ['scope', 'trade'],
  acceptanceRef: null, previewDigest: { algorithm: 'trustwork-digest-1', value: 'c'.repeat(64) }, confirmedBy: 'person-ana', confirmedAt: '2026-10-31T10:00:00Z', validUntil: null, revokedAt: null, revision: 1, ...over,
});
const view = (shares: p.PlanShare[], viewer = { personId: 'person-roofer', companyId: null as string | null }, now = new Date('2026-11-01T00:00:00Z')) =>
  p.toInvitedPlanView({ projectId: 'project-1', planId: 'plan-1', planVersion: 2, timeZone: 'America/Los_Angeles', items: [roofing, permit], shares, location, viewer, now });
function noForbidden(value: unknown): void {
  const json = JSON.stringify(value);
  for (const key of p.INVITED_FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} must never reach an invitee: ${json.slice(0, 200)}`);
  for (const secret of ['Owner budget ceiling', 'quote-demo-owner-1', 'Owner note on the permit', '123-456-78-00']) assert.ok(!json.includes(secret), `${secret} leaked`);
}

test('invited view: exactly the shared items and fields; never notes, sources, exact budgets, other invitees or the address before acceptance', () => {
  const v = view([share({})]);
  assert.ok(v);
  assert.equal(v.items.length, 1, 'only the shared item');
  const [only] = v.items;
  assert.deepEqual(Object.keys(only ?? {}).sort(), ['audiences', 'description', 'fields', 'itemKey', 'kind', 'requiredSkills', 'sharedBy', 'stepTerms', 'title', 'validUntil']);
  assert.deepEqual(only?.fields, ['scope', 'trade']);
  noForbidden(v);
  const json = JSON.stringify(v);
  for (const absent of ['budgetRange', 'address', 'regionCode', 'attachments', 'quantity', 'siteContact', 'Gate code', '100 Demo Street', '1800000']) assert.ok(!json.includes(absent), `${absent} not shared`);

  const full = view([share({ fields: ['scope', 'trade', 'locality', 'drawings', 'quantities', 'schedule', 'budget_range'] })]);
  const roof = full?.items[0];
  assert.deepEqual(roof?.budgetRange, roofing.estimate, 'the range with its basis, only because the owner shared it');
  assert.equal(roof?.budgetRange?.kind, 'estimate_range');
  assert.equal(roof?.regionCode, 'US-CA');
  assert.equal(roof && 'address' in roof, false, 'locality is the region, never the street');
  noForbidden(full);

  const accepted = view([share({}), share({ audience: 'after_acceptance', fields: ['address', 'contact'], acceptanceRef: { kind: 'task_assignment', id: 'assignment-demo-1' } })]);
  assert.deepEqual(accepted?.items[0]?.address, location.address, 'address after acceptance');
  assert.equal(accepted?.items[0]?.siteAccessNotes, 'Gate code 4321');
  assert.deepEqual(accepted?.items[0]?.audiences, ['invited', 'after_acceptance']);
});

test('invited view: uninvited, revoked, expired, other parties and public shares give nothing', () => {
  assert.equal(view([]), null);
  assert.equal(view([share({ invitee: { kind: 'person', id: 'person-other' } })]), null, 'another invitee');
  assert.equal(view([share({ revokedAt: '2026-10-31T12:00:00Z' })]), null, 'revoked');
  assert.equal(view([share({ validUntil: '2026-10-31T23:00:00Z' })]), null, 'expired');
  assert.equal(view([share({ audience: 'public', invitee: null, fields: ['scope'] })]), null, 'the needs board never widens an invitee view');
  assert.equal(view([share({ planId: 'plan-other' })]), null, 'another plan');
  assert.equal(view([share({ itemKey: 'not-in-baseline' })]), null, 'items outside the baseline');
  const two = view([share({}), share({ invitee: { kind: 'person', id: 'person-other' }, itemKey: 'permit', fields: ['scope', 'budget_range'] })]);
  assert.deepEqual(two?.items.map((i) => i.itemKey), ['roofing'], 'other invitees and their items stay invisible');
  noForbidden(two);
  const company = view([share({ invitee: { kind: 'company', id: 'company-demo-roofing' } })], { personId: 'person-employee', companyId: 'company-demo-roofing' });
  assert.equal(company?.items.length, 1, 'a company invitee is exercised by its authorised member');
  assert.equal(view([share({ invitee: { kind: 'company', id: 'company-demo-roofing' } })], { personId: 'person-employee', companyId: null }), null, 'not without the membership permission');
});

test('share preview: the projection the owner confirms, deterministic in field order', () => {
  const a = p.sharePreview(roofing, 'invited', ['trade', 'scope'], location);
  const b = p.sharePreview(roofing, 'invited', ['scope', 'trade'], location);
  assert.deepEqual(c.computeDigest(a), c.computeDigest(b));
  assert.notDeepEqual(c.computeDigest(a), c.computeDigest(p.sharePreview(roofing, 'invited', ['scope', 'trade', 'budget_range'], location)));
  noForbidden(a);
});

test('licensing notices: from taxonomy facets and pack facts; unknown stays unknown, never a ruling', () => {
  const facets: p.LicensingFacets = {
    pack: 'US', regionCode: 'US-CA',
    trades: { 'trade.roofer': { licensing: 'varies_by_state', verification: 'unverified' }, 'trade.owners_representative': { licensing: 'unknown', verification: 'unverified' } },
    facts: [{ factId: 'contractor-licensing-board', scope: 'US-CA', name: 'California contractor license', authority: 'Contractors State License Board', authorityUrl: 'https://www.cslb.ca.gov/', required: true, verification: 'pending' }],
  };
  const brief = item({ key: 'brief', kind: 'self', stepTerms: ['work.planning.brief'], requiredSkills: ['trade.owners_representative'] });
  const mystery = item({ key: 'mystery', kind: 'task', stepTerms: ['work.envelope.roofing'], requiredSkills: ['trade.not_in_facets'] });
  const none = item({ key: 'none', kind: 'milestone' });
  const notices = p.licensingNotices([roofing, brief, mystery, none], facets);
  assert.deepEqual(notices.map((n) => [n.itemKey, n.status]), [['roofing', 'likely'], ['mystery', 'unknown']]);
  assert.equal(notices[0]?.facts[0]?.authority, 'Contractors State License Board');
  assert.equal(notices[0]?.unverified, true, 'unverified facets carry the notice');
  assert.equal(notices[1]?.noticeKey, 'plans.licensing.unknown');
  const nowhere = p.licensingNotices([roofing], { pack: null, regionCode: null, trades: {}, facts: [] });
  assert.deepEqual(nowhere.map((n) => n.status), ['unknown'], 'a hub without data says unknown');
});

/* ---------- Capability registry and egress ---------- */

test('the project planner registers every plan operation once: parity, mandate kinds, governance on the first-party form only', async () => {
  const manifest = p.PROJECT_PLANNER_MANIFEST;
  assert.ok(c.AgentModuleManifestSchema.safeParse(manifest).success);
  const registry = c.buildCapabilityRegistry({ registryVersion: 1, hubId: null, manifests: [manifest], extensionCapabilities: [] });
  assert.deepEqual(c.parityGaps(registry.capabilities), [], 'every capability is in the interface and the agent');
  const byId = new Map(registry.capabilities.map((x) => [x.id, x]));
  for (const id of ['project_planner.approve_version', 'project_planner.return_version', 'project_planner.decide_change']) {
    const cap = byId.get(id);
    assert.equal(cap?.kind, 'govern', id);
    assert.equal(cap && c.requiredConnectionScopes(cap), null, `${id} is never reachable from a connection`);
  }
  for (const id of ['project_planner.draft_plan', 'project_planner.propose_version']) {
    assert.equal(byId.get(id)?.kind, 'draft');
    assert.equal(byId.get(id)?.mandateAction, 'prepare', `${id}: an agent drafts and proposes only under a prepare mandate`);
  }
  assert.equal(byId.get('project_planner.share_item')?.mandateAction, 'publish');
  assert.equal(byId.get('project_planner.record_change')?.mandateAction, 'record_evidence');
  assert.equal(byId.get('project_planner.set_location')?.confirmation, 'person_each');
  assert.ok(byId.get('project_planner.get_plan')?.privateDataClasses.includes('budgets'));
  for (const cap of registry.capabilities) {
    for (const ref of [cap.input, cap.output]) {
      const mod = (await import(`../../packages/contracts/src/${ref.contract}.js`)) as Record<string, unknown>;
      assert.ok(mod[ref.schema] && typeof (mod[ref.schema] as { safeParse?: unknown }).safeParse === 'function', `${cap.id}: ${ref.contract}.${ref.schema}`);
    }
  }
});

test('plans never reach search, retrieval, federation or a public projection; events carry identifiers only', () => {
  assert.deepEqual(p.PLAN_EGRESS, { search: false, retrieval: false, federation: false, publicProjection: false, notificationPayload: 'identifiers_only' });
  for (const kind of ['plan', 'plan_item', 'plan_version', 'plan_share', 'diary']) assert.equal((c.SourceKindSchema.options as readonly string[]).includes(kind), false, `${kind} is not a retrieval source`);
  for (const key of p.PLAN_EVENT_PAYLOAD_KEYS) assert.ok(!/budget|note|address|title|description|estimate|reason|contact/i.test(key), key);
  assert.equal('plans' in c, false, 'the project projection has no plan field');
  assert.equal(Object.keys(c.PublicProjectSchema.shape).some((k) => /plan|budget/i.test(k)), false);
});
