import type { AccessInventory } from '../inventory.js';

/** CONS-001 (packages/data/migrations/consultations): consultations and mentoring from plan items. */
export default {
  package: 'CONS-001',
  forcedTables: [
    'availability_window', 'consultation_booking', 'consultation_deliverable', 'consultation_offering', 'consultation_reminder', 'consultation_request', 'consultation_request_private',
    'consultation_session', 'mentoring_relationship',
  ],
  apiDefiners: [
    'consultation_booking_side', 'consultation_booking_site', 'consultation_credential_facts', 'consultation_current_version', 'consultation_free_windows', 'consultation_licence_usable',
    'consultation_offering_facts', 'consultation_public_deliverable', 'consultation_public_offerings', 'consultation_reserve_capacity', 'consultation_window_booked', 'consultation_window_facts',
  ],
  workerDefiners: ['comms_consultation_mail_hub', 'comms_consultation_for_hub', 'comms_consultation_due', 'comms_consultation_templates', 'comms_produce_consultation_reminder', 'comms_consultation_enqueue_mail', 'comms_consultation_mail_allowed',
    'comms_consultation_channel_job', 'comms_consultation_channel_claim', 'comms_consultation_channel_settle', 'comms_consultation_channel_reconcile'],
  internalDefiners: ['consultation_booking_sync_request'],
} satisfies AccessInventory;
