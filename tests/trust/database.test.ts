import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, type Transaction } from '@trustwork/data';
import { withoutPrincipal } from '../../apps/api/src/common/db.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { appeals } from '../../packages/data/src/repositories/admin.js';
import {
  executionAgreements, executionClaims, executionConfirmations, executionDefects, executionDisputes, executionEvidence, performanceObservations, reputationSnapshots, reviewResponses,
  reviews, trustAppeals, type ClaimInsert,
} from '../../packages/data/src/repositories/execution.js';
import type { ObligationRow } from '../../packages/data/src/schema/transactions.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { seedFixtures } from '../data/helpers/seed.js';
import { approvedChange, artifactOn, as as asWith, baselinePlan, buildAgreement, businessDate, fails, staffWorld, type Fixture } from './helpers.js';

/**
 * EXE-001 database layer under the real runtime role (FORCE RLS, no mocks): claims only by the obligor and only one
 * open at a time; evidence only from the agreement's artifacts with their digest; decisions only by the counterparty's
 * person (no agent column exists) and never on one's own claim; supersession appends; fair timing from recorded plan
 * changes (a client-caused change never penalizes the supplier; the supplier's own change does; unknown causes and
 * missing dates are unknown, never late); reviews only for completed agreements, once per side, never about oneself;
 * disputes decided by a trust reviewer and appeals by a different one; appeals of reviews in DATA-002's queue; and
 * concurrency on decisions, claims and reviews.
 */
const db = await provisionTestDatabase('trust_db');

