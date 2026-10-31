import { z } from 'zod';
import { PartySchema } from './access.js';
import { IdSchema, NameSchema, RevisionSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { MoneySchema } from './common/money.js';
import { QuantitySchema, UnitCodeSchema } from './common/quantity.js';
import { VersionNumberSchema } from './common/version.js';

export const OfferingKindSchema = z.enum(['goods', 'works', 'services', 'bundle']);
export const LineKindSchema = z.enum(['goods', 'works', 'services']);
export type LineKind = z.infer<typeof LineKindSchema>;

export const OfferingSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  kind: OfferingKindSchema,
  status: z.enum(['draft', 'active', 'archived']),
  currentVersion: VersionNumberSchema.nullable(),
  revision: RevisionSchema,
});
export type Offering = z.infer<typeof OfferingSchema>;

export const OfferingVersionPayloadSchema = z.strictObject({
  title: NameSchema,
  description: TextSchema.nullable(),
  specification: z.record(z.string().max(100), z.string().max(2000)),
  unit: UnitCodeSchema,
  listPrice: MoneySchema.nullable(),
  options: z.array(z.strictObject({ label: NameSchema, priceDelta: MoneySchema })),
  availability: z.strictObject({ state: z.enum(['available', 'limited', 'unavailable', 'unknown']), capacity: QuantitySchema.nullable(), observedAt: TimestampSchema }),
  components: z.array(z.strictObject({ offeringId: IdSchema, version: VersionNumberSchema, quantity: QuantitySchema })),
});
export const OfferingVersionSchema = z.strictObject({
  offeringId: IdSchema,
  version: VersionNumberSchema,
  status: z.enum(['draft', 'published', 'superseded']),
  payload: OfferingVersionPayloadSchema,
  /** Allowlist of payload keys shown publicly; private commercial knowledge lives in `privateKnowledge`. */
  publicFields: z.array(z.enum(['title', 'description', 'specification', 'unit', 'listPrice', 'options', 'availability'])),
  privateKnowledge: z.strictObject({ costBasis: MoneySchema.nullable(), marginTarget: z.string().nullable(), notes: TextSchema.nullable() }),
  publishedAt: TimestampSchema.nullable(),
});
export type OfferingVersion = z.infer<typeof OfferingVersionSchema>;

export const PublicOfferingVersionSchema = z.strictObject({
  offeringId: IdSchema,
  version: VersionNumberSchema,
  fields: OfferingVersionPayloadSchema.omit({ components: true }).partial(),
});
/** Only published versions and only allowlisted fields; `privateKnowledge` never appears. */
export function toPublicOfferingVersion(v: OfferingVersion): z.infer<typeof PublicOfferingVersionSchema> | null {
  if (v.status !== 'published') return null;
  const fields: Record<string, unknown> = {};
  for (const key of v.publicFields) fields[key] = v.payload[key];
  return PublicOfferingVersionSchema.parse({ offeringId: v.offeringId, version: v.version, fields });
}
