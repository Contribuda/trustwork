import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftFeeSchema, DraftSalePriceSchema } from '../../../../packages/contracts/src/billing-fees.js';
import { DraftMeteredPriceSchema, RecordMeteredCostSchema } from '../../../../packages/contracts/src/agent-metering.js';
import { priceCommand, priceRefusal, readPrices } from '../../../../apps/web/app/admin/_data/live-prices.js';
import { basisPoints, costRecord, feeDraft, priceFormProblem, saleDraft, usageDraft } from '../../../../apps/web/app/admin/hubs/[hub]/billing/prices/_commands.js';

/** The pure parts of HC-91 on the live API: what a form may send, how a refusal is worded, and the hub the screen acts on. */
const HUB = '11111111-1111-4111-8111-111111111111';
const OTHER_HUB = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const YOU = '44444444-4444-4444-8444-444444444444';
const ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-11-04T12:00:00.000Z');
const form = { currency: 'USD', now: NOW };
const orNothing = async <T>(read: Promise<T>) => read;
const fee = (over: Record<string, unknown> = {}) => ({
  id: ID, hubId: HUB, version: 1, digest: 'a'.repeat(64), status: 'draft', draftedBy: YOU, activatedBy: null, activatedAt: null,
  terms: { kind: 'task', categoryKey: null, currency: 'USD', basisPoints: 100, fixedMinor: null, payer: 'buyer', effectiveFrom: '2026-12-01T00:00:00.000Z', effectiveTo: null, acceptanceTextVersion: 'v1' }, ...over,
});

test('a percentage becomes basis points in whole numbers', () => {
  const cases: Array<[string, number | null]> = [['0', 0], ['0.07', 7], ['0.1', 10], ['12.5', 1250], ['33.33', 3333], ['100', 10_000], ['100.00', 10_000], ['100.01', null], ['1.005', null], ['-1', null], ['1e2', null], ['', null]];
  for (const [value, points] of cases) assert.equal(basisPoints(value), points, value);
});

test('what the forms send is what the strict API schemas accept, and nothing else', () => {
  const reason = 'Synthetic';
  const date = '2026-12-01';
  const money = { feeKind: 'consultation', feePayer: 'seller', feeCategory: 'synthetic.review', feePercent: '1.25', feeFixedMinor: '300', feeEffectiveFrom: date, feeAcceptance: 'v1' };
  assert.deepEqual(DraftFeeSchema.parse({ reason, ...feeDraft(money, form) }).terms.basisPoints, 125);
  const sale = { saleKind: 'model', saleSubject: 'synthetic-model', saleCode: 'synthetic_model', saleName: 'Synthetic', saleMeter: 'model_tokens', salePerUnits: '1000', saleAmountMinor: '25', saleEffectiveFrom: date, saleAcceptance: 'v1' };
  assert.equal(DraftSalePriceSchema.parse({ reason, ...saleDraft(sale, form) }).terms.kind, 'model');
  assert.equal(DraftSalePriceSchema.parse({ reason, ...saleDraft({ ...sale, saleKind: 'capability', saleSubject: 'core.list_goals' }, form) }).terms.kind, 'capability');
  const usage = { usageSubject: 'model', usageKey: 'synthetic-model', usageMeter: 'model_tokens', usageDirection: 'output', usageBasis: 'flat', usageSale: '0.3', usageEffectiveFrom: date, usageAcceptance: 'v1' };
  assert.deepEqual(DraftMeteredPriceSchema.parse({ reason, ...usageDraft(usage, form) }).terms.subject, { kind: 'model', key: 'synthetic-model', direction: 'output', meter: 'model_tokens' });
  assert.deepEqual(DraftMeteredPriceSchema.parse({ reason, ...usageDraft({ ...usage, usageSubject: 'meter', usageMeter: 'checks' }, form) }).terms.subject, { kind: 'meter', key: 'checks', meter: 'checks' });
  assert.deepEqual(DraftMeteredPriceSchema.parse({ reason, ...usageDraft({ ...usage, usageSubject: 'module', usageKey: 'project_planner', usageMeter: 'agent_actions', usageBasis: 'markup', usagePercent: '20' }, form) }).terms.basis, { kind: 'markup', percent: 20 });
  assert.equal(RecordMeteredCostSchema.parse({ reason, ...costRecord({ costSubject: 'meter', costMeter: 'checks', costPerUnit: '3.25', costBasis: 'contract' }, form) }).cost.observedAt, NOW.toISOString());
});

