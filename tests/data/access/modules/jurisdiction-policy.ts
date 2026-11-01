import type { AccessInventory } from '../inventory.js';
export default {
  package: 'HUB-005',
  forcedTables: ['jurisdiction_source', 'jurisdiction_source_current', 'jurisdiction_applicability', 'jurisdiction_applicability_current', 'jurisdiction_intent_binding', 'jurisdiction_consent_receipt', 'jurisdiction_consent_revocation', 'jurisdiction_applicability_review', 'jurisdiction_applicability_activation'],
  apiDefiners: ['jurisdiction_limits', 'jurisdiction_bind_intent', 'jurisdiction_recheck_intent', 'jurisdiction_preflight', 'jurisdiction_consent_preview', 'jurisdiction_consent_grant', 'jurisdiction_consent_revoke', 'jurisdiction_applicability_propose', 'jurisdiction_applicability_activate', 'jurisdiction_disclosure_bundle'],
  workerDefiners: ['jurisdiction_begin_attempt'],
  internalDefiners: ['hubs_activate_config_base', 'jurisdiction_config_guard', 'jurisdiction_language_guard'],
} satisfies AccessInventory;
