import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';
import type { GeneratedTimestamp, Timestamp } from './foundation.js';

/**
 * Mail module (MAIL-001, packages/data/migrations/mail): transactional mail deliveries recorded by the API in the
 * transaction of the change and delivered by apps/worker, plus the suppression list fed by bounce and complaint
 * receipts. The recipient address and the sealed one-time secret are cleared when a delivery reaches a final state.
 * `notification` (COMMS-001) carries a subject and body already rendered from the hub's active template version.
 */
export const MAIL_TEMPLATES = ['verify_email', 'already_registered', 'recovery', 'email_change', 'membership_invitation', 'security_notice', 'notification', 'screening_notice'] as const;
export type MailTemplateName = (typeof MAIL_TEMPLATES)[number];
export const MAIL_DELIVERY_STATES = ['pending', 'sending', 'sent', 'suppressed', 'rate_limited', 'expired', 'failed'] as const;
export type MailDeliveryState = (typeof MAIL_DELIVERY_STATES)[number];
/** States after which nothing is sent and the personal data is gone. */
export const MAIL_FINAL_STATES: readonly MailDeliveryState[] = ['sent', 'suppressed', 'rate_limited', 'expired', 'failed'];
export type MailFeedback = 'delivered' | 'soft_bounce' | 'hard_bounce' | 'complaint';
export type SuppressionReason = 'bounce' | 'complaint' | 'unsubscribe' | 'legal';

export interface MailDeliveryTable {
  id: string;
  seq: Generated<string>;
  template: MailTemplateName;
  locale_preferences: ColumnType<string[], string[] | undefined, string[]>;
  recipient: string | null;
  recipient_hash: string;
  params: ColumnType<Record<string, string>, string | undefined, string>;
  sealed_secret: Buffer | null;
  secret_expires_at: Timestamp | null;
  state: ColumnType<MailDeliveryState, MailDeliveryState | undefined, MailDeliveryState>;
  job_id: string | null;
  attempt_ref: string | null;
  claimed_at: Timestamp | null;
  sent_at: Timestamp | null;
  provider_message_id: string | null;
  feedback: MailFeedback | null;
  feedback_at: Timestamp | null;
  last_error: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export type MailDelivery = Selectable<MailDeliveryTable>;

export interface SuppressionEntryTable {
  address_hash: string;
  reason: SuppressionReason;
  source: string;
  delivery_id: string | null;
  created_at: GeneratedTimestamp;
}
export type SuppressionEntry = Selectable<SuppressionEntryTable>;

export interface MailDatabase {
  mail_delivery: MailDeliveryTable;
  suppression_entry: SuppressionEntryTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends MailDatabase {}
}

const columns = columnsOf<MailDatabase>();
export const TABLE_COLUMNS: TableColumns<MailDatabase> = {
  mail_delivery: columns('mail_delivery', ['id', 'seq', 'template', 'locale_preferences', 'recipient', 'recipient_hash', 'params', 'sealed_secret', 'secret_expires_at', 'state', 'job_id', 'attempt_ref', 'claimed_at', 'sent_at', 'provider_message_id', 'feedback', 'feedback_at', 'last_error', 'created_at', 'updated_at']),
  suppression_entry: columns('suppression_entry', ['address_hash', 'reason', 'source', 'delivery_id', 'created_at']),
};