test('a form that cannot be right never leaves the console', () => {
  const problem = (command: Parameters<typeof priceFormProblem>[0], fields: Record<string, string>) => priceFormProblem(command, fields, form);
  const fee = { feeKind: 'task', feePayer: 'buyer', feePercent: '1', feeEffectiveFrom: '2026-12-01', feeAcceptance: 'v1' };
  assert.equal(problem('prices.fee_draft', fee), null);
  assert.deepEqual(problem('prices.fee_draft', { ...fee, feeEffectiveFrom: '2026-11-04' }), { field: 'feeEffectiveFrom', code: 'back_dated' }, 'today is back-dated: it started at midnight');
  assert.deepEqual(problem('prices.fee_draft', { ...fee, feeEffectiveFrom: 'soon' }), { field: 'feeEffectiveFrom' });
  assert.deepEqual(problem('prices.fee_draft', { ...fee, feeAcceptance: '' }), { field: 'feeAcceptance' });
  assert.deepEqual(problem('prices.fee_draft', { ...fee, feeFixedMinor: '1.5' }), { field: 'feeFixedMinor' }, 'a fixed amount is whole minor units');
  assert.deepEqual(problem('prices.usage_draft', { usageSubject: 'participant', usageMeter: 'checks' }), { field: 'usageSubject' }, 'no price names a participant');
  assert.deepEqual(problem('prices.cost_record', { costSubject: 'model', costKey: 'synthetic-model', costMeter: 'model_tokens', costPerUnit: '1', costBasis: 'contract' }), { field: 'costSubject' }, 'model costs stay in the provider records');
  assert.deepEqual(problem('prices.activate', { target: 'anything', id: ID }), { field: 'target' });
  assert.deepEqual(problem('prices.activate', { target: 'fee', id: 'x' }), { field: 'id' });
  assert.deepEqual(problem('prices.activate', { target: 'sale', id: ID, supersedes: 'x' }), { field: 'supersedes' });
});

test('a refusal is worded by what the API said; a fee conflict is not called stale unless it is', () => {
  const code = (answer: Parameters<typeof priceRefusal>[0]) => { const o = priceRefusal(answer); return o.status === 'rejected' ? [o.code, o.field] : o.status; };
  const conflict = (reason: string) => ({ status: 409, code: 'validation.revision_conflict', body: { details: { reason } } });
  assert.equal(code({ status: 404, code: 'access.not_found' }), 'not_found');
  assert.deepEqual(code({ status: 401, code: 'auth.session_invalid' }), ['elevation_required', null]);
  assert.deepEqual(code({ status: 403, code: 'access.forbidden' }), ['denied', null]);
  assert.deepEqual(code({ status: 403, code: 'access.approval_digest_mismatch' }), ['digest_mismatch', null]);
  assert.deepEqual(code({ status: 403, code: 'access.second_approver_required', body: { details: { reason: 'self_approval' } } }), ['drafter_cannot_ask', null]);
  assert.deepEqual(code({ status: 403, code: 'access.second_approver_required', body: { details: { reason: 'not_requester' } } }), ['second_person_pending', null]);
  assert.deepEqual(code(conflict('billing.version_overlap')), ['overlap', null]);
  assert.deepEqual(code(conflict('billing.supersede_leaves_gap')), ['overlap', null]);
  assert.deepEqual(code(conflict('billing.subject_priced_elsewhere')), ['priced_elsewhere', null]);
  assert.deepEqual(code(conflict('billing.cost_record_missing')), ['cost_record_missing', null]);
  assert.deepEqual(code(conflict('billing.sale_subject_unknown')), ['invalid', 'saleSubject']);
  assert.deepEqual(code(conflict('billing.invalid_transition')), ['stale', null]);
  assert.deepEqual(code(conflict('billing.invalid_terms')), ['invalid', null]);
  assert.deepEqual(code({ status: 400, code: 'validation.schema' }), ['invalid', null]);
});

