import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { command, expectRefusal } from '../admin/helpers.js';
import { SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { claimsWorld, ok, type Claim } from './helpers.js';

const h = await startHarness('claims_country');

/**
 * Issue #592 through the HTTP API on real PostgreSQL: claim review stays inside a hub's territories. The hub covers the
 * United States; the other hub covers Canada, with its own reviewer and data steward. A reviewer of another hub reaches
 * nothing on a company of this hub's country, a company with no country is refused to everyone, and only an audited
 * correction by the holder of the right permission, at a hub covering the old or the new country, moves a company.
 * The races are in tests/claims/database.test.ts. Every person, company and address is synthetic.
 */
test('Claim review stays inside a hub\'s territories', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const world = await claimsWorld(h);
  t.after(async () => { await world.w.close(); await h.close(); });
  const { w, hubId, otherHubId, reviewer, second, recipes, provider, page, claimant, submit, decide, decideOnly, statusOf, roleOf } = world;
  const base = world.console;
  const otherBase = `/v1/admin/hubs/${otherHubId}`;
  const admin = h.db.admin;
  const steward = w.clients.lead;
  const otherReviewer = w.clients.ops;

  // The other hub offers a verified claim of its own: a foreign reviewer's claims reach the database this way.
  const otherRecipe = await (async () => {
    const drafted = ok<{ recipe: { id: string; revision: number } }>(await command(otherReviewer, `${otherBase}/verification/recipes`, { key: 'other-claim-verified', subjectKind: 'company', trigger: 'claim_verified', recheckMonths: 12,
      badgeCategories: ['register_record_matches'], steps: [{ check: 'register_match', required: true }, { check: 'sanctions_screening', required: true }] }));
    ok(await command(otherReviewer, `${otherBase}/verification/recipes/${drafted.recipe.id}/activate`, { expectedRevision: drafted.recipe.revision }));
    return drafted.recipe.id;
  })();
  const submitElsewhere = (client: Client, companyId: string): Promise<Response> => client.post('/v1/claims', { hubId: otherHubId, companyId, level: 'verified', recipeId: otherRecipe, tie: null });
  const correct = (client: Client, hub: string, companyId: string, fromCountry: string | null, country: string): Promise<Response> =>
    command(client, `/v1/admin/hubs/${hub}/claims/companies/${companyId}/country`, { fromCountry, country });
  const countryOf = async (companyId: string) => (await withMaintenance(admin, (trx) => trx.selectFrom('company').select('country_code').where('id', '=', companyId).executeTakeFirstOrThrow())).country_code;
  const audits = async (action: string, objectId: string) => (await admin.query<{ outcome: string; reason_code: string; hub_id: string; before_digest: string | null; after_digest: string | null }>(
    'SELECT outcome, reason_code, hub_id, before_digest, after_digest FROM trustwork.admin_audit_event WHERE action = $1 AND object_id = $2 ORDER BY sequence', [action, objectId])).rows;
  const handovers = async (companyId: string) => (await withMaintenance(admin, (trx) => trx.selectFrom('company_handover').select('id').where('company_id', '=', companyId).execute())).length;

  await t.test('a company of this hub\'s country is claimed here and never at another hub', async () => {
    const companyId = await page('Synthetic Local Builders');
    const person = await claimant('Synthetic Local Claimant', 'local@local.synthetic.invalid');
    expectRefusal(await submitElsewhere(person.client, companyId), 422, 'validation.schema', 'company_outside_hub');
    assert.equal(await withMaintenance(admin, async (trx) => (await trx.selectFrom('company_claim').select('id').where('company_id', '=', companyId).execute()).length), 0);
    const claim = ok<{ claim: Claim }>(await submit(person.client, companyId, 'verified')).claim;
    ok(await decide(reviewer, { ...claim, companyId, recipeId: recipes.verified }));
    assert.deepEqual([await statusOf(companyId), await roleOf(person.id, companyId)], ['verified', 'administrator']);
  });

  await t.test('a company with no country is refused to every reviewer, whichever way they decide, until a correction', async () => {
    const companyId = await page('Synthetic Legacy Builders', null, null);
    const person = await claimant('Synthetic Legacy Claimant', 'legacy@legacy.synthetic.invalid');
    const claim = ok<{ claim: Claim }>(await submit(person.client, companyId, 'verified')).claim;
    expectRefusal(await decide(reviewer, { ...claim, companyId, recipeId: recipes.verified }), 403, 'access.forbidden', 'company_country_missing');
    expectRefusal(await decideOnly(second, claim, 'rejected'), 403, 'access.forbidden', 'company_country_missing');
    assert.ok((await audits('claims.approved', claim.id)).some((row) => row.outcome === 'denied'), 'the refusal leaves a denied audit row');
    assert.deepEqual([await statusOf(companyId), await handovers(companyId)], ['unclaimed', 0]);

    // The staff read shows what the reviewer has to restate; the claimant's own read does not carry it.
    assert.equal(ok<{ claim: { companyCountry: string | null } }>(await second.get(`${base}/claims/requests/${claim.id}`)).claim.companyCountry, null);
    assert.ok(!('companyCountry' in ok<{ claims: Array<Record<string, unknown>> }>(await person.client.get('/v1/claims')).claims[0]!));
    ok(await correct(steward, hubId, companyId, null, 'US'));
    assert.equal(ok<{ claim: { companyCountry: string | null } }>(await second.get(`${base}/claims/requests/${claim.id}`)).claim.companyCountry, 'US');
    ok(await decide(reviewer, { ...claim, companyId, recipeId: recipes.verified }));
    assert.deepEqual([await statusOf(companyId), await roleOf(person.id, companyId)], ['verified', 'administrator']);
  });

  await t.test('a reviewer of another hub decides nothing on a company outside its territories, and the refusal is audited', async () => {
    const companyId = await page('Synthetic Elsewhere Builders', null, null);
    const person = await claimant('Synthetic Elsewhere Claimant', 'elsewhere@elsewhere.synthetic.invalid');
    const claim = ok<{ claim: Claim }>(await submitElsewhere(person.client, companyId)).claim;
    ok(await correct(steward, hubId, companyId, null, 'US'));
    const decision = { expectedRevision: claim.revision, officerMatch: false, note: null };
    const url = `${otherBase}/claims/requests/${claim.id}/decide`;
    expectRefusal(await command(otherReviewer, url, { ...decision, decision: 'approved' }), 403, 'access.forbidden', 'outside_territory');
    expectRefusal(await command(otherReviewer, url, { ...decision, decision: 'rejected' }), 403, 'access.forbidden', 'outside_territory');
    assert.ok((await audits('claims.approved', claim.id)).some((row) => row.outcome === 'denied' && row.reason_code === 'denied_outside_territory'));
    // This hub's reviewers do not reach through either: the claim is the other hub's.
    assert.equal((await decideOnly(reviewer, claim)).status, 404);
    assert.deepEqual([await statusOf(companyId), await handovers(companyId), await roleOf(person.id, companyId)], ['unclaimed', 0, null]);
    // The claimant can still step back.
    ok(await person.client.post(`/v1/claims/${claim.id}/withdraw`, {}));
  });

  await t.test('a dispute parked at another hub is neither proposed nor confirmed there', async () => {
    const companyId = await page('Synthetic Parked Builders', null, null);
    const one = await claimant('Synthetic Parked One', 'one@parked.synthetic.invalid');
    const two = await claimant('Synthetic Parked Two', 'two@parked.synthetic.invalid');
    ok(await submitElsewhere(one.client, companyId));
    ok(await submitElsewhere(two.client, companyId));
    ok(await correct(steward, hubId, companyId, null, 'US'));
    const dispute = await withMaintenance(admin, (trx) => trx.selectFrom('claim_dispute').select(['id', 'revision']).where('company_id', '=', companyId).executeTakeFirstOrThrow());
    expectRefusal(await command(otherReviewer, `${otherBase}/claims/disputes/${dispute.id}/propose`, { expectedRevision: dispute.revision, winnerClaimId: null, note: 'Synthetic note long enough to pass.' }), 403, 'access.forbidden', 'outside_territory');
    expectRefusal(await command(otherReviewer, `${otherBase}/claims/disputes/${dispute.id}/confirm`, { expectedRevision: dispute.revision }), 403, 'access.forbidden', 'outside_territory');
  });

  await t.test('a company that moved away is not re-checked, verified or read through a claim here; a support case still reaches it', async () => {
    const companyId = await page('Synthetic Departed Builders');
    const person = await claimant('Synthetic Departed Holder', 'holder@departed.synthetic.invalid');
    const claim = ok<{ claim: Claim }>(await submit(person.client, companyId, 'verified')).claim;
    ok(await decide(reviewer, { ...claim, companyId, recipeId: recipes.verified }));
    // Clock: the cooling period of the hand-over is over, so records can change again.
    await withMaintenance(admin, (trx) => trx.updateTable('company_handover').set({ cooling_until: new Date(Date.now() - 60_000), created_at: new Date(Date.now() - 8 * 86_400_000) }).where('company_id', '=', companyId).execute());
    const verification = ok<{ items: Array<{ id: string }> }>(await reviewer.get(`${base}/claims/verifications?companyId=${companyId}`)).items[0]!;
    const challenger = await claimant('Synthetic Departed Challenger', 'challenger@departed.synthetic.invalid');
    ok(await submit(challenger.client, companyId, 'verified'));
    const sourced = { record: { kind: 'identifier', identifierKind: 'US-CA-SOS', jurisdiction: 'US-CA', value: 'C7654321' }, sourceRef: 'register:SYN-DEPARTED' };
    const identifier = ok<{ record: { id: string } }>(await command(reviewer, `${base}/claims/companies/${companyId}/records`, sourced)).record.id;
    assert.equal((await reviewer.get(`${base}/claims/companies/${companyId}/records`)).status, 200);
    const check = ok<{ check: { id: string } }>(await command(reviewer, `${base}/verification/checks`, { subject: { kind: 'company', id: companyId }, recipeId: recipes.verified, providerId: provider, result: 'pass', evidenceRef: 'register:SYN-DEPARTED' })).check.id;

    ok(await correct(steward, hubId, companyId, 'US', 'CA'));
    expectRefusal(await command(reviewer, `${base}/claims/verifications/${verification.id}/recheck`, { recipeId: recipes.verified }), 403, 'access.forbidden', 'outside_territory');
    expectRefusal(await command(reviewer, `${base}/claims/identifiers/${identifier}/verify`, { expectedRevision: 1, checkId: check }), 403, 'access.forbidden', 'outside_territory');
    assert.equal((await reviewer.get(`${base}/claims/companies/${companyId}/records`)).status, 404);
    assert.equal((await command(reviewer, `${base}/claims/companies/${companyId}/records`, { ...sourced, record: { ...sourced.record, value: 'C7654322' } })).status, 404);

    // What needs a case keeps needing only the case: it is a reason of its own.
    await withMaintenance(admin, (trx) => trx.insertInto('support_case').values({ hub_id: hubId, requester_person_id: person.id, opened_by: person.id, subject_company_id: companyId, category: 'account_access', summary: 'Synthetic: a question about our page' } as never).execute());
    assert.equal((await reviewer.get(`${base}/claims/companies/${companyId}/records`)).status, 200);
    ok(await command(reviewer, `${base}/claims/companies/${companyId}/records`, { ...sourced, record: { ...sourced.record, value: 'C7654323' } }));

    // The hub that gave the hand-over can always undo it.
    const handover = ok<{ items: Array<{ id: string }> }>(await reviewer.get(`${base}/claims/handovers?companyId=${companyId}`)).items[0]!;
    ok(await command(reviewer, `${base}/claims/handovers/${handover.id}/revoke`, { revocationReason: 'Synthetic: the company moved to another hub.' }));
  });

  await t.test('a correction needs the permission, a hub covering the old or the new country, and the country the reviewer saw', async () => {
    const companyId = await page('Synthetic Corrected Builders');
    const url = `${base}/claims/companies/${companyId}/country`;
    const move = { fromCountry: 'US', country: 'CA' };
    // Deciding claims is not enough; neither is staff without any claims permission, an unelevated person or the company.
    expectRefusal(await correct(reviewer, hubId, companyId, 'US', 'CA'), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await correct(w.clients.moderator, hubId, companyId, 'US', 'CA'), 403, 'access.forbidden', 'forbidden');
    assert.equal((await command(w.clients.customer, url, move)).status, 403);
    // The other hub covers neither country, and a hub never reaches past its own territories by naming a third one.
    expectRefusal(await correct(otherReviewer, otherHubId, companyId, 'US', 'GB'), 403, 'access.forbidden', 'outside_territory');
    expectRefusal(await correct(steward, hubId, companyId, 'CA', 'GB'), 409, 'validation.revision_conflict', 'country_changed');
    expectRefusal(await correct(steward, hubId, companyId, 'US', 'US'), 422, 'validation.schema', 'country_unchanged');
    for (const country of ['RU', 'KP', 'IR', 'CU']) expectRefusal(await correct(steward, hubId, companyId, 'US', country), 422, 'validation.schema', 'country_refused');
    assert.equal((await correct(steward, hubId, '00000000-0000-4000-8000-00000000dead', 'US', 'CA')).status, 404);
    assert.equal(await countryOf(companyId), 'US');

    const done = ok<{ correction: { fromCountry: string; country: string; correctedBy: string } }>(await correct(steward, hubId, companyId, 'US', 'GB')).correction;
    assert.deepEqual([done.fromCountry, done.country, done.correctedBy], ['US', 'GB', w.people.lead]);
    assert.ok((await audits('company.country_corrected', companyId)).some((row) => row.outcome === 'applied' && row.hub_id === hubId && row.before_digest && row.after_digest));
    // The hub of the new country alone may bring a company in.
    ok(await correct(otherReviewer, otherHubId, companyId, 'GB', 'CA'));
    assert.equal(await countryOf(companyId), 'CA');
  });

  await t.test('whoever corrected a company\'s country does not approve a claim on it; another reviewer does', async () => {
    await w.actors.assign({ personId: w.people.lead2, role: 'data-steward', scope: { kind: 'hub', hubId } });
    const companyId = await page('Synthetic Self Moved Builders', null, 'CA');
    const person = await claimant('Synthetic Self Moved Claimant', 'claimant@selfmoved.synthetic.invalid');
    ok(await correct(second, hubId, companyId, 'CA', 'US'));
    const claim = ok<{ claim: Claim }>(await submit(person.client, companyId, 'verified')).claim;
    expectRefusal(await decide(second, { ...claim, companyId, recipeId: recipes.verified }), 403, 'access.forbidden', 'own_country_correction');
    assert.equal(await handovers(companyId), 0);
    ok(await decideOnly(reviewer, claim));
    assert.deepEqual([await statusOf(companyId), await roleOf(person.id, companyId)], ['verified', 'administrator']);
  });
});
