import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { IdentifierKinds } from '../../apps/api/src/modules/verification/claims/identifier-kinds.js';
import { command, expectRefusal } from '../admin/helpers.js';
import { Client, SKIP_REASON, startHarness, type Response } from '../backend/helpers/app.js';
import { claimsWorld, ok, type Claim } from './helpers.js';

const h = await startHarness('claims_records');
type Identifier = { id: string; kind: string; value: string; status: string; revision: number };
type Records = { identifiers: Identifier[]; registrations: Array<Record<string, unknown>>; branches: Array<Record<string, unknown>>; profile: Record<string, unknown> | null; taxRegistrations?: Array<Record<string, unknown>> };

test('what may be public follows the pack and fails closed', () => {
  const kinds = new IdentifierKinds();
  for (const kind of ['MX-RFCPF', 'US-EIN', 'US-CA-CSLB', 'US-AZ-ROC', 'US-UEI', 'GB-VAT', 'CA-GSTHST', 'other', 'US-XX-SOS']) assert.ok(kinds.isPrivate(kind), kind);
  for (const kind of ['US-CA-SOS', 'GB-CRN', 'UZ-STIR', 'MX-RFC']) assert.ok(!kinds.isPrivate(kind), kind);
  assert.ok(new IdentifierKinds(null).isPrivate('US-CA-SOS'), 'without the pack files everything is private');
  assert.ok(kinds.accepts('MX-RFCPF', 'GODE561231GR8'));
});

test('identifier kinds come from the country packs; a country without a pack uses other', () => {
  const kinds = new IdentifierKinds();
  assert.ok(kinds.accepts('US-EIN', '12-3456789'));
  assert.ok(!kinds.accepts('US-EIN', '00-3456789'), 'not a valid prefix');
  assert.ok(kinds.accepts('US-CA-SOS', 'C1234567'), 'a kind of a region of the pack');
  assert.ok(!kinds.accepts('US-XX-SOS', 'C1234567'), 'a kind the pack does not declare');
  assert.ok(kinds.accepts('other', 'free form 123'));
  assert.ok(new IdentifierKinds(null).accepts('US-EIN', 'anything'), 'without the pack files the format is not checked');
});

/**
 * CLM-001 company records on real PostgreSQL, with the United States as the worked example (EIN, Secretary of State
 * registrations, a state contractor licence, all synthetic). A value proves nothing and never moves a badge; an
 * administrator states records and a holder edits descriptive fields; tax registrations stay private; the cooling period
 * holds through the API for identifiers, the website and the representative (clock).
 */
