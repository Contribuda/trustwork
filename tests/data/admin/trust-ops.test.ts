import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bindTransaction, createPool, type DataPool, type Transaction } from '@trustwork/data';
import {
  adminDigests, appeals, approvals, featureFlags, killSwitches, maintenanceWindows, moderation, staffConflicts, type CommandContext,
} from '../../../packages/data/src/repositories/admin.js';
import { provisionTestDatabase, SKIP_REASON } from '../helpers/postgres.js';
import { actors, buildAdminWorld, rejects, type AdminWorld } from './helpers.js';

const db = await provisionTestDatabase('admin_trust_ops');

test('moderation, sanctions, appeals, feature flags, maintenance windows and kill switches', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 6 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w: AdminWorld = await buildAdminWorld(db.admin);
  const { as, elevate, assign, assignSensitive, owner } = actors(db.admin, runtime, w);
  const p = w.people;
  const hubScope = { kind: 'hub', hubId: w.hubId } as const;
  await assign({ personId: p.moderator, role: 'moderator', scope: hubScope });
  await assignSensitive({ personId: p.hubOwner, role: 'hub-owner', scope: hubScope });
  await assign({ personId: p.ops, role: 'ops-engineer', scope: { kind: 'node', nodeId: w.nodeId } });
  const modCtx: CommandContext = await elevate(p.moderator);
  const hubOwnerCtx: CommandContext = await elevate(p.hubOwner);
  const ownerCtx: CommandContext = await elevate(p.owner);
  /** Runs fn as the bare runtime login without any identity (banner reads). */
  const anonymous = async <T>(fn: (trx: Transaction) => Promise<T>): Promise<T> => {
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(bindTransaction(client));
      await client.query('COMMIT');
      return result;
    } finally {
      client.release(true);
    }
  };
  const post = randomUUID();

  let reportId: string;
  let caseId: string;
  await t.test('reports: any identified person reports; the reporter and moderators see it; the reported party never does', async () => {
    const report = await as(p.customer, (trx) => moderation.report(trx, { hubId: w.hubId, targetKind: 'publication', targetId: post, clauseCode: 'community.harassment', text: 'Synthetic report text' }));
    reportId = report.id;
    assert.equal(report.reporter_person_id, p.customer);
    assert.equal((await as(p.customer, (trx) => trx.selectFrom('moderation_report').select('id').execute())).length, 1);
    assert.equal((await as(p.employee, (trx) => trx.selectFrom('moderation_report').select('id').execute())).length, 0);
    assert.equal((await as(p.moderator, (trx) => trx.selectFrom('moderation_report').select('id').execute())).length, 1);
    await rejects(owner((trx) => trx.updateTable('moderation_report').set({ clause_code: 'community.other' }).where('id', '=', reportId).execute()), '23000', 'audit.append_only');
    await rejects(as(p.customer, (trx) => trx.insertInto('moderation_report').values({ hub_id: w.hubId, reporter_person_id: p.employee, target_kind: 'publication', target_id: post, clause_code: 'x.y' }).execute()), '42501');
    const draft = await owner((trx) => trx.insertInto('hub').values({ slug: `synthetic-draft-${randomUUID().slice(0, 6)}` }).returning('id').executeTakeFirstOrThrow());
    await rejects(as(p.customer, (trx) => moderation.report(trx, { hubId: draft.id, targetKind: 'publication', targetId: post, clauseCode: 'community.harassment' })), 'P0002', 'admin.not_found');
  });

  await t.test('moderation cases: opened and decided by moderators without a conflict; the subject sees the case, never the reporter', async () => {
    const other = await as(p.outsider, (trx) => moderation.report(trx, { hubId: w.hubId, targetKind: 'publication', targetId: randomUUID(), clauseCode: 'community.spam' }));
    await rejects(as(p.moderator, (trx) => moderation.openCase(trx, modCtx, { hubId: w.hubId, targetKind: 'publication', targetId: post, subject: { kind: 'person', id: p.employee }, reportIds: [reportId, other.id], clauseCodes: ['community.harassment'] })), '23514', 'admin.report_mismatch');
    await as(p.moderator, (trx) => staffConflicts.declare(trx, { kind: 'person', id: p.outsider }, 'Synthetic neighbour'));
    await rejects(as(p.moderator, (trx) => moderation.openCase(trx, modCtx, { hubId: w.hubId, targetKind: 'publication', targetId: randomUUID(), subject: { kind: 'person', id: p.outsider }, clauseCodes: ['community.spam'] })), '42501', 'admin.conflict_of_interest');
    await rejects(as(p.customer, async (trx) => moderation.openCase(trx, modCtx, { hubId: w.hubId, targetKind: 'publication', targetId: post, clauseCodes: ['community.harassment'] })), '42501', 'admin.elevation_required');
    const opened = await as(p.moderator, (trx) => moderation.openCase(trx, modCtx, { hubId: w.hubId, targetKind: 'publication', targetId: post, subject: { kind: 'person', id: p.employee }, reportIds: [reportId], clauseCodes: ['community.harassment'], emergencyHold: true }));
    caseId = opened.id;
    assert.equal(opened.emergency_hold, true);
    assert.equal((await as(p.employee, (trx) => trx.selectFrom('moderation_case').selectAll().execute())).length, 1, 'the subject sees the case and its reasons');
    assert.equal((await as(p.customer, (trx) => trx.selectFrom('moderation_case').selectAll().execute())).length, 0);
    const decided = await as(p.moderator, (trx) => moderation.decide(trx, modCtx, caseId, 'sanction'));
    assert.deepEqual([decided.status, decided.decision, decided.decided_by, decided.emergency_hold], ['decided', 'sanction', p.moderator, false]);
    await rejects(as(p.moderator, (trx) => moderation.decide(trx, modCtx, caseId, 'no_action')), '23514', 'admin.invalid_transition');
    await rejects(owner((trx) => trx.updateTable('moderation_case').set({ decision: 'no_action' }).where('id', '=', caseId).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.updateTable('moderation_case').set({ report_ids: [] }).where('id', '=', caseId).execute()), '23000', 'admin.immutable');
  });

  let level2: string;
  await t.test('sanctions: within engine bounds; levels 3-4 not by moderators; level 4 consumes an approval of exactly that sanction', async () => {
    await rejects(as(p.moderator, (trx) => moderation.applySanction(trx, modCtx, { caseId, level: 2, featureScope: 'commenting', durationSeconds: 31 * 86_400 })), '23514');
    await rejects(as(p.moderator, (trx) => moderation.applySanction(trx, modCtx, { caseId, level: 1, featureScope: 'commenting', durationSeconds: null })), '23514');
    const s2 = await as(p.moderator, (trx) => moderation.applySanction(trx, modCtx, { caseId, level: 2, featureScope: 'commenting', durationSeconds: 7 * 86_400 }));
    level2 = s2.id;
    assert.equal(s2.subject_person_id, p.employee);
    assert.equal(s2.ends_at!.getTime() - s2.starts_at.getTime(), 7 * 86_400_000);
    await rejects(as(p.moderator, (trx) => moderation.applySanction(trx, modCtx, { caseId, level: 3, featureScope: 'posting', durationSeconds: 86_400 })), '42501', 'admin.sanction_level_not_allowed');
    await as(p.hubOwner, (trx) => moderation.applySanction(trx, hubOwnerCtx, { caseId, level: 3, featureScope: 'posting', durationSeconds: 86_400 }));
    await rejects(as(p.hubOwner, (trx) => moderation.applySanction(trx, hubOwnerCtx, { caseId, level: 4, featureScope: 'account', durationSeconds: null })), '42501', 'admin.approval_required');
    const digest = adminDigests.sanction({ moderationCaseId: caseId, subject: { kind: 'person', id: p.employee }, level: 4, featureScope: 'account', durationSeconds: null });
    const req = await as(p.hubOwner, (trx) => approvals.request(trx, hubOwnerCtx, { action: 'moderation.apply_sanction_l4', scope: hubScope, actionDigest: digest }));
    await rejects(as(p.hubOwner, (trx) => approvals.decide(trx, hubOwnerCtx, req.id, 'approve', digest)), '42501', 'admin.self_approval');
    await as(p.moderator, (trx) => approvals.decide(trx, modCtx, req.id, 'approve', digest));
    await rejects(as(p.hubOwner, (trx) => moderation.applySanction(trx, hubOwnerCtx, { caseId, level: 4, featureScope: 'posting', durationSeconds: null, approvalId: req.id })), '23514', 'admin.approval_mismatch');
    const s4 = await as(p.hubOwner, (trx) => moderation.applySanction(trx, hubOwnerCtx, { caseId, level: 4, featureScope: 'account', durationSeconds: null, approvalId: req.id }));
    assert.deepEqual([s4.ends_at, s4.second_approval_id], [null, req.id]);
    const audit = await owner((trx) => trx.selectFrom('admin_audit_event').selectAll().where('object_id', '=', s4.id).executeTakeFirstOrThrow());
    assert.deepEqual([audit.action, audit.second_approver_person_id, audit.approval_digest], ['moderation.apply_sanction_l4', p.moderator, digest]);
    await rejects(owner((trx) => trx.insertInto('sanction').values({ hub_id: w.hubId, subject_person_id: p.employee, level: 4, feature_scope: 'account', moderation_case_id: caseId, decided_by: p.hubOwner, reason: 'x' }).execute()), '42501', 'admin.approval_mismatch');
    await rejects(owner((trx) => trx.updateTable('sanction').set({ ends_at: new Date(Date.now() + 86_400_000) }).where('id', '=', level2).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.deleteFrom('sanction').where('id', '=', level2).execute()), '23000', 'audit.append_only');
    assert.equal((await as(p.employee, (trx) => trx.selectFrom('sanction').select('id').execute())).length, 3, 'the subject sees their sanctions');
    assert.equal((await as(p.customer, (trx) => trx.selectFrom('sanction').select('id').execute())).length, 0);
  });

  await t.test('appeals: one path per decision, filed by the subject, decided by a different person; overturning lifts the sanction', async () => {
    await rejects(as(p.customer, (trx) => appeals.file(trx, 'sanction', level2, 'x')), 'P0002', 'admin.not_found');
    await rejects(as(p.employee, (trx) => appeals.file(trx, 'review' as never, randomUUID(), 'x')), '0A000', 'admin.appeal_kind_not_supported');
    const appeal = await as(p.employee, (trx) => appeals.file(trx, 'sanction', level2, 'Synthetic: the comment was quoted out of context'));
    assert.deepEqual([appeal.original_decided_by, appeal.status], [p.moderator, 'submitted']);
    await rejects(as(p.employee, (trx) => appeals.file(trx, 'sanction', level2, 'again')), '23505');
    assert.equal((await owner((trx) => trx.selectFrom('moderation_case').select('status').where('id', '=', caseId).executeTakeFirstOrThrow())).status, 'appealed');
    await rejects(as(p.moderator, (trx) => appeals.decide(trx, modCtx, appeal.id, 'overturned')), '42501');
    const overturned = await as(p.hubOwner, (trx) => appeals.decide(trx, hubOwnerCtx, appeal.id, 'overturned'));
    assert.equal(overturned.decided_by, p.hubOwner);
    const lifted = await owner((trx) => trx.selectFrom('sanction').select(['lifted_at', 'lifted_by']).where('id', '=', level2).executeTakeFirstOrThrow());
    assert.ok(lifted.lifted_at && lifted.lifted_by === p.hubOwner);
    assert.equal((await owner((trx) => trx.selectFrom('moderation_case').select('status').where('id', '=', caseId).executeTakeFirstOrThrow())).status, 'appeal_decided');
    await rejects(as(p.hubOwner, (trx) => appeals.decide(trx, hubOwnerCtx, appeal.id, 'upheld')), '23514', 'admin.invalid_transition');
    // Appeals on other modules' decisions are filed by those modules; the original decider never decides them.
    const review = await owner((trx) => appeals.fileForSubject(trx, { hubId: w.hubId, subjectKind: 'review', subjectId: randomUUID(), appellantPersonId: p.customer, reason: 'Synthetic review appeal', originalDecidedBy: p.hubOwner }));
    await rejects(as(p.hubOwner, (trx) => appeals.decide(trx, hubOwnerCtx, review.id, 'upheld')), '42501', 'admin.same_decider');
    await rejects(owner((trx) => trx.updateTable('appeal').set({ status: 'upheld', decided_by: p.hubOwner, decided_at: new Date(), decision_reason: 'x' }).where('id', '=', review.id).execute()), '23514');
    await as(p.owner, (trx) => appeals.decide(trx, ownerCtx, review.id, 'upheld')).then(() => assert.fail('platform-owner holds no admin.trust.appeals.decide'), (e: { hint?: string }) => assert.equal(e.hint, 'admin.forbidden'));
    assert.equal((await as(p.customer, (trx) => trx.selectFrom('appeal').select('id').execute())).length, 1, 'the appellant sees their appeal');
  });

  await t.test('feature flags: per node or hub, expiring, and never about authorization, projections, egress or ranking', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86_400_000);
    const flag = await as(p.hubOwner, (trx) => featureFlags.set(trx, hubOwnerCtx, { scope: hubScope, key: 'editor.new_toolbar', value: { enabled: true }, description: 'Synthetic UI experiment', declaredEffect: 'ui', expiresAt }));
    assert.equal(flag.owner_person_id, p.hubOwner);
    const changed = await as(p.hubOwner, (trx) => featureFlags.set(trx, hubOwnerCtx, { scope: hubScope, key: 'editor.new_toolbar', value: { enabled: false }, description: 'Synthetic UI experiment', declaredEffect: 'ui', expiresAt }));
    assert.deepEqual([changed.id, changed.revision], [flag.id, 2]);
    await as(p.hubOwner, (trx) => featureFlags.set(trx, hubOwnerCtx, { scope: hubScope, key: 'retrieval.rerank_model_b', value: true, description: 'Synthetic: rerank is a model job, not a ranking control', declaredEffect: 'behaviour', expiresAt }));
    for (const key of ['search.rank_boost', 'directory.promote_paid', 'access.widen', 'auth.bypass', 'profile.visibility_all', 'egress.allow_all', 'reputation.score_override', 'list.position_pin', 'staff.role_grant', 'privacy.off']) {
      await rejects(as(p.hubOwner, (trx) => featureFlags.set(trx, hubOwnerCtx, { scope: hubScope, key, value: true, description: 'x', declaredEffect: 'ui', expiresAt })), '23514');
    }
    await rejects(as(p.hubOwner, (trx) => featureFlags.set(trx, hubOwnerCtx, { scope: hubScope, key: 'editor.other', value: true, description: 'x', declaredEffect: 'authorization' as never, expiresAt })), '23514');
    await rejects(as(p.hubOwner, (trx) => featureFlags.set(trx, hubOwnerCtx, { scope: hubScope, key: 'editor.other', value: true, description: 'x', declaredEffect: 'ui', expiresAt: new Date(Date.now() + 500 * 86_400_000) })), '23514');
    await rejects(as(p.moderator, (trx) => featureFlags.set(trx, modCtx, { scope: hubScope, key: 'editor.other', value: true, description: 'x', declaredEffect: 'ui', expiresAt })), '42501', 'admin.forbidden');
    await rejects(as(p.hubOwner, (trx) => featureFlags.set(trx, hubOwnerCtx, { scope: { kind: 'hub', hubId: w.otherHubId }, key: 'editor.other', value: true, description: 'x', declaredEffect: 'ui', expiresAt })), '42501', 'admin.forbidden');
    assert.equal((await anonymous((trx) => featureFlags.list(trx, { hubId: w.hubId }))).length, 2, 'every runtime reads flags');
    await rejects(owner((trx) => trx.deleteFrom('feature_flag').where('id', '=', flag.id).execute()), '23000', 'audit.append_only');
  });

  await t.test('maintenance windows: scheduled and cancelled with admin.config.maintenance; the banner state is public', async () => {
    const starts = new Date(Date.now() - 60_000);
    await rejects(as(p.moderator, (trx) => maintenanceWindows.schedule(trx, modCtx, { scope: hubScope, startsAt: starts, endsAt: new Date(Date.now() + 3_600_000) })), '42501', 'admin.forbidden');
    await rejects(as(p.hubOwner, (trx) => maintenanceWindows.schedule(trx, hubOwnerCtx, { scope: hubScope, startsAt: starts, endsAt: new Date(Date.now() + 8 * 86_400_000) })), '23514');
    const window = await as(p.hubOwner, (trx) => maintenanceWindows.schedule(trx, hubOwnerCtx, { scope: hubScope, startsAt: starts, endsAt: new Date(Date.now() + 3_600_000) }));
    assert.equal((await anonymous((trx) => maintenanceWindows.active(trx))).length, 1);
    await as(p.hubOwner, (trx) => maintenanceWindows.cancel(trx, hubOwnerCtx, window.id));
    assert.equal((await anonymous((trx) => maintenanceWindows.active(trx))).length, 0);
    await rejects(as(p.hubOwner, (trx) => maintenanceWindows.cancel(trx, hubOwnerCtx, window.id)), '23000', 'admin.immutable');
  });

  await t.test('kill switches: engaging is immediate and needs one person; releasing consumes a second-person approval of exactly that release', async () => {
    await rejects(as(p.moderator, (trx) => killSwitches.engage(trx, modCtx, { scopeKind: 'agent_module', scope: hubScope, target: { moduleKey: 'procurement_agent' } })), '42501', 'admin.forbidden');
    await rejects(as(p.hubOwner, (trx) => killSwitches.engage(trx, hubOwnerCtx, { scopeKind: 'agent_module', scope: hubScope, target: {} })), '23514');
    const engaged = await as(p.hubOwner, (trx) => killSwitches.engage(trx, hubOwnerCtx, { scopeKind: 'agent_module', scope: hubScope, target: { moduleKey: 'procurement_agent' } }));
    assert.equal(engaged.state, 'engaged');
    await rejects(as(p.hubOwner, (trx) => killSwitches.engage(trx, hubOwnerCtx, { scopeKind: 'agent_module', scope: hubScope, target: { moduleKey: 'procurement_agent' } })), '23505');
    const opsCtx = await elevate(p.ops);
    const nodeSwitch = await as(p.ops, (trx) => killSwitches.engage(trx, opsCtx, { scopeKind: 'node', scope: { kind: 'node', nodeId: w.nodeId } }));
    assert.equal(nodeSwitch.node_id, w.nodeId);
    assert.equal((await anonymous((trx) => killSwitches.engaged(trx))).length, 2, 'every runtime reads the switches');
    // The worker role reads enforcement state and nothing else here.
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE trustwork_worker');
      assert.equal((await client.query('SELECT id FROM trustwork.kill_switch')).rowCount, 2);
      await rejects(client.query('SELECT id FROM trustwork.moderation_case'), '42501');
      await client.query('ROLLBACK');
    } finally {
      client.release(true);
    }
    const note = 'Synthetic: provider fixed, module re-tested';
    const digest = adminDigests.killSwitchRelease(engaged.id, note);
    const req = await as(p.hubOwner, (trx) => approvals.request(trx, hubOwnerCtx, { action: 'kill_switch.release', scope: hubScope, actionDigest: digest }));
    await rejects(as(p.hubOwner, (trx) => approvals.decide(trx, hubOwnerCtx, req.id, 'approve', digest)), '42501', 'admin.self_approval');
    await rejects(as(p.moderator, (trx) => approvals.decide(trx, modCtx, req.id, 'approve', digest)), '42501', 'admin.forbidden');
    await as(p.owner, (trx) => approvals.decide(trx, ownerCtx, req.id, 'approve', digest));
    await rejects(as(p.owner, (trx) => killSwitches.release(trx, ownerCtx, engaged.id, req.id, note)), '42501', 'admin.not_requester');
    await rejects(as(p.hubOwner, (trx) => killSwitches.release(trx, hubOwnerCtx, engaged.id, req.id, 'a different note')), '23514', 'admin.approval_mismatch');
    await rejects(owner((trx) => trx.updateTable('kill_switch').set({ state: 'released', released_by: p.hubOwner, release_approval_id: req.id, incident_note: note }).where('id', '=', engaged.id).execute()), '42501', 'admin.approval_mismatch');
    const released = await as(p.hubOwner, (trx) => killSwitches.release(trx, hubOwnerCtx, engaged.id, req.id, note));
    assert.deepEqual([released.state, released.released_by, released.release_approval_id, released.incident_note], ['released', p.hubOwner, req.id, note]);
    await rejects(as(p.hubOwner, (trx) => killSwitches.release(trx, hubOwnerCtx, engaged.id, req.id, note)), '23514', 'admin.invalid_transition');
    const again = await as(p.hubOwner, (trx) => killSwitches.engage(trx, hubOwnerCtx, { scopeKind: 'agent_module', scope: hubScope, target: { moduleKey: 'procurement_agent' } }));
    assert.notEqual(again.id, engaged.id, 'a released switch is final; engaging again creates a new one');
    const audit = await owner((trx) => trx.selectFrom('admin_audit_event').selectAll().where('object_id', '=', engaged.id).orderBy('sequence').execute());
    assert.deepEqual(audit.map((a) => [a.action, a.second_approver_person_id]), [['kill_switch.engage', null], ['kill_switch.release', p.owner]]);
    await rejects(owner((trx) => trx.deleteFrom('kill_switch').where('id', '=', engaged.id).execute()), '23000', 'audit.append_only');
  });
});
