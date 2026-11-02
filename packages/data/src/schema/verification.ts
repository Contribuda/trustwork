import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Verification module (HUB-003, packages/data/migrations/verification; docs/engine/hub-administration.md
 * "Verification"): providers in fake, manual or live mode, versioned recipes that always carry the sanctions check, and
 * append-only check results with expiry. The runtime role reads under row-level security (staff of the hub with a
 * claims permission) and writes only through the `verification_*` SECURITY DEFINER commands
 * (repositories/verification.ts).
 */
export type VerificationProviderMode = 'fake' | 'manual' | 'live';
export type VerificationCheckResult = 'pass' | 'fail' | 'inconclusive' | 'unavailable';
export type VerificationStepJson = { check: string; required: boolean } | { anyOf: string[] };

export interface VerificationProviderTable {
  id: Generated<string>;
  hub_id: string;
  check_type: string;
  adapter: string;
  mode: VerificationProviderMode;
  credential_ref_id: string | null;
  approval_id: string | null;
  retention_days: number;
  legal_basis: string;
  cost_minor: string | null;
  status: 'active' | 'retired';
  revision: number;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type VerificationProviderRow = Selectable<VerificationProviderTable>;

export interface VerificationRecipeTable {
  id: Generated<string>;
  hub_id: string;
  key: string;
  version: number;
  subject_kind: 'company' | 'person';
  trigger: string;
  steps: VerificationStepJson[];
  badge_categories: string[];
  recheck_months: number;
  status: 'draft' | 'active' | 'superseded';
  drafted_by: string;
  activated_by: string | null;
  activated_at: Date | null;
  revision: number;
  created_at: Generated<Date>;
}
export type VerificationRecipeRow = Selectable<VerificationRecipeTable>;

export interface VerificationCheckTable {
  id: Generated<string>;
  hub_id: string;
  subject_person_id: string | null;
  subject_company_id: string | null;
  recipe_id: string;
  check_type: string;
  provider_id: string | null;
  mode: VerificationProviderMode | 'screening';
  result: VerificationCheckResult;
  evidence_ref: string | null;
  screening_state_id: string | null;
  screening_state_revision: number | null;
  recorded_by: string;
  recorded_at: Generated<Date>;
  expires_at: Date;
}
export type VerificationCheckRow = Selectable<VerificationCheckTable>;

export interface VerificationAppealTable {
  id: Generated<string>;
  hub_id: string;
  check_id: string;
  filed_by: string;
  reason: string;
  status: 'open' | 'upheld' | 'overturned';
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  new_check_id: string | null;
  revision: number;
  created_at: Generated<Date>;
}
export type VerificationAppealRow = Selectable<VerificationAppealTable>;

export interface VerificationDatabase {
  verification_provider: VerificationProviderTable;
  verification_recipe: VerificationRecipeTable;
  verification_check: VerificationCheckTable;
  verification_appeal: VerificationAppealTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends VerificationDatabase {}
}

const columns = columnsOf<VerificationDatabase>();
export const TABLE_COLUMNS: TableColumns<VerificationDatabase> = {
  verification_provider: columns('verification_provider', [
    'id', 'hub_id', 'check_type', 'adapter', 'mode', 'credential_ref_id', 'approval_id', 'retention_days', 'legal_basis', 'cost_minor', 'status', 'revision', 'created_by',
    'created_at', 'updated_at',
  ]),
  verification_recipe: columns('verification_recipe', [
    'id', 'hub_id', 'key', 'version', 'subject_kind', 'trigger', 'steps', 'badge_categories', 'recheck_months', 'status', 'drafted_by', 'activated_by', 'activated_at', 'revision',
    'created_at',
  ]),
  verification_check: columns('verification_check', [
    'id', 'hub_id', 'subject_person_id', 'subject_company_id', 'recipe_id', 'check_type', 'provider_id', 'mode', 'result', 'evidence_ref', 'screening_state_id',
    'screening_state_revision', 'recorded_by', 'recorded_at', 'expires_at',
  ]),
  verification_appeal: columns('verification_appeal', [
    'id', 'hub_id', 'check_id', 'filed_by', 'reason', 'status', 'decided_by', 'decided_at', 'decision_note', 'new_check_id', 'revision', 'created_at',
  ]),
};
