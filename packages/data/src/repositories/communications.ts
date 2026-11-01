import { sql } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type {
  ChannelGrantRow, ChannelProviderValue, ContextThreadRow, MessageDirectionValue, MessageLinkRow, MessageRow, NotificationCategoryValue, NotificationChannelValue,
  NotificationFrequencyValue, NotificationPreferenceRow, NotificationRow, TemplateVersionRow, ThreadContextKindValue,
} from '../schema/communications.js';

/**
 * Communications repository (COMMS-001). Thin typed access under `withPrincipal`: RLS decides who reads a thread (the
 * live parties of its context), who writes into it and who reads a notification; the definers in
 * packages/data/migrations/communications compute notification parameters themselves, plan deliveries, enqueue mail
 * through MAIL-001 and govern templates. Nothing here builds a list without a context (no generic inbox).
 */
const json = (value: unknown): string => JSON.stringify(value);
const first = <T>(rows: T[]): T | undefined => rows[0];

export type ThreadSideValue = 'owner' | 'counterparty' | 'participant';
/** A delivery the API still has to act on (render and enqueue mail, or dispatch through a channel adapter). */
export interface PlannedDelivery {
  delivery_id: string;
  notification_id: string;
  recipient_person_id: string;
  channel: 'email' | 'messenger' | 'sms';
  provider: string;
  channel_grant_id: string | null;
  /** Handle for the adapter (never logged, never returned to clients). */
  account_ref: string | null;
  languages: string[];
  template_key: string;
  params: Record<string, string>;
  transactional: boolean;
  link_kind: ThreadContextKindValue | null;
  link_id: string | null;
  link_thread_id: string | null;
}

/* ---------- Contexts and threads ---------- */

export const commsContexts = {
  /** The caller's side of a context, or null (not a party, or no such context). */
  async mySide(trx: Transaction, kind: string, id: string): Promise<ThreadSideValue | null> {
    const { rows } = await sql<{ side: ThreadSideValue | null }>`SELECT trustwork.comms_my_side(${kind}, ${id}::uuid) AS side`.execute(trx);
    return rows[0]?.side ?? null;
  },
};

