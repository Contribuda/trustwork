import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { verification } from '../../packages/data/src/repositories/verification.js';
import { claims } from '../../packages/data/src/repositories/claims.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects, settle } from '../data/admin/helpers.js';
import { provisionWorkerDatabase } from '../worker/helpers/worker-db.js';
import { company, person, screen, screeningWorld } from '../screening/helpers.js';

const env = await provisionWorkerDatabase('claims_db');

/** A synthetic person with a verified e-mail and a session, screened clear unless told otherwise. */
async function claimant(admin: DataPool, worker: DataPool, name: string, email: string, screened = true): Promise<string> {
  const p = await person(admin, name);
  await withMaintenance(admin, (trx) => trx.insertInto('email_binding').values({ person_id: p.id, email_normalized: email, is_primary: true, verified_at: new Date() }).execute());
  if (screened) await screen(worker, { kind: 'person', id: p.id });
  return p.id;
}

/**
 * CLM-001 first slice on real PostgreSQL: management access passes only through the hub's recipe. One open claim per
 * page; a second claim opens a dispute that two different reviewers decide, and nothing is handed over meanwhile
 * (including under concurrency); a claim against a managed page aims at the verified level and waits; the decider is
 * never the claimant; a hand-over needs the recipe standing and the claimant's screening; claimed gives no company
 * role, verified gives the administrator role; the claim status is derived in the same transaction and revocation
 * undoes it; an invitation link counts only on the company's own non-free domain, and a link alone changes nothing;
 * sensitive changes are refused during the cooling period (clock). Every person, company and address is synthetic.
 */
