import { createHash, randomBytes } from 'node:crypto';
import {
  ChannelGrantListSchema, ChannelGrantSchema, contextPath, DEFAULT_PREFERENCES, IntakeResultSchema, MessageSchema, NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS, NOTIFICATION_TEMPLATES,
  NotificationPageSchema, NotificationPreferencesSchema, NotificationSchema, maskAccount, renderTemplateText, templatePlaceholderProblems, TemplateVersionListSchema, TemplateVersionSchema,
  ThreadListSchema, ThreadSchema, ThreadViewSchema, TRANSACTIONAL_CATEGORIES, DeliveryCountsSchema,
  type ActivateTemplateVersionCommand, type ChannelGrant, type CreateChannelGrantCommand, type DraftTemplateVersionCommand, type InboundMessageEvent, type IntakeResult, type Message,
  type Notification, type NotificationPage, type NotificationPreferences, type NotificationTemplateKey, type OpenThreadCommand, type PostMessageCommand, type Principal,
  type SetNotificationPreferenceCommand, type Thread, type ThreadContextKind, type ThreadContextRef, type ThreadList, type ThreadView,
} from '../../deps/contracts.js';
import { auditEvents, outbox, PrincipalError, withPrincipal, type Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import type { ChannelAdapter, ChannelOutcome } from './channels.js';
import {
  channelGrants, commsContexts, deliveries, mailSuppression, messages, messageTemplates, notificationPreferences, notifications, threads,
  type ChannelGrantRow, type ContextThreadRow, type MessageLinkRow, type MessageRow, type NotificationRow, type PlannedDelivery, type TemplateVersionRow, type ThreadSideValue,
} from './deps.js';
import type { CommsMandatePort } from './mandates.js';

export interface CommunicationsSettings {
  /** The hub this API serves (`TRUSTWORK_HUB_ID`); templates live per hub. Null: no templates, so no mail or messenger text. */
  hubId: string | null;
  /** Languages the hub serves: activation needs every one of them. */
  hubLanguages: readonly string[];
  /** Language used when none of the recipient's languages has an active text. */
  defaultLanguage: string;
  /** `{brand}` in template texts, per language (the Russian brand overlay applies in Russian only). */
  brandFor: (locale: string) => string;
  /** Lifetime of reply tokens sent with messenger and SMS notifications. */
  replyTokenDays: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (value: Date | string): string => new Date(value).toISOString();
const isUuid = (value: string): boolean => UUID.test(value);
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const cursorOf = (seq: string): string => Buffer.from(`n:${seq}`, 'utf8').toString('base64url');
function seqOf(cursor: string | undefined): string | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^n:\d{1,19}$/.test(decoded) ? decoded.slice(2) : null;
}

/** Database hints of the communications definers and guards, mapped to frozen contract codes. */
const HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'access.not_found': { code: 'access.not_found', reason: 'not_found' },
  'comms.context_missing': { code: 'access.not_found', reason: 'not_found' },
  'admin.forbidden': { code: 'access.forbidden', reason: 'staff_permission' },
  'comms.template_incomplete': { code: 'validation.schema', reason: 'template_incomplete' },
  'comms.second_person_required': { code: 'access.second_approver_required', reason: 'drafter_cannot_activate' },
  'comms.template_frozen': { code: 'validation.revision_conflict', reason: 'template_frozen' },
  'comms.template_version_gap': { code: 'validation.schema', reason: 'template_version_gap' },
  'comms.template_unknown': { code: 'validation.schema', reason: 'template_unknown' },
  'comms.params_not_allowed': { code: 'validation.schema', reason: 'params_not_allowed' },
  'comms.immutable': { code: 'validation.schema', reason: 'immutable' },
  'comms.retained': { code: 'validation.schema', reason: 'retained' },
};
function mapCommsError(error: unknown): never {
  if (error instanceof ApiError || error instanceof PrincipalError) throw error;
  const pg = error as { code?: string; hint?: string; detail?: string; constraint?: string };
  if (pg && typeof pg.code === 'string') {
    if (process.env.COMMS_DEBUG) console.error('COMMS_DEBUG', error, pg.hint);
    const mapped = pg.hint ? HINTS[pg.hint] : undefined;
    if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason, ...(pg.hint === 'comms.template_incomplete' && pg.detail ? { missing: pg.detail.split(',') } : {}) });
    // Row security refusing an insert means the caller is not a party: answer as if the object did not exist.
    if (process.env.COMMS_DEBUG) console.error('COMMS_DEBUG', error, pg.hint);
    if (pg.code === '42501') throw new ApiError('access.not_found', 'not found', { reason: 'not_found' });
    if (pg.code === '23505') throw new ApiError('validation.revision_conflict', 'a conflicting record already exists', { constraint: pg.constraint ?? null });
    if (pg.code === '22P02') throw new ApiError('access.not_found', 'not found', { reason: 'not_found' });
  }
  throw error;
}

