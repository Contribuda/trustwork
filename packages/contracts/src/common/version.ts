import { z } from 'zod';
import { DigestSchema } from './digest-schema.js';
import { IdSchema } from './ids.js';

/** Version numbers are the only JSON numbers inside digest inputs (I-JSON integers). */
export const VersionNumberSchema = z.int().min(1);
/** Pin by `id`; verify by `digest`. Identity decisions (staleness, comparability, acceptance) use `id`, never the digest. */
export const VersionRefSchema = z.strictObject({ id: IdSchema, version: VersionNumberSchema, digest: DigestSchema });
export type VersionRef = z.infer<typeof VersionRefSchema>;

export function sameVersion(a: VersionRef, b: VersionRef): boolean {
  return a.id === b.id;
}
