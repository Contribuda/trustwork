import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { adminSetup, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { consultationCommunications as comms, threads } from '../../packages/data/src/repositories/communications.js';
import { ConsultationsModule } from '../../apps/api/src/modules/consultations/consultations.module.js';
import { reminderProcess, type SentEffects } from './process-helper.js';
import { ConsultationsService } from '../../apps/api/src/modules/consultations/consultations.service.js';
import { NoConsultationMandates } from '../../apps/api/src/modules/consultations/mandates.js';
import { NoPublishedCommission, ScreeningCommitmentGate } from '../../apps/api/src/modules/consultations/ports.js';
import { ConfiguredElectronicRecords } from '../../apps/api/src/modules/transactions/electronic-records.js';
import type { BookingView, ExpertRequestView, RequesterRequestView } from '../../packages/contracts/src/consultations.js';
import { ENGINE_TEMPLATE_LANGUAGES, ThreadSchema, ThreadViewSchema } from '../../packages/contracts/src/communications.js';
import { consultationRemindersTask, produceReminder, ReminderChannelFake, type ReminderRuntime } from '../../apps/worker/src/consultations/reminders.js';
import { inTransaction } from '../../apps/worker/src/db.js';
import { applyFeedback } from '../../apps/worker/src/mail/delivery.js';
import { buildRegistry } from '../../apps/worker/src/main.js';
import { FakeMailTransport, mailConfigFromEnv } from '../../apps/worker/src/mail/index.js';
import { Metrics, silentLogger, Worker } from '../../apps/worker/src/index.js';
import { reconcileJob } from '../../apps/worker/src/reconcile.js';
import { waitFor } from '../worker/helpers/worker-db.js';
import { drain } from '../worker/mail/helpers/stack.js';
import { SKIP_REASON, startHarness, type Response, type Client } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { draft, personalBudget, stateOf, workerLogin, type MandateView, type IntentView } from '../assistant/helpers.js';
import { principalFor } from '../data/helpers/seed.js';
import { holdPerson, clearHold } from '../screening-gates/helpers.js';
import { screenClear } from './helpers.js';

const hubId = randomUUID();
const h = await startHarness('consultation_reminders', { communications: { settings: { hubId, hubLanguages: [...ENGINE_TEMPLATE_LANGUAGES], defaultLanguage: 'en' } } });
const PERSON = { via: 'person' as const };
const CONSENT = { consented: true as const, disclosureKey: 'trustwork.electronic-records.v1' };
const HOUR = 3600_000;
const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
function ok<T>(r: Response): T { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body)); return r.body as T; }
const texts = JSON.parse(readFileSync(new URL('./locales/reminders.json', import.meta.url), 'utf8')) as Record<string, { subject: string; body: string }>;

