import type { AccessInventory } from '../inventory.js';

export default {
  package: 'PRV-001',
  forcedTables: ['source_field_resolution', 'source_privacy_replay_receipt', 'privacy_source_hold', 'privacy_source_plan', 'support_external_source_subject', 'data_broker_registration', 'legal_hold', 'privacy_country_policy', 'privacy_export', 'privacy_preference', 'privacy_propagation', 'privacy_registry_intake', 'privacy_replay_receipt', 'privacy_request', 'privacy_source_proof', 'privacy_source_request', 'privacy_subject_plan', 'privacy_suppression'],
  apiDefiners: ['support_privacy_access_records', 'files_privacy_export_lock', 'privacy_source_plan_propose', 'privacy_source_plan_approve', 'privacy_source_plan_admit', 'privacy_source_plan_execute', 'privacy_source_hold_place', 'support_open_external_source_case', 'privacy_erasure_check', 'privacy_export_create', 'privacy_hold_place', 'privacy_hold_release', 'privacy_marketing_object', 'privacy_plan_approve', 'privacy_plan_execute', 'privacy_plan_propose', 'privacy_preference_set', 'privacy_registry_receive', 'privacy_request_create', 'privacy_source_prove', 'privacy_source_submit', 'privacy_subject_authorized', 'privacy_subject_erased'],
  workerDefiners: ['privacy_marketing_allowed', 'privacy_propagation_get', 'privacy_propagation_record'],
  internalDefiners: ['privacy_source_activation_guard', 'privacy_source_collect_guard'],
} satisfies AccessInventory;
