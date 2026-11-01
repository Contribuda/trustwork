import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { adminSetup, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { consultationCommunications as comms, threads } from '../../packages/data/src/repositories/communications.js';
import { ConsultationsService } from '../../apps/api/src/modules/consultations/consultations.service.js';
import { NoConsultationMandates } from '../../apps/api/src/modules/consultations/mandates.js';
import { NoPublishedCommission, ScreeningCommitmentGate } from '../../apps/api/src/modules/consultations/ports.js';
import { ConfiguredElectronicRecords } from '../../apps/api/src/modules/transactions/electronic-records.js';
import type { BookingView, ExpertRequestView, RequesterRequestView } from '../../packages/contracts/src/consultations.js';
import { ENGINE_TEMPLATE_LANGUAGES, ThreadSchema, ThreadViewSchema } from '../../packages/contracts/src/communications.js';
import { consultationRemindersTask, produceReminder, ReminderChannelFake, type ReminderRuntime } from '../../apps/worker/src/consultations/reminders.js';
import { inTransaction } from '../../apps/worker/src/db.js';
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
    await staffRoleDefinitions.release(trx, { version: 1, role: 'editor', scopes: ['hub'], permissions: ['admin.notifications.template.edit'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await staffRoleDefinitions.release(trx, { version: 1, role: 'ops-engineer', scopes: ['hub'], permissions: ['admin.notifications.template.edit', 'admin.config.edit'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    for (const [personId, role] of [[P.boris, 'editor'], [P.xenia, 'ops-engineer']] as const) await adminSetup.bootstrapFirstAdmin(trx, { personId, role, scope: { kind: 'hub', hubId }, definitionVersion: 1, reason: 'Synthetic template review' });
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
    new NoConsultationMandates(), new ConfiguredElectronicRecords(), new NoPublishedCommission(), new ScreeningCommitmentGate());
  const prepare = async (seller: Client = expert, selectedOffering = offeringId, selectedWindow = window.id) => {
    const req = ok<RequesterRequestView>(await client.post('/v1/consultation-requests', { source: { kind: 'direct' }, offeringId: selectedOffering, actor: PERSON, mentoringRelationshipId: null,
      privateConstraint: { budgetCeiling: { minorUnits: '987654321', currency: 'USD' }, requesterNotes: 'PRIVATE-reminder' }, terms: { kind: 'session', question: 'PRIVATE shared question', fields: [], preferredModes: ['video'], preferredTimes: [], sharedMaterials: [], licenceRequired: false, languages: ['en'] } }));
    const proposed = ok<ExpertRequestView>(await seller.post(`/v1/consultation-requests/${req.request.id}/proposals`, { expectedRevision: req.request.revision, mode: 'video', slot: { windowId: selectedWindow, start: at(nextStart++) }, deliverableDue: null, validUntil: at(24), note: null, actor: PERSON }));
    const b = proposed.bookings[0]!;
    const fresh = ok<RequesterRequestView>(await client.get(`/v1/consultation-requests/${req.request.id}`));
    const accepted = ok<RequesterRequestView>(await client.post(`/v1/consultation-requests/${req.request.id}/acceptances`, { booking: { id: b.id, version: 1, digest: b.digest }, request: { id: req.request.id, version: 1, digest: req.request.digest }, expectedRevision: fresh.request.revision, recordingConsent: false, electronicRecords: CONSENT, actor: PERSON }));
    const a = accepted.agreements[0]!;
    return a;
  };
  const book = async (seller: Client = expert, selectedOffering = offeringId, selectedWindow = window.id) => {
    const a = await prepare(seller, selectedOffering, selectedWindow);
    return service.confirmBooking(a.id, { expectedRevision: a.revision, acceptedTermsDigest: a.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON }, randomUUID(), await stateOf(h, seller, randomUUID()));
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
    await assert.rejects(withPrincipal(h.pool, principal, (trx) => comms.produce(trx, dueId(first), 'forbidden')), /permission denied/);
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
    assert.equal(transport.sent.length, 0, 'mail enqueue is not provider delivery');
    const threadId = (await h.db.admin.query('SELECT id FROM trustwork.context_thread WHERE context_id=$1', [first.agreement!.id])).rows[0].id;
    const view = ThreadViewSchema.parse(ok(await client.get(`/v1/threads/${threadId}`)));
    assert.deepEqual(view.messages[0]!.author, { kind: 'system' });
    assert.equal(view.messages[0]!.body, texts.en!.body);
    await drain(worker);
    assert.equal(transport.sent.length, 2);
    assert.ok(transport.sent.some((mail) => mail.locale === 'es' && mail.text.includes(texts.es!.body)));
    await drain(worker);
    assert.equal(transport.sent.length, 2, 'duplicate relay/ticks never resend');
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
    assert.equal(transport.sent.length, 2);
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
    assert.equal(transport.sent.length, 2);
    await clearHold(h.db.admin, P.carl, P.petr);
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('notification_preference').values({ person_id: P.petr, category: 'messages', channel: 'email', frequency: 'off' }).execute());
    const off = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(off)));
    const mailBefore = transport.sent.length;
    await drain(worker);
    assert.equal(transport.sent.length, mailBefore + 1, 'recipient off gets a context signal but no email');
    const changed = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(changed)));
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('notification_preference').values({ person_id: P.carl, category: 'messages', channel: 'email', frequency: 'off' }).execute());
    await drain(worker);
    assert.equal(transport.sent.length, mailBefore + 1, 'an off preference changed after enqueue still prevents sending');
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('notification_preference').set({ frequency: 'immediate' }).where('person_id', '=', P.carl).execute());
  });

  await t.test('withdrawn mail verification suppresses a queued reminder; ambiguous mail parks without replay', async () => {
    const unverified = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(unverified)));
    const before = transport.sent.length;
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('email_binding').set({ verified_at: null }).where('person_id', '=', P.carl).execute());
    await drain(worker);
    assert.equal(transport.sent.length, before);
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('email_binding').set({ verified_at: new Date() }).where('person_id', '=', P.carl).execute());
    const ambiguous = await book();
    await tx((trx) => produceReminder(trx, runtime, dueId(ambiguous)));
    transport.failNext('unknown');
    await drain(worker);
    const parked = (await h.db.admin.query("SELECT id FROM trustwork.job WHERE kind='mail.deliver' AND state='outcome_unknown'")).rows;
    assert.equal(parked.length, 1);
    assert.equal(transport.sent.length, before + 1);
    await drain(worker);
    assert.equal(transport.sent.length, before + 1, 'unknown mail is never automatically retried');
    await tx((trx) => reconcileJob(trx, { jobId: parked[0].id, outcome: 'succeeded', reference: 'synthetic mailbox evidence', mode: 'manual' }));
    await drain(worker);
    assert.equal(transport.sent.length, before + 1, 'reconciliation records evidence without resending');
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
    const before = transport.sent.length;
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.page.edit'] }).where('id', '=', seed.memberships.anna).execute());
    await drain(worker);
    assert.equal(transport.sent.length, before, 'the former company deal manager receives no mail');
    const threadId = (await h.db.admin.query('SELECT id FROM trustwork.context_thread WHERE context_id=$1', [revoked.agreement!.id])).rows[0].id;
    assert.equal((await anna.get(`/v1/threads/${threadId}`)).status, 404);
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.page.edit', 'company.deals.manage', 'company.catalogue.edit', 'company.publish'] }).where('id', '=', seed.memberships.anna).execute());
    const expired = await book(anna, id, w.id);
    await tx((trx) => produceReminder(trx, runtime, dueId(expired)));
    ok(await anna.post('/v1/reputation-builder/credentials', { ...credentialBody, number: 'SYNTHETIC-124', supersedesId: licence.id }));
    await drain(worker);
    assert.equal(transport.sent.length, before, 'superseding the pinned licence stops final dispatch');
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
    assert.equal(await tx((trx) => comms.mailAllowed(trx, (transport.sent.at(-1)!.headers['X-Entity-Ref-ID'])!)), false);
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
    const parked = (await h.db.admin.query("SELECT id FROM trustwork.job WHERE kind='consultation.notify' AND state='outcome_unknown'")).rows;
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
});
