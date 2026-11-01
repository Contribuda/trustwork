import { FakeMailTransport, mailConfigFromEnv } from '../../../apps/worker/src/mail/index.js';
import { buildRegistry } from '../../../apps/worker/src/main.js';
import { Metrics, silentLogger, Worker } from '../../../apps/worker/src/index.js';
import { drain } from '../../worker/mail/helpers/stack.js';
import { sql } from 'kysely';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { expectError, SKIP_REASON, startHarness, type Client } from '../../backend/helpers/app.js';
import { login, seedPersonas, PASSWORDS, type PersonaKey } from '../../backend/helpers/personas.js';
import { elevate, enrol, nextCode, secondStep, type Enrolled } from '../../backend/second-factor/helpers.js';
import { draft, ok, workerLogin } from '../../assistant/helpers.js';
import { adminSetup, staffRoleDefinitions } from '../../../packages/data/src/repositories/admin.js';
import { baselineIds } from '../../screening-lists/helpers.js';
import { activateList, CONS_ENTRIES, screen, SDN_ENTRIES } from '../../screening/helpers.js';
import { fakeGate, restrictedPlaces } from '../../../packages/contracts/src/sanctions.js';
import { RESTRICTED } from '../../../packages/country-packs/src/restricted.js';

/**
 * SANC-007 through the existing SANC-003 API (Fastify inject, real PostgreSQL): own status words, a fresh
 * step-up, the staff queue and decisions behind an elevation, suspension of a confirmed person (sessions end, the
 * agent's mandates stop, only the compliance self-service routes answer) and the lift after a two-person reversal.
 * Every name is synthetic.
 */
