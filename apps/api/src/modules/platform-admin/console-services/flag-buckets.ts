import { createHash } from 'node:crypto';
import type { FlagStage } from './deps.js';

/**
 * Which sessions a share of a flag covers. The bucket depends only on the flag's id, which the database generates, and
 * the session id, never on a person, a company or anything a staff member can name, so a stage can be a share of sessions
 * but never a chosen individual. A person gets a new bucket with a new session. A session in the 5 percent is in the
 * 25 percent too, so widening a share only adds sessions.
 */
export function flagBucket(flagId: string, sessionId: string): number {
  return createHash('sha256').update(`${flagId}:${sessionId}`).digest().readUInt32BE(0) % 100;
}

/** Is a flag at this stage in force for this session? Staff means staff covering the hub being read. */
export function flagInForce(flag: { id: string; stage: FlagStage; sharePercent: number | null }, session: { id: string; staff: boolean }): boolean {
  switch (flag.stage) {
    case 'off': return false;
    case 'staff_only': return session.staff;
    case 'share': return flag.sharePercent !== null && flagBucket(flag.id, session.id) < flag.sharePercent;
    case 'on': return true;
  }
}
