import type { ConsolePermission } from '@trustwork/contracts/client';

/**
 * Live commands of HC-23 Verification (HUBC-007 on the HUB-003 and CLM-001 routes). The vocabularies mirror the API's
 * command schemas (`apps/api/src/modules/verification/commands.ts`, kept equal by tests/web/admin/live-core); what is
 * checked here only words a mistake early, the API and the database repeat every rule. Pure: no clock, no I/O.
 */

export const VERIFICATION_CHECK_TYPES = [
  'register_match', 'officer_match', 'tax_status', 'licence', 'qualification', 'ownership', 'sanctions_screening', 'domain_confirmed', 'signed_authority', 'callback_confirmed',
] as const;
export type VerificationCheckType = (typeof VERIFICATION_CHECK_TYPES)[number];
/** The check every recipe carries as a required step: it has no switch and no provider of its own. */
export const SANCTIONS_CHECK = 'sanctions_screening' satisfies VerificationCheckType;
/** The checks a person chooses for a recipe and a provider. */
export const CHOOSABLE_CHECKS = VERIFICATION_CHECK_TYPES.filter((c) => c !== SANCTIONS_CHECK);
export const VERIFICATION_TRIGGERS = ['claim_claimed', 'claim_verified', 'seller_onboarding', 'regulated_category', 'professional_qualification'] as const;
export const VERIFICATION_LEGAL_BASES = ['statutory_public_register', 'contract', 'consent', 'legitimate_interest_assessed', 'legal_obligation'] as const;
export const VERIFICATION_SUBJECTS = ['company', 'person'] as const;
/** A provider starts as `fake` or `manual`; `live` is only reached through a second person. */
export const REGISTERED_PROVIDER_MODES = ['fake', 'manual'] as const;
export const STEP_USES = ['off', 'required', 'optional', 'any'] as const;
export type StepUse = (typeof STEP_USES)[number];

export type RecipeStep = { check: VerificationCheckType; required: boolean } | { anyOf: VerificationCheckType[] };

export const VERIFICATION_COMMANDS = [
  'verification.recipe_draft', 'verification.recipe_activate', 'verification.provider_register', 'verification.provider_request_live', 'verification.provider_go_live',
  'verification.claim_settings', 'verification.config_record',
] as const;
export type VerificationCommandId = (typeof VERIFICATION_COMMANDS)[number];
export function isVerificationCommand(value: unknown): value is VerificationCommandId {
  return typeof value === 'string' && (VERIFICATION_COMMANDS as readonly string[]).includes(value);
}

/**
 * The permission of each command, as its route and second-person action ask for it: `providers.enable_non_fake` is
 * requested with `admin.providers.toggle`, the switch to live is executed with `admin.claims.policy.edit`.
 */
export const VERIFICATION_COMMAND_PERMISSIONS: Record<VerificationCommandId, readonly ConsolePermission[]> = {
  'verification.recipe_draft': ['admin.claims.policy.edit'],
  'verification.recipe_activate': ['admin.claims.policy.edit'],
  'verification.provider_register': ['admin.claims.policy.edit'],
  'verification.provider_request_live': ['admin.providers.toggle'],
  'verification.provider_go_live': ['admin.claims.policy.edit'],
  'verification.claim_settings': ['admin.claims.policy.edit'],
  'verification.config_record': ['admin.claims.policy.edit', 'admin.config.edit'],
};

type Fields = Readonly<Record<string, string>>;
export type Invalid = { field: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const whole = (value: string | undefined, min: number, max: number): number | null => {
  const text = (value ?? '').trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return n >= min && n <= max ? n : null;
};
const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[]): T | null => (allowed.includes(value as T) ? (value as T) : null);

/**
 * The steps a recipe form describes: `step.<check>` is `off`, `required`, `optional` or `any` (one of the checks marked
 * `any` must pass, two to four of them). Sanctions screening is added last as a required step whatever the form says.
 */