/** One messenger or SMS send that runs after the request transaction committed. */
interface DispatchItem { deliveryId: string; provider: string; account: string; text: string; replyToken: string | null }

/* ---------- Serializers (explicit allowlists, re-validated by the strict contract schemas) ---------- */

function threadContract(row: ContextThreadRow): Thread {
  return ThreadSchema.parse({
    id: row.id, context: { kind: row.context_kind, id: row.context_id }, subject: row.subject, status: row.status,
    counterparty: row.counterparty_person_id ? { kind: 'person', id: row.counterparty_person_id } : row.counterparty_company_id ? { kind: 'company', id: row.counterparty_company_id } : null,
    openedByPersonId: row.opened_by_person_id, createdAt: iso(row.created_at), lastMessageAt: row.last_message_at ? iso(row.last_message_at) : null, messageCount: row.message_count,
  });
}
function messageContract(row: MessageRow, links: MessageLinkRow[], names: Map<string, string>): Message {
  const name = row.author_person_id ? names.get(row.author_person_id) ?? null : null;
  const author = row.author_kind === 'system' ? { kind: 'system' as const }
    : row.author_kind === 'agent' ? { kind: 'agent' as const, personId: row.author_person_id as string, displayName: name, mandateId: row.mandate_id as string }
      : { kind: 'person' as const, personId: row.author_person_id as string, displayName: name };
  return MessageSchema.parse({
    id: row.id, threadId: row.thread_id, direction: row.direction, author,
    onBehalfOf: row.on_behalf_company_id ? { kind: 'company', id: row.on_behalf_company_id } : row.on_behalf_person_id ? { kind: 'person', id: row.on_behalf_person_id } : null,
    body: row.body, untrusted: row.untrusted, provider: row.provider, sourceTime: iso(row.source_time), receivedAt: iso(row.received_at),
    links: links.filter((l) => l.message_id === row.id).map((l) => ({ kind: l.object_kind, id: l.object_id, versionId: l.version_id })),
  });
}
function notificationContract(row: NotificationRow): Notification {
  return NotificationSchema.parse({
    id: row.id, category: row.category, templateKey: row.template_key, params: row.params,
    link: row.link_kind && row.link_id ? { kind: row.link_kind, id: row.link_id, threadId: row.link_thread_id } : null,
    transactional: row.transactional, createdAt: iso(row.created_at), readAt: row.read_at ? iso(row.read_at) : null,
  });
}
function grantContract(row: ChannelGrantRow): ChannelGrant {
  return ChannelGrantSchema.parse({
    id: row.id, provider: row.provider, accountDisplay: row.account_display, scopes: row.scopes, status: row.status, grantedAt: iso(row.granted_at), revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
  });
}
function templateContract(row: TemplateVersionRow, key: string, hubId: string) {
  return TemplateVersionSchema.parse({
    templateKey: key, hubId, version: row.version, locale: row.locale, subject: row.subject, body: row.body, status: row.status, draftedByPersonId: row.drafted_by_person_id,
    activatedByPersonId: row.activated_by_person_id, activatedAt: row.activated_at ? iso(row.activated_at) : null,
  });
}

