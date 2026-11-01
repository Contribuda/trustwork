import { z } from "zod";
import { DigestSchema } from "./common/digest-schema.js";
import { IdSchema, ShortTextSchema, TimestampSchema } from "./common/ids.js";

/** Role declarations describe assistance, never authorship or proof of an agent execution. */
export const PROVENANCE_ROLES = [
  "editorial_scout",
  "editorial_collector",
  "editorial_researcher",
  "editorial_writer",
  "editorial_fact_checker",
  "editorial_translator",
  "editorial_post_editor",
  "editorial_desk",
  "editorial_layout",
  "editorial_designer",
  "editorial_illustrator",
  "editorial_photo_research",
  "editorial_metadata",
  "editorial_distribution",
  "editorial_curator",
  "editorial_licence_checker",
  "editorial_accessibility",
  "editorial_corrections_watch",
  "editorial_knowledge",
] as const;
export const ProvenanceRoleSchema = z.enum(PROVENANCE_ROLES);
export const ProvenanceBindingSchema = z.strictObject({
  publicationId: IdSchema,
  version: z.int().positive(),
  digest: DigestSchema,
});
export const ProvenanceKindSchema = z.enum([
  "none",
  "ai_assisted",
  "machine_translation",
  "generated",
]);
export const ProvenanceDeclarationSchema = z
  .strictObject({
    binding: ProvenanceBindingSchema,
    expectedRevision: z.int().nonnegative(),
    kind: ProvenanceKindSchema,
    roles: z.array(ProvenanceRoleSchema).max(PROVENANCE_ROLES.length),
    evidence: z.literal("human_declaration"),
    original: ProvenanceBindingSchema.nullable(),
    reason: ShortTextSchema,
  })
  .refine((v) => new Set(v.roles).size === v.roles.length, {
    message: "role keys are unique",
  })
  .refine((v) => v.kind !== "none" || v.roles.length === 0, {
    message: "participating agent roles require an assistance disclosure",
  })
  .refine((v) => (v.kind === "machine_translation") === (v.original !== null), {
    message: "translations bind an original version",
  })
  .refine((v) => v.original?.publicationId !== v.binding.publicationId, {
    message: "a translation is a different publication",
  });
export type ProvenanceDeclaration = z.infer<typeof ProvenanceDeclarationSchema>;
export const ProvenanceReviewSchema = z.strictObject({
  provenanceId: IdSchema,
  binding: ProvenanceBindingSchema,
  original: ProvenanceBindingSchema,
  reason: ShortTextSchema,
});
export type ProvenanceReview = z.infer<typeof ProvenanceReviewSchema>;

/** Exact record, role, credit text and delivery channels; never inferred from profile consent. */
export const PROVENANCE_CREDIT_NOTICE = "provenance.credit.v1" as const;
export const ProvenanceChannelSchema = z.enum(["web", "feed", "pdf"]);
export const ProvenanceCreditRoleSchema = z.enum([
  "responsible_editor",
  "translation_reviewer",
]);
export const ProvenanceConsentSchema = z
  .strictObject({
    provenanceId: IdSchema,
    role: ProvenanceCreditRoleSchema,
    credit: z.string().trim().min(1).max(200),
    channels: z.array(ProvenanceChannelSchema).min(1).max(3),
    noticeVersion: z.literal(PROVENANCE_CREDIT_NOTICE),
    informedConsent: z.literal(true),
  })
  .refine((v) => new Set(v.channels).size === v.channels.length, {
    message: "channels are unique",
  });
export type ProvenanceConsent = z.infer<typeof ProvenanceConsentSchema>;
export const ProvenanceRevokeSchema = z.strictObject({
  consentId: IdSchema,
  reason: ShortTextSchema,
});
export const ProvenanceRecordSchema = z.strictObject({
  id: IdSchema,
  binding: ProvenanceBindingSchema,
  revision: z.int().positive(),
  responsiblePersonId: IdSchema,
  kind: ProvenanceKindSchema,
  roles: z.array(ProvenanceRoleSchema),
  evidence: z.literal("human_declaration"),
  original: ProvenanceBindingSchema.nullable(),
  reason: ShortTextSchema,
  recordedAt: TimestampSchema,
});

/** E3 is unapproved. Neither commands nor a configuration switch can enable it. */
export const PROVENANCE_AUTOMATIC_PUBLICATION = false as const;
export const DigitalSourceTypeSchema = z.enum([
  "trainedAlgorithmicMedia",
  "compositeWithTrainedAlgorithmicMedia",
]);
export const ImageProvenanceInputSchema = z.strictObject({
  binding: ProvenanceBindingSchema,
  provenanceId: IdSchema,
  assetId: IdSchema,
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  digitalSourceType: DigitalSourceTypeSchema,
  depictsRealPerson: z.literal(false),
  documentary: z.literal(false),
});
export type ImageProvenanceInput = z.infer<typeof ImageProvenanceInputSchema>;
/** This attachment is explicitly a test artifact, not a C2PA claim, signature or trust assertion. */
export const FakeImageAttachmentSchema = z.strictObject({
  format: z.literal("trustwork-provenance-test-attachment-1"),
  assurance: z.literal("test_only_unsigned"),
  c2paValid: z.literal(false),
  input: ImageProvenanceInputSchema,
  attachmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FakeImageAttachment = z.infer<typeof FakeImageAttachmentSchema>;
