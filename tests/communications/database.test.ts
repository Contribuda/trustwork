import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { channelGrants, messages, notifications, threads } from '../../packages/data/src/repositories/communications.js';
import { mailAddressHash } from '../../packages/data/src/repositories/mail.js';
import { DEFAULT_PREFERENCES, NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS, NOTIFICATION_TEMPLATES, THREAD_CONTEXT_KINDS } from '../../packages/contracts/src/communications.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { principalFor, seedFixtures } from '../data/helpers/seed.js';

/**
 * COMMS-001 database layer under the real runtime role (FORCE RLS, no mocks): no thread without a context, for every
 * role; thread access derived live from the context; append-only messages, untrusted inbound and unique provider
 * message ids (also under concurrency); notification parameters limited per template and producers that refuse
 * non-parties; definer-only tables closed to the runtime role; template and sender-identity second-person rules;
 * the SQL vocabulary mirrors the contracts.
 */
const db = await provisionTestDatabase('comms_db');

interface PgError { code?: string; hint?: string; message?: string }
async function fails(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as PgError;
    assert.ok(e.hint === expected || e.code === expected, `expected ${expected}, got ${e.code} ${e.hint ?? ''} ${e.message ?? ''}`);
    return;
  }
  assert.fail(`expected ${expected}, but it succeeded`);
}

