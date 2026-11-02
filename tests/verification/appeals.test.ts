import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { verification } from '../../packages/data/src/repositories/verification.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects } from '../data/admin/helpers.js';
import { provisionWorkerDatabase } from '../worker/helpers/worker-db.js';
import { company, screeningWorld } from '../screening/helpers.js';

const env = await provisionWorkerDatabase('verification_appeals');

/**
 * HUB-003 part 3 on real PostgreSQL: the subject appeals an adverse result (a person about themselves, an active
 * company administrator about the company); anyone else finds nothing; sanctions results and passing results are not
 * appealable here; one open appeal per result; the original reviewer and the filer never decide; overturning needs
 * evidence and records a new passing result while the original stays; a decision is final. Every name is synthetic.
 */
test('HUB-003 verification appeals on PostgreSQL', { skip: env ? false : SKIP_REASON }, async (t) => {
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
  await assign({ personId: p.lead2, role: 'trust-reviewer', scope: hub });
  const cmd = async <T>(person: string, fn: (trx: Parameters<Parameters<typeof as>[1]>[0], ctx: Awaited<ReturnType<typeof elevate>>) => Promise<T>): Promise<T> => {
    const ctx = await elevate(person);
    return as(person, (trx) => fn(trx, ctx));
  };
  const reviewer = p.agent;
  const secondReviewer = p.lead; // a node-scope compliance officer with claims decide
  const subjectAdmin = p.employee;

  const drafted = await cmd(p.hubOwner, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, {
    key: 'appeal-claim', subjectKind: 'company', trigger: 'claim_verified', recheckMonths: 12, badgeCategories: ['register_record_matches', 'sanctions_screening_clear'],
    steps: [{ check: 'register_match', required: true }, { check: 'sanctions_screening', required: true }],
  }));
  const recipe = await cmd(p.hubOwner, (trx, ctx) => verification.activateRecipe(trx, ctx, drafted.id, drafted.revision));
  const provider = await cmd(p.hubOwner, (trx, ctx) => verification.registerProvider(trx, ctx, w.hubId, { checkType: 'register_match', adapter: 'synthetic_appeal_register', mode: 'manual',
    retentionDays: 365, legalBasis: 'statutory_public_register', costMinor: null }));
  // The world's company: the employee is its active administrator.
  const subject = { kind: 'company' as const, id: w.company };
  const failed = await cmd(reviewer, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, subject, recipe.id, provider.id, 'fail', 'register:SYN-404'));
  const passed = await cmd(reviewer, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, subject, recipe.id, provider.id, 'pass', 'register:SYN-200'));
  const sanctions = await cmd(reviewer, (trx, ctx) => verification.recordScreening(trx, ctx, w.hubId, subject, recipe.id));

  await t.test('only the subject files; sanctions and passing results are not appealable here; one open appeal per result', async () => {
    for (const who of [p.outsider, p.customer, reviewer]) await rejects(as(who, (trx) => verification.fileAppeal(trx, failed.id, 'Not us')), 'P0002', 'admin.not_found');
    await rejects(as(subjectAdmin, (trx) => verification.fileAppeal(trx, sanctions.id, 'Not a match')), '23514', 'verification.sanctions_appeal_in_screening');
    await rejects(as(subjectAdmin, (trx) => verification.fileAppeal(trx, passed.id, 'Why')), '23514', 'verification.not_adverse');
    const appeal = await as(subjectAdmin, (trx) => verification.fileAppeal(trx, failed.id, 'The register record moved to a new number SYN-405.'));
    assert.equal(appeal.status, 'open');
    await rejects(as(subjectAdmin, (trx) => verification.fileAppeal(trx, failed.id, 'Again')), '23505', 'verification.appeal_open');
    assert.equal((await as(subjectAdmin, (trx) => verification.ownAppeals(trx, subjectAdmin))).length, 1, 'the filer reads their own appeal');
    assert.deepEqual(await as(p.outsider, (trx) => verification.appeals(trx, w.hubId)), [], 'nobody else reads it');
    assert.equal((await as(secondReviewer, (trx) => verification.appeals(trx, w.hubId))).length, 1, 'staff of the hub read it');
  });

  await t.test('the original reviewer and people without claims decide never decide; overturning needs evidence; the decision is final', async () => {
    const [appeal] = await as(secondReviewer, (trx) => verification.appeals(trx, w.hubId));
    assert.ok(appeal);
    await rejects(cmd(reviewer, (trx, ctx) => verification.decideAppeal(trx, ctx, appeal.id, appeal.revision, 'overturned', 'Looks fine', 'register:SYN-405')), '42501', 'verification.original_reviewer');
    await rejects(cmd(p.hubOwner, (trx, ctx) => verification.decideAppeal(trx, ctx, appeal.id, appeal.revision, 'upheld', 'No', null)), '42501', 'admin.forbidden');
    await rejects(cmd(secondReviewer, (trx, ctx) => verification.decideAppeal(trx, ctx, appeal.id, appeal.revision, 'overturned', 'Looks fine', null)), '23514', 'verification.evidence_required');
    const decided = await cmd(secondReviewer, (trx, ctx) => verification.decideAppeal(trx, ctx, appeal.id, appeal.revision, 'overturned', 'The new register number matches.', 'register:SYN-405'));
    assert.equal(decided.status, 'overturned');
    assert.ok(decided.new_check_id);
    const checks = await as(secondReviewer, (trx) => verification.checksOf(trx, w.hubId, subject));
    assert.ok(checks.some((c) => c.id === failed.id && c.result === 'fail'), 'the original result stays');
    assert.ok(checks.some((c) => c.id === decided.new_check_id && c.result === 'pass' && c.recorded_by === secondReviewer && c.evidence_ref === 'register:SYN-405'));
    await rejects(cmd(secondReviewer, (trx, ctx) => verification.decideAppeal(trx, ctx, appeal.id, decided.revision, 'upheld', 'Changed my mind', null)), '23514', 'verification.invalid_transition');
    await rejects(owner((trx) => sql`UPDATE trustwork.verification_appeal SET status = 'upheld' WHERE id = ${appeal.id}::uuid`.execute(trx)), '42501', 'verification.immutable');
    const audit = await admin.query("SELECT actor_person_id FROM trustwork.admin_audit_event WHERE action = 'verification.appeal_overturned' AND object_id = $1", [appeal.id]);
    assert.deepEqual(audit.rows, [{ actor_person_id: secondReviewer }]);
  });

  await t.test('the filer never decides their own appeal, even as staff', async () => {
    // A trust reviewer who administers a company whose result someone else recorded may appeal it, never decide it.
    const owner2 = p.lead2;
    const otherCompany = await company(admin, 'Synthetic Reviewer Owned Works', [owner2]);
    const s2 = { kind: 'company' as const, id: otherCompany };
    const adverse = await cmd(secondReviewer, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, s2, recipe.id, provider.id, 'fail', 'register:SYN-500'));
    const own = await as(owner2, (trx) => verification.fileAppeal(trx, adverse.id, 'Our own record is current.'));
    await rejects(cmd(owner2, (trx, ctx) => verification.decideAppeal(trx, ctx, own.id, own.revision, 'overturned', 'Mine', 'register:SYN-501')), '42501', 'verification.own_appeal');
  });
});