test('execution and trust database: authority, append-only evidence, fair timing, reviews, disputes and concurrency', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const seed = await seedFixtures(db.admin);
  await withMaintenance(db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const f: Fixture = { admin: db.admin, app: db.app, people: { petr: seed.people.petr, boris: seed.people.boris, carl: seed.people.carl, xenia: seed.people.xenia, anna: seed.people.anna }, supplier: seed.companies.supplier, project: seed.project };
  const { petr, boris, carl, xenia, anna } = f.people;
  const supplier = f.supplier;
  const as = <T>(personId: string, fn: (trx: Transaction) => Promise<T>) => asWith(f, personId, fn);
  const claimRow = (agreementId: string, o: ObligationRow, over: Partial<ClaimInsert> = {}): ClaimInsert => ({
    agreement_id: agreementId, obligation_id: o.id, defect_id: null, kind: o.kind === 'deliver' ? 'goods_delivery' : o.kind === 'perform' ? 'work_performed' : 'payment_made',
    claimant_person_id: o.obligor_person_id, claimant_company_id: o.obligor_company_id, lines: o.kind === 'deliver' ? [{ ref: 'q1', quantity: { value: '40', unit: 'm2' } }] : [],
    period_from: null, period_to: null, performed_at: new Date(), statement: 'Synthetic statement', supersedes_claim_id: null, recorded_by_person_id: o.obligor_person_id ?? boris, via: 'person', mandate_id: null, ...over,
  });
  const decide = (personId: string, claimId: string, agreementId: string, decision: 'accepted' | 'partially_accepted' | 'rejected', onBehalf: { person: string | null; company: string | null }) =>
    as(personId, async (trx) => {
      const row = await executionConfirmations.insert(trx, { claim_id: claimId, agreement_id: agreementId, decision, lines: [], note: decision === 'accepted' ? null : 'Synthetic reason', stage_code: null, decided_by_person_id: personId, on_behalf_person_id: onBehalf.person, on_behalf_company_id: onBehalf.company });
      await executionAgreements.observe(trx, agreementId);
      return row;
    });
  const PETR = { person: petr, company: null };
  const SUPPLIER = { person: null, company: supplier };

  const A = await buildAgreement(f, businessDate(-5), 'Synthetic patio A');
  let firstClaim = '';
  let partialConfirmation = '';

  await t.test('claims: the parties only, the obligor only, the kind fits the obligation, one open claim at a time, never in the future', async () => {
    for (const outsider of [carl, xenia, anna]) {
      assert.equal(await as(outsider, (trx) => executionAgreements.get(trx, A.agreement.id)), undefined);
      await fails(as(outsider, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver, { recorded_by_person_id: outsider }))), 'execution.not_found');
    }
    await fails(as(petr, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver, { claimant_person_id: petr, claimant_company_id: null, recorded_by_person_id: petr }))), 'execution.not_obligor');
    await fails(as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver, { kind: 'payment_made' }))), 'execution.kind_mismatch');
    await fails(as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver, { lines: [] }))), '23514');
    await fails(as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver, { performed_at: new Date(Date.now() + 86_400_000) }))), 'execution.in_future');
    await fails(as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver, { recorded_by_person_id: petr }))), 'execution.not_authorised');
    const claim = await as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver)));
    assert.deepEqual([claim.counterparty_person_id, claim.counterparty_company_id], [petr, null], 'the guard names the counterparty');
    await fails(as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver))), 'execution.claim_open');
    // Supersession appends a correction; the original stays and can no longer be decided or extended.
    const corrected = await as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver, { supersedes_claim_id: claim.id, lines: [{ ref: 'q1', quantity: { value: '38', unit: 'm2' } }] })));
    await fails(as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver, { supersedes_claim_id: claim.id }))), 'execution.not_supersedable');
    await fails(decide(petr, claim.id, A.agreement.id, 'accepted', PETR), 'execution.claim_not_open');
    firstClaim = corrected.id;
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('execution_claim').set({ statement: 'rewritten' }).where('id', '=', claim.id).execute()), 'audit.append_only');
    await fails(withMaintenance(db.admin, (trx) => sql`DELETE FROM trustwork.execution_claim WHERE id = ${claim.id}`.execute(trx)), 'audit.append_only');
    assert.equal((await db.app.query('SELECT count(*)::int AS n FROM trustwork.execution_claim')).rows[0].n, 0, 'no identity, no rows');
  });

  await t.test('evidence: the claimant attaches artifacts of this agreement with their digest; never to a superseded claim; missing evidence is not failure', async () => {
    const photo = await artifactOn(f, A.agreement.id, { company: supplier }, boris);
    const B0 = await buildAgreement(f, businessDate(-5), 'Synthetic other agreement');
    const foreign = await artifactOn(f, B0.agreement.id, { company: supplier }, boris);
    const row = (over: Record<string, unknown> = {}) => ({ agreement_id: A.agreement.id, claim_id: firstClaim, defect_id: null, artifact_id: photo.id, artifact_sha256: photo.sha256, kind: 'photo' as const, observed_at: new Date(), note: null, attached_by_person_id: boris, via: 'person' as const, mandate_id: null, ...over });
    await fails(as(boris, (trx) => executionEvidence.insert(trx, row({ artifact_sha256: 'a'.repeat(64) }))), 'execution.artifact_not_attachable');
    await fails(as(boris, (trx) => executionEvidence.insert(trx, row({ artifact_id: foreign.id, artifact_sha256: foreign.sha256 }))), 'execution.artifact_not_attachable');
    await fails(as(petr, (trx) => executionEvidence.insert(trx, row({ attached_by_person_id: petr }))), 'execution.not_authorised');
    const claims = await as(boris, (trx) => executionClaims.listFor(trx, A.agreement.id));
    const superseded = claims.find((c) => c.id !== firstClaim)!;
    await fails(as(boris, (trx) => executionEvidence.insert(trx, row({ claim_id: superseded.id }))), 'execution.claim_superseded');
    await as(boris, (trx) => executionEvidence.insert(trx, row()));
    await fails(as(boris, (trx) => executionEvidence.insert(trx, row())), '23505');
    assert.equal((await as(petr, (trx) => executionEvidence.listFor(trx, A.agreement.id))).length, 1, 'the counterparty reads the evidence link');
    assert.equal((await as(carl, (trx) => executionEvidence.listFor(trx, A.agreement.id))).length, 0);
    // A claim with no evidence (the works claim below) is still decided on its merits: absence of evidence is not failure.
  });

  await t.test('decisions: the counterparty person only, never the claimant side, no agent path, one decision per claim', async () => {
    const columns = await db.admin.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name = 'execution_confirmation'");
    assert.ok(!columns.rows.some((c) => c.column_name === 'via' || c.column_name === 'mandate_id'), 'a confirmation has no agent or mandate column at all');
    await fails(decide(boris, firstClaim, A.agreement.id, 'accepted', PETR), 'execution.self_confirmation');
    await fails(decide(boris, firstClaim, A.agreement.id, 'accepted', SUPPLIER), 'execution.self_confirmation');
    await fails(decide(carl, firstClaim, A.agreement.id, 'accepted', PETR), 'execution.not_found');
    await fails(decide(petr, firstClaim, A.agreement.id, 'rejected', SUPPLIER), 'execution.not_authorised');
    await fails(as(petr, (trx) => executionConfirmations.insert(trx, { claim_id: firstClaim, agreement_id: A.agreement.id, decision: 'rejected', lines: [], note: null, stage_code: null, decided_by_person_id: petr, on_behalf_person_id: petr, on_behalf_company_id: null })), '23514');
    const partial = await decide(petr, firstClaim, A.agreement.id, 'partially_accepted', PETR);
    partialConfirmation = partial.id;
    await fails(decide(petr, firstClaim, A.agreement.id, 'accepted', PETR), 'execution.claim_not_open');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('execution_confirmation').set({ decision: 'accepted' }).where('id', '=', partial.id).execute()), 'audit.append_only');
    const observations = await as(boris, (trx) => performanceObservations.listFor(trx, A.agreement.id));
    assert.deepEqual(observations.map((o) => [o.dimension, o.outcome]).sort(), [['quality', 'partially_accepted'], ['timing', 'late']].sort(), 'a decision produces a quality and a timing fact');
    assert.equal(observations.every((o) => o.subject_company_id === supplier && o.decided_by_person_id === petr), true);
    await fails(as(petr, (trx) => sql`INSERT INTO trustwork.performance_observation (agreement_id, source_kind, source_id, subject_person_id, counterparty_person_id, dimension, outcome, attribution, decided_by_person_id)
      VALUES (${A.agreement.id}, 'execution_confirmation', gen_random_uuid(), ${petr}, ${petr}, 'quality', 'rejected', 'subject', ${petr})`.execute(trx)), '42501');
    assert.equal(await as(petr, (trx) => executionAgreements.observe(trx, A.agreement.id)), 0, 'observing again adds nothing');
    await fails(as(carl, (trx) => executionAgreements.observe(trx, A.agreement.id)), 'execution.not_found');
  });

  await t.test('fair timing: a client-caused change cannot penalize the supplier; the supplier\'s own change does; unknown causes and missing dates are unknown', async () => {
    const plan = await baselinePlan(f);
    const due = businessDate(-5);
    const late = await buildAgreement(f, due, 'Synthetic no change');
    const client = await buildAgreement(f, due, 'Synthetic client change');
    const own = await buildAgreement(f, due, 'Synthetic own change');
    const unknown = await buildAgreement(f, due, 'Synthetic unknown change');
    const external = await buildAgreement(f, due, 'Synthetic regulator change');
    const clientChange = await approvedChange(f, plan, { agreementId: client.agreement.id, cause: 'owner_request', accountable: { person: petr }, impactDays: 10 });
    await approvedChange(f, plan, { agreementId: own.agreement.id, cause: 'counterparty', accountable: { company: supplier }, impactDays: 10 });
    await approvedChange(f, plan, { agreementId: unknown.agreement.id, cause: 'unknown', accountable: { person: carl }, impactDays: 10 });
    await approvedChange(f, plan, { agreementId: external.agreement.id, cause: 'regulatory', accountable: { person: carl }, impactDays: 10 });
    // A change that names another agreement never excuses this one.
    await approvedChange(f, plan, { agreementId: client.agreement.id, cause: 'owner_request', accountable: { person: petr }, impactDays: 30 });
    const timingOf = async (a: typeof late) => {
      const claim = await as(boris, (trx) => executionClaims.insert(trx, claimRow(a.agreement.id, a.byKind.deliver)));
      await decide(petr, claim.id, a.agreement.id, 'accepted', PETR);
      return (await as(boris, (trx) => performanceObservations.listFor(trx, a.agreement.id))).find((o) => o.dimension === 'timing')!;
    };
    const plain = await timingOf(late);
    assert.equal(plain.outcome, 'late');
    assert.equal(plain.attribution, 'subject');
    assert.ok((plain.late_days ?? 0) >= 4, `late by ${plain.late_days} days`);
    const excused = await timingOf(client);
    assert.deepEqual([excused.outcome, excused.attribution, excused.excluded_reason], ['excused_delay', 'counterparty', 'client_caused_change'], 'the owner\'s change excuses the delay');
    assert.ok(excused.plan_change_ids.includes(clientChange.changeId));
    assert.ok(excused.allowance_days >= 10);
    const ownFault = await timingOf(own);
    assert.deepEqual([ownFault.outcome, ownFault.attribution, ownFault.excluded_reason], ['late', 'subject', null], 'the supplier\'s own change gives no allowance');
    assert.equal(ownFault.allowance_days, 0);
    const unattributed = await timingOf(unknown);
    assert.deepEqual([unattributed.outcome, unattributed.attribution, unattributed.excluded_reason], ['unknown', 'unknown', 'unattributed_change']);
    const regulator = await timingOf(external);
    assert.deepEqual([regulator.outcome, regulator.attribution, regulator.excluded_reason], ['excused_delay', 'external', 'external_change']);
    // The supplier sees the facts behind its timing (cause, accountable, impact), never the owner's reason text.
    const facts = await as(boris, (trx) => executionAgreements.timingFacts(trx, client.agreement.id));
    assert.equal(facts.length, 2);
    assert.ok(!JSON.stringify(facts).includes('PRIVATE-change-reason'));
    assert.deepEqual(await as(carl, (trx) => executionAgreements.timingFacts(trx, client.agreement.id)), []);
    // Payment discipline: the pay obligation of an RFQ agreement has no due date, so its timing is unknown, never late.
    const pay = await as(petr, (trx) => executionClaims.insert(trx, claimRow(late.agreement.id, late.byKind.pay, { recorded_by_person_id: petr })));
    await fails(decide(petr, pay.id, late.agreement.id, 'accepted', PETR), 'execution.self_confirmation');
    await decide(boris, pay.id, late.agreement.id, 'accepted', SUPPLIER);
    const payment = (await as(petr, (trx) => performanceObservations.listFor(trx, late.agreement.id))).find((o) => o.dimension === 'payment')!;
    assert.deepEqual([payment.outcome, payment.excluded_reason, payment.subject_person_id], ['unknown', 'no_due_date', petr]);
  });

  let defectId = '';
  await t.test('defects and remediation: reported by a party about the other, closed only by an accepted remediation', async () => {
    const defect = await as(petr, (trx) => executionDefects.insert(trx, { agreement_id: A.agreement.id, obligation_id: A.byKind.deliver.id, claim_id: firstClaim, reporter_person_id: petr, reporter_company_id: null, reported_by_person_id: petr, via: 'person', mandate_id: null, severity: 'major', location: 'North edge', description: 'PRIVATE-defect cracked pavers', observed_at: new Date() }));
    defectId = defect.id;
    assert.deepEqual([defect.subject_person_id, defect.subject_company_id], [null, supplier]);
    await fails(as(petr, (trx) => executionDefects.insert(trx, { agreement_id: A.agreement.id, obligation_id: A.byKind.pay.id, claim_id: null, reporter_person_id: petr, reporter_company_id: null, reported_by_person_id: petr, via: 'person', mandate_id: null, severity: 'minor', location: null, description: 'x', observed_at: new Date() })), 'execution.unknown_obligation');
    await fails(as(carl, (trx) => executionDefects.insert(trx, { agreement_id: A.agreement.id, obligation_id: null, claim_id: null, reporter_person_id: carl, reporter_company_id: null, reported_by_person_id: carl, via: 'person', mandate_id: null, severity: 'minor', location: null, description: 'x', observed_at: new Date() })), 'execution.not_found');
    const remedy = (over: Partial<ClaimInsert> = {}) => ({ ...claimRow(A.agreement.id, A.byKind.deliver), obligation_id: null, defect_id: defect.id, kind: 'remediation' as const, lines: [], ...over });
    await fails(as(petr, (trx) => executionClaims.insert(trx, remedy({ claimant_person_id: petr, claimant_company_id: null, recorded_by_person_id: petr }))), 'execution.not_obligor');
    const first = await as(boris, (trx) => executionClaims.insert(trx, remedy()));
    await decide(petr, first.id, A.agreement.id, 'rejected', PETR);
    const second = await as(boris, (trx) => executionClaims.insert(trx, remedy()));
    await decide(petr, second.id, A.agreement.id, 'accepted', PETR);
    await fails(as(boris, (trx) => executionClaims.insert(trx, remedy())), 'execution.defect_resolved');
    const remediations = await as(petr, (trx) => executionDefects.remediations(trx, [defect.id]));
    assert.deepEqual(remediations.map((r) => r.decision).sort(), ['accepted', 'rejected']);
  });

  await t.test('reviews: only for completed work, by a party about the other, once per side, corrections append, the reviewed party responds', async () => {
    const review = (personId: string, side: 'buyer' | 'seller', over: Record<string, unknown> = {}) => as(personId, (trx) => reviews.insert(trx, {
      agreement_id: A.agreement.id, author_side: side, author_person_id: side === 'buyer' ? petr : null, author_company_id: side === 'buyer' ? null : supplier,
      subject_person_id: side === 'buyer' ? null : petr, subject_company_id: side === 'buyer' ? supplier : null, written_by_person_id: personId, ratings: { overall: 4, timing: 3 }, text: 'PRIVATE-review text', language: 'en',
      corrects_review_id: null, ...over,
    } as never));
    await fails(review(petr, 'buyer'), 'trust.review_not_allowed');
    assert.equal(await as(petr, (trx) => executionAgreements.completed(trx, A.agreement.id)), false, 'a partially accepted delivery is not completed work');
    // Complete the agreement: the rest of the goods, and the works (a claim without any evidence, accepted on its merits).
    const rest = await as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver, { lines: [{ ref: 'q1', quantity: { value: '2', unit: 'm2' } }] })));
    await decide(petr, rest.id, A.agreement.id, 'accepted', PETR);
    const works = await as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.perform, { period_from: businessDate(-7), period_to: businessDate(-6) })));
    await decide(petr, works.id, A.agreement.id, 'accepted', PETR);
    assert.equal(await as(petr, (trx) => executionAgreements.completed(trx, A.agreement.id)), true);
    await fails(as(boris, (trx) => executionClaims.insert(trx, claimRow(A.agreement.id, A.byKind.deliver))), 'execution.obligation_fulfilled');
    await fails(review(carl, 'buyer'), 'trust.not_found');
    await fails(review(boris, 'buyer'), 'trust.not_authorised');
    await fails(review(boris, 'seller', { subject_person_id: null, subject_company_id: supplier }), '23514');
    await fails(review(boris, 'seller', { written_by_person_id: petr }), 'trust.not_authorised');
    const byPetr = await review(petr, 'buyer');
    await review(boris, 'seller');
    await fails(review(petr, 'buyer'), '23505');
    const correction = await review(petr, 'buyer', { corrects_review_id: byPetr.id, ratings: { overall: 5 }, text: 'Corrected after remediation' });
    await fails(review(petr, 'buyer', { corrects_review_id: byPetr.id }), '23505');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('review').set({ text: 'rewritten' }).where('id', '=', byPetr.id).execute()), 'audit.append_only');
    await fails(as(petr, (trx) => reviewResponses.insert(trx, { review_id: byPetr.id, agreement_id: A.agreement.id, responder_person_id: petr, responder_company_id: null, written_by_person_id: petr, text: 'x' })), 'trust.not_authorised');
    await as(boris, (trx) => reviewResponses.insert(trx, { review_id: correction.id, agreement_id: A.agreement.id, responder_person_id: null, responder_company_id: supplier, written_by_person_id: boris, text: 'Thank you' }));
    assert.equal((await as(carl, (trx) => reviews.listFor(trx, A.agreement.id))).length, 0, 'reviews stay with the parties');
  });

  await t.test('concurrency: one decision per claim, one open claim per obligation, one review per side', async () => {
    const C = await buildAgreement(f, businessDate(-1), 'Synthetic concurrency');
    const claim = await as(boris, (trx) => executionClaims.insert(trx, claimRow(C.agreement.id, C.byKind.deliver)));
    const decisions = await Promise.allSettled([decide(petr, claim.id, C.agreement.id, 'accepted', PETR), decide(petr, claim.id, C.agreement.id, 'rejected', PETR)]);
    assert.deepEqual(decisions.map((d) => d.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await as(petr, (trx) => executionConfirmations.listFor(trx, C.agreement.id))).length, 1);
    const claims = await Promise.allSettled([1, 2].map(() => as(boris, (trx) => executionClaims.insert(trx, claimRow(C.agreement.id, C.byKind.perform)))));
    assert.deepEqual(claims.map((c) => c.status).sort(), ['fulfilled', 'rejected'], 'two concurrent claims on one obligation: one waits, then sees the open claim');
    const loser = claims.find((c) => c.status === 'rejected') as PromiseRejectedResult;
    assert.equal((loser.reason as { hint?: string }).hint, 'execution.claim_open');
    const works = (await as(boris, (trx) => executionClaims.listFor(trx, C.agreement.id))).find((c) => c.kind === 'work_performed')!;
    await decide(petr, works.id, C.agreement.id, 'accepted', PETR);
    const both = await Promise.allSettled([1, 2].map((n) => as(petr, (trx) => reviews.insert(trx, {
      agreement_id: C.agreement.id, author_side: 'buyer', author_person_id: petr, author_company_id: null, subject_person_id: null, subject_company_id: supplier, written_by_person_id: petr,
      ratings: { overall: n + 2 }, text: null, language: null, corrects_review_id: null,
    }))));
    assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  });

  let staff: Awaited<ReturnType<typeof staffWorld>>;
  await t.test('disputes: opened by the party a decision went against, decided by a trust reviewer, the appeal by a different reviewer', async () => {
    staff = await staffWorld(f);
    const open = (personId: string, target: { kind: 'confirmation' | 'defect'; id: string }, opener: { person: string | null; company: string | null }) => as(personId, (trx) => executionDisputes.insert(trx, {
      agreement_id: A.agreement.id, hub_id: staff.hubId, target_kind: target.kind, target_id: target.id, opened_by_person_id: personId, opener_person_id: opener.person, opener_company_id: opener.company, reason: 'Synthetic dispute reason',
    }));
    await fails(open(petr, { kind: 'confirmation', id: partialConfirmation }, PETR), 'execution.not_authorised');
    await fails(open(carl, { kind: 'confirmation', id: partialConfirmation }, { person: carl, company: null }), 'execution.not_found');
    const dispute = await open(boris, { kind: 'confirmation', id: partialConfirmation }, SUPPLIER);
    await fails(open(boris, { kind: 'confirmation', id: partialConfirmation }, SUPPLIER), '23505');
    // Parties cannot decide; staff without the permission cannot; the decision columns are not writable by the runtime role.
    await fails(as(boris, (trx) => executionDisputes.decide(trx, { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'req-party', reasonCode: 'synthetic_test', reasonText: 'x' }, dispute.id, 'overturned')), 'admin.elevation_required');
    await fails(as(staff.outsiderStaff, async (trx) => executionDisputes.decide(trx, await staff.elevate(staff.outsiderStaff), dispute.id, 'overturned')), 'admin.forbidden');
    await fails(as(boris, (trx) => trx.updateTable('execution_dispute').set({ status: 'decided', decision: 'overturned', decided_by: boris, decided_at: new Date(), decision_reason: 'self' }).where('id', '=', dispute.id).execute()), '42501');
    await fails(as(petr, (trx) => executionDisputes.appeal(trx, dispute.id, dispute.revision, { personId: petr, reason: 'too early', at: new Date() })), 'execution.invalid_transition');
    const ctxA = await staff.elevate(staff.reviewerA);
    const decided = await as(staff.reviewerA, (trx) => executionDisputes.decide(trx, ctxA, dispute.id, 'overturned'));
    assert.deepEqual([decided.status, decided.decision, decided.decided_by], ['decided', 'overturned', staff.reviewerA]);
    assert.equal((await withMaintenance(db.admin, (trx) => trx.selectFrom('admin_audit_event').select('action').where('object_id', '=', dispute.id).execute())).map((r) => r.action).join(), 'trust.dispute.decide', 'the decision is audited by DATA-002');
    const appealed = await as(petr, (trx) => executionDisputes.appeal(trx, dispute.id, decided.revision, { personId: petr, reason: 'The pavers were cracked', at: new Date() }));
    assert.equal(appealed?.status, 'appealed');
    await fails(as(staff.reviewerA, async (trx) => executionDisputes.decideAppeal(trx, await staff.elevate(staff.reviewerA), dispute.id, 'upheld')), 'admin.same_decider');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('execution_dispute').set({ status: 'appeal_decided', appeal_decision: 'upheld', appeal_decided_by: staff.reviewerA, appeal_decided_at: new Date(), appeal_decision_reason: 'x' }).where('id', '=', dispute.id).execute()), '23514');
    const final = await as(staff.reviewerB, async (trx) => executionDisputes.decideAppeal(trx, await staff.elevate(staff.reviewerB), dispute.id, 'upheld'));
    assert.deepEqual([final.status, final.appeal_decision, final.appeal_decided_by], ['appeal_decided', 'upheld', staff.reviewerB]);
    await fails(as(staff.reviewerB, async (trx) => executionDisputes.decideAppeal(trx, await staff.elevate(staff.reviewerB), dispute.id, 'overturned')), 'admin.invalid_transition');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('execution_dispute').set({ reason: 'rewritten' }).where('id', '=', dispute.id).execute()), 'execution.dispute_immutable');
    // Reviewers read the case, not the private records behind it.
    assert.equal((await as(staff.reviewerB, (trx) => executionDisputes.get(trx, dispute.id)))?.id, dispute.id);
    assert.equal((await as(staff.reviewerB, (trx) => executionClaims.listFor(trx, A.agreement.id))).length, 0);
    // The subject of a defect disputes it; a staff member of the supplier would be conflicted (not tested here: synthetic reviewers are unaffiliated).
    const onDefect = await open(boris, { kind: 'defect', id: defectId }, SUPPLIER);
    assert.equal(onDefect.status, 'open');
  });

  await t.test('appeals of reviews and observations: filed by the reviewed party into DATA-002, decided by another person than the writer', async () => {
    const hub = { id: staff.hubId };
    const all = await as(boris, (trx) => reviews.listFor(trx, A.agreement.id));
    const aboutSupplier = all.find((r) => r.subject_company_id === supplier && r.corrects_review_id === null)!;
    const aboutPetr = all.find((r) => r.subject_person_id === petr)!;
    await fails(as(petr, (trx) => trustAppeals.file(trx, { hubId: hub.id, subjectKind: 'review', subjectId: aboutSupplier.id, reason: 'not mine' })), 'trust.not_found');
    const appeal = await as(boris, (trx) => trustAppeals.file(trx, { hubId: hub.id, subjectKind: 'review', subjectId: aboutSupplier.id, reason: 'Synthetic: the remediation was accepted' }));
    assert.deepEqual([appeal.subject_kind, appeal.original_decided_by, appeal.appellant_company_id], ['review', petr, supplier]);
    assert.equal((await as(petr, (trx) => trustAppeals.states(trx, 'review', [aboutSupplier.id, aboutPetr.id]))).get(aboutSupplier.id), 'submitted', 'the parties see that a review is under appeal');
    assert.equal((await as(carl, (trx) => trustAppeals.states(trx, 'review', [aboutSupplier.id]))).size, 0);
    const observation = (await as(boris, (trx) => performanceObservations.listFor(trx, A.agreement.id))).find((o) => o.dimension === 'timing')!;
    const obsAppeal = await as(boris, (trx) => trustAppeals.file(trx, { hubId: hub.id, subjectKind: 'performance_observation', subjectId: observation.id, reason: 'Synthetic: the delay was the site access' }));
    assert.equal(obsAppeal.original_decided_by, petr);
    // DATA-002 refuses the original decider as reviewer; the decision itself is DATA-002's admin_decide_appeal.
    await fails(as(petr, (trx) => appeals.decide(trx, { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'req-x', reasonCode: 'synthetic_test', reasonText: 'x' }, appeal.id, 'upheld')), 'admin.elevation_required');
    const overturned = await as(staff.reviewerA, async (trx) => appeals.decide(trx, await staff.elevate(staff.reviewerA), appeal.id, 'overturned'));
    assert.deepEqual([overturned.status, overturned.decided_by], ['overturned', staff.reviewerA]);
    assert.equal((await as(boris, (trx) => trustAppeals.states(trx, 'review', [aboutSupplier.id]))).get(aboutSupplier.id), 'overturned');
  });

  await t.test('snapshots: computed only for the subject one acts for; the public reads the masked summary only', async () => {
    const row = (personId: string, subject: { person: string | null; company: string | null }) => ({
      subject_person_id: subject.person, subject_company_id: subject.company, method_version: 'engine-evidence-0.1', method_digest: 'a'.repeat(64), summary: { facts: {} }, public_summary: { facts: { timing: { status: 'not_enough_data' } } },
      explanation: { observations: [{ id: 'PRIVATE-evidence-id' }] }, inputs_digest: 'b'.repeat(64), computed_by_person_id: personId,
    });
    await fails(as(petr, (trx) => reputationSnapshots.insert(trx, row(petr, SUPPLIER))), '42501');
    await fails(as(carl, (trx) => reputationSnapshots.insert(trx, row(carl, PETR))), '42501');
    await as(boris, (trx) => reputationSnapshots.insert(trx, row(boris, SUPPLIER)));
    assert.equal(await as(petr, (trx) => reputationSnapshots.latestOwn(trx, SUPPLIER)), undefined, 'the counterparty never reads the explanation');
    const anonymous = await withoutPrincipal(db.app, (trx) => reputationSnapshots.latestPublic(trx, SUPPLIER));
    assert.ok(anonymous);
    assert.ok(!JSON.stringify(anonymous).includes('PRIVATE-evidence-id'), 'the public function returns the masked summary only');
    assert.equal(anonymous.newer_evidence, false);
  });
});
