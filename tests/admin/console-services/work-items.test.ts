import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { ConsoleWorkCountSchema, ConsoleWorkItemSchema } from '../../../packages/contracts/src/console-services.js';
import { appeals, caseGrants, incidents, moderation, staffAssignments, staffConflicts, supportCases } from '../../../packages/data/src/repositories/admin.js';
import { staffLifecycle } from '../../../packages/data/src/repositories/staff-lifecycle.js';
import { Client, SKIP_REASON, startHarness } from '../../backend/helpers/app.js';
import { command, customerCase, expectRefusal } from '../helpers.js';
import { buildConsoleWorld, ids, seedPipeline, seedRecovery, work, type ConsoleWorld } from './helpers.js';

const h = await startHarness('console_work_items');

/**
 * ADM-005 acceptance: "A staff member never receives a work item for an object they may not read", and every item says why
 * it is the viewer's. Sources: approvals, recovery escalations, case grants, access reviews, support and moderation cases,
 * appeals, incidents and pipeline alerts, per role and scope, under the runtime role and over HTTP.
 */
test('console work items (ADM-005)', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: ConsoleWorld = await buildConsoleWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const { hubId, otherHubId } = w;
  const hub = { kind: 'hub', hubId } as const;
  const otherHub = { kind: 'hub', hubId: otherHubId } as const;
  const elevated = <T>(person: string, fn: (trx: Parameters<Parameters<typeof w.actors.as>[1]>[0], ctx: Awaited<ReturnType<typeof w.actors.elevate>>) => Promise<T>) =>
    w.actors.elevate(person).then((ctx) => w.actors.as(person, (trx) => fn(trx, ctx)));
  const requestRole = async (client: Client, personId: string, scope: unknown = hub) => {
    const response = await command(client, '/v1/admin/approvals', { subject: { action: 'staff.assign_sensitive_role', personId, role: 'hub-owner', scope, definitionVersion: 1 }, reason: 'Synthetic reason naming someone' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return (response.body as { approval: { id: string; actionDigest: string } }).approval;
  };
  const has = (rows: { id: string }[], id: string) => ids(rows).includes(id);

  await t.test('negative: only an elevated staff member reaches the work list', async () => {
    const url = `/v1/admin/console/work?view=waiting&hubId=${hubId}`;
    expectRefusal(await new Client(w.app).get(url), 401, 'auth.session_invalid');
    expectRefusal(await c.customer.get(url), 403, 'access.forbidden', 'staff');
    expectRefusal(await c.moderator.get(url), 403, 'access.forbidden', 'elevation');
    await w.elevateAll();
    expectRefusal(await c.owner.get(`/v1/admin/console/work?view=everything&hubId=${hubId}`), 422, 'validation.schema');
  });

  await t.test('approvals: waiting for those who may decide, with the role that makes it theirs; the requester sees it under their requests', async () => {
    const approval = await requestRole(c.owner, p.candidate);
    const waiting = await work(c.hubOwner, 'waiting', hubId);
    const row = waiting.find((item) => item.id === approval.id);
    assert.ok(row);
    assert.deepEqual({ kind: row.kind, state: row.state, action: row.action, requestedBy: row.requestedBy, reason: row.reason, scope: row.scope },
      { kind: 'approval', state: 'pending', action: 'staff.assign_sensitive_role', requestedBy: p.owner, reason: { code: 'holds_role', role: 'hub-owner' }, scope: hub });
    assert.ok(row.expiresAt, 'the request expires');
    assert.ok(!JSON.stringify(waiting).includes('naming someone'), 'the requester\'s reason stays on the approval');
    assert.ok(!JSON.stringify(waiting).includes(p.candidate), 'the change stays on the approval');
    assert.ok(!has(await work(c.owner, 'waiting', hubId), approval.id), 'nobody approves their own request');
    const mine = (await work(c.owner, 'mine', hubId)).find((item) => item.id === approval.id);
    assert.deepEqual(mine?.reason, { code: 'requested_by_you' });
    for (const reader of [c.moderator, c.lead, c.ops, c.auditor]) assert.ok(!has(await work(reader, 'waiting', hubId), approval.id), 'no permission for the action');
    assert.ok(!has(await work(c.hubOwner, 'mine', hubId), approval.id));
  });

  await t.test('negative: in full mode a staff action does not wait for someone the database would refuse, and the count says the same', async () => {
    const approval = await requestRole(c.admin, p.outsider);
    assert.ok(!has(await work(c.admin2, 'waiting', hubId), approval.id), 'the same role as the requester');
    expectRefusal(await command(c.admin2, `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: approval.actionDigest }), 403, 'access.second_approver_required', 'same_role');
    assert.ok(has(await work(c.hubOwner, 'waiting', hubId), approval.id), 'a different role');
    for (const client of [c.hubOwner, c.admin2, c.moderator]) {
      const list = await work(client, 'waiting', hubId);
      assert.deepEqual(ConsoleWorkCountSchema.parse((await client.get(`/v1/admin/console/work/count?hubId=${hubId}`)).body), { waiting: list.length, truncated: false });
    }
  });

  await t.test('negative: another hub\'s work never shows, and an expired or decided request stops waiting', async () => {
    const elsewhere = await requestRole(c.owner, p.candidate, otherHub);
    assert.ok(!has(await work(c.hubOwner, 'waiting', hubId), elsewhere.id));
    assert.ok(!has(await work(c.hubOwner, 'waiting', otherHubId), elsewhere.id), 'a hub role is not staff there');
    assert.ok(!has(await work(c.admin, 'waiting', hubId), elsewhere.id), 'a person covering both hubs, acting on this one');
    assert.ok(has(await work(c.admin, 'waiting', otherHubId), elsewhere.id), 'and acting on that one');
    const expiring = await requestRole(c.owner, p.employee);
    await w.actors.owner(async (trx) => {
      await sql`ALTER TABLE trustwork.second_person_approval DISABLE TRIGGER USER`.execute(trx);
      await sql`UPDATE trustwork.second_person_approval SET request_expires_at = now() - interval '1 minute' WHERE id = ${expiring.id}::uuid`.execute(trx);
      await sql`ALTER TABLE trustwork.second_person_approval ENABLE TRIGGER USER`.execute(trx);
    });
    assert.ok(!has(await work(c.hubOwner, 'waiting', hubId), expiring.id));
    assert.ok(!has(await work(c.owner, 'mine', hubId), expiring.id));
    const decided = await requestRole(c.owner, p.customer);
    assert.equal((await command(c.hubOwner, `/v1/admin/approvals/${decided.id}/approve`, { actionDigest: decided.actionDigest })).status, 200);
    assert.ok(!has(await work(c.admin, 'waiting', hubId), decided.id));
    const done = (await work(c.hubOwner, 'done', hubId)).find((item) => item.id === decided.id);
    assert.deepEqual(done?.reason, { code: 'decided_by_you' });
    assert.ok(has(await work(c.owner, 'mine', hubId), decided.id), 'approved: the requester still has to use it');
    assert.ok(!has(await work(c.admin, 'done', hubId), decided.id), 'someone else\'s decision');
  });

  await t.test('case grants: for a different person who may approve, never on their own account, employer or declared party', async () => {
    const caseId = await customerCase(w);
    const grant = await elevated(p.agent, (trx, ctx) => caseGrants.request(trx, ctx, { supportCaseId: caseId, objectType: 'person', objectIds: [p.customer], projectionClass: 'diagnostic', purpose: 'Synthetic purpose naming a participant', expiresInSeconds: 3600 }));
    const waiting = await work(c.lead, 'waiting', hubId);
    const row = waiting.find((item) => item.id === grant.id);
    assert.deepEqual([row?.kind, row?.reason], ['case_grant', { code: 'holds_role', role: 'support-lead' }]);
    assert.ok(!JSON.stringify(waiting).includes('naming a participant'), 'the purpose stays on the grant');
    assert.ok(!JSON.stringify(waiting).includes(p.customer), 'the object stays on the grant');
    assert.ok(!has(await work(c.agent, 'waiting', hubId), grant.id), 'no approve permission');
    assert.ok(has(await work(c.agent, 'mine', hubId), grant.id), 'the requester');
    assert.ok(!has(await work(c.moderator, 'waiting', hubId), grant.id));
    await w.actors.as(p.lead2, (trx) => staffConflicts.declare(trx, { kind: 'person', id: p.customer }, 'Synthetic: a relative'));
    assert.ok(!has(await work(c.lead2, 'waiting', hubId), grant.id), 'a declared party');
    await elevated(p.lead, (trx, ctx) => caseGrants.decide(trx, ctx, grant.id, 'approve', grant.request_digest));
    assert.ok(!has(await work(c.lead, 'waiting', hubId), grant.id));
    assert.ok(has(await work(c.lead, 'done', hubId), grant.id));
  });

  await t.test('negative: an account recovery never waits for its subject or someone conflicted with them', async () => {
    const caseId = await customerCase(w);
    const aboutCustomer = await seedRecovery(w, { subject: p.customer, requestedBy: p.lead, caseId });
    const row = (await w.workAs(w.recovery, 'waiting')).find((item) => item.id === aboutCustomer);
    assert.deepEqual([row?.kind, row?.action, row?.reason], ['recovery_escalation', 'support.reset_second_factor', { code: 'holds_role', role: 'trust-reviewer' }]);
    assert.ok(ConsoleWorkItemSchema.parse(row));
    assert.ok(!JSON.stringify(row).includes(p.customer), 'the subject is not in the row');
    assert.ok(!has(await w.workAs(p.lead2, 'waiting'), aboutCustomer), 'no permission for the action');
    const aboutReviewer = await seedRecovery(w, { subject: w.recovery, requestedBy: p.lead, caseId });
    assert.ok(!has(await w.workAs(w.recovery, 'waiting'), aboutReviewer), 'their own account');
    await w.actors.as(w.recovery, (trx) => staffConflicts.declare(trx, { kind: 'person', id: p.employee }, 'Synthetic: a relative'));
    const aboutRelative = await seedRecovery(w, { subject: p.employee, requestedBy: p.lead, caseId });
    assert.ok(!has(await w.workAs(w.recovery, 'waiting'), aboutRelative), 'a declared party');
  });

  await t.test('access reviews: never one\'s own access; past the deadline only for the scope\'s owner role', async () => {
    const campaign = await elevated(p.admin, (trx, ctx) => staffLifecycle.openAccessReview(trx, ctx, { scope: hub, title: 'Synthetic review title', roles: ['hub-owner', 'moderator'], dueInSeconds: 30 * 86_400 }));
    const items = await w.actors.owner((trx) => trx.selectFrom('staff_access_review_item').select(['id', 'holder_person_id', 'role']).where('campaign_id', '=', campaign.id).execute());
    const ofHubOwner = items.find((i) => i.holder_person_id === p.hubOwner)?.id as string;
    const ofModerator = items.find((i) => i.holder_person_id === p.moderator)?.id as string;
    const waiting = await work(c.hubOwner, 'waiting', hubId);
    assert.ok(!has(waiting, ofHubOwner), 'nobody reviews their own access');
    const row = waiting.find((item) => item.id === ofModerator);
    assert.deepEqual([row?.kind, row?.role, row?.reason], ['access_review_item', 'moderator', { code: 'holds_role', role: 'hub-owner' }]);
    assert.ok(!JSON.stringify(waiting).includes('review title'));
    assert.ok(has(await work(c.admin2, 'waiting', hubId), ofHubOwner), 'a reviewer who is not the holder');
    assert.ok(!has(await work(c.moderator, 'waiting', hubId), ofModerator), 'no admin.staff.revoke');
    assert.ok(!has(await work(c.auditor, 'waiting', hubId), ofModerator));
    await w.actors.owner(async (trx) => {
      await sql`ALTER TABLE trustwork.staff_access_review_campaign DISABLE TRIGGER USER`.execute(trx);
      await sql`UPDATE trustwork.staff_access_review_campaign SET due_at = now() - interval '1 hour' WHERE id = ${campaign.id}::uuid`.execute(trx);
      await sql`ALTER TABLE trustwork.staff_access_review_campaign ENABLE TRIGGER USER`.execute(trx);
    });
    assert.ok(!has(await work(c.admin2, 'waiting', hubId), ofModerator), 'past the deadline a plain reviewer may not decide it');
    assert.deepEqual((await work(c.hubOwner, 'waiting', hubId)).find((item) => item.id === ofModerator)?.reason, { code: 'escalated_to_owner_role', role: 'hub-owner' });
    assert.ok(!has(await work(c.hubOwner, 'waiting', hubId), ofHubOwner), 'still not their own');
  });

  await t.test('negative: a case assigned to someone leaves their list when they may no longer read it', async () => {
    const caseId = await customerCase(w);
    await elevated(p.lead, (trx, ctx) => supportCases.update(trx, ctx, caseId, { status: 'triaged', assignedTo: p.lead }));
    const row = (await work(c.lead, 'assigned', hubId)).find((item) => item.id === caseId);
    assert.deepEqual([row?.kind, row?.state, row?.reason], ['support_case', 'triaged', { code: 'assigned_to_you' }]);
    assert.ok(!JSON.stringify(row).includes('cannot open my project'), 'the summary stays on the case');
    assert.ok(!has(await work(c.lead2, 'assigned', hubId), caseId), 'someone else\'s case');

    // The assignee keeps a role at the hub but loses the one that reads support cases.
    await w.actors.assign({ personId: p.lead, role: 'moderator', scope: hub });
    const held = await w.actors.as(p.owner, (trx) => staffAssignments.list(trx, { personId: p.lead, activeOnly: true }));
    const support = held.find((a) => a.role === 'support-lead');
    assert.ok(support);
    await elevated(p.owner, (trx, ctx) => staffAssignments.revoke(trx, ctx, support.id));
    assert.ok(!has(await w.workAs(p.lead, 'assigned'), caseId), 'assigned_to alone does not reach the case');
    assert.deepEqual(await w.searchAs(p.lead, { id: caseId }), []);
    await w.actors.assign({ personId: p.lead, role: 'support-lead', scope: hub });
    assert.ok(has(await w.workAs(p.lead, 'assigned'), caseId));
    // And it leaves when a conflict is declared after the assignment.
    await w.actors.as(p.lead, (trx) => staffConflicts.declare(trx, { kind: 'person', id: p.customer }, 'Synthetic: a relative'));
    assert.ok(!has(await w.workAs(p.lead, 'assigned'), caseId), 'a declared party');
  });

  await t.test('appeals: the work of who may decide them, never the original decider or the appellant', async () => {
    const opened = await elevated(p.moderator, (trx, ctx) => moderation.openCase(trx, ctx, { hubId, targetKind: 'publication', targetId: randomUUID(), subject: { kind: 'person', id: p.outsider }, clauseCodes: ['community.spam'] }));
    await elevated(p.hubOwner, (trx, ctx) => moderation.decide(trx, ctx, opened.id, 'warning'));
    const appeal = await w.actors.as(p.outsider, (trx) => appeals.file(trx, 'moderation_case', opened.id, 'Synthetic: the reason of the appellant'));
    const owners = await work(c.owner, 'assigned', hubId);
    const row = owners.find((item) => item.id === appeal.id);
    assert.deepEqual([row?.kind, row?.state, row?.reason], ['appeal', 'submitted', { code: 'holds_role', role: 'platform-owner' }]);
    assert.ok(!JSON.stringify(owners).includes('reason of the appellant'));
    assert.ok(!has(await work(c.hubOwner, 'assigned', hubId), appeal.id), 'the original decider');
    assert.ok(!has(await work(c.moderator, 'assigned', hubId), appeal.id), 'may read it, may not decide it');
    assert.ok(has(await work(c.hubOwner, 'done', hubId), opened.id), 'the decision on the case is theirs');
    assert.ok(!has(await work(c.moderator, 'done', hubId), opened.id));
    const conflicted = await w.actors.as(p.owner, (trx) => staffConflicts.declare(trx, { kind: 'person', id: p.outsider }, 'Synthetic: a relative'));
    assert.ok(!has(await work(c.owner, 'assigned', hubId), appeal.id), 'a declared party');
    await elevated(p.owner, async (trx, ctx) => staffConflicts.end(trx, ctx, conflicted.id));
    assert.ok(has(await work(c.owner, 'assigned', hubId), appeal.id), 'and back');
  });

  await t.test('moderation cases assigned to a moderator, and incidents and alerts they are on', async () => {
    const assigned = await w.actors.owner((trx) => trx.insertInto('moderation_case').values({ hub_id: hubId, target_kind: 'publication', target_id: randomUUID(), subject_person_id: p.outsider, clause_codes: ['community.spam'], opened_by: p.hubOwner, assigned_to: p.moderator } as never).returning('id').executeTakeFirstOrThrow());
    assert.ok(has(await work(c.moderator, 'assigned', hubId), assigned.id));
    const aboutSelf = await w.actors.owner((trx) => trx.insertInto('moderation_case').values({ hub_id: hubId, target_kind: 'publication', target_id: randomUUID(), subject_person_id: p.moderator, clause_codes: ['community.spam'], opened_by: p.hubOwner, assigned_to: p.moderator } as never).returning('id').executeTakeFirstOrThrow());
    assert.ok(!has(await work(c.moderator, 'assigned', hubId), aboutSelf.id), 'a case about oneself, even if assigned');

    const incident = await elevated(p.ops, (trx, ctx) => incidents.open(trx, ctx, { scope: hub, kind: 'availability', severity: 'sev2', title: 'Synthetic incident title' }));
    const list = await work(c.ops, 'assigned', hubId);
    const row = list.find((item) => item.id === incident.id);
    assert.deepEqual([row?.kind, row?.severity, row?.reason], ['incident', 'sev2', { code: 'opened_by_you' }]);
    assert.ok(!JSON.stringify(list).includes('incident title'));
    assert.ok(!has(await work(c.auditor, 'assigned', hubId), incident.id));

    const { alertId } = await seedPipeline(w, hubId, w.steward);
    assert.deepEqual((await w.workAs(w.steward, 'assigned')).find((item) => item.id === alertId)?.reason, { code: 'acknowledged_by_you' });
    const taken = await seedPipeline(w, hubId, p.moderator);
    assert.ok(!has(await w.workAs(p.moderator, 'assigned'), taken.alertId), 'acknowledged once, but no pipeline read now');
    assert.ok(!JSON.stringify(await w.workAs(w.steward, 'assigned')).includes('failure streak'), 'the detail stays on the alert');
  });

  await t.test('negative: a person who is not staff has no work, whatever a row names them as', async () => {
    const assigned = await customerCase(w);
    await w.actors.owner(async (trx) => sql`UPDATE trustwork.support_case SET assigned_to = ${p.customer}::uuid WHERE id = ${assigned}::uuid`.execute(trx));
    for (const view of ['waiting', 'mine', 'assigned', 'done'] as const) {
      assert.deepEqual(await w.workAs(p.customer, view), [], view);
      assert.deepEqual(await w.workAs(p.otherAgent, view), [], view);
    }
    assert.deepEqual(await w.workAs(p.hubOwner, 'waiting', { kind: 'platform' }), [], 'a hub role is nothing at the platform');
  });

  await t.test('every row of every view fits the strict contract, in an order the reader can see', async () => {
    for (const view of ['waiting', 'mine', 'assigned', 'done'] as const) {
      for (const client of [c.owner, c.hubOwner, c.lead, c.moderator, c.ops]) {
        const items = await work(client, view, hubId);
        const dates = items.map((item) => (view === 'done' ? item.at : item.expiresAt ?? item.at));
        const sorted = [...dates].sort();
        assert.deepEqual(dates, view === 'done' ? sorted.reverse() : sorted, `${view}: by a date in the row`);
      }
    }
  });
});
