import { Kysely, PostgresDialect, sql, type RawBuilder } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type { Database } from '../schema/index.js';
import type {
  AdmissionRefusalRow, AdmissionTrigger, FederationPeerRow, NodeIdentityRow, NodeKeyRow, NodeManifestRow, PeerDealAdmissionRow, PeerKeyRevocationRow, PeeringEventRow,
  PeeringLevelCode, PeeringRecordRow, SuspensionReason,
} from '../schema/federation-node.js';
import type { CommandContext } from './admin.js';

/**
 * Federation node repository (FED-001, migration packages/data/migrations/federation-node).
 *
 * - **Staff commands** under `withPrincipal` with a `CommandContext` (BE-004 elevation): the node identity and genesis
 *   key, key rotation (second person: ops.rotate_node_key), peering requests and acceptances (second person above
 *   trust_verifications: federation.raise_peering_level), decline, lower, suspend, lift and defederate. Each calls one
 *   `federation_*` SECURITY DEFINER command that resolves the caller's permission at the hub or the node and writes the
 *   audit row in the same transaction.
 * - **Node-run commands** on the pool or a transaction without a principal: what the node's own process records while it
 *   speaks the protocol (its signed manifests, peers' manifests and admissions, handshakes, answers, nonces, refusals,
 *   deal admissions, revocations) and the readers the protocol handlers need.
 * - **Reads** under row-level security: identity, public key chain and manifests for everyone; peers, records, events,
 *   deal admissions and revocations for federation staff of the node or the hub; refusal records for compliance and
 *   audit readers. The sealed seeds are reachable only through `signingMaterial`.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);
/** A staff transaction or the runtime pool without a principal (node-run commands and protocol readers). */
export type Runner = Transaction | DataPool;
const poolExecutors = new WeakMap<DataPool, Kysely<Database>>();
function executor(runner: Runner): Kysely<Database> {
  if (runner instanceof Kysely) return runner;
  let db = poolExecutors.get(runner);
  if (!db) {
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: runner }) });
    poolExecutors.set(runner, db);
  }
  return db;
}
async function rows<T>(runner: Runner, query: RawBuilder<T>): Promise<T[]> {
  const result = await query.execute(executor(runner));
  return result.rows;
}
async function one<T>(runner: Runner, query: RawBuilder<T>, what: string): Promise<T> {
  const row = (await rows(runner, query))[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}
const json = (value: unknown) => JSON.stringify(value);

export interface NodeIdentityInput {
  engineVersion: string;
  engineSource: string;
  operatorName: string;
  registration: { kind: string; value: string } | null;
  abuseContact: string;
  takedownContact: string;
  jurisdiction: string;
  licences: Record<string, string>;
  tombstoneHours: number;
  offeredLevels: PeeringLevelCode[];
  agentEnvelopesPerHour: number;
}
/** A seed sealed by the process (KEYS-001 envelope encryption); the database never sees a plaintext seed. */
export interface SealedSeed { ciphertext: Buffer; iv: Buffer; authTag: Buffer; wrappedKey: Buffer; kekId: string }
export interface SigningMaterialRow { key_id: string; public_key: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; wrapped_key: Buffer; kek_id: string }

export const nodeIdentity = {
  init(trx: Transaction, ctx: CommandContext, input: NodeIdentityInput & { host: string; key: { keyId: string; publicKey: string; validFrom: Date; sealed: SealedSeed } }): Promise<NodeIdentityRow> {
    const k = input.key;
    return one(trx, sql<NodeIdentityRow>`SELECT * FROM trustwork.federation_init_identity(${ctxJson(ctx)}::jsonb, ${input.host}::text, ${input.engineVersion}::text, ${input.engineSource}::text,
      ${input.operatorName}::text, ${input.registration?.kind ?? null}::text, ${input.registration?.value ?? null}::text, ${input.abuseContact}::text, ${input.takedownContact}::text,
      ${input.jurisdiction}::text, ${json(input.licences)}::jsonb, ${input.tombstoneHours}::integer, ${input.offeredLevels}::text[], ${input.agentEnvelopesPerHour}::integer,
      ${k.keyId}::text, ${k.publicKey}::text, ${k.validFrom}::timestamptz, ${k.sealed.ciphertext}::bytea, ${k.sealed.iv}::bytea, ${k.sealed.authTag}::bytea, ${k.sealed.wrappedKey}::bytea, ${k.sealed.kekId}::text)`, 'federation_init_identity');
  },
  update(trx: Transaction, ctx: CommandContext, expectedRevision: number, input: NodeIdentityInput): Promise<NodeIdentityRow> {
    return one(trx, sql<NodeIdentityRow>`SELECT * FROM trustwork.federation_update_identity(${ctxJson(ctx)}::jsonb, ${expectedRevision}::integer, ${input.engineVersion}::text, ${input.engineSource}::text,
      ${input.operatorName}::text, ${input.registration?.kind ?? null}::text, ${input.registration?.value ?? null}::text, ${input.abuseContact}::text, ${input.takedownContact}::text,
      ${input.jurisdiction}::text, ${json(input.licences)}::jsonb, ${input.tombstoneHours}::integer, ${input.offeredLevels}::text[], ${input.agentEnvelopesPerHour}::integer)`, 'federation_update_identity');
  },
  /** The identity (public), on the pool or in a transaction. */
  async current(runner: Runner): Promise<NodeIdentityRow | null> {
    return (await rows(runner, sql<NodeIdentityRow>`SELECT * FROM trustwork.node_identity LIMIT 1`))[0] ?? null;
  },
};

export const nodeKeys = {
  /** Rotation under a consumed `ops.rotate_node_key` approval (digest: keyRotationDigestInput). `rotationSignature` was made by the previous key in the process. */
  rotate(trx: Transaction, ctx: CommandContext, input: { approvalId: string | null; previousKeyId: string; nextKeyId: string; publicKey: string; rotatedAt: Date; rotationSignature: string; compromisedSince: Date | null; sealed: SealedSeed }): Promise<NodeKeyRow> {
    return one(trx, sql<NodeKeyRow>`SELECT * FROM trustwork.federation_rotate_key(${ctxJson(ctx)}::jsonb, ${input.approvalId}::uuid, ${input.previousKeyId}::text, ${input.nextKeyId}::text, ${input.publicKey}::text,
      ${input.rotatedAt}::timestamptz, ${input.rotationSignature}::text, ${input.compromisedSince}::timestamptz, ${input.sealed.ciphertext}::bytea, ${input.sealed.iv}::bytea, ${input.sealed.authTag}::bytea,
      ${input.sealed.wrappedKey}::bytea, ${input.sealed.kekId}::text)`, 'federation_rotate_key');
  },
  /** The public chain, oldest first (anyone). */
  chain(runner: Runner): Promise<NodeKeyRow[]> {
    return rows(runner, sql<NodeKeyRow>`SELECT * FROM trustwork.node_key ORDER BY position`);
  },
  /**
   * The sealed material of the current key (or the named one), for the signer path: the transaction-local marker
   * `trustwork.federation_signer` is set in the same transaction the definer reads it in, so no other query of the runtime
   * role reaches the material. Ciphertext only; the KEK and the plaintext never enter the database.
   */
  async signingMaterial(runner: Runner, keyId: string | null = null): Promise<SigningMaterialRow | null> {
    const read = async (trx: Transaction) => {
      await sql`SELECT set_config('trustwork.federation_signer', 'on', true)`.execute(trx);
      return (await rows(trx, sql<SigningMaterialRow>`SELECT * FROM trustwork.federation_node_signing_material(${keyId}::text)`))[0] ?? null;
    };
    if (runner instanceof Kysely) return read(runner);
    return executor(runner).transaction().execute(read);
  },
};

export const nodeManifests = {
  /** Records a signed manifest as the next version (the same digest is recorded once). */
  record(runner: Runner, input: { document: Record<string, unknown>; digest: string; keyId: string; issuedAt: Date }): Promise<NodeManifestRow> {
    return one(runner, sql<NodeManifestRow>`SELECT * FROM trustwork.federation_node_record_manifest(${json(input.document)}::jsonb, ${input.digest}::text, ${input.keyId}::text, ${input.issuedAt}::timestamptz)`, 'federation_node_record_manifest');
  },
  async current(runner: Runner): Promise<NodeManifestRow | null> {
    return (await rows(runner, sql<NodeManifestRow>`SELECT * FROM trustwork.node_manifest ORDER BY version DESC LIMIT 1`))[0] ?? null;
  },
  history(runner: Runner, limit = 50): Promise<NodeManifestRow[]> {
    return rows(runner, sql<NodeManifestRow>`SELECT * FROM trustwork.node_manifest ORDER BY version DESC LIMIT ${limit}`);
  },
};

export interface PeerRecordInput {
  peerNode: string;
  manifest: Record<string, unknown>;
  manifestDigest: string;
  manifestIssuedAt: Date;
  currentKeyId: string;
  attestationExpiresAt: Date;
  admitted: boolean;
  judged: string[];
  trigger: AdmissionTrigger;
  /** Why flows pause when not admitted. */
  suspensionReason?: SuspensionReason | null;
  /** False for a re-admission without a fetch from the origin (an inbound handshake, a deal): the refresh stays due. */
  fetched?: boolean;
}
export const federationPeers = {
  /** Stores a validated manifest with the admission outcome; refusals suspend the peer's active records, admissions lift admission-caused suspensions. */
  record(runner: Runner, input: PeerRecordInput): Promise<FederationPeerRow> {
    return one(runner, sql<FederationPeerRow>`SELECT * FROM trustwork.federation_peer_record(${input.peerNode}::text, ${json(input.manifest)}::jsonb, ${input.manifestDigest}::text, ${input.manifestIssuedAt}::timestamptz,
      ${input.currentKeyId}::text, ${input.attestationExpiresAt}::timestamptz, ${input.admitted}::boolean, ${input.judged}::text[], ${input.trigger}::text, ${input.suspensionReason ?? null}::text, ${input.fetched ?? true}::boolean)`, 'federation_peer_record');
  },
  equivocation(runner: Runner, peerNode: string): Promise<FederationPeerRow> {
    return one(runner, sql<FederationPeerRow>`SELECT * FROM trustwork.federation_peer_equivocation(${peerNode}::text)`, 'federation_peer_equivocation');
  },
  /** Protocol reader (no principal). */
  async get(runner: Runner, peerNode: string): Promise<FederationPeerRow | null> {
    return (await rows(runner, sql<FederationPeerRow>`SELECT * FROM trustwork.federation_peer_get(${peerNode}::text)`))[0] ?? null;
  },
  async due(runner: Runner, now: Date, limit = 100): Promise<string[]> {
    return (await rows(runner, sql<{ host: string }>`SELECT trustwork.federation_peers_due(${now}::timestamptz, ${limit}::integer) AS host`)).map((r) => r.host);
  },
  /** Staff list under row-level security. */
  list(trx: Transaction): Promise<FederationPeerRow[]> {
    return trx.selectFrom('federation_peer').selectAll().orderBy('peer_node').execute();
  },
  refusal(runner: Runner, input: { service: string; subject: string | null; decidedAt: Date; findings: unknown[]; geolocation: Record<string, unknown> | null }): Promise<AdmissionRefusalRow> {
    return one(runner, sql<AdmissionRefusalRow>`SELECT * FROM trustwork.federation_refusal_record(${input.service}::text, ${input.subject}::text, ${input.decidedAt}::timestamptz, ${json(input.findings)}::jsonb,
      ${input.geolocation ? json(input.geolocation) : null}::jsonb)`, 'federation_refusal_record');
  },
  refusals(trx: Transaction, limit = 100): Promise<AdmissionRefusalRow[]> {
    return trx.selectFrom('admission_refusal').selectAll().orderBy('decided_at', 'desc').limit(limit).execute();
  },
  /** True when the nonce was not seen before (the signature's expiry bounds how long it is remembered). */
  async noteNonce(runner: Runner, input: { peerNode: string; keyId: string; nonce: string; expiresAt: Date }): Promise<boolean> {
    return (await one(runner, sql<{ v: boolean }>`SELECT trustwork.federation_note_nonce(${input.peerNode}::text, ${input.keyId}::text, ${input.nonce}::text, ${input.expiresAt}::timestamptz) AS v`, 'federation_note_nonce')).v === true;
  },
  async purgeNonces(runner: Runner): Promise<number> {
    return Number((await one(runner, sql<{ v: number }>`SELECT trustwork.federation_purge_nonces() AS v`, 'federation_purge_nonces')).v);
  },
  dealAdmission(runner: Runner, input: { peerNode: string; dealRef: string; outcome: 'admitted' | 'refused' }): Promise<PeerDealAdmissionRow> {
    return one(runner, sql<PeerDealAdmissionRow>`SELECT * FROM trustwork.federation_deal_admission(${input.peerNode}::text, ${input.dealRef}::text, ${input.outcome}::text)`, 'federation_deal_admission');
  },
  revocationNoticed(runner: Runner, input: { peerNode: string; keyId: string; compromisedSince: Date; revokedAt: Date; objectsFlagged: number }): Promise<PeerKeyRevocationRow> {
    return one(runner, sql<PeerKeyRevocationRow>`SELECT * FROM trustwork.federation_revocation_noticed(${input.peerNode}::text, ${input.keyId}::text, ${input.compromisedSince}::timestamptz, ${input.revokedAt}::timestamptz,
      ${input.objectsFlagged}::integer)`, 'federation_revocation_noticed');
  },
  /** 'ok' or the protocol error code that refuses a flow of this level with the peer now. */
  async flowAllowed(runner: Runner, peerNode: string, requiredLevel: PeeringLevelCode, hubId: string | null = null): Promise<string> {
    return (await one(runner, sql<{ v: string }>`SELECT trustwork.federation_flow_allowed(${peerNode}::text, ${requiredLevel}::text, ${hubId}::uuid) AS v`, 'federation_flow_allowed')).v;
  },
};

export interface PeeringTerms { licences: Record<string, string>; tombstoneHours: number; agentEnvelopesPerHour: number }
export const peeringRecords = {
  request(trx: Transaction, ctx: CommandContext, input: { localHubId: string; peerNode: string; peerHubId: string; level: PeeringLevelCode; approvalId: string | null } & PeeringTerms): Promise<PeeringRecordRow> {
    return one(trx, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_request_peering(${ctxJson(ctx)}::jsonb, ${input.localHubId}::uuid, ${input.peerNode}::text, ${input.peerHubId}::text, ${input.level}::text,
      ${json(input.licences)}::jsonb, ${input.tombstoneHours}::integer, ${input.agentEnvelopesPerHour}::integer, ${input.approvalId}::uuid)`, 'federation_request_peering');
  },
  accept(trx: Transaction, ctx: CommandContext, recordId: string, expectedRevision: number, level: PeeringLevelCode, approvalId: string | null): Promise<PeeringRecordRow> {
    return one(trx, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_accept_peering(${ctxJson(ctx)}::jsonb, ${recordId}::uuid, ${expectedRevision}::integer, ${level}::text, ${approvalId}::uuid)`, 'federation_accept_peering');
  },
  awaitSecondApprover(trx: Transaction, ctx: CommandContext, recordId: string, expectedRevision: number): Promise<PeeringRecordRow> {
    return one(trx, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_await_second_approver(${ctxJson(ctx)}::jsonb, ${recordId}::uuid, ${expectedRevision}::integer)`, 'federation_await_second_approver');
  },
  decline(trx: Transaction, ctx: CommandContext, recordId: string, expectedRevision: number): Promise<PeeringRecordRow> {
    return one(trx, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_decline_peering(${ctxJson(ctx)}::jsonb, ${recordId}::uuid, ${expectedRevision}::integer)`, 'federation_decline_peering');
  },
  lower(trx: Transaction, ctx: CommandContext, recordId: string, expectedRevision: number, level: PeeringLevelCode): Promise<PeeringRecordRow> {
    return one(trx, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_lower_peering(${ctxJson(ctx)}::jsonb, ${recordId}::uuid, ${expectedRevision}::integer, ${level}::text)`, 'federation_lower_peering');
  },
  suspend(trx: Transaction, ctx: CommandContext, recordId: string, expectedRevision: number): Promise<PeeringRecordRow> {
    return one(trx, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_suspend_peering(${ctxJson(ctx)}::jsonb, ${recordId}::uuid, ${expectedRevision}::integer)`, 'federation_suspend_peering');
  },
  lift(trx: Transaction, ctx: CommandContext, recordId: string, expectedRevision: number): Promise<PeeringRecordRow> {
    return one(trx, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_lift_suspension(${ctxJson(ctx)}::jsonb, ${recordId}::uuid, ${expectedRevision}::integer)`, 'federation_lift_suspension');
  },
  /** Defederation (admin.federation.defederate): final, history kept. */
  end(trx: Transaction, ctx: CommandContext, recordId: string, expectedRevision: number): Promise<PeeringRecordRow> {
    return one(trx, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_end_peering(${ctxJson(ctx)}::jsonb, ${recordId}::uuid, ${expectedRevision}::integer)`, 'federation_end_peering');
  },
  /** The console's refresh of a peer, audited at the node or at a hub of the caller with a record for that peer; returns a record id. */
  async noteRefresh(trx: Transaction, ctx: CommandContext, peerNode: string, outcome: string): Promise<string> {
    return (await one(trx, sql<{ v: string }>`SELECT trustwork.federation_note_refresh(${ctxJson(ctx)}::jsonb, ${peerNode}::text, ${outcome}::text) AS v`, 'federation_note_refresh')).v;
  },
  /* ---------- Node-run (protocol) ---------- */
  handshakeReceived(runner: Runner, input: { peerNode: string; peerHubId: string; localHubId: string; level: PeeringLevelCode; manifestDigest: string; keyId: string } & PeeringTerms): Promise<PeeringRecordRow> {
    return one(runner, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_handshake_received(${input.peerNode}::text, ${input.peerHubId}::text, ${input.localHubId}::uuid, ${input.level}::text,
      ${json(input.licences)}::jsonb, ${input.tombstoneHours}::integer, ${input.agentEnvelopesPerHour}::integer, ${input.manifestDigest}::text, ${input.keyId}::text)`, 'federation_handshake_received');
  },
  peerAnswered(runner: Runner, recordId: string, answer: { outcome: 'admitted'; level: PeeringLevelCode; state: 'active' | 'pending_approval' } | { outcome: 'refused'; code: string }): Promise<PeeringRecordRow> {
    const admitted = answer.outcome === 'admitted';
    return one(runner, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_peer_answered(${recordId}::uuid, ${answer.outcome}::text, ${admitted ? answer.level : null}::text,
      ${admitted ? answer.state : null}::text, ${admitted ? null : answer.code}::text)`, 'federation_peer_answered');
  },
  peerEnded(runner: Runner, peerNode: string, localHubId: string | null, peerHubId: string | null): Promise<PeeringRecordRow[]> {
    return rows(runner, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_peer_ended(${peerNode}::text, ${localHubId}::uuid, ${peerHubId}::text)`);
  },
  async getForProtocol(runner: Runner, recordId: string): Promise<PeeringRecordRow | null> {
    return (await rows(runner, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_record_get(${recordId}::uuid)`))[0] ?? null;
  },
  ofPeerForProtocol(runner: Runner, peerNode: string): Promise<PeeringRecordRow[]> {
    return rows(runner, sql<PeeringRecordRow>`SELECT * FROM trustwork.federation_records_of_peer(${peerNode}::text)`);
  },
  /* ---------- Staff reads (row-level security) ---------- */
  get(trx: Transaction, recordId: string): Promise<PeeringRecordRow | undefined> {
    return trx.selectFrom('peering_record').selectAll().where('id', '=', recordId).executeTakeFirst();
  },
  list(trx: Transaction, filter: { hubId?: string; peerNode?: string } = {}): Promise<PeeringRecordRow[]> {
    let query = trx.selectFrom('peering_record').selectAll();
    if (filter.hubId) query = query.where('local_hub_id', '=', filter.hubId);
    if (filter.peerNode) query = query.where('peer_node', '=', filter.peerNode);
    return query.orderBy('started_at', 'desc').orderBy('id').execute();
  },
  events(trx: Transaction, recordId: string): Promise<PeeringEventRow[]> {
    return trx.selectFrom('peering_event').selectAll().where('peering_record_id', '=', recordId).orderBy('occurred_at').orderBy('id').execute();
  },
};
