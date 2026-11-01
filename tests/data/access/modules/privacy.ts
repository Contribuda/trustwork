import type { AccessInventory } from '../inventory.js';

export default {
  package: 'PRV-001',
  forcedTables: ['data_broker_registration', 'legal_hold', 'privacy_country_policy', 'privacy_export', 'privacy_preference', 'privacy_replay_receipt', 'privacy_request', 'privacy_suppression'],
  apiDefiners: ['privacy_erasure_check', 'privacy_export_create', 'privacy_hold_place', 'privacy_hold_release', 'privacy_preference_set', 'privacy_request_create', 'privacy_subject_authorized', 'privacy_subject_erased'],
} satisfies AccessInventory;
