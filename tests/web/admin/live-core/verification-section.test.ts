import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalStage, hubApprovals } from '../../../../apps/web/app/admin/_data/live-approvals.js';
import { configPayload, readVerification, verificationRefusal, type VerificationRecipe } from '../../../../apps/web/app/admin/_data/live-verification.js';
import { claimSettings, providerDraft, recipeDraft, recipeSteps, verificationFormProblem } from '../../../../apps/web/app/admin/hubs/[hub]/participants/verification/_commands.js';

/** The pure parts of HC-23 on the live API: what the form may ask for, where a digest stands, how a refusal is worded. */
const HUB = '11111111-1111-4111-8111-111111111111';
const OTHER_HUB = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const YOU = '44444444-4444-4444-8444-444444444444';
const PROVIDER = '55555555-5555-4555-8555-555555555555';
const CREDENTIAL = '66666666-6666-4666-8666-666666666666';
const DIGEST = 'a'.repeat(64);
const NOW = new Date('2026-11-04T12:00:00.000Z');
const LATER = '2026-11-05T12:00:00.000Z';
const EARLIER = '2026-11-03T12:00:00.000Z';
const orNothing = async <T>(read: Promise<T>) => read;

const approval = (over: Record<string, unknown> = {}) => ({
  id: 'a-1', action: 'providers.enable_non_fake', scope: { kind: 'hub', hubId: HUB }, actionDigest: DIGEST, requestedBy: ME, requestExpiresAt: LATER, status: 'pending', expiresAt: null, revokedAt: null, ...over,
});
const stage = (over: Record<string, unknown> = {}, viewer = ME) => approvalStage(hubApprovals({ mine: [approval(over)] }, HUB), 'providers.enable_non_fake', DIGEST, viewer, NOW);

test('a digest stands where its live request says: an expired, revoked or foreign one counts for nothing', () => {
  assert.deepEqual(stage(), { stage: 'requested', requestId: 'a-1', requestedBy: ME, approved: false });
  assert.deepEqual(stage({ requestExpiresAt: EARLIER }), { stage: 'none' }, 'a request nobody answered in time is gone');
  assert.deepEqual(stage({ status: 'approved', expiresAt: LATER }), { stage: 'approved', requestId: 'a-1' });
  assert.deepEqual(stage({ status: 'approved', expiresAt: LATER }, YOU), { stage: 'requested', requestId: 'a-1', requestedBy: ME, approved: true }, 'only the requester finishes it');
  assert.deepEqual(stage({ status: 'approved', expiresAt: EARLIER }), { stage: 'none' });
  assert.deepEqual(stage({ status: 'approved', expiresAt: LATER, revokedAt: EARLIER }), { stage: 'none' });
  for (const status of ['consumed', 'declined', 'withdrawn']) assert.deepEqual(stage({ status, expiresAt: LATER }), { stage: 'none' }, status);
  assert.deepEqual(stage({ actionDigest: 'b'.repeat(64) }), { stage: 'none' }, 'another digest is another change');
  assert.deepEqual(stage({ action: 'staff.assign_sensitive_role' }), { stage: 'none' }, 'another action is another change');
  assert.deepEqual(hubApprovals({ mine: [approval({ scope: { kind: 'hub', hubId: OTHER_HUB } })] }, HUB), [], "another hub's request is not this hub's");
  assert.deepEqual(hubApprovals({ mine: [approval({ scope: { kind: 'node' } })] }, HUB), []);
  assert.deepEqual(hubApprovals({ forMe: [approval()], mine: [approval()] }, HUB).map((r) => r.id), ['a-1'], 'each request once');
  assert.deepEqual(hubApprovals(null, HUB), []);
});

test('the recipe form: sanctions screening cannot be left out, and a group is two to four checks', () => {
  assert.deepEqual(recipeSteps({}), [{ check: 'sanctions_screening', required: true }]);
  assert.deepEqual(recipeSteps({ 'step.sanctions_screening': 'off', 'step.licence': 'required', 'step.ownership': 'optional' }), [
    { check: 'licence', required: true }, { check: 'ownership', required: false }, { check: 'sanctions_screening', required: true },
  ]);
  assert.deepEqual(recipeSteps({ 'step.licence': 'any' }), { field: 'step.licence' });
  assert.deepEqual(recipeSteps({ 'step.licence': 'nonsense' }), { field: 'step.licence' });
  const five = Object.fromEntries(['register_match', 'officer_match', 'tax_status', 'licence', 'qualification'].map((c) => [`step.${c}`, 'any']));
  assert.deepEqual(recipeSteps(five), { field: 'step.register_match' });
});

