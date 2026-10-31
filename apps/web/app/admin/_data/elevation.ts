import { SessionElevationSchema, type SessionElevation } from '@trustwork/contracts/client';
import type { ElevationState } from './port.js';

/**
 * The console's elevation gate on BE-004's elevated sessions (`SessionElevationSchema`, `POST
 * /v1/admin/session/elevate`, 15 minutes by default): a console page or command counts as elevated only while the
 * session's elevation is unrevoked, already started and not yet expired, and belongs to the viewer. Anything else,
 * including a missing or malformed record, requires a new elevation. The API repeats the check (`ElevationGuard`).
 */
export function elevationState(record: unknown, viewerPersonId: string, now: Date): ElevationState {
  const parsed = SessionElevationSchema.safeParse(record);
  if (!parsed.success) return { state: 'required' };
  const elevation: SessionElevation = parsed.data;
  const t = now.getTime();
  const live = elevation.personId === viewerPersonId && elevation.revokedAt === null && Date.parse(elevation.createdAt) <= t && Date.parse(elevation.expiresAt) > t;
  return live ? { state: 'elevated', until: elevation.expiresAt } : { state: 'required' };
}
