import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ELEVATION_LIFETIME_MS, ELEVATION_MAX_LIFETIME_MS, elevationLive, formatRecoveryCode, normalizeRecoveryCode, RECOVERY_CODE_ALPHABET, RECOVERY_CODE_SYMBOLS, RecoveryCodeListSchema,
  SECOND_FACTOR_NOTICE_EVENTS, SECOND_FACTOR_RESET_COOLING_OFF_MS, SecondFactorProofSchema, SecondFactorResetRequestCommandSchema, SecondFactorResetViewSchema, SecondFactorStatusSchema,
  SessionElevationSchema, TotpEnrolmentSchema,
} from '../../packages/contracts/src/second-factor.js';
import { COOLING_OFF_ACTIONS } from '../../packages/contracts/src/hub.js';
import { CredentialKindSchema } from '../../packages/contracts/src/identity.js';

const t0 = '2026-11-01T10:00:00.000Z';
const plus = (ms: number) => new Date(Date.parse(t0) + ms).toISOString();

test('proofs: six-digit TOTP codes or recovery codes in display form, nothing else', () => {
  assert.ok(SecondFactorProofSchema.safeParse({ method: 'totp', code: '012345' }).success);
  assert.ok(!SecondFactorProofSchema.safeParse({ method: 'totp', code: '12345' }).success);
  assert.ok(!SecondFactorProofSchema.safeParse({ method: 'totp', code: '12345a' }).success);
  assert.ok(SecondFactorProofSchema.safeParse({ method: 'recovery_code', code: 'abcd-efgh-ijkm-npqr' }).success);
  assert.ok(!SecondFactorProofSchema.safeParse({ method: 'recovery_code', code: 'abcd' }).success);
  assert.ok(!SecondFactorProofSchema.safeParse({ method: 'sms', code: '123456' }).success, 'no SMS factor');
  assert.ok(!SecondFactorProofSchema.safeParse({ method: 'totp', code: '123456', remember: true }).success, 'strict');
  assert.ok(CredentialKindSchema.options.includes('totp') && CredentialKindSchema.options.includes('recovery_code'));
});

test('recovery codes: canonical form and display form', () => {
  assert.equal(RECOVERY_CODE_ALPHABET.length, 32);
  assert.ok(!/[01lo]/.test(RECOVERY_CODE_ALPHABET), 'no look-alike characters');
  assert.equal(RECOVERY_CODE_SYMBOLS * Math.log2(RECOVERY_CODE_ALPHABET.length), 80);
  assert.equal(normalizeRecoveryCode(' ABCD-efgh ijkm-NPQR '), 'abcdefghijkmnpqr');
  assert.equal(normalizeRecoveryCode('abcd-efgh-ijkm-npq0'), null);
  assert.equal(formatRecoveryCode('abcdefghijkmnpqr'), 'abcd-efgh-ijkm-npqr');
  assert.ok(RecoveryCodeListSchema.safeParse(Array.from({ length: 10 }, () => 'abcd-efgh-ijkm-npqr')).success);
  assert.ok(!RecoveryCodeListSchema.safeParse(Array.from({ length: 9 }, () => 'abcd-efgh-ijkm-npqr')).success);
});