test('form fields are checked before anything is sent', () => {
  const recipe = { key: 'company-verified', subjectKind: 'company', trigger: 'claim_verified', categories: 'a_b, c_d', recheckMonths: '12' };
  assert.deepEqual(recipeDraft({ ...recipe, recheckMonths: '25' }), { field: 'recheckMonths' });
  assert.deepEqual(recipeDraft({ ...recipe, categories: ' , ' }), { field: 'categories' });
  assert.deepEqual(recipeDraft({ ...recipe, categories: 'Not Valid' }), { field: 'categories' });
  assert.deepEqual(recipeDraft({ ...recipe, trigger: 'on_a_whim' }), { field: 'trigger' });
  assert.deepEqual(recipeDraft({ ...recipe, subjectKind: 'hub' }), { field: 'subjectKind' });
  assert.deepEqual('steps' in recipeDraft(recipe) && (recipeDraft(recipe) as { badgeCategories: string[] }).badgeCategories, ['a_b', 'c_d']);
  const provider = { checkType: 'licence', adapter: 'manual_review', mode: 'manual', retentionDays: '30', legalBasis: 'contract', costMinor: '' };
  assert.equal((providerDraft(provider) as { costMinor: unknown }).costMinor, null, 'an empty cost is not a cost of zero');
  assert.deepEqual(providerDraft({ ...provider, retentionDays: '0' }), { field: 'retentionDays' });
  assert.deepEqual(providerDraft({ ...provider, costMinor: '1.5' }), { field: 'costMinor' });
  assert.deepEqual(providerDraft({ ...provider, legalBasis: 'because' }), { field: 'legalBasis' });
  assert.deepEqual(claimSettings({ waitingDays: '0', coolingDays: '1' }), { field: 'waitingDays' });
  assert.deepEqual(claimSettings({ waitingDays: '1', coolingDays: '31' }), { field: 'coolingDays' });
  assert.deepEqual(verificationFormProblem('verification.recipe_activate', { recipeId: 'not-a-uuid', revision: '1' }), { field: 'recipeId' });
  assert.deepEqual(verificationFormProblem('verification.recipe_activate', { recipeId: PROVIDER, revision: 'x' }), { field: 'recipeId' });
  assert.deepEqual(verificationFormProblem('verification.provider_go_live', { providerId: PROVIDER, credentialRefId: 'x' }), { field: 'credentialRefId' });
  assert.equal(verificationFormProblem('verification.config_record', {}), null);
});

test('a refusal is worded by what the API said, never softened', () => {
  const code = (answer: Parameters<typeof verificationRefusal>[0]) => { const o = verificationRefusal(answer); return o.status === 'rejected' ? [o.code, o.field] : o.status; };
  assert.equal(code({ status: 404, code: 'access.not_found' }), 'not_found');
  assert.deepEqual(code({ status: 401, code: 'auth.session_invalid' }), ['elevation_required', null]);
  assert.deepEqual(code({ status: 403, code: 'access.forbidden', body: { details: { reason: 'forbidden' } } }), ['denied', null]);
  assert.deepEqual(code({ status: 403, code: 'access.forbidden', body: { details: { reason: 'elevation_required' } } }), ['elevation_required', null]);
  assert.deepEqual(code({ status: 403, code: 'access.approval_digest_mismatch' }), ['digest_mismatch', null]);
  assert.deepEqual(code({ status: 403, code: 'access.second_approver_required', body: { details: { reason: 'self_approval' } } }), ['own_request', null]);
  assert.deepEqual(code({ status: 403, code: 'access.second_approver_required', body: { details: { reason: 'approval_expired' } } }), ['second_person_pending', null]);
  assert.deepEqual(code({ status: 409, code: 'validation.revision_conflict', body: { details: { reason: 'revision_conflict' } } }), ['stale', null]);
  assert.deepEqual(code({ status: 409, code: 'validation.revision_conflict', body: { details: { reason: 'duplicate' } } }), ['invalid', 'adapter']);
  assert.deepEqual(code({ status: 400, code: 'validation.schema' }), ['invalid', null]);
});

