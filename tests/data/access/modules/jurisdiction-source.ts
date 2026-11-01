import type { AccessInventory } from '../inventory.js';
export default {
  package: 'HUB-005',
  forcedTables: ['jurisdiction_issuer_version', 'jurisdiction_issuer_activation', 'jurisdiction_issuer_current', 'jurisdiction_issuer_revocation', 'jurisdiction_proof_record', 'jurisdiction_proof_current', 'jurisdiction_proof_revocation', 'jurisdiction_applicability_origin', 'jurisdiction_scoped_head'],
  apiDefiners: ['jurisdiction_issuer_propose', 'jurisdiction_issuer_activate', 'jurisdiction_source_revoke', 'jurisdiction_agreement_limits'],
  workerDefiners: [], internalDefiners: [],
} satisfies AccessInventory;