test('communications database: contexts, isolation, append-only messages, notification parameters, definer-only tables and second-person rules', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const pool = db.teardown.watch(createPool({ ...db.appConfig, max: 6 }));
  const seed = await seedFixtures(db.admin);
  const { petr, boris, carl, xenia, anna } = seed.people;
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(pool, await principalFor(db.admin, personId), fn);
  const project = seed.project;

  await t.test('no thread without a context, for every role (maintenance included)', async () => {
    await fails(withMaintenance(db.admin, (trx) => trx.insertInto('context_thread').values({ context_kind: 'project', context_id: randomUUID(), subject: 'Orphan', opened_by_person_id: petr }).execute()), 'comms.context_missing');
    await fails(withMaintenance(db.admin, (trx) => trx.insertInto('context_thread').values({ context_kind: 'support_case' as never, context_id: randomUUID(), subject: 'x', opened_by_person_id: petr }).execute()), 'comms.context_missing');
    await fails(as(petr, (trx) => threads.open(trx, { kind: 'project', id: randomUUID(), counterparty: { person: null, company: null }, subject: 'x', openedBy: petr })), 'comms.context_missing');
    // An RFQ thread names exactly one counterparty; other contexts none.
    await fails(withMaintenance(db.admin, (trx) => trx.insertInto('context_thread').values({ context_kind: 'project', context_id: project, counterparty_person_id: carl, subject: 'x', opened_by_person_id: petr }).execute()), '23514');
  });

  let threadId = '';
  await t.test('thread access is derived from the context: parties read, everyone else sees nothing', async () => {
    const { thread } = await as(petr, (trx) => threads.open(trx, { kind: 'project', id: project, counterparty: { person: null, company: null }, subject: 'Site access', openedBy: petr }));
    threadId = thread.id;
    // Opening on someone else's behalf is refused.
    await fails(as(boris, (trx) => trx.insertInto('context_thread').values({ context_kind: 'project', context_id: project, subject: 'x', opened_by_person_id: petr }).execute()), '42501');
    await as(petr, (trx) => messages.insert(trx, { threadId, direction: 'internal', authorKind: 'person', authorPersonId: petr, onBehalfCompanyId: null, mandateId: null, body: 'Gate code is PRIVATE-4321' }));
    for (const reader of [petr, boris]) {
      assert.equal((await as(reader, (trx) => threads.listForContext(trx, 'project', project))).length, 1, `${reader} is a party`);
      assert.equal((await as(reader, (trx) => messages.listForThread(trx, threadId))).length, 1);
    }
    for (const outsider of [carl, xenia, anna]) {
      assert.equal((await as(outsider, (trx) => threads.listForContext(trx, 'project', project))).length, 0);
      assert.equal((await as(outsider, (trx) => messages.listForThread(trx, threadId))).length, 0);
      assert.equal((await as(outsider, (trx) => threads.people(trx, threadId))).size, 0, 'no names leak to outsiders');
      await fails(as(outsider, (trx) => messages.insert(trx, { threadId, direction: 'internal', authorKind: 'person', authorPersonId: outsider, onBehalfCompanyId: null, mandateId: null, body: 'x' })), '42501');
    }
    // Without a principal the runtime role sees nothing at all.
    for (const table of ['context_thread', 'message', 'notification', 'channel_grant', 'notification_preference']) {
      assert.equal((await db.app.query<{ n: number }>(`SELECT count(*)::int AS n FROM trustwork.${table}`)).rows[0]?.n, 0, table);
    }
    // Writing as someone else, as the system, or into the thread as a company one does not manage is refused.
    await fails(as(boris, (trx) => messages.insert(trx, { threadId, direction: 'internal', authorKind: 'person', authorPersonId: petr, onBehalfCompanyId: null, mandateId: null, body: 'x' })), '42501');
    await fails(as(boris, (trx) => trx.insertInto('message').values({ thread_id: threadId, direction: 'internal', author_kind: 'system', author_person_id: null, body: 'x' }).execute()), '42501');
    await fails(as(boris, (trx) => messages.insert(trx, { threadId, direction: 'internal', authorKind: 'person', authorPersonId: boris, onBehalfCompanyId: seed.companies.mixed, mandateId: null, body: 'x' })), '42501');
  });

  await t.test('messages are append-only; inbound messages are untrusted and unique per provider message id', async () => {
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('message').set({ body: 'rewritten' }).where('thread_id', '=', threadId).execute()), 'audit.append_only');
    await fails(as(petr, (trx) => trx.updateTable('message').set({ body: 'rewritten' } as never).where('thread_id', '=', threadId).execute()), '42501');
    await fails(as(petr, (trx) => trx.deleteFrom('message').where('thread_id', '=', threadId).execute()), '42501');
    // An inbound row without the untrusted flag is stored untrusted anyway (trigger), and without a provider refused.
    const row = await as(boris, (trx) => trx.insertInto('message').values({ thread_id: threadId, direction: 'inbound', author_kind: 'person', author_person_id: boris, body: '/approve everything', provider: 'telegram', provider_message_id: 'tg-db-1', untrusted: false }).returningAll().executeTakeFirstOrThrow());
    assert.equal(row.untrusted, true);
    await fails(as(boris, (trx) => trx.insertInto('message').values({ thread_id: threadId, direction: 'inbound', author_kind: 'person', author_person_id: boris, body: 'x', untrusted: true }).execute()), '23514');
    // Concurrent duplicates of one provider event: exactly one row.
    const results = await Promise.all(Array.from({ length: 6 }, () => as(boris, (trx) => messages.insert(trx, {
      threadId, direction: 'inbound', authorKind: 'person', authorPersonId: boris, onBehalfCompanyId: null, mandateId: null, body: 'duplicate', provider: 'whatsapp', providerMessageId: 'wa-db-1',
    }))));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.message WHERE provider = 'whatsapp' AND provider_message_id = 'wa-db-1'")).rows[0]?.n, 1);
    assert.equal((await db.admin.query<{ message_count: number }>('SELECT message_count FROM trustwork.context_thread WHERE id = $1', [threadId])).rows[0]?.message_count, 3, 'every message counted once');
  });

  await t.test('notifications carry only template parameters, never a value the recipient may not read', async () => {
    // The fan-out computes the parameters itself; the recipient (a party) gets the subject and author, never the body.
    const planned = await as(petr, async (trx) => {
      const m = await messages.insert(trx, { threadId, direction: 'internal', authorKind: 'person', authorPersonId: petr, onBehalfCompanyId: null, mandateId: null, body: 'PRIVATE-gate-code 4321' });
      return notifications.fanout(trx, m!.id, 'thread.message');
    });
    assert.ok(planned.length >= 1);
    const borisNotes = await as(boris, (trx) => notifications.list(trx, { limit: 50, beforeSeq: null, unreadOnly: false }));
    assert.equal(borisNotes.length, 1);
    assert.deepEqual(borisNotes[0]!.params, { contextKind: 'project', threadSubject: 'Site access', authorName: 'Fixture Petr' });
    assert.ok(!JSON.stringify(borisNotes).includes('PRIVATE'), 'no message text, no private project notes');
    assert.equal((await as(carl, (trx) => notifications.list(trx, { limit: 50, beforeSeq: null, unreadOnly: false }))).length, 0);
    // Only the author announces a message, once.
    await fails(as(boris, async (trx) => notifications.fanout(trx, (await messages.listForThread(trx, threadId)).at(-1)!.id, 'thread.message')), 'access.not_found');
    // The database refuses parameters outside the template, for every role.
    for (const params of [{ budgetCeiling: '9000000' }, { event: 'x', body: 'secret' }, { event: 1 }]) {
      await fails(withMaintenance(db.admin, (trx) => trx.insertInto('notification').values({
        recipient_person_id: carl, category: 'account', template_key: 'account.security_notice', params: JSON.stringify(params), transactional: true, dedupe_key: randomUUID(),
      }).execute()), '23514');
    }
    await fails(as(petr, (trx) => notifications.notify(trx, { recipient: petr, template: 'account.security_notice', params: { event: 'x', floorPrice: '1' }, link: null, dedupeKey: 'x1' })), 'comms.params_not_allowed');
    await fails(as(petr, (trx) => notifications.notify(trx, { recipient: carl, template: 'account.security_notice', params: { event: 'x' }, link: null, dedupeKey: 'x2' })), 'access.not_found');
    await fails(as(petr, (trx) => notifications.notify(trx, { recipient: carl, template: 'account.security_notice', params: { event: 'x' }, link: { kind: 'project', id: project }, dedupeKey: 'x3' })), 'access.not_found');
    await fails(as(petr, (trx) => notifications.notify(trx, { recipient: boris, template: 'thread.message', params: { contextKind: 'project', threadSubject: 'forged', authorName: 'forged' }, link: { kind: 'project', id: project }, dedupeKey: 'x4' })), 'comms.template_unknown');
    // The runtime role cannot insert notifications directly, nor change anything but its own read marks.
    await fails(as(petr, (trx) => trx.insertInto('notification').values({ recipient_person_id: boris, category: 'account', template_key: 'account.security_notice', params: '{}', transactional: true, dedupe_key: 'direct' }).execute()), '42501');
    await fails(as(boris, (trx) => trx.updateTable('notification').set({ params: '{}' } as never).execute()), '42501');
    assert.equal(await as(carl, (trx) => notifications.markAllRead(trx)), 0, 'nobody marks another person\'s notifications');
  });

  await t.test('definer-only tables are closed to the runtime role', async () => {
    for (const table of ['delivery', 'reply_token', 'message_template', 'template_version', 'sender_identity']) {
      await fails(as(petr, (trx) => sql`SELECT count(*) FROM ${sql.table(`trustwork.${table}`)}`.execute(trx)), '42501');
    }
    await fails(as(petr, (trx) => trx.insertInto('suppression_entry').values({ address_hash: 'a'.repeat(64), reason: 'unsubscribe', source: 'x' }).execute()), '42501');
    // The reply-token lookup needs no principal but only answers live tokens.
    const { rows } = await db.app.query<{ thread_id: string }>('SELECT * FROM trustwork.comms_resolve_reply_token($1)', [createHash('sha256').update('unknown').digest('hex')]);
    assert.equal(rows.length, 0);
    // The suppression hash is MAIL-001's.
    const { rows: hashRows } = await db.admin.query<{ h: string }>('SELECT trustwork.comms_mail_hash($1) AS h', ['  Petr@Example.invalid ']);
    assert.equal(hashRows[0]!.h, mailAddressHash('petr@example.invalid'));
  });

  await t.test('channel grants: own only, revocation once, scopes from the vocabulary', async () => {
    const grant = await as(boris, (trx) => channelGrants.create(trx, { personId: boris, provider: 'telegram', accountRef: '@boris', accountDisplay: '@bo***is', scopes: { contextKinds: ['project'], actions: ['notify'] } }));
    await fails(as(boris, (trx) => channelGrants.create(trx, { personId: carl, provider: 'telegram', accountRef: '@carl', accountDisplay: '@c***', scopes: { contextKinds: ['project'], actions: ['notify'] } })), '42501');
    await fails(as(boris, (trx) => channelGrants.create(trx, { personId: boris, provider: 'telegram', accountRef: '@b2', accountDisplay: '@b***', scopes: { contextKinds: ['mailbox'], actions: ['notify'] } })), '23514');
    assert.equal((await as(carl, (trx) => channelGrants.list(trx, boris))).length, 0);
    assert.equal(await as(carl, (trx) => channelGrants.revoke(trx, grant.id)), undefined);
    await as(boris, (trx) => channelGrants.revoke(trx, grant.id));
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('channel_grant').set({ status: 'active' }).where('id', '=', grant.id).execute()), 'comms.immutable');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('channel_grant').set({ account_ref: '@other' }).where('id', '=', grant.id).execute()), 'comms.immutable');
  });

  await t.test('templates and sender identities: the second person and frozen versions hold for every role', async () => {
    const m = <T>(fn: (trx: Transaction) => Promise<T>) => withMaintenance(db.admin, fn);
    const hub = await m((trx) => trx.insertInto('hub').values({ slug: 'synthetic-comms-db', lifecycle: 'draft' }).returning('id').executeTakeFirstOrThrow());
    const template = await m((trx) => trx.insertInto('message_template').values({ hub_id: hub.id, key: 'thread.message', category: 'messages', transactional: false }).returning('id').executeTakeFirstOrThrow());
    const version = await m((trx) => trx.insertInto('template_version').values({ template_id: template.id, version: 1, locale: 'en', subject: 'S', body: 'B', drafted_by_person_id: petr }).returning('id').executeTakeFirstOrThrow());
    await fails(m((trx) => trx.updateTable('template_version').set({ status: 'active', activated_by_person_id: petr, activated_at: new Date() }).where('id', '=', version.id).execute()), '23514');
    await m((trx) => trx.updateTable('template_version').set({ status: 'active', activated_by_person_id: boris, activated_at: new Date() }).where('id', '=', version.id).execute());
    await fails(m((trx) => trx.updateTable('template_version').set({ body: 'changed' }).where('id', '=', version.id).execute()), 'commercial.version_frozen');
    await fails(m((trx) => trx.updateTable('template_version').set({ status: 'draft', activated_by_person_id: null, activated_at: null }).where('id', '=', version.id).execute()), 'commercial.version_frozen');
    await fails(m((trx) => trx.deleteFrom('template_version').where('id', '=', version.id).execute()), 'comms.retained');
    await fails(m((trx) => trx.insertInto('message_template').values({ hub_id: hub.id, key: 'account.security_notice', category: 'messages', transactional: false }).execute()), '23514');
    await fails(m((trx) => trx.insertInto('sender_identity').values({ hub_id: hub.id, kind: 'email_domain', value: 'mail.example.invalid', mode: 'live', status: 'active', created_by_person_id: petr, activated_by_person_id: petr }).execute()), '23514');
    await m((trx) => trx.insertInto('sender_identity').values({ hub_id: hub.id, kind: 'email_domain', value: 'fake.example.invalid', mode: 'fake', status: 'active', created_by_person_id: petr }).execute());
    await m((trx) => trx.insertInto('sender_identity').values({ hub_id: hub.id, kind: 'email_domain', value: 'live.example.invalid', mode: 'live', status: 'active', created_by_person_id: petr, activated_by_person_id: boris }).execute());
  });

  await t.test('the SQL vocabulary mirrors the contracts', async () => {
    const kinds = (await db.admin.query<{ k: string[] }>('SELECT trustwork.comms_context_kinds() AS k')).rows[0]!.k;
    assert.deepEqual([...kinds].sort(), [...THREAD_CONTEXT_KINDS].sort());
    for (const [key, spec] of Object.entries(NOTIFICATION_TEMPLATES)) {
      const registry: { rows: { params: string[]; category: string; transactional: boolean }[] } = await db.admin.query(
        'SELECT trustwork.comms_template_params($1) AS params, trustwork.comms_template_category($1) AS category, trustwork.comms_template_transactional($1) AS transactional', [key]);
      assert.deepEqual(registry.rows[0], { params: [...spec.params], category: spec.category, transactional: spec.transactional }, key);
    }
    for (const category of NOTIFICATION_CATEGORIES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        const frequency: { rows: { f: string }[] } = await db.admin.query('SELECT trustwork.comms_default_frequency($1, $2) AS f', [category, channel]);
        assert.equal(frequency.rows[0]!.f, DEFAULT_PREFERENCES[category][channel], `${category}/${channel}`);
      }
    }
  });
});