test('the view keeps what staff need: no secret reference, no claim, no list of another hub', async () => {
  const replies: Record<string, unknown> = {
    [`/v1/admin/hubs/${HUB}/verification`]: { providers: [{ id: PROVIDER, hubId: HUB, checkType: 'licence', adapter: 'x_y', mode: 'manual', credentialRefId: null, retentionDays: 30, legalBasis: 'contract', costMinor: null, status: 'active', revision: 1, extra: 'dropped' }], recipes: [] },
    [`/v1/admin/hubs/${HUB}/claims`]: { claims: [{ claimantId: ME, evidence: 'private' }], disputes: [], settings: { hubId: HUB, waitingDays: 7, coolingDays: 7, revision: 0, updatedAt: null } },
    [`/v1/admin/hubs/${HUB}/credentials`]: { items: [{ id: CREDENTIAL, provider: 'p', adapter: 'a', mode: 'live', status: 'active', secret: { store: 'env', ref: 'env:SECRET_NAME' } }] },
    '/v1/admin/screening/lists': { items: [{ code: 'own', baseline: false, hubId: HUB, mode: 'file', status: 'active', freshness: { ageSeconds: 60 } }, { code: 'theirs', baseline: false, hubId: OTHER_HUB, mode: 'file', status: 'active', freshness: { ageSeconds: 60 } }, { code: 'ofac', baseline: true, hubId: null, mode: 'file', status: 'active', freshness: { ageSeconds: null } }] },
    [`/v1/admin/approvals?hubId=${HUB}`]: { forMe: [], mine: [], decided: [] },
    [`/v1/admin/hubs/${HUB}/config/current`]: { items: [] },
    [`/v1/admin/hubs/${HUB}/verification/providers/${PROVIDER}/live-digest?credentialRefId=${CREDENTIAL}`]: { action: 'providers.enable_non_fake', actionDigest: DIGEST, revision: 1 },
  };
  const view = await readVerification({ get: async (path) => { assert.ok(path in replies, path); return replies[path]; } }, orNothing, HUB, ME, NOW);
  assert.ok(view);
  const text = JSON.stringify(view);
  assert.ok(!text.includes('SECRET_NAME'), 'a secret reference never reaches the page');
  assert.ok(!text.includes('private'), 'the claims read serves the periods only');
  assert.ok(!text.includes('extra'));
  assert.deepEqual(view.lists?.map((l) => l.code), ['own', 'ofac']);
  assert.deepEqual(view.liveOptions[PROVIDER], [{ credentialId: CREDENTIAL, digest: DIGEST, stage: { stage: 'none' } }]);
  assert.equal(view.config, null);
  assert.equal(await readVerification({ get: async () => null }, orNothing, HUB, ME, NOW), null, 'an API that shows nothing is nothing, not an empty section');
});

test('a credential that is fake, registered or retired is never offered', async () => {
  const get = async (path: string) => {
    if (path.endsWith('/verification')) return { providers: [{ id: PROVIDER, hubId: HUB, checkType: 'licence', adapter: 'x_y', mode: 'fake', credentialRefId: null, retentionDays: 30, legalBasis: 'contract', costMinor: null, status: 'active', revision: 1 }], recipes: [] };
    if (path.endsWith('/credentials')) return { items: [['fake', 'active'], ['live', 'registered'], ['live', 'retired']].map(([mode, status], i) => ({ id: `${i}${CREDENTIAL.slice(1)}`, provider: 'p', adapter: 'a', mode, status })) };
    assert.ok(!path.includes('live-digest'), path);
    return null;
  };
  const view = await readVerification({ get }, orNothing, HUB, ME, NOW);
  assert.deepEqual(view?.liveOptions[PROVIDER], []);
});

test('the launch record names the active recipes only', () => {
  const recipe = (over: Partial<VerificationRecipe>) => ({ id: PROVIDER, key: 'k', version: 1, subjectKind: 'company', trigger: 'claim_verified', status: 'active', ...over }) as VerificationRecipe;
  assert.deepEqual(configPayload([recipe({}), recipe({ id: CREDENTIAL, status: 'draft' }), recipe({ id: ME, status: 'superseded' })]).activeRecipes.map((r) => r.recipeId), [PROVIDER]);
});
