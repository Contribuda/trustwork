import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNotificationParams, ChannelGrantScopesSchema, contextPath, CreateChannelGrantCommandSchema, DEFAULT_PREFERENCES, ENGINE_TEMPLATE_LANGUAGES, InboundMessageEventSchema, maskAccount,
  MessageSchema, MODEL_CONTEXT_KINDS, NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS, NOTIFICATION_FORBIDDEN_KEYS, NOTIFICATION_TEMPLATES, NotificationSchema, OpenThreadCommandSchema,
  PostMessageCommandSchema, renderTemplateText, SetNotificationPreferenceCommandSchema, templatePlaceholderProblems, THREAD_CONTEXT_KINDS, ThreadListQuerySchema, TRANSACTIONAL_CATEGORIES,
  type NotificationTemplateKey,
} from '../../packages/contracts/src/communications.js';
import * as client from '../../packages/contracts/src/client.js';

const ID = '0b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f';
const NOW = '2026-11-02T18:00:00.000Z';

test('COMMS-001 contracts', async (t) => {
  await t.test('threads exist per context only, and only for context kinds of the data model', () => {
    for (const kind of THREAD_CONTEXT_KINDS) assert.ok((MODEL_CONTEXT_KINDS as readonly string[]).includes(kind), kind);
    assert.equal(ThreadListQuerySchema.safeParse({}).success, false, 'no listing without a context (no generic inbox)');
    assert.equal(ThreadListQuerySchema.safeParse({ contextKind: 'inbox', contextId: ID }).success, false);
    assert.equal(ThreadListQuerySchema.safeParse({ contextKind: 'project', contextId: ID }).success, true);
    const open = OpenThreadCommandSchema.parse({ context: { kind: 'project', id: ID }, subject: ' Roof ', message: { body: 'Hello' } });
    assert.equal(open.counterparty, null);
    assert.equal(open.subject, 'Roof');
    assert.deepEqual(open.message.actor, { via: 'person' });
    assert.equal(OpenThreadCommandSchema.safeParse({ context: { kind: 'project', id: ID }, subject: 'Roof' }).success, false, 'a thread starts with a message');
    assert.equal(PostMessageCommandSchema.safeParse({ body: '   ' }).success, false);
    assert.equal(PostMessageCommandSchema.safeParse({ body: 'x', extra: 1 }).success, false, 'strict');
  });

  await t.test('inbound messages are untrusted and name their provider', () => {
    const base = { id: ID, threadId: ID, author: { kind: 'person', personId: ID, displayName: null }, onBehalfOf: null, body: 'x', sourceTime: NOW, receivedAt: NOW, links: [] };
    assert.equal(MessageSchema.safeParse({ ...base, direction: 'inbound', untrusted: false, provider: 'telegram' }).success, false);
    assert.equal(MessageSchema.safeParse({ ...base, direction: 'inbound', untrusted: true, provider: null }).success, false);
    assert.equal(MessageSchema.safeParse({ ...base, direction: 'inbound', untrusted: true, provider: 'telegram' }).success, true);
    assert.equal(InboundMessageEventSchema.safeParse({ provider: 'telegram', providerMessageId: 'm1', replyToken: 'short', body: 'x', sourceTime: NOW, senderClaim: null }).success, false);
    assert.equal(InboundMessageEventSchema.safeParse({ provider: 'telegram', providerMessageId: 'm1', replyToken: 'a'.repeat(43), body: 'x', sourceTime: NOW, senderClaim: null }).success, true);
  });

  await t.test('notification parameters: declared keys only, never a forbidden key', () => {
    for (const [key, spec] of Object.entries(NOTIFICATION_TEMPLATES)) {
      for (const param of spec.params) assert.ok(!(NOTIFICATION_FORBIDDEN_KEYS as readonly string[]).includes(param), `${key} declares ${param}`);
      assert.equal(spec.transactional, TRANSACTIONAL_CATEGORIES.includes(spec.category), `${key} transactional follows its category`);
    }
    assert.deepEqual(assertNotificationParams('thread.message', { contextKind: 'project', threadSubject: 'Roof', authorName: 'Ann' }), { contextKind: 'project', threadSubject: 'Roof', authorName: 'Ann' });
    assert.throws(() => assertNotificationParams('thread.message', { body: 'secret' }), RangeError);
    assert.throws(() => assertNotificationParams('thread.message', { budgetCeiling: '9000000' }), RangeError);
    assert.throws(() => assertNotificationParams('account.security_notice', { event: 1 }), TypeError);
    const n = { id: ID, category: 'messages', templateKey: 'thread.message', params: {}, link: { kind: 'project', id: ID, threadId: ID }, transactional: false, createdAt: NOW, readAt: null };
    assert.equal(NotificationSchema.safeParse(n).success, true);
    assert.equal(NotificationSchema.safeParse({ ...n, body: 'x' }).success, false, 'a notification has no body field');
  });

  await t.test('preferences: transactional notices by e-mail cannot be turned off; defaults cover every category and channel', () => {
    for (const category of TRANSACTIONAL_CATEGORIES) {
      assert.equal(SetNotificationPreferenceCommandSchema.safeParse({ category, channel: 'email', frequency: 'off' }).success, false);
      assert.equal(DEFAULT_PREFERENCES[category].email, 'immediate');
    }
    assert.equal(SetNotificationPreferenceCommandSchema.safeParse({ category: 'messages', channel: 'email', frequency: 'off' }).success, true);
    for (const category of NOTIFICATION_CATEGORIES) for (const channel of NOTIFICATION_CHANNELS) assert.ok(DEFAULT_PREFERENCES[category][channel]);
  });

  await t.test('channel grants: scoped, no blanket mailbox, masked display', () => {
    assert.equal(ChannelGrantScopesSchema.safeParse({ contextKinds: [], actions: ['notify'] }).success, false);
    assert.equal(ChannelGrantScopesSchema.safeParse({ contextKinds: ['project', 'project'], actions: ['notify'] }).success, false);
    assert.equal(CreateChannelGrantCommandSchema.safeParse({ provider: 'email', account: 'a@example.invalid', scopes: { contextKinds: ['project'], actions: ['notify'] } }).success, false);
    for (const account of ['@boris_demo', '+1 555 0100', 'abcd']) {
      const masked = maskAccount(account);
      assert.ok(masked.includes('***') && masked !== account && masked.length < account.length + 3, `${account} -> ${masked}`);
    }
  });

  await t.test('templates: placeholders from the template only; plain substitution', () => {
    assert.deepEqual(templatePlaceholderProblems('thread.message', '{authorName} wrote in {threadSubject} on {brand}'), []);
    assert.deepEqual(templatePlaceholderProblems('thread.message', 'Budget {budgetCeiling}'), ['unknown placeholder {budgetCeiling}']);
    assert.deepEqual(templatePlaceholderProblems('account.security_notice', 'Event {event'), ['unbalanced braces']);
    assert.equal(renderTemplateText('{authorName} wrote: {threadSubject} {unknown}', { authorName: 'Ann', threadSubject: 'Roof' }), 'Ann wrote: Roof {unknown}');
    const keys = Object.keys(NOTIFICATION_TEMPLATES) as NotificationTemplateKey[];
    assert.ok(keys.length >= 3);
  });

  await t.test('the engine template languages are the seven languages of the web dictionaries', () => {
    const directories = readdirSync(resolve('apps/web/locales'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    assert.deepEqual([...ENGINE_TEMPLATE_LANGUAGES].sort(), directories);
  });

  await t.test('links point into the workspace; the client barrel exports the module', () => {
    assert.equal(contextPath('project', ID), `/app/projects/${ID}`);
    assert.equal(contextPath('rfq', ID), `/app/procurement/rfq/${ID}`);
    assert.equal(contextPath('task_assignment', ID), '/app/notifications');
    assert.equal(contextPath('project', '../x'), '/app/projects/..%2Fx');
    assert.equal(typeof client.contextPath, 'function');
    assert.equal(client.THREAD_CONTEXT_KINDS, THREAD_CONTEXT_KINDS);
  });
});
