import { z } from "zod";
import { IdSchema } from "./common/ids.js";
import {
  DigitalSourceTypeSchema,
  ProvenanceBindingSchema,
} from "./provenance.js";

/**
 * Server-side image contracts (PROV-001), kept out of the browser bundle: only `PublicProvenanceSchema` reaches readers.
 * The person states what the image is; the attestations are literals, so a real person or documentary image has no
 * valid request at all. Alt text is required because the reader shows the image.
 */
export const ImageProvenanceRequestSchema = z.strictObject({
  provenanceId: IdSchema,
  binding: ProvenanceBindingSchema,
  assetId: IdSchema,
  digitalSourceType: DigitalSourceTypeSchema,
  altText: z.string().trim().min(1).max(500),
  depictsRealPerson: z.literal(false),
  documentary: z.literal(false),
});
export type ImageProvenanceRequest = z.infer<
  typeof ImageProvenanceRequestSchema
>;
export const ProvenanceImageViewSchema = z.strictObject({
  id: IdSchema,
  provenanceId: IdSchema,
  digitalSourceType: DigitalSourceTypeSchema,
  altText: z.string(),
  status: z.enum(["pending", "carried", "failed"]),
  failure: z.string().nullable(),
  ready: z.boolean(),
});
export type ProvenanceImageView = z.infer<typeof ProvenanceImageViewSchema>;

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
