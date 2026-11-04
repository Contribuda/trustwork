import { z } from 'zod';
import { consoleCommand } from '../../../deps/contracts.js';

/**
 * Commands of the claim routes (CLM-001). Staff commands carry the console base (contract version, idempotency key,
 * staff reason); the claimant's commands are a participant's own and carry only the `Idempotency-Key` header. The
 * vocabularies mirror packages/data/migrations/claims; the database repeats every rule.
 */
export const CLAIM_LEVELS = ['claimed', 'verified'] as const;
export const CLAIM_STATES = ['open', 'waiting', 'disputed', 'approved', 'rejected', 'withdrawn'] as const;

const Id = z.uuid();
const Revision = z.int().min(1);

/** The address of a tie: it counts only as one of the claimant's own verified addresses on the company's domain. */
const Tie = z.strictObject({ kind: z.enum(['invitation_link', 'own_domain_mailbox']), email: z.email().max(254) });
export const SubmitClaimCommandSchema = z.strictObject({ hubId: Id, companyId: Id, level: z.enum(CLAIM_LEVELS), recipeId: Id, tie: Tie.nullable() });
export const WithdrawClaimCommandSchema = z.strictObject({});

export const DecideClaimCommandSchema = consoleCommand({
  expectedRevision: Revision,
  decision: z.enum(['approved', 'rejected']),
  /** The reviewer's own record that a register names the claimant as an officer: the other tie for the claimed level. */
  officerMatch: z.boolean(),
  note: z.string().trim().min(1).max(1000).nullable(),
});
export const ProposeDisputeCommandSchema = consoleCommand({ expectedRevision: Revision, winnerClaimId: Id.nullable(), note: z.string().trim().min(10).max(1000) });
export const ConfirmDisputeCommandSchema = consoleCommand({ expectedRevision: Revision });
export const RevokeHandoverCommandSchema = consoleCommand({ revocationReason: z.string().trim().min(10).max(1000) });
export const BindEvidenceCommandSchema = consoleCommand({ checkIds: z.array(Id).min(1).max(12) });
export const ClaimSettingsCommandSchema = consoleCommand({ waitingDays: z.int().min(1).max(30), coolingDays: z.int().min(1).max(30) });

export const RecheckVerificationCommandSchema = consoleCommand({ recipeId: Id });

/* The company's records. The status and the source of a record never come from its author. */
const Jurisdiction = z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/);
const IdentifierKind = z.string().regex(/^(?:[A-Z]{2}(?:-[A-Z0-9]{2,8}){1,3}|other)$/);
const RecordStatus = z.enum(['active', 'inactive', 'unknown']);
const IdentifierRecord = z.strictObject({ kind: z.literal('identifier'), identifierKind: IdentifierKind, jurisdiction: Jurisdiction.nullable(), value: z.string().trim().min(1).max(64) });
const RegistrationRecord = z.strictObject({
  kind: z.literal('registration'), jurisdiction: Jurisdiction, registrationKind: z.enum(['formation', 'foreign_qualification', 'dba', 'branch']), registeredName: z.string().trim().min(1).max(300),
  number: z.string().trim().min(1).max(64).nullable(), status: RecordStatus, observedAt: z.iso.datetime().nullable(),
});
const TaxRecord = z.strictObject({ kind: z.literal('tax_registration'), jurisdiction: Jurisdiction, taxKind: IdentifierKind, number: z.string().trim().min(1).max(64), status: RecordStatus, validUntil: z.iso.date().nullable() });
const BranchRecord = z.strictObject({ kind: z.literal('branch'), hubId: Id, name: z.string().trim().min(1).max(200), address: z.record(z.string().max(40), z.string().max(200)), regionCode: Jurisdiction.nullable(), public: z.boolean() });
export const RECORD_KINDS = ['identifier', 'registration', 'tax_registration', 'branch'] as const;
export const AddRecordCommandSchema = z.discriminatedUnion('kind', [IdentifierRecord, RegistrationRecord, TaxRecord, BranchRecord]);
export const RetireRecordCommandSchema = z.strictObject({});
export const SetProfileCommandSchema = z.strictObject({
  legalForm: z.string().regex(/^[A-Z]{2}-[A-Z0-9-]{2,20}$/).nullable(), websiteUrl: z.url().max(300).nullable(), regionCode: Jurisdiction.nullable(), categories: z.array(z.string().trim().min(1).max(60)).max(20),
  publicFields: z.array(z.enum(['legal_form', 'website_url', 'region_code', 'categories'])).max(4), description: z.string().trim().max(2000).nullable().optional(),
});
export const SourceRecordCommandSchema = consoleCommand({ record: z.discriminatedUnion('kind', [IdentifierRecord, RegistrationRecord]), sourceRef: z.string().trim().min(1).max(200) });
export const VerifyIdentifierCommandSchema = consoleCommand({ expectedRevision: Revision, checkId: Id });
const Country = z.string().regex(/^[A-Z]{2}$/);
const Region = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);
/** `fromCountry` and `fromRegion` restate what the reviewer saw (null for a company older than the rule), so a second correction is not overwritten. */
export const CorrectCountryCommandSchema = consoleCommand({ fromCountry: Country.nullable(), fromRegion: Region.nullable(), country: Country, region: Region.nullable() });

export const ClaimListQuerySchema = z.strictObject({ state: z.enum(CLAIM_STATES).optional() });
export const HandoverListQuerySchema = z.strictObject({ companyId: Id.optional() });
export const VerificationListQuerySchema = z.strictObject({ companyId: Id.optional(), dueDays: z.coerce.number().int().min(0).max(366).optional() });
export const RecipeListQuerySchema = z.strictObject({ hubId: Id });
