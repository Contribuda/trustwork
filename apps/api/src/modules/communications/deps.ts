/**
 * Relative re-exports of the communications slice (COMMS-001). The module imports its repository file directly so the
 * shared data entry (`packages/data/src/index.ts`) stays untouched; adding it there is integrator bookkeeping. The
 * contracts are part of the client barrel.
 */
export {
  channelGrants, commsContexts, deliveries, mailSuppression, messages, messageTemplates, notificationPreferences, notifications, threads,
  type NewMessage, type PlannedDelivery, type ThreadSideValue,
} from '../../../../../packages/data/src/repositories/communications.js';
export type {
  ChannelGrantRow, ContextThreadRow, MessageLinkRow, MessageRow, NotificationRow, NotificationPreferenceRow, TemplateVersionRow, ThreadContextKindValue,
} from '../../../../../packages/data/src/schema/communications.js';
