import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { verification, verificationWorker } from '../../packages/data/src/repositories/verification.js';
import { runRechecks } from '../../apps/worker/src/verification/recheck.js';
import { silentLogger } from '../../apps/worker/src/log.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects } from '../data/admin/helpers.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { company, screeningWorld } from '../screening/helpers.js';

const env = await provisionWorkerDatabase('verification_rechecks');

/**
 * HUB-003 part 4 on real PostgreSQL: the worker re-checks results that expire soon. A fake adapter repeats its answer
 * with no person as author; a manual result waits for a reviewer and appears in the hub's re-check list; a superseded
 * result is skipped; only adapter modes may lack an author; the runtime role cannot call the worker functions and
 * people without a claims permission find no re-check list. Every name is synthetic.
 */
test('HUB-003 scheduled re-checks on PostgreSQL', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const worker = env.workerPool(4);
  const world = await screeningWorld(admin, env.apiPool, worker);
  const { w, as, elevate, assign, owner } = world;
  const p = w.people;
  await withMaintenance(admin, async (trx) => {
    await staffRoleDefinitions.release(trx, { version: 1, role: 'data-steward', scopes: ['hub'], permissions: ['admin.claims.read', 'admin.claims.policy.edit'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await staffRoleDefinitions.release(trx, { version: 1, role: 'trust-reviewer', scopes: ['hub'], permissions: ['admin.claims.read', 'admin.claims.decide'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
  });
  const hub = { kind: 'hub', hubId: w.hubId } as const;
  await assign({ personId: p.hubOwner, role: 'data-steward', scope: hub });
  await assign({ personId: p.agent, role: 'trust-reviewer', scope: hub });
  const cmd = async <T>(person: string, fn: (trx: Parameters<Parameters<typeof as>[1]>[0], ctx: Awaited<ReturnType<typeof elevate>>) => Promise<T>): Promise<T> => {
    const ctx = await elevate(person);
    return as(person, (trx) => fn(trx, ctx));
  };
  const drafted = await cmd(p.hubOwner, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, {
    key: 'monthly', subjectKind: 'company', trigger: 'seller_onboarding', recheckMonths: 1, badgeCategories: ['register_record_matches'],
    steps: [{ check: 'register_match', required: true }, { check: 'tax_status', required: false }, { check: 'sanctions_screening', required: true }],
  }));
  const recipe = await cmd(p.hubOwner, (trx, ctx) => verification.activateRecipe(trx, ctx, drafted.id, drafted.revision));
  const fake = await cmd(p.hubOwner, (trx, ctx) => verification.registerProvider(trx, ctx, w.hubId, { checkType: 'register_match', adapter: 'synthetic_fake_register', mode: 'fake',
    retentionDays: 365, legalBasis: 'statutory_public_register', costMinor: null }));
  const manual = await cmd(p.hubOwner, (trx, ctx) => verification.registerProvider(trx, ctx, w.hubId, { checkType: 'tax_status', adapter: 'synthetic_manual_tax', mode: 'manual',
    retentionDays: 365, legalBasis: 'statutory_public_register', costMinor: null }));
  const subject = { kind: 'company' as const, id: await company(admin, 'Synthetic Recheck Builders') };
  const fakeResult = await cmd(p.agent, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, subject, recipe.id, fake.id, 'pass', null));
  const manualResult = await cmd(p.agent, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, subject, recipe.id, manual.id, 'pass', 'tax:SYN-1'));

  await t.test('the hub\'s re-check list is staff-only', async () => {
    const due = await as(p.agent, (trx) => verification.hubDue(trx, w.hubId, 40));
    assert.deepEqual(due.map((d) => [d.check_type, d.provider_mode]).sort(), [['register_match', 'fake'], ['tax_status', 'manual']]);
    await rejects(as(p.outsider, (trx) => verification.hubDue(trx, w.hubId, 40)), 'P0002', 'admin.not_found');
  });

  await t.test('the worker re-checks fake results without a person and leaves manual ones to a reviewer', async () => {
    const counts = await runRechecks({ pool: worker, log: silentLogger, withinDays: 40 });
    assert.equal(counts.rechecked, 1);
    assert.equal(counts.awaitingReviewer, 1);
    const checks = await as(p.agent, (trx) => verification.checksOf(trx, w.hubId, subject));
    const repeated = checks.find((c) => c.check_type === 'register_match' && c.id !== fakeResult.id);
    assert.ok(repeated);
    assert.deepEqual([repeated.mode, repeated.result, repeated.recorded_by, repeated.evidence_ref], ['fake', 'pass', null, 'fake:register_match:recheck']);
    assert.ok(checks.some((c) => c.id === manualResult.id), 'the manual result stays as it was');
  });

  await t.test('a superseded result is skipped; a manual result is never re-checked by the worker; only adapters lack an author', async () => {
    await rejects(tx(worker, (trx) => verificationWorker.recordAdapterResult(trx, fakeResult.id, 'pass', 'fake:again')), '40001', 'verification.superseded');
    await rejects(tx(worker, (trx) => verificationWorker.recordAdapterResult(trx, manualResult.id, 'pass', 'fake:no')), '23514', 'verification.not_an_adapter');
    await rejects(owner((trx) => sql`INSERT INTO trustwork.verification_check (hub_id, subject_company_id, recipe_id, check_type, provider_id, mode, result, evidence_ref, recorded_by, expires_at)
      VALUES (${w.hubId}::uuid, ${subject.id}::uuid, ${recipe.id}::uuid, 'tax_status', ${manual.id}::uuid, 'manual', 'pass', 'tax:x', NULL, now() + interval '1 day')`.execute(trx)), '23514');
  });

  await t.test('the runtime role cannot call the worker functions', async () => {
    await assert.rejects(tx(env.apiPool, (trx) => verificationWorker.dueAll(trx, 7, 10)), /permission denied/);
    await assert.rejects(tx(env.apiPool, (trx) => verificationWorker.recordAdapterResult(trx, fakeResult.id, 'pass', null)), /permission denied/);
  });
});
