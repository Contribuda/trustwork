import { z } from 'zod';
import { PartySchema } from './access.js';
import { IdSchema, ShortTextSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { LocaleTagSchema } from './hub.js';

/**
 * Communications and notifications (COMMS-001; requirement R08, data model section 13, handbook
 * docs/engine/communications.md).
 *
 * - **Conversations belong to the work.** A context thread always names its context (a project, an RFQ, a quote, an
 *   agreement, an order, a task request or a task assignment). There is no generic inbox: threads are listed per
 *   context only, and whoever may see the context as a party may see its threads, nobody else (non-participants get
 *   not found). RFQs and task requests have many counterparties, so each of their threads is between the owner side and
 *   one counterparty; competitors never see each other's threads.
 * - **Inbound content is untrusted.** Messages arriving through an external channel are matched to a thread by a reply
 *   token, de-duplicated by `(provider, providerMessageId)` and stored with `untrusted: true`; they inform people and
 *   agents but never authorize an action or issue a command.
 * - **Notifications are not mail.** The bell shows short signals with a link. Their parameters are restricted per
 *   template to values every recipient may read (never a message body, budget, floor, price or private note), and the
 *   recipient's right to the linked context is checked again when the notification is read.
 * - **Templates** are versioned per hub and language; a version is activated only when it exists in every language the
 *   hub serves and by a person other than its drafter.
 */
export const COMMUNICATIONS_CONTRACT_VERSION = 1;

/* ---------- Contexts ---------- */

/** Every context kind of the data model (section 13). Kinds whose module does not exist yet are not accepted yet. */
export const MODEL_CONTEXT_KINDS = [
  'rfq', 'quote', 'agreement', 'order', 'introduction', 'project', 'plan', 'consultation_booking', 'task_request', 'task_assignment', 'mentoring_relationship',
  'registration', 'support_case', 'negotiation_session',
] as const;
/** Context kinds with a thread today: their modules exist and define who the parties are. */
export const THREAD_CONTEXT_KINDS = ['project', 'rfq', 'quote', 'agreement', 'order', 'task_request', 'task_assignment'] as const;
export const ThreadContextKindSchema = z.enum(THREAD_CONTEXT_KINDS);
export type ThreadContextKind = z.infer<typeof ThreadContextKindSchema>;
/** Contexts with one owner side and many counterparties: each thread is between the owner side and one counterparty. */
export const COUNTERPARTY_SCOPED_KINDS: readonly ThreadContextKind[] = ['rfq', 'task_request'];
export const ThreadContextRefSchema = z.strictObject({ kind: ThreadContextKindSchema, id: IdSchema });
export type ThreadContextRef = z.infer<typeof ThreadContextRefSchema>;
/** How the reader takes part in the context: the owner side, the counterparty, or a participant (project participants). */
export const ThreadSideSchema = z.enum(['owner', 'counterparty', 'participant']);
export type ThreadSide = z.infer<typeof ThreadSideSchema>;

/** Workspace page of a context; notifications and mail link there (the thread is shown with its context). */
export function contextPath(kind: ThreadContextKind, id: string): string {
  const safe = encodeURIComponent(id);
  switch (kind) {
    case 'project': return `/app/projects/${safe}`;
    case 'rfq': return `/app/procurement/rfq/${safe}`;
    case 'quote': return `/app/sales/quotes/${safe}`;
    default: return '/app/notifications';
  }
}

/* ---------- Threads and messages ---------- */

export const ThreadStatusSchema = z.enum(['open', 'closed']);
export const ThreadSubjectSchema = z.string().overwrite((v) => v.normalize('NFC')).trim().min(1).max(200);
export const ThreadSchema = z.strictObject({
  id: IdSchema,
  context: ThreadContextRefSchema,
  subject: ThreadSubjectSchema,
  status: ThreadStatusSchema,
  /** The counterparty of an RFQ or task-request thread; null for every other context. */
  counterparty: PartySchema.nullable(),
  openedByPersonId: IdSchema,
  createdAt: TimestampSchema,
  lastMessageAt: TimestampSchema.nullable(),
  messageCount: z.int().min(0),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const MessageDirectionSchema = z.enum(['inbound', 'outbound', 'internal']);
/** Channels a person may connect (`channel_grant.provider`); e-mail is always available through the hub. */
export const CHANNEL_PROVIDERS = ['email', 'telegram', 'whatsapp', 'sms', 'other'] as const;
export const ChannelProviderSchema = z.enum(CHANNEL_PROVIDERS);
export type ChannelProvider = z.infer<typeof ChannelProviderSchema>;
export const MessageAuthorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), personId: IdSchema, displayName: z.string().max(200).nullable() }),
  /** An agent wrote on behalf of the person under a mandate (ADR 010 decision 4). */
  z.strictObject({ kind: z.literal('agent'), personId: IdSchema, displayName: z.string().max(200).nullable(), mandateId: IdSchema }),
  z.strictObject({ kind: z.literal('system') }),
]);
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>;
/** Object versions a message discusses (`message_link`). */
export const MESSAGE_LINK_KINDS = ['rfq_version', 'quote_version', 'agreement', 'order', 'plan_version', 'task_request_version', 'task_offer', 'file'] as const;
export const MessageLinkSchema = z.strictObject({ kind: z.enum(MESSAGE_LINK_KINDS), id: IdSchema, versionId: IdSchema.nullable() });
export type MessageLink = z.infer<typeof MessageLinkSchema>;
export const MessageBodySchema = z.string().overwrite((v) => v.normalize('NFC')).max(10_000).refine((v) => v.trim().length > 0, { message: 'a message has text' });
export const MessageSchema = z.strictObject({
  id: IdSchema,
  threadId: IdSchema,
  direction: MessageDirectionSchema,
  author: MessageAuthorSchema,
  onBehalfOf: PartySchema.nullable(),
  body: TextSchema,
  /** Always true for inbound messages: the text may inform drafts, never authorize anything. */
  untrusted: z.boolean(),
  /** Provider of an inbound message; null for messages written on the platform. */
  provider: ChannelProviderSchema.nullable(),
  sourceTime: TimestampSchema,
  receivedAt: TimestampSchema,
  links: z.array(MessageLinkSchema).max(10),
}).refine((m) => m.direction !== 'inbound' || (m.untrusted && m.provider !== null), { message: 'inbound messages are untrusted and name their provider', path: ['untrusted'] });
export type Message = z.infer<typeof MessageSchema>;

