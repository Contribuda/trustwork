import { z } from 'zod';
import { canonicalize } from './canonical.js';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from './encoding.js';
import { IdSchema } from './ids.js';

export const PAGE_LIMIT_MAX = 100;
/** Cursor pagination with a deterministic `(sortKey, id)` tie break; cursors are opaque to clients and audience-checked on use. */
export const CursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const PageRequestSchema = z.strictObject({
  limit: z.int().min(1).max(PAGE_LIMIT_MAX).default(20),
  cursor: CursorSchema.optional(),
});
export type PageRequest = z.infer<typeof PageRequestSchema>;

export const CursorPayloadSchema = z.strictObject({ sortKey: z.string().max(200), id: IdSchema });
export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

export function encodeCursor(payload: CursorPayload): string {
  return toBase64Url(utf8Encode(canonicalize(CursorPayloadSchema.parse(payload))));
}
export function decodeCursor(cursor: string): CursorPayload | null {
  if (!CursorSchema.safeParse(cursor).success) return null;
  const bytes = fromBase64Url(cursor);
  if (!bytes) return null;
  try {
    const parsed = CursorPayloadSchema.safeParse(JSON.parse(utf8Decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item), nextCursor: CursorSchema.nullable() });
}
