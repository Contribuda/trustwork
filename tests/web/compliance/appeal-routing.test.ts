import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { screeningStaff, screeningSubjects } from '../../../packages/data/src/repositories/screening.js';
import { currentAppealAssignment, reassignScreeningAppeal } from '../../../packages/data/src/repositories/screening-notices.js';
import { staffConflicts as conflicts, staffAssignments } from '../../../packages/data/src/repositories/admin.js';
import { SKIP_REASON } from '../../data/helpers/postgres.js';
import { rejects } from '../../data/admin/helpers.js';
import { gate, provisionWorkerDatabase, waitFor } from '../../worker/helpers/worker-db.js';
import { company, person, screen, screeningWorld } from '../../screening/helpers.js';

const env = await provisionWorkerDatabase('sanc007_appeal_routing');
test('SANC-007 current independent appeal routing with immutable history', { skip: env ? false : SKIP_REASON, timeout: 120_000 }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const worker = env.workerPool(4);
  const world = await screeningWorld(admin, env.apiPool, worker);
  const { as, elevate, w } = world;
  const original = w.people.moderator; const actor = w.people.lead; const candidate = w.people.ops;
  await world.assign({ personId: candidate, role: 'ops-engineer', scope: { kind: 'node', nodeId: w.nodeId } });
  const actorCtx = await elevate(actor);
  const originalCtx = await elevate(original);
  const candidateCtx = await elevate(candidate);
  const subject = await person(admin, 'Milo Fictivsky');
  await screen(worker, { kind: 'person', id: subject.id });
  const matchId = (await as(actor, (trx) => screeningStaff.matchesOf(trx, { kind: 'person', id: subject.id })))[0]!.id;
  await as(original, (trx) => screeningStaff.confirm(trx, originalCtx, { matchId, reason: 'Synthetic evidence', evidence: 'other' }));
  await as(subject.id, (trx) => screeningSubjects.appeal(trx, { companyId: null, reason: 'Synthetic appeal evidence' }));
  const view = () => as(actor, (trx) => currentAppealAssignment(trx, matchId));
  const route = async (reviewerId: string | null) => as(actor, (trx) => reassignScreeningAppeal(trx, actorCtx, { matchId, expectedVersion: 1, reviewerId, reason: 'Synthetic routing review' }));
  await t.test('original decider, subject, outsiders, absent elevation and direct writes cannot assign', async () => {
    for (const reviewerId of [original, subject.id, w.people.outsider]) await rejects(route(reviewerId), '42501', 'admin.forbidden');
    await rejects(as(original, (trx) => reassignScreeningAppeal(trx, originalCtx, { matchId, expectedVersion: 1, reviewerId: actor, reason: 'Synthetic' })), '42501', 'admin.forbidden');
    await rejects(as(actor, (trx) => reassignScreeningAppeal(trx, { ...actorCtx, elevationId: '00000000-0000-4000-8000-000000000000' }, { matchId, expectedVersion: 1, reviewerId: actor, reason: 'Synthetic' })), '42501', 'admin.elevation_required');
    for (const pool of [env.apiPool, worker]) {
      await assert.rejects(pool.query('INSERT INTO trustwork.screening_appeal_routing_current (appeal_id, version) VALUES ($1, 2)', [(await view())!.appealId]), { code: '42501' });
    }
    await rejects(as(subject.id, (trx) => currentAppealAssignment(trx, matchId)), '42501', 'admin.forbidden');
  });
  await t.test('concurrent versions admit one change; history and original evidence stay append-only', async () => {
    const results = await Promise.allSettled([route(null), route(candidate)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal((rejected.reason as { hint: string }).hint, 'screening.routing_conflict');
    assert.equal((await view())!.version, 2);
    const appealId = (await view())!.appealId;
    await assert.rejects(withMaintenance(admin, (trx) => trx.updateTable('screening_appeal_routing_history').set({ reason: 'Rewrite' }).where('appeal_id', '=', appealId).execute()));
    await assert.rejects(withMaintenance(admin, (trx) => trx.deleteFrom('screening_appeal_routing_history').where('appeal_id', '=', appealId).execute()));
    assert.equal((await admin.query('SELECT reason FROM trustwork.screening_decision WHERE id = $1', [appealId])).rows[0]?.reason, 'Synthetic appeal evidence');
  });
  const assign = async (reviewerId: string | null) => {
    const current = (await view())!;
    return as(actor, (trx) => reassignScreeningAppeal(trx, actorCtx, { matchId, expectedVersion: current.version, reviewerId, reason: 'Synthetic current-authority reassignment' }));
  };
  await t.test('a new conflict makes a recorded assignment unavailable and blocks decision; rerouting stays operational', async () => {
    await assign(candidate);
    const conflict = await as(candidate, (trx) => conflicts.declare(trx, { kind: 'person', id: subject.id }, 'Synthetic conflict'));
    assert.deepEqual([(await view())!.status, (await view())!.reviewerId], ['unavailable', null]);
    await rejects(assign(candidate), '42501', 'admin.forbidden');
    await rejects(as(candidate, (trx) => screeningStaff.decideAppeal(trx, candidateCtx, { matchId, decision: 'uphold', reason: 'Synthetic', evidence: 'other' })), '42501', 'admin.conflict_of_interest');
    assert.equal((await assign(actor)).reviewerId, actor);
    await as(candidate, (trx) => conflicts.end(trx, candidateCtx, conflict.id));
  });
  await t.test('authority writer first: absent conflict insertion makes routing fail closed, then current validation rejects', async () => {
    const entered = gate(); const release = gate();
    const mutation = as(candidate, async (trx) => {
      const conflict = await conflicts.declare(trx, { kind: 'person', id: subject.id }, 'Synthetic concurrent conflict');
      entered.open(); await release.promise; return conflict;
    });
    await entered.promise;
    try { await rejects(assign(candidate), '40001', 'screening.routing_conflict'); }
    finally { release.open(); }
    const conflict = await mutation;
    await rejects(assign(candidate), '42501', 'admin.forbidden');
    await as(candidate, (trx) => conflicts.end(trx, candidateCtx, conflict.id));
  });
  await t.test('routing first: conflict command waits until routing commits, then the current projection invalidates it', async () => {
    const entered = gate(); const release = gate(); let pid = 0;
    const current = (await view())!;
    const routing = as(actor, async (trx) => {
      pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid;
      const result = await reassignScreeningAppeal(trx, actorCtx, { matchId, expectedVersion: current.version, reviewerId: candidate, reason: 'Synthetic concurrent routing' });
      entered.open(); await release.promise; return result;
    });
    await entered.promise;
    const mutation = as(candidate, (trx) => conflicts.declare(trx, { kind: 'person', id: subject.id }, 'Synthetic blocked conflict'));
    try { await waitFor(async () => (await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.length > 0); }
    finally { release.open(); }
    await routing; const conflict = await mutation;
    assert.equal((await view())!.status, 'unavailable');
    await as(candidate, (trx) => conflicts.end(trx, candidateCtx, conflict.id));
  });
  await t.test('role revocation invalidates routing; null remains truthful and reassignment grants no authority', async () => {
    await assign(candidate);
    const role = (await admin.query("SELECT id FROM trustwork.staff_role_assignment WHERE person_id = $1 AND role = 'compliance-officer' AND revoked_at IS NULL", [candidate])).rows[0]!.id as string;
    const ownerCtx = await elevate(w.people.owner);
    await as(w.people.owner, (trx) => staffAssignments.revoke(trx, ownerCtx, role));
    assert.equal((await view())!.status, 'unavailable');
    await rejects(assign(candidate), '42501', 'admin.forbidden');
    await assert.rejects(as(candidate, (trx) => screeningStaff.decideAppeal(trx, candidateCtx, { matchId, decision: 'uphold', reason: 'Synthetic', evidence: 'other' })));
    const unassigned = await assign(null);
    assert.deepEqual([unassigned.status, unassigned.reviewerId], ['unassigned', null]);
    const assigned = await assign(actor);
    assert.equal(assigned.status, 'assigned');
    const resolved = await as(actor, (trx) => screeningStaff.decideAppeal(trx, actorCtx, { matchId, decision: 'uphold', reason: 'Synthetic independent review', evidence: 'other' }));
    assert.equal(resolved.state, 'confirmed');
    assert.equal((await view())!.status, 'closed');
    await rejects(assign(actor), '23514', 'screening.match_state');
  });
  await t.test('active company members cannot receive their company appeal, even with a compliance role', async () => {
    const subjectCompany = await company(admin, 'Northwind Synthetic Supply', [actor]);
    await screen(worker, { kind: 'company', id: subjectCompany });
    const match = (await as(original, (trx) => screeningStaff.matchesOf(trx, { kind: 'company', id: subjectCompany })))[0]!;
    await as(original, (trx) => screeningStaff.confirm(trx, originalCtx, { matchId: match.id, reason: 'Synthetic company evidence', evidence: 'other' }));
    await as(actor, (trx) => screeningSubjects.appeal(trx, { companyId: subjectCompany, reason: 'Synthetic company appeal' }));
    const routing = await as(original, (trx) => currentAppealAssignment(trx, match.id));
    assert.equal(routing!.reviewerId, null, 'original excluded, remaining officer is the subject company member');
    await rejects(as(actor, (trx) => reassignScreeningAppeal(trx, actorCtx, { matchId: match.id, expectedVersion: 1, reviewerId: actor, reason: 'Synthetic' })), '42501', 'screening.subject_member');
  });
});