export const ThreadViewSchema = z.strictObject({ thread: ThreadSchema, side: ThreadSideSchema, messages: z.array(MessageSchema) });
export type ThreadView = z.infer<typeof ThreadViewSchema>;
export const ThreadListSchema = z.strictObject({ context: ThreadContextRefSchema, side: ThreadSideSchema, items: z.array(ThreadSchema) });
export type ThreadList = z.infer<typeof ThreadListSchema>;

/** `GET /v1/threads?contextKind=&contextId=`: threads exist per context only (no generic inbox). */
export const ThreadListQuerySchema = z.strictObject({ contextKind: ThreadContextKindSchema, contextId: IdSchema });
export const CommsActorSchema = z.discriminatedUnion('via', [
  z.strictObject({ via: z.literal('person') }),
  z.strictObject({ via: z.literal('agent'), mandateId: IdSchema }),
]);
export type CommsActor = z.infer<typeof CommsActorSchema>;
export const PostMessageCommandSchema = z.strictObject({
  body: MessageBodySchema,
  links: z.array(MessageLinkSchema).max(10).default([]),
  /** Write as the employer (a company party of the context); null writes as the person. */
  onBehalfOfCompany: z.boolean().default(false),
  actor: CommsActorSchema.default({ via: 'person' }),
});
export type PostMessageCommand = z.infer<typeof PostMessageCommandSchema>;
export const OpenThreadCommandSchema = z.strictObject({
  context: ThreadContextRefSchema,
  subject: ThreadSubjectSchema,
  /** Required for RFQ and task-request threads (the counterparty side passes itself); null otherwise. */
  counterparty: PartySchema.nullable().default(null),
  /** The first message (a thread is never empty). On an existing thread it is appended. */
  message: PostMessageCommandSchema,
});
export type OpenThreadCommand = z.infer<typeof OpenThreadCommandSchema>;

/* ---------- Inbound intake (adapters only) ---------- */

