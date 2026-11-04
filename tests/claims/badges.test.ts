import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { runClaimsExpiry } from '../../apps/worker/src/verification/claims-expiry.js';
import { silentLogger } from '../../apps/worker/src/log.js';
import { command, expectRefusal } from '../admin/helpers.js';
import { workerLogin } from '../assistant/helpers.js';
import { Client, SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { screen } from '../screening-gates/helpers.js';
import { claimsWorld, ok, type Claim } from './helpers.js';

const h = await startHarness('claims_badges');
const DAY = 86_400_000;
type Badge = Record<string, unknown> & { level: string; categories: string[]; decidedAt: string; validUntil: string };
type Verification = { id: string; state: string; level: string; companyId: string; renewedFrom: string | null; validUntil: string; revocationReasonCode: string | null };

/**
 * CLM-001 per-hub badges on real PostgreSQL: a hand-over writes what the hub stands behind; the public badge shows
 * categories and dates and nothing about screening; a verification lapses on the worker role and the status follows;
 * a re-check needs a reviewer and a passing standing; revocation reaches every projection; a page without an
 * administrator falls back to claimed and a new verified claim restores it. Every person and company is synthetic.
 */
test('CLM-001 verification badges', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const world = await claimsWorld(h);
  const workers = await workerLogin(h);
  const worker: DataPool = workers.pool(2);
  t.after(async () => { await workers.close(); await world.w.close(); await h.close(); });
  const { w, otherHubId, reviewer, second, recipes, provider, page, claimant, submit, decide, decideOnly, statusOf, roleOf, notices } = world;
  const base = world.console;
  const admin = h.db.admin;
  const anonymous = new Client(w.app);
  const badges = async (companyId: string) => ok<{ items: Badge[] }>(await anonymous.get(`/v1/companies/${companyId}/badges`)).items;
  const verifications = async (companyId: string) => ok<{ items: Verification[] }>(await reviewer.get(`${base}/claims/verifications?companyId=${companyId}`)).items;
  const directoryStatus = async (companyId: string) => ok<{ items: Array<{ id: string; claimStatus: string }> }>(await anonymous.get('/v1/companies?limit=100')).items.find((c) => c.id === companyId)?.claimStatus;
  const verifiedPage = async (name: string, email: string) => {
    const companyId = await page(name);
    const person = await claimant(`${name} Administrator`, email);
    ok(await decide(reviewer, ok<{ claim: Claim }>(await submit(person.client, companyId, 'verified')).claim));
    return { companyId, person };
  };
  const recheck = (client: Client, id: string, recipeId = recipes.verified) => command(client, `${base}/claims/verifications/${id}/recheck`, { recipeId });

  await t.test('a hand-over writes the verification; the public badge shows categories and dates, never screening or a document', async () => {
    const { companyId } = await verifiedPage('Synthetic Badge Builders', 'admin@badge.synthetic.invalid');
    const [row] = await verifications(companyId);
    assert.deepEqual([row?.state, row?.level], ['active', 'verified']);
    const [badge] = await badges(companyId);
    assert.ok(badge);
    assert.deepEqual(Object.keys(badge).sort(), ['categories', 'decidedAt', 'level', 'validUntil']);
    assert.deepEqual(badge.categories, ['register_record_matches'], 'the recipe also names sanctions_screening_clear, which never reaches the public');
    assert.ok(!JSON.stringify(badge).match(/sanction|screen|evidence|document|register:/));
    assert.ok(Date.parse(badge.validUntil) > Date.now() + 300 * DAY, 'valid while the results of the recipe are');
    assert.deepEqual(await badges(await page('Synthetic Unclaimed Builders')), [], 'a page nobody claimed has no badge');
  });

  await t.test('a verification is a record: the runtime role writes nothing and not even maintenance rewrites it', async () => {
    const { companyId } = await verifiedPage('Synthetic Frozen Builders', 'admin@frozen.synthetic.invalid');
    const [row] = await verifications(companyId);
    await assert.rejects(withMaintenance(admin, (trx) => trx.updateTable('company_verification').set({ valid_until: new Date(Date.now() + 900 * DAY) }).where('id', '=', row!.id).execute()),
      (e: { hint?: string }) => e.hint === 'claims.verification_frozen');
    await assert.rejects(w.actors.as(w.people.hubOwner, (trx) => trx.updateTable('company_verification').set({ state: 'revoked' }).where('id', '=', row!.id).execute()), (e: { code?: string }) => e.code === '42501');
    assert.deepEqual(await w.actors.as(w.people.outsider, (trx) => trx.selectFrom('company_verification').select('id').where('company_id', '=', companyId).execute()), [], 'staff of the hub read the table; others use the public badges');
  });

  await t.test('a verification lapses on the worker role; the badge goes, the status follows, the role stays; a re-check restores it (clock)', async () => {
    const { companyId, person } = await verifiedPage('Synthetic Lapsing Builders', 'admin@lapsing.synthetic.invalid');
    const [row] = await verifications(companyId);
    const notYet = await runClaimsExpiry({ pool: worker, log: silentLogger, now: () => new Date(Date.parse(row!.validUntil) - DAY) });
    assert.equal((await verifications(companyId))[0]?.state, 'active', `nothing lapses before its date (${notYet.expired})`);

    const lapsed = await runClaimsExpiry({ pool: worker, log: silentLogger, now: () => new Date(Date.parse(row!.validUntil) + DAY) });
    assert.ok(lapsed.expired >= 1);
    assert.equal((await verifications(companyId))[0]?.state, 'expired');
    assert.deepEqual(await badges(companyId), []);
    assert.deepEqual([await statusOf(companyId), await roleOf(person.id, companyId)], ['claimed', 'administrator'], 'still held, no longer verified');
    assert.ok((await notices(person.client)).some((n) => n.params.outcome === 'expired'));
    assert.equal((await runClaimsExpiry({ pool: worker, log: silentLogger, now: () => new Date(Date.parse(row!.validUntil) + DAY) })).expired, 0, 'repeating changes nothing');

    assert.equal((await recheck(w.clients.moderator, row!.id)).status, 404, 'staff without a claims permission find nothing');
    assert.equal((await command(w.clients.ops, `/v1/admin/hubs/${otherHubId}/claims/verifications/${row!.id}/recheck`, { recipeId: recipes.verified })).status, 404);
    assert.equal((await recheck(w.clients.employee, row!.id)).status, 403);
    const renewed = ok<{ verification: Verification }>(await recheck(reviewer, row!.id)).verification;
    assert.deepEqual([renewed.state, renewed.renewedFrom], ['active', row!.id]);
    assert.equal(await statusOf(companyId), 'verified');
    assert.equal((await badges(companyId)).length, 1);
    expectRefusal(await recheck(reviewer, row!.id), 409, 'validation.revision_conflict', 'invalid_transition');
  });

  await t.test('a re-check needs a passing standing: a failed result changes nothing and the old date runs out', async () => {
    const { companyId } = await verifiedPage('Synthetic Failing Builders', 'admin@failing.synthetic.invalid');
    const [row] = await verifications(companyId);
    ok(await command(reviewer, `${base}/verification/checks`, { subject: { kind: 'company', id: companyId }, recipeId: recipes.verified, providerId: provider, result: 'fail', evidenceRef: 'register:SYN-CLAIM-2' }));
    expectRefusal(await recheck(reviewer, row!.id), 422, 'validation.schema', 'standing_not_passed');
    expectRefusal(await recheck(reviewer, row!.id, recipes.claimed), 422, 'validation.schema', 'recipe_mismatch');
    assert.deepEqual((await verifications(companyId)).map((v) => v.state), ['active']);
  });

  await t.test('a re-check makes the person checks of a decision: nobody renews their own badge, and a held or suspended holder keeps none', async () => {
    const companyId = await page('Synthetic Own Recheck Builders');
    const own = ok<{ claim: Claim }>(await submit(second, companyId, 'verified')).claim;
    await withMaintenance(admin, async (trx) => {
      await trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: w.people.lead2, ended_reason: 'Synthetic: clears the way for the test' }).where('person_id', '=', w.people.lead2).where('status', '=', 'active').execute();
    });
    await screen(admin, { kind: 'person', id: w.people.lead2 });
    ok(await decide(reviewer, own));
    const [mine] = await verifications(companyId);
    expectRefusal(await recheck(second, mine!.id), 403, 'access.forbidden', 'own_claim');
    const asHolder = ok<{ items: Array<Record<string, unknown>> }>(await second.get(`${base}/claims/verifications?companyId=${companyId}`)).items[0];
    assert.ok(asHolder && !('decidedBy' in asHolder), 'a holder who is also staff does not read who decided');
    assert.ok('decidedBy' in (ok<{ items: Array<Record<string, unknown>> }>(await reviewer.get(`${base}/claims/verifications?companyId=${companyId}`)).items[0] as object));
    const [handover] = ok<{ items: Array<{ id: string }> }>(await reviewer.get(`${base}/claims/handovers?companyId=${companyId}`)).items;
    ok(await command(reviewer, `${base}/claims/handovers/${handover!.id}/revoke`, { revocationReason: 'Synthetic: ends the fixture hand-over.' }));

    for (const [key, state, label] of [['suspended', { suspended: true, money_held: true }, 'a suspended holder'], ['held', { money_held: true }, 'a held holder']] as const) {
      const held = await verifiedPage(`Synthetic ${key} Builders`, `admin@${key}.synthetic.invalid`);
      const [row] = await verifications(held.companyId);
      await withMaintenance(admin, (trx) => trx.updateTable('screening_subject_state').set(state as never).where('subject_person_id', '=', held.person.id).execute());
      expectRefusal(await recheck(reviewer, row!.id), 422, 'validation.schema', 'claimant_not_clear');
      assert.deepEqual((await verifications(held.companyId)).map((v) => v.state), ['active'], label);
    }
  });

  await t.test('revocation reaches every projection: the record, the badge, the directory, the role and the outbox', async () => {
    const { companyId, person } = await verifiedPage('Synthetic Revoked Badge Builders', 'admin@revokedbadge.synthetic.invalid');
    assert.equal(await directoryStatus(companyId), 'verified');
    const [handover] = ok<{ items: Array<{ id: string }> }>(await reviewer.get(`${base}/claims/handovers?companyId=${companyId}`)).items;
    ok(await command(reviewer, `${base}/claims/handovers/${handover!.id}/revoke`, { revocationReason: 'Signatory authority withdrawn by the company.' }));
    const [row] = await verifications(companyId);
    assert.deepEqual([row?.state, row?.revocationReasonCode], ['revoked', 'handover_revoked']);
    assert.deepEqual(await badges(companyId), []);
    assert.equal(await directoryStatus(companyId), 'unclaimed');
    assert.equal(await roleOf(person.id, companyId), null);
    const { rows } = await admin.query<{ s: string }>("SELECT payload ->> 'claimStatus' AS s FROM trustwork.outbox_event WHERE type = 'company.verification_changed' AND aggregate_id = $1 ORDER BY id", [companyId]);
    assert.deepEqual(rows.map((r) => r.s), ['verified', 'unclaimed']);
    expectRefusal(await recheck(reviewer, row!.id), 409, 'validation.revision_conflict', 'invalid_transition');
  });

  await t.test('a page without an administrator falls back to claimed; a new verified claim restores it; other companies are untouched', async () => {
    const { companyId, person } = await verifiedPage('Synthetic Recovery Builders', 'admin@recovery.synthetic.invalid');
    await withMaintenance(admin, (trx) => trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: person.id, ended_reason: 'Synthetic: left the company' })
      .where('person_id', '=', person.id).where('company_id', '=', companyId).execute());
    assert.equal(await statusOf(companyId), 'claimed');
    assert.deepEqual((await verifications(companyId)).map((v) => [v.level, v.state]), [['verified', 'active']], 'the record stands');
    assert.deepEqual(await badges(companyId), [], 'the badge never says more than the status');

    const successor = await claimant('Synthetic Recovery Successor', 'successor@recovery.synthetic.invalid');
    const waiting = ok<{ claim: Claim }>(await submit(successor.client, companyId, 'verified')).claim;
    assert.equal(waiting.state, 'waiting', 'the previous hand-over still stands, so the waiting period applies');
    await withMaintenance(admin, (trx) => trx.updateTable('company_claim').set({ waiting_until: new Date(Date.now() - 60_000) }).where('id', '=', waiting.id).execute());
    // The earlier holder's results prove nothing for the successor: the claim needs its own.
    expectRefusal(await decideOnly(reviewer, waiting), 422, 'validation.schema', 'evidence_required');
    ok(await decide(reviewer, waiting));
    assert.deepEqual([await statusOf(companyId), await roleOf(successor.id, companyId)], ['verified', 'administrator']);
    assert.deepEqual((await badges(companyId)).map((b) => b.level), ['verified']);

    const unrelated = await withMaintenance(admin, async (trx) => {
      const id = (await trx.insertInto('company').values({ display_name: 'Synthetic Never Claimed Builders', claim_status: 'claimed' }).returning('id').executeTakeFirstOrThrow()).id;
      const membership = await trx.insertInto('membership').values({ person_id: w.people.candidate, company_id: id, role: 'administrator', permissions: ['company.members.manage'], status: 'active', valid_from: new Date() }).returning('id').executeTakeFirstOrThrow();
      await trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: w.people.candidate, ended_reason: 'Synthetic: left the company' }).where('id', '=', membership.id).execute();
      return id;
    });
    assert.equal(await statusOf(unrelated), 'claimed', 'a company that never went through a claim keeps its status');
  });

  await t.test('staff list what lapses soon', async () => {
    const soon = ok<{ items: Verification[] }>(await reviewer.get(`${base}/claims/verifications?dueDays=366`)).items;
    assert.ok(soon.length > 0 && soon.every((v) => v.state === 'active'));
    assert.deepEqual(ok<{ items: Verification[] }>(await reviewer.get(`${base}/claims/verifications?dueDays=0`)).items, []);
    assert.deepEqual(ok<{ items: Verification[] }>(await w.clients.moderator.get(`${base}/claims/verifications`)).items, []);
  });
});
