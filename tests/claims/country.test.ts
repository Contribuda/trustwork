import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { hubs } from '../../packages/data/src/repositories/kernel.js';
import { screen } from '../screening-gates/helpers.js';
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
  const correct = (client: Client, hub: string, companyId: string, fromCountry: string | null, country: string, region: string | null = null, fromRegion: string | null = null): Promise<Response> =>
    command(client, `/v1/admin/hubs/${hub}/claims/companies/${companyId}/country`, { fromCountry, fromRegion, country, region });
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

  await t.test('a hub covers a company when any of its territories lies inside the company\'s country: a city hub reviews its whole country', async () => {
    await withMaintenance(admin, (trx) => hubs.addTerritory(trx, { hubId: otherHubId, level: 'region', code: 'MX-GUA' }));
    const companyId = await page('Synthetic Far Side Builders', null, 'MX');
    const person = await claimant('Synthetic Far Side Claimant', 'claimant@farside.synthetic.invalid');
    const claim = ok<{ claim: Claim }>(await submitElsewhere(person.client, companyId)).claim;
    const decided = ok<{ claim: Claim }>(await command(otherReviewer, `${otherBase}/claims/requests/${claim.id}/decide`, { expectedRevision: claim.revision, decision: 'rejected', officerMatch: false, note: null })).claim;
    assert.equal(decided.state, 'rejected', 'the hub holds one region of the country, and the company has no place finer than the country');
    // A territory of another country still covers nothing here.
    expectRefusal(await submit(person.client, companyId, 'verified'), 422, 'validation.schema', 'company_outside_hub');
  });

  await t.test('the founding role unsticks a company with no country, and hands nothing over', async () => {
    // Exactly what the setup wizard releases: on a new node this is the only role that exists.
    const founding = (await admin.query<{ v: string[] }>('SELECT trustwork.setup_founding_permissions() AS v')).rows[0]!.v;
    await withMaintenance(admin, (trx) => staffRoleDefinitions.release(trx, { version: 2, role: 'node-operator', scopes: ['node'], permissions: founding as never,
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));
    await w.actors.assignSensitive({ personId: w.people.admin2, role: 'node-operator', scope: { kind: 'node', nodeId: w.world.nodeId }, definitionVersion: 2 });
    const operator = w.clients.admin2;
    const companyId = await page('Synthetic Founding Case Builders', null, null);
    const person = await claimant('Synthetic Founding Case Claimant', 'founding@founding.synthetic.invalid');
    const claim = ok<{ claim: Claim }>(await submit(person.client, companyId, 'verified')).claim;

    expectRefusal(await correct(w.clients.moderator, hubId, companyId, null, 'US'), 403, 'access.forbidden');
    ok(await correct(operator, hubId, companyId, null, 'US'));
    assert.equal(await countryOf(companyId), 'US');
    assert.deepEqual((await audits('company.country_corrected', companyId)).map((row) => [row.outcome, row.hub_id]), [['denied', hubId], ['applied', hubId]], 'the moderator\'s refusal, then the correction');

    expectRefusal(await decideOnly(operator, claim), 404, 'access.not_found');
    assert.deepEqual([await statusOf(companyId), await handovers(companyId)], ['unclaimed', 0]);
    ok(await decide(reviewer, { ...claim, companyId, recipeId: recipes.verified }));
    assert.equal(await statusOf(companyId), 'verified');
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
    const move = { fromCountry: 'US', fromRegion: null, country: 'CA', region: null };
    // Deciding claims is not enough; neither is staff without any claims permission, an unelevated person or the company.
    expectRefusal(await correct(reviewer, hubId, companyId, 'US', 'CA'), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await correct(w.clients.moderator, hubId, companyId, 'US', 'CA'), 403, 'access.forbidden', 'forbidden');
    assert.equal((await command(w.clients.customer, url, move)).status, 403);
    // The other hub covers neither country, and a hub never reaches past its own territories by naming a third one.
    expectRefusal(await correct(otherReviewer, otherHubId, companyId, 'US', 'GB'), 403, 'access.forbidden', 'outside_territory');
    expectRefusal(await correct(steward, hubId, companyId, 'CA', 'GB'), 409, 'validation.revision_conflict', 'country_changed');
    expectRefusal(await correct(steward, hubId, companyId, 'US', 'US'), 422, 'validation.schema', 'country_unchanged');
    for (const country of ['RU', 'KP', 'IR', 'CU']) expectRefusal(await correct(steward, hubId, companyId, 'US', country), 422, 'validation.schema', 'country_refused');
    // A country the restricted list splits needs its region, and a restricted region is refused.
    expectRefusal(await correct(steward, hubId, companyId, 'US', 'UA'), 422, 'validation.schema', 'region_required');
    for (const region of ['UA-43', 'UA-40', 'UA-14', 'UA-09']) expectRefusal(await correct(steward, hubId, companyId, 'US', 'UA', region), 422, 'validation.schema', 'region_refused');
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

  await t.test('the corrector takes no decision of any kind on that company', async () => {
    // `second` holds both roles (the case above). Rejecting a rival is a decision too.
    const companyId = await page('Synthetic Every Decision Builders', null, 'CA');
    ok(await correct(second, hubId, companyId, 'CA', 'US'));
    const first = await claimant('Synthetic Every Decision One', 'one@every.synthetic.invalid');
    const rival = await claimant('Synthetic Every Decision Two', 'two@every.synthetic.invalid');
    const own = 'own_country_correction';
    const single = ok<{ claim: Claim }>(await submit(first.client, companyId, 'verified')).claim;
    expectRefusal(await decideOnly(second, single, 'rejected'), 403, 'access.forbidden', own);
    ok(await submit(rival.client, companyId, 'verified'));
    const listed = ok<{ claims: Claim[]; disputes: Array<{ id: string; companyId: string; revision: number }> }>(await reviewer.get(`${base}/claims?state=disputed`));
    const dispute = listed.disputes.find((d) => d.companyId === companyId)!;
    const url = `${base}/claims/disputes/${dispute.id}`;
    expectRefusal(await command(second, `${url}/propose`, { expectedRevision: dispute.revision, winnerClaimId: single.id, note: 'Synthetic note.' }), 403, 'access.forbidden', own);
    const proposed = ok<{ dispute: { revision: number } }>(await command(reviewer, `${url}/propose`, { expectedRevision: dispute.revision, winnerClaimId: single.id, note: 'Synthetic note.' })).dispute;
    expectRefusal(await command(second, `${url}/confirm`, { expectedRevision: proposed.revision }), 403, 'access.forbidden', own);
    assert.equal(await handovers(companyId), 0);
  });

  await t.test('a claimant, a member or a conflicted staff member does not correct the company, in either order', async () => {
    const steward = w.clients.lead;
    const claimed = await page('Synthetic Own Claim Builders', null, null);
    await screen(admin, { kind: 'person', id: w.people.lead });
    const filed = ok<{ claim: Claim }>(await submit(steward, claimed, 'verified')).claim;
    expectRefusal(await correct(steward, hubId, claimed, null, 'US'), 403, 'access.forbidden');
    assert.equal(await countryOf(claimed), null);
    ok(await steward.post(`/v1/claims/${filed.id}/withdraw`, {}));
    expectRefusal(await correct(steward, hubId, claimed, null, 'US'), 403, 'access.forbidden');
    ok(await correct(second, hubId, claimed, null, 'US'));

    const member = await page('Synthetic Own Employer Builders', null, null);
    await withMaintenance(admin, (trx) => trx.insertInto('membership').values({ person_id: w.people.lead, company_id: member, role: 'member', status: 'active', valid_from: new Date() }).execute());
    expectRefusal(await correct(steward, hubId, member, null, 'US'), 403, 'access.forbidden');

    const declared = await page('Synthetic Declared Conflict Builders', null, null);
    await admin.query("INSERT INTO trustwork.staff_conflict_declaration (staff_person_id, conflict_company_id, reason) VALUES ($1, $2, 'Synthetic declared conflict')", [w.people.lead, declared]);
    expectRefusal(await correct(steward, hubId, declared, null, 'US'), 403, 'access.forbidden');
    assert.equal(await countryOf(declared), null);

    // The other order: the corrector does not file a claim afterwards.
    const moved = await page('Synthetic Moved Then Claimed Builders', null, null);
    ok(await correct(steward, hubId, moved, null, 'US'));
    expectRefusal(await submit(steward, moved, 'verified'), 403, 'access.forbidden', 'own_country_correction');
  });
});
