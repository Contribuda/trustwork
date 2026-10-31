import { z } from 'zod';
import restricted from '../packs/restricted.json' with { type: 'json' };
import { LocalizedText, SourceSchema } from './facets.js';

export const RestrictedPlacesSchema = z.strictObject({
  $comment: z.string(),
  places: z.array(z.strictObject({ code: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/), name: LocalizedText, basis: z.string().min(1) })).min(1),
  sources: z.array(SourceSchema).min(1),
});

/** Restricted places (ISO 3166-1 alpha-2 or ISO 3166-2). The engine never serves them and never lists them. This list is authoritative: no pack, layer or facet can add to it, remove from it or override it. */
export const RESTRICTED = RestrictedPlacesSchema.parse(restricted);
const RESTRICTED_CODES = new Set(RESTRICTED.places.map((p) => p.code));

export function isRestricted(code: string): boolean {
  const upper = code.toUpperCase();
  return RESTRICTED_CODES.has(upper) || RESTRICTED_CODES.has(upper.split('-')[0] ?? '');
}