/** First of the recipient's languages with an active text (exact tag, then the same language), else the hub default. */
export function pickLocale(preferences: readonly string[], available: readonly string[], fallback: string): string | null {
  const exact = new Map(available.map((tag) => [tag.toLowerCase(), tag]));
  for (const preference of preferences) {
    const hit = exact.get(preference.toLowerCase());
    if (hit) return hit;
    const language = preference.split('-')[0]!.toLowerCase();
    const same = available.find((tag) => tag.split('-')[0]!.toLowerCase() === language);
    if (same) return same;
  }
  return exact.get(fallback.toLowerCase()) ?? null;
}

/**
 * Context threads, messages, notifications, preferences, channel grants and templates (COMMS-001).
 *
 * Every route runs in one `withPrincipal` transaction that also completes its idempotency record (BE-005). Threads are
 * reached through their context only (no generic inbox); RLS decides who is a party and a non-party gets not found.
 * A new message is announced to the other parties by the database (`comms_fanout_message` computes the parameters
 * itself); e-mail deliveries are rendered from the hub's active template in the recipient's language and enqueued
 * through MAIL-001 in the same transaction; messenger and SMS deliveries go through the channel adapter after COMMIT
 * (fakes only) and carry a reply token. Inbound replies are matched by that token, de-duplicated by
 * `(provider, providerMessageId)`, stored untrusted and never interpreted as commands. Outbox events carry identifiers only.
 */
