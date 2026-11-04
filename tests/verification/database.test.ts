import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { approvals, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { verification, verificationWorker, type DraftRecipeInput } from '../../packages/data/src/repositories/verification.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects } from '../data/admin/helpers.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { company, screen, screeningWorld } from '../screening/helpers.js';
import { assertCardBinds } from '../admin/approval-change-helpers.js';

const env = await provisionWorkerDatabase('verification_db');

/**
 * HUB-003 first slice on real PostgreSQL under the runtime role: providers start in fake or manual mode and go live only
 * with a credential reference and a second person; every recipe carries the sanctions check and no version drops it;
 * results are append-only evidence references with expiry; the sanctions check reads SANC-003 and never fails or clears
 * a subject on its own; an unscreened subject, a possible match or an unavailable screening store blocks hand-over
 * whatever the other checks say; and only staff of the hub with a claims permission read anything. Every name is
 * synthetic.
 */
test('HUB-003 verification on PostgreSQL', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const runtime = env.apiPool;
  const worker = env.workerPool(6);
  const world = await screeningWorld(admin, runtime, worker);
  const { w, as, elevate, assign, owner } = world;
  const p = w.people;
  await withMaintenance(admin, async (trx) => {
    await staffRoleDefinitions.release(trx, { version: 1, role: 'data-steward', scopes: ['hub'], permissions: ['admin.claims.read', 'admin.claims.policy.edit', 'admin.providers.toggle'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await staffRoleDefinitions.release(trx, { version: 1, role: 'trust-reviewer', scopes: ['hub'], permissions: ['admin.claims.read', 'admin.claims.decide'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
  });
  const hub = { kind: 'hub', hubId: w.hubId } as const;
  await assign({ personId: p.hubOwner, role: 'data-steward', scope: hub });
  await assign({ personId: p.lead2, role: 'data-steward', scope: hub });
  await assign({ personId: p.agent, role: 'trust-reviewer', scope: hub });
  await assign({ personId: p.otherAgent, role: 'trust-reviewer', scope: { kind: 'hub', hubId: w.otherHubId } });
  const cmd = async <T>(person: string, fn: (trx: Parameters<Parameters<typeof as>[1]>[0], ctx: Awaited<ReturnType<typeof elevate>>) => Promise<T>): Promise<T> => {
    const ctx = await elevate(person);
    return as(person, (trx) => fn(trx, ctx));
  };
  const steward = p.hubOwner;
  const reviewer = p.agent;

  const recipeInput = (over: Partial<DraftRecipeInput> = {}): DraftRecipeInput => ({
    key: 'company-claim-standard', subjectKind: 'company', trigger: 'claim_verified', recheckMonths: 12,
    steps: [{ check: 'register_match', required: true }, { anyOf: ['domain_confirmed', 'signed_authority', 'callback_confirmed'] }, { check: 'sanctions_screening', required: true }],
    badgeCategories: ['register_record_matches', 'signatory_confirmed', 'sanctions_screening_clear'], ...over,
  });
  const activeRecipe = async (over: Partial<DraftRecipeInput> = {}) => {
    const drafted = await cmd(steward, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, recipeInput(over)));
    return cmd(steward, (trx, ctx) => verification.activateRecipe(trx, ctx, drafted.id, drafted.revision));
  };
  let adapters = 0;
  const provider = (checkType: string, mode: 'fake' | 'manual' = 'manual') =>
    cmd(steward, (trx, ctx) => verification.registerProvider(trx, ctx, w.hubId, { checkType, adapter: `synthetic_adapter_${++adapters}`, mode, retentionDays: 365, legalBasis: 'statutory_public_register', costMinor: null }));

  await t.test('every recipe carries a required sanctions check; versions are immutable and activation supersedes', async () => {
    const without = recipeInput({ key: 'no-sanctions', steps: [{ check: 'register_match', required: true }] });
    await rejects(cmd(steward, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, without)), '23514', 'verification.sanctions_required');
    await rejects(cmd(steward, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, recipeInput({ key: 'optional-sanctions', steps: [{ check: 'sanctions_screening', required: false }] }))),
      '23514', 'verification.sanctions_required');
    await rejects(cmd(steward, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, recipeInput({ key: 'twice', steps: [{ check: 'sanctions_screening', required: true }, { check: 'register_match', required: true }, { anyOf: ['register_match', 'licence'] }] }))),
      '23514', 'verification.invalid_steps');
    await rejects(cmd(steward, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, recipeInput({ key: 'any-sanctions', steps: [{ check: 'sanctions_screening', required: true }, { anyOf: ['sanctions_screening', 'licence'] }] }))),
      '23514', 'verification.invalid_steps');
    const v1 = await activeRecipe({ key: 'supersede-me' });
    const v2 = await activeRecipe({ key: 'supersede-me' });
    assert.equal(v2.version, 2);
    const rows = await as(steward, (trx) => verification.recipes(trx, w.hubId));
    assert.deepEqual(rows.filter((r) => r.key === 'supersede-me').map((r) => [r.version, r.status]), [[1, 'superseded'], [2, 'active']]);
    await rejects(owner((trx) => sql`UPDATE trustwork.verification_recipe SET steps = '[{"check":"register_match","required":true}]'::jsonb WHERE id = ${v1.id}::uuid`.execute(trx)), '42501', 'verification.immutable');
    await rejects(owner((trx) => sql`DELETE FROM trustwork.verification_recipe WHERE id = ${v1.id}::uuid`.execute(trx)), '42501', 'verification.immutable');
  });

  await t.test('negative authorization: no claims permission, another hub, no elevation, direct writes', async () => {
    await rejects(cmd(reviewer, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, recipeInput({ key: 'by-reviewer' }))), '42501', 'admin.forbidden');
    await rejects(cmd(p.otherAgent, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, recipeInput({ key: 'other-hub' }))), '42501', 'admin.forbidden');
    await rejects(cmd(p.outsider, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, recipeInput({ key: 'outsider' }))), '42501');
    const ctx = { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'req-none', reasonCode: 'synthetic_test', reasonText: 'No elevation' };
    await rejects(as(steward, (trx) => verification.draftRecipe(trx, ctx, w.hubId, recipeInput({ key: 'no-elevation' }))), '42501', 'admin.elevation_required');
    await rejects(as(steward, (trx) => sql`INSERT INTO trustwork.verification_recipe (hub_id, key, version, subject_kind, trigger, steps, badge_categories, recheck_months, drafted_by)
      VALUES (${w.hubId}::uuid, 'direct', 1, 'company', 'claim_verified', '[]'::jsonb, ARRAY['x'], 12, ${steward}::uuid)`.execute(trx)), '42501');
    // Only staff of the hub with a claims permission read anything.
    await activeRecipe({ key: 'visible' });
    assert.ok((await as(reviewer, (trx) => verification.recipes(trx, w.hubId))).length > 0);
    for (const who of [p.outsider, p.otherAgent, p.customer, p.auditor]) assert.deepEqual(await as(who, (trx) => verification.recipes(trx, w.hubId)), [], 'no row without a claims permission at this hub');
    assert.ok((await as(p.moderator, (trx) => verification.recipes(trx, w.hubId))).length > 0, 'a node-scope compliance officer (claims read) reads every hub of the node');
    assert.ok((await as(p.ops, (trx) => verification.recipes(trx, w.hubId))).length > 0, 'so does the third node-scope compliance officer of the world');
  });

  await t.test('providers start fake or manual; live needs a hub credential reference and a different person\'s approval of exactly that version', async () => {
    await rejects(cmd(steward, (trx, ctx) => verification.registerProvider(trx, ctx, w.hubId, { checkType: 'register_match', adapter: 'synthetic_live', mode: 'live' as never, retentionDays: 30, legalBasis: 'contract', costMinor: null })),
      '23514', 'verification.live_needs_second_person');
    await rejects(cmd(steward, (trx, ctx) => verification.registerProvider(trx, ctx, w.hubId, { checkType: 'sanctions_screening', adapter: 'own_lists', mode: 'fake', retentionDays: 30, legalBasis: 'contract', costMinor: null })),
      '23514', 'verification.sanctions_through_screening');
    const prov = await provider('register_match', 'fake');
    const credential = await owner(async (trx) => (await trx.insertInto('provider_credential_ref').values({ hub_id: w.hubId, provider: 'synthetic_register', adapter: 'synthetic_register_api', mode: 'live',
      secret_store: 'env', secret_ref: 'env:SYNTHETIC_REGISTER_KEY', registered_by: steward }).returning('id').executeTakeFirstOrThrow()).id);
    await rejects(cmd(steward, (trx, ctx) => verification.goLive(trx, ctx, prov.id, prov.revision, credential, null)), '42501', 'admin.approval_required');
    const digest = await as(steward, (trx) => verification.liveDigest(trx, prov.id, prov.revision, credential));
    const request = await cmd(steward, (trx, ctx) => approvals.request(trx, ctx, { action: 'providers.enable_non_fake', scope: hub, actionDigest: digest }));
    await rejects(cmd(steward, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest)), '42501');
    const shown = (await as(p.lead2, (trx) => approvals.changes(trx, [request.id]))).get(request.id) as { bound: boolean; fields: Array<{ field: string }> };
    assert.ok(shown.bound && shown.fields.some((f) => f.field === 'check_type'), 'the second person reads the provider the digest binds');
    await assertCardBinds(env.db.admin, request.id);
    await cmd(p.lead2, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    const live = await cmd(steward, (trx, ctx) => verification.goLive(trx, ctx, prov.id, prov.revision, credential, request.id));
    assert.equal(live.mode, 'live');
    await rejects(cmd(steward, (trx, ctx) => verification.goLive(trx, ctx, prov.id, live.revision, credential, request.id)), '23514', 'verification.invalid_transition');
  });

  await t.test('results: evidence references, recipe scope, expiry; live results only from the adapter; append-only', async () => {
    const recipe = await activeRecipe({ key: 'results' });
    const registerProv = await provider('register_match');
    const licence = await provider('licence');
    const subject = { kind: 'company' as const, id: await company(admin, 'Synthetic Builders One') };
    await rejects(cmd(reviewer, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, subject, recipe.id, registerProv.id, 'pass', null)), '23514', 'verification.evidence_required');
    await rejects(cmd(reviewer, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, subject, recipe.id, licence.id, 'pass', 'register:SYN-1')), '23514', 'verification.check_not_in_recipe');
    await rejects(cmd(steward, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, subject, recipe.id, registerProv.id, 'pass', 'register:SYN-1')), '42501', 'admin.forbidden');
    const row = await cmd(reviewer, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, subject, recipe.id, registerProv.id, 'pass', 'register:SYN-1'));
    assert.equal(row.mode, 'manual');
    const months = (row.expires_at.getTime() - row.recorded_at.getTime()) / (30 * 86_400_000);
    assert.ok(months > 11.5 && months < 12.5, 'expires after the recipe\'s re-check period');
    await rejects(owner((trx) => sql`UPDATE trustwork.verification_check SET result = 'fail' WHERE id = ${row.id}::uuid`.execute(trx)), '23000');
    const due = await tx(worker, (trx) => verificationWorker.dueRechecks(trx, w.hubId, 400));
    assert.ok(due.some((d) => d.check_id === row.id), 'the re-check list carries the result before it expires');
  });

  await t.test('the sanctions check: unscreened, possible match and unavailable store block hand-over; a clear subject passes; never "fail"', async () => {
    const recipe = await activeRecipe({ key: 'handover', steps: [{ check: 'register_match', required: true }, { check: 'sanctions_screening', required: true }], badgeCategories: ['register_record_matches', 'sanctions_screening_clear'] });
    const registerProv = await provider('register_match', 'fake');
    const standing = (subject: { kind: 'company' | 'person'; id: string }) => as(reviewer, (trx) => verification.evaluate(trx, w.hubId, subject, recipe.id));

    // Unscreened: everything else passes, hand-over stays blocked and no badge is shown.
    const fresh = { kind: 'company' as const, id: await company(admin, 'Synthetic Quiet Masonry') };
    await cmd(reviewer, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, fresh, recipe.id, registerProv.id, 'pass', null));
    const unscreened = await cmd(reviewer, (trx, ctx) => verification.recordScreening(trx, ctx, w.hubId, fresh, recipe.id));
    assert.equal(unscreened.result, 'inconclusive');
    assert.deepEqual(await standing(fresh), { status: 'pending', missing: ['sanctions_screening'], failed: [], handoverBlocked: true, badgeCategories: [], expiresAt: (await standing(fresh)).expiresAt });

    // Clear: screened through SANC-003, the check records a reference to the state and passes.
    await screen(worker, fresh);
    const clear = await cmd(reviewer, (trx, ctx) => verification.recordScreening(trx, ctx, w.hubId, fresh, recipe.id));
    assert.equal(clear.result, 'pass');
    assert.ok(clear.screening_state_id, 'a reference to the SANC-003 state, nothing more');
    const ok = await standing(fresh);
    assert.deepEqual([ok.status, ok.handoverBlocked, ok.badgeCategories], ['passed', false, ['register_record_matches', 'sanctions_screening_clear']]);

    // Possible match: a company named like a synthetic listed entity stays inconclusive (never "fail"), hand-over blocked.
    const flagged = { kind: 'company' as const, id: await company(admin, 'Northwind Synthetic Supply LLC') };
    await screen(worker, flagged);
    await cmd(reviewer, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, flagged, recipe.id, registerProv.id, 'pass', null));
    const matched = await cmd(reviewer, (trx, ctx) => verification.recordScreening(trx, ctx, w.hubId, flagged, recipe.id));
    assert.notEqual(matched.result, 'fail');
    assert.equal((await standing(flagged)).handoverBlocked, true);

    // Unavailable store: the baseline lists go stale; the clear subject is blocked again although its checks passed.
    await owner((trx) => sql`UPDATE trustwork.screening_list SET last_checked_at = now() - interval '30 days' WHERE baseline`.execute(trx));
    const unavailable = await standing(fresh);
    assert.equal(unavailable.handoverBlocked, true, 'an unavailable screening store blocks every hand-over level');
    const recorded = await cmd(reviewer, (trx, ctx) => verification.recordScreening(trx, ctx, w.hubId, fresh, recipe.id));
    assert.equal(recorded.result, 'unavailable');
    await rejects(owner((trx) => sql`INSERT INTO trustwork.verification_check (hub_id, subject_company_id, recipe_id, check_type, mode, result, recorded_by, expires_at)
      VALUES (${w.hubId}::uuid, ${fresh.id}::uuid, ${recipe.id}::uuid, 'sanctions_screening', 'screening', 'fail', ${reviewer}::uuid, now() + interval '1 day')`.execute(trx)), '23514');
  });

  await t.test('evaluation is staff-only: no claims permission or another hub finds nothing', async () => {
    const recipe = await activeRecipe({ key: 'evaluation-scope' });
    const subject = { kind: 'company' as const, id: await company(admin, 'Synthetic Evaluation Works') };
    await rejects(as(p.outsider, (trx) => verification.evaluate(trx, w.hubId, subject, recipe.id)), 'P0002', 'admin.not_found');
    await rejects(as(p.otherAgent, (trx) => verification.evaluate(trx, w.hubId, subject, recipe.id)), 'P0002', 'admin.not_found');
  });
});
