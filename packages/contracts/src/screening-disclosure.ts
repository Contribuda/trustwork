import { z } from 'zod';
import { OwnComplianceStatusSchema, OWN_COMPLIANCE_STATUSES } from './sanctions.js';

export const DISCLOSURE_PURPOSE = 'sanctions_subject_notice' as const;
export const DISCLOSURE_CHANNELS = ['own_ui', 'email'] as const;
export const DISCLOSURE_TRANSITIONS = ['hold', 'cleared', 'review', 'confirmed', 'not_same_person', 'appeal_received', 'appeal_upheld', 'appeal_reversed'] as const;
export const DISCLOSURE_MESSAGE_KEYS = [
  'clear', 'checking', 'name_needed', 'review', 'suspended', 'appeal_pending',
  'hold', 'cleared', 'confirmed', 'not_same_person', 'appeal_received', 'appeal_upheld', 'appeal_reversed',
] as const;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const Locale = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).max(35);
const Interval = { effectiveFrom: z.iso.datetime(), effectiveUntil: z.iso.datetime() };
const distinct = <T>(values: T[]) => new Set(values).size === values.length;
const Jurisdictions = z.array(z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/)).min(1).max(32).refine(distinct);
export const DisclosureRulesSchema = z.strictObject({
  subjectKinds: z.array(z.enum(['person', 'company'])).min(1).max(2).refine(distinct),
  channels: z.array(z.enum(DISCLOSURE_CHANNELS)).min(1).max(2).refine(distinct),
  jurisdictions: Jurisdictions,
  statuses: z.array(z.enum(OWN_COMPLIANCE_STATUSES)).max(6).refine(distinct),
  transitions: z.array(z.enum(DISCLOSURE_TRANSITIONS)).max(8).refine(distinct),
  permittedFields: z.array(z.enum(['status', 'paymentsPaused', 'canAppeal', 'transition'])).min(1).max(4).refine(distinct),
});
export const DisclosureMessagesSchema = z.strictObject(Object.fromEntries(DISCLOSURE_MESSAGE_KEYS.map((key) => [key, z.string().min(1).max(1000)])) as Record<typeof DISCLOSURE_MESSAGE_KEYS[number], z.ZodString>);
/** Counsel reviews these exact locale bytes and the exact bounded rules, never a free-text scope_note. */
export const DisclosureLegalBodySchema = z.strictObject({
  purpose: z.literal(DISCLOSURE_PURPOSE), locale: Locale, rulesDigest: Hash, messages: DisclosureMessagesSchema,
});
export const DisclosureSourceSchema = z.strictObject({
  schemaVersion: z.literal(1), purpose: z.literal(DISCLOSURE_PURPOSE), nodeId: z.uuid(), hubId: z.uuid(),
  producerId: Token, sourceKey: Token, version: Token, ...Interval,
  rules: DisclosureRulesSchema,
  provenance: z.array(z.strictObject({ sourceId: Token, version: Token, contentDigest: Hash })).min(1).max(32),
  review: z.strictObject({ reviewId: Token, evidenceDigest: Hash, reviewedAt: z.iso.datetime(), rulesDigest: Hash }),
  wording: z.array(z.strictObject({ locale: Locale, documentId: z.uuid(), bodyDigest: Hash, counselApprovalId: z.uuid(), messagesDigest: Hash })).min(1).max(32),
}).refine((v) => v.effectiveUntil > v.effectiveFrom && distinct(v.wording.map((w) => w.locale)));
export type DisclosureSource = z.infer<typeof DisclosureSourceSchema>;
export const DisclosureApplicabilitySchema = z.strictObject({
  schemaVersion: z.literal(1), purpose: z.literal(DISCLOSURE_PURPOSE), producerId: Token,
  nodeId: z.uuid(), hubId: z.uuid(), subjectKind: z.enum(['person', 'company']), subjectId: z.uuid(), recipientId: z.uuid(),
  channel: z.enum(DISCLOSURE_CHANNELS), jurisdictions: Jurisdictions,
  complete: z.literal(true), evidenceId: Token, evidenceDigest: Hash, version: Token, ...Interval,
}).refine((v) => v.effectiveUntil > v.effectiveFrom);
export type DisclosureApplicability = z.infer<typeof DisclosureApplicabilitySchema>;
export const OwnCompliancePresentationSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('generic'), messageKey: z.literal('compliance.generic'), canAppeal: z.boolean() }),
  z.strictObject({ mode: z.literal('detailed'), status: OwnComplianceStatusSchema,
    wording: z.strictObject({ locale: Locale, key: z.enum(OWN_COMPLIANCE_STATUSES), messagesDigest: Hash }) }),
]);
export type OwnCompliancePresentation = z.infer<typeof OwnCompliancePresentationSchema>;
export const ComplianceAppealReceiptSchema = z.strictObject({ recorded: z.literal(true) });
export const complianceAppealReceipt = () => ComplianceAppealReceiptSchema.parse({ recorded: true });
export const PublishDisclosureCommandSchema = z.strictObject({ sourceId: z.uuid(), sourceDigest: Hash, expectedSourceRevision: z.int().positive(), reason: z.string().trim().min(1).max(500) });
export const ActivateDisclosureCommandSchema = z.strictObject({ expectedRevision: z.int().nonnegative(), approvalId: z.uuid(), reason: z.string().trim().min(1).max(500) });
export const RevokeDisclosureCommandSchema = z.strictObject({ expectedRevision: z.int().positive(), reason: z.string().trim().min(1).max(500) });
export const NominateComplianceRecipientCommandSchema = z.strictObject({
  recipientId: z.uuid(), hubId: z.uuid(), purpose: z.literal(DISCLOSURE_PURPOSE), channel: z.literal('email'),
  expectedRevision: z.int().nonnegative(), expiresAt: z.iso.datetime(),
});
export const AcceptComplianceRecipientCommandSchema = z.strictObject({ digest: Hash });
