import type { AccessInventory } from '../inventory.js';

/** COMMS-001: context threads, messages, notifications, channel grants, templates and deliveries. */
export default {
  package: 'COMMS-001',
  forcedTables: [
    'context_thread', 'message', 'message_link', 'reply_token', 'channel_grant', 'send_receipt', 'notification', 'notification_preference', 'message_template',
    'template_version', 'delivery', 'sender_identity',
  ],
  apiDefiners: [
    'comms_my_side', 'comms_thread_readable', 'comms_thread_id_readable', 'comms_can_open', 'comms_can_post', 'comms_thread_people', 'comms_fanout_message', 'comms_notify',
    'comms_enqueue_mail', 'comms_settle_delivery', 'comms_issue_reply_token', 'comms_resolve_reply_token', 'comms_mail_unsubscribe', 'comms_mail_suppression',
    'comms_template_staff', 'comms_template_draft', 'comms_template_activate', 'comms_template_versions', 'comms_active_template', 'comms_delivery_counts',
  ],
  internalDefiners: ['comms_thread_guard', 'comms_message_counted'],
} satisfies AccessInventory;
