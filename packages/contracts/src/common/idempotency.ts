import { z } from 'zod';
import { canonicalize } from './canonical.js';
import { DigestSchema, digestEquals, type Digest } from './digest-schema.js';
import { IdSchema, TimestampSchema } from './ids.js';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key' as const;
export const IdempotencyKeySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

/** Scope `(principal, action, context, key)`: the key alone is never authorization and never global. */
export const IdempotencyScopeSchema = z.strictObject({
  principalId: IdSchema,
  action: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_.]*$/),
  contextId: IdSchema,
  key: IdempotencyKeySchema,
});
export type IdempotencyScope = z.infer<typeof IdempotencyScopeSchema>;

export const IdempotencyRecordSchema = z.strictObject({
  scope: IdempotencyScopeSchema,
  /** trustwork-digest-1 over the canonical command payload (without the key itself); computed server-side from the canonical payload. */
  payloadDigest: DigestSchema,
  status: z.enum(['in_progress', 'completed']),
  /** Recorded result of the first execution; replayed as-is for the same key and payload. */
  result: z.strictObject({ httpStatus: z.int().min(200).max(599), body: z.unknown() }).nullable(),
  recordedAt: TimestampSchema,
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

/** Builds the scope and the unique storage key (canonical JSON of the scope) in one step. */
export function buildIdempotencyScope(input: IdempotencyScope): { scope: IdempotencyScope; storageKey: string } {
  const scope = IdempotencyScopeSchema.parse(input);
  return { scope, storageKey: canonicalize(scope) };
}
export type IdempotencyResolution = { kind: 'first' } | { kind: 'replay'; result: NonNullable<IdempotencyRecord['result']> } | { kind: 'in_progress' } | { kind: 'conflict' };
/** Same key + same payload digest -> recorded result; same key + different digest -> conflict; unfinished -> in_progress. */
export function resolveIdempotency(existing: IdempotencyRecord | null, payloadDigest: Digest): IdempotencyResolution {
  if (!existing) return { kind: 'first' };
  if (!digestEquals(existing.payloadDigest, payloadDigest)) return { kind: 'conflict' };
  if (existing.status === 'in_progress' || !existing.result) return { kind: 'in_progress' };
  return { kind: 'replay', result: existing.result };
}
