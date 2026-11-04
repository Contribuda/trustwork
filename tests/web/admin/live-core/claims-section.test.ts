import test from 'node:test';
import assert from 'node:assert/strict';
import { claimRefusal, readClaims } from '../../../../apps/web/app/admin/_data/live-claims.js';
import { boundChecks, checkBody, claimFormProblem, countryBody, decideBody, proposeBody, territoryState } from '../../../../apps/web/app/admin/hubs/[hub]/participants/claims/_commands.js';
import { CorrectCountryCommandSchema, DecideClaimCommandSchema, ProposeDisputeCommandSchema } from '../../../../apps/api/src/modules/verification/claims/commands.js';
import { RecordCheckCommandSchema } from '../../../../apps/api/src/modules/verification/commands.js';

/** The pure parts of HC-22 on the live API: the country rule as the page reads it, the forms and the refusals. */
const HUB = '11111111-1111-4111-8111-111111111111';
const OTHER_HUB = '22222222-2222-4222-8222-222222222222';
const COMPANY = '33333333-3333-4333-8333-333333333333';
const CLAIM = '44444444-4444-4444-8444-444444444444';
const RECIPE = '55555555-5555-4555-8555-555555555555';
const CHECK = '66666666-6666-4666-8666-666666666666';
const AT = '2026-11-04T12:00:00.000Z';
const envelope = { contractVersion: '1.0.0', idempotencyKey: 'synthetic-key-0001', reason: 'Synthetic' };
const orNothing = async <T>(read: Promise<T>) => read;

test('a territory covers a country by the country itself, a region or a place in it', () => {
  assert.equal(territoryState([{ code: 'GE' }], 'GE'), 'covered');
  assert.equal(territoryState([{ code: 'US-CA' }], 'US'), 'covered');
  assert.equal(territoryState([{ code: 'US-CA:san-diego' }], 'US'), 'covered');
  assert.equal(territoryState([{ code: 'US' }], 'CA'), 'outside');
  assert.equal(territoryState([], 'US'), 'outside');
  assert.equal(territoryState([{ code: 'US' }], null), 'missing');
});

test('what the forms send is what the strict API schemas accept', () => {
  assert.equal(DecideClaimCommandSchema.parse({ ...envelope, ...decideBody({ revision: '3', decision: 'approved', officerMatch: 'on', note: '' }) }).officerMatch, true);
  assert.equal(DecideClaimCommandSchema.parse({ ...envelope, ...decideBody({ revision: '3', decision: 'rejected' }) }).note, null);
  assert.equal(CorrectCountryCommandSchema.parse({ ...envelope, ...countryBody({ fromCountry: '', fromRegion: '', country: 'ge', region: '' }) }).country, 'GE');
  assert.equal(ProposeDisputeCommandSchema.parse({ ...envelope, ...proposeBody({ revision: '1', winner: 'none', note: 'Synthetic reasoning' }) }).winnerClaimId, null);
  assert.equal(RecordCheckCommandSchema.parse({ ...envelope, ...checkBody({ companyId: COMPANY, recipeId: RECIPE, providerId: CHECK, result: 'pass', evidenceRef: 'register:SYN-1' }) }).result, 'pass');
});

test('a form that cannot be right never leaves the console', () => {
  assert.deepEqual(claimFormProblem('claim.decide', { claimId: CLAIM, revision: 'x', decision: 'approved' }), { field: 'revision' });
  assert.deepEqual(claimFormProblem('claim.decide', { claimId: CLAIM, revision: '1', decision: 'verified' }), { field: 'decision' }, 'a decision is approved or rejected: no badge is typed here');
  assert.deepEqual(boundChecks({}), { field: 'checks' });
  assert.deepEqual(boundChecks({ [`check.${CHECK}`]: 'on', 'check.x': 'on' }), { field: 'checks' });
  assert.deepEqual(boundChecks({ [`check.${CHECK}`]: 'on', other: 'on' }), { checkIds: [CHECK] });
  assert.deepEqual(countryBody({ country: 'Georgia' }), { field: 'country' });
  assert.deepEqual(countryBody({ country: 'UA', region: 'kyiv' }), { field: 'region' });
  assert.deepEqual(proposeBody({ revision: '1', winner: 'none', note: 'short' }), { field: 'note' });
  assert.deepEqual(checkBody({ companyId: COMPANY, recipeId: RECIPE, providerId: CHECK, result: 'maybe' }), { field: 'result' });
});

