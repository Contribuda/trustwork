import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { adminSetup, staffRoleDefinitions } from '../../../../packages/data/src/repositories/admin.js';
import { ENGINE_TEMPLATE_LANGUAGES } from '../../../../packages/contracts/src/communications.js';
import type { Response } from '../../helpers/app.js';
import type { CrashCase } from '../cases.js';

/**
 * COMMS-001: every communications route completes its idempotency record in its own transaction. Hub staff for the
 * template routes get synthetic `editor` and `data-steward` roles at a synthetic hub (assigned through the
 * maintenance path by the founding platform owner, or bootstrapped when the file runs alone). Anna and boris are left
 * alone: earlier cases enrol them in a second factor. Carl joins the project as a participant to receive notifications.
 */
export default {
  name: 'COMMS-001: threads, notifications, preferences, channel grants and templates',
  async run({ h, seed, as, exactlyOnce }) {
    const n = async (query: string, params: unknown[] = []) => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]!.n;
    const body = <T>(r: Response): T => {
      assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body));
      return r.body as T;
    };
    const [petr, carl, xenia] = [await as('petr'), await as('carl'), await as('xenia')];
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('object_participation').values({
      resource_kind: 'project', resource_id: seed.project, party_person_id: seed.people.carl, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party',
      valid_from: new Date(Date.now() - 60_000), granted_by_person_id: seed.people.petr,
    }).execute());
    const message = (text: string) => ({ body: text, links: [], onBehalfOfCompany: false, actor: { via: 'person' } });

    const thread = body<{ thread: { id: string } }>(await exactlyOnce({
      action: 'comms.thread_open', client: petr, url: '/v1/threads',
      body: { context: { kind: 'project', id: seed.project }, subject: 'Exactly once thread', counterparty: null, message: message('first') },
      effects: () => n('SELECT 1 FROM trustwork.context_thread WHERE context_id = $1', [seed.project]),
    })).thread;
    await exactlyOnce({ action: 'comms.message_post', client: petr, url: `/v1/threads/${thread.id}/messages`, body: message('second'), effects: () => n('SELECT 1 FROM trustwork.message WHERE thread_id = $1', [thread.id]) });
    const unread = () => n('SELECT 1 FROM trustwork.notification WHERE recipient_person_id = $1 AND read_at IS NOT NULL', [seed.people.carl]);
    const notes = body<{ items: { id: string }[] }>(await carl.get('/v1/notifications'));
    assert.ok(notes.items.length >= 2, 'carl hears about both messages');
    await exactlyOnce({ action: 'comms.notification_read', client: carl, url: `/v1/notifications/${notes.items[0]!.id}/read`, effects: unread });
    await exactlyOnce({ action: 'comms.notification_read_all', client: carl, url: '/v1/notifications/read-all', effects: async () => (await unread()) >= notes.items.length ? 1 : 0 });
    await exactlyOnce({ action: 'comms.preference_set', client: petr, url: '/v1/me/notification-preferences', body: { category: 'projects', channel: 'email', frequency: 'weekly' },
      effects: () => n("SELECT 1 FROM trustwork.notification_preference WHERE person_id = $1 AND frequency = 'weekly'", [seed.people.petr]) });
    await exactlyOnce({ action: 'comms.mail_unsubscribe', client: petr, url: '/v1/me/mail-unsubscribe', effects: () => n("SELECT 1 FROM trustwork.suppression_entry WHERE reason = 'unsubscribe'") });
    const grant = body<{ id: string }>(await exactlyOnce({
      action: 'comms.channel_grant_create', client: carl, url: '/v1/me/channel-grants', body: { provider: 'telegram', account: '@carl_once', scopes: { contextKinds: ['project'], actions: ['notify'] } },
      effects: () => n('SELECT 1 FROM trustwork.channel_grant WHERE person_id = $1', [seed.people.carl]),
    }));
    await exactlyOnce({ action: 'comms.channel_grant_revoke', client: carl, url: `/v1/me/channel-grants/${grant.id}/revoke`, effects: () => n("SELECT 1 FROM trustwork.channel_grant WHERE status = 'revoked'") });

    // Hub staff for the template routes.
    const hubId = randomUUID();
    await withMaintenance(h.db.admin, async (trx) => {
      await trx.insertInto('hub').values({ id: hubId, slug: `crash-comms-${hubId.slice(0, 8)}`, lifecycle: 'draft' }).execute();
      for (const [role, permissions] of [['editor', ['admin.notifications.template.edit']], ['data-steward', ['admin.config.edit']]] as const) {
        const latest = await trx.selectFrom('staff_role_definition_version').select((eb) => eb.fn.max('version').as('v')).where('role', '=', role).executeTakeFirst();
        await staffRoleDefinitions.release(trx, { version: Number(latest?.v ?? 0) + 1, role, scopes: ['hub'], permissions: [...permissions], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
      }
      const version = async (role: 'editor' | 'data-steward') => Number((await trx.selectFrom('staff_role_definition_version').select((eb) => eb.fn.max('version').as('v')).where('role', '=', role).executeTakeFirstOrThrow()).v);
      const grantor = await trx.selectFrom('staff_role_assignment').select('person_id').where('role', '=', 'platform-owner').where('revoked_at', 'is', null).executeTakeFirst();
      for (const [person, role] of [[seed.people.carl, 'editor'], [seed.people.xenia, 'data-steward']] as const) {
        if (grantor) {
          await trx.insertInto('staff_role_assignment').values({ person_id: person, role, scope_kind: 'hub', hub_id: hubId, definition_version: await version(role), granted_by: grantor.person_id, reason: 'Synthetic crash test' }).execute();
        } else {
          await adminSetup.bootstrapFirstAdmin(trx, { personId: person, role, scope: { kind: 'hub', hubId }, definitionVersion: await version(role), reason: 'Synthetic crash test' });
        }
      }
    });
    const T = `/v1/hubs/${hubId}/message-templates/thread.message`;
    const text = { subject: '{authorName}: {threadSubject}', body: 'New message about {contextKind}.' };
    await exactlyOnce({ action: 'comms.template_draft', client: carl, url: `${T}/drafts`, body: { version: 1, locale: 'en', ...text }, effects: () => n('SELECT 1 FROM trustwork.template_version v JOIN trustwork.message_template t ON t.id = v.template_id WHERE t.hub_id = $1', [hubId]) });
    for (const locale of ENGINE_TEMPLATE_LANGUAGES.filter((l) => l !== 'en')) body(await carl.post(`${T}/drafts`, { version: 1, locale, ...text }));
    await exactlyOnce({ action: 'comms.template_activate', client: xenia, url: `${T}/versions/1/activate`, body: { reason: 'Synthetic crash test' },
      effects: () => n("SELECT 1 FROM trustwork.audit_event WHERE action = 'comms.template_activated' AND basis ->> 'key' = 'thread.message' AND object_id IN (SELECT id::text FROM trustwork.message_template WHERE hub_id = $1)", [hubId]) });
  },
} satisfies CrashCase;