/** One inbound event as an adapter normalises it. Every field except the ids is untrusted text. */
export const InboundMessageEventSchema = z.strictObject({
  provider: ChannelProviderSchema,
  providerMessageId: z.string().min(1).max(200),
  /** Reply token carried by the outbound message (reply address, messenger payload); never stored in clear. */
  replyToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  body: z.string().max(20_000),
  sourceTime: TimestampSchema,
  /** What the channel claims about the sender (display name, masked address); informational only. */
  senderClaim: z.string().max(200).nullable(),
});
export type InboundMessageEvent = z.infer<typeof InboundMessageEventSchema>;
export const IntakeOutcomeSchema = z.enum(['accepted', 'duplicate', 'unmatched', 'refused']);
export const IntakeResultSchema = z.strictObject({ outcome: IntakeOutcomeSchema, messageId: IdSchema.nullable(), threadId: IdSchema.nullable() });
export type IntakeResult = z.infer<typeof IntakeResultSchema>;

/* ---------- Notifications ---------- */

export const NOTIFICATION_CATEGORIES = ['messages', 'commerce', 'tasks', 'projects', 'account', 'legal'] as const;
export const NotificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;
/** Security and legal notices cannot be turned off (handbook: "transactional notices cannot be turned off"). */
export const TRANSACTIONAL_CATEGORIES: readonly NotificationCategory[] = ['account', 'legal'];

/**
 * Notification templates and the only parameters each may carry. Every parameter is a value every recipient may read
 * as a party of the linked context (the thread subject is written for all of the thread's readers; the author's
 * display name is shown in the thread). A message body, a price, a budget, a floor or a private note is never a
 * parameter; the database refuses any other key (`comms_params_allowed`).
 */
export const NOTIFICATION_TEMPLATES = {
  'thread.opened': { category: 'messages', transactional: false, params: ['contextKind', 'threadSubject', 'authorName'] },
  'thread.message': { category: 'messages', transactional: false, params: ['contextKind', 'threadSubject', 'authorName'] },
  'account.security_notice': { category: 'account', transactional: true, params: ['event'] },
} as const satisfies Record<string, { category: NotificationCategory; transactional: boolean; params: readonly string[] }>;
export type NotificationTemplateKey = keyof typeof NOTIFICATION_TEMPLATES;
export const NOTIFICATION_TEMPLATE_KEYS = Object.keys(NOTIFICATION_TEMPLATES) as NotificationTemplateKey[];
export const NotificationTemplateKeySchema = z.enum(NOTIFICATION_TEMPLATE_KEYS as [NotificationTemplateKey, ...NotificationTemplateKey[]]);
/**
 * Keys that never appear in a notification, a delivery or an outbox payload (forbidden-field list, checked by tests and
 * by `assertNotificationParams`). Private values of the other party have no place in a signal.
 */
export const NOTIFICATION_FORBIDDEN_KEYS = [
  'body', 'text', 'price', 'amount', 'budget', 'budgetCeiling', 'floor', 'floorPrice', 'floorPrices', 'ceiling', 'privateNotes', 'internalNotes', 'ownerNotes',
  'offerorNotes', 'negotiationNotes', 'costBasis', 'marginTargets', 'evaluationWeights', 'shortlist', 'address', 'email', 'phone',
] as const;
export const NotificationParamValueSchema = z.string().max(200);
export const NotificationLinkSchema = z.strictObject({ kind: ThreadContextKindSchema, id: IdSchema, threadId: IdSchema.nullable() });
export const NotificationSchema = z.strictObject({
  id: IdSchema,
  category: NotificationCategorySchema,
  templateKey: NotificationTemplateKeySchema,
  params: z.record(z.string(), NotificationParamValueSchema),
  link: NotificationLinkSchema.nullable(),
  transactional: z.boolean(),
  createdAt: TimestampSchema,
  readAt: TimestampSchema.nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;
export const NotificationPageSchema = z.strictObject({ items: z.array(NotificationSchema), unreadCount: z.int().min(0), nextCursor: z.string().nullable() });
export type NotificationPage = z.infer<typeof NotificationPageSchema>;
export const NotificationListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
  unread: z.enum(['true', 'false']).optional(),
});

/** Parameters of a template, exactly: unknown or forbidden keys and non-string values are refused. */
export function assertNotificationParams(templateKey: NotificationTemplateKey, params: Record<string, unknown>): Record<string, string> {
  const allowed: readonly string[] = NOTIFICATION_TEMPLATES[templateKey].params;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if ((NOTIFICATION_FORBIDDEN_KEYS as readonly string[]).includes(key) || !allowed.includes(key)) throw new RangeError(`notification parameter ${key} is not allowed for ${templateKey}`);
    if (typeof value !== 'string') throw new TypeError(`notification parameter ${key} must be a string`);
    out[key] = NotificationParamValueSchema.parse(value);
  }
  return out;
}