test('CLM-001 claims on PostgreSQL', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const worker = env.workerPool(4);
  const world = await screeningWorld(admin, env.apiPool, worker);
  const { w, as, elevate, assign, owner } = world;
  const p = w.people;
  await withMaintenance(admin, async (trx) => {
    await staffRoleDefinitions.release(trx, { version: 1, role: 'trust-reviewer', scopes: ['hub'],
      permissions: ['admin.claims.read', 'admin.claims.decide', 'admin.claims.policy.edit', 'admin.claims.revoke'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
  });
  const hub = { kind: 'hub', hubId: w.hubId } as const;
  await assign({ personId: p.hubOwner, role: 'trust-reviewer', scope: hub });
  await assign({ personId: p.lead2, role: 'trust-reviewer', scope: hub });
  const reviewer = p.hubOwner;
  const second = p.lead2;
  const cmd = async <T>(person_: string, fn: (trx: Parameters<Parameters<typeof as>[1]>[0], ctx: Awaited<ReturnType<typeof elevate>>) => Promise<T>): Promise<T> => {
    const ctx = await elevate(person_);
    return as(person_, (trx) => fn(trx, ctx));
  };

  // Recipes for both levels and a fake register provider; a page passes once its register match and screening pass.
  const recipeFor = async (key: string, trigger: 'claim_claimed' | 'claim_verified') => {
    const drafted = await cmd(reviewer, (trx, ctx) => verification.draftRecipe(trx, ctx, w.hubId, { key, subjectKind: 'company', trigger, recheckMonths: 12,
      badgeCategories: ['register_record_matches'], steps: [{ check: 'register_match', required: true }, { check: 'sanctions_screening', required: true }] }));
    return cmd(reviewer, (trx, ctx) => verification.activateRecipe(trx, ctx, drafted.id, drafted.revision));
  };
  const claimedRecipe = await recipeFor('claim-claimed', 'claim_claimed');
  const verifiedRecipe = await recipeFor('claim-verified', 'claim_verified');
  const provider = await cmd(reviewer, (trx, ctx) => verification.registerProvider(trx, ctx, w.hubId, { checkType: 'register_match', adapter: 'synthetic_claims_register', mode: 'fake',
    retentionDays: 365, legalBasis: 'statutory_public_register', costMinor: null }));
  const page = async (name: string, domain: string | null = null) => {
    const id = await company(admin, name);
    await owner((trx) => trx.updateTable('company').set({ claim_status: 'unclaimed', verified_domains: domain ? [domain] : [] }).where('id', '=', id).execute());
    await screen(worker, { kind: 'company', id });
    for (const recipe of [claimedRecipe, verifiedRecipe]) {
      await cmd(reviewer, (trx, ctx) => verification.recordCheck(trx, ctx, w.hubId, { kind: 'company', id }, recipe.id, provider.id, 'pass', null));
      await cmd(reviewer, (trx, ctx) => verification.recordScreening(trx, ctx, w.hubId, { kind: 'company', id }, recipe.id));
    }
    return id;
  };
  const status = async (id: string) => (await owner((trx) => trx.selectFrom('company').select('claim_status').where('id', '=', id).executeTakeFirstOrThrow())).claim_status;
  const roleOf = async (personId: string, companyId: string) =>
    (await owner((trx) => trx.selectFrom('membership').select(['role', 'status']).where('person_id', '=', personId).where('company_id', '=', companyId).where('status', '=', 'active').executeTakeFirst()))?.role ?? null;

  await t.test('an invitation link counts only on the company\'s own non-free domain; a link alone changes nothing', async () => {
    const companyId = await page('Synthetic Link Builders', 'linkbuilders.synthetic.invalid');
    const free = await claimant(admin, worker, 'Synthetic Free Mail Claimant', 'free.claimant@gmail.com');
    const freeClaim = await as(free, (trx) => claims.submit(trx, w.hubId, companyId, 'claimed', claimedRecipe.id, { kind: 'invitation_link', email: 'office@gmail.com' }));
    assert.deepEqual([freeClaim.domain_tie, freeClaim.state], [null, 'open'], 'a free mail address proves nothing');
    await as(free, (trx) => claims.withdraw(trx, freeClaim.id));
    const other = await claimant(admin, worker, 'Synthetic Other Domain Claimant', 'other@elsewhere.synthetic.invalid');
    const otherClaim = await as(other, (trx) => claims.submit(trx, w.hubId, companyId, 'claimed', claimedRecipe.id, { kind: 'invitation_link', email: 'office@elsewhere.synthetic.invalid' }));
    assert.equal(otherClaim.domain_tie, null, 'a domain not recorded for the company proves nothing');
    await as(other, (trx) => claims.withdraw(trx, otherClaim.id));
    const own = await claimant(admin, worker, 'Synthetic Own Domain Claimant', 'office@linkbuilders.synthetic.invalid');
    const ownClaim = await as(own, (trx) => claims.submit(trx, w.hubId, companyId, 'claimed', claimedRecipe.id, { kind: 'invitation_link', email: 'Office@LinkBuilders.synthetic.invalid' }));
    assert.deepEqual([ownClaim.domain_tie, ownClaim.domain_tie_domain, ownClaim.state], ['invitation_link', 'linkbuilders.synthetic.invalid', 'open']);
    // Nothing was handed over by submitting with a link: no status change, no role.
    assert.deepEqual([await status(companyId), await roleOf(own, companyId)], ['unclaimed', null]);
    await rejects(as(own, (trx) => claims.submit(trx, w.hubId, companyId, 'claimed', claimedRecipe.id, null)), '23505', 'claims.already_claiming');
    // The claimed level: a reviewer approves; limited control, no company role.
    await rejects(cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, ownClaim.id, ownClaim.revision + 1, 'approved', false, null)), '40001', 'claims.revision_conflict');
    const approved = await cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, ownClaim.id, ownClaim.revision, 'approved', false, null));
    assert.equal(approved.state, 'approved');
    assert.deepEqual([await status(companyId), await roleOf(own, companyId)], ['claimed', null]);
  });

  await t.test('the claimed level needs a company tie; the decider is never the claimant; the claimant must be screened', async () => {
    const companyId = await page('Synthetic Tie Builders');
    const noTie = await claimant(admin, worker, 'Synthetic No Tie Claimant', 'notie@notie.synthetic.invalid');
    const claim = await as(noTie, (trx) => claims.submit(trx, w.hubId, companyId, 'claimed', claimedRecipe.id, null));
    await rejects(cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, claim.id, claim.revision, 'approved', false, null)), '23514', 'claims.company_tie_required');
    const viaOfficer = await cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, claim.id, claim.revision, 'approved', true, 'Officer name matches the register'));
    assert.equal(viaOfficer.domain_tie, 'register_officer_match');
    const companyB = await page('Synthetic Self Builders');
    await withMaintenance(admin, (trx) => trx.insertInto('email_binding').values({ person_id: reviewer, email_normalized: 'reviewer@self.synthetic.invalid', is_primary: false, verified_at: new Date() }).execute());
    const own = await as(reviewer, (trx) => claims.submit(trx, w.hubId, companyB, 'claimed', claimedRecipe.id, null));
    await rejects(cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, own.id, own.revision, 'approved', true, null)), '42501', 'claims.own_claim');
    await as(reviewer, (trx) => claims.withdraw(trx, own.id));
    const unscreened = await claimant(admin, worker, 'Synthetic Unscreened Claimant', 'unscreened@self.synthetic.invalid', false);
    const pending = await as(unscreened, (trx) => claims.submit(trx, w.hubId, companyB, 'claimed', claimedRecipe.id, null));
    await rejects(cmd(second, (trx, ctx) => claims.decide(trx, ctx, pending.id, pending.revision, 'approved', true, null)), '23514', 'claims.claimant_not_clear');
    await rejects(cmd(p.outsider, (trx, ctx) => claims.decide(trx, ctx, pending.id, pending.revision, 'approved', true, null)), '42501', 'admin.forbidden');
    const noLogin = (await person(admin, 'Synthetic No Login Claimant')).id;
    await rejects(as(noLogin, (trx) => claims.submit(trx, w.hubId, companyB, 'claimed', claimedRecipe.id, null)), '42501', 'claims.verified_login_required');
  });

  await t.test('two concurrent claims on one page produce one dispute and no hand-over; two reviewers decide it', async () => {
    const companyId = await page('Synthetic Contested Builders', 'contested.synthetic.invalid');
    const first = await claimant(admin, worker, 'Synthetic First Claimant', 'first@contested.synthetic.invalid');
    const secondClaimant = await claimant(admin, worker, 'Synthetic Second Claimant', 'second@contested.synthetic.invalid');
    const results = await Promise.all([first, secondClaimant].map((who) => settle(as(who, (trx) => claims.submit(trx, w.hubId, companyId, 'verified', verifiedRecipe.id, null)))));
    assert.deepEqual(results, [null, null], 'both claims are accepted for review');
    const onPage = await owner((trx) => trx.selectFrom('company_claim').selectAll().where('company_id', '=', companyId).execute());
    assert.deepEqual(onPage.map((c) => c.state).sort(), ['disputed', 'disputed']);
    const disputes = await owner((trx) => trx.selectFrom('claim_dispute').selectAll().where('company_id', '=', companyId).execute());
    assert.equal(disputes.length, 1);
    assert.equal(new Set(onPage.map((c) => c.dispute_id)).size, 1);
    assert.deepEqual([await status(companyId), (await owner((trx) => trx.selectFrom('company_handover').select('id').where('company_id', '=', companyId).execute())).length], ['unclaimed', 0]);
    const third = await claimant(admin, worker, 'Synthetic Third Claimant', 'third@contested.synthetic.invalid');
    await rejects(as(third, (trx) => claims.submit(trx, w.hubId, companyId, 'verified', verifiedRecipe.id, null)), '23514', 'claims.dispute_open');
    for (const c of onPage) await rejects(cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, c.id, c.revision, 'approved', false, null)), '23514', 'claims.invalid_transition');
    const winner = onPage.find((c) => c.claimant_id === first)!;
    const dispute = disputes[0]!;
    const proposed = await cmd(reviewer, (trx, ctx) => claims.proposeDispute(trx, ctx, dispute.id, dispute.revision, winner.id, 'The first claimant showed the signatory evidence.'));
    await rejects(cmd(reviewer, (trx, ctx) => claims.confirmDispute(trx, ctx, dispute.id, proposed.revision)), '42501', 'claims.second_person_required');
    const decided = await cmd(second, (trx, ctx) => claims.confirmDispute(trx, ctx, dispute.id, proposed.revision));
    assert.deepEqual([decided.state, decided.proposed_by, decided.confirmed_by], ['decided', reviewer, second]);
    const after = await owner((trx) => trx.selectFrom('company_claim').selectAll().where('company_id', '=', companyId).orderBy('created_at').execute());
    assert.deepEqual(after.map((c) => [c.claimant_id === first, c.state]).sort(), [[false, 'rejected'], [true, 'open']]);
    assert.equal(await status(companyId), 'unclaimed', 'the dispute itself hands nothing over');
    // The winner is then decided as any claim: the verified level gives the administrator role.
    const open = after.find((c) => c.state === 'open')!;
    await cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, open.id, open.revision, 'approved', false, null));
    assert.deepEqual([await status(companyId), await roleOf(first, companyId)], ['verified', 'administrator']);
  });

  await t.test('a managed page is claimed again only at the verified level, after the waiting period', async () => {
    const companyId = await page('Synthetic Managed Builders', 'managed.synthetic.invalid');
    const holder = await claimant(admin, worker, 'Synthetic Holder', 'holder@managed.synthetic.invalid');
    const held = await as(holder, (trx) => claims.submit(trx, w.hubId, companyId, 'claimed', claimedRecipe.id, { kind: 'invitation_link', email: 'holder@managed.synthetic.invalid' }));
    await cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, held.id, held.revision, 'approved', false, null));
    const challenger = await claimant(admin, worker, 'Synthetic Challenger', 'challenger@managed.synthetic.invalid');
    await rejects(as(challenger, (trx) => claims.submit(trx, w.hubId, companyId, 'claimed', claimedRecipe.id, null)), '23514', 'claims.verified_level_required');
    const waiting = await as(challenger, (trx) => claims.submit(trx, w.hubId, companyId, 'verified', verifiedRecipe.id, null));
    assert.equal(waiting.state, 'waiting');
    const days = Math.round((waiting.waiting_until!.getTime() - Date.now()) / 86_400_000);
    assert.equal(days, 7);
    await rejects(cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, waiting.id, waiting.revision, 'approved', false, null)), '23514', 'claims.waiting_period');
    // Clock: the period passes.
    await owner((trx) => sql`UPDATE trustwork.company_claim SET waiting_until = now() - interval '1 minute' WHERE id = ${waiting.id}::uuid`.execute(trx));
    const later = await cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, waiting.id, waiting.revision, 'approved', false, null));
    assert.equal(later.state, 'approved');
    assert.equal(await status(companyId), 'verified');
  });

  await t.test('sensitive changes are refused during the cooling period; revocation undoes the hand-over (clock)', async () => {
    const companyId = await page('Synthetic Cooling Builders', 'cooling.synthetic.invalid');
    const admin_ = await claimant(admin, worker, 'Synthetic New Administrator', 'admin@cooling.synthetic.invalid');
    const claim = await as(admin_, (trx) => claims.submit(trx, w.hubId, companyId, 'verified', verifiedRecipe.id, null));
    await cmd(reviewer, (trx, ctx) => claims.decide(trx, ctx, claim.id, claim.revision, 'approved', false, null));
    const [handover] = await as(admin_, (trx) => claims.handovers(trx, companyId));
    assert.ok(handover && handover.membership_id);
    await rejects(owner((trx) => trx.updateTable('company').set({ display_name: 'Synthetic Renamed Builders' }).where('id', '=', companyId).execute()), '23514', 'claims.cooling_period');
    await rejects(owner((trx) => trx.updateTable('company').set({ verified_domains: ['other.synthetic.invalid'] }).where('id', '=', companyId).execute()), '23514', 'claims.cooling_period');
    await owner((trx) => trx.updateTable('company').set({ public_description: 'Synthetic description, not sensitive.' }).where('id', '=', companyId).execute());
    // Clock: the cooling period ends; the rename goes through.
    await owner((trx) => sql`UPDATE trustwork.company_handover SET cooling_until = now() - interval '1 minute', created_at = now() - interval '8 days' WHERE id = ${handover.id}::uuid`.execute(trx));
    await owner((trx) => trx.updateTable('company').set({ display_name: 'Synthetic Renamed Builders' }).where('id', '=', companyId).execute());
    await rejects(cmd(p.outsider, (trx, ctx) => claims.revoke(trx, ctx, handover.id, 'Synthetic revocation reason')), '42501', 'admin.forbidden');
    await cmd(second, (trx, ctx) => claims.revoke(trx, ctx, handover.id, 'Signatory authority withdrawn by the company.'));
    assert.deepEqual([await status(companyId), await roleOf(admin_, companyId)], ['unclaimed', null]);
  });

  await t.test('only staff of the hub and the claimant read claims; the runtime role writes nothing directly', async () => {
    assert.ok((await as(p.hubOwner, (trx) => claims.list(trx, w.hubId))).length > 0);
    assert.deepEqual(await as(p.outsider, (trx) => claims.list(trx, w.hubId)), []);
    await rejects(as(p.hubOwner, (trx) => sql`UPDATE trustwork.company SET claim_status = 'verified' WHERE id = ${w.company}::uuid`.execute(trx)), '42501');
    await rejects(as(p.hubOwner, (trx) => sql`INSERT INTO trustwork.company_claim (hub_id) VALUES (${w.hubId}::uuid)`.execute(trx)), '42501');
  });
});
