import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common/ids.js';

/**
 * Second factor, recovery codes and elevated sessions (BE-004).
 *
 * - **TOTP** (RFC 6238 over RFC 4226 HOTP): SHA-1, six digits, 30-second steps, one step of tolerance either side. These
 *   are the parameters every common authenticator app understands; the secret is 160 random bits, shown once at
 *   enrolment and stored only sealed (AES-256-GCM under a key the database never sees). A code is accepted only for a
 *   time step later than the last accepted one, so a code (or an earlier code of the same window) never works twice.
 * - **Recovery codes**: ten single-use codes of 80 random bits, shown once, stored only as keyed hashes. Using one
 *   notifies every verified address. Regenerating replaces the whole set.
 * - **Elevated session**: `admin.session.elevate` needs a recent password step-up plus a second-factor proof; the
 *   elevation is bound to the acting session and expires after `ELEVATION_LIFETIME_MS`. Staff routes refuse a session
 *   without a live elevation (403 `access.forbidden`, `details.required = 'elevation'`).
 * - **Sign-in**: a person with an active factor gets `second_factor_required` after the password (or provider) proof
 *   and a session only after `POST /v1/auth/second-factor`.
 * - **Support reset**: requested by support with evidence, approved by a different person, effective no sooner than 72
 *   hours after approval, announced on every verified channel and cancellable until then (`COOLING_OFF_ACTIONS`).
 *
 * WebAuthn (passkeys) is reserved in `CredentialKindSchema` but not implemented in this slice.
 */

export const TOTP_PARAMETERS = { algorithm: 'SHA1', digits: 6, periodSeconds: 30, window: 1 } as const;
export const TOTP_SECRET_BYTES = 20;
export const RECOVERY_CODE_COUNT = 10;
/** Alphabet without look-alike characters (no 0, 1, l, o): 32 symbols, 5 bits each; 16 symbols = 80 bits. */
export const RECOVERY_CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_SYMBOLS = 16;
/** A pending enrolment must be confirmed with a code within this time. */
export const ENROLMENT_TTL_MS = 10 * 60_000;
/** Sign-in challenge after a correct password (or provider) proof. */
export const SECOND_FACTOR_CHALLENGE_TTL_MS = 5 * 60_000;
export const SECOND_FACTOR_CHALLENGE_MAX_ATTEMPTS = 5;
/** Elevated sessions are short: the integrator default until the owner decides (operations proposal: 30 minutes). */
export const ELEVATION_LIFETIME_MS = 15 * 60_000;
/** Upper bound the database enforces on any elevation row. */
export const ELEVATION_MAX_LIFETIME_MS = 60 * 60_000;
export const SECOND_FACTOR_RESET_COOLING_OFF_MS = 72 * 3_600_000;

/** Staff roles that may request a support reset, and the roles that may approve one (`admin.support.recovery.approve`). */
export const SECOND_FACTOR_RESET_REQUEST_ROLES = ['support-agent', 'support-lead'] as const;
export const SECOND_FACTOR_RESET_APPROVE_ROLES = ['support-lead'] as const;

export const SecondFactorKindSchema = z.enum(['totp']);
export const ProofMethodSchema = z.enum(['totp', 'recovery_code']);
export type ProofMethod = z.infer<typeof ProofMethodSchema>;

export const TotpCodeSchema = z.string().trim().regex(/^\d{6}$/, 'six digits');
/** Accepts the displayed form (`abcd-efgh-ijkm-npqr`), any case, with or without separators. */
export const RecoveryCodeSchema = z.string().trim().min(RECOVERY_CODE_SYMBOLS).max(RECOVERY_CODE_SYMBOLS + 8).regex(/^[A-Za-z0-9 -]+$/, 'recovery code');

/** Canonical form of a recovery code before hashing: lower case, separators removed. Null when malformed. */
export function normalizeRecoveryCode(input: string): string | null {
  const compact = input.toLowerCase().replace(/[\s-]/g, '');
  if (compact.length !== RECOVERY_CODE_SYMBOLS) return null;
  for (const ch of compact) if (!RECOVERY_CODE_ALPHABET.includes(ch)) return null;
  return compact;
}
/** Display form: four groups of four symbols. */
export function formatRecoveryCode(compact: string): string {
  return compact.match(/.{1,4}/g)?.join('-') ?? compact;
}