const h = await startHarness('sanc007_api', { jurisdictionGate: fakeGate(restrictedPlaces(RESTRICTED.places.map((p) => p.code))) });

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

  await t.test('anonymous, other-person and staff data never enter the participant projection', async () => {
    expectError(await h.client().get('/v1/screening/me', { remoteAddress: '192.0.2.10' }), 451, 'jurisdiction.restricted');
    expectError(await h.client().post('/v1/screening/me/appeal', { companyId: null, reason: 'Synthetic' }, { remoteAddress: '192.0.2.10' }), 451, 'jurisdiction.restricted');
    assert.equal((await h.client().get('/v1/screening/me')).status, 401);
    expectError(await petr.get(`/v1/screening/me?personId=${people.anna}`), 422, 'validation.unknown_field');
    expectError(await petr.post('/v1/screening/me/appeal', { companyId: seed.companies.unrelated, reason: 'Synthetic unauthorized appeal' }), 404, 'access.not_found');
    assert.equal((await h.db.app.query('SELECT * FROM trustwork.screening_appeal_assignment')).rows.length, 0);
    await assert.rejects(h.db.app.query("SELECT trustwork.screening_record_notice($1, 'hold')", [people.anna]));
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
    expectError(await back.post('/v1/auth/step-up', { password: 'wrong-password' }), 401, 'auth.invalid_credentials');
    assert.equal((await back.post('/v1/auth/step-up', { password: PASSWORDS.petr })).status, 200);
    const fresh = back;
    const body = { companyId: null, reason: 'Synthetic: that is not me' };
    const options = { idempotencyKey: 'sanc007-concurrent-appeal' };
    const concurrent = await Promise.all([fresh.post('/v1/screening/me/appeal', body, options), fresh.post('/v1/screening/me/appeal', body, options)]);
    assert.ok(concurrent.every((r) => r.status === 200 || r.status === 409));
    const appealed = ok<OwnStatus>(await fresh.post('/v1/screening/me/appeal', body, options));
    const once = await h.db.admin.query("SELECT id FROM trustwork.screening_decision WHERE match_id = $1 AND kind = 'appeal'", [matchId]);
    assert.equal(once.rows.length, 1, 'concurrent/replayed submission records one appeal and one assignment');
    assert.deepEqual([appealed.status, appealed.canAppeal], ['appeal_pending', false]);
  });

  await t.test('the appeal goes to another reviewer; the reversal needs a second person other than the proposer; then the account is back', async () => {
    const anna = await staffClient('anna');
    expectError(await anna.post(`/v1/admin/screening/matches/${matchId}/appeal-decision`, { decision: 'uphold', reason: 'Synthetic', evidence: 'other' }), 403, 'access.forbidden');
    const assignment = ok<{ assignment: { reviewerId: string; appealId: string; originalDecisionId: string } }>(await anna.get(`/v1/admin/screening/matches/${matchId}/appeal-assignment`)).assignment;
    assert.equal(assignment.reviewerId, people.boris);
    const stored = await h.db.admin.query('SELECT d.reason, a.original_decider FROM trustwork.screening_appeal_assignment a JOIN trustwork.screening_decision d ON d.id = a.appeal_id WHERE a.match_id = $1', [matchId]);
    assert.equal(stored.rows[0].reason, 'Synthetic: that is not me');
    assert.equal(stored.rows[0].original_decider, people.anna);
    const outsider = h.client();
    await login(outsider, 'carl');
    expectError(await outsider.get(`/v1/admin/screening/matches/${matchId}/appeal-assignment`), 403, 'access.forbidden');
    // Even maintenance cannot create a routing record that assigns the original decider.
    await assert.rejects(withMaintenance(h.db.admin, (trx) => sql`INSERT INTO trustwork.screening_appeal_assignment
      (appeal_id, match_id, original_decision_id, original_decider, reviewer_id)
      VALUES (${assignment.originalDecisionId}::uuid, ${matchId}::uuid, ${assignment.originalDecisionId}::uuid, ${people.anna}::uuid, ${people.anna}::uuid)`.execute(trx)));
    const boris = await staffClient('boris');
    const routingUrl = `/v1/admin/screening/matches/${matchId}/appeal-assignment`;
    const routing = { expectedVersion: 1, reviewerId: people.boris, reason: 'Synthetic reassignment review' };
    expectError(await anna.post(routingUrl, routing), 403, 'access.forbidden');
    expectError(await outsider.post(routingUrl, routing), 403, 'access.forbidden');
    for (const reviewerId of [people.anna, people.petr, people.carl]) {
      expectError(await boris.post(routingUrl, { ...routing, reviewerId }), 403, 'access.forbidden');
    }
    expectError(await boris.post(routingUrl, { ...routing, expectedVersion: 99 }), 409, 'validation.revision_conflict');
    assert.equal((await boris.post(routingUrl, { ...routing, law: 'invented' })).status, 422);
    const concurrentRoutes = await Promise.all([
      boris.post(routingUrl, { ...routing, reviewerId: null }),
      boris.post(routingUrl, routing),
    ]);
    assert.deepEqual(concurrentRoutes.map((r) => r.status).sort(), [200, 409]);
    const afterRace = ok<{ assignment: { version: number } }>(await boris.get(routingUrl)).assignment;
    assert.equal(afterRace.version, 2);
    const options = { idempotencyKey: 'sanc007-routing-replay' };
    const body = { ...routing, expectedVersion: 2 };
    const assigned = await boris.post(routingUrl, body, options);
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.deepEqual((await boris.post(routingUrl, body, options)).body, assigned.body);
    assert.equal((await h.db.admin.query('SELECT * FROM trustwork.screening_appeal_routing_history WHERE appeal_id = $1', [assignment.appealId])).rows.length, 3);
    assert.equal((await h.db.admin.query("SELECT * FROM trustwork.admin_audit_event WHERE action = 'screening.appeal_reassigned' AND object_id = $1", [matchId])).rows.length, 2);
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
  await t.test('holds retain denial and produce hold/cleared notices; all real transitions reach fake mail through the outbox once', async () => {
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('person_mail_locale').values({ person_id: people.carl, locale: 'es', source: 'sign_in' }).onConflict((oc) => oc.column('person_id').doUpdateSet({ locale: 'es' })).execute());
    const held = await withMaintenance(h.db.admin, async (trx) => {
      return trx.insertInto('jurisdiction_hold').values({ person_id: people.carl, place: 'RU', source: 'staff_report', dataset: 'synthetic-local-fixture' }).returning('id').executeTakeFirstOrThrow();
    });
    const carl = h.client();
    const refused = await carl.post('/v1/auth/login', { email: 'carl@example.invalid', password: PASSWORDS.carl }, { idempotencyKey: null });
    assert.equal(refused.status, 403);
    const reviewer = await staffClient('boris');
    assert.equal((await reviewer.post(`/v1/admin/jurisdiction/holds/${held.id}/clear`, { reason: 'Synthetic location evidence reviewed', evidence: 'document' })).status, 200);
    const intents = await h.db.admin.query("SELECT id, params, recipient FROM trustwork.mail_delivery WHERE template = 'screening_notice'");
    const kinds = new Set(intents.rows.map((r) => r.params.kind));
    for (const kind of ['hold', 'cleared', 'review', 'decision', 'appeal_received', 'appeal_outcome']) assert.ok(kinds.has(kind), kind);
    for (const row of intents.rows) assert.deepEqual(Object.keys(row.params), ['kind']);
    const payloads = await h.db.admin.query("SELECT payload FROM trustwork.outbox_event WHERE type = 'mail.requested' AND aggregate_id = ANY($1::text[])", [intents.rows.map((r) => r.id)]);
    assert.equal(payloads.rows.length, intents.rows.length);
    assert.ok(payloads.rows.every((r) => JSON.stringify(r.payload) === '{}'));
    // A rolled-back hold and its notice must both disappear.
    const before = intents.rows.length;
    await assert.rejects(withMaintenance(h.db.admin, async (trx) => {
      await trx.insertInto('jurisdiction_hold').values({ person_id: people.pure, place: 'RU', source: 'staff_report', dataset: 'synthetic-rollback' }).execute();
      throw new Error('synthetic rollback');
    }));
    assert.equal((await h.db.admin.query("SELECT id FROM trustwork.mail_delivery WHERE template = 'screening_notice'")).rows.length, before);
    const transport = new FakeMailTransport();
    const metrics = new Metrics();
    const registry = buildRegistry({ pool: worker, metrics, log: silentLogger, mail: mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_PUBLIC_ORIGIN: 'https://hub.example.invalid', MAIL_RECIPIENT_LIMIT_PER_HOUR: '100' }), mailTransport: transport });
    const mailWorker = new Worker({ pool: worker, registry, metrics, config: { concurrency: 2 }, tasks: () => [] });
    await drain(mailWorker);
    const first = transport.sent.length;
    await drain(mailWorker);
    assert.equal(transport.sent.length, first, 'no duplicate delivery');
    const notices = transport.sent.filter((m) => m.text.includes('/app/settings/account/compliance'));
    assert.equal(notices.length, intents.rows.length);
    for (const notice of notices) {
      assert.doesNotMatch(notice.text + notice.html + notice.subject, /Fictivsky|OFAC|SDN|920002|SYNTHETIC-B|synthetic-local-fixture|Synthetic:|reviewerId|matchId/i);
      assert.ok(['petr@example.invalid', 'carl@example.invalid'].includes(notice.to));
      if (notice.to === 'carl@example.invalid') assert.equal(notice.locale, 'es', 'recipient language, never the reviewer language');
    }
    assert.equal((await h.db.admin.query("SELECT id FROM trustwork.mail_delivery WHERE template = 'screening_notice' AND (state <> 'sent' OR recipient IS NOT NULL)")).rows.length, 0);
    await mailWorker.stop(200);
  });

  await t.test('routing fails closed when the only different reviewer is held; no assignment is invented', async () => {
    await withMaintenance(h.db.admin, async (trx) => {
      await trx.updateTable('person').set({ display_name: 'Milo Fictivsky' }).where('id', '=', people.pure).execute();
      await trx.insertInto('jurisdiction_hold').values({ person_id: people.boris, place: 'RU', source: 'staff_report', dataset: 'synthetic-held-reviewer' }).execute();
    });
    await screen(worker, { kind: 'person', id: people.pure }, undefined, 'name_change');
    const id = (await h.db.admin.query('SELECT id FROM trustwork.screening_match WHERE subject_person_id = $1', [people.pure])).rows[0].id;
    const anna = await staffClient('anna');
    assert.equal((await anna.post(`/v1/admin/screening/matches/${id}/confirm`, { reason: 'Synthetic confirmation', evidence: 'identity_document' })).status, 200);
    const subject = h.client();
    await login(subject, 'pure');
    assert.equal((await subject.post('/v1/screening/me/appeal', { companyId: null, reason: 'Synthetic evidence for review' })).status, 200);
    const route = ok<{ assignment: { reviewerId: string | null } }>(await anna.get(`/v1/admin/screening/matches/${id}/appeal-assignment`));
    assert.equal(route.assignment.reviewerId, null);
    expectError(await anna.post(`/v1/admin/screening/matches/${id}/appeal-decision`, { decision: 'uphold', reason: 'Synthetic', evidence: 'other' }), 403, 'access.forbidden');
  });

});