test('a refusal keeps its reason, so a reviewer reads why', () => {
  const code = (answer: Parameters<typeof claimRefusal>[0]) => { const o = claimRefusal(answer); return o.status === 'rejected' ? [o.code, o.detail] : o.status; };
  const forbidden = (reason: string) => ({ status: 403, code: 'access.forbidden', body: { details: { reason } } });
  assert.equal(code({ status: 404, code: 'access.not_found' }), 'not_found');
  assert.deepEqual(code(forbidden('forbidden')), ['denied', []]);
  assert.deepEqual(code(forbidden('elevation_required')), ['elevation_required', []]);
  assert.deepEqual(code(forbidden('outside_territory')), ['claim_reason', ['outside_territory']]);
  assert.deepEqual(code(forbidden('own_country_correction')), ['claim_reason', ['own_country_correction']]);
  assert.deepEqual(code({ status: 403, code: 'access.second_approver_required', body: { details: { reason: 'second_person_required' } } }), ['claim_reason', ['second_person_required']]);
  assert.deepEqual(code({ status: 409, code: 'validation.revision_conflict', body: { details: { reason: 'revision_conflict' } } }), ['stale', []]);
  assert.deepEqual(code({ status: 409, code: 'validation.revision_conflict', body: { details: { reason: 'country_changed' } } }), ['claim_reason', ['country_changed']]);
  assert.deepEqual(code({ status: 400, code: 'validation.schema' }), ['invalid', []]);
});

test('the view: another hub is dropped, checks older than the claim are not offered, and the claimant sees no country', async () => {
  const row = { id: CLAIM, hubId: HUB, companyId: COMPANY, level: 'verified', recipeId: RECIPE, domainTie: null, state: 'open', waitingUntil: null, decidedAt: null, revision: 1, createdAt: AT };
  const staffRow = { ...row, claimantId: COMPANY, domainTieDomain: null, disputeId: null };
  const replies = (claims: unknown[]) => async (path: string) => {
    if (path.endsWith('/claims')) return { claims, disputes: [], settings: {} };
    if (path.includes('/claims/requests/')) return { claim: { companyCountry: 'CA', companyRegion: null, evidence: [CHECK] } };
    if (path.endsWith('/checks')) return { items: [{ id: CHECK, recipeId: RECIPE, checkType: 'register_match', mode: 'manual', result: 'pass', recordedAt: '2026-11-04T13:00:00.000Z', expiresAt: null }, { id: RECIPE, recipeId: RECIPE, checkType: 'licence', mode: 'manual', result: 'pass', recordedAt: '2026-11-03T13:00:00.000Z', expiresAt: null }] };
    if (path.includes('/standing')) return { status: 'pending', missing: ['licence'], failed: [], handoverBlocked: true, badgeCategories: [] };
    return null;
  };
  const hub = { id: HUB, territories: [{ code: 'US' }] };
  const view = await readClaims({ get: replies([staffRow, { ...staffRow, id: COMPANY, hubId: OTHER_HUB }]) }, orNothing, hub);
  assert.deepEqual(view?.claims.map((c) => c.id), [CLAIM]);
  assert.equal(view?.claims[0]?.territory, 'outside');
  assert.deepEqual(view?.claims[0]?.checks.map((c) => [c.id, c.bound]), [[CHECK, true]], 'an earlier result proves nothing for this claim');
  assert.equal(view?.claims[0]?.standing?.handoverBlocked, true);
  const own = await readClaims({ get: replies([row]) }, orNothing, hub);
  assert.deepEqual([own?.claims[0]?.own, own?.claims[0]?.company, own?.claims[0]?.territory, own?.claims[0]?.standing], [true, null, null, null]);
  assert.equal(await readClaims({ get: async () => null }, orNothing, hub), null);
});
