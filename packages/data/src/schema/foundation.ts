import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';

/**
 * Foundation module of the hand-written Kysely model of the `trustwork` schema: one interface per table created by
 * the flat-root migrations in packages/data/migrations (identity, company, access, projects, reliability, admission).
 * Every schema module file in this directory exports `TABLE_COLUMNS`; tests/data/migrations.test.ts discovers the
 * module files by listing the directory and diffs their union against information_schema. Module slices never edit
 * this file: they add packages/data/src/schema/<module>.ts (see packages/data/README.md, "Parallel slices").
 */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type GeneratedUuid = Generated<string>;
export type GeneratedInt = Generated<number>;

export type ProfileVisibility = 'private' | 'public';
export type CredentialKind = 'password' | 'google' | 'apple' | 'totp' | 'webauthn' | 'recovery_code';
export type Provider = 'google' | 'apple';
export type AuthMethod = 'password' | 'google' | 'apple' | 'recovery';
export type SessionRevokedReason = 'logout' | 'logout_all' | 'password_change' | 'recovery' | 'admin' | 'expired' | 'suspicious';
export type AuthTokenKind = 'verify_email' | 'email_change' | 'recovery' | 'membership_invitation';
export type SourcedStatus = 'sourced' | 'registered';
export type ClaimStatus = 'unclaimed' | 'claimed' | 'verified';
export type MembershipRole = 'member' | 'administrator';
export type MembershipStatus = 'invited' | 'active' | 'declined' | 'expired' | 'withdrawn' | 'ended';
export type ResourceKind = 'project' | 'rfq' | 'quote' | 'agreement' | 'order' | 'thread' | 'publication';
export type Side = 'owner' | 'buyer' | 'seller' | 'participant' | 'staff';
export type GrantAudience = 'shared_party' | 'party_private' | 'owner_private';
export type ProjectStatus = 'planned' | 'active' | 'suspended' | 'completed' | 'cancelled';
export type OwnershipTransferStatus = 'proposed' | 'accepted_by_recipient' | 'effective' | 'rejected' | 'expired' | 'withdrawn';
export type JobState = 'queued' | 'leased' | 'succeeded' | 'failed' | 'dead' | 'outcome_unknown';
export type IdempotencyState = 'in_progress' | 'completed';
export type AdmissionTarget = 'embedding_provider' | 'rerank_provider' | 'answer_provider';
export type AdmissionPurpose = 'query_embedding' | 'document_embedding' | 'rerank' | 'answer';
export type AdmissionOutcome = 'dispatched' | 'failed' | 'lease_expired' | 'cancelled';