/** One second-factor proof: a TOTP code or a recovery code. */
export const SecondFactorProofSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('totp'), code: TotpCodeSchema }),
  z.strictObject({ method: z.literal('recovery_code'), code: RecoveryCodeSchema }),
]);
export type SecondFactorProof = z.infer<typeof SecondFactorProofSchema>;

/* ---------- Own factors (the person) ---------- */

export const SecondFactorViewSchema = z.strictObject({
  id: IdSchema,
  kind: SecondFactorKindSchema,
  createdAt: TimestampSchema,
  activatedAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
});
export type SecondFactorView = z.infer<typeof SecondFactorViewSchema>;

export const SecondFactorResetStateSchema = z.enum(['pending', 'cooling_off', 'done', 'cancelled']);

/** `GET /v1/me/second-factor`: never a secret, a code or a hash. */
export const SecondFactorStatusSchema = z.strictObject({
  enrolled: z.boolean(),
  factors: z.array(SecondFactorViewSchema).max(10),
  recoveryCodes: z.strictObject({ remaining: z.int().min(0).max(RECOVERY_CODE_COUNT), total: z.int().min(1).max(RECOVERY_CODE_COUNT), generatedAt: TimestampSchema }).nullable(),
  /** A support reset of the person's factors that has not taken effect yet; the person may cancel it. */
  pendingReset: z.strictObject({ id: IdSchema, state: z.enum(['pending', 'cooling_off']), requestedAt: TimestampSchema, effectiveAt: TimestampSchema.nullable() }).nullable(),
}).refine((s) => s.enrolled === s.factors.length > 0, { message: 'enrolled means at least one active factor', path: ['enrolled'] });
export type SecondFactorStatus = z.infer<typeof SecondFactorStatusSchema>;

export const TotpEnrolmentStartCommandSchema = z.strictObject({});
/** Returned once; the secret is never readable again. `otpauthUri` follows the Key Uri Format of authenticator apps. */
export const TotpEnrolmentSchema = z.strictObject({
  factorId: IdSchema,
  secret: z.string().regex(/^[A-Z2-7]{32}$/, 'base32 secret'),
  otpauthUri: z.string().startsWith('otpauth://totp/').max(500),
  expiresAt: TimestampSchema,
  digits: z.literal(TOTP_PARAMETERS.digits),
  periodSeconds: z.literal(TOTP_PARAMETERS.periodSeconds),
});
export type TotpEnrolment = z.infer<typeof TotpEnrolmentSchema>;

export const TotpEnrolmentConfirmCommandSchema = z.strictObject({ factorId: IdSchema, code: TotpCodeSchema });
export const RecoveryCodeListSchema = z.array(z.string().regex(/^[a-km-np-z2-9]{4}(?:-[a-km-np-z2-9]{4}){3}$/)).length(RECOVERY_CODE_COUNT);
/** Confirmation result; `recoveryCodes` is shown once and only when the person had no unused codes. */
export const TotpEnrolmentConfirmedSchema = z.strictObject({ status: z.literal('enabled'), factor: SecondFactorViewSchema, recoveryCodes: RecoveryCodeListSchema.nullable() });

export const RecoveryCodesRegenerateCommandSchema = z.strictObject({ proof: SecondFactorProofSchema });
export const RecoveryCodesIssuedSchema = z.strictObject({ recoveryCodes: RecoveryCodeListSchema, generatedAt: TimestampSchema });
export const SecondFactorRemoveCommandSchema = z.strictObject({ factorId: IdSchema, proof: SecondFactorProofSchema });

/* ---------- Sign-in ---------- */

export const LoginSecondFactorRequiredSchema = z.strictObject({
  status: z.literal('second_factor_required'),
  methods: z.array(ProofMethodSchema).min(1),
  expiresAt: TimestampSchema,
});
export const SecondFactorLoginCommandSchema = z.strictObject({ proof: SecondFactorProofSchema });

