import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { SKIP_REASON, startHarness, expectError, type Response } from '../../../backend/helpers/app.js';
import { buildSupportWorld, query } from '../../../support/helpers.js';
import { screen } from '../../../screening/helpers.js';
import { screeningWorld } from './world.js';

const h = await startHarness('sanc006_card');
const S = '/v1/admin/support';

/**
 * Console design section 4.1 and the package's fourth criterion, on real PostgreSQL through the API with real elevated
 * sessions: staff without the screening role see neither the status nor its absence. No hub legal setting for the
 * restricted-servicing notice exists yet, so the notice is shown to nobody.
 */
test('SANC-006 card: other staff see neither the status nor its absence', { skip: h ? false : SKIP_REASON, timeout: 120_000 }, async (t) => {
  if (!h) return;
  const w = await buildSupportWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients; const p = w.people;
  await w.elevateAll();
  const opened = await c.customer.post('/v1/support/cases', { hubId: w.world.hubId, category: 'account_access', summary: 'Synthetic: I cannot reach my account' });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const caseId = (opened.body as { case: { id: string } }).case.id;
  const card = async () => {
    const response = await query(c.agent, `${S}/cases/${caseId}/people/${p.customer}/account`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return (response.body as { account: Record<string, unknown> }).account;
  };
  const before = await card();
  let stateId = '';
  await withMaintenance(h.db.admin, async (trx) => {
    await trx.insertInto('jurisdiction_hold').values({ person_id: p.customer, place: 'CU', source: 'geolocation', dataset: 'synthetic-fake' }).execute();
    stateId = (await trx.insertInto('screening_subject_state').values({ subject_person_id: p.customer, names_digest: 'a'.repeat(64), last_outcome: 'possible_match', money_held: true }).returning('id').executeTakeFirstOrThrow()).id;
  });

  await t.test('the support account card is the same with an open hold and a held state, and carries no compliance word', async () => {
    const after = await card();
    assert.deepEqual(after, before);
    assert.doesNotMatch(Object.keys(after).join(' '), /screen|sanction|hold|complian|restrict|jurisdiction|money/i);
  });

  await t.test('support, moderator and auditor get one answer whether the subject has a state, has none or does not exist', async () => {
    for (const key of ['agent', 'lead', 'moderator', 'auditor'] as const) {
      const lookup = (id: string) => c[key].get(`/v1/admin/screening/subjects/lookup/person/${id}`);
      const screened = answer(await lookup(p.customer));
      assert.ok(screened.status === 403 || screened.status === 404, `${key}: ${JSON.stringify(screened)}`);
      assert.deepEqual(answer(await lookup(p.outsider)), screened, key);
      assert.deepEqual(answer(await lookup(randomUUID())), screened, key);
      const byState = (id: string) => c[key].get(`/v1/admin/screening/subjects/${id}`);
      assert.deepEqual(answer(await byState(stateId)), answer(await byState(randomUUID())), `${key}: the state id opens nothing`);
      assert.ok([403, 404].includes((await byState(stateId)).status), key);
      const queue = await c[key].get('/v1/admin/screening/queue');
      assert.ok([403, 404].includes(queue.status), `${key}: ${JSON.stringify(queue.body)}`);
    }
  });

  await t.test('holds and the queue stay closed to them', async () => {
    for (const key of ['agent', 'lead', 'moderator'] as const) {
      for (const route of ['/v1/admin/jurisdiction/holds', '/v1/admin/screening/queue']) {
        const response = await c[key].get(route);
        const items = (response.body as { items?: unknown[] }).items;
        assert.ok(response.status >= 400 || items?.length === 0, `${key} ${route}: ${JSON.stringify(response.body)}`);
      }
    }
  });
});

const answer = (r: Response) => { const rest = { ...(r.body as Record<string, unknown>) }; delete rest.requestId; return { status: r.status, rest }; };

/** Every read that carries a named subject's status, list entry, reasons or deciders, by the ids a reader could hold. */
const panelRoutes = (subject: { kind: 'person' | 'company'; id: string }, stateId: string, matchId: string) => [
  `/v1/admin/screening/subjects/lookup/${subject.kind}/${subject.id}`, `/v1/admin/screening/subjects/${stateId}`, `/v1/admin/screening/matches/${matchId}`, `/v1/admin/screening/matches/${matchId}/appeal-assignment`,
];

async function caseOf(w: Awaited<ReturnType<typeof screeningWorld>>, subject: { kind: 'person' | 'company'; id: string }) {
  const column = subject.kind === 'person' ? 'subject_person_id' : 'subject_company_id';
  const state = await withMaintenance(w.h.db.admin, (trx) => trx.selectFrom('screening_subject_state').select('id').where(column, '=', subject.id).executeTakeFirstOrThrow());
  const match = await withMaintenance(w.h.db.admin, (trx) => trx.selectFrom('screening_match').select('id').where(column, '=', subject.id).executeTakeFirstOrThrow());
  return { stateId: state.id, matchId: match.id };
}

/** The filter on reads, on real PostgreSQL through the API with real elevated sessions; `second` stays independent. */
test('SANC-006 reads: an officer who is the subject, a member of the subject company or conflicted reads nothing about that subject', { timeout: 240_000 }, async (t) => {
  const w = await screeningWorld('sanc006_conflict_reads'); t.after(() => w.close());
  const { first: officer, second: independent } = w;
  const queued = async (client: typeof officer) => ((await client.get('/v1/admin/screening/queue')).body as { items: { subject: { id: string } }[] }).items.map((item) => item.subject.id);
  /** The conflicted officer's answers equal the answers about ids that do not exist; the independent one reads on. */
  const closed = async (subject: { kind: 'person' | 'company'; id: string }, label: string) => {
    const { stateId, matchId } = await caseOf(w, subject);
    const real = panelRoutes(subject, stateId, matchId);
    const absent = panelRoutes({ kind: subject.kind, id: randomUUID() }, randomUUID(), randomUUID());
    for (const [index, route] of real.entries()) {
      const response = await officer.get(route);
      expectError(response, 404, 'access.not_found');
      assert.deepEqual(answer(response), answer(await officer.get(absent[index]!)), `${label}: ${route}`);
      assert.doesNotMatch(JSON.stringify(response.body), /moneyHeld|entryName|listCode|decidedBy|reason"/, `${label}: ${route}`);
    }
    assert.ok(!(await queued(officer)).includes(subject.id), `${label}: the queue leaves the subject out`);
    assert.equal((await independent.get(real[0]!)).status, 200, `${label}: another officer still reads the panel`);
    assert.equal((await independent.get(real[1]!)).status, 200, label);
    assert.equal((await independent.get(real[2]!)).status, 200, label);
    assert.ok((await queued(independent)).includes(subject.id), `${label}: the queue still has it for another officer`);
  };
  const open = async (subject: { kind: 'person' | 'company'; id: string }, label: string) => {
    const { stateId, matchId } = await caseOf(w, subject);
    for (const route of panelRoutes(subject, stateId, matchId).slice(0, 3)) assert.equal((await officer.get(route)).status, 200, `${label}: ${route}`);
    assert.ok((await queued(officer)).includes(subject.id), label);
  };
  const petr = { kind: 'person' as const, id: w.seed.people.petr };
  // The officer's own employer, under a listed name, so that the membership conflict is real.
  const company = { kind: 'company' as const, id: w.seed.companies.mixed };
  await withMaintenance(w.h.db.admin, (trx) => trx.updateTable('company').set({ display_name: 'NORTHWIND SYNTHETIC SUPPLY LLC' }).where('id', '=', company.id).execute());
  await screen(w.worker, company);

  await t.test('an officer without a conflict reads the subject, which proves the refusals below', async () => {
    await open(petr, 'independent');
  });
  await t.test('the subject', async () => {
    const anna = { kind: 'person' as const, id: w.seed.people.anna };
    await withMaintenance(w.h.db.admin, (trx) => trx.updateTable('person').set({ display_name: 'Milo Fictivsky' }).where('id', '=', anna.id).execute());
    await screen(w.worker, anna);
    await closed(anna, 'the subject');
  });
  await t.test('a member of the subject company', async () => {
    await closed(company, 'the member');
    await withMaintenance(w.h.db.admin, (trx) => trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: w.seed.people.anna, ended_reason: 'Synthetic departure' })
      .where('person_id', '=', w.seed.people.anna).where('company_id', '=', company.id).execute());
    await open(company, 'after leaving');
  });
  await t.test('a declared conflict, for as long as it stands; report drafts leave the subject out as well', async () => {
    const { matchId } = await caseOf(w, petr);
    const confirmed = await independent.post(`/v1/admin/screening/matches/${matchId}/confirm`, { reason: 'Synthetic confirmation', evidence: 'date_of_birth' });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const drafts = async () => ((await officer.get('/v1/admin/screening/report-drafts')).body as { items: { matchId: string }[] }).items.map((item) => item.matchId);
    assert.ok((await drafts()).includes(matchId));
    const declared = (await w.h.db.admin.query<{ id: string }>("INSERT INTO trustwork.staff_conflict_declaration(staff_person_id,conflict_person_id,reason) VALUES($1,$2,'Synthetic declared conflict') RETURNING id", [w.seed.people.anna, petr.id])).rows[0]!.id;
    const { stateId } = await caseOf(w, petr);
    for (const route of panelRoutes(petr, stateId, matchId)) expectError(await officer.get(route), 404, 'access.not_found');
    assert.ok(!(await drafts()).includes(matchId));
    await w.h.db.admin.query('UPDATE trustwork.staff_conflict_declaration SET ended_at=now() WHERE id=$1', [declared]);
    assert.equal((await officer.get(panelRoutes(petr, stateId, matchId)[1]!)).status, 200, 'the same officer reads again once the conflict has ended');
  });
});

