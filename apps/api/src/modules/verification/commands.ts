import { z } from 'zod';
import { consoleCommand } from '../../deps/contracts.js';

/**
 * Console commands of the verification routes (HUB-003). Every command carries the console base (contract version,
 * idempotency key, staff reason). The vocabularies mirror the SQL vocabularies of
 * packages/data/migrations/verification (kept equal by tests/verification/api.test.ts); the database repeats every rule.
 */
export const VERIFICATION_CHECK_TYPES = [
  'register_match', 'officer_match', 'tax_status', 'licence', 'qualification', 'ownership', 'sanctions_screening', 'domain_confirmed', 'signed_authority', 'callback_confirmed',
] as const;
export const VERIFICATION_TRIGGERS = ['claim_claimed', 'claim_verified', 'seller_onboarding', 'regulated_category', 'professional_qualification'] as const;
export const VERIFICATION_LEGAL_BASES = ['statutory_public_register', 'contract', 'consent', 'legitimate_interest_assessed', 'legal_obligation'] as const;

const Id = z.uuid();
const CheckType = z.enum(VERIFICATION_CHECK_TYPES);
const NonSanctions = CheckType.exclude(['sanctions_screening']);
const Step = z.union([
  z.strictObject({ check: CheckType, required: z.boolean() }),
  z.strictObject({ anyOf: z.array(NonSanctions).min(2).max(4) }),
]);
const Subject = z.strictObject({ kind: z.enum(['company', 'person']), id: Id });

export const RegisterProviderCommandSchema = consoleCommand({
  checkType: NonSanctions,
  adapter: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  mode: z.enum(['fake', 'manual']),
  retentionDays: z.int().min(1).max(3650),
  legalBasis: z.enum(VERIFICATION_LEGAL_BASES),
  costMinor: z.string().regex(/^\d{1,15}$/).nullable(),
});
export const GoLiveCommandSchema = consoleCommand({ expectedRevision: z.int().min(1), credentialRefId: Id, approvalId: Id.nullable() });
export const DraftRecipeCommandSchema = consoleCommand({
  key: z.string().regex(/^[a-z][a-z0-9_-]{2,60}$/),
  subjectKind: z.enum(['company', 'person']),
  trigger: z.enum(VERIFICATION_TRIGGERS),
  steps: z.array(Step).min(1).max(12)
    .refine((steps) => steps.some((s) => 'check' in s && s.check === 'sanctions_screening' && s.required), { message: 'every recipe carries a required sanctions screening step' }),
  badgeCategories: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,60}$/)).min(1).max(10),
  recheckMonths: z.int().min(1).max(24),
});
export const ActivateRecipeCommandSchema = consoleCommand({ expectedRevision: z.int().min(1) });
export const RecordCheckCommandSchema = consoleCommand({
  subject: Subject,
  recipeId: Id,
  providerId: Id,
  result: z.enum(['pass', 'fail', 'inconclusive', 'unavailable']),
  evidenceRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/).nullable(),
});
export const RecordScreeningCommandSchema = consoleCommand({ subject: Subject, recipeId: Id });
export const StandingQuerySchema = z.strictObject({ subjectKind: z.enum(['company', 'person']), subjectId: Id, recipeId: Id });