/* ---------- Elevated sessions ---------- */

export const SessionElevateCommandSchema = z.strictObject({ proof: SecondFactorProofSchema });
export const SessionElevationSchema = z.strictObject({
  id: IdSchema,
  sessionId: IdSchema,
  personId: IdSchema,
  factor: ProofMethodSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
}).refine((e) => Date.parse(e.expiresAt) > Date.parse(e.createdAt) && Date.parse(e.expiresAt) - Date.parse(e.createdAt) <= ELEVATION_MAX_LIFETIME_MS, {
  message: 'an elevation is short-lived',
  path: ['expiresAt'],
});
export type SessionElevation = z.infer<typeof SessionElevationSchema>;
/** `POST /v1/admin/session/elevate` and `GET /v1/admin/session`. */
export const SessionElevationViewSchema = z.strictObject({ elevationId: IdSchema, factor: ProofMethodSchema, expiresAt: TimestampSchema, staffRoles: z.array(z.string().min(1).max(40)).min(1) });
export type SessionElevationView = z.infer<typeof SessionElevationViewSchema>;
export function elevationLive(e: Pick<SessionElevation, 'expiresAt' | 'revokedAt'>, now: Date): boolean {
  return e.revokedAt === null && Date.parse(e.expiresAt) > now.getTime();
}
/** `details` of the 403 a staff route answers without a live elevation (`required: 'staff'` for non-staff). */
export const ElevationRequiredDetailsSchema = z.strictObject({ required: z.enum(['elevation', 'staff', 'second_factor']) });

/* ---------- Support reset (SUP-001 calls these use cases) ---------- */

export const SecondFactorResetRequestCommandSchema = z.strictObject({
  subjectPersonId: IdSchema,
  supportCaseId: IdSchema,
  /** References to recorded identity checks; the evidence itself is never stored here. */
  evidenceRefs: z.array(IdSchema).min(1).max(10),
  reason: z.string().trim().min(10).max(500),
});
export const SecondFactorResetViewSchema = z.strictObject({
  id: IdSchema,
  subjectPersonId: IdSchema,
  supportCaseId: IdSchema,
  requestedBy: IdSchema,
  approvedBy: IdSchema.nullable(),
  evidenceCount: z.int().min(1).max(10),
  requestedAt: TimestampSchema,
  approvedAt: TimestampSchema.nullable(),
  effectiveAt: TimestampSchema.nullable(),
  state: SecondFactorResetStateSchema,
})
  .refine((r) => r.subjectPersonId !== r.requestedBy, { message: 'staff never service their own account', path: ['requestedBy'] })
  .refine((r) => r.approvedBy === null || (r.approvedBy !== r.requestedBy && r.approvedBy !== r.subjectPersonId), { message: 'the approver is a second person', path: ['approvedBy'] })
  .refine((r) => r.effectiveAt === null || Date.parse(r.effectiveAt) - Date.parse(r.requestedAt) >= SECOND_FACTOR_RESET_COOLING_OFF_MS, { message: 'a reset takes effect after at least 72 hours', path: ['effectiveAt'] })
  .refine((r) => (r.state === 'pending') === (r.approvedBy === null) || r.state === 'cancelled', { message: 'only an approved reset cools off or completes', path: ['state'] });
export type SecondFactorResetView = z.infer<typeof SecondFactorResetViewSchema>;

/* ---------- Owner notices (security_notice events delivered through the outbox) ---------- */

export const SECOND_FACTOR_NOTICE_EVENTS = [
  'second_factor_enabled', 'second_factor_removed', 'recovery_codes_regenerated', 'recovery_code_used', 'second_factor_throttled',
  'second_factor_reset_requested', 'second_factor_reset_approved', 'second_factor_reset_cancelled', 'second_factor_reset_completed',
] as const;
export type SecondFactorNoticeEvent = (typeof SECOND_FACTOR_NOTICE_EVENTS)[number];