export function recipeSteps(fields: Fields): RecipeStep[] | Invalid {
  const steps: RecipeStep[] = [];
  const any: VerificationCheckType[] = [];
  for (const check of CHOOSABLE_CHECKS) {
    const use = oneOf(fields[`step.${check}`] ?? 'off', STEP_USES);
    if (!use) return { field: `step.${check}` };
    if (use === 'required' || use === 'optional') steps.push({ check, required: use === 'required' });
    if (use === 'any') any.push(check);
  }
  if (any.length === 1 || any.length > 4) return { field: `step.${any[0]}` };
  if (any.length) steps.push({ anyOf: any });
  steps.push({ check: SANCTIONS_CHECK, required: true });
  return steps;
}

/** The body of `POST .../verification/recipes`, or the field to correct. */
export function recipeDraft(fields: Fields) {
  const key = (fields.key ?? '').trim();
  if (!/^[a-z][a-z0-9_-]{2,60}$/.test(key)) return { field: 'key' };
  const subjectKind = oneOf(fields.subjectKind, VERIFICATION_SUBJECTS);
  if (!subjectKind) return { field: 'subjectKind' };
  const trigger = oneOf(fields.trigger, VERIFICATION_TRIGGERS);
  if (!trigger) return { field: 'trigger' };
  const steps = recipeSteps(fields);
  if ('field' in steps) return steps;
  // The form names them `categories`: a recipe says which categories a passed check may show, it sets no one's badge.
  const badgeCategories = (fields.categories ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  if (badgeCategories.length < 1 || badgeCategories.length > 10 || badgeCategories.some((c) => !/^[a-z][a-z0-9_]{1,60}$/.test(c))) return { field: 'categories' };
  const recheckMonths = whole(fields.recheckMonths, 1, 24);
  if (recheckMonths === null) return { field: 'recheckMonths' };
  return { key, subjectKind, trigger, steps, badgeCategories, recheckMonths };
}

/** The body of `POST .../verification/providers`, or the field to correct. Sanctions screening has no provider here. */
export function providerDraft(fields: Fields) {
  const checkType = oneOf(fields.checkType, CHOOSABLE_CHECKS);
  if (!checkType) return { field: 'checkType' };
  const adapter = (fields.adapter ?? '').trim();
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(adapter)) return { field: 'adapter' };
  const mode = oneOf(fields.mode, REGISTERED_PROVIDER_MODES);
  if (!mode) return { field: 'mode' };
  const retentionDays = whole(fields.retentionDays, 1, 3650);
  if (retentionDays === null) return { field: 'retentionDays' };
  const legalBasis = oneOf(fields.legalBasis, VERIFICATION_LEGAL_BASES);
  if (!legalBasis) return { field: 'legalBasis' };
  const cost = (fields.costMinor ?? '').trim();
  if (cost && !/^\d{1,15}$/.test(cost)) return { field: 'costMinor' };
  return { checkType, adapter, mode, retentionDays, legalBasis, costMinor: cost || null };
}

/** The body of `POST .../claims/settings`, or the field to correct. */
export function claimSettings(fields: Fields) {
  const waitingDays = whole(fields.waitingDays, 1, 30);
  if (waitingDays === null) return { field: 'waitingDays' };
  const coolingDays = whole(fields.coolingDays, 1, 30);
  if (coolingDays === null) return { field: 'coolingDays' };
  return { waitingDays, coolingDays };
}

/** What the shell's evaluation checks for these commands after role, elevation and reason: a well-formed form. */
export function verificationFormProblem(command: VerificationCommandId, fields: Fields): Invalid | null {
  const failed = (body: object): Invalid | null => ('field' in body ? (body as Invalid) : null);
  switch (command) {
    case 'verification.recipe_draft':
      return failed(recipeDraft(fields));
    case 'verification.provider_register':
      return failed(providerDraft(fields));
    case 'verification.claim_settings':
      return failed(claimSettings(fields));
    case 'verification.recipe_activate':
      return UUID.test(fields.recipeId ?? '') && whole(fields.revision, 1, 999_999) !== null ? null : { field: 'recipeId' };
    case 'verification.provider_request_live':
    case 'verification.provider_go_live':
      if (!UUID.test(fields.providerId ?? '')) return { field: 'providerId' };
      return UUID.test(fields.credentialRefId ?? '') ? null : { field: 'credentialRefId' };
    case 'verification.config_record':
      return null;
  }
}
