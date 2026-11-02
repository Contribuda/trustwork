import { z } from 'zod';
import { consoleCommand } from '../../deps/contracts.js';
import { REGISTER_ADAPTERS } from './deps.js';

/**
 * Console commands of the registers routes (REG-001). Every command carries the console base (contract version,
 * idempotency key, staff reason); the database repeats every rule. A fake run names subjects (an identifier value, or
 * a record reference for registers without identifiers); the API computes the deterministic observations itself, so a
 * person never types a register fact.
 */
const Id = z.uuid();
const AdapterId = z.enum(REGISTER_ADAPTERS.map((a) => a.id) as [string, ...string[]]);
const IdentifierValue = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]{0,63}$/);
const RecordRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/);

export const BindAdapterCommandSchema = consoleCommand({ adapter: AdapterId, sourceId: Id, refreshDays: z.int().min(1).max(30) });
export const GoLiveCommandSchema = consoleCommand({ expectedRevision: z.int().min(1), credentialRefId: Id, approvalId: Id.nullable() });
export const RetireAdapterCommandSchema = consoleCommand({ expectedRevision: z.int().min(1) });
export const FakeRunCommandSchema = consoleCommand({
  subjects: z.array(z.union([
    z.strictObject({ identifierValue: IdentifierValue }),
    z.strictObject({ identifierValue: z.null(), recordRef: RecordRef }),
  ])).min(1).max(100),
});
export const LinkRecordCommandSchema = consoleCommand({ adapterId: Id, recordRef: RecordRef, companyId: Id, reason: z.string().trim().min(10).max(1000) });
export const EndLinkCommandSchema = consoleCommand({});
