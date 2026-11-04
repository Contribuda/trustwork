import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { incidents, moderation, staffConflicts, supportCases } from '../../../packages/data/src/repositories/admin.js';
import { Client, SKIP_REASON, startHarness } from '../../backend/helpers/app.js';
import { command, companyCase, customerCase, expectRefusal } from '../helpers.js';
import { buildConsoleWorld, ids, kinds, search, seedConfigVersion, seedPipeline, type ConsoleWorld } from './helpers.js';

const h = await startHarness('console_search');

/**
 * ADM-005 acceptance: "A staff member never receives a search hit for an object they may not read" and "answers identical
 * nothing found for missing and unreadable objects", per role and scope, on real PostgreSQL under the runtime role and
 * through the HTTP API. `nothing()` compares the raw response with the one for an id that exists nowhere.
 */
test('console search (ADM-005)', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: ConsoleWorld = await buildConsoleWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const { hubId, otherHubId } = w;
  const hub = { kind: 'hub', hubId } as const;
  const otherHub = { kind: 'hub', hubId: otherHubId } as const;
  const inHub = { hubId };

  /** The reader gets exactly what they would get for an object that does not exist. */
  const nothing = async (client: Client, ref: string, target: { hubId?: string; nodeId?: string } = inHub, why = ''): Promise<void> => {
    const missing = await search(client, randomUUID(), target);
    const found = await search(client, ref, target);
    assert.deepEqual(found.hits, [], why);
    assert.equal(found.raw, missing.raw, why);
  };

  await t.test('negative: only an elevated staff member reaches the lookup, and what is not an identifier is refused without being repeated', async () => {
    const url = `/v1/admin/console/search?ref=${randomUUID()}&hubId=${hubId}`;
    expectRefusal(await new Client(w.app).get(url), 401, 'auth.session_invalid');
    expectRefusal(await c.customer.get(url), 403, 'access.forbidden', 'staff');
    expectRefusal(await c.otherAgent.get(url), 403, 'access.forbidden', 'staff');
    expectRefusal(await c.moderator.get(url), 403, 'access.forbidden', 'elevation');
    await w.elevateAll();
    for (const typed of ['maria.petrova@example.invalid', 'Maria Petrova', 'Maria', '+15550100123', 'maria petrova']) {
      const response = await c.owner.get(`/v1/admin/console/search?ref=${encodeURIComponent(typed)}&hubId=${hubId}`);
      assert.equal(response.status, 422, typed);
      assert.ok(!JSON.stringify(response.body).toLowerCase().includes('maria'), 'the refusal does not repeat the text');
      assert.ok(!JSON.stringify(response.body).includes('5550100123'), 'the refusal does not repeat the text');
    }
    expectRefusal(await c.owner.get(`/v1/admin/console/search?ref=${randomUUID()}&hubId=${hubId}&nodeId=${w.world.nodeId}`), 422, 'validation.schema');
    expectRefusal(await c.owner.get(`/v1/admin/console/search?ref=${randomUUID()}&q=anything`), 422, 'validation.unknown_field');
  });

  const incident = async (by: string, scope: typeof hub | typeof otherHub, title: string) =>
    w.actors.as(by, async (trx) => incidents.open(trx, await w.actors.elevate(by), { scope, kind: 'content', severity: 'sev3', title }));

  await t.test('an incident is found by whoever reads incidents at that hub, and by no one else', async () => {
    const row = await incident(p.owner, hub, 'Synthetic incident naming a participant');
    const { hits, raw } = await search(c.ops, row.id, inHub);
    assert.deepEqual(hits, [{ kind: 'incident', id: row.id, scope: hub, incidentKind: 'content', severity: 'sev3', status: 'open' }]);
    assert.ok(!raw.includes('naming a participant'), 'the title is not in a hit');
    await nothing(c.moderator, row.id);
    await nothing(c.lead, row.id);
    await nothing(c.auditor, row.id);
  });

  await t.test('negative: an object of another hub is not found, not even by someone who may read it there, unless they act on that hub', async () => {
    const elsewhere = await incident(p.owner, otherHub, 'Synthetic incident of the other hub');
    await nothing(c.ops, elsewhere.id, inHub, 'hub staff');
    await nothing(c.hubOwner, elsewhere.id, inHub, 'hub owner');
    await nothing(c.owner, elsewhere.id, inHub, 'platform owner acting on this hub');
    assert.deepEqual(ids((await search(c.owner, elsewhere.id, { hubId: otherHubId })).hits), [elsewhere.id], 'platform owner acting on that hub');
    await nothing(c.ops, elsewhere.id, { hubId: otherHubId }, 'a hub role grants nothing at another hub');
    await nothing(c.hubOwner, elsewhere.id, {}, 'at the platform');
    await nothing(c.hubOwner, elsewhere.id, { nodeId: w.world.nodeId }, 'at the node');
  });

  await t.test('negative: a support case needs a support role, and never shows its summary, its requester or its subject', async () => {
    const id = await customerCase(w);
    const row = await w.actors.owner((trx) => trx.selectFrom('support_case').select(['number']).where('id', '=', id).executeTakeFirstOrThrow());
    const { hits, raw } = await search(c.lead, id, inHub);
    assert.deepEqual(hits, [{ kind: 'support_case', id, scope: hub, number: Number(row.number), status: 'open' }]);
    for (const text of ['cannot open my project', p.customer, 'Synthetic Customer']) assert.ok(!raw.includes(text), text);
    assert.deepEqual(ids((await search(c.agent, String(row.number), inHub)).hits), [id], 'by its number');
    await nothing(c.moderator, id);
    await nothing(c.ops, id);
    await nothing(c.auditor, id);
    await nothing(c.moderator, String(row.number), inHub, 'by its number');
  });

  await t.test('negative: staff never find a case about themselves, their employer or a party they declared', async () => {
    // The support agent belongs to the customer's company: row-level security admits them, the conflict does not.
    const employer = await companyCase(w);
    await nothing(c.agent, employer, inHub, 'employer');
    assert.deepEqual(ids((await search(c.lead, employer, inHub)).hits), [employer]);

    const declared = await customerCase(w);
    assert.deepEqual(ids((await search(c.lead2, declared, inHub)).hits), [declared]);
    await w.actors.as(p.lead2, (trx) => staffConflicts.declare(trx, { kind: 'person', id: p.customer }, 'Synthetic: a relative'));
    await nothing(c.lead2, declared, inHub, 'declared party');

    // A lead's own support case, as a participant: the policy admits them as requester, the console does not.
    const own = (await w.actors.as(p.lead, (trx) => supportCases.openOwn(trx, { hubId, category: 'account_access', summary: 'Synthetic: my own account' }))).id;
    assert.equal(await w.actors.as(p.lead, async (trx) => (await supportCases.get(trx, own))?.id), own, 'the policy admits the requester');
    await nothing(c.lead, own, inHub, 'own case');
    assert.deepEqual(ids((await search(c.agent, own, inHub)).hits), [own]);
  });

  await t.test('negative: the participant side of a row is not a console read', async () => {
    const ctx = await w.actors.elevate(p.moderator);
    const about = await w.actors.as(p.moderator, (trx) => moderation.openCase(trx, ctx, { hubId, targetKind: 'publication', targetId: randomUUID(), subject: { kind: 'person', id: p.lead }, clauseCodes: ['community.spam'] }));
    assert.equal(await w.actors.as(p.lead, async (trx) => (await trx.selectFrom('moderation_case').select('id').where('id', '=', about.id).executeTakeFirst())?.id), about.id, 'the policy admits the subject');
    await nothing(c.lead, about.id, inHub, 'the subject of the case holds no moderation read');
    assert.deepEqual(kinds((await search(c.moderator, about.id, inHub)).hits), ['moderation_case']);
    await nothing(c.agent, about.id, inHub, 'no moderation read');
    // A moderator who is the case's subject holds the read and is still not shown it.
    const aboutModerator = await w.actors.owner((trx) => trx.insertInto('moderation_case').values({ hub_id: hubId, target_kind: 'publication', target_id: randomUUID(), subject_person_id: p.moderator, clause_codes: ['community.spam'], opened_by: p.hubOwner } as never).returning('id').executeTakeFirstOrThrow());
    await nothing(c.moderator, aboutModerator.id, inHub, 'about themselves');
    assert.deepEqual(kinds((await search(c.hubOwner, aboutModerator.id, inHub)).hits), ['moderation_case']);
  });

  await t.test('an approval is found by the people who may read it; its reason stays on its own screen', async () => {
    const subject = { action: 'staff.assign_sensitive_role', personId: p.candidate, role: 'hub-owner', scope: hub, definitionVersion: 1 };
    const requested = await command(c.owner, '/v1/admin/approvals', { subject, reason: 'Synthetic reason naming a participant' });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    const id = (requested.body as { approval: { id: string } }).approval.id;
    const { hits, raw } = await search(c.hubOwner, id, inHub);
    assert.deepEqual(hits, [{ kind: 'approval', id, scope: hub, action: 'staff.assign_sensitive_role', status: 'pending' }]);
    assert.ok(!raw.includes('naming a participant'));
    assert.ok(!raw.includes(p.candidate), 'whom it would change is not in a hit');
    await nothing(c.moderator, id);
    await nothing(c.lead, id);
    assert.deepEqual(ids((await search(c.auditor, id, inHub)).hits), [id], 'admin.audit.read at the scope');
  });

  await t.test('audit events: found by id, sequence or request id, for their readers; never by the object they are about', async () => {
    // A refused attempt about a participant leaves an audit row whose object is that person.
    expectRefusal(await command(c.moderator, '/v1/admin/staff/assignments', { personId: p.customer, role: 'editor', scope: hub, definitionVersion: 1 }), 403, 'access.forbidden');
    const { rows: [row] } = await h.db.admin.query<{ id: string; sequence: string; request_id: string; object_id: string }>(
      "SELECT id, sequence, request_id, object_id FROM trustwork.admin_audit_event WHERE actor_person_id = $1 AND outcome = 'denied' ORDER BY sequence DESC LIMIT 1", [p.moderator]);
    assert.ok(row);
    assert.equal(row.object_id, p.customer);
    const byId = await search(c.auditor, row.id, inHub);
    assert.deepEqual(kinds(byId.hits), ['audit_event']);
    assert.ok(!byId.raw.includes(p.customer), 'the object is not in a hit');
    assert.deepEqual(ids((await search(c.auditor, row.sequence, inHub)).hits), [row.id], 'by sequence');
    assert.deepEqual(ids((await search(c.auditor, row.request_id, inHub)).hits), [row.id], 'by request id');
    assert.deepEqual(ids((await search(c.moderator, row.id, inHub)).hits), [row.id], 'one\'s own action');
    await nothing(c.lead, row.id, inHub, 'someone else\'s action');
    await nothing(c.auditor, p.customer, inHub, 'a person is not a way into the audit');
    assert.equal(((await c.auditor.get(`/v1/admin/audit?objectId=${p.customer}&hubId=${hubId}`)).body as { events: unknown[] }).events.length > 0, true, 'the audit explorer, with its own reader, still has it');
  });

  await t.test('flags: by key or id at the target, whatever the open read of the flag table allows', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const set = async (scope: typeof hub | typeof otherHub) => {
      const response = await command(c.owner, '/v1/admin/flags', { scope, key: 'ui.dense_tables', value: true, description: 'Synthetic flag', declaredEffect: 'ui', expiresAt });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return (response.body as { flag: { id: string } }).flag.id;
    };
    const here = await set(hub);
    const there = await set(otherHub);
    const { hits } = await search(c.moderator, 'ui.dense_tables', inHub);
    assert.deepEqual(ids(hits), [here]);
    assert.deepEqual(kinds(hits), ['flag']);
    assert.deepEqual(hits[0] && 'stage' in hits[0] ? [hits[0].stage, hits[0].sharePercent] : null, ['off', null]);
    await nothing(c.moderator, there, inHub);
    await nothing(c.moderator, 'no.such_flag', inHub);
    await nothing(c.moderator, 'ui.dense_tables', { hubId: otherHubId }, 'a hub role is not staff of the other hub');
  });

  await t.test('negative: a person is found only as staff of the hub, by a reader of the staff directory', async () => {
    assert.deepEqual((await search(c.hubOwner, p.agent, inHub)).hits, [{ kind: 'staff', id: p.agent, scope: hub }]);
    assert.deepEqual(kinds((await search(c.hubOwner, p.owner, inHub)).hits), ['staff'], 'platform staff covering the hub');
    await nothing(c.moderator, p.agent, inHub, 'no admin.staff.read');
    await nothing(c.moderator, p.moderator, inHub, 'not even oneself');
    await nothing(c.hubOwner, p.customer, inHub, 'a participant is exactly as absent as an unknown id');
    await nothing(c.owner, p.customer, inHub, 'for everyone');
    await nothing(c.hubOwner, p.otherAgent, inHub, 'staff of another hub');
    await nothing(c.owner, p.agent, { hubId: randomUUID() }, 'an unknown hub, for someone covering every hub');
  });

  await t.test('configuration versions and pipeline runs belong to their readers, at their hub', async () => {
    const version = await seedConfigVersion(w, hubId);
    const { runId } = await seedPipeline(w, hubId, p.owner);
    const elsewhere = await seedPipeline(w, otherHubId, p.owner);
    const found = await w.searchAs(w.steward, { id: version });
    assert.deepEqual(found, [{ kind: 'config_version', id: version, scope: hub, domain: 'identity', version: 1, status: 'draft' }]);
    assert.ok(!JSON.stringify(found).includes('Synthetic'), 'neither the payload nor the reason');
    assert.deepEqual(await w.searchAs(w.steward, { id: runId }), [{ kind: 'pipeline_run', id: runId, scope: hub, state: 'queued', dryRun: false }]);
    assert.deepEqual(await w.searchAs(w.steward, { id: elsewhere.runId }), []);
    assert.deepEqual(await w.searchAs(w.steward, { id: elsewhere.runId }, otherHub), [], 'not staff there');
    assert.deepEqual(await w.searchAs(p.moderator, { id: runId }), []);
    assert.deepEqual(await w.searchAs(p.moderator, { id: version }), []);
  });

  await t.test('negative: under the runtime role a person who is not staff gets nothing for an object that exists, at any target', async () => {
    const row = await incident(p.owner, hub, 'Synthetic incident');
    for (const person of [p.customer, p.employee, p.outsider]) {
      assert.deepEqual(await w.searchAs(person, { id: row.id }), []);
      assert.deepEqual(await w.searchAs(person, { id: row.id }, { kind: 'platform' }), []);
    }
    assert.deepEqual(await w.searchAs(p.otherAgent, { id: row.id }), [], 'staff of another hub');
  });

  await t.test('hits come in a fixed order the reader can see, and a request id with many events stays bounded', async () => {
    const requestId = randomUUID();
    await w.actors.as(p.owner, async (trx) => {
      for (let i = 0; i < 25; i += 1) await incidents.open(trx, { ...(await w.actors.elevate(p.owner)), requestId }, { scope: hub, kind: 'content', severity: 'sev4', title: 'Synthetic ordered incident' });
    });
    const { hits } = await search(c.auditor, requestId, inHub);
    assert.equal(hits.length, 20, 'a page of the visible rows and no total');
    const sequences = hits.map((hit) => (hit.kind === 'audit_event' ? hit.sequence : 0));
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), 'by sequence, which the hit shows');
  });
});
