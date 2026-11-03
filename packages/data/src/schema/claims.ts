import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Claims module (CLM-001, packages/data/migrations/claims): company claims against hub recipe versions, disputes
 * decided by two reviewers, hand-overs at the claimed or verified level with a cooling period, and hub claim settings.
 * The runtime role reads under row-level security (staff of the hub with a claims permission; a claimant their own
 * claims and hand-overs) and writes only through the `claims_*` SECURITY DEFINER commands (repositories/claims.ts).
 */
export type ClaimLevel = 'claimed' | 'verified';
export type ClaimState = 'open' | 'waiting' | 'disputed' | 'approved' | 'rejected' | 'withdrawn';

export interface ClaimsSettingsTable {
  hub_id: string;
  waiting_days: Generated<number>;
  cooling_days: Generated<number>;
  updated_by: string;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type ClaimsSettingsRow = Selectable<ClaimsSettingsTable>;

export interface ClaimDisputeTable {
  id: Generated<string>;
  hub_id: string;
  company_id: string;
  state: Generated<'open' | 'decided' | 'dissolved'>;
  proposed_claim_id: string | null;
  proposed_none: Generated<boolean>;
  proposed_by: string | null;
  proposed_note: string | null;
  confirmed_by: string | null;
  decided_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
}
export type ClaimDisputeRow = Selectable<ClaimDisputeTable>;

export interface CompanyClaimTable {
  id: Generated<string>;
  hub_id: string;
  company_id: string;
  claimant_id: string;
  level: ClaimLevel;
  recipe_id: string;
  domain_tie: 'invitation_link' | 'own_domain_mailbox' | 'register_officer_match' | null;
  domain_tie_domain: string | null;
  state: ClaimState;
  waiting_until: Date | null;
  dispute_id: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
}
export type CompanyClaimRow = Selectable<CompanyClaimTable>;

export interface CompanyHandoverTable {
  id: Generated<string>;
  hub_id: string;
  company_id: string;
  claim_id: string;
  person_id: string;
  level: ClaimLevel;
  membership_id: string | null;
  decided_by: string;
  cooling_until: Date;
  created_at: Generated<Date>;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}
export type CompanyHandoverRow = Selectable<CompanyHandoverTable>;

/** A verification check bound to one claim: a decision counts only these. Append-only. */
export interface CompanyClaimEvidenceTable {
  claim_id: string;
  check_id: string;
  bound_by: string;
  bound_at: Generated<Date>;
}

export interface CompanyVerificationTable {
  id: Generated<string>;
  hub_id: string;
  company_id: string;
  handover_id: string;
  level: ClaimLevel;
  recipe_id: string;
  categories: string[];
  state: Generated<'active' | 'expired' | 'revoked' | 'superseded'>;
  decided_by: string;
  decided_at: Generated<Date>;
  valid_until: Date;
  renewed_from: string | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revocation_reason_code: string | null;
}
export type CompanyVerificationRow = Selectable<CompanyVerificationTable>;

/** No runtime grant on these five: readers go through `claims_public_records`, `claims_company_records` and `claims_staff_records`. */
export interface CompanyProfileTable {
  company_id: string;
  legal_form: string | null;
  website_url: string | null;
  region_code: string | null;
  categories: Generated<string[]>;
  public_fields: Generated<string[]>;
  revision: Generated<number>;
  updated_by: string;
  updated_at: Generated<Date>;
}
export type CompanyProfileRow = Selectable<CompanyProfileTable>;

export interface CompanyIdentifierTable {
  id: Generated<string>;
  company_id: string;
  kind: string;
  jurisdiction: string | null;
  value: string;
  value_normalized: string;
  status: 'sourced' | 'claimed' | 'verified';
  source_ref: string | null;
  verification_check_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  retired_at: Date | null;
  revision: Generated<number>;
}
export type CompanyIdentifierRow = Selectable<CompanyIdentifierTable>;

export interface CompanyRegistrationTable {
  id: Generated<string>;
  company_id: string;
  jurisdiction: string;
  kind: 'formation' | 'foreign_qualification' | 'dba' | 'branch';
  registered_name: string;
  number: string | null;
  status: Generated<'active' | 'inactive' | 'unknown'>;
  observed_at: Date | null;
  source_ref: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  retired_at: Date | null;
}

export interface TaxRegistrationTable {
  id: Generated<string>;
  company_id: string;
  jurisdiction: string;
  kind: string;
  number: string;
  status: Generated<'active' | 'inactive' | 'unknown'>;
  valid_until: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  retired_at: Date | null;
}

export interface CompanyBranchTable {
  id: Generated<string>;
  company_id: string;
  hub_id: string;
  name: string;
  address: Generated<unknown>;
  region_code: string | null;
  public: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  retired_at: Date | null;
}

export interface ClaimsDatabase {
  company_claim_evidence: CompanyClaimEvidenceTable;
  company_profile: CompanyProfileTable;
  company_identifier: CompanyIdentifierTable;
  company_registration: CompanyRegistrationTable;
  tax_registration: TaxRegistrationTable;
  company_branch: CompanyBranchTable;
  company_verification: CompanyVerificationTable;
  claims_settings: ClaimsSettingsTable;
  claim_dispute: ClaimDisputeTable;
  company_claim: CompanyClaimTable;
  company_handover: CompanyHandoverTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ClaimsDatabase {}
}

const columns = columnsOf<ClaimsDatabase>();
export const TABLE_COLUMNS: TableColumns<ClaimsDatabase> = {
  company_claim_evidence: columns('company_claim_evidence', ['claim_id', 'check_id', 'bound_by', 'bound_at']),
  company_profile: columns('company_profile', ['company_id', 'legal_form', 'website_url', 'region_code', 'categories', 'public_fields', 'revision', 'updated_by', 'updated_at']),
  company_identifier: columns('company_identifier', [
    'id', 'company_id', 'kind', 'jurisdiction', 'value', 'value_normalized', 'status', 'source_ref', 'verification_check_id', 'created_by', 'created_at', 'retired_at', 'revision',
  ]),
  company_registration: columns('company_registration', ['id', 'company_id', 'jurisdiction', 'kind', 'registered_name', 'number', 'status', 'observed_at', 'source_ref', 'created_by', 'created_at', 'retired_at']),
  tax_registration: columns('tax_registration', ['id', 'company_id', 'jurisdiction', 'kind', 'number', 'status', 'valid_until', 'created_by', 'created_at', 'retired_at']),
  company_branch: columns('company_branch', ['id', 'company_id', 'hub_id', 'name', 'address', 'region_code', 'public', 'created_by', 'created_at', 'retired_at']),
  company_verification: columns('company_verification', [
    'id', 'hub_id', 'company_id', 'handover_id', 'level', 'recipe_id', 'categories', 'state', 'decided_by', 'decided_at', 'valid_until', 'renewed_from', 'revoked_at', 'revoked_by', 'revocation_reason_code',
  ]),
  claims_settings: columns('claims_settings', ['hub_id', 'waiting_days', 'cooling_days', 'updated_by', 'revision', 'updated_at']),
  claim_dispute: columns('claim_dispute', [
    'id', 'hub_id', 'company_id', 'state', 'proposed_claim_id', 'proposed_none', 'proposed_by', 'proposed_note', 'confirmed_by', 'decided_at', 'revision', 'created_at',
  ]),
  company_claim: columns('company_claim', [
    'id', 'hub_id', 'company_id', 'claimant_id', 'level', 'recipe_id', 'domain_tie', 'domain_tie_domain', 'state', 'waiting_until', 'dispute_id', 'decided_by', 'decided_at',
    'decision_note', 'revision', 'created_at',
  ]),
  company_handover: columns('company_handover', [
    'id', 'hub_id', 'company_id', 'claim_id', 'person_id', 'level', 'membership_id', 'decided_by', 'cooling_until', 'created_at', 'revoked_at', 'revoked_by', 'revoke_reason',
  ]),
};
