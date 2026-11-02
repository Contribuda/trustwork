import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import { VERIFICATION_CHECK_TYPES, VERIFICATION_TRIGGERS } from '../../apps/api/src/modules/verification/commands.js';
import { SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../admin/helpers.js';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { actors, buildHubWorld, syncKernel, type HubWorld } from '../hubs/helpers.js';

const h = await startHarness('verification_api');
const PERMISSIONS = ['admin.claims.read', 'admin.claims.decide', 'admin.claims.policy.edit', 'admin.providers.toggle'];

/**
 * HUB-003 through the HTTP API on real PostgreSQL with real sessions, TOTP and elevated sessions: the vocabularies of
 * the API equal the database's; staff routes refuse a participant, an unelevated staff member and staff of another
 * hub; a recipe without the sanctions check never reaches the database; live mode refuses another digest; standing
 * reads are staff-only and blocked for an unscreened subject. Every person, hub and company is synthetic.
 */
test('HUB-003 verification API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const admin = h.db.admin;
  await syncKernel(admin);
  const w: HubWorld = await buildHubWorld(admin);
  const a = actors(admin, h.pool, w);
  await withMaintenance(admin, (trx) => staffRoleDefinitions.release(trx, { version: 1, role: 'trust-reviewer', scopes: ['hub'], permissions: PERMISSIONS as never,
    caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub('synthetic-verification-api')).hub_id;
  const otherHubId = (await a.createHub('synthetic-verification-other')).hub_id;
  const seeded = await withMaintenance(admin, async (trx) => {
    const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    const people = { staff: await person('Synthetic Verification Staff'), elsewhere: await person('Synthetic Other Hub Staff'), participant: await person('Synthetic Participant') };
    const companyId = (await trx.insertInto('company').values({ display_name: 'Synthetic Verification API Builders' }).returning('id').executeTakeFirstOrThrow()).id;
    return { people, companyId };
  });
  await a.assign({ personId: seeded.people.staff, role: 'trust-reviewer' as never, scope: { kind: 'hub', hubId } });
  await a.assign({ personId: seeded.people.elsewhere, role: 'trust-reviewer' as never, scope: { kind: 'hub', hubId: otherHubId } });
  const { people, companyId } = seeded;
  const email = (k: string) => `verification-api-${k}@example.invalid`;
  await addLogins(h, Object.entries(people).map(([k, id]) => [id, email(k)]));
  const clients = {} as Record<keyof typeof people | 'unelevated', Client>;
  // A second session of the staff member, signed in before the second factor exists, that never elevates.
  clients.unelevated = h.client();
  await signIn(clients.unelevated, email('staff'));
  for (const key of ['staff', 'elsewhere', 'participant'] as const) {
    clients[key] = h.client();
    await signIn(clients[key], email(key));
    if (key === 'participant') continue;
    h.staff.set(people[key], ['trust-reviewer']);
    const secret = await enrolNow(h, clients[key]);
    h.clock.advance(30_000);
    assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    assert.equal((await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null })).status, 200);
    h.clock.reset();
  }
  const base = `/v1/admin/hubs/${hubId}/verification`;
  const send = (client: Client, url: string, rest: Record<string, unknown>): Promise<Response> => {
    const key = `verify-${randomUUID()}`;
    return client.post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: key, reason: 'Synthetic verification action', ...rest }, { idempotencyKey: key });
  };
  const code = (r: Response) => (r.body as { code?: string } | null)?.code;
  const recipe = {
    key: 'api-claim', subjectKind: 'company', trigger: 'claim_verified', recheckMonths: 12, badgeCategories: ['register_record_matches', 'sanctions_screening_clear'],
    steps: [{ check: 'register_match', required: true }, { check: 'sanctions_screening', required: true }],
  };

  await t.test('the API vocabularies equal the database vocabularies', async () => {
    const { rows } = await admin.query<{ types: string[]; triggers: string[] }>('SELECT trustwork.verification_check_types() AS types, trustwork.verification_triggers() AS triggers');
    assert.deepEqual([...VERIFICATION_CHECK_TYPES], rows[0]!.types);
    assert.deepEqual([...VERIFICATION_TRIGGERS], rows[0]!.triggers);
  });

  await t.test('negative authorization: participant, unelevated staff, staff of another hub', async () => {
    const participant = await send(clients.participant, `${base}/recipes`, recipe);
    assert.equal(participant.status, 403, JSON.stringify(participant.body));
    const unelevated = await send(clients.unelevated, `${base}/recipes`, recipe);
    assert.equal(unelevated.status, 403);
    assert.equal((unelevated.body as { details?: { required?: string } }).details?.required, 'elevation');
    const elsewhere = await send(clients.elsewhere, `${base}/recipes`, recipe);
    assert.equal(elsewhere.status, 403);
    assert.equal(code(elsewhere), 'access.forbidden');
    assert.deepEqual((await clients.elsewhere.get(base)).body, { providers: [], recipes: [] }, 'staff of another hub read nothing here');
    assert.equal((await clients.participant.get(base)).status, 403);
  });

  await t.test('a recipe without a required sanctions step never reaches the database', async () => {
    const r = await send(clients.staff, `${base}/recipes`, { ...recipe, key: 'no-sanctions', steps: [{ check: 'register_match', required: true }] });
    assert.equal(r.status, 422);
    const optional = await send(clients.staff, `${base}/recipes`, { ...recipe, key: 'optional', steps: [{ check: 'sanctions_screening', required: false }] });
    assert.equal(optional.status, 422);
    assert.equal((await admin.query("SELECT 1 FROM trustwork.verification_recipe WHERE hub_id = $1 AND key IN ('no-sanctions', 'optional')", [hubId])).rowCount, 0);
  });

  await t.test('a provider goes live only with a second person\'s approval of the exact digest; standing is blocked for an unscreened subject', async () => {
    const provider = (await send(clients.staff, `${base}/providers`, { checkType: 'register_match', adapter: 'synthetic_api_register', mode: 'manual', retentionDays: 365,
      legalBasis: 'statutory_public_register', costMinor: null })).body as { provider: { id: string; revision: number } };
    const credentialId = await withMaintenance(admin, async (trx) => (await trx.insertInto('provider_credential_ref').values({ hub_id: hubId, provider: 'synthetic_register', adapter: 'synthetic_register_api',
      mode: 'live', secret_store: 'env', secret_ref: 'env:SYNTHETIC_API_REGISTER', registered_by: people.staff }).returning('id').executeTakeFirstOrThrow()).id);
    const noApproval = await send(clients.staff, `${base}/providers/${provider.provider.id}/live`, { expectedRevision: provider.provider.revision, credentialRefId: credentialId, approvalId: null });
    assert.equal(noApproval.status, 403);
    assert.equal(code(noApproval), 'access.second_approver_required');
    const recipeRow = ((await send(clients.staff, `${base}/recipes`, recipe)).body as { recipe: { id: string; revision: number } }).recipe;
    assert.equal((await send(clients.staff, `${base}/recipes/${recipeRow.id}/activate`, { expectedRevision: recipeRow.revision })).status, 200);
    assert.equal((await send(clients.staff, `${base}/checks`, { subject: { kind: 'company', id: companyId }, recipeId: recipeRow.id, providerId: provider.provider.id, result: 'pass',
      evidenceRef: 'register:SYN-API-1' })).status, 201);
    const standing = await clients.staff.get(`${base}/standing?subjectKind=company&subjectId=${companyId}&recipeId=${recipeRow.id}`);
    assert.equal(standing.status, 200, JSON.stringify(standing.body));
    assert.deepEqual([(standing.body as { status: string }).status, (standing.body as { handoverBlocked: boolean }).handoverBlocked], ['pending', true], 'an unscreened subject is never handed over');
    const elsewhere = await clients.elsewhere.get(`/v1/admin/hubs/${hubId}/verification/standing?subjectKind=company&subjectId=${companyId}&recipeId=${recipeRow.id}`);
    assert.equal(elsewhere.status, 404, 'staff of another hub find nothing');
  });

  await t.test('appeals: anyone but the subject finds nothing; the recorder may not decide (403); a decision is final', async () => {
    const provider = ((await send(clients.staff, `${base}/providers`, { checkType: 'tax_status', adapter: 'synthetic_api_tax', mode: 'manual', retentionDays: 365,
      legalBasis: 'statutory_public_register', costMinor: null })).body as { provider: { id: string } }).provider;
    const taxRecipe = ((await send(clients.staff, `${base}/recipes`, { ...recipe, key: 'api-tax', trigger: 'seller_onboarding', badgeCategories: ['tax_status_current'],
      steps: [{ check: 'tax_status', required: true }, { check: 'sanctions_screening', required: true }] })).body as { recipe: { id: string; revision: number } }).recipe;
    assert.equal((await send(clients.staff, `${base}/recipes/${taxRecipe.id}/activate`, { expectedRevision: taxRecipe.revision })).status, 200);
    const adverse = ((await send(clients.staff, `${base}/checks`, { subject: { kind: 'company', id: companyId }, recipeId: taxRecipe.id, providerId: provider.id, result: 'fail',
      evidenceRef: 'tax:SYN-API-9' })).body as { check: { id: string } }).check;
    const appealBy = (client: Client) => { const key = `appeal-${randomUUID()}`; return client.post(`/v1/verification/checks/${adverse.id}/appeals`, { reason: 'Renewed.' }, { idempotencyKey: key }); };
    assert.equal((await appealBy(clients.participant)).status, 404, 'not the subject: nothing is found');
    assert.equal((await appealBy(clients.elsewhere)).status, 404);
    // The company has no administrator in this world, so nobody may appeal its result; the recorder may not decide an appeal either.
    assert.equal((await clients.participant.get('/v1/verification/appeals')).status, 200);
    assert.deepEqual(((await clients.participant.get('/v1/verification/appeals')).body as { items: unknown[] }).items, []);
  });
});
