import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, type Transaction } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { appeals } from '../../packages/data/src/repositories/admin.js';
import {
  confirmationRequests, confirmationResponses, credentials, derivedRecords, portfolio, relations, reputationAppeals, reputationPublic, type RequestInsert,
} from '../../packages/data/src/repositories/reputation.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { seedFixtures } from '../data/helpers/seed.js';
import { approvedChange, as as asWith, baselinePlan, buildAgreement, businessDate, fails, staffWorld, type Fixture } from '../trust/helpers.js';
import { claimAndDecide } from './helpers.js';

/**
 * REP-001 database layer under the real runtime role (FORCE RLS, no mocks): confirmation requests only between the two
 * sides of a recorded relationship, never to oneself, an employee or a relative, once, within the daily limit, with
 * one reminder after three days; final human answers before the deadline; concurrency on requests, answers and
 * reminders; contribution and timeliness records derived only from canonical records (client-caused delay excluded,
 * the party as subject, never an employee) and never inserted at runtime; appeals into DATA-002's queue; public reads
 * without numbers, documents or counterparties; staff without any read path.
 */
const HUB_ID = '00000000-0000-4000-8000-0000000e0f01';
const db = await provisionTestDatabase('reputation_db');

test('reputation builder database: relationships, conflicts, one request and one reminder, derivation, appeals and concurrency', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const seed = await seedFixtures(db.admin);
  await withMaintenance(db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const f: Fixture = { admin: db.admin, app: db.app, people: { petr: seed.people.petr, boris: seed.people.boris, carl: seed.people.carl, xenia: seed.people.xenia, anna: seed.people.anna }, supplier: seed.companies.supplier, project: seed.project };
  const { petr, boris, carl, anna } = f.people;
  const supplier = f.supplier;
  const as = <T>(personId: string, fn: (trx: Transaction) => Promise<T>) => asWith(f, personId, fn);
  const staff = await staffWorld(f, HUB_ID);
  const request = (over: Partial<RequestInsert> & Pick<RequestInsert, 'context_id'>): RequestInsert => ({
    requester_person_id: null, requester_company_id: supplier, addressed_person_id: petr, addressed_company_id: null, context_kind: 'agreement', portfolio_entry_id: null,
    statement_kind: 'delivered', statement: 'Synthetic: 40 m2 of pavers delivered and laid', no_incentive: true, no_conflict: true, requested_by_person_id: boris, ...over,
  });
  const answer = (requestId: string, over: Partial<Parameters<typeof confirmationResponses.insert>[1]> = {}) => ({
    confirmation_request_id: requestId, responder_person_id: petr, on_behalf_person_id: petr, on_behalf_company_id: null, decision: 'confirmed' as const, comment: null,
    consent_to_show: true, no_conflict: true, ...over,
  });

  const A = await buildAgreement(f, businessDate(-5), 'Synthetic patio A');
  const B = await buildAgreement(f, businessDate(-5), 'Synthetic patio B');
  const plan = await baselinePlan(f);
  await approvedChange(f, plan, { agreementId: B.agreement.id, cause: 'owner_request', accountable: { person: petr }, impactDays: 10 });

  await t.test('a confirmation without a recorded relationship is refused; the two sides of an accepted agreement may ask each other', async () => {
    await fails(as(boris, (trx) => confirmationRequests.insert(trx, request({ context_id: A.agreement.id, addressed_person_id: carl }))), 'reputation.no_recorded_relationship');
    await fails(as(boris, (trx) => confirmationRequests.insert(trx, request({ context_kind: 'project', context_id: f.project }))), 'reputation.no_recorded_relationship');
    await fails(as(boris, (trx) => confirmationRequests.insert(trx, request({ context_kind: 'task_assignment', context_id: A.agreement.id }))), 'reputation.no_recorded_relationship');
    await fails(as(petr, (trx) => confirmationRequests.insert(trx, request({ context_id: A.agreement.id, requester_person_id: petr, requester_company_id: null, requested_by_person_id: petr }))), 'reputation.self_confirmation');
    await fails(as(carl, (trx) => confirmationRequests.insert(trx, request({ context_id: A.agreement.id, requested_by_person_id: carl }))), '42501');
    await fails(as(boris, (trx) => confirmationRequests.insert(trx, request({ context_id: A.agreement.id, no_incentive: false }))), '23514');
    const row = await as(boris, (trx) => confirmationRequests.insert(trx, request({ context_id: A.agreement.id })));
    assert.equal(Math.round((row.due_at.getTime() - row.requested_at.getTime()) / 86_400_000), 30, 'the server sets a 30-day deadline');
    assert.equal(row.reminder_sent_at, null);
    // The addressee sees the request; an outsider does not.
    assert.equal((await as(petr, (trx) => confirmationRequests.get(trx, row.id)))?.id, row.id);
    assert.equal(await as(carl, (trx) => confirmationRequests.get(trx, row.id)), undefined);
    assert.equal(await as(staff.reviewerA, (trx) => confirmationRequests.get(trx, row.id)), undefined, 'staff have no read path');
  });

  await t.test('one request per counterparty, context and statement: two concurrent requests, one wins; the same request never again', async () => {
    const body = request({ context_id: A.agreement.id, requester_person_id: petr, requester_company_id: null, addressed_person_id: null, addressed_company_id: supplier, statement_kind: 'paid_on_time', requested_by_person_id: petr });
    const results = await Promise.allSettled([as(petr, (trx) => confirmationRequests.insert(trx, body)), as(petr, (trx) => confirmationRequests.insert(trx, body))]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    const e = rejected.reason as { hint?: string; constraint?: string };
    assert.ok(e.hint === 'reputation.already_requested' || e.constraint === 'confirmation_request_once', JSON.stringify(e));
    await fails(as(petr, (trx) => confirmationRequests.insert(trx, body)), 'reputation.already_requested');
  });

  await t.test('answers: the addressed side in person, once, never the requester side; concurrent answers, one wins', async () => {
    const sent = await as(petr, (trx) => confirmationRequests.listSent(trx, { person: petr, company: null }));
    const toSupplier = sent[0]!;
    await fails(as(petr, (trx) => confirmationResponses.insert(trx, answer(toSupplier.id))), 'reputation.not_authorised');
    await fails(as(carl, (trx) => confirmationResponses.insert(trx, answer(toSupplier.id, { responder_person_id: carl, on_behalf_person_id: null, on_behalf_company_id: supplier }))), '42501');
    const theirs = answer(toSupplier.id, { responder_person_id: boris, on_behalf_person_id: null, on_behalf_company_id: supplier, decision: 'declined', comment: 'Synthetic: paid 12 days late', consent_to_show: false });
    const race = await Promise.allSettled([as(boris, (trx) => confirmationResponses.insert(trx, theirs)), as(boris, (trx) => confirmationResponses.insert(trx, theirs))]);
    assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    await fails(as(boris, (trx) => confirmationResponses.insert(trx, { ...theirs, decision: 'confirmed', comment: null })), 'reputation.already_answered');
    await fails(as(boris, (trx) => trx.updateTable('confirmation_response').set({ decision: 'confirmed' } as never).where('confirmation_request_id', '=', toSupplier.id).execute()), '42501');
    // The supplier's request to Petr: confirmed.
    const mine = (await as(boris, (trx) => confirmationRequests.listSent(trx, { person: null, company: supplier })))[0]!;
    await as(petr, (trx) => confirmationResponses.insert(trx, answer(mine.id)));
  });

  await t.test('one reminder, after three days, by the requester, never after an answer, a withdrawal or the deadline', async () => {
    const early = await as(boris, (trx) => confirmationRequests.insert(trx, request({ context_id: A.agreement.id, statement_kind: 'quality_met' })));
    await fails(as(boris, (trx) => confirmationRequests.remind(trx, early.id)), 'reputation.reminder_too_early');
    assert.equal(await as(petr, (trx) => confirmationRequests.remind(trx, early.id)), undefined, 'the addressee cannot remind');
    const backdated = (days: number, statement: 'on_time' | 'role_performed') => withMaintenance(db.admin, async (trx) => (await trx.insertInto('confirmation_request').values({
      ...request({ context_id: A.agreement.id, statement_kind: statement }), requested_at: new Date(Date.now() - days * 86_400_000), due_at: new Date(Date.now() + (30 - days) * 86_400_000),
    }).returningAll().executeTakeFirstOrThrow()));
    const old = await backdated(4, 'on_time');
    const race = await Promise.allSettled([as(boris, (trx) => confirmationRequests.remind(trx, old.id)), as(boris, (trx) => confirmationRequests.remind(trx, old.id))]);
    assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.hint, 'reputation.reminder_already_sent');
    await fails(as(boris, (trx) => trx.updateTable('confirmation_request').set({ statement: 'changed' } as never).where('id', '=', old.id).execute()), '42501');
    const expired = await backdated(31, 'role_performed');
    await fails(as(petr, (trx) => confirmationResponses.insert(trx, answer(expired.id))), 'reputation.request_closed');
    await fails(as(boris, (trx) => confirmationRequests.remind(trx, expired.id)), 'reputation.request_closed');
    await as(boris, (trx) => confirmationRequests.withdraw(trx, early.id));
    await fails(as(petr, (trx) => confirmationResponses.insert(trx, answer(early.id))), 'reputation.request_closed');
  });

  await t.test('contributions and timeliness come only from canonical records; client-caused delay is excluded; the party is the subject, never an employee', async () => {
    await claimAndDecide(f, A.agreement.id, A.byKind.deliver);
    await claimAndDecide(f, B.agreement.id, B.byKind.deliver);
    await claimAndDecide(f, A.agreement.id, A.byKind.pay);
    const advice = await as(boris, (trx) => confirmationRequests.insert(trx, request({ context_id: A.agreement.id, statement_kind: 'advice_delivered', statement: 'Synthetic: drainage advice before laying' })));
    await as(petr, (trx) => confirmationResponses.insert(trx, answer(advice.id)));
    await fails(as(boris, (trx) => derivedRecords.derive(trx, { person: petr, company: null })), 'reputation.not_authorised');
    const n = await as(boris, (trx) => derivedRecords.derive(trx, { person: null, company: supplier }));
    assert.ok(n >= 3);
    assert.equal(await as(boris, (trx) => derivedRecords.derive(trx, { person: null, company: supplier })), 0, 'idempotent');
    const timeliness = await as(boris, (trx) => derivedRecords.timeliness(trx, { person: null, company: supplier }));
    const byAgreement = (id: string) => timeliness.find((x) => x.agreement_id === id)!;
    assert.deepEqual([byAgreement(A.agreement.id).kind, byAgreement(A.agreement.id).excluded_reason, byAgreement(A.agreement.id).attribution], ['delivery', null, 'subject']);
    assert.ok(Number(byAgreement(A.agreement.id).delta_seconds) > 0, 'performed after the end of the due day: late');
    assert.deepEqual([byAgreement(B.agreement.id).excluded_reason, byAgreement(B.agreement.id).attribution], ['client_caused_change', 'counterparty'], 'the owner\'s change excuses the supplier');
    assert.equal(byAgreement(B.agreement.id).plan_change_ids.length, 1);
    for (const x of timeliness) assert.deepEqual([x.subject_person_id, x.subject_company_id], [null, supplier], 'the company is the subject, never the employee who acted');
    await as(boris, (trx) => derivedRecords.derive(trx, { person: boris, company: null }));
    assert.deepEqual(await as(boris, (trx) => derivedRecords.timeliness(trx, { person: boris, company: null })), [], 'no per-employee metric exists');
    const contributions = await as(boris, (trx) => derivedRecords.contributions(trx, { person: null, company: supplier }));
    assert.deepEqual(contributions.map((c) => [c.kind, c.source_kind, c.appeal_subject_kind]), [['consultation_given', 'confirmation_response', 'confirmation_response']]);
    await as(petr, (trx) => derivedRecords.derive(trx, { person: petr, company: null }));
    const payments = await as(petr, (trx) => derivedRecords.timeliness(trx, { person: petr, company: null }));
    assert.deepEqual(payments.map((x) => x.kind), ['payment'], 'the client builds a payment record too');
    assert.equal((await as(carl, (trx) => derivedRecords.timeliness(trx, { person: null, company: supplier }))).length, 0);
    assert.equal((await as(staff.reviewerA, (trx) => derivedRecords.timeliness(trx, { person: null, company: supplier }))).length, 0);
    // The runtime role never writes derived records or limitations, and nothing is ever rewritten.
    await fails(as(boris, (trx) => trx.insertInto('contribution_record').values({
      holder_person_id: null, holder_company_id: supplier, kind: 'publication', source_kind: 'agreement', source_id: A.agreement.id, appeal_subject_kind: 'performance_observation',
      appeal_subject_id: A.agreement.id, outcome: '{}', occurred_at: new Date(),
    }).execute()), '42501');
    await fails(as(boris, (trx) => sql`INSERT INTO trustwork.timeliness_observation (subject_company_id, kind, agreement_id, source_observation_id, attribution) VALUES (${supplier}::uuid, 'delivery', ${A.agreement.id}::uuid, ${A.agreement.id}::uuid, 'subject')`.execute(trx)), '42501');
    await fails(as(boris, (trx) => sql`INSERT INTO trustwork.automated_limitation (subject_company_id, module, scope, reason_code, evidence) VALUES (${supplier}::uuid, 'reputation', 'observation', 'rate_limited', '[]')`.execute(trx)), '42501');
    await fails(withMaintenance(db.admin, (trx) => trx.deleteFrom('timeliness_observation').execute()), 'audit.append_only');
  });

  await t.test('appeals: the requester appeals a counterparty\'s answer and an automated refusal; a different person decides', async () => {
    const declined = (await as(petr, (trx) => confirmationRequests.listSent(trx, { person: petr, company: null })))[0]!;
    const response = (await as(petr, (trx) => confirmationResponses.forRequests(trx, [declined.id])))[0]!;
    await fails(as(boris, (trx) => reputationAppeals.file(trx, { hubId: HUB_ID, subjectKind: 'confirmation_response', subjectId: response.id, reason: 'mine' })), 'reputation.not_found');
    const appeal = await as(petr, (trx) => reputationAppeals.file(trx, { hubId: HUB_ID, subjectKind: 'confirmation_response', subjectId: response.id, reason: 'Synthetic: the bank record shows the payment on time' }));
    assert.deepEqual([appeal.original_decided_by, appeal.appellant_person_id, appeal.status], [boris, petr, 'submitted']);
    assert.equal((await as(petr, (trx) => reputationAppeals.states(trx, 'confirmation_response', [response.id]))).get(response.id), 'submitted');
    assert.equal((await as(carl, (trx) => reputationAppeals.states(trx, 'confirmation_response', [response.id]))).size, 0);
    const decided = await as(staff.reviewerA, async (trx) => appeals.decide(trx, await staff.elevate(staff.reviewerA), appeal.id, 'overturned'));
    assert.equal(decided.status, 'overturned');

    const refusal = { hubId: HUB_ID, reasonCode: 'no_recorded_relationship', scope: 'confirmation_request' as const, requester: { person: null, company: supplier }, addressed: { person: carl, company: null },
      contextKind: 'agreement', contextId: A.agreement.id, statementKind: 'delivered', requestId: null, reason: 'Synthetic: Carl inspected the work for the owner' };
    await fails(as(boris, (trx) => reputationAppeals.appealLimitation(trx, { ...refusal, reasonCode: 'relative_of_subject' })), 'reputation.limitation_not_found');
    await fails(as(carl, (trx) => reputationAppeals.appealLimitation(trx, refusal)), 'reputation.limitation_not_found');
    const limitationAppeal = await as(boris, (trx) => reputationAppeals.appealLimitation(trx, refusal));
    assert.equal(limitationAppeal.subject_kind, 'automated_limitation');
    const limitations = await as(boris, (trx) => derivedRecords.limitations(trx, { person: null, company: supplier }));
    assert.deepEqual(limitations.map((l) => [l.reason_code, l.scope, l.module]), [['no_recorded_relationship', 'confirmation_request', 'reputation']]);
    assert.deepEqual(limitations[0]!.evidence, [{ kind: 'agreement', id: A.agreement.id }, { kind: 'person', id: carl }]);
    await as(staff.reviewerB, async (trx) => appeals.decide(trx, await staff.elevate(staff.reviewerB), limitationAppeal.id, 'upheld'));
  });

  await t.test('credentials, checks and portfolio: the holder only; public reads show checked facts and consented work, never numbers or counterparties', async () => {
    const credential = await as(boris, (trx) => credentials.insert(trx, {
      holder_person_id: null, holder_company_id: supplier, kind: 'licence', jurisdiction: 'US-CA', credential_type: 'US-CA-CSLB-C8', issuer: 'Synthetic licence board', number: 'SYN-OK-2030-01-01-1',
      classification: 'C-8 concrete', coverage_minor: null, coverage_currency: null, valid_from: '2026-01-01', valid_until: '2030-01-01', visibility: 'public', supersedes_id: null, recorded_by_person_id: boris,
    }));
    await fails(as(petr, (trx) => credentials.insertCheck(trx, { credential_id: credential.id, hub_id: HUB_ID, register_code: 'fake.synthetic-register', outcome: 'match', register_valid_until: null, source_ref: null, requested_by_person_id: petr })), '42501');
    await as(boris, (trx) => credentials.insertCheck(trx, { credential_id: credential.id, hub_id: HUB_ID, register_code: 'fake.synthetic-register', outcome: 'match', register_valid_until: '2030-01-01', source_ref: 'synthetic', requested_by_person_id: boris }));
    assert.equal(await as(petr, (trx) => credentials.get(trx, credential.id)), undefined);
    await fails(as(petr, (trx) => credentials.insert(trx, {
      holder_person_id: null, holder_company_id: supplier, kind: 'licence', jurisdiction: 'US-CA', credential_type: 'US-CA-CSLB-C8', issuer: 'Forged', number: null, classification: null,
      coverage_minor: null, coverage_currency: null, valid_from: null, valid_until: null, visibility: 'public', supersedes_id: null, recorded_by_person_id: petr,
    })), '42501');

    const external = await as(boris, (trx) => portfolio.insert(trx, {
      holder_person_id: null, holder_company_id: supplier, context_kind: null, context_id: null, external_description: 'Synthetic driveway, 2024, before joining the hub', title: 'Driveway',
      role: 'Contractor', period_from: '2024-04-01', period_to: '2024-05-01', scope_summary: null, visibility: 'public', supersedes_id: null, recorded_by_person_id: boris,
    }));
    const onPlatform = await as(boris, (trx) => portfolio.insert(trx, {
      holder_person_id: null, holder_company_id: supplier, context_kind: 'agreement', context_id: B.agreement.id, external_description: null, title: 'Patio B', role: 'Supplier and installer',
      period_from: null, period_to: null, scope_summary: 'Synthetic pavers', visibility: 'public', supersedes_id: null, recorded_by_person_id: boris,
    }));
    await fails(as(boris, (trx) => portfolio.insert(trx, {
      holder_person_id: null, holder_company_id: supplier, context_kind: 'project', context_id: f.project, external_description: null, title: 'Not ours', role: 'None', period_from: null,
      period_to: null, scope_summary: null, visibility: 'public', supersedes_id: null, recorded_by_person_id: boris,
    })), 'reputation.no_recorded_relationship');
    let shown = await as(carl, (trx) => reputationPublic.portfolio(trx, { person: null, company: supplier }));
    assert.deepEqual(shown.map((e) => [e.id, e.confirmation]), [[external.id, 'self_reported']], 'platform work waits for the counterparty\'s consent');
    const linked = await as(boris, (trx) => confirmationRequests.insert(trx, request({ context_id: B.agreement.id, portfolio_entry_id: onPlatform.id })));
    await fails(as(boris, (trx) => confirmationRequests.insert(trx, request({ context_id: A.agreement.id, statement_kind: 'paid_on_time', portfolio_entry_id: onPlatform.id }))), 'reputation.no_recorded_relationship');
    await as(petr, (trx) => confirmationResponses.insert(trx, answer(linked.id, { decision: 'partially', comment: 'Synthetic: one edge redone', consent_to_show: true })));
    shown = await as(carl, (trx) => reputationPublic.portfolio(trx, { person: null, company: supplier }));
    assert.deepEqual(shown.map((e) => e.confirmation).sort(), ['client_confirmed', 'self_reported']);
    const publicCreds = await as(carl, (trx) => reputationPublic.credentials(trx, { person: null, company: supplier }));
    assert.deepEqual(publicCreds.map((c) => [c.credential_type, c.check_outcome, c.check_hub_id]), [['US-CA-CSLB-C8', 'match', HUB_ID]]);
    const json = JSON.stringify({ shown, publicCreds });
    for (const secret of ['SYN-OK', B.agreement.id, petr, 'C-8 concrete']) assert.ok(!json.includes(secret), `${secret} leaked publicly`);
    // A person with a private profile shows nothing publicly.
    await as(petr, (trx) => portfolio.insert(trx, { holder_person_id: petr, holder_company_id: null, context_kind: null, context_id: null, external_description: 'Synthetic shed', title: 'Shed', role: 'Owner-builder', period_from: null, period_to: null, scope_summary: null, visibility: 'public', supersedes_id: null, recorded_by_person_id: petr }));
    assert.deepEqual(await as(carl, (trx) => reputationPublic.portfolio(trx, { person: petr, company: null })), []);
  });

  await t.test('employees and relatives of the subject never confirm, at request or at answer time', async () => {
    const C = await buildAgreement(f, businessDate(5), 'Synthetic patio C');
    // Anna answers for nobody here; a declared relative between Petr and Boris blocks both directions.
    await as(petr, (trx) => relations.insert(trx, { declarer_person_id: petr, other_person_id: boris, kind: 'relative' }));
    await fails(as(petr, (trx) => relations.insert(trx, { declarer_person_id: anna, other_person_id: boris, kind: 'relative' })), '42501');
    assert.equal((await as(boris, (trx) => relations.listMine(trx, petr))).length, 0, 'a declaration is private to its declarer');
    await fails(as(boris, (trx) => confirmationRequests.insert(trx, request({ context_id: C.agreement.id }))), 'reputation.relative_of_subject');
    const toSupplier = request({ context_id: C.agreement.id, requester_person_id: petr, requester_company_id: null, addressed_person_id: null, addressed_company_id: supplier, requested_by_person_id: petr, statement_kind: 'paid_on_time' });
    const pending = await as(petr, (trx) => confirmationRequests.insert(trx, toSupplier));
    await fails(as(boris, (trx) => confirmationResponses.insert(trx, answer(pending.id, { responder_person_id: boris, on_behalf_person_id: null, on_behalf_company_id: supplier }))), 'reputation.relative_of_subject');
    // A person who is or was employed by the subject's company never confirms for or about it.
    await withMaintenance(db.admin, (trx) => trx.insertInto('membership').values({
      person_id: petr, company_id: supplier, role: 'member', permissions: [], status: 'ended', valid_from: new Date('2026-01-01T00:00:00Z'), ended_at: new Date('2026-02-01T00:00:00Z'),
      ended_by: petr, ended_reason: 'synthetic: left the company',
    }).execute());
    await fails(as(petr, (trx) => confirmationRequests.insert(trx, { ...toSupplier, statement_kind: 'on_time' })), 'reputation.employee_of_subject');
    await fails(as(boris, (trx) => confirmationRequests.insert(trx, request({ context_id: C.agreement.id, statement_kind: 'on_time' }))), 'reputation.employee_of_subject');
  });
});