/* ---------- Preferences ---------- */

/** Delivery channels besides the bell (the bell always shows every notification). */
export const NOTIFICATION_CHANNELS = ['email', 'messenger', 'sms'] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
export const NotificationFrequencySchema = z.enum(['immediate', 'daily', 'weekly', 'off']);
export type NotificationFrequency = z.infer<typeof NotificationFrequencySchema>;
/** Defaults when a person has chosen nothing: e-mail at once for work and security, messengers only when connected. */
export const DEFAULT_PREFERENCES: Readonly<Record<NotificationCategory, Readonly<Record<NotificationChannel, NotificationFrequency>>>> = {
  messages: { email: 'immediate', messenger: 'immediate', sms: 'off' },
  commerce: { email: 'immediate', messenger: 'immediate', sms: 'off' },
  tasks: { email: 'immediate', messenger: 'immediate', sms: 'off' },
  projects: { email: 'daily', messenger: 'off', sms: 'off' },
  account: { email: 'immediate', messenger: 'off', sms: 'off' },
  legal: { email: 'immediate', messenger: 'off', sms: 'off' },
};
export const NotificationPreferenceSchema = z.strictObject({
  category: NotificationCategorySchema,
  channel: NotificationChannelSchema,
  frequency: NotificationFrequencySchema,
  transactional: z.boolean(),
  /** True when the person chose it; false for the engine default. */
  chosen: z.boolean(),
});
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;
export const NotificationPreferencesSchema = z.strictObject({
  items: z.array(NotificationPreferenceSchema),
  /** Why the person's own address receives no non-transactional mail (bounce, complaint, unsubscribe, legal), or null. */
  emailSuppressed: z.enum(['bounce', 'complaint', 'unsubscribe', 'legal']).nullable(),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;
export const SetNotificationPreferenceCommandSchema = z.strictObject({ category: NotificationCategorySchema, channel: NotificationChannelSchema, frequency: NotificationFrequencySchema })
  .refine((c) => !(TRANSACTIONAL_CATEGORIES.includes(c.category) && c.channel === 'email' && c.frequency === 'off'), { message: 'transactional notices cannot be turned off', path: ['frequency'] });
export type SetNotificationPreferenceCommand = z.infer<typeof SetNotificationPreferenceCommandSchema>;

/* ---------- Channel grants ---------- */

export const ChannelGrantActionSchema = z.enum(['notify', 'reply']);
export const ChannelGrantScopesSchema = z.strictObject({
  contextKinds: z.array(ThreadContextKindSchema).min(1).max(THREAD_CONTEXT_KINDS.length),
  actions: z.array(ChannelGrantActionSchema).min(1).max(2),
}).refine((s) => new Set(s.contextKinds).size === s.contextKinds.length && new Set(s.actions).size === s.actions.length, { message: 'no duplicates', path: ['contextKinds'] });
export type ChannelGrantScopes = z.infer<typeof ChannelGrantScopesSchema>;
export const ChannelGrantSchema = z.strictObject({
  id: IdSchema,
  provider: ChannelProviderSchema,
  /** Masked account (`@ma***`, `+1 *** 0142`); the full handle is kept for the adapter only. */
  accountDisplay: z.string().max(200),
  scopes: ChannelGrantScopesSchema,
  status: z.enum(['active', 'revoked']),
  grantedAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
});
export type ChannelGrant = z.infer<typeof ChannelGrantSchema>;
export const ChannelGrantListSchema = z.strictObject({ items: z.array(ChannelGrantSchema) });
/** Messenger and SMS grants; e-mail goes through the hub sender for everyone and needs no grant. */
export const CreateChannelGrantCommandSchema = z.strictObject({
  provider: z.enum(['telegram', 'whatsapp', 'sms', 'other']),
  account: z.string().trim().min(3).max(200).regex(/^[^\s<>"']+$/),
  scopes: ChannelGrantScopesSchema,
});
export type CreateChannelGrantCommand = z.infer<typeof CreateChannelGrantCommandSchema>;
/** Masks a handle or number for display: keeps a short prefix and the last two characters. */
export function maskAccount(account: string): string {
  const value = account.trim();
  if (value.length <= 4) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, Math.min(3, value.length - 2))}***${value.slice(-2)}`;
}

/* ---------- Templates ---------- */

/** The seven engine languages: a hub serving all of them needs every template version in each (configurable per hub). */
export const ENGINE_TEMPLATE_LANGUAGES = ['en', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn', 'es'] as const;

/** Placeholders a template body may use: the template's parameters and the hub brand. */
export function templatePlaceholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]{0,40})\}/g)].map((m) => m[1] as string);
}
export function templatePlaceholderProblems(templateKey: NotificationTemplateKey, text: string): string[] {
  const allowed = new Set<string>([...NOTIFICATION_TEMPLATES[templateKey].params, 'brand']);
  const problems = templatePlaceholders(text).filter((p) => !allowed.has(p)).map((p) => `unknown placeholder {${p}}`);
  if (/[{}]/.test(text.replace(/\{[A-Za-z][A-Za-z0-9]{0,40}\}/g, ''))) problems.push('unbalanced braces');
  return problems;
}
/** Plain substitution of `{name}`; unknown names stay as they are (drafts are checked before activation). */
export function renderTemplateText(text: string, params: Readonly<Record<string, string>>): string {
  return text.replace(/\{([A-Za-z][A-Za-z0-9]{0,40})\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? (params[name] as string) : whole));
}

export const TemplateSubjectSchema = z.string().overwrite((v) => v.normalize('NFC')).trim().min(1).max(200).refine((v) => !/[\r\n]/.test(v), { message: 'one line' });
export const TemplateBodySchema = z.string().overwrite((v) => v.normalize('NFC')).trim().min(1).max(4000);
export const TemplateVersionStatusSchema = z.enum(['draft', 'active', 'retired']);
export const TemplateVersionSchema = z.strictObject({
  templateKey: NotificationTemplateKeySchema,
  hubId: IdSchema,
  version: z.int().min(1),
  locale: LocaleTagSchema,
  subject: TemplateSubjectSchema,
  body: TemplateBodySchema,
  status: TemplateVersionStatusSchema,
  draftedByPersonId: IdSchema,
  activatedByPersonId: IdSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
});
export type TemplateVersion = z.infer<typeof TemplateVersionSchema>;
export const TemplateVersionListSchema = z.strictObject({
  templateKey: NotificationTemplateKeySchema,
  hubId: IdSchema,
  /** Languages the hub serves; activation needs every one of them. */
  hubLanguages: z.array(LocaleTagSchema),
  items: z.array(TemplateVersionSchema),
});
export type TemplateVersionList = z.infer<typeof TemplateVersionListSchema>;
/** Drafts (or replaces the draft text of) one language of a template version. */
export const DraftTemplateVersionCommandSchema = z.strictObject({ version: z.int().min(1).max(10_000), locale: LocaleTagSchema, subject: TemplateSubjectSchema, body: TemplateBodySchema });
export type DraftTemplateVersionCommand = z.infer<typeof DraftTemplateVersionCommandSchema>;
export const ActivateTemplateVersionCommandSchema = z.strictObject({ reason: ShortTextSchema });
export type ActivateTemplateVersionCommand = z.infer<typeof ActivateTemplateVersionCommandSchema>;

/* ---------- Deliveries ---------- */

export const DELIVERY_STATES = ['queued', 'sent', 'delivered', 'bounced', 'failed', 'outcome_unknown', 'suppressed', 'skipped'] as const;
export const DeliveryStateSchema = z.enum(DELIVERY_STATES);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;
export const DeliveryChannelSchema = z.enum(['email', 'sms', 'messenger', 'push']);
export type DeliveryChannel = z.infer<typeof DeliveryChannelSchema>;
/** Hub console view: counts only, never per-person tracking (handbook: deliverability as counts). */
export const DeliveryCountsSchema = z.strictObject({ items: z.array(z.strictObject({ channel: DeliveryChannelSchema, state: DeliveryStateSchema, count: z.int().min(0) })) });

/** Outbox events of this module carry identifiers only (never a body, a parameter value or an address). */
export const COMMS_EVENT_PAYLOAD_KEYS = ['threadId', 'messageId', 'notificationId', 'deliveryId', 'contextKind', 'contextId'] as const;
export const COMMS_EGRESS = { search: false, retrieval: false, federation: false, publicProjection: false, notificationPayload: 'recipient_visible_only' } as const;
