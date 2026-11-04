import { z } from 'zod';

/**
 * The change a second-person approval binds (HUBC-007), as `GET /v1/admin/approvals` reports it. The server computes it
 * from what the digest binds (`admin_approval_change`), never from the requester's reason. `bound: false` means nothing
 * proves what the digest binds: the console says so and offers no approval, and nothing is guessed. Every field the digest
 * binds is here, each named by its path in the digest input; the database refuses to approve what this cannot show.
 */
const Digest = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * One side of a change: nothing, a value as stored, a locale key under `admin.`, a person, or a length of time. A person
 * always carries the identifier: a display name is chosen at sign-up, is not unique and may be missing. `maskedEmail` is
 * the primary verified address for staff and support changes, masked as the support workspace shows it.
 */
export const ApprovalChangeValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('text'), value: z.string().min(1).max(4000) }),
  z.strictObject({ kind: z.literal('key'), key: z.string().regex(/^[a-z][a-zA-Z0-9_-]*(\.[a-z][a-zA-Z0-9_-]*)*$/) }),
  z.strictObject({ kind: z.literal('person'), personId: z.string().min(1), displayName: z.string().min(1).nullable(), maskedEmail: z.string().min(1).nullable().default(null) }),
  z.strictObject({ kind: z.literal('duration'), seconds: z.int().min(0) }),
]);
export type ApprovalChangeValue = z.infer<typeof ApprovalChangeValueSchema>;

export const ApprovalChangeFieldSchema = z.strictObject({ field: z.string().regex(/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_-]+)*$/), before: ApprovalChangeValueSchema, after: ApprovalChangeValueSchema });
export type ApprovalChangeField = z.infer<typeof ApprovalChangeFieldSchema>;

/** How the console finishes an approved change that has no drafted version: a lifecycle transition at this revision. */
export const ApprovalApplySchema = z.strictObject({ kind: z.literal('lifecycle'), to: z.enum(['soft_launch', 'public']), revision: z.int().min(1) });

export const ApprovalChangeSchema = z.strictObject({
  bound: z.boolean(),
  /** False when the viewer does not hold the read permission of the change's domain: only action, scope and digest. */
  visible: z.boolean(),
  /** False when a value or the list was too long to show whole, or a value could not be read; the change then cannot be approved. */
  complete: z.boolean(),
  /** False when the object moved on, so executing would fail; `currentDigest` is then null. */
  current: z.boolean(),
  currentDigest: Digest.nullable(),
  fields: z.array(ApprovalChangeFieldSchema),
  apply: ApprovalApplySchema.nullable(),
});
export type ApprovalChange = z.infer<typeof ApprovalChangeSchema>;