export class CommunicationsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly mandates: CommsMandatePort,
    private readonly channels: ChannelAdapter,
    private readonly settings: CommunicationsSettings,
  ) {}

  private async run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    try {
      return await this.principals.runAs(state, fn);
    } catch (error) {
      return mapCommsError(error);
    }
  }
  private async audit(trx: Transaction, principal: Principal, state: RequestState | null, action: string, objectKind: string, objectId: string, basis?: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state?.requestId ?? null, authz_epoch: principal.authzEpoch, ...(basis === undefined ? {} : { basis }) });
  }
  /** Identifiers only (COMMS_EVENT_PAYLOAD_KEYS). */
  private async event(trx: Transaction, kind: 'context_thread' | 'channel_grant', id: string, revision: number, type: string, payload: Record<string, string>): Promise<void> {
    await outbox.append(trx, { aggregate_kind: kind, aggregate_id: id, revision, type, payload });
  }

  /* ---------- Threads ---------- */

  private async sideOrNotFound(trx: Transaction, context: ThreadContextRef): Promise<ThreadSideValue> {
    if (!isUuid(context.id)) throw new ApiError('access.not_found', 'not found');
    const side = await commsContexts.mySide(trx, context.kind, context.id);
    if (!side) throw new ApiError('access.not_found', 'not found');
    return side;
  }

  listThreads(context: ThreadContextRef, state: RequestState): Promise<ThreadList> {
    return this.run(state, async (trx) => {
      const side = await this.sideOrNotFound(trx, context);
      const rows = await threads.listForContext(trx, context.kind, context.id);
      return ThreadListSchema.parse({ context, side, items: rows.map(threadContract) });
    });
  }

  getThread(id: string, state: RequestState): Promise<ThreadView> {
    return this.run(state, async (trx) => this.view(trx, id));
  }

  private async view(trx: Transaction, id: string): Promise<ThreadView> {
    if (!isUuid(id)) throw new ApiError('access.not_found', 'not found');
    const row = await threads.getById(trx, id);
    if (!row) throw new ApiError('access.not_found', 'not found');
    const side = await commsContexts.mySide(trx, row.context_kind, row.context_id);
    if (!side) throw new ApiError('access.not_found', 'not found');
    const list = await messages.listForThread(trx, id);
    const links = await messages.linksFor(trx, list.map((m) => m.id));
    const names = await threads.people(trx, id);
    return ThreadViewSchema.parse({ thread: threadContract(row), side, messages: list.map((m) => messageContract(m, links, names)) });
  }

  private async actorFor(principal: Principal, actor: PostMessageCommand['actor'], context: { kind: ThreadContextKind; id: string }): Promise<{ kind: 'person' | 'agent'; mandateId: string | null }> {
    if (actor.via === 'person') return { kind: 'person', mandateId: null };
    if (!isUuid(actor.mandateId)) throw new ApiError('access.mandate_scope', 'the mandate does not cover this message');
    const allowed = await this.mandates.allows({ personId: principal.personId, mandateId: actor.mandateId, action: 'communicate', context, at: this.ctx.clock.now() });
    if (!allowed) throw new ApiError('access.mandate_scope', 'the mandate does not cover this message');
    return { kind: 'agent', mandateId: actor.mandateId };
  }

  /** Opens the context's thread (or finds the existing one) with a first message, and tells the other parties. */
  async openThread(command: OpenThreadCommand, state: RequestState): Promise<ThreadView> {
    let dispatch: DispatchItem[] = [];
    const result = await this.run(state, async (trx, principal): Promise<ThreadView> => {
      dispatch = [];
      await this.sideOrNotFound(trx, command.context);
      const multi = command.context.kind === 'rfq' || command.context.kind === 'task_request';
      if (multi !== (command.counterparty !== null)) throw new ApiError('validation.schema', 'RFQ and task-request threads name their counterparty; other threads do not', { reason: 'counterparty' });
      if (command.counterparty && !isUuid(command.counterparty.id)) throw new ApiError('access.not_found', 'not found');
      const counterparty = { person: command.counterparty?.kind === 'person' ? command.counterparty.id : null, company: command.counterparty?.kind === 'company' ? command.counterparty.id : null };
      const actor = await this.actorFor(principal, command.message.actor, command.context);
      const { thread, created } = await threads.open(trx, { kind: command.context.kind, id: command.context.id, counterparty, subject: command.subject, openedBy: principal.personId });
      if (created) {
        await this.audit(trx, principal, state, 'comms.thread_opened', 'context_thread', thread.id, { contextKind: thread.context_kind });
        await this.event(trx, 'context_thread', thread.id, 1, 'comms.thread_opened', { threadId: thread.id, contextKind: thread.context_kind, contextId: thread.context_id });
      }
      dispatch = (await this.writeMessage(trx, principal, state, thread, command.message, actor, created ? 'thread.opened' : 'thread.message')).dispatch;
      return this.view(trx, thread.id);
    });
    await this.dispatch(state.principal as Principal, dispatch);
    return result;
  }

  async postMessage(threadId: string, command: PostMessageCommand, state: RequestState): Promise<Message> {
    let dispatch: DispatchItem[] = [];
    const result = await this.run(state, async (trx, principal): Promise<Message> => {
      dispatch = [];
      if (!isUuid(threadId)) throw new ApiError('access.not_found', 'not found');
      const thread = await threads.getById(trx, threadId);
      if (!thread) throw new ApiError('access.not_found', 'not found');
      if (thread.status !== 'open') throw new ApiError('validation.revision_conflict', 'the thread is closed', { reason: 'thread_closed' });
      const actor = await this.actorFor(principal, command.actor, { kind: thread.context_kind, id: thread.context_id });
      const written = await this.writeMessage(trx, principal, state, thread, command, actor, 'thread.message');
      dispatch = written.dispatch;
      const links = await messages.linksFor(trx, [written.message.id]);
      return messageContract(written.message, links, await threads.people(trx, threadId));
    });
    await this.dispatch(state.principal as Principal, dispatch);
    return result;
  }

  private async writeMessage(trx: Transaction, principal: Principal, state: RequestState | null, thread: ContextThreadRow, command: PostMessageCommand,
    actor: { kind: 'person' | 'agent'; mandateId: string | null }, template: 'thread.opened' | 'thread.message'): Promise<{ message: MessageRow; dispatch: DispatchItem[] }> {
    for (const link of command.links) if (!isUuid(link.id) || (link.versionId !== null && !isUuid(link.versionId))) throw new ApiError('validation.schema', 'links name stored objects', { reason: 'link' });
    const company = command.onBehalfOfCompany ? principal.membership?.companyId ?? null : null;
    if (command.onBehalfOfCompany && !company) throw new ApiError('access.forbidden', 'no employer to write for', { reason: 'no_employer' });
    const row = await messages.insert(trx, {
      threadId: thread.id, direction: 'internal', authorKind: actor.kind, authorPersonId: principal.personId, onBehalfCompanyId: company, mandateId: actor.mandateId, body: command.body,
    });
    if (!row) throw new Error('message insert returned nothing');
    await messages.addLinks(trx, row.id, command.links.map((l) => ({ kind: l.kind, id: l.id, versionId: l.versionId })));
    await this.audit(trx, principal, state, 'comms.message_posted', 'message', row.id, { threadId: thread.id, via: actor.kind });
    await this.event(trx, 'context_thread', thread.id, thread.message_count + 1, 'comms.message_posted', { threadId: thread.id, messageId: row.id });
    return { message: row, dispatch: await this.deliver(trx, await notifications.fanout(trx, row.id, template)) };
  }

  /* ---------- Deliveries ---------- */

  /**
   * Acts on planned deliveries inside the transaction: e-mail is rendered from the active template in the recipient's
   * language and enqueued through MAIL-001; messenger and SMS get a reply token and are returned for dispatch after
   * COMMIT. Without an active text in a language the recipient reads the delivery is skipped (never another language
   * the hub does not serve, never an English fallback the hub did not choose).
   */
  private async deliver(trx: Transaction, planned: PlannedDelivery[]): Promise<DispatchItem[]> {
    const dispatch: DispatchItem[] = [];
    const texts = new Map<string, { locale: string; subject: string; body: string }[]>();
    for (const item of planned) {
      const active = this.settings.hubId ? (texts.get(item.template_key) ?? await messageTemplates.active(trx, this.settings.hubId, item.template_key)) : [];
      texts.set(item.template_key, active);
      const locale = pickLocale(item.languages, active.map((a) => a.locale), this.settings.defaultLanguage);
      const text = locale ? active.find((a) => a.locale === locale) : undefined;
      if (!locale || !text) {
        await deliveries.settle(trx, { deliveryId: item.delivery_id, state: 'skipped', providerRef: null, reason: this.settings.hubId ? 'no_active_template' : 'no_hub' });
        continue;
      }
      const params = { ...item.params, brand: this.settings.brandFor(locale) };
      const subject = renderTemplateText(text.subject, params).slice(0, 200);
      const body = renderTemplateText(text.body, params);
      const path = item.link_kind && item.link_id ? contextPath(item.link_kind, item.link_id) : '/app/notifications';
      if (item.channel === 'email') {
        await deliveries.enqueueMail(trx, { deliveryId: item.delivery_id, locale, subject, body, path });
        continue;
      }
      let replyToken: string | null = null;
      if (item.link_thread_id) {
        replyToken = randomBytes(32).toString('base64url');
        await deliveries.issueReplyToken(trx, { deliveryId: item.delivery_id, tokenHash: sha256(replyToken), expiresAt: new Date(this.ctx.clock.now().getTime() + this.settings.replyTokenDays * 86_400_000) });
      }
      dispatch.push({ deliveryId: item.delivery_id, provider: item.provider, account: item.account_ref as string, text: `${subject}\n\n${body}`, replyToken });
    }
    return dispatch;
  }

  /**
   * Sends messenger and SMS deliveries after the request committed and records each outcome as the same person. A
   * crash in between leaves them `queued` (never sent twice); an unknown outcome is recorded and never retried here.
   */
  private async dispatch(principal: Principal, items: DispatchItem[]): Promise<void> {
    for (const item of items) {
      let outcome: ChannelOutcome;
      try {
        outcome = this.channels.providers.includes(item.provider) ? await this.channels.send(item) : { kind: 'failed', reason: 'no_adapter' };
      } catch {
        outcome = { kind: 'unknown', reason: 'adapter_error' };
      }
      const state = outcome.kind === 'accepted' ? 'sent' : outcome.kind === 'failed' ? 'failed' : 'outcome_unknown';
      try {
        await this.asPerson(principal.personId, (trx) => deliveries.settle(trx, {
          deliveryId: item.deliveryId, state, providerRef: outcome.kind === 'accepted' ? outcome.providerRef : null, reason: outcome.kind === 'accepted' ? null : outcome.reason.replace(/[^a-z0-9_]/g, '_').slice(0, 60),
        }));
      } catch (error) {
        this.ctx.log('communications: recording a channel outcome failed', error);
      }
    }
  }

  private async asPerson<T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> {
    const { rows } = await this.ctx.pool.query<{ authz_epoch: number }>('SELECT authz_epoch FROM trustwork.auth_person_epoch($1::uuid)', [personId]);
    const epoch = rows[0]?.authz_epoch;
    if (epoch === undefined) throw new ApiError('access.not_found', 'not found');
    return withPrincipal(this.ctx.pool, { personId, authzEpoch: epoch }, fn);
  }

  /* ---------- Inbound intake (adapters) ---------- */

  /**
   * One inbound message from a channel adapter. The reply token names the thread and the person it was sent to; the
   * message is written as that person under RLS (a person who is no longer a party is refused), flagged untrusted, and
   * a repeated provider event changes nothing. The text is stored, never parsed for commands.
   */
  async ingest(event: InboundMessageEvent): Promise<IntakeResult> {
    const token = await deliveries.resolveReplyToken(this.ctx.pool, sha256(event.replyToken));
    if (!token) return IntakeResultSchema.parse({ outcome: 'unmatched', messageId: null, threadId: null });
    if (token.provider !== event.provider) return IntakeResultSchema.parse({ outcome: 'refused', messageId: null, threadId: null });
    const body = event.body.trim().slice(0, 20_000);
    if (!body) return IntakeResultSchema.parse({ outcome: 'refused', messageId: null, threadId: token.thread_id });
    let dispatch: DispatchItem[] = [];
    let result: IntakeResult;
    try {
      result = await withPrincipal(this.ctx.pool, { personId: token.person_id, authzEpoch: token.authz_epoch }, async (trx) => {
        const thread = await threads.getById(trx, token.thread_id);
        if (!thread || thread.status !== 'open') return IntakeResultSchema.parse({ outcome: 'refused', messageId: null, threadId: null });
        const row = await messages.insert(trx, {
          threadId: thread.id, direction: 'inbound', authorKind: 'person', authorPersonId: token.person_id, onBehalfCompanyId: null, mandateId: null, body,
          sourceTime: new Date(event.sourceTime), provider: event.provider, providerMessageId: event.providerMessageId, channelGrantId: token.channel_grant_id, senderClaim: event.senderClaim,
        });
        if (!row) return IntakeResultSchema.parse({ outcome: 'duplicate', messageId: null, threadId: thread.id });
        await auditEvents.append(trx, { actor_person_id: token.person_id, action: 'comms.message_received', object_kind: 'message', object_id: row.id, basis: { threadId: thread.id, provider: event.provider } });
        await this.event(trx, 'context_thread', thread.id, thread.message_count + 1, 'comms.message_received', { threadId: thread.id, messageId: row.id });
        dispatch = await this.deliver(trx, await notifications.fanout(trx, row.id, 'thread.message'));
        return IntakeResultSchema.parse({ outcome: 'accepted', messageId: row.id, threadId: thread.id });
      });
    } catch (error) {
      const pg = error as { code?: string };
      if (error instanceof PrincipalError || pg?.code === '42501') return IntakeResultSchema.parse({ outcome: 'refused', messageId: null, threadId: null });
      throw error;
    }
    if (dispatch.length) await this.dispatch({ personId: token.person_id } as Principal, dispatch);
    return result;
  }

  /* ---------- Notifications ---------- */

  listNotifications(query: { limit: number; cursor?: string | undefined; unread?: 'true' | 'false' | undefined }, state: RequestState): Promise<NotificationPage> {
    return this.run(state, async (trx) => {
      const rows = await notifications.list(trx, { limit: query.limit + 1, beforeSeq: seqOf(query.cursor), unreadOnly: query.unread === 'true' });
      const page = rows.slice(0, query.limit);
      return NotificationPageSchema.parse({
        items: page.map(notificationContract), unreadCount: await notifications.unreadCount(trx), nextCursor: rows.length > query.limit ? cursorOf(page.at(-1)!.seq) : null,
      });
    });
  }

  markRead(id: string, state: RequestState): Promise<Notification> {
    return this.run(state, async (trx) => {
      if (!isUuid(id)) throw new ApiError('access.not_found', 'not found');
      const row = await notifications.markRead(trx, id);
      if (!row) throw new ApiError('access.not_found', 'not found');
      return notificationContract(row);
    });
  }

  markAllRead(state: RequestState): Promise<{ marked: number }> {
    return this.run(state, async (trx) => ({ marked: await notifications.markAllRead(trx) }));
  }

  /** Producer for other modules (non-thread templates): parameters are restricted by the database to the template's keys. */
  notify(trx: Transaction, input: { recipient: string; template: Exclude<NotificationTemplateKey, 'thread.opened' | 'thread.message'>; params: Record<string, string>; link: { kind: ThreadContextKind; id: string } | null; dedupeKey: string }): Promise<DispatchItem[]> {
    return notifications.notify(trx, input).then((planned) => this.deliver(trx, planned));
  }

  /* ---------- Preferences ---------- */

  private async preferencesOf(trx: Transaction, personId: string): Promise<NotificationPreferences> {
    const chosen = await notificationPreferences.list(trx, personId);
    const items = NOTIFICATION_CATEGORIES.flatMap((category) => NOTIFICATION_CHANNELS.map((channel) => {
      const row = chosen.find((c) => c.category === category && c.channel === channel);
      return { category, channel, frequency: row?.frequency ?? DEFAULT_PREFERENCES[category][channel], transactional: TRANSACTIONAL_CATEGORIES.includes(category), chosen: Boolean(row) };
    }));
    return NotificationPreferencesSchema.parse({ items, emailSuppressed: await mailSuppression.mine(trx) });
  }

  getPreferences(state: RequestState): Promise<NotificationPreferences> {
    return this.run(state, async (trx, principal) => this.preferencesOf(trx, principal.personId));
  }

  setPreference(command: SetNotificationPreferenceCommand, state: RequestState): Promise<NotificationPreferences> {
    return this.run(state, async (trx, principal) => {
      await notificationPreferences.set(trx, { personId: principal.personId, ...command });
      await this.audit(trx, principal, state, 'comms.preference_set', 'person', principal.personId, { category: command.category, channel: command.channel, frequency: command.frequency });
      return this.preferencesOf(trx, principal.personId);
    });
  }

  /** Unsubscribes the person's own verified address from non-transactional mail (security and legal notices still arrive). */
  unsubscribe(state: RequestState): Promise<NotificationPreferences> {
    return this.run(state, async (trx, principal) => {
      const added = await mailSuppression.unsubscribe(trx);
      if (added) await this.audit(trx, principal, state, 'comms.mail_unsubscribed', 'person', principal.personId);
      return this.preferencesOf(trx, principal.personId);
    });
  }

  /* ---------- Channel grants ---------- */

  listGrants(state: RequestState) {
    return this.run(state, async (trx, principal) => ChannelGrantListSchema.parse({ items: (await channelGrants.list(trx, principal.personId)).map(grantContract) }));
  }

  createGrant(command: CreateChannelGrantCommand, state: RequestState): Promise<ChannelGrant> {
    return this.run(state, async (trx, principal) => {
      const row = await channelGrants.create(trx, { personId: principal.personId, provider: command.provider, accountRef: command.account, accountDisplay: maskAccount(command.account), scopes: command.scopes });
      await this.audit(trx, principal, state, 'comms.channel_granted', 'channel_grant', row.id, { provider: row.provider, scopes: command.scopes });
      await this.event(trx, 'channel_grant', row.id, 1, 'comms.channel_granted', {});
      return grantContract(row);
    });
  }

  revokeGrant(id: string, state: RequestState): Promise<ChannelGrant> {
    return this.run(state, async (trx, principal) => {
      if (!isUuid(id)) throw new ApiError('access.not_found', 'not found');
      const existing = await channelGrants.getById(trx, id);
      if (!existing) throw new ApiError('access.not_found', 'not found');
      const row = existing.status === 'revoked' ? existing : await channelGrants.revoke(trx, id);
      if (!row) throw new ApiError('access.not_found', 'not found');
      if (existing.status === 'active') {
        await this.audit(trx, principal, state, 'comms.channel_revoked', 'channel_grant', id, { provider: row.provider });
        await this.event(trx, 'channel_grant', id, 2, 'comms.channel_revoked', {});
      }
      return grantContract(row);
    });
  }

  /* ---------- Templates (hub staff) ---------- */

  private hub(): string {
    if (!this.settings.hubId) throw new ApiError('access.not_found', 'this API serves no hub');
    return this.settings.hubId;
  }

  listTemplateVersions(key: NotificationTemplateKey, state: RequestState) {
    return this.run(state, async (trx) => {
      const hubId = this.hub();
      const rows = await messageTemplates.versions(trx, hubId, key);
      return TemplateVersionListSchema.parse({ templateKey: key, hubId, hubLanguages: [...this.settings.hubLanguages], items: rows.map((r) => templateContract(r, key, hubId)) });
    });
  }

  draftTemplate(key: NotificationTemplateKey, command: DraftTemplateVersionCommand, state: RequestState) {
    return this.run(state, async (trx) => {
      const hubId = this.hub();
      if (!this.settings.hubLanguages.includes(command.locale)) throw new ApiError('validation.schema', 'the hub does not serve this language', { reason: 'locale_not_served' });
      const problems = [...templatePlaceholderProblems(key, command.subject), ...templatePlaceholderProblems(key, command.body)];
      if (problems.length) throw new ApiError('validation.schema', 'unknown placeholders', { reason: 'placeholders', problems });
      return templateContract(await messageTemplates.draft(trx, { hubId, key, ...command }), key, hubId);
    });
  }

  activateTemplate(key: NotificationTemplateKey, version: number, command: ActivateTemplateVersionCommand, state: RequestState) {
    return this.run(state, async (trx) => {
      const hubId = this.hub();
      const rows = await messageTemplates.activate(trx, { hubId, key, version, requiredLocales: this.settings.hubLanguages, reason: command.reason });
      return TemplateVersionListSchema.parse({ templateKey: key, hubId, hubLanguages: [...this.settings.hubLanguages], items: rows.map((r) => templateContract(r, key, hubId)) });
    });
  }

  deliveryCounts(state: RequestState) {
    return this.run(state, async (trx) => DeliveryCountsSchema.parse({ items: (await deliveries.counts(trx, this.hub())).map((r) => ({ channel: r.channel, state: r.state, count: r.n })) }));
  }
}

/** The registry keys a template may have, for route validation. */
export const TEMPLATE_KEYS = Object.keys(NOTIFICATION_TEMPLATES) as NotificationTemplateKey[];