export const threads = {
  listForContext(trx: Transaction, kind: ThreadContextKindValue, id: string): Promise<ContextThreadRow[]> {
    return trx.selectFrom('context_thread').selectAll().where('context_kind', '=', kind).where('context_id', '=', id).orderBy('created_at').orderBy('id').execute();
  },
  getById(trx: Transaction, id: string): Promise<ContextThreadRow | undefined> {
    return trx.selectFrom('context_thread').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** The one thread of a context (and counterparty), visible to the caller. */
  findOne(trx: Transaction, kind: ThreadContextKindValue, id: string, counterparty: { person: string | null; company: string | null }): Promise<ContextThreadRow | undefined> {
    let q = trx.selectFrom('context_thread').selectAll().where('context_kind', '=', kind).where('context_id', '=', id);
    q = counterparty.person === null ? q.where('counterparty_person_id', 'is', null) : q.where('counterparty_person_id', '=', counterparty.person);
    q = counterparty.company === null ? q.where('counterparty_company_id', 'is', null) : q.where('counterparty_company_id', '=', counterparty.company);
    return q.executeTakeFirst();
  },
  /**
   * Opens the thread of a context, or returns the existing one (one conversation per context and counterparty; two
   * concurrent openings meet on the unique constraint). RLS refuses a caller who is not a party.
   */
  async open(trx: Transaction, input: { kind: ThreadContextKindValue; id: string; counterparty: { person: string | null; company: string | null }; subject: string; openedBy: string }): Promise<{ thread: ContextThreadRow; created: boolean }> {
    const inserted = await trx.insertInto('context_thread').values({
      context_kind: input.kind, context_id: input.id, counterparty_person_id: input.counterparty.person, counterparty_company_id: input.counterparty.company,
      subject: input.subject, opened_by_person_id: input.openedBy,
    }).onConflict((oc) => oc.constraint('context_thread_one_per_context').doNothing()).returningAll().executeTakeFirst();
    if (inserted) return { thread: inserted, created: true };
    const existing = await threads.findOne(trx, input.kind, input.id, input.counterparty);
    if (!existing) throw new Error('thread conflict without a visible thread');
    return { thread: existing, created: false };
  },
  /** Display names of the people who appear in a readable thread. */
  async people(trx: Transaction, threadId: string): Promise<Map<string, string>> {
    const { rows } = await sql<{ person_id: string; display_name: string }>`SELECT * FROM trustwork.comms_thread_people(${threadId}::uuid)`.execute(trx);
    return new Map(rows.map((r) => [r.person_id, r.display_name]));
  },
};

/* ---------- Messages ---------- */

export interface NewMessage {
  threadId: string;
  direction: Extract<MessageDirectionValue, 'internal' | 'inbound'>;
  authorKind: 'person' | 'agent';
  authorPersonId: string;
  onBehalfCompanyId: string | null;
  mandateId: string | null;
  body: string;
  sourceTime?: Date;
  provider?: ChannelProviderValue | null;
  providerMessageId?: string | null;
  channelGrantId?: string | null;
  senderClaim?: string | null;
}

export const messages = {
  /** Inserts one message; an inbound duplicate `(provider, providerMessageId)` returns undefined and inserts nothing. */
  insert(trx: Transaction, input: NewMessage): Promise<MessageRow | undefined> {
    const query = trx.insertInto('message').values({
      thread_id: input.threadId, direction: input.direction, author_kind: input.authorKind, author_person_id: input.authorPersonId, on_behalf_person_id: null,
      on_behalf_company_id: input.onBehalfCompanyId, mandate_id: input.mandateId, body: input.body, attachments: '[]', source_time: input.sourceTime ?? new Date(),
      provider: input.provider ?? null, provider_message_id: input.providerMessageId ?? null, channel_grant_id: input.channelGrantId ?? null, sender_claim: input.senderClaim ?? null,
      untrusted: input.direction === 'inbound',
    });
    return (input.provider ? query.onConflict((oc) => oc.constraint('message_provider_unique').doNothing()) : query).returningAll().executeTakeFirst();
  },
  listForThread(trx: Transaction, threadId: string, limit = 200): Promise<MessageRow[]> {
    return trx.selectFrom('message').selectAll().where('thread_id', '=', threadId).orderBy('seq', 'desc').limit(limit).execute().then((rows) => rows.reverse());
  },
  async addLinks(trx: Transaction, messageId: string, links: { kind: string; id: string; versionId: string | null }[]): Promise<void> {
    if (!links.length) return;
    await trx.insertInto('message_link').values(links.map((l) => ({ message_id: messageId, object_kind: l.kind, object_id: l.id, version_id: l.versionId }))).execute();
  },
  linksFor(trx: Transaction, messageIds: string[]): Promise<MessageLinkRow[]> {
    if (!messageIds.length) return Promise.resolve([]);
    return trx.selectFrom('message_link').selectAll().where('message_id', 'in', messageIds).orderBy('created_at').orderBy('id').execute();
  },
};

/* ---------- Notifications and deliveries ---------- */

export const notifications = {
  /** Tells every other party of the thread about a message the caller wrote; returns the deliveries to act on. */
  async fanout(trx: Transaction, messageId: string, template: 'thread.opened' | 'thread.message'): Promise<PlannedDelivery[]> {
    const { rows } = await sql<PlannedDelivery>`SELECT * FROM trustwork.comms_fanout_message(${messageId}::uuid, ${template})`.execute(trx);
    return rows;
  },
  /** Producer for other modules: one notification of a non-thread template (parameters checked by the database). */
  async notify(trx: Transaction, input: { recipient: string; template: string; params: Record<string, string>; link: { kind: ThreadContextKindValue; id: string } | null; dedupeKey: string }): Promise<PlannedDelivery[]> {
    const { rows } = await sql<PlannedDelivery>`SELECT * FROM trustwork.comms_notify(${input.recipient}::uuid, ${input.template}, ${json(input.params)}::jsonb, ${input.link?.kind ?? null}, ${input.link?.id ?? null}::uuid, ${input.dedupeKey})`.execute(trx);
    return rows;
  },
  /** The caller's notifications, newest first (seq cursor), filtered by RLS to contexts the caller is still part of. */
  list(trx: Transaction, input: { limit: number; beforeSeq: string | null; unreadOnly: boolean }): Promise<NotificationRow[]> {
    let q = trx.selectFrom('notification').selectAll().where('dismissed_at', 'is', null);
    if (input.beforeSeq !== null) q = q.where('seq', '<', input.beforeSeq as never);
    if (input.unreadOnly) q = q.where('read_at', 'is', null);
    return q.orderBy('seq', 'desc').limit(input.limit).execute();
  },
  async unreadCount(trx: Transaction): Promise<number> {
    const row = await trx.selectFrom('notification').select((eb) => eb.fn.countAll<string>().as('n')).where('read_at', 'is', null).where('dismissed_at', 'is', null).executeTakeFirstOrThrow();
    return Number(row.n);
  },
  getById(trx: Transaction, id: string): Promise<NotificationRow | undefined> {
    return trx.selectFrom('notification').selectAll().where('id', '=', id).executeTakeFirst();
  },
  async markRead(trx: Transaction, id: string): Promise<NotificationRow | undefined> {
    return trx.updateTable('notification').set({ read_at: sql`now()` }).where('id', '=', id).returningAll().executeTakeFirst();
  },
  async markAllRead(trx: Transaction): Promise<number> {
    const result = await trx.updateTable('notification').set({ read_at: sql`now()` }).where('read_at', 'is', null).executeTakeFirst();
    return Number(result.numUpdatedRows);
  },
};

export const deliveries = {
  /** Enqueues one planned e-mail through MAIL-001; returns the delivery state (`queued`, `suppressed` or `skipped`). */
  async enqueueMail(trx: Transaction, input: { deliveryId: string; locale: string; subject: string; body: string; path: string }): Promise<'queued' | 'suppressed' | 'skipped'> {
    const { rows } = await sql<{ state: 'queued' | 'suppressed' | 'skipped' }>`SELECT trustwork.comms_enqueue_mail(${input.deliveryId}::uuid, ${input.locale}, ${input.subject}, ${input.body}, ${input.path}) AS state`.execute(trx);
    return rows[0]!.state;
  },
  async settle(trx: Transaction, input: { deliveryId: string; state: 'sent' | 'failed' | 'outcome_unknown' | 'skipped'; providerRef: string | null; reason: string | null }): Promise<string> {
    const { rows } = await sql<{ state: string }>`SELECT trustwork.comms_settle_delivery(${input.deliveryId}::uuid, ${input.state}, ${input.providerRef}, ${input.reason}) AS state`.execute(trx);
    return rows[0]!.state;
  },
  async issueReplyToken(trx: Transaction, input: { deliveryId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await sql`SELECT trustwork.comms_issue_reply_token(${input.deliveryId}::uuid, ${input.tokenHash}, ${input.expiresAt.toISOString()}::timestamptz)`.execute(trx);
  },
  /** Pre-identity lookup (no principal): the thread and person a live reply token belongs to. */
  async resolveReplyToken(pool: DataPool, tokenHash: string): Promise<{ thread_id: string; person_id: string; authz_epoch: number; channel_grant_id: string | null; provider: string } | undefined> {
    const { rows } = await pool.query<{ thread_id: string; person_id: string; authz_epoch: number; channel_grant_id: string | null; provider: string }>(
      'SELECT * FROM trustwork.comms_resolve_reply_token($1)', [tokenHash]);
    return first(rows);
  },
  async counts(trx: Transaction, hubId: string): Promise<{ channel: string; state: string; n: number }[]> {
    const { rows } = await sql<{ channel: string; state: string; n: number }>`SELECT * FROM trustwork.comms_delivery_counts(${hubId}::uuid)`.execute(trx);
    return rows;
  },
};

export const mailSuppression = {
  async unsubscribe(trx: Transaction): Promise<boolean> {
    const { rows } = await sql<{ added: boolean }>`SELECT trustwork.comms_mail_unsubscribe() AS added`.execute(trx);
    return rows[0]?.added ?? false;
  },
  async mine(trx: Transaction): Promise<string | null> {
    const { rows } = await sql<{ reason: string | null }>`SELECT trustwork.comms_mail_suppression() AS reason`.execute(trx);
    return rows[0]?.reason ?? null;
  },
};

/* ---------- Preferences and channel grants ---------- */

export const notificationPreferences = {
  list(trx: Transaction, personId: string): Promise<NotificationPreferenceRow[]> {
    return trx.selectFrom('notification_preference').selectAll().where('person_id', '=', personId).execute();
  },
  async set(trx: Transaction, input: { personId: string; category: NotificationCategoryValue; channel: NotificationChannelValue; frequency: NotificationFrequencyValue }): Promise<void> {
    await trx.insertInto('notification_preference').values({ person_id: input.personId, category: input.category, channel: input.channel, frequency: input.frequency })
      .onConflict((oc) => oc.columns(['person_id', 'category', 'channel']).doUpdateSet({ frequency: input.frequency, updated_at: sql`now()` })).execute();
  },
};

export const channelGrants = {
  list(trx: Transaction, personId: string): Promise<ChannelGrantRow[]> {
    return trx.selectFrom('channel_grant').selectAll().where('person_id', '=', personId).orderBy('granted_at').orderBy('id').execute();
  },
  create(trx: Transaction, input: { personId: string; provider: ChannelProviderValue; accountRef: string; accountDisplay: string; scopes: { contextKinds: string[]; actions: string[] } }): Promise<ChannelGrantRow> {
    return trx.insertInto('channel_grant').values({ person_id: input.personId, provider: input.provider, account_ref: input.accountRef, account_display: input.accountDisplay, scopes: json(input.scopes) })
      .returningAll().executeTakeFirstOrThrow();
  },
  revoke(trx: Transaction, id: string): Promise<ChannelGrantRow | undefined> {
    return trx.updateTable('channel_grant').set({ status: 'revoked' }).where('id', '=', id).where('status', '=', 'active').returningAll().executeTakeFirst();
  },
  getById(trx: Transaction, id: string): Promise<ChannelGrantRow | undefined> {
    return trx.selectFrom('channel_grant').selectAll().where('id', '=', id).executeTakeFirst();
  },
};

/* ---------- Templates ---------- */

export const messageTemplates = {
  async draft(trx: Transaction, input: { hubId: string; key: string; version: number; locale: string; subject: string; body: string }): Promise<TemplateVersionRow> {
    const { rows } = await sql<TemplateVersionRow>`SELECT * FROM trustwork.comms_template_draft(${input.hubId}::uuid, ${input.key}, ${input.version}::int, ${input.locale}, ${input.subject}, ${input.body})`.execute(trx);
    return rows[0]!;
  },
  async activate(trx: Transaction, input: { hubId: string; key: string; version: number; requiredLocales: readonly string[]; reason: string }): Promise<TemplateVersionRow[]> {
    const { rows } = await sql<TemplateVersionRow>`SELECT * FROM trustwork.comms_template_activate(${input.hubId}::uuid, ${input.key}, ${input.version}::int, ${[...input.requiredLocales]}::text[], ${input.reason})`.execute(trx);
    return rows;
  },
  async versions(trx: Transaction, hubId: string, key: string): Promise<TemplateVersionRow[]> {
    const { rows } = await sql<TemplateVersionRow>`SELECT * FROM trustwork.comms_template_versions(${hubId}::uuid, ${key})`.execute(trx);
    return rows;
  },
  async active(trx: Transaction, hubId: string, key: string): Promise<{ locale: string; version: number; subject: string; body: string }[]> {
    const { rows } = await sql<{ locale: string; version: number; subject: string; body: string }>`SELECT * FROM trustwork.comms_active_template(${hubId}::uuid, ${key})`.execute(trx);
    return rows;
  },
  async isStaff(trx: Transaction, hubId: string): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`SELECT trustwork.comms_template_staff(${hubId}::uuid) AS ok`.execute(trx);
    return rows[0]?.ok ?? false;
  },
};

/** Worker-only consultation producer. SQL derives the context and recipients from the booked agreement. */
export const consultationCommunications = {
  async reconcileChannels(trx: Transaction): Promise<number> {
    return (await sql<{ n: number }>`SELECT trustwork.comms_consultation_channel_reconcile() AS n`.execute(trx)).rows[0]!.n;
  },
  async mailHub(trx: Transaction, id: string): Promise<string | null> {
    return (await sql<{ hub: string | null }>`SELECT trustwork.comms_consultation_mail_hub(${id}::uuid) AS hub`.execute(trx)).rows[0]?.hub ?? null;
  },
  async forHub(trx: Transaction, id: string, kind: 'reminder' | 'mail' | 'channel', hubId: string | null): Promise<boolean> {
    return (await sql<{ ok: boolean }>`SELECT trustwork.comms_consultation_for_hub(${id}::uuid,${kind},${hubId}::uuid) AS ok`.execute(trx)).rows[0]?.ok === true;
  },
  async due(trx: Transaction, hubId: string): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`SELECT trustwork.comms_consultation_due(${hubId}::uuid) AS id`.execute(trx);
    return rows.map((r) => r.id);
  },
  async templates(trx: Transaction, hubId: string): Promise<{ locale: string; subject: string; body: string }[]> {
    return (await sql<{ locale: string; subject: string; body: string }>`SELECT * FROM trustwork.comms_consultation_templates(${hubId}::uuid)`.execute(trx)).rows;
  },
  async produce(trx: Transaction, reminderId: string, hubId: string, body: string): Promise<PlannedDelivery[]> {
    return (await sql<PlannedDelivery>`SELECT * FROM trustwork.comms_produce_consultation_reminder(${reminderId}::uuid,${hubId}::uuid,${body})`.execute(trx)).rows;
  },
  async enqueueMail(trx: Transaction, id: string, locale: string, subject: string, body: string): Promise<string> {
    return (await sql<{ state: string }>`SELECT trustwork.comms_consultation_enqueue_mail(${id}::uuid,${locale},${subject},${body},'/app/notifications') AS state`.execute(trx)).rows[0]!.state;
  },
  async mailAllowed(trx: Transaction, id: string, hubId: string | null): Promise<boolean> {
    return (await sql<{ ok: boolean }>`SELECT trustwork.comms_consultation_mail_allowed(${id}::uuid,${hubId}::uuid) AS ok`.execute(trx)).rows[0]?.ok === true;
  },
  async channelJob(trx: Transaction, id: string, job: string): Promise<void> {
    await sql`SELECT trustwork.comms_consultation_channel_job(${id}::uuid,${job}::uuid)`.execute(trx);
  },
  async claimChannel(trx: Transaction, id: string, job: string, fence: string, hubId: string): Promise<{ deliveryId: string; provider: string; account: string; languages: string[] } | null> {
    const { rows } = await sql<{ value: { deliveryId: string; provider: string; account: string; languages: string[] } | null }>`SELECT trustwork.comms_consultation_channel_claim(${id}::uuid,${job}::uuid,${fence}::bigint,${hubId}::uuid) AS value`.execute(trx);
    return rows[0]?.value ?? null;
  },
  async settleChannel(trx: Transaction, id: string, job: string, fence: string, state: 'sent' | 'failed' | 'outcome_unknown' | 'skipped', ref: string | null): Promise<void> {
    await sql`SELECT trustwork.comms_consultation_channel_settle(${id}::uuid,${job}::uuid,${fence}::bigint,${state},${ref})`.execute(trx);
  },
};