export interface PersonTable {
  id: GeneratedUuid;
  /** NULL for a provider sign-up without a name (BE-002); clients render a localized placeholder. */
  display_name: string | null;
  profile_visibility: Generated<ProfileVisibility>;
  public_headline: string | null;
  public_expertise: Generated<string[]>;
  prefers_buying: Generated<boolean>;
  prefers_selling: Generated<boolean>;
  prefers_industry_participation: Generated<boolean>;
  authz_epoch: GeneratedInt;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface EmailBindingTable {
  id: GeneratedUuid;
  person_id: string;
  email_normalized: string;
  is_primary: Generated<boolean>;
  verified_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}
export interface CredentialTable {
  id: GeneratedUuid;
  person_id: string;
  kind: CredentialKind;
  provider: Provider | null;
  provider_subject: string | null;
  password_hash: string | null;
  disabled_at: Timestamp | null;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface SessionTable {
  id: GeneratedUuid;
  person_id: string;
  token_hash: Buffer;
  created_at: GeneratedTimestamp;
  last_seen_at: GeneratedTimestamp;
  idle_expires_at: Timestamp;
  absolute_expires_at: Timestamp;
  authenticated_at: GeneratedTimestamp;
  auth_method: AuthMethod;
  user_agent_family: Generated<string>;
  ip_prefix: Generated<string>;
  revoked_at: Timestamp | null;
  revoked_reason: SessionRevokedReason | null;
}
export interface AuthTokenTable {
  id: GeneratedUuid;
  token_hash: Buffer;
  kind: AuthTokenKind;
  person_id: string;
  email_normalized: string;
  created_at: GeneratedTimestamp;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
}
export interface LoginFailureTable {
  id: Generated<string>;
  subject_hash: Buffer;
  occurred_at: GeneratedTimestamp;
  expires_at: Timestamp;
}
export interface LegalIdentifier { kind: 'inn' | 'ogrn' | 'kpp' | 'other'; value: string; status: 'sourced' | 'claimed' | 'verified' }
export interface CompanyTable {
  id: GeneratedUuid;
  display_name: string;
  sourced_status: Generated<SourcedStatus>;
  claim_status: Generated<ClaimStatus>;
  legal_identifiers: JSONColumnType<LegalIdentifier[], string | undefined, string>;
  public_description: string | null;
  verified_domains: Generated<string[]>;
  authz_epoch: GeneratedInt;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface CompanyPrivateTable {
  company_id: string;
  internal_notes: string | null;
  billing_account_id: string | null;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface MembershipTable {
  id: GeneratedUuid;
  person_id: string;
  company_id: string;
  role: MembershipRole;
  permissions: Generated<string[]>;
  status: Generated<MembershipStatus>;
  invited_by: string | null;
  invited_at: GeneratedTimestamp;
  valid_from: Timestamp | null;
  ended_at: Timestamp | null;
  ended_by: string | null;
  ended_reason: string | null;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface PermissionGrantTable {
  id: GeneratedUuid;
  principal_person_id: string | null;
  principal_company_id: string | null;
  action: string;
  scope: JSONColumnType<Record<string, unknown>, string | undefined, string>;
  limits: JSONColumnType<Record<string, unknown>, string | undefined, string>;
  granted_by: string;
  granted_at: GeneratedTimestamp;
  expires_at: Timestamp | null;
  revoked_at: Timestamp | null;
  revoked_reason: string | null;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface ObjectParticipationTable {
  id: GeneratedUuid;
  resource_kind: ResourceKind;
  resource_id: string;
  party_person_id: string | null;
  party_company_id: string | null;
  side: Side;
  capabilities: string[];
  audience: GrantAudience;
  valid_from: GeneratedTimestamp;
  valid_until: Timestamp | null;
  granted_by_person_id: string;
  on_behalf_of_person_id: string | null;
  on_behalf_of_company_id: string | null;
  revoked_at: Timestamp | null;
  revoked_reason: string | null;
  case_ref: string | null;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface ProjectTable {
  id: GeneratedUuid;
  owner_person_id: string | null;
  owner_company_id: string | null;
  creator_person_id: string;
  leader_person_id: string | null;
  name: string;
  summary: string | null;
  status: Generated<ProjectStatus>;
  publicity_enabled: Generated<boolean>;
  published_story: string | null;
  private_notes: string | null;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface OwnershipTransferTable {
  id: GeneratedUuid;
  project_id: string;
  from_person_id: string | null;
  from_company_id: string | null;
  to_person_id: string | null;
  to_company_id: string | null;
  status: Generated<OwnershipTransferStatus>;
  proposed_by: string;
  proposed_at: GeneratedTimestamp;
  recipient_consent_at: Timestamp | null;
  effective_at: Timestamp | null;
  expires_at: Timestamp;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface LeadershipAssignmentTable {
  id: GeneratedUuid;
  project_id: string;
  leader_person_id: string;
  assigned_by: string;
  assigned_at: GeneratedTimestamp;
  ended_at: Timestamp | null;
  ended_by: string | null;
}
export interface AuditEventTable {
  id: Generated<string>;
  occurred_at: GeneratedTimestamp;
  actor_person_id: string | null;
  on_behalf_of_person_id: string | null;
  on_behalf_of_company_id: string | null;
  mandate_id: string | null;
  action: string;
  object_kind: string;
  object_id: string;
  before_digest: string | null;
  after_digest: string | null;
  basis: JSONColumnType<object | null, string | null | undefined, string | null>;
  reason: string | null;
  request_id: string | null;
  authz_epoch: number | null;
}
export interface OutboxEventTable {
  id: Generated<string>;
  aggregate_kind: string;
  aggregate_id: string;
  revision: number;
  type: string;
  payload: JSONColumnType<object, string, string>;
  created_at: GeneratedTimestamp;
  published_at: Timestamp | null;
}
export interface JobTable {
  id: GeneratedUuid;
  kind: string;
  payload: JSONColumnType<object, string | undefined, string>;
  state: Generated<JobState>;
  attempt: GeneratedInt;
  max_attempts: GeneratedInt;
  next_at: GeneratedTimestamp;
  leased_until: Timestamp | null;
  leased_by: string | null;
  fencing_token: Generated<string>;
  last_error: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface IdempotencyRecordTable {
  id: GeneratedUuid;
  principal_id: string;
  action: string;
  context_id: string;
  key: string;
  payload_digest: string;
  state: Generated<IdempotencyState>;
  result: JSONColumnType<object | null, string | null | undefined, string | null>;
  created_at: GeneratedTimestamp;
  expires_at: Timestamp;
}
export interface InboxReceiptTable {
  id: Generated<string>;
  provider: string;
  account: string;
  event_id: string;
  received_at: GeneratedTimestamp;
}
/** Owner-only secret behind the HMAC-verified transaction identity (BE-001); never readable by the runtime role. */
export interface PrincipalKeyTable {
  id: number;
  secret: Buffer;
  rotated_at: GeneratedTimestamp;
}
/** Admission / revocation primitive (BE-001): one epoch per scope, bumped by an exclusive revocation. */
export interface AdmissionScopeTable {
  scope: string;
  epoch: Generated<string>;
  revoked_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface AdmissionLeaseTable {
  id: GeneratedUuid;
  permit_id: string;
  principal_id: string;
  scopes: string[];
  scope_epochs: string[];
  target: AdmissionTarget;
  purpose: AdmissionPurpose;
  binding: JSONColumnType<Record<string, unknown>, string, string>;
  payload_digest: string;
  policy_epoch: string;
  scope_fingerprint: string;
  dependencies_digest: string;
  issued_at: GeneratedTimestamp;
  expires_at: Timestamp;
  admitted_at: Timestamp | null;
  lease_until: Timestamp | null;
  settled_at: Timestamp | null;
  outcome: AdmissionOutcome | null;
  denied_at: Timestamp | null;
  denied_reason: string | null;
  revoked_at: Timestamp | null;
}
export interface RevocationEventTable {
  id: Generated<string>;
  scope: string;
  epoch: string;
  reason: string | null;
  actor_person_id: string | null;
  occurred_at: GeneratedTimestamp;
}
export interface MigrationLedgerTable {
  filename: string;
  checksum: string;
  applied_at: GeneratedTimestamp;
  applied_by: string;
  duration_ms: number;
  transactional: boolean;
}

/** Tables owned by the foundation migrations; `Database` in ./index.ts extends it and module files augment that. */
export interface FoundationDatabase {
  person: PersonTable;
  email_binding: EmailBindingTable;
  credential: CredentialTable;
  session: SessionTable;
  auth_token: AuthTokenTable;
  login_failure: LoginFailureTable;
  company: CompanyTable;
  company_private: CompanyPrivateTable;
  membership: MembershipTable;
  permission_grant: PermissionGrantTable;
  object_participation: ObjectParticipationTable;
  project: ProjectTable;
  ownership_transfer: OwnershipTransferTable;
  leadership_assignment: LeadershipAssignmentTable;
  audit_event: AuditEventTable;
  outbox_event: OutboxEventTable;
  job: JobTable;
  idempotency_record: IdempotencyRecordTable;
  inbox_receipt: InboxReceiptTable;
  principal_key: PrincipalKeyTable;
  admission_scope: AdmissionScopeTable;
  admission_lease: AdmissionLeaseTable;
  revocation_event: RevocationEventTable;
  migration_ledger: MigrationLedgerTable;
}

export type Person = Selectable<PersonTable>;
export type NewPerson = Insertable<PersonTable>;
export type PersonUpdate = Updateable<PersonTable>;
export type EmailBinding = Selectable<EmailBindingTable>;
export type Credential = Selectable<CredentialTable>;
export type Session = Selectable<SessionTable>;
export type NewSession = Insertable<SessionTable>;
export type AuthToken = Selectable<AuthTokenTable>;
export type Company = Selectable<CompanyTable>;
export type NewCompany = Insertable<CompanyTable>;
export type CompanyPrivate = Selectable<CompanyPrivateTable>;
export type Membership = Selectable<MembershipTable>;
export type NewMembership = Insertable<MembershipTable>;
export type PermissionGrant = Selectable<PermissionGrantTable>;
export type NewPermissionGrant = Insertable<PermissionGrantTable>;
export type ObjectParticipation = Selectable<ObjectParticipationTable>;
export type NewObjectParticipation = Insertable<ObjectParticipationTable>;
export type Project = Selectable<ProjectTable>;
export type NewProject = Insertable<ProjectTable>;
export type ProjectUpdate = Updateable<ProjectTable>;
export type OwnershipTransfer = Selectable<OwnershipTransferTable>;
export type NewOwnershipTransfer = Insertable<OwnershipTransferTable>;
export type LeadershipAssignment = Selectable<LeadershipAssignmentTable>;
export type AuditEvent = Selectable<AuditEventTable>;
export type NewAuditEvent = Insertable<AuditEventTable>;
export type OutboxEvent = Selectable<OutboxEventTable>;
export type Job = Selectable<JobTable>;
export type NewJob = Insertable<JobTable>;
export type IdempotencyRecord = Selectable<IdempotencyRecordTable>;
export type InboxReceipt = Selectable<InboxReceiptTable>;
export type AdmissionScope = Selectable<AdmissionScopeTable>;
export type AdmissionLease = Selectable<AdmissionLeaseTable>;
export type RevocationEvent = Selectable<RevocationEventTable>;

type ColumnsOf<D, T extends keyof D> = readonly (keyof D[T] & string)[];
type ExhaustiveColumns<D, T extends keyof D, C extends ColumnsOf<D, T>> = Exclude<keyof D[T] & string, C[number]> extends never ? C : never;
/** Runtime column mirror of a module's tables, keyed by table name. */
export type TableColumns<D> = { readonly [T in keyof D & string]: ColumnsOf<D, T> };
/**
 * Returns a checker for one module's tables: `columnsOf<PlansDatabase>()('plan', ['id', …])` fails to compile unless
 * the list names every column of the interface, so the runtime mirror cannot drift from the Kysely model.
 */
export function columnsOf<D>() {
  return <T extends keyof D & string, const C extends ColumnsOf<D, T>>(_table: T, list: ExhaustiveColumns<D, T, C>): C => list;
}
const columns = columnsOf<FoundationDatabase>();

/** Runtime mirror of the foundation tables (compile-time exhaustive) so a test can diff it against the live schema. */
export const TABLE_COLUMNS: TableColumns<FoundationDatabase> = {
  person: columns('person', ['id', 'display_name', 'profile_visibility', 'public_headline', 'public_expertise', 'prefers_buying', 'prefers_selling', 'prefers_industry_participation', 'authz_epoch', 'revision', 'created_at', 'updated_at']),
  email_binding: columns('email_binding', ['id', 'person_id', 'email_normalized', 'is_primary', 'verified_at', 'created_at']),
  credential: columns('credential', ['id', 'person_id', 'kind', 'provider', 'provider_subject', 'password_hash', 'disabled_at', 'revision', 'created_at', 'updated_at']),
  session: columns('session', ['id', 'person_id', 'token_hash', 'created_at', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'authenticated_at', 'auth_method', 'user_agent_family', 'ip_prefix', 'revoked_at', 'revoked_reason']),
  auth_token: columns('auth_token', ['id', 'token_hash', 'kind', 'person_id', 'email_normalized', 'created_at', 'expires_at', 'consumed_at']),
  login_failure: columns('login_failure', ['id', 'subject_hash', 'occurred_at', 'expires_at']),
  company: columns('company', ['id', 'display_name', 'sourced_status', 'claim_status', 'legal_identifiers', 'public_description', 'verified_domains', 'authz_epoch', 'revision', 'created_at', 'updated_at']),
  company_private: columns('company_private', ['company_id', 'internal_notes', 'billing_account_id', 'revision', 'created_at', 'updated_at']),
  membership: columns('membership', ['id', 'person_id', 'company_id', 'role', 'permissions', 'status', 'invited_by', 'invited_at', 'valid_from', 'ended_at', 'ended_by', 'ended_reason', 'revision', 'created_at', 'updated_at']),
  permission_grant: columns('permission_grant', ['id', 'principal_person_id', 'principal_company_id', 'action', 'scope', 'limits', 'granted_by', 'granted_at', 'expires_at', 'revoked_at', 'revoked_reason', 'revision', 'created_at', 'updated_at']),
  object_participation: columns('object_participation', ['id', 'resource_kind', 'resource_id', 'party_person_id', 'party_company_id', 'side', 'capabilities', 'audience', 'valid_from', 'valid_until', 'granted_by_person_id', 'on_behalf_of_person_id', 'on_behalf_of_company_id', 'revoked_at', 'revoked_reason', 'case_ref', 'revision', 'created_at', 'updated_at']),
  project: columns('project', ['id', 'owner_person_id', 'owner_company_id', 'creator_person_id', 'leader_person_id', 'name', 'summary', 'status', 'publicity_enabled', 'published_story', 'private_notes', 'revision', 'created_at', 'updated_at']),
  ownership_transfer: columns('ownership_transfer', ['id', 'project_id', 'from_person_id', 'from_company_id', 'to_person_id', 'to_company_id', 'status', 'proposed_by', 'proposed_at', 'recipient_consent_at', 'effective_at', 'expires_at', 'revision', 'created_at', 'updated_at']),
  leadership_assignment: columns('leadership_assignment', ['id', 'project_id', 'leader_person_id', 'assigned_by', 'assigned_at', 'ended_at', 'ended_by']),
  audit_event: columns('audit_event', ['id', 'occurred_at', 'actor_person_id', 'on_behalf_of_person_id', 'on_behalf_of_company_id', 'mandate_id', 'action', 'object_kind', 'object_id', 'before_digest', 'after_digest', 'basis', 'reason', 'request_id', 'authz_epoch']),
  outbox_event: columns('outbox_event', ['id', 'aggregate_kind', 'aggregate_id', 'revision', 'type', 'payload', 'created_at', 'published_at']),
  job: columns('job', ['id', 'kind', 'payload', 'state', 'attempt', 'max_attempts', 'next_at', 'leased_until', 'leased_by', 'fencing_token', 'last_error', 'created_at', 'updated_at']),
  idempotency_record: columns('idempotency_record', ['id', 'principal_id', 'action', 'context_id', 'key', 'payload_digest', 'state', 'result', 'created_at', 'expires_at']),
  inbox_receipt: columns('inbox_receipt', ['id', 'provider', 'account', 'event_id', 'received_at']),
  principal_key: columns('principal_key', ['id', 'secret', 'rotated_at']),
  admission_scope: columns('admission_scope', ['scope', 'epoch', 'revoked_at', 'created_at', 'updated_at']),
  admission_lease: columns('admission_lease', ['id', 'permit_id', 'principal_id', 'scopes', 'scope_epochs', 'target', 'purpose', 'binding', 'payload_digest', 'policy_epoch', 'scope_fingerprint', 'dependencies_digest', 'issued_at', 'expires_at', 'admitted_at', 'lease_until', 'settled_at', 'outcome', 'denied_at', 'denied_reason', 'revoked_at']),
  revocation_event: columns('revocation_event', ['id', 'scope', 'epoch', 'reason', 'actor_person_id', 'occurred_at']),
  migration_ledger: columns('migration_ledger', ['filename', 'checksum', 'applied_at', 'applied_by', 'duration_ms', 'transactional']),
};