test('the screen acts only on the hub the deployment serves', async () => {
  const reads: string[] = [];
  const api = { get: async (path: string) => { reads.push(path); return path === '/v1/pricing' ? { hubId: OTHER_HUB } : { fees: [] }; } };
  assert.deepEqual(await readPrices(api, orNothing, HUB, ME, NOW), { served: false, fees: null, sales: null, usage: null });
  assert.deepEqual(reads, ['/v1/pricing'], 'no staff list is read for another hub');
  const closed = await readPrices({ get: async () => ({ hubId: null }) }, orNothing, HUB, ME, NOW);
  assert.equal(closed.served, false, 'a deployment with no open hub serves none');
  const posts: string[] = [];
  const io = { post: async (path: string) => { posts.push(path); return { status: 201, code: null }; }, send: async (path: string) => { posts.push(path); return { status: 201, code: null }; }, read: async () => ({ served: false, fees: null, sales: null, usage: null }), form, viewerId: ME, hubId: HUB };
  for (const [command, fields] of [['prices.fee_draft', { feeKind: 'task', feePayer: 'buyer', feePercent: '1', feeEffectiveFrom: '2026-12-01', feeAcceptance: 'v1' }], ['prices.usage_cancel', { id: ID }], ['prices.activate', { target: 'fee', id: ID }]] as const) {
    assert.deepEqual(await priceCommand(command, fields, io), { status: 'not_found' }, command);
  }
  assert.deepEqual(posts, [], 'nothing is sent');
});

test('rows of another hub are dropped, whatever a list answers', async () => {
  const get = async (path: string) => {
    if (path === '/v1/pricing') return { hubId: HUB };
    if (path === '/v1/admin/billing/fees') return [fee(), fee({ id: YOU, hubId: OTHER_HUB })];
    if (path === '/v1/admin/billing/sale-prices') return [];
    if (path === '/v1/admin/billing/metered/prices') return { prices: [] };
    return { forMe: [], mine: [], decided: [] };
  };
  const view = await readPrices({ get }, orNothing, HUB, ME, NOW);
  assert.deepEqual(view.fees?.map((f) => f.id), [ID]);
});

test('the drafter is told before anything is sent, and only an approval of this viewer activates', async () => {
  const posts: string[] = [];
  const view = (stage: unknown, draftedBy: string) => ({ served: true, sales: [], usage: [], fees: [{ ...fee({ draftedBy }), stage }] });
  const io = (v: unknown, viewerId = ME) => ({
    post: async (path: string) => { posts.push(path); return { status: 200, code: null }; }, send: async (path: string) => { posts.push(path); return { status: 201, code: null }; },
    read: async () => v as never, form, viewerId, hubId: HUB,
  });
  const fields = { target: 'fee', id: ID };
  const asked = await priceCommand('prices.request_activation', fields, io(view({ stage: 'none' }, ME)));
  assert.equal(asked.status === 'rejected' && asked.code, 'drafter_cannot_ask');
  const taken = await priceCommand('prices.activate', fields, io(view({ stage: 'requested', requestId: 'r', requestedBy: YOU, approved: true }, YOU)));
  assert.equal(taken.status === 'rejected' && taken.code, 'second_person_pending');
  assert.deepEqual(posts, []);
  assert.deepEqual(await priceCommand('prices.activate', fields, io(view({ stage: 'approved', requestId: ID }, YOU))), { status: 'applied' });
  assert.deepEqual(posts, [`/v1/admin/billing/fees/${ID}/activate`]);
  assert.deepEqual(await priceCommand('prices.activate', { target: 'usage', id: ID }, io(view({ stage: 'approved', requestId: ID }, YOU))), { status: 'not_found' }, 'a fee id is no usage price');
});
