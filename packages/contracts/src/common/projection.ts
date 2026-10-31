import { z } from 'zod';

/**
 * Five projection layers. Each API read, search hit, export and notification passes through one explicit
 * allowlist serializer per layer; counts and existence checks honour the same layer.
 */
export const PROJECTION_LAYERS = ['public', 'shared_party', 'party_private', 'owner_private', 'staff_case'] as const;
export const ProjectionLayerSchema = z.enum(PROJECTION_LAYERS);
export type ProjectionLayer = z.infer<typeof ProjectionLayerSchema>;

/** Highest layer a grant may reveal; `public` is implicit and never granted, `staff_case` comes only from a case grant. */
export const GrantAudienceSchema = z.enum(['shared_party', 'party_private', 'owner_private']);
export type GrantAudience = z.infer<typeof GrantAudienceSchema>;

const RANK: Record<ProjectionLayer, number> = { public: 0, shared_party: 1, party_private: 2, owner_private: 3, staff_case: 1 };
/** `staff_case` is a diagnostic subset, not a superset: it is ranked beside `shared_party` and never widens to party-private data. */
export function layerAtMost(requested: ProjectionLayer, allowed: ProjectionLayer): boolean {
  if (requested === 'staff_case' || allowed === 'staff_case') return requested === allowed;
  return RANK[requested] <= RANK[allowed];
}

/** Picks an explicit allowlist; unknown keys never leak because the result is re-validated by a strict schema. */
export function pickFields<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}