test('CONS-001 reminder producer and final fake dispatch under real restricted roles', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const cleanup: { worker?: () => Promise<void>; pools?: () => Promise<void> } = {};
  t.after(async () => { await cleanup.worker?.(); await cleanup.pools?.(); await h.close(); });
  const seed = await seedPersonas(h);
  const P = seed.people;
  await withMaintenance(h.db.admin, async (trx) => {
    await kernelSync.apply(trx, await kernelReference.fromRepository());
    await trx.insertInto('hub').values({ id: hubId, slug: 'synthetic-reminders', lifecycle: 'public' }).execute();
    await staffRoleDefinitions.release(trx, { version: 1, role: 'editor', scopes: ['hub', 'platform'], permissions: ['admin.notifications.template.edit'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await staffRoleDefinitions.release(trx, { version: 1, role: 'ops-engineer', scopes: ['hub', 'platform'], permissions: ['admin.notifications.template.edit', 'admin.config.edit'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    for (const [personId, role] of [[P.boris, 'editor'], [P.xenia, 'ops-engineer']] as const) await adminSetup.bootstrapFirstAdmin(trx, { personId, role, scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic template review' });
  });
  const as = async (key: Parameters<typeof login>[1]) => { const c = h.client(); await login(c, key); return c; };
  const [client, expert, editor, reviewer, outsider] = await Promise.all([as('petr'), as('carl'), as('boris'), as('xenia'), as('anna')]);
  await screenClear(h, [{ kind: 'person', id: P.petr }, { kind: 'person', id: P.carl }]);
  const workers = await workerLogin(h);
  cleanup.pools = () => workers.close();
  const pool = workers.pool(8);
  const channels = new ReminderChannelFake();
  const mail = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake' });
  const transport = new FakeMailTransport();
  // Hold transitions also send independent SANC-007 notices through this real mail registry.
  // Count reminder effects by durable delivery provenance, without suppressing or replacing other sends.
  const reminderSends = async () => {
    const ids = new Set((await h.db.admin.query<{ id: string }>(`SELECT m.id FROM trustwork.mail_delivery m
      JOIN trustwork.delivery d ON d.mail_delivery_id = m.id JOIN trustwork.notification n ON n.id = d.notification_id
      JOIN trustwork.consultation_reminder r ON n.dedupe_key = 'message:' || r.message_id::text
      WHERE m.template = 'notification' AND r.source_hub_id = $1`, [hubId])).rows.map((row) => row.id));
    return transport.sent.filter((item) => ids.has(item.headers['X-Entity-Ref-ID']!));
  };
  const runtime: ReminderRuntime = { pool, hubId, render: mail.render, channels };
  const registry = buildRegistry({ pool, mail, mailTransport: transport, log: silentLogger, metrics: new Metrics(), consultations: runtime });
  const worker = new Worker({ pool, registry, metrics: new Metrics(), tasks: () => [], config: { concurrency: 2, pollIntervalMs: 10 } });
  cleanup.worker = () => worker.stop(1000);
  const tx = <T>(fn: Parameters<typeof inTransaction<T>>[1]) => inTransaction(pool, fn);
  const count = async (query: string, ids: unknown[] = []) => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) x`, ids)).rows[0]!.n;
  const catalogue = ok<{ offering: { id: string; revision: number }; versions: { id: string }[] }>(await expert.post('/v1/catalogue', {
    owner: { kind: 'person', id: P.carl }, kind: 'services', actor: PERSON,
    draft: { payload: { title: 'Synthetic consultation', description: null, specification: {}, unit: 'h', listPrice: { minorUnits: '100', currency: 'USD' }, options: [], availability: { state: 'available', capacity: null, observedAt: at(0) }, components: [] }, publicFields: ['title'], privateKnowledge: { costBasis: null, marginTarget: null, notes: null } },
  }));
  const offeringId = catalogue.offering.id;
  ok(await expert.post(`/v1/catalogue/${offeringId}/versions/${catalogue.versions[0]!.id}/publish`, { expectedRevision: catalogue.offering.revision, actor: PERSON }));
  ok(await expert.post('/v1/consultation-offerings', { offeringId, actor: PERSON, terms: { kind: 'session', modes: ['video'], topics: [], regions: ['US-CA'], languages: ['en'], durationMinutes: 15, deliverableKind: 'written_advice', pricing: 'fixed', cancellation: { freeUntilHours: 24, lateShareBps: 0, noShowShareBps: 0 }, licence: { required: false, credentialId: null }, recordingOffered: false } }));
  const window = ok<{ id: string }>(await expert.post('/v1/consultation-availability', { startsAt: at(0.01), endsAt: at(23), timeZone: 'America/Los_Angeles', capacity: 50, actor: PERSON }));
  let nextStart = 2;
  // Only the injected service clock moves: SQL, the principal, the booked slot and reminder identity stay real.
  // This simulates a reminder becoming due without sleeps or disabling any production trigger.
  const service = new ConsultationsService({ ...h.created.ctx!, clock: { now: () => new Date(Date.now() - 48 * HOUR) } }, h.services().principals,
    new NoConsultationMandates(), new ConfiguredElectronicRecords(), new NoPublishedCommission(), new ScreeningCommitmentGate(), hubId);
  const prepare = async (seller: Client = expert, selectedOffering = offeringId, selectedWindow = window.id) => {
    const req = ok<RequesterRequestView>(await client.post('/v1/consultation-requests', { source: { kind: 'direct' }, offeringId: selectedOffering, actor: PERSON, mentoringRelationshipId: null,
      privateConstraint: { budgetCeiling: { minorUnits: '987654321', currency: 'USD' }, requesterNotes: 'PRIVATE-reminder' }, terms: { kind: 'session', question: 'PRIVATE shared question', fields: [], preferredModes: ['video'], preferredTimes: [], sharedMaterials: [], licenceRequired: false, languages: ['en'] } }));
    const proposed = ok<ExpertRequestView>(await seller.post(`/v1/consultation-requests/${req.request.id}/proposals`, { expectedRevision: req.request.revision, mode: 'video', slot: { windowId: selectedWindow, start: at(2 + (nextStart++ - 2) * 0.4) }, deliverableDue: null, validUntil: at(24), note: null, actor: PERSON }));
    const b = proposed.bookings[0]!;
    const fresh = ok<RequesterRequestView>(await client.get(`/v1/consultation-requests/${req.request.id}`));
    const accepted = ok<RequesterRequestView>(await client.post(`/v1/consultation-requests/${req.request.id}/acceptances`, { booking: { id: b.id, version: 1, digest: b.digest }, request: { id: req.request.id, version: 1, digest: req.request.digest }, expectedRevision: fresh.request.revision, recordingConsent: false, electronicRecords: CONSENT, actor: PERSON }));
    const a = accepted.agreements[0]!;
    return a;
  };
  const book = async (seller: Client = expert, selectedOffering = offeringId, selectedWindow = window.id, confirmer = service) => {
    const a = await prepare(seller, selectedOffering, selectedWindow);
    return confirmer.confirmBooking(a.id, { expectedRevision: a.revision, acceptedTermsDigest: a.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON }, randomUUID(), await stateOf(h, seller, randomUUID()));
  };
  const dueId = (b: BookingView) => b.reminders.find((r) => r.offsetMinutes === 1440)!.id;
  const cancel = async (b: BookingView) => ok(await client.post(`/v1/consultation-bookings/${b.booking.id}/cancel`, { expectedRevision: b.booking.revision, kind: 'client', absentSide: null, reason: 'Synthetic cancellation', actor: PERSON }));
  await withMaintenance(h.db.admin, (trx) => trx.insertInto('person_profile').values({ person_id: P.petr, role_line: null, region_code: null, languages: ['es'] }).onConflict((oc) => oc.column('person_id').doUpdateSet({ languages: ['es'] })).execute());
  const first = await book();

  await t.test('confirmation creates exactly one participant thread; worker/API cannot impersonate an opener or producer', async () => {
    const listed = ok<{ items: unknown[] }>(await expert.get(`/v1/threads?contextKind=agreement&contextId=${first.agreement!.id}`));
    assert.equal(listed.items.length, 1);
    const thread = ThreadSchema.parse(listed.items[0]);
    assert.equal(thread.openedByPersonId, P.carl);
    assert.equal(thread.messageCount, 0);
    assert.equal((await outsider.get(`/v1/threads/${thread.id}`)).status, 404);
    const principal = await principalFor(h.db.admin, P.carl);
    await withPrincipal(h.pool, principal, async (trx) => {
      assert.equal((await threads.open(trx, { kind: 'agreement', id: first.agreement!.id, counterparty: { person: null, company: null }, openedBy: P.carl, subject: 'Ignored duplicate' })).thread.id, thread.id);
    });
    await assert.rejects(withPrincipal(h.pool, principal, (trx) => comms.produce(trx, dueId(first), hubId, 'forbidden')), /permission denied/);
    await assert.rejects(pool.query('SELECT * FROM trustwork.context_thread'), /permission denied/);
    assert.equal(await tx((trx) => produceReminder(trx, runtime, dueId(first))), false, 'no active template means no local effect');
  });

  await t.test('seven-language template governance and minimal private-safe copy', async () => {
    for (const locale of ENGINE_TEMPLATE_LANGUAGES.filter((x) => x !== 'ka')) ok(await editor.post(`/v1/hubs/${hubId}/message-templates/thread.message/drafts`, { version: 1, locale, ...texts[locale]! }));
    assert.equal((await reviewer.post(`/v1/hubs/${hubId}/message-templates/thread.message/versions/1/activate`, { reason: 'Incomplete' })).status, 422);
    ok(await editor.post(`/v1/hubs/${hubId}/message-templates/thread.message/drafts`, { version: 1, locale: 'ka', ...texts.ka! }));
    assert.equal((await editor.post(`/v1/hubs/${hubId}/message-templates/thread.message/versions/1/activate`, { reason: 'Self activation' })).status, 403);
    ok(await reviewer.post(`/v1/hubs/${hubId}/message-templates/thread.message/versions/1/activate`, { reason: 'Synthetic multilingual review' }));
    assert.equal((await tx((trx) => comms.templates(trx, hubId))).length, 7);
  });

  await t.test('crash rollback, two-worker race and repeat tick yield one atomic message/fanout/receipt/sent effect', async () => {
    await assert.rejects(tx(async (trx) => { await produceReminder(trx, runtime, dueId(first)); throw new Error('simulated pre-commit crash'); }), /simulated/);
    assert.equal(await count('SELECT 1 FROM trustwork.consultation_reminder WHERE id=$1 AND status=\'sent\'', [dueId(first)]), 0);
    assert.equal(await count('SELECT 1 FROM trustwork.message'), 0);
    await Promise.all([tx((trx) => produceReminder(trx, runtime, dueId(first))), tx((trx) => produceReminder(trx, runtime, dueId(first)))]);
    await consultationRemindersTask(runtime).run();
    assert.equal(await count('SELECT 1 FROM trustwork.message'), 1);
    assert.equal(await count("SELECT 1 FROM trustwork.send_receipt WHERE provider='internal'"), 1);
    assert.equal(await count('SELECT 1 FROM trustwork.notification'), 2);
    const records = (await h.db.admin.query('SELECT params FROM trustwork.notification UNION ALL SELECT params FROM trustwork.mail_delivery')).rows;
    assert.ok(!JSON.stringify(records).includes('PRIVATE'));
    assert.ok(!JSON.stringify(records).includes('987654321'));
    assert.equal((await reminderSends()).length, 0, 'mail enqueue is not provider delivery');
    const threadId = (await h.db.admin.query('SELECT id FROM trustwork.context_thread WHERE context_id=$1', [first.agreement!.id])).rows[0].id;
    const view = ThreadViewSchema.parse(ok(await client.get(`/v1/threads/${threadId}`)));
    assert.deepEqual(view.messages[0]!.author, { kind: 'system' });
    assert.equal(view.messages[0]!.body, texts.en!.body);
    await drain(worker);
    assert.equal((await reminderSends()).length, 2);
    assert.ok((await reminderSends()).some((mail) => mail.locale === 'es' && mail.text.includes(texts.es!.body)));
    await drain(worker);
    assert.equal((await reminderSends()).length, 2, 'duplicate relay/ticks never resend');
  });

  await t.test('cancellation before production and between enqueue and dispatch suppresses effects', async () => {
    const cancelled = await book();
    await cancel(cancelled);
    await tx((trx) => produceReminder(trx, runtime, dueId(cancelled)));
    assert.equal(await count('SELECT 1 FROM trustwork.message'), 1);
    const queued = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(queued)));
    await cancel(queued);
    await drain(worker);
    assert.equal((await reminderSends()).length, 2);
    assert.equal(await count("SELECT 1 FROM trustwork.mail_delivery WHERE state='suppressed'"), 2);
  });

  await t.test('preferences and sanctions are rechecked at production and final dispatch', async () => {
    const b = await book();
    await holdPerson(h.db.admin, P.petr);
    await tx((trx) => produceReminder(trx, runtime, dueId(b)));
    assert.equal(await count("SELECT 1 FROM trustwork.consultation_reminder WHERE id=$1 AND status='sent'", [dueId(b)]), 0);
    await clearHold(h.db.admin, P.petr, P.carl);
    await tx((trx) => produceReminder(trx, runtime, dueId(b)));
    await holdPerson(h.db.admin, P.carl);
    await drain(worker);
    assert.equal((await reminderSends()).length, 2);
    assert.equal(transport.sent.length, 5, 'three independent hold/clear notices are delivered alongside the two earlier reminders');
    await clearHold(h.db.admin, P.carl, P.petr);
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('notification_preference').values({ person_id: P.petr, category: 'messages', channel: 'email', frequency: 'off' }).execute());
    const off = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(off)));
    const mailBefore = (await reminderSends()).length;
    await drain(worker);
    assert.equal((await reminderSends()).length, mailBefore + 1, 'recipient off gets a context signal but no email');
    const changed = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(changed)));
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('notification_preference').values({ person_id: P.carl, category: 'messages', channel: 'email', frequency: 'off' }).execute());
    await drain(worker);
    assert.equal((await reminderSends()).length, mailBefore + 1, 'an off preference changed after enqueue still prevents sending');
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('notification_preference').set({ frequency: 'immediate' }).where('person_id', '=', P.carl).execute());
  });

  await t.test('withdrawn mail verification suppresses a queued reminder; ambiguous mail parks without replay', async () => {
    const unverified = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(unverified)));
    const before = (await reminderSends()).length;
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('email_binding').set({ verified_at: null }).where('person_id', '=', P.carl).execute());
    await drain(worker);
    assert.equal((await reminderSends()).length, before);
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('email_binding').set({ verified_at: new Date() }).where('person_id', '=', P.carl).execute());
    const ambiguous = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(ambiguous)));
    transport.failNext('unknown');
    await drain(worker);
    const parked = (await h.db.admin.query("SELECT id FROM trustwork.job WHERE kind LIKE 'consultation.mail.%' AND state='outcome_unknown'")).rows;
    assert.equal(parked.length, 1);
    assert.equal((await reminderSends()).length, before + 1);
    await drain(worker);
    assert.equal((await reminderSends()).length, before + 1, 'unknown mail is never automatically retried');
    await tx((trx) => reconcileJob(trx, { jobId: parked[0].id, outcome: 'succeeded', reference: 'synthetic mailbox evidence', mode: 'manual' }));
    await drain(worker);
    assert.equal((await reminderSends()).length, before + 1, 'reconciliation records evidence without resending');
  });

  await t.test('real confirmation mandates authorize the empty participant thread; unknown and revoked mandates fail closed', async () => {
    const agreement = await prepare();
    const budget = await personalBudget(h, P.carl, 'transaction', '100000');
    const makeMandate = async () => ok<MandateView>(await expert.post('/v1/assistant/mandates', {
      draft: draft({ moduleKeys: ['consultation'], actions: ['accept_order'], contexts: [{ kind: 'agreement', id: agreement.id }], approvalPolicy: { mode: 'ask_each' },
        limits: { ceiling: { minorUnits: '100000', currency: 'USD' }, perActionCeiling: null, transactionBudgetId: budget, platformBudgetId: null, perWindow: null } }),
    }));
    const confirm = async (mandateId: string) => expert.post(`/v1/consultation-agreements/${agreement.id}/confirm`, {
      expectedRevision: agreement.revision, acceptedTermsDigest: agreement.acceptedTermsDigest, electronicRecords: CONSENT, actor: { via: 'agent', mandateId },
    });
    assert.equal((await confirm(randomUUID())).status, 403);
    const revoked = await makeMandate();
    ok(await expert.post(`/v1/assistant/mandates/${revoked.id}/revoke`, { expectedRevision: revoked.revision, reason: 'Synthetic revocation' }));
    assert.equal((await confirm(revoked.id)).status, 403);
    assert.equal(await count('SELECT 1 FROM trustwork.context_thread WHERE context_id=$1', [agreement.id]), 0);
    const granted = await makeMandate();
    assert.equal((await confirm(granted.id)).status, 403, 'the confirmed ask_each mandate still needs approval of this commitment');
    const decisions = ok<{ decisions: IntentView[] }>(await expert.get('/v1/assistant/decisions')).decisions;
    const decision = decisions.find((x) => x.state === 'proposed')!;
    assert.ok(decision);
    ok(await expert.post(`/v1/assistant/decisions/${decision.id}/approve`, { digest: decision.actionDigest }));
    const booked = ok<BookingView>(await confirm(granted.id));
    assert.equal(booked.booking.status, 'booked');
    const thread = (await h.db.admin.query('SELECT opened_by_person_id,message_count FROM trustwork.context_thread WHERE context_id=$1', [agreement.id])).rows[0];
    assert.equal(thread.opened_by_person_id, P.carl);
    assert.equal(thread.message_count, 0, 'confirmation does not author a person/agent message');
  });

  await t.test('current company membership and pinned licence are rechecked after enqueue', async () => {
    const anna = outsider;
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.page.edit', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit', 'company.publish'] }).where('id', '=', seed.memberships.anna).execute());
    await screenClear(h, [{ kind: 'person', id: P.anna }, { kind: 'company', id: seed.companies.mixed }]);
    const credentialBody = { holder: { kind: 'person', id: P.anna }, kind: 'licence', jurisdiction: 'US-CA', credentialType: 'US-CA-PE-CIVIL', issuer: 'Synthetic Board', number: 'SYNTHETIC-123', classification: null, coverage: null, validFrom: null, validUntil: '2030-12-31', visibility: 'private', supersedesId: null };
    const licence = ok<{ credentials: { id: string }[] }>(await anna.post('/v1/reputation-builder/credentials', credentialBody)).credentials[0]!;
    const companyCatalogue = ok<{ offering: { id: string; revision: number }; versions: { id: string }[] }>(await anna.post('/v1/catalogue', {
      owner: { kind: 'company', id: seed.companies.mixed }, kind: 'services', actor: PERSON,
      draft: { payload: { title: 'Synthetic company advice', description: null, specification: {}, unit: 'h', listPrice: null, options: [], availability: { state: 'available', capacity: null, observedAt: at(0) }, components: [] }, publicFields: ['title'], privateKnowledge: { costBasis: null, marginTarget: null, notes: null } },
    }));
    const id = companyCatalogue.offering.id;
    ok(await anna.post(`/v1/catalogue/${id}/versions/${companyCatalogue.versions[0]!.id}/publish`, { expectedRevision: companyCatalogue.offering.revision, actor: PERSON }));
    ok(await anna.post('/v1/consultation-offerings', { offeringId: id, actor: PERSON, terms: { kind: 'session', modes: ['video'], topics: [], regions: ['US-CA'], languages: ['en'], durationMinutes: 15, deliverableKind: 'written_advice', pricing: 'free', cancellation: { freeUntilHours: 24, lateShareBps: 0, noShowShareBps: 0 }, licence: { required: true, credentialId: licence.id }, recordingOffered: false } }));
    const w = ok<{ id: string }>(await anna.post('/v1/consultation-availability', { startsAt: at(0.01), endsAt: at(23), timeZone: 'America/Los_Angeles', capacity: 20, actor: PERSON }));
    const revoked = await book(anna, id, w.id);
    await tx((trx) => produceReminder(trx, runtime, dueId(revoked)));
    const before = (await reminderSends()).length;
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.page.edit'] }).where('id', '=', seed.memberships.anna).execute());
    await drain(worker);
    assert.equal((await reminderSends()).length, before, 'the former company deal manager receives no mail');
    const threadId = (await h.db.admin.query('SELECT id FROM trustwork.context_thread WHERE context_id=$1', [revoked.agreement!.id])).rows[0].id;
    assert.equal((await anna.get(`/v1/threads/${threadId}`)).status, 404);
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.page.edit', 'company.deals.manage', 'company.catalogue.edit', 'company.publish'] }).where('id', '=', seed.memberships.anna).execute());
    const expired = await book(anna, id, w.id);
    await tx((trx) => produceReminder(trx, runtime, dueId(expired)));
    ok(await anna.post('/v1/reputation-builder/credentials', { ...credentialBody, number: 'SYNTHETIC-124', supersedesId: licence.id }));
    await drain(worker);
    assert.equal((await reminderSends()).length, before, 'superseding the pinned licence stops final dispatch');
  });

  await t.test('cancellation serializes with local rollback and with the final fake provider call', async () => {
    const b = await book();
    const before = await count('SELECT 1 FROM trustwork.message');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const effect = tx(async (trx) => { await produceReminder(trx, runtime, dueId(b)); entered(); await barrier; throw new Error('local crash'); });
    const rolledBack = assert.rejects(effect, /local crash/);
    await started;
    const cancelling = cancel(b);
    const blocked = async () => (await h.db.admin.query<{ blocked: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0) AS blocked")).rows[0]!.blocked;
    try { await waitFor(blocked, 5000, 'cancellation waits for the local effect'); } finally { release(); }
    await rolledBack;
    await cancelling;
    assert.equal(await count('SELECT 1 FROM trustwork.message'), before);

    const sending = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(sending)));
    let atSend!: () => void;
    let finishSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => { atSend = resolve; });
    const sendBarrier = new Promise<void>((resolve) => { finishSend = resolve; });
    const original = transport.send.bind(transport);
    transport.send = async (mail, signal) => { atSend(); await sendBarrier; return original(mail, signal); };
    const sendingWork = drain(worker);
    await sendStarted;
    const cancelDuringSend = cancel(sending);
    try { await waitFor(blocked, 5000, 'cancellation waits for the final dispatch lock'); } finally { finishSend(); transport.send = original; }
    await sendingWork;
    await cancelDuringSend;
    const lastReminder = (await reminderSends()).at(-1)!;
    assert.equal(await tx((trx) => comms.mailAllowed(trx, lastReminder.headers['X-Entity-Ref-ID']!, hubId)), false);
  });

  await t.test('fake channel unknown outcomes park durably; reconciliation never blindly sends again', async () => {
    const grantBody = { provider: 'telegram', account: 'synthetic-chat', scopes: { contextKinds: ['agreement'], actions: ['notify'] } };
    const grant = ok<{ id: string }>(await client.post('/v1/me/channel-grants', grantBody));
    const revoked = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(revoked)));
    ok(await client.post(`/v1/me/channel-grants/${grant.id}/revoke`));
    await drain(worker);
    assert.equal(channels.sent.length, 0, 'revoking the grant after enqueue prevents dispatch');
    ok(await client.post('/v1/me/channel-grants', grantBody));
    const b = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(b)));
    channels.script({ kind: 'unknown', reason: 'synthetic timeout' });
    await drain(worker);
    const parked = (await h.db.admin.query("SELECT id FROM trustwork.job WHERE kind LIKE 'consultation.notify.%' AND state='outcome_unknown'")).rows;
    assert.equal(parked.length, 1);
    assert.equal(channels.sent.length, 1);
    await drain(worker);
    assert.equal(channels.sent.length, 1);
    await tx((trx) => reconcileJob(trx, { jobId: parked[0].id, outcome: 'queued', reference: 'synthetic retry decision', mode: 'manual' }));
    await drain(worker);
    assert.equal(channels.sent.length, 1, 'the fake deduplicates the stable delivery identity even after explicit retry');
    await tx((trx) => reconcileJob(trx, { jobId: parked[0].id, outcome: 'succeeded', reference: 'synthetic adapter evidence', mode: 'manual' }));
    await drain(worker);
    assert.equal(channels.sent.length, 1);
    assert.equal(await tx((trx) => comms.reconcileChannels(trx)), 1);
    assert.equal(await count("SELECT 1 FROM trustwork.delivery WHERE channel='messenger' AND state='sent'"), 1);
  });

  await t.test('two hub processes use immutable confirmation provenance, distinct templates and scoped jobs; legacy stays scheduled', async () => {
    const otherHub = randomUUID();
    await withMaintenance(h.db.admin, async (trx) => {
      await trx.insertInto('hub').values({ id: otherHub, slug: 'synthetic-reminders-b', lifecycle: 'public' }).execute();
    });
    for (const locale of ENGINE_TEMPLATE_LANGUAGES) ok(await editor.post(`/v1/hubs/${otherHub}/message-templates/thread.message/drafts`, { version: 1, locale, subject: `B ${texts[locale]!.subject}`, body: `B ${texts[locale]!.body}` }));
    ok(await reviewer.post(`/v1/hubs/${otherHub}/message-templates/thread.message/versions/1/activate`, { reason: 'Synthetic second hub review' }));
    // Exercise the owning module's actual environment wiring, not a caller-supplied public field.
    const moduleService = (sourceHub: string | null) => {
      const mod = ConsultationsModule.forRoot({ ...h.created.ctx!, clock: { now: () => new Date(Date.now() - 48 * HOUR) } }, h.services(), {}, sourceHub ? { TRUSTWORK_HUB_ID: sourceHub } : {});
      return (mod.providers![0] as { useValue: ConsultationsService }).useValue;
    };
    const a = await book(expert, offeringId, window.id, moduleService(hubId));
    const b = await book(expert, offeringId, window.id, moduleService(otherHub));
    const legacy = await book(expert, offeringId, window.id, moduleService(null));
    const rows = (await h.db.admin.query('SELECT id,source_hub_id FROM trustwork.consultation_reminder WHERE id=ANY($1::uuid[])', [[dueId(a), dueId(b), dueId(legacy)]])).rows;
    assert.equal(rows.find((r) => r.id === dueId(a)).source_hub_id, hubId);
    assert.equal(rows.find((r) => r.id === dueId(b)).source_hub_id, otherHub);
    assert.equal(rows.find((r) => r.id === dueId(legacy)).source_hub_id, null);
    await assert.rejects(withMaintenance(h.db.admin, (trx) => trx.updateTable('consultation_reminder').set({ source_hub_id: hubId }).where('id', '=', dueId(legacy)).execute()), /immutable|frozen/);
    assert.ok(!(await tx((trx) => comms.due(trx, hubId))).includes(dueId(b)));
    assert.ok(!(await tx((trx) => comms.due(trx, hubId))).includes(dueId(legacy)));
    const processA = await reminderProcess(pool.options, hubId);
    const processB = await reminderProcess(pool.options, otherHub);
    try {
      assert.equal(await processA.command('produce', { reminderId: dueId(b) }), false);
      assert.equal(await processB.command('produce', { reminderId: dueId(a) }), false);
      assert.equal(await processA.command('produce', { reminderId: dueId(legacy) }), false);
      // Even the SQL producer independently refuses the wrong hub.
      assert.deepEqual(await tx((trx) => comms.produce(trx, dueId(b), hubId, 'Wrong hub copy')), []);
      const ticks = await Promise.all([processA.command<string[]>('tick'), processB.command<string[]>('tick')]);
      assert.deepEqual(ticks, [[`consultation.reminders.${hubId.replaceAll('-', '')}`], [`consultation.reminders.${otherHub.replaceAll('-', '')}`]], 'both source hubs own an independent scheduler slot');
      const messages = (await h.db.admin.query('SELECT r.id,m.body FROM trustwork.consultation_reminder r JOIN trustwork.message m ON m.id=r.message_id WHERE r.id=ANY($1::uuid[])', [[dueId(a), dueId(b)]])).rows;
      assert.equal(messages.find((r) => r.id === dueId(a)).body, texts.en!.body);
      assert.equal(messages.find((r) => r.id === dueId(b)).body, `B ${texts.en!.body}`);
      const aSent = await processA.command<SentEffects>('drain');
      const bDeliveries = (await h.db.admin.query('SELECT d.id,d.mail_delivery_id FROM trustwork.consultation_reminder r JOIN trustwork.notification n ON n.dedupe_key=\'message:\' || r.message_id::text JOIN trustwork.delivery d ON d.notification_id=n.id WHERE r.id=$1', [dueId(b)])).rows;
      assert.ok(bDeliveries.length > 0);
      for (const d of bDeliveries) {
        assert.ok(!aSent.mail.some((x) => x.id === d.mail_delivery_id));
        assert.ok(!aSent.channels.some((x) => x.id === d.id));
        if (d.mail_delivery_id) assert.equal(await tx((trx) => comms.mailAllowed(trx, d.mail_delivery_id, hubId)), false);
      }
      const bSent = await processB.command<SentEffects>('drain');
      assert.ok(bSent.mail.length + bSent.channels.length > 0);
      assert.ok([...bSent.mail, ...bSent.channels].every((x) => x.text.includes('B ')));
      assert.equal(await count("SELECT 1 FROM trustwork.consultation_reminder WHERE id=$1 AND status='scheduled' AND message_id IS NULL", [dueId(legacy)]), 1);
    } finally { await processA.close(); await processB.close(); }
  });

  // Both orders use the real preference HTTP API and a separate OS worker process against embedded PG.
  // The writer-first barrier pauses AFTER the production write trigger has acquired its lock, before API commit.
  for (const channel of ['email', 'messenger'] as const) {
    for (const order of ['writer-first', 'dispatch-first'] as const) {
      await t.test(`absent ${channel} preference: actual API ${order} serializes with the final separate-process fake effect`, async () => {
        await withMaintenance(h.db.admin, (trx) => trx.deleteFrom('notification_preference').where('person_id', '=', P.petr).where('category', '=', 'messages').where('channel', '=', channel).execute());
        const b = await book();
        await tx((trx) => produceReminder(trx, runtime, dueId(b)));
        const row = (await h.db.admin.query('SELECT d.id,d.mail_delivery_id FROM trustwork.consultation_reminder r JOIN trustwork.notification n ON n.dedupe_key=\'message:\' || r.message_id::text JOIN trustwork.delivery d ON d.notification_id=n.id WHERE r.id=$1 AND d.recipient_person_id=$2 AND d.channel=$3', [dueId(b), P.petr, channel])).rows[0];
        assert.ok(row, 'default immediate schedules the channel before the first explicit preference exists');
        const effectId = channel === 'email' ? row.mail_delivery_id : row.id;
        assert.ok(effectId);
        const child = await reminderProcess(pool.options, hubId);
        const revoke = () => client.post('/v1/me/notification-preferences', { category: 'messages', channel, frequency: 'off' });
        const selected = (effects: SentEffects) => (channel === 'email' ? effects.mail : effects.channels).filter((x) => x.id === effectId);
        try {
          if (order === 'dispatch-first') {
            const atEffect = child.atEffect();
            const sending = child.command<SentEffects>('drain', { holdId: effectId });
            await atEffect;
            let committed = false;
            const revoking = revoke().then((r) => { ok(r); committed = true; });
            try {
              await waitFor(async () => (await h.db.admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%insert into \"notification_preference\"%' AND cardinality(pg_blocking_pids(pid))>0) AS blocked")).rows[0].blocked, 10_000, 'actual preference API waits for the fake effect');
              assert.equal(committed, false);
            } finally { child.release(); }
            const effects = await sending;
            await revoking;
            assert.equal(selected(effects).length, 1, 'the effect precedes revocation commit');
            assert.equal(selected(await child.command<SentEffects>('drain')).length, 1, 'committed revocation cannot trigger another effect');
          } else {
            const gate = await h.db.admin.connect();
            let revoking: Promise<Response> | undefined;
            let sending: Promise<SentEffects> | undefined;
            try {
              await gate.query('SELECT pg_advisory_lock(764021)');
              const gatePid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
              await h.db.admin.query(`CREATE FUNCTION trustwork.test_preference_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                IF NEW.person_id='${P.petr}'::uuid AND NEW.category='messages' AND NEW.channel='${channel}' THEN PERFORM pg_advisory_xact_lock(764021); END IF; RETURN NEW; END $$;
                CREATE TRIGGER zz_test_preference_barrier AFTER INSERT ON trustwork.notification_preference FOR EACH ROW EXECUTE FUNCTION trustwork.test_preference_barrier()`);
              revoking = revoke();
              let writerPid = 0;
              await waitFor(async () => {
                const waiting = (await h.db.admin.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [gatePid])).rows[0];
                writerPid = waiting?.pid ?? 0; return writerPid > 0;
              }, 10_000, 'actual API holds the preference lock before commit');
              sending = child.command<SentEffects>('drain');
              await waitFor(async () => (await h.db.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [writerPid])).rows[0].blocked, 10_000, 'final worker preflight waits for actual API commit');
            } finally {
              await gate.query('SELECT pg_advisory_unlock(764021)');
              gate.release();
              if (revoking) ok(await revoking);
              if (sending) assert.equal(selected(await sending).length, 0, 'revocation committed first, so no fake effect');
              await h.db.admin.query('DROP TRIGGER IF EXISTS zz_test_preference_barrier ON trustwork.notification_preference; DROP FUNCTION IF EXISTS trustwork.test_preference_barrier()');
            }
          }
          const saved = (await h.db.admin.query('SELECT frequency FROM trustwork.notification_preference WHERE person_id=$1 AND category=\'messages\' AND channel=$2', [P.petr, channel])).rows[0];
          assert.equal(saved.frequency, 'off');
        } finally { child.release(); await child.close(); }
      });
    }
  }

  for (const order of ['writer-first', 'dispatch-first'] as const) {
    await t.test(`first unsubscribe: actual API ${order} serializes with final separate-process mail`, async () => {
      const addressHash = (await h.db.admin.query('SELECT trustwork.comms_mail_hash(email_normalized) AS hash FROM trustwork.email_binding WHERE person_id=$1 AND is_primary', [P.petr])).rows[0].hash;
      await withMaintenance(h.db.admin, (trx) => trx.deleteFrom('suppression_entry').where('address_hash', '=', addressHash).execute());
      ok(await client.post('/v1/me/notification-preferences', { category: 'messages', channel: 'email', frequency: 'immediate' }));
      const b = await book();
      await tx((trx) => produceReminder(trx, runtime, dueId(b)));
      const effectId = (await h.db.admin.query('SELECT d.mail_delivery_id FROM trustwork.consultation_reminder r JOIN trustwork.notification n ON n.dedupe_key=\'message:\' || r.message_id::text JOIN trustwork.delivery d ON d.notification_id=n.id WHERE r.id=$1 AND d.recipient_person_id=$2 AND d.channel=\'email\'', [dueId(b), P.petr])).rows[0].mail_delivery_id;
      const child = await reminderProcess(pool.options, hubId);
      const blocked = async () => (await h.db.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0) AS blocked')).rows[0].blocked;
      try {
        if (order === 'dispatch-first') {
          const atEffect = child.atEffect();
          const sending = child.command<SentEffects>('drain', { holdId: effectId });
          await atEffect;
          let committed = false;
          const unsubscribing = client.post('/v1/me/mail-unsubscribe').then((r) => { ok(r); committed = true; });
          try { await waitFor(blocked, 10_000, 'unsubscribe waits for final dispatch'); assert.equal(committed, false); }
          finally { child.release(); }
          assert.equal((await sending).mail.filter((x) => x.id === effectId).length, 1);
          await unsubscribing;
        } else {
          const gate = await h.db.admin.connect();
          let unsubscribing: Promise<Response> | undefined;
          let sending: Promise<SentEffects> | undefined;
          try {
            await gate.query('SELECT pg_advisory_lock(764022)');
            const gatePid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            await h.db.admin.query(`CREATE FUNCTION trustwork.test_suppression_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
              PERFORM pg_advisory_xact_lock(764022); RETURN NEW; END $$;
              CREATE TRIGGER zz_test_suppression_barrier AFTER INSERT ON trustwork.suppression_entry FOR EACH ROW EXECUTE FUNCTION trustwork.test_suppression_barrier()`);
            unsubscribing = client.post('/v1/me/mail-unsubscribe');
            let writerPid = 0;
            await waitFor(async () => {
              writerPid = (await h.db.admin.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [gatePid])).rows[0]?.pid ?? 0;
              return writerPid > 0;
            }, 10_000, 'unsubscribe holds its production lock before API commit');
            sending = child.command<SentEffects>('drain');
            await waitFor(async () => (await h.db.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [writerPid])).rows[0].blocked, 10_000, 'mail preflight waits for unsubscribe commit');
          } finally {
            await gate.query('SELECT pg_advisory_unlock(764022)'); gate.release();
            if (unsubscribing) ok(await unsubscribing);
            if (sending) assert.equal((await sending).mail.filter((x) => x.id === effectId).length, 0);
            await h.db.admin.query('DROP TRIGGER IF EXISTS zz_test_suppression_barrier ON trustwork.suppression_entry; DROP FUNCTION IF EXISTS trustwork.test_suppression_barrier()');
          }
        }
        assert.equal(await tx((trx) => comms.mailAllowed(trx, effectId, hubId)), false);
      } finally { child.release(); await child.close(); }
    });
  }


  await t.test('complaint feedback waits for final mail dispatch without a mail/suppression lock inversion', async () => {
    const b = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(b)));
    const effectId = (await h.db.admin.query("SELECT d.mail_delivery_id FROM trustwork.consultation_reminder r JOIN trustwork.notification n ON n.dedupe_key='message:' || r.message_id::text JOIN trustwork.delivery d ON d.notification_id=n.id WHERE r.id=$1 AND d.recipient_person_id=$2 AND d.channel='email'", [dueId(b), P.carl])).rows[0].mail_delivery_id;
    const child = await reminderProcess(pool.options, hubId);
    try {
      const atEffect = child.atEffect();
      const sending = child.command<SentEffects>('drain', { holdId: effectId });
      await atEffect;
      let committed = false;
      const feedback = tx((trx) => applyFeedback(trx, { provider: 'fake', eventId: randomUUID(), kind: 'complaint', deliveryId: effectId })).then(() => { committed = true; });
      try {
        await waitFor(async () => (await h.db.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0) AS blocked')).rows[0].blocked, 10_000, 'feedback waits for dispatch mail lock');
        assert.equal(committed, false);
      } finally { child.release(); }
      assert.equal((await sending).mail.filter((x) => x.id === effectId).length, 1);
      await feedback;
      assert.equal(await tx((trx) => comms.mailAllowed(trx, effectId, hubId)), false);
    } finally { child.release(); await child.close(); }
  });

});
