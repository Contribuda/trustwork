import { z } from 'zod';

/** Client-safe digest vocabulary: no crypto here. Computation lives in `digest.ts` (server only). */
export const DIGEST_ALGORITHM = 'trustwork-digest-1' as const;
export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, 'lowercase hex sha-256');
/** `trustwork-digest-1` = lowercase hex of SHA-256 over the RFC 8785 canonical bytes of an explicit digest input. */
export const DigestSchema = z.strictObject({ algorithm: z.literal(DIGEST_ALGORITHM), value: Sha256HexSchema });
export type Digest = z.infer<typeof DigestSchema>;

export function digestEquals(a: Digest, b: Digest): boolean {
  return a.algorithm === b.algorithm && a.value === b.value;
}
