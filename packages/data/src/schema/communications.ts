import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Communications (COMMS-001, packages/data/migrations/communications): context threads and append-only messages whose
 * readers are derived live from the context, message links, reply tokens (hashes), channel grants, send receipts,
 * notifications with template-restricted parameters, preferences, versioned templates, deliveries and hub sender
 * identities. Every table is under FORCE RLS; reply tokens, deliveries, templates and sender identities are reached
 * through SECURITY DEFINER functions only. `suppression_entry` is MAIL-001's table (schema/mail.ts).
 */
export type ThreadContextKindValue = 'project' | 'rfq' | 'quote' | 'agreement' | 'order' | 'task_request' | 'task_assignment';
export type MessageDirectionValue = 'inbound' | 'outbound' | 'internal';
export type MessageAuthorKindValue = 'person' | 'agent' | 'system';
export type ChannelProviderValue = 'email' | 'telegram' | 'whatsapp' | 'sms' | 'other';
export type NotificationCategoryValue = 'messages' | 'commerce' | 'tasks' | 'projects' | 'account' | 'legal';
export type NotificationChannelValue = 'email' | 'messenger' | 'sms';
export type NotificationFrequencyValue = 'immediate' | 'daily' | 'weekly' | 'off';
export type TemplateVersionStatusValue = 'draft' | 'active' | 'retired';
export type DeliveryChannelValue = 'email' | 'sms' | 'messenger' | 'push';
export type DeliveryStateValue = 'queued' | 'sent' | 'delivered' | 'bounced' | 'failed' | 'outcome_unknown' | 'suppressed' | 'skipped';
/** jsonb: read as parsed JSON, written as a JSON string. */
type Jsonb<T = unknown> = ColumnType<T, string | undefined, string>;
/** bigint: node-postgres returns int8 as a string. */
type Int8 = ColumnType<string, never, never>;