test('status and enrolment views never carry a hash, and enrolled means an active factor', () => {
  const factor = { id: 'f1', kind: 'totp', createdAt: t0, activatedAt: t0, lastUsedAt: null };
  assert.ok(SecondFactorStatusSchema.safeParse({ enrolled: true, factors: [factor], recoveryCodes: { remaining: 9, total: 10, generatedAt: t0 }, pendingReset: null }).success);
  assert.ok(!SecondFactorStatusSchema.safeParse({ enrolled: true, factors: [], recoveryCodes: null, pendingReset: null }).success);
  assert.ok(!SecondFactorStatusSchema.safeParse({ enrolled: false, factors: [], recoveryCodes: null, pendingReset: null, secretHash: 'x' }).success);
  assert.ok(TotpEnrolmentSchema.safeParse({ factorId: 'f1', secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/hub.example:a?secret=x', expiresAt: t0, digits: 6, periodSeconds: 30 }).success);
  assert.ok(!TotpEnrolmentSchema.safeParse({ factorId: 'f1', secret: 'jbswy3dp', otpauthUri: 'otpauth://totp/x', expiresAt: t0, digits: 6, periodSeconds: 30 }).success);
});

test('elevations are short-lived and bound to a session', () => {
  const base = { id: 'e1', sessionId: 's1', personId: 'p1', factor: 'totp', createdAt: t0, revokedAt: null };
  assert.equal(ELEVATION_LIFETIME_MS, 15 * 60_000);
  assert.ok(SessionElevationSchema.safeParse({ ...base, expiresAt: plus(ELEVATION_LIFETIME_MS) }).success);
  assert.ok(!SessionElevationSchema.safeParse({ ...base, expiresAt: plus(ELEVATION_MAX_LIFETIME_MS + 1) }).success);
  assert.ok(!SessionElevationSchema.safeParse({ ...base, expiresAt: t0 }).success);
  assert.ok(elevationLive({ expiresAt: plus(60_000), revokedAt: null }, new Date(t0)));
  assert.ok(!elevationLive({ expiresAt: plus(60_000), revokedAt: t0 }, new Date(t0)));
  assert.ok(!elevationLive({ expiresAt: t0, revokedAt: null }, new Date(t0)));
});

test('support resets: evidence, a second person, at least 72 hours, never one\'s own account', () => {
  assert.ok(COOLING_OFF_ACTIONS.includes('reset_second_factor'));
  assert.ok(!SecondFactorResetRequestCommandSchema.safeParse({ subjectPersonId: 'p1', supportCaseId: 'c1', evidenceRefs: [], reason: 'lost the phone' }).success, 'evidence required');
  assert.ok(SecondFactorResetRequestCommandSchema.safeParse({ subjectPersonId: 'p1', supportCaseId: 'c1', evidenceRefs: ['e1'], reason: 'lost the phone' }).success);
  const view = { id: 'r1', subjectPersonId: 'p1', supportCaseId: 'c1', requestedBy: 's1', approvedBy: 's2', evidenceCount: 1, requestedAt: t0, approvedAt: t0, effectiveAt: plus(SECOND_FACTOR_RESET_COOLING_OFF_MS), state: 'cooling_off' };
  assert.ok(SecondFactorResetViewSchema.safeParse(view).success);
  assert.ok(!SecondFactorResetViewSchema.safeParse({ ...view, effectiveAt: plus(SECOND_FACTOR_RESET_COOLING_OFF_MS - 1) }).success, 'sooner than 72 hours');
  assert.ok(!SecondFactorResetViewSchema.safeParse({ ...view, approvedBy: 's1' }).success, 'approver is the requester');
  assert.ok(!SecondFactorResetViewSchema.safeParse({ ...view, approvedBy: 'p1' }).success, 'approver is the subject');
  assert.ok(!SecondFactorResetViewSchema.safeParse({ ...view, requestedBy: 'p1', approvedBy: 's2' }).success, 'own account');
  assert.ok(!SecondFactorResetViewSchema.safeParse({ ...view, approvedBy: null, approvedAt: null, effectiveAt: null }).success, 'cooling off without approval');
  assert.ok(SecondFactorResetViewSchema.safeParse({ ...view, approvedBy: null, approvedAt: null, effectiveAt: null, state: 'pending' }).success);
});

test('every second-factor notice event is a security notice the worker renders', async () => {
  const { SECURITY_EVENTS } = await import('../../apps/worker/src/mail/templates.js');
  for (const event of SECOND_FACTOR_NOTICE_EVENTS) assert.ok((SECURITY_EVENTS as readonly string[]).includes(event), event);
});
