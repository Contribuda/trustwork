import { z } from 'zod';
import { Sha256HexSchema } from './common/digest-schema.js';
import { IdSchema, NameSchema, nfc, RevisionSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { pickFields } from './common/projection.js';

export const EmailSchema = z
  .email()
  .max(254)
  .overwrite((v) => nfc(v).toLowerCase());

export const PasswordPolicySchema = z.strictObject({ minLength: z.int().min(8).max(64), maxLength: z.int().min(64).max(256) });
/** H01 default (NIST/OWASP single factor); the human may lower it with a breached-password check as compensation. */
export const DEFAULT_PASSWORD_POLICY = { minLength: 15, maxLength: 128 } as const;
/** Passwords are NFC-normalised before hashing so the same visible password verifies from different keyboards. */
export function passwordSchema(policy: z.infer<typeof PasswordPolicySchema> = DEFAULT_PASSWORD_POLICY) {
  return z.string().overwrite(nfc).min(policy.minLength).max(policy.maxLength);
}

export const ProviderSchema = z.enum(['google', 'apple']);
/** Identity key `(provider, subject)`; never the e-mail returned by the provider. */
export const ProviderIdentitySchema = z.strictObject({ provider: ProviderSchema, subject: z.string().min(1).max(255) });
export const CredentialKindSchema = z.enum(['password', 'google', 'apple', 'totp', 'webauthn', 'recovery_code']);

export const EmailBindingSchema = z.strictObject({ email: EmailSchema, verifiedAt: TimestampSchema.nullable(), isPrimary: z.boolean() });
export type EmailBinding = z.infer<typeof EmailBindingSchema>;

export const PersonSchema = z
  .strictObject({
    id: IdSchema,
    displayName: NameSchema.nullable(),
    profileVisibility: z.enum(['private', 'public']),
    publicProfile: z.strictObject({ headline: TextSchema.nullable(), expertise: z.array(z.string().min(1).max(100)) }),
    /** owner_private: the person alone. */
    emailBindings: z.array(EmailBindingSchema),
    providerIdentities: z.array(ProviderIdentitySchema),
    preferences: z.strictObject({ buying: z.boolean(), selling: z.boolean(), industryParticipation: z.boolean() }),
    revision: RevisionSchema,
    createdAt: TimestampSchema,
  })
  .refine((p) => p.emailBindings.filter((b) => b.isPrimary).length <= 1, { message: 'at most one primary e-mail binding', path: ['emailBindings'] });
export type Person = z.infer<typeof PersonSchema>;

export const PublicPersonSchema = z.strictObject({ id: IdSchema, displayName: PersonSchema.shape.displayName, publicProfile: PersonSchema.shape.publicProfile });
export type PublicPerson = z.infer<typeof PublicPersonSchema>;
/** Public people require `profileVisibility: public`; private profiles are not found, not forbidden. */
export function toPublicPerson(person: Person): PublicPerson | null {
  if (person.profileVisibility !== 'public') return null;
  return PublicPersonSchema.parse(pickFields(person, ['id', 'displayName', 'publicProfile']));
}

export const SessionRevokedReasonSchema = z.enum(['logout', 'logout_all', 'password_change', 'recovery', 'admin', 'expired', 'suspicious']);
export const AuthMethodSchema = z.enum(['password', 'google', 'apple', 'recovery']);
/** Opaque PostgreSQL session; the browser holds only the raw token in `__Host-sr_session`, the row stores its hash. */
export const SessionSchema = z.strictObject({
  id: IdSchema,
  personId: IdSchema,
  tokenHash: Sha256HexSchema,
  createdAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  idleExpiresAt: TimestampSchema,
  absoluteExpiresAt: TimestampSchema,
  authenticatedAt: TimestampSchema,
  authMethod: AuthMethodSchema,
  client: z.strictObject({ userAgentFamily: z.string().max(100), ipPrefix: z.string().max(64) }),
  revokedAt: TimestampSchema.nullable(),
  revokedReason: SessionRevokedReasonSchema.nullable(),
});
export type Session = z.infer<typeof SessionSchema>;
export const SessionViewSchema = SessionSchema.omit({ tokenHash: true, personId: true });
export type SessionView = z.infer<typeof SessionViewSchema>;
export function toSessionView(session: Session): SessionView {
  return SessionViewSchema.parse(pickFields(session, ['id', 'createdAt', 'lastSeenAt', 'idleExpiresAt', 'absoluteExpiresAt', 'authenticatedAt', 'authMethod', 'client', 'revokedAt', 'revokedReason']));
}
export function sessionActive(session: Session, now: Date): boolean {
  const t = now.getTime();
  return Number.isFinite(t) && session.revokedAt === null && Date.parse(session.idleExpiresAt) > t && Date.parse(session.absoluteExpiresAt) > t;
}
export const STEP_UP_FRESHNESS_MS = 10 * 60_000;
export function stepUpFresh(session: Pick<Session, 'authenticatedAt'>, now: Date): boolean {
  return now.getTime() - Date.parse(session.authenticatedAt) <= STEP_UP_FRESHNESS_MS;
}

export const SignupCommandSchema = z.strictObject({ name: NameSchema, email: EmailSchema, password: passwordSchema(), acceptedTermsVersion: z.string().min(1).max(40) });
export const LoginCommandSchema = z.strictObject({ email: EmailSchema, password: z.string().min(1).max(256) });
export const RecoveryRequestCommandSchema = z.strictObject({ email: EmailSchema });
export const RecoveryCompleteCommandSchema = z.strictObject({ token: z.string().min(16).max(256), newPassword: passwordSchema() });
export const VerifyEmailCommandSchema = z.strictObject({ token: z.string().min(16).max(256) });
export const ProviderLinkStartCommandSchema = z.strictObject({ provider: ProviderSchema });
export const ChangeEmailCommandSchema = z.strictObject({ newEmail: EmailSchema });
export const RevokeSessionCommandSchema = z.strictObject({ sessionId: IdSchema });
