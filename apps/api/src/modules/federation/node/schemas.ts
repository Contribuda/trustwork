import { z } from 'zod';
import {
  consoleCommand, IdSchema, KeyIdSchema, MESH_DATA_CLASSES, NodeHostSchema, PEERING_LEVELS, PeeringLevelSchema, RevisionSchema, SyndicationTermSchema, TimestampSchema, type MeshDataClass,
} from './deps.js';

/**
 * Console commands of the federation node (FED-001): the node identity and its genesis key, key rotation, peering
 * requests and decisions. Every command carries the console base (contract version, idempotency key, reason).
 */
const Uuid = z.uuid();
const ContactSchema = z.string().max(320).regex(/^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, 'mailto: or https: contact of a role, not a person');
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
export const LicencesSchema = z.strictObject(Object.fromEntries(MESH_DATA_CLASSES.map((c) => [c, SyndicationTermSchema])) as Record<MeshDataClass, typeof SyndicationTermSchema>);

const identityShape = {
  engineVersion: SemverSchema.optional(),
  engineSource: z.string().max(300).regex(/^https:\/\/\S+$/).optional(),
  operatorName: z.string().trim().min(1).max(200),
  registration: z.strictObject({ kind: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), value: z.string().trim().min(1).max(64) }).nullable(),
  abuseContact: ContactSchema,
  takedownContact: ContactSchema,
  jurisdiction: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/),
  /** Omitted: the default licence of every class. */
  licences: LicencesSchema.partial().optional(),
  tombstoneHours: z.int().min(1).max(72).default(72),
  offeredLevels: z.array(PeeringLevelSchema).min(1).max(4).default([...PEERING_LEVELS]),
  agentEnvelopesPerHour: z.int().min(0).max(10_000).default(60),
};
export const InitializeNodeCommandSchema = consoleCommand({ host: NodeHostSchema, keyId: KeyIdSchema.default('k1'), ...identityShape });
export type InitializeNodeCommand = z.infer<typeof InitializeNodeCommandSchema>;
export const UpdateNodeCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, ...identityShape });
export type UpdateNodeCommand = z.infer<typeof UpdateNodeCommandSchema>;
/** Rotation (second person: ops.rotate_node_key); `compromisedSince` publishes a revocation of the retiring key. */
export const RotateKeyCommandSchema = consoleCommand({ nextKeyId: KeyIdSchema, compromisedSince: TimestampSchema.nullable().default(null), approvalId: IdSchema.nullable().default(null) });
export type RotateKeyCommand = z.infer<typeof RotateKeyCommandSchema>;

export const RequestPeeringCommandSchema = consoleCommand({
  localHubId: Uuid,
  peerNode: NodeHostSchema,
  /** The peer's hub as its manifest names it. */
  peerHubId: IdSchema,
  level: PeeringLevelSchema,
  approvalId: IdSchema.nullable().default(null),
});
export type RequestPeeringCommand = z.infer<typeof RequestPeeringCommandSchema>;
export const AcceptPeeringCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, level: PeeringLevelSchema, approvalId: IdSchema.nullable().default(null) });
export type AcceptPeeringCommand = z.infer<typeof AcceptPeeringCommandSchema>;
export const RecordCommandSchema = consoleCommand({ expectedRevision: RevisionSchema });
export type RecordCommand = z.infer<typeof RecordCommandSchema>;
export const LowerPeeringCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, level: PeeringLevelSchema });
export type LowerPeeringCommand = z.infer<typeof LowerPeeringCommandSchema>;
export const RefreshPeerCommandSchema = consoleCommand({ peerNode: NodeHostSchema });
export type RefreshPeerCommand = z.infer<typeof RefreshPeerCommandSchema>;

/** The digest a second person approves for a peering at deal_routing or identity (mirrors federation_peering_digest). */
export function peeringLevelDigestInput(p: { localHubId: string; peerNode: string; peerHubId: string; level: string }) {
  return { action: 'federation.raise_peering_level', object: 'peering_record', localHubId: p.localHubId, peerNode: p.peerNode, peerHubId: p.peerHubId, level: p.level };
}
/** The digest a second person approves for a key rotation (mirrors federation_rotation_digest). */
export function keyRotationDigestInput(r: { nodeId: string; previousKeyId: string; compromisedSince: string | null }) {
  return { action: 'ops.rotate_node_key', object: 'node_key', nodeId: r.nodeId, previousKeyId: r.previousKeyId, compromisedSince: r.compromisedSince };
}