test('CLM-001 company records', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const world = await claimsWorld(h);
  t.after(async () => { await world.w.close(); await h.close(); });
  const { w, hubId, otherHubId, reviewer, recipes, provider, page, claimant, submit, decide, statusOf, roleOf } = world;
  const sos = (value: string) => ({ kind: 'identifier', identifierKind: 'US-CA-SOS', jurisdiction: 'US-CA', value });
  const legalIdentifiers = async (companyId: string) => (await withMaintenance(h.db.admin, (trx) => trx.selectFrom('company').select('legal_identifiers').where('id', '=', companyId).executeTakeFirstOrThrow())).legal_identifiers;
  /** A claim in play, which is what lets staff of the hub read and source the company's records. */
  const openClaim = async (companyId: string, key: string) => {
    const person = await claimant(`Synthetic ${key} Claimant`, `claimant@${key}.synthetic.invalid`);
    return { person, claim: ok<{ claim: Claim }>(await submit(person.client, companyId, 'verified')).claim };
  };
  const base = world.console;
  const admin = h.db.admin;
  const anonymous = new Client(w.app);
  const add = (client: Client, companyId: string, record: Record<string, unknown>): Promise<Response> => client.post(`/v1/companies/${companyId}/records`, record);
  const ein = (value = '12-3456789') => ({ kind: 'identifier', identifierKind: 'US-EIN', jurisdiction: 'US', value });
  const records = async (client: Client, companyId: string) => ok<Records>(await client.get(`/v1/companies/${companyId}/records`));
  const publicRecords = async (companyId: string) => ok<Records>(await anonymous.get(`/v1/companies/${companyId}/public-records`));
  const profile = (over: Record<string, unknown> = {}) => ({ legalForm: 'US-LLC', websiteUrl: null, regionCode: 'US-CA', categories: ['general_contractor'], publicFields: ['legal_form', 'categories'], ...over });
  /** The cooling period has passed (clock). */
  const cooled = (companyId: string) => withMaintenance(admin, (trx) => trx.updateTable('company_handover').set({ cooling_until: new Date(Date.now() - 60_000), created_at: new Date(Date.now() - 8 * 86_400_000) }).where('company_id', '=', companyId).execute());
  const verifiedPage = async (name: string, email: string) => {
    const companyId = await page(name);
    const person = await claimant(`${name} Administrator`, email);
    ok(await decide(reviewer, ok<{ claim: Claim }>(await submit(person.client, companyId, 'verified')).claim));
    return { companyId, person };
  };
  /** A company a person founded: an administrator with no claim and no badge. */
  const foundedPage = async (name: string, email: string) => {
    const companyId = await page(name);
    const person = await claimant(`${name} Founder`, email);
    await withMaintenance(admin, (trx) => trx.insertInto('membership').values({ person_id: person.id, company_id: companyId, role: 'administrator', permissions: ['company.members.manage'], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute());
    return { companyId, person };
  };
  const passingCheck = async (companyId: string) => ok<{ check: { id: string } }>(await command(reviewer, `${base}/verification/checks`, { subject: { kind: 'company', id: companyId }, recipeId: recipes.verified, providerId: provider, result: 'pass',
    evidenceRef: 'register:SYN-RECORD-1' })).check.id;
  const verify = (client: Client, identifier: Pick<Identifier, 'id' | 'revision'>, checkId: string, hub = base) => command(client, `${hub}/claims/identifiers/${identifier.id}/verify`, { expectedRevision: identifier.revision, checkId });

  await t.test('the United States example: an EIN, state registrations, a tax registration, a branch and a contractor licence checked through the recipe', async () => {
    const { companyId, person } = await verifiedPage('Synthetic Golden State Builders', 'admin@goldenstate.synthetic.invalid');
    await cooled(companyId);
    ok(await add(person.client, companyId, ein()));
    const stateNumber = ok<{ record: { id: string } }>(await add(person.client, companyId, sos('C1234567'))).record;
    expectRefusal(await add(person.client, companyId, ein('00-1234567')), 422, 'validation.schema', 'identifier_invalid');
    expectRefusal(await add(person.client, companyId, { kind: 'identifier', identifierKind: 'US-XX-SOS', jurisdiction: 'US', value: 'C1' }), 422, 'validation.schema', 'identifier_invalid');
    ok(await add(person.client, companyId, { kind: 'registration', jurisdiction: 'US-DE', registrationKind: 'formation', registeredName: 'Synthetic Golden State Builders LLC', number: '7000001', status: 'active', observedAt: null }));
    ok(await add(person.client, companyId, { kind: 'registration', jurisdiction: 'US-CA', registrationKind: 'foreign_qualification', registeredName: 'Synthetic Golden State Builders LLC', number: null, status: 'unknown', observedAt: null }));
    ok(await add(person.client, companyId, { kind: 'tax_registration', jurisdiction: 'US-TX', taxKind: 'US-TX-SALES', number: 'SYN-TX-1', status: 'active', validUntil: null }));
    ok(await add(person.client, companyId, { kind: 'branch', hubId, name: 'Synthetic Sacramento Yard', address: { city: 'Sacramento' }, regionCode: 'US-CA', public: true }));
    ok(await add(person.client, companyId, { kind: 'branch', hubId, name: 'Synthetic Private Depot', address: {}, regionCode: 'US-CA', public: false }));
    ok(await person.client.post(`/v1/companies/${companyId}/page-profile`, profile({ websiteUrl: 'https://goldenstate.synthetic.invalid/', description: 'Synthetic general contractor, as stated by the company.' })));

    const own = await records(person.client, companyId);
    assert.deepEqual(own.identifiers.map((i) => [i.kind, i.status]), [['US-EIN', 'claimed'], ['US-CA-SOS', 'claimed']], 'stated, not verified');
    assert.deepEqual(own.registrations.map((r) => [r.jurisdiction, r.kind, r.status]), [['US-DE', 'formation', 'active'], ['US-CA', 'foreign_qualification', 'unknown']], 'unknown stays unknown');
    assert.equal(own.taxRegistrations?.length, 1);

    // Nothing self-stated reaches the old column. Once verified, a public kind does, three-part kinds included; the EIN never.
    const directory = async () => ok<{ items: Array<{ id: string; legalIdentifiers: Array<{ kind: string; status: string }>; publicDescription: string | null }> }>(await anonymous.get('/v1/companies?limit=100')).items.find((c) => c.id === companyId);
    assert.deepEqual((await directory())?.legalIdentifiers, []);
    assert.equal((await directory())?.publicDescription, 'Synthetic general contractor, as stated by the company.');
    ok(await verify(reviewer, { id: stateNumber.id, revision: 1 }, await passingCheck(companyId)));
    assert.deepEqual((await directory())?.legalIdentifiers.map((i) => [i.kind, i.status]), [['US-CA-SOS', 'verified']]);
    assert.deepEqual((await publicRecords(companyId)).identifiers.map((i) => i.kind), ['US-CA-SOS'], 'the EIN is not public');

    // The licence: a professional credential of REP-001, checked through a HUB-003 recipe; the badge names the category.
    await withMaintenance(admin, (trx) => trx.insertInto('professional_credential').values({ holder_company_id: companyId, kind: 'licence', jurisdiction: 'US-CA', credential_type: 'US-CA-CSLB', issuer: 'Synthetic Contractors Board',
      number: '8000001', recorded_by_person_id: person.id } as never).execute());
    const drafted = ok<{ recipe: { id: string; revision: number } }>(await command(reviewer, `${base}/verification/recipes`, { key: 'claim-verified-licensed', subjectKind: 'company', trigger: 'claim_verified', recheckMonths: 12,
      badgeCategories: ['register_record_matches', 'licence_valid_us_ca'], steps: [{ check: 'register_match', required: true }, { check: 'licence', required: true }, { check: 'sanctions_screening', required: true }] })).recipe;
    ok(await command(reviewer, `${base}/verification/recipes/${drafted.id}/activate`, { expectedRevision: drafted.revision }));
    const board = ok<{ provider: { id: string } }>(await command(reviewer, `${base}/verification/providers`, { checkType: 'licence', adapter: 'synthetic_ca_licence_board', mode: 'fake', retentionDays: 365, legalBasis: 'statutory_public_register', costMinor: null })).provider.id;
    const subject = { kind: 'company', id: companyId };
    ok(await command(reviewer, `${base}/verification/checks`, { subject, recipeId: drafted.id, providerId: provider, result: 'pass', evidenceRef: 'register:SYN-CA-SOS' }));
    ok(await command(reviewer, `${base}/verification/checks`, { subject, recipeId: drafted.id, providerId: board, result: 'pass', evidenceRef: 'licence:SYN-CSLB-8000001' }));
    ok(await command(reviewer, `${base}/verification/checks/screening`, { subject, recipeId: drafted.id }));
    const [row] = ok<{ items: Array<{ id: string }> }>(await reviewer.get(`${base}/claims/verifications?companyId=${companyId}`)).items;
    ok(await command(reviewer, `${base}/claims/verifications/${row!.id}/recheck`, { recipeId: drafted.id }));
    const [badge] = ok<{ items: Array<{ categories: string[] }> }>(await anonymous.get(`/v1/companies/${companyId}/badges`)).items;
    assert.deepEqual(badge?.categories, ['licence_valid_us_ca', 'register_record_matches']);
    assert.ok(!JSON.stringify(badge).includes('8000001'), 'a badge shows a category, not the licence');
  });

  await t.test('an identifier value never upgrades a badge, not even when a reviewer verifies it', async () => {
    const { companyId, person } = await foundedPage('Synthetic Numbers Builders', 'founder@numbers.synthetic.invalid');
    const stated = ok<{ record: { id: string } }>(await add(person.client, companyId, sos('C1111111'))).record;
    const check = await passingCheck(companyId);
    const verified = ok<{ identifier: Identifier }>(await verify(reviewer, { id: stated.id, revision: 1 }, check)).identifier;
    assert.equal(verified.status, 'verified');
    assert.equal(await statusOf(companyId), 'unclaimed');
    assert.deepEqual(ok<{ items: unknown[] }>(await anonymous.get(`/v1/companies/${companyId}/badges`)).items, []);
    for (const table of ['company_verification', 'company_handover']) assert.equal((await admin.query(`SELECT 1 FROM trustwork.${table} WHERE company_id = $1`, [companyId])).rowCount, 0, table);
    const { rows } = await admin.query<{ proname: string }>("SELECT proname FROM pg_proc WHERE pronamespace = 'trustwork'::regnamespace AND prosrc LIKE '%INSERT INTO trustwork.company_verification%' ORDER BY proname");
    assert.deepEqual(rows.map((r) => r.proname), ['claims_handover_verification', 'claims_recheck'], 'only a hand-over and a re-check write a verification');
    assert.equal(ok<Records>(await anonymous.get(`/v1/companies/${companyId}/public-records`)).identifiers[0]?.status, 'verified');
  });

  await t.test('a value is verified for one company, also when two reviewers race; several may state it', async () => {
    const first = await foundedPage('Synthetic Race One Builders', 'founder@raceone.synthetic.invalid');
    const second = await foundedPage('Synthetic Race Two Builders', 'founder@racetwo.synthetic.invalid');
    const a = ok<{ record: { id: string } }>(await add(first.person.client, first.companyId, ein('12-2222222'))).record;
    const b = ok<{ record: { id: string } }>(await add(second.person.client, second.companyId, ein('12-2222222'))).record;
    const [c1, c2] = [await passingCheck(first.companyId), await passingCheck(second.companyId)];
    const results = await Promise.all([verify(reviewer, { id: a.id, revision: 1 }, c1), verify(world.second, { id: b.id, revision: 1 }, c2)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)));
  });

  await t.test('verification needs a passing, current check of the same company at this hub, and a reviewer', async () => {
    const { companyId, person } = await foundedPage('Synthetic Checked Builders', 'founder@checked.synthetic.invalid');
    const other = await page('Synthetic Unrelated Builders');
    const stated = ok<{ record: { id: string } }>(await add(person.client, companyId, ein('12-3333333'))).record;
    const identifier = { id: stated.id, revision: 1 };
    expectRefusal(await verify(reviewer, identifier, await passingCheck(other)), 422, 'validation.schema', 'check_mismatch');
    const failing = ok<{ check: { id: string } }>(await command(reviewer, `${base}/verification/checks`, { subject: { kind: 'company', id: companyId }, recipeId: recipes.verified, providerId: provider, result: 'fail', evidenceRef: 'register:SYN-RECORD-2' })).check.id;
    expectRefusal(await verify(reviewer, identifier, failing), 422, 'validation.schema', 'check_mismatch');
    const check = await passingCheck(companyId);
    expectRefusal(await verify(reviewer, { ...identifier, revision: 9 }, check), 409, 'validation.revision_conflict', 'revision_conflict');
    expectRefusal(await verify(w.clients.moderator, identifier, check), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await verify(w.clients.ops, identifier, check, `/v1/admin/hubs/${otherHubId}`), 403, 'access.forbidden', 'outside_territory');
    assert.equal((await verify(w.clients.employee, identifier, check)).status, 403);
    assert.equal((await records(person.client, companyId)).identifiers[0]?.status, 'claimed');
  });

  await t.test('negative authorization: only an administrator states records; a holder edits descriptions only; strangers find nothing private', async () => {
    const companyId = await page('Synthetic Holder Records Builders', 'holderrecords.synthetic.invalid');
    const holder = await claimant('Synthetic Limited Holder', 'holder@holderrecords.synthetic.invalid');
    ok(await decide(reviewer, ok<{ claim: Claim }>(await submit(holder.client, companyId, 'claimed', { kind: 'own_domain_mailbox', email: 'holder@holderrecords.synthetic.invalid' })).claim));
    await cooled(companyId);
    assert.equal(await roleOf(holder.id, companyId), null);
    expectRefusal(await add(holder.client, companyId, ein('12-4444444')), 403, 'access.forbidden', 'administrator_required');
    const stranger = await claimant('Synthetic Records Stranger', 'stranger@elsewhere3.synthetic.invalid');
    expectRefusal(await add(stranger.client, companyId, ein('12-4444444')), 403, 'access.forbidden', 'administrator_required');
    assert.equal((await stranger.client.get(`/v1/companies/${companyId}/records`)).status, 404);
    assert.equal((await anonymous.get(`/v1/companies/${companyId}/records`)).status, 401);
    expectRefusal(await stranger.client.post(`/v1/companies/${companyId}/page-profile`, profile()), 403, 'access.forbidden', 'administrator_required');

    // Descriptive fields are the holder's; the legal form and the website are not.
    const descriptive = { legalForm: null, websiteUrl: null, regionCode: 'US-CA', categories: ['roofing'], publicFields: ['categories'], description: 'Synthetic roofing, as stated by the company.' };
    ok(await holder.client.post(`/v1/companies/${companyId}/page-profile`, descriptive));
    expectRefusal(await holder.client.post(`/v1/companies/${companyId}/page-profile`, { ...descriptive, legalForm: 'US-LLC' }), 403, 'access.forbidden', 'administrator_required');
    expectRefusal(await holder.client.post(`/v1/companies/${companyId}/page-profile`, { ...descriptive, websiteUrl: 'https://taken.synthetic.invalid/' }), 403, 'access.forbidden', 'administrator_required');

    // A status or a source in a payload is refused by the schema, for any author.
    assert.equal((await add(holder.client, companyId, { ...ein('12-4444444'), status: 'verified' })).status, 422);
    // The runtime role has no way around the commands.
    await assert.rejects(w.actors.as(holder.id, (trx) => trx.insertInto('company_identifier').values({ company_id: companyId, kind: 'US-EIN', value: '1', value_normalized: '1', status: 'verified' } as never).execute()), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(w.actors.as(w.people.hubOwner, (trx) => trx.selectFrom('tax_registration').selectAll().execute()), (e: { code?: string }) => e.code === '42501');
    expectRefusal(await command(w.clients.moderator, `${base}/claims/companies/${companyId}/records`, { record: ein('12-4444444'), sourceRef: 'register:SYN-1' }), 403, 'access.forbidden', 'forbidden');
    assert.equal((await w.clients.employee.get(`${base}/claims/companies/${companyId}/records`)).status, 403);
    assert.equal((await w.clients.moderator.get(`${base}/claims/companies/${companyId}/records`)).status, 403);
  });

  await t.test('tax registrations and private branches stay private; the page shows only the fields it chose', async () => {
    const { companyId, person } = await foundedPage('Synthetic Private Records Builders', 'founder@privaterecords.synthetic.invalid');
    const colleague = await claimant('Synthetic Private Colleague', 'colleague@privaterecords.synthetic.invalid');
    await withMaintenance(admin, (trx) => trx.insertInto('membership').values({ person_id: colleague.id, company_id: companyId, role: 'member', permissions: [], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute());
    ok(await add(person.client, companyId, { kind: 'tax_registration', jurisdiction: 'US-TX', taxKind: 'US-TX-SALES', number: 'SYN-TAX-SECRET', status: 'active', validUntil: '2027-12-31' }));
    ok(await add(person.client, companyId, { kind: 'branch', hubId, name: 'Synthetic Hidden Yard', address: {}, regionCode: null, public: false }));
    ok(await person.client.post(`/v1/companies/${companyId}/page-profile`, profile({ websiteUrl: 'https://privaterecords.synthetic.invalid/', publicFields: ['legal_form'] })));

    assert.equal((await records(person.client, companyId)).taxRegistrations?.length, 1);
    const open = await publicRecords(companyId);
    assert.deepEqual(open.profile, { legalForm: 'US-LLC' }, 'only the chosen fields');
    assert.deepEqual(open.branches, []);
    const member = await records(colleague.client, companyId);

    // Staff have no reason to read this page until a claim or a case of it is open at their hub.
    const url = `${base}/claims/companies/${companyId}/records`;
    const elsewhere = `/v1/admin/hubs/${otherHubId}/claims/companies/${companyId}/records`;
    assert.equal((await reviewer.get(url)).status, 404);
    assert.equal((await command(reviewer, url, { record: sos('C2222222'), sourceRef: 'register:SYN-1' })).status, 404);
    const { person: claimantPerson, claim } = await openClaim(companyId, 'privatereads');
    const staff = ok<Records>(await reviewer.get(url));
    assert.equal(staff.branches.length, 1, 'staff of the hub see the branch');
    const audited = () => admin.query("SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'claims.records_read' AND outcome = 'applied' AND object_id = $1", [companyId]);
    assert.equal((await audited()).rowCount, 1, 'the read is audited');
    assert.equal((await w.clients.ops.get(elsewhere)).status, 404, 'a claim at one hub opens nothing to staff of another');
    assert.equal((await command(w.clients.ops, elsewhere, { record: sos('C2222222'), sourceRef: 'register:SYN-1' })).status, 404);
    ok(await claimantPerson.client.post(`/v1/claims/${claim.id}/withdraw`, {}));
    assert.equal((await reviewer.get(url)).status, 404, 'the reason ends with the claim');
    await withMaintenance(admin, (trx) => trx.insertInto('support_case').values({ hub_id: otherHubId, requester_person_id: person.id, opened_by: person.id, subject_company_id: companyId, category: 'account_access', summary: 'Synthetic: a question about our page' } as never).execute());
    assert.equal(ok<Records>(await w.clients.ops.get(elsewhere)).branches.length, 1, 'an open case at that hub is a reason there');
    assert.equal((await reviewer.get(url)).status, 404, 'and only there');
    for (const view of [open, member, staff]) {
      assert.ok(!('taxRegistrations' in view));
      assert.ok(!JSON.stringify(view).includes('SYN-TAX-SECRET'));
    }
  });

  await t.test('staff record what a source says, labelled sourced; a tax registration is not theirs to record', async () => {
    const companyId = await page('Synthetic Sourced Builders');
    await openClaim(companyId, 'sourced');
    const url = `${base}/claims/companies/${companyId}/records`;
    ok(await command(reviewer, url, { record: { kind: 'identifier', identifierKind: 'US-CA-SOS', jurisdiction: 'US-CA', value: 'C7654321' }, sourceRef: 'register:SYN-CA-SOS' }));
    ok(await command(reviewer, url, { record: { kind: 'registration', jurisdiction: 'US-CA', registrationKind: 'formation', registeredName: 'Synthetic Sourced Builders Inc', number: 'C7654321', status: 'active', observedAt: '2026-10-20T09:00:00Z' }, sourceRef: 'register:SYN-CA-SOS' }));
    assert.equal((await command(reviewer, url, { record: { kind: 'tax_registration', jurisdiction: 'US-TX', taxKind: 'US-TX-SALES', number: 'SYN-1', status: 'active', validUntil: null }, sourceRef: 'register:SYN-1' })).status, 422);
    assert.equal((await publicRecords(companyId)).identifiers[0]?.status, 'sourced');
    assert.equal(await statusOf(companyId), 'unclaimed');
  });

  await t.test('the cooling period holds through the API for identifiers, the website and the representative (clock)', async () => {
    const { companyId, person } = await verifiedPage('Synthetic Cooling Records Builders', 'admin@coolingrecords.synthetic.invalid');
    await cooled(companyId);
    // The accountable person of a representative holds company.deals.manage, which a claim does not give; this fixture has it.
    await withMaintenance(admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.page.edit', 'company.members.manage', 'company.deals.manage'] }).where('person_id', '=', person.id).where('company_id', '=', companyId).execute());
    const before = ok<{ record: { id: string } }>(await add(person.client, companyId, ein('12-5555555'))).record;
    ok(await person.client.post(`/v1/companies/${companyId}/page-profile`, profile({ websiteUrl: 'https://coolingrecords.synthetic.invalid/' })));
    const lock = () => withMaintenance(admin, (trx) => trx.updateTable('company_handover').set({ cooling_until: new Date(Date.now() + 7 * 86_400_000) }).where('company_id', '=', companyId).execute());
    await lock();
    await openClaim(companyId, 'coolingrecords');

    expectRefusal(await add(person.client, companyId, ein('12-6666666')), 422, 'validation.schema', 'cooling_period');
    expectRefusal(await person.client.post(`/v1/companies/${companyId}/records/identifier/${before.id}/retire`, {}), 422, 'validation.schema', 'cooling_period');
    expectRefusal(await command(reviewer, `${base}/claims/companies/${companyId}/records`, { record: ein('12-6666666'), sourceRef: 'register:SYN-1' }), 422, 'validation.schema', 'cooling_period');
    expectRefusal(await person.client.post(`/v1/companies/${companyId}/page-profile`, profile({ websiteUrl: 'https://elsewhere.synthetic.invalid/' })), 422, 'validation.schema', 'cooling_period');
    const representative = await person.client.post(`/v1/companies/${companyId}/representative`, { accountablePersonId: person.id, expectedRevision: null });
    assert.equal(representative.status, 422, JSON.stringify(representative.body));
    assert.equal((await admin.query('SELECT 1 FROM trustwork.company_representative WHERE company_id = $1', [companyId])).rowCount, 0);

    // Descriptions stay free, and a reviewer's label on an identifier is not a change of the value.
    ok(await person.client.post(`/v1/companies/${companyId}/page-profile`, profile({ websiteUrl: 'https://coolingrecords.synthetic.invalid/', description: 'Synthetic description during cooling.' })));
    ok(await verify(reviewer, { id: before.id, revision: 1 }, await passingCheck(companyId)));
    // A new value in the old column is a change, whoever writes it.
    await withMaintenance(admin, (trx) => trx.updateTable('company').set({ legal_identifiers: JSON.stringify([{ kind: 'other', value: 'SYN 2', status: 'sourced' }]) }).where('id', '=', companyId).execute())
      .then(() => assert.fail('a new value in the old column is a change'), (e: { hint?: string }) => assert.equal(e.hint, 'claims.cooling_period'));

    await cooled(companyId);
    ok(await add(person.client, companyId, ein('12-6666666')));
    ok(await person.client.post(`/v1/companies/${companyId}/page-profile`, profile({ websiteUrl: 'https://elsewhere.synthetic.invalid/' })));
    ok(await person.client.post(`/v1/companies/${companyId}/records/identifier/${before.id}/retire`, {}));
    assert.deepEqual((await records(person.client, companyId)).identifiers.map((i) => i.value), ['12-6666666']);
  });

  await t.test('the cooling guard compares identifier values, not their order or status', async () => {
    const { rows } = await admin.query<{ same: boolean; changed: boolean }>(`SELECT
      trustwork.claims_identifier_values('[{"kind":"US-EIN","value":"1","status":"claimed"},{"kind":"other","value":"2","status":"sourced"}]'::jsonb)
        = trustwork.claims_identifier_values('[{"kind":"other","value":"2","status":"verified"},{"kind":"US-EIN","value":"1","status":"claimed"}]'::jsonb) AS same,
      trustwork.claims_identifier_values('[{"kind":"US-EIN","value":"1"}]'::jsonb) <> trustwork.claims_identifier_values('[{"kind":"US-EIN","value":"3"}]'::jsonb) AS changed`);
    assert.deepEqual(rows[0], { same: true, changed: true });
  });

  await t.test('a self-stated value is not evidence: a company that types a contractor\'s licence number shows no licence status', async () => {
    // A public register holds the licence of a real contractor (synthetic here); a new company enters that number.
    const sourceId = await withMaintenance(admin, async (trx) => (await trx.insertInto('source').values({
      hub_id: hubId, kind: 'register_open_data', name: 'Synthetic Claims Licence Board', url: 'https://board.synthetic-claims.invalid/data', reader_kind: 'official_register', purposes: ['company_directory'],
      licence_kind: 'statutory_public', allowed_uses: JSON.stringify({ displayHeadlineAndLink: true, displaySummary: true, storeFullText: false, indexForSearch: true, sendToModelProviders: false, translate: false,
        rewriteWithAttribution: false, reuseImages: false, syndicateToPeers: false }), attribution_template: 'Source: Synthetic Claims Licence Board', takedown_contact: 'records@synthetic-claims.invalid',
      owner_person_id: w.people.hubOwner, personal_data: false, proposed_by_person: w.people.hubOwner, edited_by: w.people.hubOwner, status: 'active', activated_by: w.people.lead2, activated_at: new Date(),
    } as never).returning('id').executeTakeFirstOrThrow()).id);
    const adapter = ok<{ adapter: { id: string } }>(await command(reviewer, `${base}/registers/adapters`, { adapter: 'us_ca_cslb_licence_file', sourceId, refreshDays: 7 })).adapter.id;
    ok(await command(reviewer, `${base}/registers/adapters/${adapter}/fake-runs`, { subjects: [{ identifierValue: '8000123' }] }));

    const { companyId, person } = await foundedPage('Synthetic Impostor Builders', 'founder@impostor.synthetic.invalid');
    ok(await add(person.client, companyId, { kind: 'identifier', identifierKind: 'US-CA-CSLB', jurisdiction: 'US-CA', value: '8000123' }));
    const previous = process.env.TRUSTWORK_HUB_ID;
    process.env.TRUSTWORK_HUB_ID = hubId;
    try {
      assert.deepEqual(ok<{ items: unknown[] }>(await anonymous.get(`/v1/companies/${companyId}/sourced-facts`)).items, [], 'no licence status appears');
      assert.deepEqual(await legalIdentifiers(companyId), []);
      assert.deepEqual((await publicRecords(companyId)).identifiers, [], 'nor the number');
      const holds = async (kind: string, value: string) => (await admin.query<{ holds: boolean }>('SELECT trustwork.registers_company_holds($1, $2, trustwork.registers_norm($3)) AS holds', [companyId, kind, value])).rows[0]?.holds;
      assert.equal(await holds('US-CA-CSLB', '8000123'), false);

      // A public kind typed by the company is no evidence either, until it passes verification.
      const stated = ok<{ record: { id: string } }>(await add(person.client, companyId, sos('C3333333'))).record;
      assert.equal(await holds('US-CA-SOS', 'C3333333'), false);
      assert.deepEqual(await legalIdentifiers(companyId), []);
      ok(await verify(reviewer, { id: stated.id, revision: 1 }, await passingCheck(companyId)));
      assert.equal(await holds('US-CA-SOS', 'C3333333'), true);
    } finally {
      process.env.TRUSTWORK_HUB_ID = previous;
    }
    // Both evidence readers read only the old column; nothing outside this module reads the new table.
    const { rows } = await admin.query<{ proname: string }>("SELECT proname FROM pg_proc WHERE pronamespace = 'trustwork'::regnamespace AND prosrc LIKE '%trustwork.company_identifier%' AND proname NOT LIKE 'claims\\_%' ORDER BY proname");
    assert.deepEqual(rows, []);
    const sources = await admin.query<{ proname: string }>("SELECT proname FROM pg_proc WHERE proname IN ('registers_company_holds', 'datasets_statutory_match') AND prosrc LIKE '%legal_identifiers%' ORDER BY proname");
    assert.deepEqual(sources.rows.map((r) => r.proname), ['datasets_statutory_match', 'registers_company_holds']);
  });

  await t.test('personal and tax identifiers stay private, verified or not', async () => {
    const { companyId, person } = await foundedPage('Synthetic Personal Numbers Builders', 'founder@personalnumbers.synthetic.invalid');
    const rfc = ok<{ record: { id: string } }>(await add(person.client, companyId, { kind: 'identifier', identifierKind: 'MX-RFCPF', jurisdiction: 'MX', value: 'GODE561231GR8' })).record;
    const eins = ok<{ record: { id: string } }>(await add(person.client, companyId, ein('12-8888888'))).record;
    assert.equal((await add(person.client, companyId, { ...ein('12-9999999'), private: false })).status, 422, 'the request does not choose');
    const check = await passingCheck(companyId);
    ok(await verify(reviewer, { id: rfc.id, revision: 1 }, check));
    ok(await verify(reviewer, { id: eins.id, revision: 1 }, await passingCheck(companyId)));
    assert.deepEqual((await publicRecords(companyId)).identifiers, []);
    assert.deepEqual(await legalIdentifiers(companyId), [], 'never mirrored, so no public read can show it');
    const directory = ok<{ items: Array<{ id: string; legalIdentifiers: unknown[] }> }>(await anonymous.get('/v1/companies?limit=100')).items.find((c) => c.id === companyId);
    assert.deepEqual(directory?.legalIdentifiers, []);
    const own = await records(person.client, companyId);
    assert.deepEqual(own.identifiers.map((i) => [i.kind, i.status]), [['MX-RFCPF', 'verified'], ['US-EIN', 'verified']], 'the company still sees its own');
    // An EIN written to the old column by maintenance is still kept out of the new public read.
    await withMaintenance(admin, (trx) => trx.updateTable('company').set({ legal_identifiers: JSON.stringify([{ kind: 'US-EIN', value: '12-7070707', status: 'sourced' }]) }).where('id', '=', companyId).execute());
    assert.deepEqual((await publicRecords(companyId)).identifiers, []);
  });

  await t.test('a removed administrator keeps nothing through a hand-over; a claimed-level holder keeps what the level gives', async () => {
    const { companyId, person } = await verifiedPage('Synthetic Removed Builders', 'admin@removed.synthetic.invalid');
    await cooled(companyId);
    const endMembership = (personId: string, company: string) => withMaintenance(admin, (trx) => trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: personId, ended_reason: 'Synthetic: removed by the company' })
      .where('person_id', '=', personId).where('company_id', '=', company).where('status', '=', 'active').execute());
    ok(await records(person.client, companyId).then((r) => ({ status: 200, body: r, headers: {}, cookies: [] })));
    await endMembership(person.id, companyId);
    assert.equal((await person.client.get(`/v1/companies/${companyId}/records`)).status, 404);
    expectRefusal(await person.client.post(`/v1/companies/${companyId}/page-profile`, { legalForm: null, websiteUrl: null, regionCode: null, categories: [], publicFields: [] }), 403, 'access.forbidden', 'administrator_required');

    // Claimed first, then verified, then removed: the older claimed-level hand-over does not bring the access back.
    const upgraded = await page('Synthetic Upgraded Removed Builders', 'upgradedremoved.synthetic.invalid');
    const holder = await claimant('Synthetic Upgraded Holder', 'holder@upgradedremoved.synthetic.invalid');
    ok(await decide(reviewer, ok<{ claim: Claim }>(await submit(holder.client, upgraded, 'claimed', { kind: 'own_domain_mailbox', email: 'holder@upgradedremoved.synthetic.invalid' })).claim));
    assert.equal((await holder.client.get(`/v1/companies/${upgraded}/records`)).status, 200, 'a claimed-level holder reads the page');
    ok(await decide(reviewer, ok<{ claim: Claim }>(await submit(holder.client, upgraded, 'verified')).claim));
    await endMembership(holder.id, upgraded);
    assert.equal((await holder.client.get(`/v1/companies/${upgraded}/records`)).status, 404);
  });

  await t.test('expand: a write to the old column reaches the table, and a value gone from it retires', async () => {
    const companyId = await page('Synthetic Legacy Builders');
    const live = async () => (await admin.query<{ kind: string; status: string }>('SELECT kind, status FROM trustwork.company_identifier WHERE company_id = $1 AND retired_at IS NULL ', [companyId])).rows.map((r) => [r.kind, r.status]).sort();
    const write = (list: unknown[]) => withMaintenance(admin, (trx) => trx.updateTable('company').set({ legal_identifiers: JSON.stringify(list) }).where('id', '=', companyId).execute());
    await write([{ kind: 'US-EIN', value: '12-7777777', status: 'sourced' }, { kind: 'other', value: 'SYN 1', status: 'claimed' }]);
    assert.deepEqual(await live(), [['US-EIN', 'sourced'], ['other', 'claimed']]);
    await write([{ kind: 'other', value: 'SYN 1', status: 'claimed' }]);
    assert.deepEqual(await live(), [['other', 'claimed']]);
    const { rows } = await admin.query<{ n: string }>('SELECT count(*)::text AS n FROM trustwork.company_identifier WHERE company_id = $1', [companyId]);
    assert.equal(rows[0]?.n, '2', 'the retired row stays on record');
  });
});
