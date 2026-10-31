import { z } from 'zod';

/**
 * Opaque identifier token. Persistence generates UUIDs (DATA-001); the contract only constrains the
 * token alphabet and length so fixtures stay readable and the storage choice does not leak into clients.
 * Identifiers never grant access.
 */
export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'opaque identifier token');
export type Id = z.infer<typeof IdSchema>;

/** Optimistic-concurrency revision of a mutable envelope. Starts at 1 and increases by one per committed change. */
export const RevisionSchema = z.int().min(1);
export type Revision = z.infer<typeof RevisionSchema>;

/** RFC 3339 UTC timestamp (`Z` suffix only). Business dates with local meaning use `BusinessDateSchema`. */
export const TimestampSchema = z.iso.datetime({ offset: false });
export type Timestamp = z.infer<typeof TimestampSchema>;

export const IanaTimeZoneSchema = z.string().regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$|^UTC$/, 'IANA time zone');
export const BusinessDateSchema = z.strictObject({ date: z.iso.date(), timeZone: IanaTimeZoneSchema });
export type BusinessDate = z.infer<typeof BusinessDateSchema>;

/** Normalizes to NFC at the validation boundary so stored bytes equal digested bytes (JCS applies no normalization). */
export const nfc = (value: string): string => value.normalize('NFC');
/** Normalize first so length limits apply to the stored (NFC) form. */
export const TextSchema = z.string().overwrite(nfc).max(20_000);
export const ShortTextSchema = z.string().overwrite(nfc).min(1).max(500);
export const NameSchema = z.string().overwrite(nfc).trim().min(1).max(200);

export const RequestIdSchema = IdSchema;

/** Reference to a stored evidence artifact; `hash` is the immutable content hash recorded at upload. */
export const AttachmentRefSchema = z.strictObject({
  evidenceArtifactId: IdSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/, 'lowercase hex sha-256'),
  audience: z.literal('shared'),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
