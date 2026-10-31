import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { adminSetup, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { mailAddressHash } from '../../packages/data/src/repositories/mail.js';
import {
  COMMS_EVENT_PAYLOAD_KEYS, ENGINE_TEMPLATE_LANGUAGES, NOTIFICATION_FORBIDDEN_KEYS, NOTIFICATION_TEMPLATES,
  type ChannelGrant, type Message, type NotificationPage, type NotificationPreferences, type ThreadList, type ThreadView, type TemplateVersionList,
} from '../../packages/contracts/src/communications.js';
import type { OwnerRfqView } from '../../packages/contracts/src/commerce.js';
import { CommunicationsService } from '../../apps/api/src/modules/communications/communications.service.js';
import { FakeChannelAdapter } from '../../apps/api/src/modules/communications/channels.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { EMAILS, login, seedPersonas } from '../backend/helpers/personas.js';
import { principalFor } from '../data/helpers/seed.js';

/**
 * COMMS-001 through the HTTP API (real PostgreSQL, runtime role, CSRF, idempotency): threads belong to a context and
 * non-participants get not found; RFQ threads are per counterparty and competitors never see each other's; the
 * notification a party receives carries only template parameters every recipient may read (never a message body, a
 * buyer ceiling or a private note) and disappears when the recipient loses the context; templates activate only in
 * every hub language and by a second person; e-mail goes through MAIL-001 and suppressed addresses get no
 * non-transactional mail; messenger notifications go through the fake adapter with a reply token, inbound replies are
 * untrusted and de-duplicated by provider message id, also under concurrency.
 */
const HUB_ID = randomUUID();
const channels = new FakeChannelAdapter();
const h = await startHarness('comms_api', {
  communications: { channels, settings: { hubId: HUB_ID, hubLanguages: [...ENGINE_TEMPLATE_LANGUAGES], defaultLanguage: 'en' } },
});

const PERSON = { via: 'person' as const };
const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const RFQ_PAYLOAD = {
  title: 'Patio pavers and laying', currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [], paymentTermsRequested: 'Net 30', acceptanceCriteria: 'Level within 3 mm per metre',
  deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } },
  lines: [{ lineId: 'pavers', kind: 'goods', description: 'Concrete pavers, grey', specification: { thickness: '60 mm' }, quantity: { value: '10', unit: 'm2' }, alternativesAllowed: true }],
};
const BUYER_PRIVATE = { budgetCeiling: usd('9000000'), evaluationWeights: { price: '0.7' }, internalNotes: 'PRIVATE-buyer-ceiling-note', shortlist: [] as unknown[] };
const SECRETS = ['9000000', 'PRIVATE-buyer', 'owner only', 'SECRET-BODY'];
const STAFF_PASSWORD = 'synthetic-comms-staff-0001';
function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
/** A notification never carries a forbidden key or a private value of the other party, nor any message text. */
function noLeak(value: unknown, extra: readonly string[] = []): void {
  const json = JSON.stringify(value);
  for (const key of NOTIFICATION_FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} leaked: ${json.slice(0, 300)}`);
  for (const secret of [...SECRETS, ...extra]) assert.ok(!json.includes(secret), `${secret} leaked: ${json.slice(0, 300)}`);
}
const TEXTS: Record<string, { subject: string; body: string }> = {
  en: { subject: '{authorName} wrote: {threadSubject}', body: 'New message about your {contextKind} in {brand}.' },
  ru: { subject: '{authorName}: {threadSubject}', body: 'ru text {contextKind} {brand}' },
  'uz-Latn': { subject: '{authorName}: {threadSubject}', body: 'uz text {contextKind}' },
  ka: { subject: '{authorName}: {threadSubject}', body: 'ka text {contextKind}' },
  hy: { subject: '{authorName}: {threadSubject}', body: 'hy text {contextKind}' },
  'az-Latn': { subject: '{authorName}: {threadSubject}', body: 'az text {contextKind}' },
  es: { subject: '{authorName} escribió: {threadSubject}', body: 'Mensaje nuevo sobre {contextKind}.' },
};

test('communications API: context threads, notifications, templates, mail, channels and inbound intake with negative authorization and concurrency', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const staff = await withMaintenance(h.db.admin, async (trx) => {
    await trx.insertInto('hub').values({ id: HUB_ID, slug: 'synthetic-comms-hub', lifecycle: 'public' }).execute();
    await staffRoleDefinitions.release(trx, { version: 1, role: 'editor', scopes: ['hub'], permissions: ['admin.notifications.template.edit'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await staffRoleDefinitions.release(trx, { version: 1, role: 'ops-engineer', scopes: ['hub'], permissions: ['admin.notifications.template.edit', 'admin.config.edit', 'admin.notifications.read'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    const editor = await person('Synthetic Template Editor');
    const ops = await person('Synthetic Operations');
    await adminSetup.bootstrapFirstAdmin(trx, { personId: editor, role: 'editor', scope: { kind: 'hub', hubId: HUB_ID }, definitionVersion: 1, reason: 'Synthetic setup' });
    await adminSetup.bootstrapFirstAdmin(trx, { personId: ops, role: 'ops-engineer', scope: { kind: 'hub', hubId: HUB_ID }, definitionVersion: 1, reason: 'Synthetic setup' });
    const passwordHash = await hash(STAFF_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    for (const [id, email] of [[editor, 'comms-editor@example.invalid'], [ops, 'comms-ops@example.invalid']] as const) {
      await trx.insertInto('email_binding').values({ person_id: id, email_normalized: email, is_primary: true, verified_at: new Date('2026-10-01T09:00:00Z') }).execute();
      await trx.insertInto('credential').values({ person_id: id, kind: 'password', password_hash: passwordHash }).execute();
    }
    return { editor, ops };
  });
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const staffClient = async (email: string): Promise<Client> => {
    const c = h.client();
    ok(await c.post('/v1/auth/login', { email, password: STAFF_PASSWORD }, { idempotencyKey: null }));
    return c;
  };
  const [petr, boris, carl, xenia, anna] = [await as('petr'), await as('boris'), await as('carl'), await as('xenia'), await as('anna')];
  const [editor, ops] = [await staffClient('comms-editor@example.invalid'), await staffClient('comms-ops@example.invalid')];
  const anonymous = h.client();
  const service = h.created.app.get(CommunicationsService);
  const project = seed.project;
  const supplier = { kind: 'company' as const, id: seed.companies.supplier };
  const carlParty = { kind: 'person' as const, id: seed.people.carl };
  const message = (body: string, extra: Record<string, unknown> = {}) => ({ body, links: [], onBehalfOfCompany: false, actor: PERSON, ...extra });
  const count = async (query: string, params: unknown[] = []) => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]!.n;
  const notificationsOf = async (client: Client) => ok<NotificationPage>(await client.get('/v1/notifications?limit=100'));

  /* ---------- Templates: every hub language, a second person ---------- */
  await t.test('templates: activation needs every hub language and a person other than the drafter', async () => {
    const draft = (client: Client, key: string, version: number, locale: string) => client.post(`/v1/hub/message-templates/${key}/drafts`, { version, locale, ...TEXTS[locale]! });
    expectError(await carl.post('/v1/hub/message-templates/thread.message/drafts', { version: 1, locale: 'en', ...TEXTS.en! }), 403, 'access.forbidden');
    expectError(await carl.get('/v1/hub/message-templates/thread.message'), 403, 'access.forbidden');
    expectError(await anonymous.get('/v1/hub/message-templates/thread.message'), 401, 'auth.session_invalid');
    expectError(await editor.post('/v1/hub/message-templates/thread.message/drafts', { version: 1, locale: 'en', subject: 'Hi {firstName}', body: 'x' }), 422, 'validation.schema');
    expectError(await editor.post('/v1/hub/message-templates/thread.message/drafts', { version: 1, locale: 'pl', subject: 'Hi', body: 'x' }), 422, 'validation.schema');
    expectError(await editor.post('/v1/hub/message-templates/thread.message/drafts', { version: 2, locale: 'en', ...TEXTS.en! }), 422, 'validation.schema');
    for (const locale of ENGINE_TEMPLATE_LANGUAGES.filter((l) => l !== 'ka')) ok(await draft(editor, 'thread.message', 1, locale));
    const incomplete = await ops.post('/v1/hub/message-templates/thread.message/versions/1/activate', { reason: 'Launch texts' });
    expectError(incomplete, 422, 'validation.schema');
    assert.deepEqual((incomplete.body as { details: { missing: string[] } }).details.missing, ['ka'], 'the missing hub language is named');
    ok(await draft(editor, 'thread.message', 1, 'ka'));
    expectError(await editor.post('/v1/hub/message-templates/thread.message/versions/1/activate', { reason: 'Self' }), 403, 'access.forbidden');
    const active = ok<TemplateVersionList>(await ops.post('/v1/hub/message-templates/thread.message/versions/1/activate', { reason: 'Launch texts' }));
    assert.equal(active.items.length, ENGINE_TEMPLATE_LANGUAGES.length);
    assert.ok(active.items.every((v) => v.status === 'active' && v.activatedByPersonId === staff.ops && v.draftedByPersonId === staff.editor));
    expectError(await draft(editor, 'thread.message', 1, 'en'), 409, 'validation.revision_conflict');
    // The operations person drafts version 2 and cannot activate their own draft.
    for (const locale of ENGINE_TEMPLATE_LANGUAGES) ok(await draft(ops, 'thread.message', 2, locale));
    expectError(await ops.post('/v1/hub/message-templates/thread.message/versions/2/activate', { reason: 'Own draft' }), 403, 'access.second_approver_required');
    const listed = ok<TemplateVersionList>(await editor.get('/v1/hub/message-templates/thread.message'));
    assert.equal(listed.items.filter((v) => v.status === 'active').length, ENGINE_TEMPLATE_LANGUAGES.length);
    assert.equal(listed.items.filter((v) => v.version === 1).every((v) => v.status === 'active'), true, 'version 1 stays active');
    // The other two templates, drafted by the editor and activated by operations (used below).
    for (const key of ['thread.opened', 'account.security_notice']) {
      for (const locale of ENGINE_TEMPLATE_LANGUAGES) {
        const text = key === 'account.security_notice' ? { subject: 'Security notice', body: 'Event: {event}' } : TEXTS[locale]!;
        ok(await editor.post(`/v1/hub/message-templates/${key}/drafts`, { version: 1, locale, ...text }));
      }
    }
    // Two concurrent activations of the same version: one wins, the other finds it frozen; one active version per language.
    const [a, b] = await Promise.all([ops.post('/v1/hub/message-templates/thread.opened/versions/1/activate', { reason: 'A' }), ops.post('/v1/hub/message-templates/thread.opened/versions/1/activate', { reason: 'B' })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
    ok(await ops.post('/v1/hub/message-templates/account.security_notice/versions/1/activate', { reason: 'Launch' }));
    assert.equal(await count("SELECT 1 FROM trustwork.template_version WHERE status = 'active'"), ENGINE_TEMPLATE_LANGUAGES.length * 3);
  });

  /* ---------- Project thread ---------- */
  let projectThread: ThreadView;
  await t.test('project thread: parties only, no generic inbox, notifications carry recipient-visible values only', async () => {
    const open = { context: { kind: 'project', id: project }, subject: 'Roof schedule', counterparty: null, message: message('SECRET-BODY first note about the roof') };
    expectError(await anonymous.post('/v1/threads', open, { idempotencyKey: null }), 401, 'auth.session_invalid');
    for (const outsider of [carl, xenia, anna]) expectError(await outsider.post('/v1/threads', open), 404, 'access.not_found');
    expectError(await petr.post('/v1/threads', { ...open, context: { kind: 'project', id: randomUUID() } }), 404, 'access.not_found');
    expectError(await petr.post('/v1/threads', { ...open, context: { kind: 'project', id: 'not-a-uuid' } }), 404, 'access.not_found');
    expectError(await petr.post('/v1/threads', { ...open, counterparty: supplier }), 422, 'validation.schema');
    expectError(await petr.post('/v1/threads', { ...open, context: { kind: 'support_case', id: randomUUID() } }), 422, 'validation.schema');
    projectThread = ok<ThreadView>(await petr.post('/v1/threads', open), 201);
    assert.equal(projectThread.side, 'owner');
    assert.equal(projectThread.messages.length, 1);
    assert.equal(projectThread.messages[0]!.untrusted, false);
    assert.equal(projectThread.messages[0]!.author.kind, 'person');
    // No generic inbox: threads are listed per context only.
    expectError(await petr.get('/v1/threads'), 422, 'validation.schema');
    const borisList = ok<ThreadList>(await boris.get(`/v1/threads?contextKind=project&contextId=${project}`));
    assert.equal(borisList.side, 'participant');
    assert.deepEqual(borisList.items.map((i) => i.id), [projectThread.thread.id]);
    for (const outsider of [carl, xenia, anna]) {
      expectError(await outsider.get(`/v1/threads?contextKind=project&contextId=${project}`), 404, 'access.not_found');
      expectError(await outsider.get(`/v1/threads/${projectThread.thread.id}`), 404, 'access.not_found');
      expectError(await outsider.post(`/v1/threads/${projectThread.thread.id}/messages`, message('intrusion')), 404, 'access.not_found');
    }
    // A public project does not open its threads.
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('project').set({ publicity_enabled: true }).where('id', '=', project).execute());
    expectError(await carl.get(`/v1/threads?contextKind=project&contextId=${project}`), 404, 'access.not_found');
    expectError(await carl.get(`/v1/threads/${projectThread.thread.id}`), 404, 'access.not_found');
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('project').set({ publicity_enabled: false }).where('id', '=', project).execute());

    const reply = ok<Message>(await boris.post(`/v1/threads/${projectThread.thread.id}/messages`, message('SECRET-BODY supplier answer', { onBehalfOfCompany: true })), 201);
    assert.deepEqual(reply.onBehalfOf, supplier);
    expectError(await carl.post(`/v1/threads/${projectThread.thread.id}/messages`, message('x', { onBehalfOfCompany: true })), 404, 'access.not_found');
    expectError(await boris.post(`/v1/threads/${projectThread.thread.id}/messages`, message('agent text', { actor: { via: 'agent', mandateId: randomUUID() } })), 403, 'access.mandate_scope');
    // Opening the same context again appends to the one thread.
    const again = ok<ThreadView>(await boris.post('/v1/threads', { ...open, subject: 'Other subject', message: message('third') }), 201);
    assert.equal(again.thread.id, projectThread.thread.id);
    assert.equal(again.thread.subject, 'Roof schedule');
    assert.equal(again.messages.length, 3);

    const petrBox = await notificationsOf(petr);
    const borisBox = await notificationsOf(boris);
    assert.equal(petrBox.items.length, 2, 'petr hears about both of boris\'s messages');
    assert.equal(borisBox.items.length, 1, 'boris hears about the opening message');
    assert.equal(borisBox.items[0]!.templateKey, 'thread.opened');
    assert.deepEqual(borisBox.items[0]!.params, { contextKind: 'project', threadSubject: 'Roof schedule', authorName: 'Fixture Petr' });
    assert.deepEqual(petrBox.items[0]!.link, { kind: 'project', id: project, threadId: projectThread.thread.id });
    for (const n of [...petrBox.items, ...borisBox.items]) assert.deepEqual(Object.keys(n.params).sort(), [...NOTIFICATION_TEMPLATES[n.templateKey].params].sort());
    noLeak(petrBox);
    noLeak(borisBox);
    for (const outsider of [carl, xenia, anna]) assert.equal((await notificationsOf(outsider)).items.length, 0);
    // Mail through MAIL-001: one notification mail per recipient, rendered in the hub language, no message body.
    const mails = (await h.db.admin.query<{ recipient_hash: string; params: Record<string, string>; template: string }>("SELECT recipient_hash, params, template FROM trustwork.mail_delivery WHERE template = 'notification'")).rows;
    assert.equal(mails.length, 3, 'one mail per notification: two to petr, one to boris');
    assert.equal(mails.filter((m) => m.recipient_hash === mailAddressHash(EMAILS.petr)).length, 2);
    assert.ok(mails.every((m) => m.params.path === `/app/projects/${project}` && m.params.transactional === 'false'));
    assert.ok(mails.some((m) => m.params.subject === 'Fixture Boris wrote: Roof schedule'));
    for (const secret of SECRETS) assert.ok(!JSON.stringify(mails).includes(secret), `${secret} reached a mail`);
    // Outbox events carry identifiers only.
    const events = (await h.db.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM trustwork.outbox_event WHERE type LIKE 'comms.%'")).rows;
    assert.ok(events.length >= 4);
    for (const e of events) for (const key of Object.keys(e.payload)) assert.ok((COMMS_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key), `outbox key ${key}`);
  });

  await t.test('notifications: read marks are the recipient\'s own', async () => {
    const box = await notificationsOf(petr);
    assert.equal(box.unreadCount, 2);
    expectError(await carl.post(`/v1/notifications/${box.items[0]!.id}/read`), 404, 'access.not_found');
    expectError(await boris.post(`/v1/notifications/${box.items[0]!.id}/read`), 404, 'access.not_found');
    const read = ok<{ readAt: string | null }>(await petr.post(`/v1/notifications/${box.items[0]!.id}/read`));
    assert.ok(read.readAt);
    assert.equal((await notificationsOf(petr)).unreadCount, 1);
    assert.equal(ok<NotificationPage>(await petr.get('/v1/notifications?unread=true')).items.length, 1);
    ok(await petr.post('/v1/notifications/read-all'));
    assert.equal((await notificationsOf(petr)).unreadCount, 0);
    const page = ok<NotificationPage>(await petr.get('/v1/notifications?limit=1'));
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const next = ok<NotificationPage>(await petr.get(`/v1/notifications?limit=1&cursor=${page.nextCursor}`));
    assert.notEqual(next.items[0]!.id, page.items[0]!.id);
  });

  /* ---------- RFQ: one thread per counterparty ---------- */
  await t.test('RFQ threads: per counterparty, competitors isolated, buyer private constraint never in a notification', async () => {
    let rfq = ok<OwnerRfqView>(await petr.post('/v1/rfqs', { owner: { kind: 'person', id: seed.people.petr }, projectId: null, payload: RFQ_PAYLOAD, category: 'landscaping', publicProjection: { enabled: false, fields: [] }, privateConstraint: BUYER_PRIVATE, source: null, actor: PERSON }), 201);
    rfq = ok<OwnerRfqView>(await petr.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: PERSON }));
    for (const party of [supplier, carlParty]) ok(await petr.post(`/v1/rfqs/${rfq.rfq.id}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, party, channel: 'platform', actor: PERSON }), 201);
    const context = { kind: 'rfq', id: rfq.rfq.id };
    const open = (counterparty: unknown, body = 'Question about delivery') => ({ context, subject: 'Delivery window', counterparty, message: message(body) });
    expectError(await boris.post('/v1/threads', open(null)), 422, 'validation.schema');
    expectError(await boris.post('/v1/threads', open(carlParty)), 404, 'access.not_found');
    expectError(await petr.post('/v1/threads', open({ kind: 'company', id: seed.companies.mixed })), 404, 'access.not_found');
    expectError(await anna.post('/v1/threads', open({ kind: 'company', id: seed.companies.mixed })), 404, 'access.not_found');
    const supplierThread = ok<ThreadView>(await boris.post('/v1/threads', open(supplier)), 201);
    assert.equal(supplierThread.side, 'counterparty');
    // Concurrent openings of carl's thread meet on the one thread; both messages are kept.
    const [c1, c2] = await Promise.all([carl.post('/v1/threads', open(carlParty, 'first')), carl.post('/v1/threads', open(carlParty, 'second'))]);
    const t1 = ok<ThreadView>(c1, 201);
    const t2 = ok<ThreadView>(c2, 201);
    assert.equal(t1.thread.id, t2.thread.id);
    assert.equal(await count('SELECT 1 FROM trustwork.context_thread WHERE context_kind = $1 AND context_id = $2', ['rfq', rfq.rfq.id]), 2);
    assert.equal(await count('SELECT 1 FROM trustwork.message WHERE thread_id = $1', [t1.thread.id]), 2);
    const carlThread = t1.thread;
    assert.deepEqual(ok<ThreadList>(await petr.get(`/v1/threads?contextKind=rfq&contextId=${rfq.rfq.id}`)).items.map((i) => i.id).sort(), [supplierThread.thread.id, carlThread.id].sort());
    assert.deepEqual(ok<ThreadList>(await boris.get(`/v1/threads?contextKind=rfq&contextId=${rfq.rfq.id}`)).items.map((i) => i.id), [supplierThread.thread.id]);
    assert.deepEqual(ok<ThreadList>(await carl.get(`/v1/threads?contextKind=rfq&contextId=${rfq.rfq.id}`)).items.map((i) => i.id), [carlThread.id]);
    expectError(await carl.get(`/v1/threads/${supplierThread.thread.id}`), 404, 'access.not_found');
    expectError(await boris.get(`/v1/threads/${carlThread.id}`), 404, 'access.not_found');
    expectError(await carl.post(`/v1/threads/${supplierThread.thread.id}/messages`, message('peek')), 404, 'access.not_found');
    expectError(await anna.get(`/v1/threads?contextKind=rfq&contextId=${rfq.rfq.id}`), 404, 'access.not_found');
    ok(await petr.post(`/v1/threads/${supplierThread.thread.id}/messages`, message('SECRET-BODY our ceiling is 9000000')), 201);
    // The buyer's notifications name the thread; the supplier's never carry the buyer's private values or the body.
    const borisBox = await notificationsOf(boris);
    const rfqNotes = borisBox.items.filter((n) => n.link?.kind === 'rfq');
    assert.equal(rfqNotes.length, 1);
    noLeak(borisBox);
    const carlBox = await notificationsOf(carl);
    assert.equal(carlBox.items.filter((n) => n.link?.threadId === supplierThread.thread.id).length, 0, 'a competitor hears nothing of another thread');
    noLeak(carlBox);
    const petrBox = await notificationsOf(petr);
    assert.equal(petrBox.items.filter((n) => n.link?.kind === 'rfq').length, 3);
  });

  /* ---------- Concurrency: messages ---------- */
  await t.test('concurrent messages: every message counted once, one notification per message and recipient', async () => {
    const before = await count('SELECT 1 FROM trustwork.message WHERE thread_id = $1', [projectThread.thread.id]);
    const notesBefore = await count("SELECT 1 FROM trustwork.notification WHERE link_thread_id = $1", [projectThread.thread.id]);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? petr : boris).post(`/v1/threads/${projectThread.thread.id}/messages`, message(`burst ${i}`))));
    for (const r of results) ok(r, 201);
    const thread = ok<ThreadView>(await petr.get(`/v1/threads/${projectThread.thread.id}`));
    assert.equal(thread.thread.messageCount, before + 8);
    assert.equal(thread.messages.length, before + 8);
    assert.equal(await count("SELECT 1 FROM trustwork.notification WHERE link_thread_id = $1", [projectThread.thread.id]), notesBefore + 8);
    // A replay of the same idempotency key does not post twice.
    const key = `replay-${randomUUID()}`;
    const first = ok<Message>(await petr.post(`/v1/threads/${projectThread.thread.id}/messages`, message('once'), { idempotencyKey: key }), 201);
    const second = ok<Message>(await petr.post(`/v1/threads/${projectThread.thread.id}/messages`, message('once'), { idempotencyKey: key }), 201);
    assert.equal(first.id, second.id);
    assert.equal(await count("SELECT 1 FROM trustwork.message WHERE body = 'once'"), 1);
  });

  /* ---------- Preferences and suppression ---------- */
  await t.test('preferences and suppression: transactional notices cannot be turned off; suppressed addresses get no non-transactional mail', async () => {
    const prefs = ok<NotificationPreferences>(await boris.get('/v1/me/notification-preferences'));
    assert.equal(prefs.items.length, 18);
    assert.equal(prefs.emailSuppressed, null);
    expectError(await boris.post('/v1/me/notification-preferences', { category: 'account', channel: 'email', frequency: 'off' }), 422, 'validation.schema');
    const mailsTo = (email: string) => count("SELECT 1 FROM trustwork.mail_delivery WHERE template = 'notification' AND recipient_hash = $1", [mailAddressHash(email)]);

    // A hard bounce of petr's address: petr's notification mail is suppressed, the bell still shows it.
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('suppression_entry').values({ address_hash: mailAddressHash(EMAILS.petr), reason: 'bounce', source: 'test' }).execute());
    const petrMails = await mailsTo(EMAILS.petr);
    const unread = (await notificationsOf(petr)).unreadCount;
    ok(await boris.post(`/v1/threads/${projectThread.thread.id}/messages`, message('after the bounce')), 201);
    assert.equal(await mailsTo(EMAILS.petr), petrMails, 'no mail to a suppressed address');
    assert.equal((await notificationsOf(petr)).unreadCount, unread + 1);
    assert.ok(await count("SELECT 1 FROM trustwork.delivery WHERE recipient_person_id = $1 AND state = 'suppressed' AND reason = 'suppressed_bounce'", [seed.people.petr]) >= 1);

    // Boris unsubscribes: no non-transactional mail, but a transactional notice still goes.
    const unsubscribed = ok<NotificationPreferences>(await boris.post('/v1/me/mail-unsubscribe'));
    assert.equal(unsubscribed.emailSuppressed, 'unsubscribe');
    const borisMails = await mailsTo(EMAILS.boris);
    ok(await petr.post(`/v1/threads/${projectThread.thread.id}/messages`, message('after the unsubscribe')), 201);
    assert.equal(await mailsTo(EMAILS.boris), borisMails, 'no non-transactional mail after unsubscribing');
    const principal = await principalFor(h.db.admin, seed.people.boris);
    await withPrincipal(h.pool, principal, (trx) => service.notify(trx, { recipient: seed.people.boris, template: 'account.security_notice', params: { event: 'password_changed' }, link: null, dedupeKey: 'security:1' }));
    assert.equal(await mailsTo(EMAILS.boris), borisMails + 1, 'a transactional notice still reaches an unsubscribed address');
    const notice = (await h.db.admin.query<{ params: Record<string, string> }>("SELECT params FROM trustwork.mail_delivery WHERE template = 'notification' AND recipient_hash = $1 ORDER BY seq DESC LIMIT 1", [mailAddressHash(EMAILS.boris)])).rows[0]!;
    assert.equal(notice.params.transactional, 'true');
    // ...but not to a bounced one.
    await withPrincipal(h.pool, await principalFor(h.db.admin, seed.people.petr), (trx) => service.notify(trx, { recipient: seed.people.petr, template: 'account.security_notice', params: { event: 'password_changed' }, link: null, dedupeKey: 'security:2' }));
    assert.equal(await mailsTo(EMAILS.petr), petrMails, 'a bounced address receives nothing');

    // A person who turns message e-mail off gets no e-mail delivery for new messages.
    ok(await anna.get('/v1/me/notification-preferences'));
    const offPrefs = ok<NotificationPreferences>(await petr.post('/v1/me/notification-preferences', { category: 'messages', channel: 'email', frequency: 'off' }));
    assert.equal(offPrefs.items.find((i) => i.category === 'messages' && i.channel === 'email')?.frequency, 'off');
    const deliveriesBefore = await count("SELECT 1 FROM trustwork.delivery WHERE recipient_person_id = $1 AND channel = 'email'", [seed.people.petr]);
    ok(await boris.post(`/v1/threads/${projectThread.thread.id}/messages`, message('with email off')), 201);
    assert.equal(await count("SELECT 1 FROM trustwork.delivery WHERE recipient_person_id = $1 AND channel = 'email'", [seed.people.petr]), deliveriesBefore);
  });

  /* ---------- Channels and inbound intake ---------- */
  await t.test('channel grants, messenger delivery through the fake adapter, untrusted and de-duplicated inbound replies', async () => {
    const scopes = { contextKinds: ['project'], actions: ['notify', 'reply'] };
    expectError(await anonymous.post('/v1/me/channel-grants', { provider: 'telegram', account: '@boris_demo', scopes }, { idempotencyKey: null }), 401, 'auth.session_invalid');
    expectError(await boris.post('/v1/me/channel-grants', { provider: 'email', account: 'x@example.invalid', scopes }), 422, 'validation.schema');
    const grant = ok<ChannelGrant>(await boris.post('/v1/me/channel-grants', { provider: 'telegram', account: '@boris_demo', scopes }), 201);
    assert.equal(grant.accountDisplay, '@bo***mo');
    assert.ok(!JSON.stringify(grant).includes('@boris_demo'), 'the full handle is never returned');
    assert.equal(ok<{ items: ChannelGrant[] }>(await carl.get('/v1/me/channel-grants')).items.length, 0);
    expectError(await carl.post(`/v1/me/channel-grants/${grant.id}/revoke`), 404, 'access.not_found');

    ok(await petr.post(`/v1/threads/${projectThread.thread.id}/messages`, message('SECRET-BODY please confirm by chat')), 201);
    const sent = channels.to('@boris_demo');
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.replyToken && sent[0]!.text.startsWith('Fixture Petr wrote: Roof schedule'));
    noLeak(sent[0]!.text, ['please confirm']);
    assert.equal(await count("SELECT 1 FROM trustwork.delivery WHERE channel = 'messenger' AND state = 'sent'"), 1);
    assert.equal(await count("SELECT 1 FROM trustwork.send_receipt WHERE state = 'accepted'"), 1);
    const token = sent[0]!.replyToken!;
    assert.equal(await count('SELECT 1 FROM trustwork.reply_token WHERE token_hash = $1', [token]), 0, 'only the hash is stored');

    // An inbound reply: untrusted, never a command, de-duplicated by provider message id even under concurrency.
    const agreementsBefore = await count('SELECT 1 FROM trustwork.agreement');
    const event = { provider: 'telegram' as const, providerMessageId: 'tg-1001', replyToken: token, body: '/accept quote APPROVE ORDER now', sourceTime: new Date().toISOString(), senderClaim: 'Boris (telegram)' };
    const results = await Promise.all(Array.from({ length: 5 }, () => service.ingest(event)));
    assert.equal(results.filter((r) => r.outcome === 'accepted').length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.outcome === 'duplicate').length, 4);
    assert.equal((await service.ingest(event)).outcome, 'duplicate');
    assert.equal(await count("SELECT 1 FROM trustwork.message WHERE provider = 'telegram' AND provider_message_id = 'tg-1001'"), 1);
    assert.equal(await count('SELECT 1 FROM trustwork.agreement'), agreementsBefore, 'inbound text never issues a command');
    const view = ok<ThreadView>(await petr.get(`/v1/threads/${projectThread.thread.id}`));
    const inbound = view.messages.find((m) => m.direction === 'inbound')!;
    assert.equal(inbound.untrusted, true);
    assert.equal(inbound.provider, 'telegram');
    assert.deepEqual(inbound.author, { kind: 'person', personId: seed.people.boris, displayName: 'Fixture Boris' });
    assert.ok((await notificationsOf(petr)).items.some((n) => n.params.authorName === 'Fixture Boris'));
    assert.equal((await service.ingest({ ...event, providerMessageId: 'tg-1002', provider: 'whatsapp' })).outcome, 'refused', 'a token answers only through its channel');
    assert.equal((await service.ingest({ ...event, providerMessageId: 'tg-1003', replyToken: 'x'.repeat(43) })).outcome, 'unmatched');

    // A failed and an unknown outcome are recorded, never retried.
    channels.script({ kind: 'failed', reason: 'blocked by user' }, { kind: 'unknown', reason: 'timeout' });
    ok(await petr.post(`/v1/threads/${projectThread.thread.id}/messages`, message('two')), 201);
    ok(await petr.post(`/v1/threads/${projectThread.thread.id}/messages`, message('three')), 201);
    assert.equal(await count("SELECT 1 FROM trustwork.delivery WHERE channel = 'messenger' AND state = 'failed'"), 1);
    assert.equal(await count("SELECT 1 FROM trustwork.delivery WHERE channel = 'messenger' AND state = 'outcome_unknown'"), 1);

    // After revocation the grant receives nothing and its tokens no longer match.
    const revoked = ok<ChannelGrant>(await boris.post(`/v1/me/channel-grants/${grant.id}/revoke`));
    assert.equal(revoked.status, 'revoked');
    const sentBefore = channels.to('@boris_demo').length;
    ok(await petr.post(`/v1/threads/${projectThread.thread.id}/messages`, message('after revoke')), 201);
    assert.equal(channels.to('@boris_demo').length, sentBefore);
    assert.equal((await service.ingest({ ...event, providerMessageId: 'tg-1004' })).outcome, 'unmatched');

    const counts = ok<{ items: { channel: string; state: string; count: number }[] }>(await ops.get('/v1/hub/deliveries/counts'));
    assert.ok(counts.items.some((c) => c.channel === 'messenger' && c.state === 'sent' && c.count === 1));
    assert.ok(!JSON.stringify(counts).includes(seed.people.boris), 'counts only, never per person');
    expectError(await carl.get('/v1/hub/deliveries/counts'), 403, 'access.forbidden');
  });

  /* ---------- Losing the context ---------- */
  await t.test('a party that loses the context loses its threads and its notifications about them', async () => {
    const before = (await notificationsOf(boris)).items.filter((n) => n.link?.kind === 'project').length;
    assert.ok(before > 0);
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('object_participation').set({ revoked_at: new Date(), revoked_reason: 'Synthetic: the supplier left the project' })
      .where('resource_kind', '=', 'project').where('resource_id', '=', project).where('party_company_id', '=', seed.companies.supplier).execute());
    expectError(await boris.get(`/v1/threads/${projectThread.thread.id}`), 404, 'access.not_found');
    expectError(await boris.post(`/v1/threads/${projectThread.thread.id}/messages`, message('still here?')), 404, 'access.not_found');
    assert.equal((await notificationsOf(boris)).items.filter((n) => n.link?.kind === 'project').length, 0, 'notifications follow the current rights');
    // New messages no longer notify the former party.
    const notes = await count('SELECT 1 FROM trustwork.notification WHERE recipient_person_id = $1', [seed.people.boris]);
    ok(await petr.post(`/v1/threads/${projectThread.thread.id}/messages`, message('after the revocation')), 201);
    assert.equal(await count('SELECT 1 FROM trustwork.notification WHERE recipient_person_id = $1', [seed.people.boris]), notes);
  });
});