/** Console design section 4.1: the panel is the compliance officer's, and a role in a hub is not that authority. */
test('SANC-006 reads: a node auditor reaches no panel route, also when holding the compliance role in a hub', { timeout: 240_000 }, async (t) => {
  const servedHubId = randomUUID();
  const w = await screeningWorld('sanc006_auditor_panel', 'https://trustwork.test', { auditorSecond: true, servedHubId }); t.after(() => w.close());
  const petr = { kind: 'person' as const, id: w.seed.people.petr };
  const { stateId, matchId } = await caseOf(w, petr);
  const routes = [...panelRoutes(petr, stateId, matchId), '/v1/admin/screening/queue'];
  const absent = [...panelRoutes({ kind: 'person', id: randomUUID() }, randomUUID(), randomUUID()), '/v1/admin/screening/queue'];
  const noPanel = async (label: string) => {
    for (const [index, route] of routes.entries()) {
      const response = await w.second.get(route);
      expectError(response, 404, 'access.not_found');
      assert.deepEqual(answer(response), answer(await w.second.get(absent[index]!)), `${label}: ${route}`);
      assert.equal(answer(response).status, answer(await w.otherStaff.get(route)).status, `${label}: the same answer as any other staff member`);
    }
  };
  await t.test('the officer reads them, the auditor does not', async () => {
    for (const route of routes.slice(0, 3)) assert.equal((await w.first.get(route)).status, 200, route);
    assert.equal((await w.first.get(routes[4]!)).status, 200);
    await noPanel('auditor');
  });
  await t.test('a compliance role scoped to a hub does not open them for the node auditor', async () => {
    // This world has one officer, so the second person a compliance role needs does not exist here; that approval has
    // its own tests. Only the resulting assignment matters, so it is written as a founding row with the guard off.
    const client = await w.h.db.admin.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query("INSERT INTO trustwork.staff_role_assignment(person_id,role,scope_kind,hub_id,definition_version,setup_bootstrap,reason) VALUES($1,'compliance-officer','hub',$2,1,true,'Synthetic hub role')", [w.seed.people.boris, w.hubId]);
      await client.query('COMMIT');
    } finally { client.release(); }
    const roles = (await w.second.get(`/v1/admin/access?nodeId=${w.node.id}`)).status;
    assert.equal(roles, 200, 'the auditor still has a working session');
    await noPanel('auditor with a hub role');
  });
});

