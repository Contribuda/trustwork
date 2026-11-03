import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { CLAIM_LEVELS, CLAIM_STATES } from '../../apps/api/src/modules/verification/claims/commands.js';
import { auditRows, command, expectRefusal } from '../admin/helpers.js';
import { SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { claimsWorld, ok, type Claim } from './helpers.js';

const h = await startHarness('claims_api');
const DAY = 86_400_000;

/**
 * CLM-001 through the HTTP API on real PostgreSQL, under the runtime role, with real sessions, TOTP and elevated
 * sessions. A participant, an unelevated session, staff without the permission and staff of another hub are refused;
 * a tie needs the claimant's own verified address; submitting never changes a page; two concurrent claims make one
 * dispute and no hand-over; two reviewers decide it; a managed page waits and its people are told; revocation undoes
 * the hand-over. Every person, company, domain and address is synthetic.
 */
test('CLM-001 claim routes', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const world = await claimsWorld(h);
  t.after(async () => { await world.w.close(); await h.close(); });
  const { w, hubId, otherHubId, reviewer, second, page, claimant, submit, decide, statusOf, roleOf, notices } = world;
  const base = world.console;
  const admin = h.db.admin;
  const count = async (sqlText: string, params: unknown[]) => (await admin.query(sqlText, params)).rowCount ?? 0;

  await t.test('the API vocabularies equal the database vocabularies', async () => {
    const { rows } = await admin.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'trustwork.company_claim'::regclass AND conname IN ('company_claim_level_check', 'company_claim_state_check') ORDER BY conname");
    for (const level of CLAIM_LEVELS) assert.ok(rows[0]?.def.includes(`'${level}'`), level);
    for (const state of CLAIM_STATES) assert.ok(rows[1]?.def.includes(`'${state}'`), state);
  });

  await t.test('negative authorization: participant, unelevated session, staff without the permission, staff of another hub', async () => {
    const companyId = await page('Synthetic Authorization Builders', 'authorization.synthetic.invalid');
    const person = await claimant('Synthetic Authorization Claimant', 'office@authorization.synthetic.invalid');
    const claim = ok<{ claim: Claim }>(await submit(person.client, companyId, 'claimed', { kind: 'own_domain_mailbox', email: 'office@authorization.synthetic.invalid' })).claim;
    const url = `${base}/claims/requests/${claim.id}/decide`;
    const body = { expectedRevision: claim.revision, decision: 'approved', officerMatch: false, note: null };

    assert.equal((await w.clients.employee.get(`${base}/claims`)).status, 403);
    assert.equal((await command(w.clients.employee, url, body)).status, 403, 'a participant has no console');
    assert.equal((await command(person.client, url, body)).status, 403, 'a claimant does not reach the console');

    // A reviewer's role without an elevated session reaches nothing.
    const unelevated = await claimant('Synthetic Unelevated Reviewer', 'unelevated@staff.synthetic.invalid');
    await w.actors.assign({ personId: unelevated.id, role: 'trust-reviewer', scope: { kind: 'hub', hubId } });
    expectRefusal(await command(unelevated.client, url, body), 403, 'access.forbidden', 'elevation');
    assert.equal((await unelevated.client.get(`${base}/claims`)).status, 403);

    // Staff without a claims permission do not see the claim at all.
    assert.equal((await command(w.clients.moderator, url, body)).status, 404);
    assert.deepEqual((ok<{ claims: unknown[] }>(await w.clients.moderator.get(`${base}/claims`))).claims, [], 'staff without a claims permission read nothing');

    const elsewhere = `/v1/admin/hubs/${otherHubId}/claims`;
    assert.equal((await w.clients.ops.get(`${elsewhere}/requests/${claim.id}`)).status, 404, 'a claim of another hub is not found');
    assert.equal((await command(w.clients.ops, `${elsewhere}/requests/${claim.id}/decide`, body)).status, 404);
    assert.deepEqual([await statusOf(companyId), await roleOf(person.id, companyId)], ['unclaimed', null]);
  });

  await t.test('the claimant reads a hub\'s recipes and their own claim; a tie needs their own verified address on the company\'s domain', async () => {
    const companyId = await page('Synthetic Mailbox Builders', 'mailbox.synthetic.invalid');
    const person = await claimant('Synthetic Mailbox Claimant', 'office@mailbox.synthetic.invalid');
    const stranger = await claimant('Synthetic Mailbox Stranger', 'stranger@elsewhere.synthetic.invalid');
    const offered = ok<{ items: Array<{ id: string; level: string; badgeCategories: string[] }> }>(await person.client.get(`/v1/claims/recipes?hubId=${hubId}`)).items;
    assert.deepEqual(offered.map((r) => r.level).sort(), ['claimed', 'verified']);

    // Knowing a company's address proves nothing: it must be a login the claimant verified.
    const typed = ok<{ claim: Claim }>(await submit(stranger.client, companyId, 'claimed', { kind: 'own_domain_mailbox', email: 'office@mailbox.synthetic.invalid' })).claim;
    assert.equal(typed.domainTie, null);
    ok(await stranger.client.post(`/v1/claims/${typed.id}/withdraw`, {}));

    const claim = ok<{ claim: Claim & Record<string, unknown> }>(await submit(person.client, companyId, 'claimed', { kind: 'own_domain_mailbox', email: 'Office@Mailbox.synthetic.invalid' })).claim;
    assert.deepEqual([claim.domainTie, claim.state], ['own_domain_mailbox', 'open']);
    for (const hidden of ['decidedBy', 'decisionNote', 'disputeId', 'claimantId', 'domainTieDomain']) assert.ok(!(hidden in claim), `${hidden} is not for the claimant`);
    expectRefusal(await submit(person.client, companyId, 'claimed'), 409, 'validation.revision_conflict', 'already_claiming');
    assert.equal((await stranger.client.post(`/v1/claims/${claim.id}/withdraw`, {})).status, 404, 'another claimant finds nothing');
    assert.equal(ok<{ claims: Claim[] }>(await person.client.get('/v1/claims')).claims.length, 1);
    assert.deepEqual(ok<{ claims: Claim[] }>(await w.clients.outsider.get('/v1/claims')).claims, []);
    // SANC-003 hears of the claim: both sides, identifiers only.
    assert.equal(await count("SELECT 1 FROM trustwork.outbox_event WHERE type = 'identity.company_claim_submitted' AND aggregate_id = $1", [person.id]), 1);
    assert.ok(await count("SELECT 1 FROM trustwork.outbox_event WHERE type = 'company.claim_submitted' AND aggregate_id = $1", [companyId]) >= 2);
  });

  await t.test('an invitation link alone changes nothing: no status, no role; only a reviewer\'s decision hands over', async () => {
    const companyId = await page('Synthetic Invitation Builders', 'invitation.synthetic.invalid');
    const person = await claimant('Synthetic Invitation Claimant', 'owner@invitation.synthetic.invalid');
    const claim = ok<{ claim: Claim }>(await submit(person.client, companyId, 'claimed', { kind: 'invitation_link', email: 'owner@invitation.synthetic.invalid' })).claim;
    assert.deepEqual([claim.domainTie, claim.state], ['invitation_link', 'open']);
    assert.deepEqual([await statusOf(companyId), await roleOf(person.id, companyId)], ['unclaimed', null]);
    assert.equal(await count('SELECT 1 FROM trustwork.company_handover WHERE company_id = $1', [companyId]), 0);
    expectRefusal(await decide(reviewer, { id: claim.id, revision: claim.revision + 1 }), 409, 'validation.revision_conflict', 'revision_conflict');
    const approved = ok<{ claim: Claim }>(await decide(reviewer, claim)).claim;
    assert.equal(approved.state, 'approved');
    assert.deepEqual([await statusOf(companyId), await roleOf(person.id, companyId)], ['claimed', null], 'the claimed level gives no company role');
    // Only the decision writes hand-overs and only the derivation writes the status: no message, reply or link path exists.
    const writers = (text: string) => admin.query<{ proname: string }>('SELECT proname FROM pg_proc WHERE pronamespace = \'trustwork\'::regnamespace AND prosrc LIKE $1 ORDER BY proname', [`%${text}%`]);
    assert.deepEqual((await writers('INSERT INTO trustwork.company_handover')).rows.map((r) => r.proname), ['claims_decide']);
    assert.deepEqual((await writers('UPDATE trustwork.company SET claim_status')).rows.map((r) => r.proname), ['claims_derive']);
  });

  await t.test('the claimed level needs a tie; a reviewer never decides their own claim', async () => {
    const companyId = await page('Synthetic Reviewer Builders');
    const noTie = await claimant('Synthetic No Tie Claimant', 'notie@reviewer.synthetic.invalid');
    const claim = ok<{ claim: Claim }>(await submit(noTie.client, companyId, 'claimed')).claim;
    expectRefusal(await decide(reviewer, claim), 422, 'validation.schema', 'company_tie_required');
    const viaOfficer = ok<{ claim: Claim }>(await decide(reviewer, claim, 'approved', true)).claim;
    assert.equal(viaOfficer.domainTie, 'register_officer_match');

    const other = await page('Synthetic Self Dealing Builders');
    const own = ok<{ claim: Claim }>(await submit(second, other, 'verified')).claim;
    expectRefusal(await decide(second, own), 403, 'access.forbidden', 'own_claim');
    assert.equal((await auditRows(h, "action = 'claims.approved' AND outcome = 'denied' AND object_id = $1", [own.id])).length, 1, 'the refusal is audited');
    ok(await second.post(`/v1/claims/${own.id}/withdraw`, {}));
  });

  await t.test('two concurrent claims make one dispute and no hand-over; two different reviewers decide it', async () => {
    const companyId = await page('Synthetic Contested Builders');
    const first = await claimant('Synthetic First Claimant', 'first@contested.synthetic.invalid');
    const rival = await claimant('Synthetic Rival Claimant', 'rival@contested.synthetic.invalid');
    const results = await Promise.all([first, rival].map((c) => submit(c.client, companyId, 'verified')));
    assert.deepEqual(results.map((r) => r.status), [201, 201]);
    const listed = ok<{ claims: Claim[]; disputes: Array<{ id: string; companyId: string; revision: number; state: string }> }>(await reviewer.get(`${base}/claims?state=disputed`));
    const onPage = listed.claims.filter((c) => (c as unknown as { companyId: string }).companyId === companyId);
    assert.equal(onPage.length, 2);
    const disputes = listed.disputes.filter((d) => d.companyId === companyId);
    assert.equal(disputes.length, 1);
    assert.deepEqual([await statusOf(companyId), await count('SELECT 1 FROM trustwork.company_handover WHERE company_id = $1', [companyId])], ['unclaimed', 0]);
    for (const c of [first, rival]) assert.deepEqual((await notices(c.client)).map((n) => n.params.outcome), ['in_dispute'], 'each claimant hears of the dispute once');

    const third = await claimant('Synthetic Third Claimant', 'third@contested.synthetic.invalid');
    expectRefusal(await submit(third.client, companyId, 'verified'), 409, 'validation.revision_conflict', 'dispute_open');
    for (const c of onPage) expectRefusal(await decide(reviewer, c), 409, 'validation.revision_conflict', 'invalid_transition');

    const dispute = disputes[0]!;
    const url = `${base}/claims/disputes/${dispute.id}`;
    const winner = onPage.find((c) => c.claimantId === first.id)!;
    assert.equal((await command(w.clients.moderator, `${url}/propose`, { expectedRevision: dispute.revision, winnerClaimId: winner.id, note: 'Synthetic signatory evidence.' })).status, 404);
    assert.equal((await command(w.clients.ops, `/v1/admin/hubs/${otherHubId}/claims/disputes/${dispute.id}/propose`, { expectedRevision: dispute.revision, winnerClaimId: winner.id, note: 'Synthetic signatory evidence.' })).status, 404);
    const proposed = ok<{ dispute: { revision: number } }>(await command(reviewer, `${url}/propose`, { expectedRevision: dispute.revision, winnerClaimId: winner.id, note: 'The first claimant showed the signatory evidence.' })).dispute;
    // A reviewer who proposed cannot confirm, whichever route they try; the attempt is audited.
    expectRefusal(await command(reviewer, `${url}/confirm`, { expectedRevision: proposed.revision }), 403, 'access.second_approver_required', 'second_person_required');
    assert.equal((await auditRows(h, "action = 'claims.dispute_decided' AND outcome = 'denied' AND object_id = $1", [dispute.id])).length, 1);
    assert.equal((await command(w.clients.moderator, `${url}/confirm`, { expectedRevision: proposed.revision })).status, 404);
    assert.equal(await statusOf(companyId), 'unclaimed');
    ok(await command(second, `${url}/confirm`, { expectedRevision: proposed.revision }));
    expectRefusal(await command(second, `${url}/confirm`, { expectedRevision: proposed.revision + 1 }), 409, 'validation.revision_conflict', 'invalid_transition');

    const after = ok<{ claims: Array<Claim & { companyId: string }> }>(await reviewer.get(`${base}/claims`)).claims.filter((c) => c.companyId === companyId && c.claimantId !== third.id);
    assert.deepEqual(after.map((c) => [c.claimantId === first.id, c.state]).sort(), [[false, 'rejected'], [true, 'open']]);
    assert.equal(await statusOf(companyId), 'unclaimed', 'the dispute itself hands nothing over');
    assert.deepEqual((await notices(rival.client)).map((n) => n.params.outcome).sort(), ['in_dispute', 'rejected']);
    assert.deepEqual((await notices(first.client)).map((n) => n.params.outcome).sort(), ['back_in_review', 'in_dispute']);
    const open = after.find((c) => c.state === 'open')!;
    ok(await decide(reviewer, open));
    assert.deepEqual([await statusOf(companyId), await roleOf(first.id, companyId)], ['verified', 'administrator']);
  });

  await t.test('a reviewer who is a party to a dispute neither proposes nor confirms its outcome', async () => {
    const companyId = await page('Synthetic Conflicted Builders');
    const rival = await claimant('Synthetic Conflicted Rival', 'rival@conflicted.synthetic.invalid');
    const own = ok<{ claim: Claim }>(await submit(second, companyId, 'verified')).claim;
    ok(await submit(rival.client, companyId, 'verified'));
    const dispute = ok<{ disputes: Array<{ id: string; companyId: string; revision: number }> }>(await reviewer.get(`${base}/claims`)).disputes.find((d) => d.companyId === companyId)!;
    const url = `${base}/claims/disputes/${dispute.id}`;
    expectRefusal(await command(second, `${url}/propose`, { expectedRevision: dispute.revision, winnerClaimId: own.id, note: 'Synthetic self-serving proposal.' }), 403, 'access.forbidden', 'own_claim');
    const proposed = ok<{ dispute: { revision: number } }>(await command(reviewer, `${url}/propose`, { expectedRevision: dispute.revision, winnerClaimId: own.id, note: 'Synthetic proposal for the reviewer.' })).dispute;
    expectRefusal(await command(second, `${url}/confirm`, { expectedRevision: proposed.revision }), 403, 'access.forbidden', 'own_claim');
    assert.deepEqual([await statusOf(companyId), await count("SELECT 1 FROM trustwork.claim_dispute WHERE id = $1 AND state = 'open'", [dispute.id])], ['unclaimed', 1]);
    ok(await second.post(`/v1/claims/${own.id}/withdraw`, {}));
  });

  await t.test('a managed page waits and its people are told; they hear no name; a verified hand-over then gives the role', async () => {
    const companyId = await page('Synthetic Managed Builders', 'managed.synthetic.invalid');
    const holder = await claimant('Synthetic Holder', 'holder@managed.synthetic.invalid');
    const held = ok<{ claim: Claim }>(await submit(holder.client, companyId, 'claimed', { kind: 'own_domain_mailbox', email: 'holder@managed.synthetic.invalid' })).claim;
    ok(await decide(reviewer, held));
    const challenger = await claimant('Synthetic Challenger Person', 'challenger@elsewhere.synthetic.invalid');
    expectRefusal(await submit(challenger.client, companyId, 'claimed'), 422, 'validation.schema', 'verified_level_required');
    const waiting = ok<{ claim: Claim }>(await submit(challenger.client, companyId, 'verified')).claim;
    assert.equal(waiting.state, 'waiting');
    assert.equal(Math.round((Date.parse(waiting.waitingUntil as string) - Date.now()) / DAY), 7);

    const told = (await notices(holder.client)).filter((n) => n.templateKey === 'claims.page_notice');
    assert.equal(told.length, 1);
    assert.deepEqual([told[0]!.params.stage, told[0]!.params.companyName, told[0]!.params.waitingUntil], ['claim_opened', 'Synthetic Managed Builders', (waiting.waitingUntil as string).slice(0, 10)]);
    assert.ok(!JSON.stringify(told).includes('Challenger'), 'the page is told that a claim arrived, not who claims');

    expectRefusal(await decide(reviewer, waiting), 422, 'validation.schema', 'waiting_period');
    await withMaintenance(admin, (trx) => trx.updateTable('company_claim').set({ waiting_until: new Date(Date.now() - 60_000) }).where('id', '=', waiting.id).execute());
    ok(await decide(reviewer, waiting));
    assert.deepEqual([await statusOf(companyId), await roleOf(challenger.id, companyId)], ['verified', 'administrator']);
    assert.ok((await notices(holder.client)).some((n) => n.params.stage === 'handed_over'));
    assert.ok((await notices(challenger.client)).some((n) => n.params.outcome === 'approved'));
  });

  await t.test('a holder asking for the verified level does not wait for themselves; the same level is refused', async () => {
    const companyId = await page('Synthetic Upgrade Builders', 'upgrade.synthetic.invalid');
    const holder = await claimant('Synthetic Upgrade Holder', 'holder@upgrade.synthetic.invalid');
    ok(await decide(reviewer, ok<{ claim: Claim }>(await submit(holder.client, companyId, 'claimed', { kind: 'own_domain_mailbox', email: 'holder@upgrade.synthetic.invalid' })).claim));
    expectRefusal(await submit(holder.client, companyId, 'claimed'), 409, 'validation.revision_conflict', 'already_managing');
    const upgrade = ok<{ claim: Claim }>(await submit(holder.client, companyId, 'verified')).claim;
    assert.equal(upgrade.state, 'open');
    ok(await decide(reviewer, upgrade));
    assert.deepEqual([await statusOf(companyId), await roleOf(holder.id, companyId)], ['verified', 'administrator']);
  });

  await t.test('revocation needs the permission and a reason, ends the role and derives the status again', async () => {
    const companyId = await page('Synthetic Revoked Builders');
    const person = await claimant('Synthetic Revoked Administrator', 'admin@revoked.synthetic.invalid');
    ok(await decide(reviewer, ok<{ claim: Claim }>(await submit(person.client, companyId, 'verified')).claim));
    const [handover] = ok<{ items: Array<{ id: string; level: string; membershipId: string | null }> }>(await reviewer.get(`${base}/claims/handovers?companyId=${companyId}`)).items;
    assert.ok(handover?.membershipId);
    assert.equal(ok<{ handovers: Array<Record<string, unknown>> }>(await person.client.get('/v1/claims')).handovers.filter((x) => x.companyId === companyId).length, 1);
    const url = `${base}/claims/handovers/${handover.id}/revoke`;
    assert.equal((await command(w.clients.moderator, url, { revocationReason: 'Signatory authority withdrawn.' })).status, 404);
    assert.equal((await command(w.clients.ops, `/v1/admin/hubs/${otherHubId}/claims/handovers/${handover.id}/revoke`, { revocationReason: 'Signatory authority withdrawn.' })).status, 404);
    assert.equal((await command(reviewer, url, { revocationReason: 'Too short' })).status, 422);
    ok(await command(reviewer, url, { revocationReason: 'Signatory authority withdrawn by the company.' }));
    assert.deepEqual([await statusOf(companyId), await roleOf(person.id, companyId)], ['unclaimed', null]);
    assert.ok((await notices(person.client)).some((n) => n.params.outcome === 'revoked'));
    expectRefusal(await command(reviewer, url, { revocationReason: 'Signatory authority withdrawn by the company.' }), 409, 'validation.revision_conflict', 'invalid_transition');
  });

  await t.test('claim settings need the policy permission; a new waiting period applies to the next claim', async () => {
    expectRefusal(await command(w.clients.moderator, `${base}/claims/settings`, { waitingDays: 3, coolingDays: 5 }), 403, 'access.forbidden', 'forbidden');
    assert.equal((await command(reviewer, `${base}/claims/settings`, { waitingDays: 0, coolingDays: 5 })).status, 422);
    const set = ok<{ settings: { waitingDays: number; coolingDays: number } }>(await command(reviewer, `${base}/claims/settings`, { waitingDays: 3, coolingDays: 5 })).settings;
    assert.deepEqual([set.waitingDays, set.coolingDays], [3, 5]);
    assert.equal(ok<{ settings: { waitingDays: number } }>(await reviewer.get(`${base}/claims`)).settings.waitingDays, 3);
    const companyId = await page('Synthetic Short Wait Builders', 'shortwait.synthetic.invalid');
    const holder = await claimant('Synthetic Short Wait Holder', 'holder@shortwait.synthetic.invalid');
    ok(await decide(reviewer, ok<{ claim: Claim }>(await submit(holder.client, companyId, 'claimed', { kind: 'own_domain_mailbox', email: 'holder@shortwait.synthetic.invalid' })).claim));
    const challenger = await claimant('Synthetic Short Wait Challenger', 'challenger@elsewhere2.synthetic.invalid');
    const waiting = ok<{ claim: Claim }>(await submit(challenger.client, companyId, 'verified')).claim;
    assert.equal(Math.round((Date.parse(waiting.waitingUntil as string) - Date.now()) / DAY), 3);
    ok(await command(reviewer, `${base}/claims/settings`, { waitingDays: 7, coolingDays: 7 }));
  });

  await t.test('notices reach e-mail through the hub\'s active text in the same transaction', async () => {
    const template = await withMaintenance(admin, (trx) => trx.insertInto('message_template').values({ hub_id: hubId, key: 'claims.claim_update', category: 'account', transactional: true }).returning('id').executeTakeFirstOrThrow());
    const version = await withMaintenance(admin, (trx) => trx.insertInto('template_version').values({ template_id: template.id, version: 1, locale: 'en', subject: 'Your claim on {companyName}', body: 'Outcome: {outcome}',
      drafted_by_person_id: w.people.hubOwner }).returning('id').executeTakeFirstOrThrow());
    await withMaintenance(admin, (trx) => trx.updateTable('template_version').set({ status: 'active', activated_by_person_id: w.people.lead2, activated_at: new Date() }).where('id', '=', version.id).execute());
    const companyId = await page('Synthetic Mailed Builders');
    const person = await claimant('Synthetic Mailed Claimant', 'mailed@mailed.synthetic.invalid');
    ok(await decide(reviewer, ok<{ claim: Claim }>(await submit(person.client, companyId, 'verified')).claim, 'rejected'));
    const { rows } = await admin.query<{ state: string; mail: string | null }>("SELECT d.state, d.mail_delivery_id AS mail FROM trustwork.delivery d JOIN trustwork.notification n ON n.id = d.notification_id WHERE d.recipient_person_id = $1 AND n.template_key = 'claims.claim_update'", [person.id]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.mail, JSON.stringify(rows));
    assert.equal(await count("SELECT 1 FROM trustwork.mail_delivery WHERE id = $1 AND template = 'notification' AND recipient = 'mailed@mailed.synthetic.invalid' AND params ->> 'subject' = 'Your claim on Synthetic Mailed Builders'", [rows[0]!.mail]), 1);
    // Without a text in a served language the delivery settles as skipped; nothing stays queued behind a claim.
    assert.equal(await count("SELECT 1 FROM trustwork.delivery d JOIN trustwork.notification n ON n.id = d.notification_id WHERE n.template_key LIKE 'claims.%' AND d.state = 'queued' AND d.mail_delivery_id IS NULL", []), 0);
  });
});