export interface ContextThreadTable {
  id: GeneratedUuid;
  context_kind: ThreadContextKindValue;
  context_id: string;
  counterparty_person_id: string | null;
  counterparty_company_id: string | null;
  subject: string;
  status: Generated<'open' | 'closed'>;
  opened_by_person_id: string;
  last_message_at: Timestamp | null;
  message_count: Generated<number>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface MessageTable {
  id: GeneratedUuid;
  seq: Int8;
  thread_id: string;
  direction: MessageDirectionValue;
  author_kind: MessageAuthorKindValue;
  author_person_id: string | null;
  on_behalf_person_id: string | null;
  on_behalf_company_id: string | null;
  mandate_id: string | null;
  body: string;
  attachments: Jsonb<unknown[]>;
  source_time: GeneratedTimestamp;
  received_at: GeneratedTimestamp;
  provider: ChannelProviderValue | null;
  provider_message_id: string | null;
  channel_grant_id: string | null;
  sender_claim: string | null;
  untrusted: Generated<boolean>;
}
export interface MessageLinkTable {
  id: GeneratedUuid;
  message_id: string;
  object_kind: string;
  object_id: string;
  version_id: string | null;
  created_at: GeneratedTimestamp;
}
export interface ReplyTokenTable {
  id: GeneratedUuid;
  thread_id: string;
  person_id: string;
  channel_grant_id: string | null;
  delivery_id: string | null;
  token_hash: string;
  expires_at: Timestamp;
  created_at: GeneratedTimestamp;
}
export interface ChannelGrantTable {
  id: GeneratedUuid;
  person_id: string;
  provider: ChannelProviderValue;
  account_ref: string;
  account_display: string;
  scopes: Jsonb<{ contextKinds: ThreadContextKindValue[]; actions: ('notify' | 'reply')[] }>;
  credential_ref: string | null;
  status: Generated<'active' | 'revoked'>;
  granted_at: GeneratedTimestamp;
  revoked_at: Timestamp | null;
}
export interface SendReceiptTable {
  id: GeneratedUuid;
  delivery_id: string | null;
  message_id: string | null;
  provider: string;
  provider_ref: string | null;
  state: 'accepted' | 'delivered' | 'bounced' | 'failed' | 'unknown';
  observed_at: GeneratedTimestamp;
}
export interface NotificationTable {
  id: GeneratedUuid;
  seq: Int8;
  recipient_person_id: string;
  category: NotificationCategoryValue;
  template_key: string;
  params: Jsonb<Record<string, string>>;
  link_kind: ThreadContextKindValue | null;
  link_id: string | null;
  link_thread_id: string | null;
  transactional: boolean;
  dedupe_key: string;
  created_by_person_id: string | null;
  created_at: GeneratedTimestamp;
  read_at: Timestamp | null;
  dismissed_at: Timestamp | null;
}
export interface NotificationPreferenceTable {
  person_id: string;
  category: NotificationCategoryValue;
  channel: NotificationChannelValue;
  frequency: NotificationFrequencyValue;
  updated_at: GeneratedTimestamp;
}
export interface MessageTemplateTable {
  id: GeneratedUuid;
  hub_id: string;
  key: string;
  category: NotificationCategoryValue;
  transactional: boolean;
  created_at: GeneratedTimestamp;
}
export interface TemplateVersionTable {
  id: GeneratedUuid;
  template_id: string;
  version: number;
  locale: string;
  subject: string;
  body: string;
  status: Generated<TemplateVersionStatusValue>;
  drafted_by_person_id: string;
  activated_by_person_id: string | null;
  activated_at: Timestamp | null;
  retired_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface DeliveryTable {
  id: GeneratedUuid;
  notification_id: string | null;
  message_id: string | null;
  recipient_person_id: string;
  channel: DeliveryChannelValue;
  provider: string;
  channel_grant_id: string | null;
  attempt: Generated<number>;
  state: Generated<DeliveryStateValue>;
  reason: string | null;
  provider_event_id: string | null;
  provider_ref: string | null;
  mail_delivery_id: string | null;
  consultation_job_id: string | null;
  created_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface SenderIdentityTable {
  id: GeneratedUuid;
  hub_id: string;
  kind: 'email_domain' | 'sms_sender' | 'messenger_bot';
  value: string;
  mode: Generated<'fake' | 'live'>;
  verification: Jsonb<Record<string, unknown>>;
  status: Generated<'draft' | 'verifying' | 'active' | 'disabled'>;
  created_by_person_id: string;
  activated_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ContextThreadRow = Selectable<ContextThreadTable>;
export type MessageRow = Selectable<MessageTable>;
export type MessageLinkRow = Selectable<MessageLinkTable>;
export type ChannelGrantRow = Selectable<ChannelGrantTable>;
export type NotificationRow = Selectable<NotificationTable>;
export type NotificationPreferenceRow = Selectable<NotificationPreferenceTable>;
export type TemplateVersionRow = Selectable<TemplateVersionTable>;
export type DeliveryRow = Selectable<DeliveryTable>;

export interface CommunicationsDatabase {
  context_thread: ContextThreadTable;
  message: MessageTable;
  message_link: MessageLinkTable;
  reply_token: ReplyTokenTable;
  channel_grant: ChannelGrantTable;
  send_receipt: SendReceiptTable;
  notification: NotificationTable;
  notification_preference: NotificationPreferenceTable;
  message_template: MessageTemplateTable;
  template_version: TemplateVersionTable;
  delivery: DeliveryTable;
  sender_identity: SenderIdentityTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends CommunicationsDatabase {}
}

const columns = columnsOf<CommunicationsDatabase>();
export const TABLE_COLUMNS: TableColumns<CommunicationsDatabase> = {
  context_thread: columns('context_thread', ['id', 'context_kind', 'context_id', 'counterparty_person_id', 'counterparty_company_id', 'subject', 'status', 'opened_by_person_id', 'last_message_at', 'message_count', 'revision', 'created_at', 'updated_at']),
  message: columns('message', ['id', 'seq', 'thread_id', 'direction', 'author_kind', 'author_person_id', 'on_behalf_person_id', 'on_behalf_company_id', 'mandate_id', 'body', 'attachments', 'source_time', 'received_at', 'provider', 'provider_message_id', 'channel_grant_id', 'sender_claim', 'untrusted']),
  message_link: columns('message_link', ['id', 'message_id', 'object_kind', 'object_id', 'version_id', 'created_at']),
  reply_token: columns('reply_token', ['id', 'thread_id', 'person_id', 'channel_grant_id', 'delivery_id', 'token_hash', 'expires_at', 'created_at']),
  channel_grant: columns('channel_grant', ['id', 'person_id', 'provider', 'account_ref', 'account_display', 'scopes', 'credential_ref', 'status', 'granted_at', 'revoked_at']),
  send_receipt: columns('send_receipt', ['id', 'delivery_id', 'message_id', 'provider', 'provider_ref', 'state', 'observed_at']),
  notification: columns('notification', ['id', 'seq', 'recipient_person_id', 'category', 'template_key', 'params', 'link_kind', 'link_id', 'link_thread_id', 'transactional', 'dedupe_key', 'created_by_person_id', 'created_at', 'read_at', 'dismissed_at']),
  notification_preference: columns('notification_preference', ['person_id', 'category', 'channel', 'frequency', 'updated_at']),
  message_template: columns('message_template', ['id', 'hub_id', 'key', 'category', 'transactional', 'created_at']),
  template_version: columns('template_version', ['id', 'template_id', 'version', 'locale', 'subject', 'body', 'status', 'drafted_by_person_id', 'activated_by_person_id', 'activated_at', 'retired_at', 'revision', 'created_at', 'updated_at']),
  delivery: columns('delivery', ['id', 'notification_id', 'message_id', 'recipient_person_id', 'channel', 'provider', 'channel_grant_id', 'attempt', 'state', 'reason', 'provider_event_id', 'provider_ref', 'mail_delivery_id', 'consultation_job_id', 'created_by_person_id', 'revision', 'created_at', 'updated_at']),
  sender_identity: columns('sender_identity', ['id', 'hub_id', 'kind', 'value', 'mode', 'verification', 'status', 'created_by_person_id', 'activated_by_person_id', 'revision', 'created_at', 'updated_at']),
};
