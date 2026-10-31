import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import { screeningStaff, screeningStates, screeningSubjects, screeningWorker } from '../../packages/data/src/repositories/screening.js';
import { TABLE_COLUMNS } from '../../packages/data/src/schema/screening.js';
import { SCREENING_EVENTS } from '../../packages/contracts/src/sanctions.js';
import { MATCHER_VERSION } from '../../packages/compliance/src/matching/index.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects, settle } from '../data/admin/helpers.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { activateList, company, CONFIG, ownerRows, person, screen, screeningWorld, SDN_ENTRIES } from './helpers.js';

const env = await provisionWorkerDatabase('screening_db');

/**
 * SANC-003 persistence on real PostgreSQL under the runtime, worker and owner roles: honest outcomes and money_held,
 * the clear invariant, separation of duties for every decision (the subject, a member of the subject company and a
 * conflicted reviewer cannot decide; "not the same person" and reversals need a second person; appeals go to another
 * reviewer), exactly one decision under concurrent approvals, decided entries not flagged again, suspension on a
 * confirmed match, and staff-only visibility. Every name is synthetic.
 */
test('SANC-003 screening engine on PostgreSQL', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const runtime = env.apiPool;
  const worker = env.workerPool(6);
  const world = await screeningWorld(admin, runtime, worker);
  const { w, as, elevate, owner } = world;
  const staff = w.people;
  const state = (subject: { kind: 'person' | 'company'; id: string }) => tx(runtime, (trx) => screeningStates.state(trx, subject));
  const matchesOf = (subject: { kind: 'person' | 'company'; id: string }) => as(staff.moderator, (trx) => screeningStaff.matchesOf(trx, subject));
  const outbox = (type: string) => admin.query<{ aggregate_id: string; payload: Record<string, unknown> }>('SELECT aggregate_id, payload FROM trustwork.outbox_event WHERE type = $1 ORDER BY id', [type]).then((r) => r.rows);

  await t.test('a subject never screened, and a result while the baseline is unusable, keep money held', async () => {
    const fresh = await person(admin, 'Quentin Brightwater');
    const before = await state({ kind: 'person', id: fresh.id });
    assert.deepEqual([before.moneyHeld, before.reasons, before.lastOutcome], [true, ['not_screened'], null]);
    // Make the baseline stale (content last confirmed 30 days ago): the worker records not_screened, never clear.
    await owner((trx) => sql`UPDATE trustwork.screening_list SET last_checked_at = now() - interval '30 days' WHERE baseline`.execute(trx));
    const result = await screen(worker, { kind: 'person', id: fresh.id });
    assert.equal(result.outcome, 'not_screened');
    const held = await state({ kind: 'person', id: fresh.id });
    assert.equal(held.moneyHeld, true);
    assert.ok(held.reasons.includes('not_screened') && held.reasons.includes('lists_unavailable'), held.reasons.join(','));
    await owner((trx) => sql`UPDATE trustwork.screening_list SET last_checked_at = now() WHERE baseline`.execute(trx));
    assert.equal((await screen(worker, { kind: 'person', id: fresh.id })).outcome, 'clear');
    const clear = await state({ kind: 'person', id: fresh.id });
    assert.deepEqual([clear.moneyHeld, clear.reasons, clear.lastOutcome], [false, [], 'clear']);
    // The stored state stays clear, but a stale baseline holds money again at read time.
    await owner((trx) => sql`UPDATE trustwork.screening_list SET last_checked_at = now() - interval '30 days' WHERE baseline`.execute(trx));
    assert.deepEqual((await state({ kind: 'person', id: fresh.id })).reasons, ['lists_unavailable']);
    await owner((trx) => sql`UPDATE trustwork.screening_list SET last_checked_at = now() WHERE baseline`.execute(trx));
  });

  await t.test('only clear against the active baseline versions releases money; insufficient_name keeps it held', async () => {
    const mono = await person(admin, 'Exampleton');
    assert.equal((await screen(worker, { kind: 'person', id: mono.id })).outcome, 'insufficient_name');
    const s = await state({ kind: 'person', id: mono.id });
    assert.deepEqual([s.moneyHeld, s.reasons], [true, ['insufficient_name']]);
    // A forged clear that omits an active baseline version is refused by the database.
    const other = await person(admin, 'Rowena Clearfield');
    const names = await tx(worker, (trx) => screeningWorker.subjectNames(trx, { kind: 'person', id: other.id }));
    await rejects(tx(worker, (trx) => screeningWorker.recordResult(trx, {
      subject: { kind: 'person', id: other.id }, trigger: 'registration', namesDigest: names.namesDigest, listVersionIds: [world.versions.cons], outcome: 'clear',
      matcherVersion: MATCHER_VERSION, fuzzyThreshold: null, screenedNamesDigest: 'b'.repeat(64), matches: [],
    })), '23514', 'screening.stale_versions');
    // A new baseline version makes an earlier clear due for re-screening: money is held until the subject is screened again.
    const fresh = await person(admin, 'Rowena Clearwater');
    assert.equal((await screen(worker, { kind: 'person', id: fresh.id })).outcome, 'clear');
    await activateList(worker, world.lists.cons, [...(await import('./helpers.js')).CONS_ENTRIES, { uid: '930002', type: 'individual', firstName: 'Ansel', lastName: 'MOCKRIDGE', programs: ['SYNTHETIC-D'] }]);
    assert.deepEqual((await state({ kind: 'person', id: fresh.id })).reasons, ['rescreen_due']);
    assert.equal(await tx(worker, (trx) => screeningWorker.shouldScreen(trx, { kind: 'person', id: fresh.id }, false)), true, 'sign-in screens again when newer lists are active');
    assert.equal((await screen(worker, { kind: 'person', id: fresh.id }, CONFIG, 'sign_in')).outcome, 'clear');
    assert.equal((await state({ kind: 'person', id: fresh.id })).moneyHeld, false);
    assert.equal(await tx(worker, (trx) => screeningWorker.shouldScreen(trx, { kind: 'person', id: fresh.id }, false)), false, 'nothing changed: no screening at sign-in');
  });

  await t.test('a possible match holds money, opens one queue item with a notification that names nobody, and never blocks sign-in', async () => {
    const zorvan = await person(admin, 'Zorvan Exampleton');
    const result = await screen(worker, { kind: 'person', id: zorvan.id });
    assert.deepEqual([result.outcome, result.opened, result.moneyHeld], ['possible_match', 1, true]);
    const s = await state({ kind: 'person', id: zorvan.id });
    assert.deepEqual([s.moneyHeld, s.suspended, s.reasons], [true, false, ['review_pending']]);
    const subjectTx = (fn: Parameters<typeof as>[1]) => as(zorvan.id, fn);
    assert.equal(await subjectTx((trx) => screeningStates.callerSuspended(trx)), false, 'a possible match does not refuse sign-in');
    assert.equal(await screeningStates.sessionSuspended(runtime, zorvan.tokenHash.toString('hex')), false);
    const notes = (await outbox(SCREENING_EVENTS.reviewRequested)).filter((n) => n.payload.queueItemId === result.stateId);
    assert.equal(notes.length, 1);
    assert.deepEqual(Object.keys(notes[0]?.payload ?? {}).sort(), ['mutable', 'queueItemId']);
    assert.equal(notes[0]?.payload.mutable, false, 'the staff notification cannot be muted');
    assert.ok(!JSON.stringify(notes).toLowerCase().includes('exampleton'), 'the notification names nobody');
    // Screening again does not open a second item or a second notification; nothing auto-clears.
    assert.equal((await screen(worker, { kind: 'person', id: zorvan.id })).opened, 0);
    assert.equal((await outbox(SCREENING_EVENTS.reviewRequested)).filter((n) => n.payload.queueItemId === result.stateId).length, 1);
    const queue = await as(staff.moderator, (trx) => screeningStaff.queue(trx, { serviceLevelDays: 1, now: new Date() }));
    const item = queue.find((q) => q.subject.id === zorvan.id);
    assert.ok(item && !item.late && item.waiting === 1);
    const late = await as(staff.moderator, (trx) => screeningStaff.queue(trx, { serviceLevelDays: 1, now: new Date(Date.now() + 4 * 86_400_000) }));
    assert.equal(late.find((q) => q.subject.id === zorvan.id)?.late, true, 'late after the service level');
    const [match] = await matchesOf({ kind: 'person', id: zorvan.id });
    assert.deepEqual([match?.entryUid, match?.rule, match?.state, match?.screenedName, match?.matchedKey], ['920001', 'engine', 'open', 'Zorvan Exampleton', 'exampleton q zorvan']);
  });

  await t.test('the subject, a member of the subject company, a conflicted reviewer and non-compliance staff cannot decide', async () => {
    // The moderator (a compliance officer) is themselves matched.
    await owner((trx) => trx.updateTable('person').set({ display_name: 'Orla Synthetic Testworthy' }).where('id', '=', staff.moderator).execute());
    await screen(worker, { kind: 'person', id: staff.moderator }, CONFIG, 'name_change');
    const [own] = await as(staff.lead, (trx) => screeningStaff.matchesOf(trx, { kind: 'person', id: staff.moderator }));
    assert.ok(own);
    const moderatorCtx = await elevate(staff.moderator);
    await rejects(as(staff.moderator, (trx) => screeningStaff.confirm(trx, moderatorCtx, { matchId: own.id, reason: 'Synthetic', evidence: 'other' })), '42501', 'screening.self_decision');
    await rejects(as(staff.moderator, (trx) => screeningStaff.proposeNotSamePerson(trx, moderatorCtx, { matchId: own.id, reason: 'Synthetic', evidence: 'other' })), '42501', 'screening.self_decision');
    // ops is a compliance officer and an administrator of the matched company.
    const northwind = await company(admin, 'Northwind Synthetic Supply', [staff.ops]);
    assert.equal((await screen(worker, { kind: 'company', id: northwind }, CONFIG, 'company_change')).outcome, 'possible_match');
    const [companyMatch] = await matchesOf({ kind: 'company', id: northwind });
    const opsCtx = await elevate(staff.ops);
    await rejects(as(staff.ops, (trx) => screeningStaff.confirm(trx, opsCtx, { matchId: companyMatch!.id, reason: 'Synthetic', evidence: 'other' })), '42501', 'screening.subject_member');
    // The lead declared a conflict with Milo.
    const milo = await person(admin, 'Milo Fictivsky');
    await screen(worker, { kind: 'person', id: milo.id });
    await owner((trx) => trx.insertInto('staff_conflict_declaration').values({ staff_person_id: staff.lead, conflict_person_id: milo.id, reason: 'Synthetic: a relative' }).execute());
    const [miloMatch] = await matchesOf({ kind: 'person', id: milo.id });
    const leadCtx = await elevate(staff.lead);
    await rejects(as(staff.lead, (trx) => screeningStaff.confirm(trx, leadCtx, { matchId: miloMatch!.id, reason: 'Synthetic', evidence: 'other' })), '42501', 'admin.conflict_of_interest');
    // Staff without a compliance role, a participant, and a compliance officer without an elevation.
    const agentCtx = await elevate(staff.agent);
    await rejects(as(staff.agent, (trx) => screeningStaff.confirm(trx, agentCtx, { matchId: miloMatch!.id, reason: 'Synthetic', evidence: 'other' })), '42501', 'admin.forbidden');
    await rejects(as(milo.id, (trx) => screeningStaff.confirm(trx, { ...agentCtx }, { matchId: miloMatch!.id, reason: 'Synthetic', evidence: 'other' })), '42501', 'admin.elevation_required');
    await rejects(as(staff.moderator, (trx) => screeningStaff.confirm(trx, { ...moderatorCtx, elevationId: agentCtx.elevationId }, { matchId: miloMatch!.id, reason: 'Synthetic', evidence: 'other' })), '42501', 'admin.elevation_required');
    // A reason and an evidence category are required.
    await rejects(as(staff.moderator, (trx) => screeningStaff.confirm(trx, moderatorCtx, { matchId: miloMatch!.id, reason: ' ', evidence: 'other' })), '22023', 'screening.reason_required');
    // The trigger refuses the same for any writer, the owner included.
    await rejects(owner((trx) => trx.insertInto('screening_decision').values({ match_id: own.id, kind: 'confirm', decided_by: staff.moderator, reason: 'Synthetic', evidence_category: 'other' }).execute()), '42501', 'screening.self_decision');
    await rejects(owner((trx) => trx.insertInto('screening_decision').values({ match_id: companyMatch!.id, kind: 'confirm', decided_by: staff.ops, reason: 'Synthetic', evidence_category: 'other' }).execute()), '42501', 'screening.subject_member');
    await rejects(owner((trx) => trx.insertInto('screening_decision').values({ match_id: miloMatch!.id, kind: 'confirm', decided_by: staff.lead, reason: 'Synthetic', evidence_category: 'other' }).execute()), '42501', 'admin.conflict_of_interest');
    assert.equal((await matchesOf({ kind: 'person', id: milo.id }))[0]?.state, 'open', 'nothing was decided');
  });

  await t.test('not the same person needs a second person; the generic approval path refuses screening actions', async () => {
    const orla = await person(admin, 'Orla Testworthy');
    await screen(worker, { kind: 'person', id: orla.id });
    const [match] = await matchesOf({ kind: 'person', id: orla.id });
    const modCtx = await elevate(staff.moderator);
    await as(staff.moderator, (trx) => screeningStaff.proposeNotSamePerson(trx, modCtx, { matchId: match!.id, reason: 'Synthetic: different date of birth on the identity document', evidence: 'identity_document' }));
    const proposed = await as(staff.lead, (trx) => screeningStaff.match(trx, match!.id));
    assert.equal(proposed?.state, 'pending_second');
    assert.equal(proposed?.pendingApproval?.action, 'screening.clear_match');
    assert.equal((await state({ kind: 'person', id: orla.id })).moneyHeld, true, 'still held while the second person has not decided');
    const digest = proposed!.pendingApproval!.actionDigest;
    await rejects(as(staff.moderator, (trx) => screeningStaff.decideProposal(trx, modCtx, { matchId: match!.id, decision: 'approve', actionDigest: digest, reason: 'Synthetic' })), '42501', 'screening.second_person_required');
    const leadCtx = await elevate(staff.lead);
    await rejects(as(staff.lead, (trx) => approvals.decide(trx, leadCtx, proposed!.pendingApproval!.id, 'approve', digest)), '42501', 'admin.forbidden');
    await rejects(as(staff.lead, (trx) => screeningStaff.decideProposal(trx, leadCtx, { matchId: match!.id, decision: 'approve', actionDigest: 'c'.repeat(64), reason: 'Synthetic' })), '23514', 'access.approval_digest_mismatch');
    await rejects(runtime.query("UPDATE trustwork.screening_match SET state = 'not_same_person'"), '42501');
    await rejects(runtime.query('DELETE FROM trustwork.screening_match'), '42501');
    // Reject sends it back to open; a new proposal and a second person's approval clear it.
    await as(staff.lead, (trx) => screeningStaff.decideProposal(trx, leadCtx, { matchId: match!.id, decision: 'reject', actionDigest: digest, reason: 'Synthetic: ask for the document again' }));
    assert.equal((await as(staff.lead, (trx) => screeningStaff.match(trx, match!.id)))?.state, 'open');
    await as(staff.moderator, (trx) => screeningStaff.proposeNotSamePerson(trx, modCtx, { matchId: match!.id, reason: 'Synthetic: the document shows another birth year', evidence: 'date_of_birth' }));
    const again = await as(staff.lead, (trx) => screeningStaff.match(trx, match!.id));
    await as(staff.lead, (trx) => screeningStaff.decideProposal(trx, leadCtx, { matchId: match!.id, decision: 'approve', actionDigest: again!.pendingApproval!.actionDigest, reason: 'Synthetic: checked' }));
    const cleared = await state({ kind: 'person', id: orla.id });
    assert.deepEqual([cleared.moneyHeld, cleared.reasons], [false, []], 'a decided not-same-person releases money');
    const approval = await ownerRows(admin, (trx) => trx.selectFrom('second_person_approval').selectAll().where('id', '=', again!.pendingApproval!.id).executeTakeFirstOrThrow());
    assert.deepEqual([approval.action, approval.status, approval.requested_by, approval.approved_by], ['screening.clear_match', 'consumed', staff.moderator, staff.lead]);
    const audit = await ownerRows(admin, (trx) => trx.selectFrom('admin_audit_event').select(['action', 'actor_person_id']).where('object_id', '=', match!.id).orderBy('sequence').execute());
    assert.deepEqual(audit.map((a) => a.action), ['screening.not_same_person_proposed', 'screening.not_same_person_rejected', 'screening.not_same_person_proposed', 'screening.not_same_person_approved']);
  });

  await t.test('two concurrent approvals produce exactly one decision', async () => {
    const petra = await person(admin, 'Petra Samplewood');
    await screen(worker, { kind: 'person', id: petra.id });
    const [match] = await matchesOf({ kind: 'person', id: petra.id });
    const modCtx = await elevate(staff.moderator);
    await as(staff.moderator, (trx) => screeningStaff.proposeNotSamePerson(trx, modCtx, { matchId: match!.id, reason: 'Synthetic: another nationality', evidence: 'nationality' }));
    const digest = (await as(staff.lead, (trx) => screeningStaff.match(trx, match!.id)))!.pendingApproval!.actionDigest;
    const [leadCtx, opsCtx] = [await elevate(staff.lead), await elevate(staff.ops)];
    const outcomes = await Promise.all([
      settle(as(staff.lead, (trx) => screeningStaff.decideProposal(trx, leadCtx, { matchId: match!.id, decision: 'approve', actionDigest: digest, reason: 'Synthetic' }))),
      settle(as(staff.ops, (trx) => screeningStaff.decideProposal(trx, opsCtx, { matchId: match!.id, decision: 'approve', actionDigest: digest, reason: 'Synthetic' }))),
    ]);
    assert.equal(outcomes.filter((o) => o === null).length, 1, 'exactly one approval applies');
    const refused = outcomes.find((o) => o !== null);
    assert.ok(refused?.hint === 'screening.match_state', `the other sees the decided match (${refused?.hint})`);
    const decisions = await ownerRows(admin, (trx) => trx.selectFrom('screening_decision').select('kind').where('match_id', '=', match!.id).execute());
    assert.deepEqual(decisions.map((d) => d.kind).sort(), ['approve', 'propose_not_same_person']);
  });

  await t.test('a decision and a concurrent screening of the same subject both apply, in one lock order', async () => {
    for (const name of ['Milo Q Fictivsky', 'Milo R Fictivsky', 'Milo S Fictivsky']) {
      const subject = await person(admin, name);
      await screen(worker, { kind: 'person', id: subject.id });
      const [match] = await matchesOf({ kind: 'person', id: subject.id });
      const ctx = await elevate(staff.moderator);
      const outcomes = await Promise.all([
        settle(screen(worker, { kind: 'person', id: subject.id }, CONFIG, 'sign_in')),
        settle(as(staff.moderator, (trx) => screeningStaff.confirm(trx, ctx, { matchId: match!.id, reason: 'Synthetic: identifiers match', evidence: 'registration_identifier' }))),
        settle(screen(worker, { kind: 'person', id: subject.id }, CONFIG, 'scheduled')),
      ]);
      assert.deepEqual(outcomes.map((o) => o?.code ?? null), [null, null, null], 'no deadlock, no refusal');
      assert.equal((await state({ kind: 'person', id: subject.id })).suspended, true);
    }
  });

  await t.test('a decided entry is not flagged again for the subject unless its normalized names change', async () => {
    const petra = (await ownerRows(admin, (trx) => trx.selectFrom('person').select('id').where('display_name', '=', 'Petra Samplewood').executeTakeFirstOrThrow())).id;
    const again = await screen(worker, { kind: 'person', id: petra });
    assert.deepEqual([again.outcome, again.opened, again.moneyHeld], ['clear', 0, false], 'decided entry: the result is clear');
    // The same entry with a changed programme but unchanged names: still not flagged.
    const { CONS_ENTRIES } = await import('./helpers.js');
    const base = [...CONS_ENTRIES, { uid: '930002', type: 'individual' as const, firstName: 'Ansel', lastName: 'MOCKRIDGE', programs: ['SYNTHETIC-D'] }];
    await activateList(worker, world.lists.cons, base.map((e) => (e.uid === '930001' ? { ...e, programs: ['SYNTHETIC-E'] } : e)));
    assert.deepEqual([(await screen(worker, { kind: 'person', id: petra })).outcome, (await state({ kind: 'person', id: petra })).moneyHeld], ['clear', false]);
    // Its names change (a new alias): the decided match re-opens and money is held again.
    await activateList(worker, world.lists.cons, base.map((e) => (e.uid === '930001' ? { ...e, aliases: [{ firstName: 'Petra M', lastName: 'SAMPLEWOOD-ROE' }] } : e)));
    const reopened = await screen(worker, { kind: 'person', id: petra });
    assert.deepEqual([reopened.outcome, reopened.opened, reopened.moneyHeld], ['possible_match', 1, true]);
    assert.equal((await matchesOf({ kind: 'person', id: petra }))[0]?.state, 'open');
  });

  await t.test('confirm suspends the subject, ends their sessions and prepares a report draft; appeals go to another reviewer; reversal needs two', async () => {
    const zorvan = (await ownerRows(admin, (trx) => trx.selectFrom('person').select('id').where('display_name', '=', 'Zorvan Exampleton').executeTakeFirstOrThrow())).id;
    // Newer list versions were activated above: screen again (the open match stays open, nothing auto-clears).
    assert.deepEqual([(await screen(worker, { kind: 'person', id: zorvan }, CONFIG, 'sign_in')).opened, (await state({ kind: 'person', id: zorvan })).reasons], [0, ['review_pending']]);
    const [match] = await matchesOf({ kind: 'person', id: zorvan });
    const modCtx = await elevate(staff.moderator);
    await as(staff.moderator, (trx) => screeningStaff.confirm(trx, modCtx, { matchId: match!.id, reason: 'Synthetic: identifiers match', evidence: 'registration_identifier' }));
    const s = await state({ kind: 'person', id: zorvan });
    assert.deepEqual([s.moneyHeld, s.suspended, s.reasons], [true, true, ['confirmed']]);
    const live = await ownerRows(admin, (trx) => trx.selectFrom('session').select('id').where('person_id', '=', zorvan).where('revoked_at', 'is', null).execute());
    assert.equal(live.length, 0, 'every live session ended');
    assert.equal(await as(zorvan, (trx) => screeningStates.callerSuspended(trx)), true);
    const drafts = await as(staff.lead, (trx) => screeningStaff.reportDrafts(trx));
    const draft = drafts.find((d) => d.match_id === match!.id);
    assert.ok(draft && draft.list_code === 'ofac-sdn' && draft.entry_uid === '920001' && draft.status === 'draft');
    const due = new Date(draft.due_on);
    assert.ok(due.getTime() - Date.now() >= 11 * 86_400_000 && due.getTime() - Date.now() <= 16 * 86_400_000, 'ten business days');
    const status = await (async () => {
      const own = await as(zorvan, (trx) => screeningSubjects.own(trx, null));
      return [own.state.suspended, own.appealable];
    })();
    assert.deepEqual(status, [true, true]);
    // Appeal: only the subject; the reviewer who confirmed cannot decide it; a reversal needs a second person.
    await rejects(as(staff.lead, (trx) => screeningSubjects.appeal(trx, { companyId: null, reason: 'Not me' })), '23514', 'screening.nothing_to_appeal');
    assert.equal(await as(zorvan, (trx) => screeningSubjects.appeal(trx, { companyId: null, reason: 'Synthetic: I have never used another name' })), 1);
    await rejects(as(zorvan, (trx) => screeningSubjects.appeal(trx, { companyId: null, reason: 'Again' })), '23514', 'screening.nothing_to_appeal');
    await rejects(as(staff.moderator, (trx) => screeningStaff.decideAppeal(trx, modCtx, { matchId: match!.id, decision: 'uphold', reason: 'Synthetic', evidence: 'other' })), '42501', 'screening.same_reviewer');
    const leadCtx = await elevate(staff.lead);
    await as(staff.lead, (trx) => screeningStaff.decideAppeal(trx, leadCtx, { matchId: match!.id, decision: 'propose_reversal', reason: 'Synthetic: the identifiers belong to someone else', evidence: 'identity_document' }));
    const pending = await as(staff.ops, (trx) => screeningStaff.match(trx, match!.id));
    assert.deepEqual([pending?.state, pending?.pendingApproval?.action], ['pending_reversal', 'screening.reverse_confirmation']);
    assert.equal((await state({ kind: 'person', id: zorvan })).suspended, true, 'suspended until the second person approves');
    await rejects(as(staff.lead, (trx) => screeningStaff.decideProposal(trx, leadCtx, { matchId: match!.id, decision: 'approve', actionDigest: pending!.pendingApproval!.actionDigest, reason: 'Synthetic' })), '42501', 'screening.second_person_required');
    const opsCtx = await elevate(staff.ops);
    await as(staff.ops, (trx) => screeningStaff.decideProposal(trx, opsCtx, { matchId: match!.id, decision: 'approve', actionDigest: pending!.pendingApproval!.actionDigest, reason: 'Synthetic: agreed' }));
    const after = await state({ kind: 'person', id: zorvan });
    assert.deepEqual([after.moneyHeld, after.suspended], [false, false]);
    assert.equal(await as(zorvan, (trx) => screeningStates.callerSuspended(trx)), false);
    const standing = (await outbox(SCREENING_EVENTS.subjectStatusChanged)).filter((e) => (e.payload.subject as { id: string }).id === zorvan);
    assert.ok(standing.length >= 2);
    for (const e of standing) assert.deepEqual(Object.keys(e.payload).sort(), ['moneyHeld', 'subject', 'suspended'], 'identifiers and flags only');
  });

  await t.test('records are staff-only and append-only; the worker and the runtime role cannot cross', async () => {
    const zorvan = (await ownerRows(admin, (trx) => trx.selectFrom('person').select('id').where('display_name', '=', 'Zorvan Exampleton').executeTakeFirstOrThrow())).id;
    for (const table of Object.keys(TABLE_COLUMNS)) {
      const count = async (personId: string) => as(personId, async (trx) => Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(`trustwork.${table}`)}`.execute(trx)).rows[0]?.n));
      assert.equal(await count(zorvan), 0, `${table}: the subject reads nothing directly`);
      assert.equal(await count(staff.customer), 0, `${table}: another participant reads nothing`);
      assert.equal(await count(staff.agent), 0, `${table}: staff without a compliance role read nothing`);
      assert.ok((await count(staff.auditor)) > 0, `${table}: the auditor reads`);
      assert.ok((await count(staff.moderator)) > 0, `${table}: a compliance officer reads`);
      await rejects(worker.query(`SELECT 1 FROM trustwork.${table}`), '42501');
      await rejects(runtime.query(`DELETE FROM trustwork.${table}`), '42501');
    }
    await rejects(owner((trx) => sql`UPDATE trustwork.screening_result SET outcome = 'clear'`.execute(trx)), '23000', 'audit.append_only');
    await rejects(owner((trx) => sql`DELETE FROM trustwork.screening_decision`.execute(trx)), '23000', 'audit.append_only');
    await rejects(owner((trx) => sql`DELETE FROM trustwork.screening_match`.execute(trx)), '23514', 'screening.record_permanent');
    await rejects(owner((trx) => sql`UPDATE trustwork.screening_match SET state = 'confirmed' WHERE state = 'not_same_person'`.execute(trx)), '23514', 'screening.match_transition');
    await rejects(runtime.query("SELECT trustwork.screening_record_result('person', $1, 'registration', $2, '{}', 'clear', 'x', NULL, $2, '[]')", [zorvan, 'a'.repeat(64)]), '42501');
    await rejects(runtime.query('SELECT * FROM trustwork.screening_candidates($1, $2, $3)', [['individual'], ['x'], []]), '42501');
    await rejects(worker.query("SELECT trustwork.screening_confirm_match('{}'::jsonb, $1, 'x', 'other')", [zorvan]), '42501');
    await rejects(worker.query('SELECT * FROM trustwork.screening_state($1, $2)', ['person', zorvan]), '42501');
  });

  await t.test('renames append name-change events with identifiers only; the sweep finds unscreened and renamed subjects', async () => {
    const rowena = await person(admin, 'Rowena Clearwood');
    const target = await company(admin, 'Synthetic Quarry Partners');
    await owner((trx) => trx.updateTable('person').set({ display_name: 'Rowena Clearwood Synthetic' }).where('id', '=', rowena.id).execute());
    await owner((trx) => trx.updateTable('company').set({ display_name: 'Synthetic Quarry Partners Two' }).where('id', '=', target).execute());
    await owner((trx) => trx.updateTable('company').set({ public_description: 'unchanged name' }).where('id', '=', target).execute());
    const personEvents = (await outbox('identity.name_changed')).filter((e) => e.aggregate_id === rowena.id);
    const companyEvents = (await outbox('company.renamed')).filter((e) => e.aggregate_id === target);
    assert.equal(personEvents.length, 1);
    assert.equal(companyEvents.length, 1, 'only a name change appends the event');
    assert.deepEqual(personEvents[0]?.payload, { personId: rowena.id });
    assert.deepEqual(companyEvents[0]?.payload, { companyId: target });
    const due = await tx(worker, (trx) => screeningWorker.sweepDue(trx, 1000));
    assert.ok(due.some((s) => s.id === rowena.id) && due.some((s) => s.id === target));
    await screen(worker, { kind: 'person', id: rowena.id }, CONFIG, 'scheduled');
    assert.ok(!(await tx(worker, (trx) => screeningWorker.sweepDue(trx, 1000))).some((s) => s.id === rowena.id), 'screened subjects leave the sweep');
    await owner((trx) => trx.updateTable('person').set({ display_name: 'Rowena Clearwood Renamed' }).where('id', '=', rowena.id).execute());
    assert.ok((await tx(worker, (trx) => screeningWorker.sweepDue(trx, 1000))).some((s) => s.id === rowena.id), 'a rename brings the subject back');
    void SDN_ENTRIES;
  });

  await t.test('the effective state of a subject that does not exist is refused, not invented', async () => {
    await rejects(tx(runtime, (trx) => screeningStates.state(trx, { kind: 'person', id: '00000000-0000-4000-8000-0000000000aa' })), 'P0002', 'screening.subject_not_found');
    await withMaintenance(admin, async () => undefined);
  });
});
