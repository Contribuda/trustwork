import { createHash } from 'node:crypto';
import type { FlagStage } from './deps.js';

/**
 * Which people a share of a flag covers. The bucket is a hash of the flag's id, which the database generates, and the
 * person's id, so signing in again cannot reach a share by retrying, and a person sees the same thing on every device.
 * Nobody chooses it: a stage names a percent, and which people that is follows from a generated id, so a stage can be a
 * share but never a chosen individual. Someone in the 5 percent is in the 25 percent too, so widening only adds people.
 */
export function flagBucket(flagId: string, personId: string): number {
  return createHash('sha256').update(`${flagId}:${personId}`).digest().readUInt32BE(0) % 100;
}

/** Is a flag at this stage in force for this person? Staff means staff covering the hub being read. */
export function flagInForce(flag: { id: string; stage: FlagStage; sharePercent: number | null }, reader: { personId: string; staff: boolean }): boolean {
  switch (flag.stage) {
    case 'off': return false;
    case 'staff_only': return reader.staff;
    case 'share': return flag.sharePercent !== null && flagBucket(flag.id, reader.personId) < flag.sharePercent;
    case 'on': return true;
  }
}
