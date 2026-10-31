import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { expectError, SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { as, fails } from '../assistant/helpers.js';
import { buildWorld, ok, terms, UNTIL } from './helpers.js';

/**
 * AGT-001 company representation on the real database under the runtime role: at most one representative per company
 * (also under concurrent enabling), always with an accountable person who accepted; company mandates granted only by
 * members holding company.deals.manage on the first-party form; nobody widens a company mandate (not the executor, not
 * the accountable person, not a re-confirmation); another participant cannot act through them; and losing a membership
 * stops dependent authority in the membership's own transaction.
 */
const h = await startHarness('agents_representation');

interface RepView { id: string; status: string; suspensionReason: string | null; accountablePersonId: string | null; revision: number; blockedBy: string | null }
interface CmView { id: string; status: string; statusReason: string | null; mandateId: string; grantedByPersonId: string; termsDigest: { algorithm: string; value: string }; revision: number; reconfirmDueAt: string | null }

test('representation: one representative, accountable person, company mandates, re-confirmation and membership loss', { skip: h ? false : SKIP_REASON, timeout: 300_000 }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const w = await buildWorld(h);
  const { boris, xenia, pure, carl, anna } = w.clients;
  const company = w.seed.companies.supplier;
  const base = `/v1/companies/${company}`;
  let repCm: CmView;
  let pureCm: CmView;

  await t.test('only a company administrator enables the one representative, naming a member with deals authority who accepts', async () => {
    expectError(await pure.post(`${base}/representative`, { accountablePersonId: w.seed.people.pure, expectedRevision: null }), 403, 'membership.permission_missing');
    expectError(await xenia.post(`${base}/representative`, { accountablePersonId: w.seed.people.xenia, expectedRevision: null }), 403, 'membership.permission_missing');
    expectError(await boris.post(`${base}/representative`, { accountablePersonId: w.seed.people.pure, expectedRevision: null }), 403, 'membership.permission_missing');
    expectError(await anna.post(`${base}/representative`, { accountablePersonId: w.seed.people.anna, expectedRevision: null }), 404, 'access.not_found');
    h.clock.advance(11 * 60_000);
    expectError(await boris.post(`${base}/representative`, { accountablePersonId: w.seed.people.xenia, expectedRevision: null }), 403, 'auth.step_up_required');
    h.clock.reset();
    const pending = ok<RepView>(await boris.post(`${base}/representative`, { accountablePersonId: w.seed.people.xenia, expectedRevision: null }));
    assert.equal(pending.status, 'pending_acceptance');
    // A second representative cannot exist: a fresh enable conflicts, the database refuses a direct row.
    expectError(await boris.post(`${base}/representative`, { accountablePersonId: w.seed.people.boris, expectedRevision: null }), 409, 'validation.revision_conflict');
    await as(h, w.seed.people.boris, (trx) => fails(sql`INSERT INTO trustwork.company_representative (company_id, status, enabled_by_person_id, accountable_person_id) VALUES (${company}::uuid, 'active', ${w.seed.people.boris}::uuid, ${w.seed.people.boris}::uuid)`.execute(trx), '42501'));
    expectError(await boris.post(`${base}/representative/accept`), 404, 'access.not_found');
    const accepted = ok<RepView>(await xenia.post(`${base}/representative/accept`));
    assert.deepEqual([accepted.status, accepted.suspensionReason, accepted.accountablePersonId], ['suspended', 'no_confirmed_mandate', w.seed.people.xenia], 'no mandate yet: it suspends automatically');
    const view = ok<{ representative: RepView | null; companyMandates: unknown[] }>(await carl.get(`${base}/representative`));
    assert.equal(view.representative, null, 'another participant does not see the company\'s representative record');
  });

  await t.test('two administrators enabling at the same time create exactly one representative', async () => {
    const other = w.seed.companies.unrelated;
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.members.manage', 'company.deals.manage'] }).where('id', '=', w.seed.memberships.carl).execute());
    const [a, b] = await Promise.all([1, 2].map(() => carl.post(`/v1/companies/${other}/representative`, { accountablePersonId: w.seed.people.carl, expectedRevision: null })));
    assert.deepEqual([a!.status, b!.status].sort(), [200, 409], JSON.stringify([a!.body, b!.body]));
    const { rows } = await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.company_representative WHERE company_id = $1', [other]);
    assert.equal(rows[0].n, 1);
  });

  await t.test('company mandates are granted only by members holding deals authority, on the first-party form', async () => {
    const repTerms = terms(w.rfq.rfq.id, ['negotiate', 'communicate', 'send_quote']);
    expectError(await pure.post(`${base}/agent-mandates`, { executor: { kind: 'company_representative' }, terms: repTerms }), 403, 'membership.permission_missing');
    expectError(await carl.post(`${base}/agent-mandates`, { executor: { kind: 'company_representative' }, terms: repTerms }), 404, 'access.not_found');
    expectError(await boris.post(`${base}/agent-mandates`, { executor: { kind: 'colleague_agent', personId: w.seed.people.carl }, terms: repTerms }), 403, 'access.forbidden');
    expectError(await boris.post(`${base}/agent-mandates`, { executor: { kind: 'colleague_agent', personId: w.seed.people.boris }, terms: repTerms }), 403, 'access.forbidden');
    expectError(await boris.post(`${base}/agent-mandates`, { executor: { kind: 'company_representative' }, terms: { ...repTerms, actions: ['place_order'] } }), 422, 'validation.schema');
    expectError(await boris.post(`${base}/agent-mandates`, { executor: { kind: 'company_representative' }, terms: repTerms, confirmation: { via: 'first_party_form' } }), 422, 'validation.unknown_field');
    repCm = ok<CmView>(await boris.post(`${base}/agent-mandates`, { executor: { kind: 'company_representative' }, terms: repTerms }), 201);
    assert.equal(repCm.status, 'active');
    const rep = ok<{ representative: RepView }>(await xenia.get(`${base}/representative`)).representative;
    assert.deepEqual([rep.status, rep.suspensionReason], ['active', null], 'a confirmed mandate activates the representative');
    pureCm = ok<CmView>(await boris.post(`${base}/agent-mandates`, { executor: { kind: 'colleague_agent', personId: w.seed.people.pure }, terms: terms(w.rfq.rfq.id, ['communicate']) }), 201);
    assert.equal(ok<{ companyMandates: CmView[] }>(await pure.get('/v1/assistant/company-mandates')).companyMandates.length, 1, 'the colleague sees the mandate their agent executes');
    assert.equal(ok<{ companyMandates: CmView[] }>(await carl.get('/v1/assistant/company-mandates')).companyMandates.length, 0);
  });

  await t.test('no executor, accountable person or other member can widen a company mandate', async () => {
    // The underlying AST-001 mandate belongs to its granter: the accountable person and the colleague cannot revise it.
    expectError(await xenia.post(`/v1/assistant/mandates/${repCm.mandateId}/confirm`, { expectedRevision: 1, draft: { onBehalfOf: { kind: 'company', id: company }, grantee: { kind: 'own_agent' }, ...terms(w.rfq.rfq.id, ['negotiate', 'place_order']) } }), 404, 'access.not_found');
    expectError(await pure.get(`/v1/assistant/mandates/${pureCm.mandateId}`), 404, 'access.not_found');
    // The AST-001 route itself never confirms a company grantee.
    expectError(await boris.post(`/v1/assistant/mandates/${repCm.mandateId}/confirm`, { expectedRevision: 1, draft: { onBehalfOf: { kind: 'company', id: company }, grantee: { kind: 'company_representative', companyId: company }, ...terms(w.rfq.rfq.id, ['negotiate', 'communicate', 'send_quote', 'introduce']) } }), 422, 'validation.schema');
    // Re-confirmation is only for a mandate awaiting it, and only with the identical digest.
    expectError(await xenia.post(`${base}/agent-mandates/${repCm.id}/reconfirm`, { termsDigest: repCm.termsDigest }), 409, 'validation.revision_conflict');
    // Direct writes are refused for every runtime principal.
    await as(h, w.seed.people.xenia, (trx) => fails(sql`UPDATE trustwork.company_mandate SET terms = '{}'::jsonb WHERE id = ${repCm.id}::uuid`.execute(trx), '42501'));
    await as(h, w.seed.people.xenia, (trx) => fails(sql`SELECT trustwork.agents_grant_company_mandate(${repCm.mandateId}::uuid, '{}'::jsonb, ${'a'.repeat(64)})`.execute(trx), 'access.not_found'));
    await as(h, w.seed.people.pure, (trx) => fails(sql`SELECT trustwork.agents_revoke_company_mandate(${repCm.id}::uuid, 1)`.execute(trx), 'access.not_found'));
    await as(h, w.seed.people.carl, (trx) => fails(sql`SELECT * FROM trustwork.agents_suspend_representative(${company}::uuid)`.execute(trx), 'agents.not_company_admin'));
    // The representative's own record is not writable either.
    await as(h, w.seed.people.xenia, (trx) => fails(sql`UPDATE trustwork.company_representative SET accountable_person_id = ${w.seed.people.pure}::uuid WHERE company_id = ${company}::uuid`.execute(trx), '42501'));
  });

  await t.test('membership loss stops dependent authority in the same transaction (proved by a rollback)', async () => {
    const client = await h.db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL ROLE trustwork_owner");
      await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      await client.query("UPDATE trustwork.membership SET status = 'ended', ended_at = now(), ended_by = person_id, ended_reason = 'left' WHERE person_id = $1 AND company_id = $2 AND status = 'active'", [w.seed.people.xenia, company]);
      const rep = (await client.query('SELECT status, suspension_reason, accountable_person_id FROM trustwork.company_representative WHERE company_id = $1', [company])).rows[0];
      assert.deepEqual([rep.status, rep.suspension_reason, rep.accountable_person_id], ['suspended', 'no_accountable_person', null], 'inside the membership transaction');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const rep = ok<{ representative: RepView }>(await boris.get(`${base}/representative`)).representative;
    assert.equal(rep.status, 'active', 'the rollback undid both the membership end and the suspension');
  });

  await t.test('the granter leaves: company mandates stop at once and wait 7 days for another member\'s identical re-confirmation', async () => {
    // Xenia becomes an administrator first so the company keeps one when Boris leaves.
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ role: 'administrator' }).where('person_id', '=', w.seed.people.xenia).where('company_id', '=', company).where('status', '=', 'active').execute());
    const membership = (await h.db.admin.query('SELECT id, revision FROM trustwork.membership WHERE id = $1', [w.seed.memberships.boris])).rows[0];
    ok(await boris.post(`${base}/memberships/end`, { membershipId: membership.id, reason: 'Moved on', expectedRevision: membership.revision }));
    const listed = ok<{ companyMandates: CmView[] }>(await xenia.get(`${base}/agent-mandates`)).companyMandates;
    const rep = listed.find((m) => m.id === repCm.id)!;
    assert.equal(rep.status, 'awaiting_reconfirmation');
    assert.ok(rep.reconfirmDueAt && Date.parse(rep.reconfirmDueAt) > Date.now() + 6.9 * 86400_000);
    assert.equal(listed.find((m) => m.id === pureCm.id)!.status, 'awaiting_reconfirmation');
    const mandate = await h.db.admin.query('SELECT status FROM trustwork.mandate WHERE id = $1', [rep.mandateId]);
    assert.equal(mandate.rows[0].status, 'revoked', 'the underlying mandate stopped in the membership transaction');
    const view = ok<{ representative: RepView }>(await xenia.get(`${base}/representative`)).representative;
    assert.deepEqual([view.status, view.suspensionReason], ['suspended', 'no_confirmed_mandate']);
    // Pure has no deals authority: she cannot re-confirm. A wrong digest is refused. Xenia re-confirms exactly.
    expectError(await pure.post(`${base}/agent-mandates/${repCm.id}/reconfirm`, { termsDigest: repCm.termsDigest }), 404, 'access.not_found');
    expectError(await xenia.post(`${base}/agent-mandates/${repCm.id}/reconfirm`, { termsDigest: { algorithm: 'trustwork-digest-1', value: 'b'.repeat(64) } }), 409, 'access.approval_digest_mismatch');
    const reconfirmed = ok<CmView>(await xenia.post(`${base}/agent-mandates/${repCm.id}/reconfirm`, { termsDigest: repCm.termsDigest }));
    assert.deepEqual([reconfirmed.status, reconfirmed.grantedByPersonId], ['active', w.seed.people.xenia]);
    assert.notEqual(reconfirmed.mandateId, repCm.mandateId, 'a new mandate of the re-confirming member, with identical terms');
    assert.equal(reconfirmed.termsDigest.value, repCm.termsDigest.value);
    assert.equal(ok<{ representative: RepView }>(await xenia.get(`${base}/representative`)).representative.status, 'active');
    repCm = reconfirmed;
  });

  await t.test('a lapsed re-confirmation window suspends; the colleague leaving revokes her mandate in the same transaction', async () => {
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('company_mandate').set({ reconfirm_due_at: new Date(Date.now() - 1000) }).where('id', '=', pureCm.id).execute());
    expectError(await xenia.post(`${base}/agent-mandates/${pureCm.id}/reconfirm`, { termsDigest: pureCm.termsDigest }), 409, 'validation.revision_conflict');
    const lapsedView = ok<{ companyMandates: CmView[] }>(await xenia.get(`${base}/agent-mandates`)).companyMandates.find((m) => m.id === pureCm.id)!;
    assert.deepEqual([lapsedView.status, lapsedView.statusReason], ['suspended', 'reconfirmation_lapsed']);
    const swept = await h.db.admin.query('SELECT trustwork.agents_lapse_reconfirmations(10) AS n');
    assert.equal(swept.rows[0].n, 1);
    const pureMembership = (await h.db.admin.query('SELECT id, revision FROM trustwork.membership WHERE person_id = $1 AND company_id = $2 AND status = $3', [w.seed.people.pure, company, 'active'])).rows[0];
    ok(await pure.post(`${base}/memberships/end`, { membershipId: pureMembership.id, reason: 'Left the company', expectedRevision: pureMembership.revision }));
    const row = (await h.db.admin.query('SELECT status, status_reason FROM trustwork.company_mandate WHERE id = $1', [pureCm.id])).rows[0];
    assert.deepEqual([row.status, row.status_reason], ['revoked', 'executor_left']);
  });

  await t.test('any administrator suspends instantly; resuming is deliberate; disabling revokes the representative\'s mandates', async () => {
    const suspended = ok<RepView>(await xenia.post(`${base}/representative/suspend`));
    assert.deepEqual([suspended.status, suspended.suspensionReason], ['suspended', 'admin_suspended']);
    expectError(await xenia.post(`${base}/representative/resume`, { expectedRevision: suspended.revision + 5 }), 409, 'validation.revision_conflict');
    const resumed = ok<RepView>(await xenia.post(`${base}/representative/resume`, { expectedRevision: suspended.revision }));
    assert.equal(resumed.status, 'active');
    const disabled = ok<RepView>(await xenia.post(`${base}/representative/disable`));
    assert.equal(disabled.status, 'disabled');
    const cm = (await h.db.admin.query('SELECT status FROM trustwork.company_mandate WHERE id = $1', [repCm.id])).rows[0];
    assert.equal(cm.status, 'revoked');
    // Re-enabling reuses the one row: still exactly one representative per company.
    const again = ok<RepView>(await xenia.post(`${base}/representative`, { accountablePersonId: w.seed.people.xenia, expectedRevision: disabled.revision }));
    assert.equal(again.id, disabled.id);
    assert.deepEqual([again.status, again.suspensionReason], ['suspended', 'no_confirmed_mandate']);
  });

  await t.test('there is no agent management surface: no list of agents, no second assistant', async () => {
    for (const path of ['/v1/assistant/agents', '/v1/agents', `${base}/representatives`, `${base}/agents`]) {
      const r = await xenia.get(path);
      assert.equal(r.status, 404, path);
    }
    const r = await xenia.post('/v1/assistant/agents', { name: 'Second assistant' });
    assert.equal(r.status, 404);
    const tables = await h.db.admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'trustwork' AND table_name ~ '(^|_)agents?$'");
    assert.deepEqual(tables.rows, [], 'no table of agents per person');
    assert.ok(UNTIL);
  });
});
