import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { expectError, SKIP_REASON, startHarness, type Client } from '../backend/helpers/app.js';
import { login, seedPersonas, type PersonaKey } from '../backend/helpers/personas.js';
import { elevate, enrol, nextCode, secondStep, type Enrolled } from '../backend/second-factor/helpers.js';
import { draft, ok, workerLogin } from '../assistant/helpers.js';
import { adminSetup, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { baselineIds } from '../screening-lists/helpers.js';
import { activateList, CONS_ENTRIES, screen, SDN_ENTRIES } from './helpers.js';

/**
 * SANC-003 through the API (Fastify inject, real PostgreSQL): the subject's own status words, the appeal with a fresh
 * step-up, the staff queue and decisions behind an elevation, suspension of a confirmed person (sessions end, the
 * agent's mandates stop, only the compliance self-service routes answer) and the lift after a two-person reversal.
 * Every name is synthetic.
 */
const h = await startHarness('screening_api');

interface OwnStatus { subject: { kind: string; id: string }; status: string; paymentsPaused: boolean; canAppeal: boolean; messageKeys: string[] }
interface MatchView { id: string; state: string; pendingApproval: { actionDigest: string } | null }

test('screening through the API', { skip: h ? false : SKIP_REASON, timeout: 240_000 }, async (t) => {
  if (!h) return;
  const workers = await workerLogin(h);
  t.after(async () => {
    await workers.close();
    await h.close();
  });
  const worker = workers.pool(4);
  const seed = await seedPersonas(h);
  const people = seed.people;
  await withMaintenance(h.db.admin, async (trx) => {
    const node = await adminSetup.createNode(trx, 'Synthetic screening node');
    await staffRoleDefinitions.release(trx, { version: 1, role: 'compliance-officer', scopes: ['node', 'hub'], permissions: ['admin.claims.read', 'admin.claims.decide'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    for (const key of ['anna', 'boris'] as const) await adminSetup.bootstrapFirstAdmin(trx, { personId: people[key], role: 'compliance-officer', scope: { kind: 'node', nodeId: node.id }, definitionVersion: 1, reason: 'Synthetic setup' });
    await trx.updateTable('screening_list').set({ min_entries: 1, max_drop_share: '0.99' }).where('baseline', '=', true).execute();
  });
  for (const key of ['anna', 'boris'] as const) h.staff.set(people[key], ['trust-reviewer']);
  const lists = await baselineIds(h.db.admin);
  await activateList(worker, lists.sdn, SDN_ENTRIES);
  await activateList(worker, lists.cons, CONS_ENTRIES);

  const enrolled = new Map<PersonaKey, Enrolled>();
  const staffClient = async (key: PersonaKey): Promise<Client> => {
    const client = h.client();
    await login(client, key);
    if (!enrolled.has(key)) enrolled.set(key, await enrol(h, client));
    else assert.equal((await secondStep(client, { method: 'totp', code: nextCode(h, enrolled.get(key)!.secret) })).status, 200);
    await elevate(h, client, enrolled.get(key)!.secret);
    return client;
  };

  // Petr's account name matches a synthetic entry; his agent holds a mandate.
  const petr = h.client();
  await login(petr, 'petr');
  const project = ok<{ id: string }>(await petr.post('/v1/projects', { owner: { kind: 'person', id: people.petr }, name: 'Synthetic porch', summary: null, leaderPersonId: null }), 201);
  const mandate = ok<{ id: string; status: string }>(await petr.post('/v1/assistant/mandates', { draft: draft({ moduleKeys: ['project_planner'], actions: ['prepare'], contexts: [{ kind: 'project', id: project.id }] }) }), 201);
  await withMaintenance(h.db.admin, (trx) => trx.updateTable('person').set({ display_name: 'Milo Fictivsky' }).where('id', '=', people.petr).execute());
  assert.equal((await screen(worker, { kind: 'person', id: people.petr }, undefined, 'name_change')).outcome, 'possible_match');

  await t.test('a possible match: status words only, payments paused, nothing else refused', async () => {
    const own = ok<OwnStatus>(await petr.get('/v1/screening/me'));
    assert.deepEqual([own.status, own.paymentsPaused, own.canAppeal], ['review', true, false]);
    assert.ok(own.messageKeys.includes('screening.paymentsPaused'));
    const text = JSON.stringify(own).toLowerCase();
    for (const leak of ['fictivsky', 'ofac', '920002', 'synthetic-b', 'matched', 'entry']) assert.ok(!text.includes(leak), `the subject is never told ${leak}`);
    assert.equal((await petr.get('/v1/projects')).status, 200, 'a possible match never blocks the account');
    const again = h.client();
    await login(again, 'petr');
    assert.equal((await again.get('/v1/me')).status, 200, 'nor sign-in');
    expectError(await petr.get(`/v1/screening/me?companyId=${seed.companies.unrelated}`), 404, 'access.not_found');
    const carl = h.client();
    await login(carl, 'carl');
    assert.equal(ok<OwnStatus>(await carl.get(`/v1/screening/me?companyId=${seed.companies.unrelated}`)).status, 'checking', 'an administrator reads their company status (not yet screened)');
  });

  let matchId = '';
  await t.test('staff routes need a compliance role and an elevation; the queue names subjects only to compliance staff', async () => {
    expectError(await petr.get('/v1/admin/screening/queue'), 403, 'access.forbidden');
    const plainAnna = h.client();
    await login(plainAnna, 'anna');
    expectError(await plainAnna.get('/v1/admin/screening/queue'), 403, 'access.forbidden');
    const anna = await staffClient('anna');
    const queue = ok<{ serviceLevelDays: number; items: { subject: { id: string }; subjectStateId: string; late: boolean }[] }>(await anna.get('/v1/admin/screening/queue'));
    assert.equal(queue.serviceLevelDays, 1);
    const item = queue.items.find((i) => i.subject.id === people.petr);
    assert.ok(item);
    const subject = ok<{ matches: MatchView[] }>(await anna.get(`/v1/admin/screening/subjects/${item.subjectStateId}`));
    matchId = subject.matches[0]!.id;
    assert.equal(subject.matches[0]?.state, 'open');
  });

  await t.test('confirm suspends: sessions end, the mandate stops, only self-service routes answer; the appeal needs a fresh step-up', async () => {
    const anna = await staffClient('anna');
    const confirmed = ok<{ match: MatchView }>(await anna.post(`/v1/admin/screening/matches/${matchId}/confirm`, { reason: 'Synthetic: identifiers match', evidence: 'registration_identifier' }));
    assert.equal(confirmed.match.state, 'confirmed');
    expectError(await petr.get('/v1/me'), 401, 'auth.session_invalid');
    const status = await h.db.admin.query<{ status: string }>('SELECT status FROM trustwork.mandate WHERE id = $1', [mandate.id]);
    assert.equal(status.rows[0]?.status, 'suspended', "the person's agent stops");
    const back = h.client();
    await login(back, 'petr');
    expectError(await back.get('/v1/projects'), 403, 'auth.compliance_suspended');
    expectError(await back.get('/v1/me/sessions'), 403, 'auth.compliance_suspended');
    expectError(await back.post('/v1/projects', { owner: { kind: 'person', id: people.petr }, name: 'x', summary: null, leaderPersonId: null }), 403, 'auth.compliance_suspended');
    assert.equal((await back.get('/v1/me')).status, 200);
    const own = ok<OwnStatus>(await back.get('/v1/screening/me'));
    assert.deepEqual([own.status, own.canAppeal], ['suspended', true]);
    // The clock only moves forward here (the staff second factors' replay protection is per time step).
    h.clock.advance(11 * 60_000);
    expectError(await back.post('/v1/screening/me/appeal', { companyId: null, reason: 'Synthetic: that is not me' }), 403, 'auth.step_up_required');
    const fresh = h.client();
    await login(fresh, 'petr');
    const appealed = ok<OwnStatus>(await fresh.post('/v1/screening/me/appeal', { companyId: null, reason: 'Synthetic: that is not me' }));
    assert.deepEqual([appealed.status, appealed.canAppeal], ['appeal_pending', false]);
  });

  await t.test('the appeal goes to another reviewer; the reversal needs a second person other than the proposer; then the account is back', async () => {
    const anna = await staffClient('anna');
    expectError(await anna.post(`/v1/admin/screening/matches/${matchId}/appeal-decision`, { decision: 'uphold', reason: 'Synthetic', evidence: 'other' }), 403, 'access.forbidden');
    const boris = await staffClient('boris');
    const proposed = ok<{ match: MatchView }>(await boris.post(`/v1/admin/screening/matches/${matchId}/appeal-decision`, { decision: 'propose_reversal', reason: 'Synthetic: identifiers belong to someone else', evidence: 'identity_document' }));
    assert.equal(proposed.match.state, 'pending_reversal');
    const digest = proposed.match.pendingApproval!.actionDigest;
    expectError(await boris.post(`/v1/admin/screening/matches/${matchId}/proposal-decision`, { decision: 'approve', actionDigest: digest, reason: 'Synthetic' }), 403, 'access.second_approver_required');
    // The second person may be anyone with the role but the proposer (here the reviewer who first confirmed).
    const second = await staffClient('anna');
    expectError(await second.post(`/v1/admin/screening/matches/${matchId}/proposal-decision`, { decision: 'approve', actionDigest: 'f'.repeat(64), reason: 'Synthetic' }), 409, 'access.approval_digest_mismatch');
    const approved = ok<{ match: MatchView }>(await second.post(`/v1/admin/screening/matches/${matchId}/proposal-decision`, { decision: 'approve', actionDigest: digest, reason: 'Synthetic: agreed' }));
    assert.equal(approved.match.state, 'not_same_person');
    const petrAgain = h.client();
    await login(petrAgain, 'petr');
    assert.equal((await petrAgain.get('/v1/projects')).status, 200);
    assert.deepEqual(ok<OwnStatus>(await petrAgain.get('/v1/screening/me')).status, 'clear');
    const drafts = ok<{ items: { matchId: string; status: string }[] }>(await second.get('/v1/admin/screening/report-drafts'));
    assert.ok(drafts.items.some((d) => d.matchId === matchId && d.status === 'draft'), 'the report draft stays on record');
  });
});
