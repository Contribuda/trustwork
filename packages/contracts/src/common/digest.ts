import { createHash } from 'node:crypto';
import { canonicalBytes } from './canonical.js';
import { DIGEST_ALGORITHM, DigestSchema, digestEquals, type Digest } from './digest-schema.js';

export * from './digest-schema.js';

/**
 * Server-side only (node:crypto): the server computes digests; a client-supplied digest is compared and rejected on
 * mismatch, never trusted. Clients import the schema vocabulary from `digest-schema.ts` through the `./client` entry.
 */
export function computeDigest(digestInput: unknown): Digest {
  return { algorithm: DIGEST_ALGORITHM, value: createHash('sha256').update(canonicalBytes(digestInput)).digest('hex') };
}
/** Integrity check: recomputes the digest of `digestInput` and compares it with the recorded one. */
export function verifyDigest(digestInput: unknown, recorded: Digest): boolean {
  return DigestSchema.safeParse(recorded).success && digestEquals(computeDigest(digestInput), recorded);
}
