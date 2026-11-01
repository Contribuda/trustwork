import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';
import type { GeneratedTimestamp, GeneratedUuid, Timestamp } from './foundation.js';

/**
 * Identity module slice (packages/data/migrations/identity): second factors, recovery codes, sign-in challenges,
 * elevated sessions and support resets (BE-004). The person, binding, credential and session tables stay in the
 * foundation mirror. `recovery_code.code_hash` and `second_factor_challenge.token_hash` are write-only for the runtime
 * role (column privileges), so repositories never select them.
 */
export type SecondFactorKind = 'totp';
export type SecondFactorState = 'pending' | 'active' | 'revoked';
export type SecondFactorRevokedReason = 'removed' | 'abandoned' | 'support_reset';
export type ElevationFactorKind = 'totp' | 'recovery_code';
export type ElevationRevokedReason = 'ended' | 'replaced' | 'factor_changed' | 'session_ended';
export type ChallengeAuthMethod = 'password' | 'google' | 'apple';
export type SecondFactorResetState = 'pending' | 'cooling_off' | 'done' | 'cancelled';

export interface SecondFactorTable {
  id: string;
  person_id: string;
  kind: SecondFactorKind;
  state: SecondFactorState;
  secret_sealed: Buffer;
  last_used_step: string | number | bigint | null;
  pending_expires_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  activated_at: Timestamp | null;
  last_used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  revoked_reason: SecondFactorRevokedReason | null;
}
export type SecondFactorRow = Selectable<SecondFactorTable>;

export interface RecoveryCodeTable {
  id: GeneratedUuid;
  person_id: string;
  batch_id: string;
  code_hash: Buffer;
  created_at: GeneratedTimestamp;
  used_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

export interface SecondFactorChallengeTable {
  id: GeneratedUuid;
  person_id: string;
  token_hash: Buffer;
  auth_method: ChallengeAuthMethod;
  created_at: GeneratedTimestamp;
  expires_at: Timestamp;
  attempts: Generated<number>;
  consumed_at: Timestamp | null;
}

export interface SessionElevationTable {
  id: GeneratedUuid;
  session_id: string;
  person_id: string;
  factor_kind: ElevationFactorKind;
  created_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_reason: ElevationRevokedReason | null;
}
export type SessionElevationRow = Selectable<SessionElevationTable>;

export interface SecondFactorResetTable {
  id: GeneratedUuid;
  subject_person_id: string;
  support_case_id: string;
  evidence_refs: string[];
  reason: string;
  requested_by: string;
  requested_at: GeneratedTimestamp;
  approved_by: string | null;
  approved_at: Timestamp | null;
  effective_at: Timestamp | null;
  state: Generated<SecondFactorResetState>;
  cancelled_by: string | null;
  cancelled_at: Timestamp | null;
  executed_by: string | null;
  executed_at: Timestamp | null;
}
export type SecondFactorResetRow = Selectable<SecondFactorResetTable>;

/** The language a person last used for their own account actions (QA-002 D5): for mail someone else causes for them. */
export type MailLocaleSource = 'sign_in' | 'email_verified';
export interface PersonMailLocaleTable {
  person_id: string;
  locale: string;
  source: MailLocaleSource;
  updated_at: GeneratedTimestamp;
}

export interface IdentityDatabase {
  second_factor: SecondFactorTable;
  recovery_code: RecoveryCodeTable;
  second_factor_challenge: SecondFactorChallengeTable;
  session_elevation: SessionElevationTable;
  second_factor_reset: SecondFactorResetTable;
  person_mail_locale: PersonMailLocaleTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends IdentityDatabase {}
}

const columns = columnsOf<IdentityDatabase>();
export const TABLE_COLUMNS: TableColumns<IdentityDatabase> = {
  second_factor: columns('second_factor', ['id', 'person_id', 'kind', 'state', 'secret_sealed', 'last_used_step', 'pending_expires_at', 'created_at', 'activated_at', 'last_used_at', 'revoked_at', 'revoked_reason']),
  recovery_code: columns('recovery_code', ['id', 'person_id', 'batch_id', 'code_hash', 'created_at', 'used_at', 'revoked_at']),
  second_factor_challenge: columns('second_factor_challenge', ['id', 'person_id', 'token_hash', 'auth_method', 'created_at', 'expires_at', 'attempts', 'consumed_at']),
  session_elevation: columns('session_elevation', ['id', 'session_id', 'person_id', 'factor_kind', 'created_at', 'expires_at', 'revoked_at', 'revoked_reason']),
  second_factor_reset: columns('second_factor_reset', [
    'id', 'subject_person_id', 'support_case_id', 'evidence_refs', 'reason', 'requested_by', 'requested_at', 'approved_by', 'approved_at', 'effective_at', 'state',
    'cancelled_by', 'cancelled_at', 'executed_by', 'executed_at',
  ]),
  person_mail_locale: columns('person_mail_locale', ['person_id', 'locale', 'source', 'updated_at']),
};
