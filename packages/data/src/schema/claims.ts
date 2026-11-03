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

export interface ClaimsDatabase {
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
