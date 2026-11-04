import type { Principal } from '../../../deps/contracts.js';
import { withPrincipal, type Transaction } from '../../../deps/data.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { AppContext } from '../../identity/context.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { generateNodeKey, verifyEd25519, type NodeKeySealer, type NodeSeed } from './crypto.js';
import {
  admissionLogEvent, admitPeerAtHandshake, adminAudit, agreedLicences, approvals, canonicalize, computeDigest, DATA_LICENCE_RULES, defaultDataLicences, deploymentAttestations,
  federationPeers, HandshakeResponseSchema, handshakeRequestSchema, HUB_CONSOLE_CONTRACT_VERSION, keyForSignature, manifestRestrictions, MESH_DATA_CLASSES, MESH_ENDPOINTS, MESH_PROTOCOL,
  nodeIdentity, nodeKeys, nodeManifestSchema, nodeManifests, parseAddress, PEERING_LEVELS, peeringLevelAtLeast, peeringRecords, restrictedPlaces, rotationStatementFor, SECOND_APPROVER_LEVELS,
  signDocument, unconfiguredGate, utf8Encode, verifyManifestSignatures, type AdmissionDecision, type AdmissionTrigger, type CommandContext, type ConsoleCommandResult, type FederationErrorCode,
  type FederationPeerRow, type GateRequest, type HandshakeRequest, type HandshakeResponse, type MeshDataClass, type NodeIdentityInput, type NodeIdentityRow, type NodeKey, type NodeManifest,
  type NodeManifestRow, type PeeringLevel, type PeeringLevelCode, type PeeringRecordRow, type PeeringTerms, type RestrictedPlaces, type StaffRole, type SuspensionReason, type SyndicationTerm,
} from './deps.js';
import { federationRefusal, FederationProtocolError, isAuthorityRefusal } from './errors.js';
import { freshNonce, signRequest, signResponse, verifySignedMessage, type ReceivedMessage, type SignedFields, type Signer, type Verification } from './http-signatures.js';
import { keyRotationDigestInput, peeringLevelDigestInput, type AcceptPeeringCommand, type InitializeNodeCommand, type LowerPeeringCommand, type RecordCommand, type RequestPeeringCommand, type RotateKeyCommand, type UpdateNodeCommand } from './schemas.js';
import { PeerUnreachableError, type PeerResponse, type PeerTransport } from './transport.js';
import { toEvent, toIdentity, toManifestVersion, toNodeKey, toPeer, toPeeringRecord, toProtocolRecord, toRefusal } from './views.js';

/**
 * Re-verification of what a peer signed with a key it later revoked (protocol section 5): the packages that hold
 * replicas (FED-002) and deal objects (FED-004) register their stores; until then the default flags nothing.
 */
export interface ReverificationPort {
  /** Flags every held object signed by `peerNode` under `keyId` at or after `compromisedSince`; returns how many. */
  reverify(peerNode: string, keyId: string, compromisedSince: Date): Promise<number>;
}
export const noReverification: ReverificationPort = { reverify: async () => 0 };

export interface FederationNodeOptions {
  /** Seals node seeds with the node's key-encryption key; null refuses key generation (`secret_store_unconfigured`). */
  sealer: () => NodeKeySealer | null;
  transport: PeerTransport;
  /** The authoritative restricted places (the synced kernel list). */
  restricted: () => Promise<RestrictedPlaces>;
  engine: { version: string; source: string };
  reverification?: ReverificationPort;
}

type Cmd = { contractVersion: string; idempotencyKey: string; reason: string };
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
interface Attempt { hubId: string | null; permission: string; action: string; objectType: string; objectId: string }
export interface HandshakeInput {
  method: string;
  url: string;
  header(name: string): string | null;
  body: unknown;
  rawBody: Uint8Array | null;
  /** The client address as our door sees it (trusted-proxy rules applied); used for the lookup and dropped. */
  address: string | null;
  requestId: string;
}
export interface ProtocolReply { status: number; body: Record<string, unknown>; fields: SignedFields | null }
export type FlowCheck = { ok: true } | { ok: false; code: FederationErrorCode };

const NODE_OBJECT = '00000000-0000-4000-8000-000000000000';
/** Key validity instants are whole seconds: RFC 9421 `created` is an integer, so a key never postdates a signature made in its first second. */
const wholeSecond = (d: Date): Date => new Date(Math.floor(d.getTime() / 1000) * 1000);
const RESTRICTED_CACHE_MS = 60_000;

function containsAddress(value: unknown): boolean {
  if (typeof value === 'string') return parseAddress(value.trim()) !== null;
  if (Array.isArray(value)) return value.some(containsAddress);
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).some(([k, v]) => parseAddress(k) !== null || containsAddress(v));
  return false;
}
const highestOfferedAtMost = (offered: readonly string[], requested: PeeringLevel): PeeringLevel | null =>
  [...PEERING_LEVELS].reverse().find((l) => offered.includes(l) && peeringLevelAtLeast(requested, l)) ?? null;

/**
 * The federation node (FED-001): identity, keys, the signed manifest, handshakes, peering records and the admission
 * check around every peer.
 *
 * Staff commands run in one `PrincipalService.runAs` transaction through a `federation_*` SECURITY DEFINER command (the
 * database checks the permission at the hub or node, the elevation, the second person and writes the audit row). The
 * protocol handlers run as the node's own process: they verify signatures against the peer's manifest, run the SANC-008
 * admission on every piece of evidence and record only names, digests, places and datasets, never an address.
 */
export class FederationNodeService {
  private restrictedCache: { at: number; value: RestrictedPlaces } | null = null;
  private readonly reverification: ReverificationPort;
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly options: FederationNodeOptions) {
    this.reverification = options.reverification ?? noReverification;
  }

  /* ---------- Plumbing ---------- */

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'console_action', reasonText: body.reason };
  }
  private async staff<T>(e: Elevated, body: Cmd, attempt: Attempt | null, fn: (trx: Transaction, cmd: CommandContext, p: Principal) => Promise<T>): Promise<T> {
    const cmd = this.commandContext(e, body);
    try {
      return await this.principals.runAs(e.state, (trx, p) => fn(trx, cmd, p), { refreshStale: false });
    } catch (error) {
      const refusal = federationRefusal(error);
      if (refusal && attempt && isAuthorityRefusal(refusal)) await this.recordDenied(e, cmd, attempt, refusal).catch((failure: unknown) => this.ctx.log('federation.denied_audit_failed', failure));
      throw refusal ?? error;
    }
  }
  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw federationRefusal(error) ?? error;
    });
  }
  private async recordDenied(e: Elevated, cmd: CommandContext, attempt: Attempt, refusal: ApiError): Promise<void> {
    const p = e.state.principal as Principal;
    await withPrincipal(this.ctx.pool, { personId: p.personId, authzEpoch: p.authzEpoch }, async (trx) => {
      const role = await trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', p.personId).where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('scope_kind', 'in', ['platform', 'node']), ...(attempt.hubId ? [eb('hub_id', '=', attempt.hubId)] : [])]))
        .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', new Date())])).orderBy('breakglass').limit(1).executeTakeFirst();
      if (!role) return;
      const nodeId = attempt.hubId ? null : (await trx.selectFrom('admin_node').select('id').executeTakeFirst())?.id ?? null;
      if (!attempt.hubId && !nodeId) return;
      const reason = typeof refusal.details?.reason === 'string' ? refusal.details.reason : refusal.code.replace(/\W/g, '_');
      await adminAudit.append(trx, {
        actorPersonId: p.personId, actorRole: role.role as StaffRole, scope: attempt.hubId ? { kind: 'hub', hubId: attempt.hubId } : { kind: 'node', nodeId: nodeId as string },
        permission: attempt.permission, elevationId: cmd.elevationId, action: attempt.action, objectType: attempt.objectType, objectId: attempt.objectId,
        reasonCode: `denied_${reason}`.slice(0, 64), reasonText: cmd.reasonText, outcome: 'denied', requestId: cmd.requestId,
      });
    });
  }
  private async auditId(trx: Transaction, requestId: string, objectId: string): Promise<string> {
    const row = await trx.selectFrom('admin_audit_event').select('id').where('request_id', '=', requestId).where('object_id', '=', objectId).orderBy('sequence', 'desc').limit(1).executeTakeFirst();
    if (!row) throw new Error('the command wrote no audit row');
    return row.id;
  }
  private async result(trx: Transaction, cmd: CommandContext, outcome: 'applied' | 'pending_second_person', objectId: string, revision: number, approvalRequestId: string | null, auditObjectId = objectId): Promise<ConsoleCommandResult> {
    return { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, outcome, objectId, revision, approvalRequestId, auditEventId: await this.auditId(trx, cmd.requestId, auditObjectId) };
  }
  /** Asks a second person for exactly this action and answers `pending_second_person`. */
  private async pending(trx: Transaction, cmd: CommandContext, action: string, scope: { kind: 'hub'; hubId: string } | { kind: 'node'; nodeId: string }, digestInput: unknown, objectId: string, revision: number) {
    const request = await approvals.request(trx, cmd, { action, scope, actionDigest: computeDigest(digestInput).value });
    return this.result(trx, cmd, 'pending_second_person', objectId, revision, request.id, request.id);
  }
  private async restricted(): Promise<RestrictedPlaces> {
    const now = Date.now();
    if (this.restrictedCache && now - this.restrictedCache.at < RESTRICTED_CACHE_MS) return this.restrictedCache.value;
    const value = await this.options.restricted();
    this.restrictedCache = { at: now, value };
    return value;
  }
  private async identity(): Promise<NodeIdentityRow | null> {
    return nodeIdentity.current(this.ctx.pool);
  }
  private async requireIdentity(): Promise<NodeIdentityRow> {
    const identity = await this.identity();
    if (!identity) throw new ApiError('access.not_found', 'the node identity is not initialized', { reason: 'node_not_configured' });
    return identity;
  }
  private sealer(): NodeKeySealer {
    const sealer = this.options.sealer();
    if (!sealer) throw new ApiError('validation.schema', 'no key-encryption key is configured (TRUSTWORK_KEK); node keys cannot be generated', { reason: 'secret_store_unconfigured' });
    return sealer;
  }

  /* ---------- Signing with the node key ---------- */

  /** Opens the current key (or the named one) in memory for one use; the seed is destroyed afterwards. */
  private async withSigner<T>(fn: (signer: Signer) => Promise<T> | T, keyId: string | null = null): Promise<T> {
    const identity = await this.requireIdentity();
    const material = await nodeKeys.signingMaterial(this.ctx.pool, keyId);
    if (!material) throw new ApiError('access.not_found', 'the node has no signing key', { reason: 'node_not_configured' });
    const seed: NodeSeed = await this.sealer().open({ ciphertext: material.ciphertext, iv: material.iv, authTag: material.auth_tag, wrappedKey: material.wrapped_key, kekId: material.kek_id }, identity.node_id, material.key_id);
    try {
      return await fn({ keyId: material.key_id, sign: seed.signer() });
    } finally {
      seed.destroy();
    }
  }
  private async signerOrNull(): Promise<Signer | null> {
    try {
      return await this.withSigner((s) => s);
    } catch {
      return null;
    }
  }

  /* ---------- The manifest ---------- */

  private async attestationSummary() {
    const row = await deploymentAttestations.currentOnPool(this.ctx.pool);
    if (!row) return null;
    return {
      id: row.id, nodeId: row.node_id, operatorEntityCountry: row.operator_entity_country, operatorEntityRegion: row.operator_entity_region, hostingCountry: row.hosting_country,
      hostingRegion: row.hosting_region, gateMode: row.gate_mode, statementDigest: row.statement_digest, attestedAt: row.attested_at.toISOString(), expiresAt: row.expires_at.toISOString(),
      supersedesId: row.supersedes_id, basis: 'operator_statement' as const,
    };
  }
  private async manifestHubs(): Promise<{ hub_id: string; slug: string; territories: string[]; locales: string[]; pack_code: string | null; pack_version: string | null }[]> {
    const { rows } = await this.ctx.pool.query<{ hub_id: string; slug: string; territories: string[]; locales: string[]; pack_code: string | null; pack_version: string | null }>('SELECT * FROM trustwork.federation_manifest_hubs()');
    return rows;
  }
  /** The unsigned manifest from the identity, the key chain, the hubs and the current attestation. */
  private async unsignedManifest(identity: NodeIdentityRow): Promise<Omit<NodeManifest, 'signature' | 'issuedAt'>> {
    const attestation = await this.attestationSummary();
    if (!attestation) throw new ApiError('access.not_found', 'the deployment-location attestation is missing; the manifest cannot be published', { reason: 'attestation_missing' });
    const chain = (await nodeKeys.chain(this.ctx.pool)).map(toNodeKey);
    const current = chain.find((k) => k.retiredAt === null);
    if (!current) throw new ApiError('access.not_found', 'the node has no current key', { reason: 'node_not_configured' });
    const hubs = await this.manifestHubs();
    if (hubs.length === 0) throw new ApiError('access.not_found', 'the node has no launched hub yet', { reason: 'no_hub' });
    const packs = new Map<string, { country: string; version: string }>();
    for (const h of hubs) if (h.pack_code && h.pack_version) packs.set(`${h.pack_code}@${h.pack_version}`, { country: h.pack_code, version: h.pack_version });
    return {
      protocol: [MESH_PROTOCOL],
      node: identity.host,
      engine: { version: identity.engine_version, source: identity.engine_source },
      operator: {
        name: identity.operator_name, country: attestation.operatorEntityCountry,
        registration: identity.operator_registration_kind && identity.operator_registration_value ? { kind: identity.operator_registration_kind, value: identity.operator_registration_value } : null,
        abuseContact: identity.abuse_contact, takedownContact: identity.takedown_contact,
      },
      jurisdiction: identity.jurisdiction,
      hubs: hubs.map((h) => ({ id: h.slug, territories: h.territories, languages: h.locales })),
      packs: [...packs.values()],
      licences: identity.licences as Record<MeshDataClass, SyndicationTerm>,
      licenceConditions: { attributionVisible: true, tombstoneHours: identity.tombstone_hours, noResaleOfPersonalData: true, noModelTrainingOutsideGovernedRetrieval: true, neverPresentedAsLocal: true },
      peeringPolicy: { offered: identity.offered_levels, secondApproverFor: ['deal_routing', 'identity'], agentEnvelopesPerHour: identity.agent_envelopes_per_hour },
      keys: { current: current.keyId, chain },
      deploymentAttestation: attestation,
    };
  }
  /** The current signed manifest: the stored version when nothing changed, otherwise a newly signed and recorded version. */
  async manifest(): Promise<NodeManifestRow> {
    const identity = await this.requireIdentity();
    const unsigned = await this.unsignedManifest(identity);
    const stored = await nodeManifests.current(this.ctx.pool);
    if (stored) {
      const storedBody: Record<string, unknown> = { ...(stored.document as Record<string, unknown>) };
      delete storedBody['issuedAt'];
      delete storedBody['signature'];
      if (computeDigest(storedBody).value === computeDigest(unsigned).value) return stored;
    }
    const issuedAt = this.ctx.clock.now().toISOString();
    const signed = await this.withSigner((signer) => signDocument('manifest', { ...unsigned, issuedAt }, signer.keyId, signer.sign));
    const parsed = nodeManifestSchema(await this.restricted()).parse(signed);
    if (!verifyManifestSignatures(parsed, verifyEd25519)) throw new Error('the freshly signed manifest does not verify');
    return nodeManifests.record(this.ctx.pool, { document: parsed, digest: computeDigest(parsed).value, keyId: parsed.signature.keyId, issuedAt: new Date(issuedAt) });
  }

  /* ---------- Peer manifests and admission ---------- */

  /** Strict validation of a peer's manifest: the schema (restricted places refused), the address backstop, the host and every signature. */
  private async validatePeerManifest(raw: unknown, expectedHost: string): Promise<{ manifest: NodeManifest; digest: string }> {
    const restricted = await this.restricted();
    const parsed = nodeManifestSchema(restricted).safeParse(raw);
    if (!parsed.success) {
      if (parsed.error.issues.some((i) => i.message.includes('restricted place') || i.message.includes('must be stated with its region'))) throw new FederationProtocolError('federation.peer_restricted', 'the peer is not available for connection');
      throw new FederationProtocolError('federation.manifest_invalid', 'the manifest does not validate');
    }
    if (parsed.data.node !== expectedHost) throw new FederationProtocolError('federation.manifest_invalid', 'the manifest names another node');
    if (containsAddress(parsed.data)) throw new FederationProtocolError('federation.manifest_invalid', 'a manifest carries no network address');
    if (!verifyManifestSignatures(parsed.data, verifyEd25519)) throw new FederationProtocolError('federation.signature_invalid', 'the manifest signature or its key chain does not verify');
    return { manifest: parsed.data, digest: computeDigest(parsed.data).value };
  }
  /** The restricted places a manifest declares, judged before signatures when the schema already refused it. */
  private async refuseDeclared(raw: unknown, host: string, observed: GateRequest | null): Promise<void> {
    const manifest = raw as { jurisdiction?: unknown; operator?: unknown; hubs?: unknown; deploymentAttestation?: unknown } | null;
    if (!manifest || typeof manifest !== 'object') return;
    const decision = admitPeerAtHandshake({ manifest: { node: host, ...(manifest as object) } as never, attestation: (manifest.deploymentAttestation as never) ?? null, observed }, await this.admissionContext());
    if (decision.outcome === 'refused') await this.storeRefusal(decision);
  }
  private async admissionContext() {
    return { restricted: await this.restricted(), geolocation: this.ctx.jurisdictionGate ?? unconfiguredGate(), now: this.ctx.clock.now() };
  }
  private async storeRefusal(decision: AdmissionDecision): Promise<void> {
    if (decision.outcome !== 'refused') return;
    const r = decision.record;
    await federationPeers.refusal(this.ctx.pool, { service: r.service, subject: r.subject, decidedAt: new Date(r.decidedAt), findings: r.findings, geolocation: r.geolocation });
    const event = admissionLogEvent(decision);
    if (event) this.ctx.log('admission.refused', event);
  }
  /** SANC-008 on a validated manifest: declared and attested evidence from it, observed from our own door. */
  private async admit(manifest: NodeManifest, observed: GateRequest | null): Promise<AdmissionDecision> {
    const decision = admitPeerAtHandshake({ manifest, attestation: manifest.deploymentAttestation, observed }, await this.admissionContext());
    if (decision.outcome === 'refused') await this.storeRefusal(decision);
    return decision;
  }
  /** Records a peer's manifest with the admission outcome; a refusal (or an attestation that expired) suspends every flow. */
  private async recordPeer(manifest: NodeManifest, digest: string, decision: AdmissionDecision, trigger: AdmissionTrigger): Promise<FederationPeerRow> {
    const expired = decision.outcome === 'refused' && decision.record.findings.some((f) => f.reason === 'attestation_expired');
    const suspensionReason: SuspensionReason | null = decision.outcome === 'refused' ? (expired ? 'attestation_expired' : 'admission_refused') : null;
    return federationPeers.record(this.ctx.pool, {
      peerNode: manifest.node, manifest, manifestDigest: digest, manifestIssuedAt: new Date(manifest.issuedAt), currentKeyId: manifest.keys.current,
      attestationExpiresAt: new Date(manifest.deploymentAttestation.expiresAt), admitted: decision.outcome === 'admitted', judged: decision.outcome === 'admitted' ? [...decision.judged] : [],
      trigger, suspensionReason,
    });
  }
  /**
   * A changed key chain against the one we hold: a second successor of the same key is equivocation (suspend, stop
   * trusting new signatures); a newly published revocation triggers re-verification of everything signed at or after
   * `compromisedSince`. Returns false on equivocation.
   */
  private async reconcileChain(peer: FederationPeerRow | null, manifest: NodeManifest): Promise<boolean> {
    if (!peer) return true;
    const held = (peer.manifest as NodeManifest).keys.chain;
    for (const key of manifest.keys.chain) {
      if (!key.rotation) continue;
      const sibling = held.find((k) => k.rotation?.previousKeyId === key.rotation?.previousKeyId);
      if (sibling && (sibling.keyId !== key.keyId || sibling.publicKey !== key.publicKey)) {
        await federationPeers.equivocation(this.ctx.pool, manifest.node);
        this.ctx.log('federation.equivocation', { peer: manifest.node, previousKeyId: key.rotation.previousKeyId });
        return false;
      }
    }
    for (const key of manifest.keys.chain) {
      const before = held.find((k) => k.keyId === key.keyId);
      if (key.revocation && !before?.revocation) {
        const since = new Date(key.revocation.compromisedSince);
        const flagged = await this.reverification.reverify(manifest.node, key.keyId, since);
        await federationPeers.revocationNoticed(this.ctx.pool, { peerNode: manifest.node, keyId: key.keyId, compromisedSince: since, revokedAt: new Date(key.revocation.revokedAt), objectsFlagged: flagged });
        this.ctx.log('federation.revocation_noticed', { peer: manifest.node, keyId: key.keyId, objectsFlagged: flagged });
      }
    }
    return true;
  }
  private observedFrom(address: string | null): GateRequest {
    return { address, header: () => null };
  }

  /**
   * Fetches, validates and admits a peer's manifest (the observed evidence is the server address we resolved). Used
   * before a request, at least daily for every known peer, immediately after `federation.key_unknown`, and by the
   * console's refresh command. A refusal or an expired attestation suspends every flow with the peer; a renewed
   * admission lifts the suspensions it caused.
   */
  async refreshPeer(host: string, trigger: AdmissionTrigger): Promise<FederationPeerRow> {
    const held = await federationPeers.get(this.ctx.pool, host);
    const response = await this.options.transport.fetchManifest(host);
    if (response.status !== 200) throw new PeerUnreachableError(host, new Error(`manifest answered ${response.status}`));
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(response.body).toString('utf8'));
    } catch {
      throw new FederationProtocolError('federation.manifest_invalid', 'the manifest is not JSON');
    }
    const observed = this.observedFrom(response.remoteAddress);
    let validated: { manifest: NodeManifest; digest: string };
    try {
      validated = await this.validatePeerManifest(raw, host);
    } catch (error) {
      if (error instanceof FederationProtocolError && error.code === 'federation.peer_restricted') {
        await this.refuseDeclared(raw, host, observed);
        if (held) await this.suspendHeld(held, 'admission_refused', trigger);
      }
      throw error;
    }
    if (!(await this.reconcileChain(held, validated.manifest))) throw new FederationProtocolError('federation.signature_invalid', 'the peer published two successors of one key');
    const decision = await this.admit(validated.manifest, observed);
    return this.recordPeer(validated.manifest, validated.digest, decision, trigger);
  }
  /** A held peer whose new manifest cannot even be validated: its flows pause until a valid manifest is admitted again. */
  private async suspendHeld(held: FederationPeerRow, reason: SuspensionReason, trigger: AdmissionTrigger): Promise<void> {
    const manifest = held.manifest as NodeManifest;
    await federationPeers.record(this.ctx.pool, {
      peerNode: held.peer_node, manifest, manifestDigest: held.manifest_digest, manifestIssuedAt: held.manifest_issued_at, currentKeyId: held.current_key_id,
      attestationExpiresAt: held.attestation_expires_at, admitted: false, judged: [], trigger, suspensionReason: reason,
    });
  }
  /** Re-runs the admission on the manifest we hold (a changed attestation or capability statement, a new deal) without a fetch. */
  async readmit(host: string, trigger: AdmissionTrigger, observed: GateRequest | null): Promise<AdmissionDecision> {
    const held = await federationPeers.get(this.ctx.pool, host);
    if (!held) throw new FederationProtocolError('federation.not_peered', 'unknown peer');
    const manifest = held.manifest as NodeManifest;
    const decision = await this.admit(manifest, observed);
    await this.recordPeer(manifest, held.manifest_digest, decision, trigger);
    return decision;
  }
  /** Every peer whose manifest is due (at least daily); failures are logged and retried on the next run. */
  async refreshDue(now: Date = this.ctx.clock.now(), limit = 100): Promise<{ host: string; outcome: 'admitted' | 'refused' | 'failed' }[]> {
    const out: { host: string; outcome: 'admitted' | 'refused' | 'failed' }[] = [];
    for (const host of await federationPeers.due(this.ctx.pool, now, limit)) {
      try {
        const peer = await this.refreshPeer(host, 'refresh');
        out.push({ host, outcome: peer.admission_state });
        if (peer.admission_state === 'admitted') {
          for (const row of await peeringRecords.ofPeerForProtocol(this.ctx.pool, host)) if (row.state === 'pending_approval' && row.phase === 'awaiting_peer') await this.sendHandshake(row);
        }
      } catch (error) {
        this.ctx.log('federation.refresh_failed', { peer: host, code: error instanceof FederationProtocolError ? error.code : 'unreachable' });
        out.push({ host, outcome: error instanceof FederationProtocolError && error.code === 'federation.peer_restricted' ? 'refused' : 'failed' });
      }
    }
    return out;
  }

  /* ---------- Verifying what peers send ---------- */

  /** The peer's key chain for signature checks, refreshing the manifest once when a key label is unknown. */
  async verifyPeerMessage(host: string, message: ReceivedMessage): Promise<Verification> {
    let peer = await federationPeers.get(this.ctx.pool, host);
    if (!peer) return { ok: false, code: 'federation.not_peered', reason: 'unknown_peer' };
    const nonces = (keyId: string, nonce: string, expiresAt: Date) => federationPeers.noteNonce(this.ctx.pool, { peerNode: host, keyId, nonce, expiresAt });
    let verification = await verifySignedMessage(message, (peer.manifest as NodeManifest).keys.chain, this.ctx.clock.now(), nonces);
    if (!verification.ok && verification.code === 'federation.key_unknown') {
      try {
        peer = await this.refreshPeer(host, 'key_unknown');
      } catch {
        return verification;
      }
      verification = await verifySignedMessage(message, (peer.manifest as NodeManifest).keys.chain, this.ctx.clock.now(), nonces);
    }
    return verification;
  }
  /** May a flow of this level run with the peer now (active, unsuspended record; admitted peer with a valid attestation)? */
  async flowAllowed(host: string, required: PeeringLevel, hubId: string | null = null): Promise<FlowCheck> {
    const code = await federationPeers.flowAllowed(this.ctx.pool, host, required as PeeringLevelCode, hubId);
    return code === 'ok' ? { ok: true } : { ok: false, code: code as FederationErrorCode };
  }
  /** Before the first delivery of a new deal: the admission runs again (declared, attested and observed); a lapsed admission stops it. */
  async admitDealDelivery(host: string, dealRef: string, observed: GateRequest, hubId: string | null = null): Promise<FlowCheck> {
    const held = await federationPeers.get(this.ctx.pool, host);
    if (!held) return { ok: false, code: 'federation.not_peered' };
    const decision = await this.readmit(host, 'deal_delivery', observed);
    await federationPeers.dealAdmission(this.ctx.pool, { peerNode: host, dealRef, outcome: decision.outcome });
    if (decision.outcome === 'refused') return { ok: false, code: 'federation.peer_restricted' };
    return this.flowAllowed(host, 'deal_routing', hubId);
  }

  /* ---------- The handshake we receive ---------- */

  private async terms(identity: NodeIdentityRow, theirs: NodeManifest): Promise<PeeringTerms> {
    return {
      licences: agreedLicences(identity.licences as Record<MeshDataClass, SyndicationTerm>, theirs.licences),
      tombstoneHours: Math.min(identity.tombstone_hours, theirs.licenceConditions.tombstoneHours),
      agentEnvelopesPerHour: Math.min(identity.agent_envelopes_per_hour, theirs.peeringPolicy.agentEnvelopesPerHour),
    };
  }
  private async hubBySlug(slug: string): Promise<string | null> {
    const { rows } = await this.ctx.pool.query<{ id: string | null }>('SELECT trustwork.federation_hub_by_slug($1::text) AS id', [slug]);
    return rows[0]?.id ?? null;
  }
  private async reply(status: number, body: Record<string, unknown>): Promise<ProtocolReply> {
    const signer = await this.signerOrNull();
    const bytes = utf8Encode(canonicalize(body));
    return { status, body, fields: signer ? signResponse({ status, body: bytes, signer, now: this.ctx.clock.now() }) : null };
  }
  private async refusal(error: FederationProtocolError, requestId: string): Promise<ProtocolReply> {
    return this.reply(error.status, error.body(requestId));
  }

  /**
   * `POST /federation/v1/handshake` (protocol section 7): validate the initiator's manifest, verify the HTTP signature
   * against it, run the admission check on declared, attested and observed evidence, then record the peer and the
   * peering record (a new incoming request, or the peer's acceptance of ours). A refusal answers 451 with the code only.
   */
  async receiveHandshake(input: HandshakeInput): Promise<ProtocolReply> {
    const identity = await this.identity();
    if (!identity) return this.refusal(new FederationProtocolError('federation.not_peered', 'this node does not federate yet'), input.requestId);
    const body = input.body as { from?: unknown; to?: unknown; manifest?: unknown; nonce?: unknown } | null;
    if (!body || typeof body !== 'object' || typeof body.from !== 'string' || typeof body.to !== 'string' || typeof body.nonce !== 'string') {
      return this.refusal(new FederationProtocolError('federation.manifest_invalid', 'the handshake is not well formed'), input.requestId);
    }
    if (body.to !== identity.host) return this.refusal(new FederationProtocolError('federation.not_addressed', 'this node is not the addressee'), input.requestId);
    if (body.from === identity.host) return this.refusal(new FederationProtocolError('federation.manifest_invalid', 'a node does not peer with itself'), input.requestId);
    const from = body.from;
    const observed: GateRequest = { address: input.address, header: input.header };
    const held = await federationPeers.get(this.ctx.pool, from);
    let validated: { manifest: NodeManifest; digest: string };
    try {
      validated = await this.validatePeerManifest(body.manifest, from);
    } catch (error) {
      if (!(error instanceof FederationProtocolError)) throw error;
      if (error.code === 'federation.peer_restricted') {
        await this.refuseDeclared(body.manifest, from, observed);
        if (held) await this.suspendHeld(held, 'admission_refused', 'handshake');
      }
      return this.refusal(error, input.requestId);
    }
    const { manifest, digest } = validated;
    const message: ReceivedMessage = { method: input.method, targetUri: `https://${identity.host}${input.url}`, header: input.header, body: input.rawBody ?? utf8Encode(canonicalize(input.body)) };
    const nonces = (keyId: string, nonce: string, expiresAt: Date) => federationPeers.noteNonce(this.ctx.pool, { peerNode: from, keyId, nonce, expiresAt });
    const verification = await verifySignedMessage(message, manifest.keys.chain, this.ctx.clock.now(), nonces);
    if (!verification.ok) return this.refusal(new FederationProtocolError(verification.code, `request signature: ${verification.reason}`), input.requestId);
    if (!(await this.reconcileChain(held, manifest))) return this.refusal(new FederationProtocolError('federation.signature_invalid', 'the peer published two successors of one key'), input.requestId);
    const decision = await this.admit(manifest, observed);
    if (decision.outcome === 'refused') {
      if (held) await this.recordPeer(manifest, digest, decision, 'handshake');
      const refused: HandshakeResponse = { protocol: MESH_PROTOCOL, outcome: 'refused', from: identity.host, to: from, code: 'federation.peer_restricted', nonce: body.nonce, issuedAt: this.ctx.clock.now().toISOString() };
      return this.reply(451, refused);
    }
    const parsed = handshakeRequestSchema(await this.restricted()).safeParse(input.body);
    if (!parsed.success) return this.refusal(new FederationProtocolError('federation.manifest_invalid', 'the handshake does not validate'), input.requestId);
    const request: HandshakeRequest = parsed.data;
    const localHubId = await this.hubBySlug(request.hubs.responder);
    if (!localHubId) return this.refusal(new FederationProtocolError('federation.not_addressed', 'no such hub on this node'), input.requestId);
    const level = highestOfferedAtMost(identity.offered_levels, request.requestedLevel);
    if (!level) return this.refusal(new FederationProtocolError('federation.level_insufficient', 'no common level'), input.requestId);
    await this.recordPeer(manifest, digest, decision, 'handshake');
    const terms = await this.terms(identity, manifest);
    const record = await peeringRecords.handshakeReceived(this.ctx.pool, { peerNode: from, peerHubId: request.hubs.initiator, localHubId, level: level as PeeringLevelCode, manifestDigest: digest, keyId: manifest.keys.current, ...terms });
    const ours = await this.manifest();
    const response: HandshakeResponse = {
      protocol: MESH_PROTOCOL, outcome: 'admitted', from: identity.host, to: from, manifestDigest: { algorithm: 'trustwork-digest-1', value: ours.digest },
      level: record.level, state: record.state === 'active' ? 'active' : 'pending_approval', nonce: request.nonce, issuedAt: this.ctx.clock.now().toISOString(),
    };
    return this.reply(200, response);
  }

  /* ---------- The handshake we send ---------- */

  /** Sends our handshake for a record awaiting the peer and records the peer's signed answer. */
  async sendHandshake(record: PeeringRecordRow): Promise<PeeringRecordRow> {
    const identity = await this.requireIdentity();
    const peer = await federationPeers.get(this.ctx.pool, record.peer_node);
    if (!peer) throw new ApiError('access.not_found', 'access.not_found');
    const ours = await this.manifest();
    const hubs = await this.manifestHubs();
    const local = hubs.find((h) => h.hub_id === record.local_hub_id);
    if (!local) throw new ApiError('access.not_found', 'the local hub is not in the manifest', { reason: 'no_hub' });
    const nonce = freshNonce();
    const request: HandshakeRequest = {
      protocol: MESH_PROTOCOL, from: identity.host, to: record.peer_node, manifest: ours.document as NodeManifest, requestedLevel: record.level,
      hubs: { initiator: local.slug, responder: record.peer_hub_id }, nonce, issuedAt: this.ctx.clock.now().toISOString(),
    };
    const bytes = utf8Encode(canonicalize(request));
    const fields = await this.withSigner((signer) => signRequest({ method: 'POST', targetUri: `https://${record.peer_node}${MESH_ENDPOINTS.handshake}`, body: bytes, signer, now: this.ctx.clock.now() }));
    let response: PeerResponse;
    try {
      response = await this.options.transport.postHandshake(record.peer_node, bytes, fields);
    } catch (error) {
      this.ctx.log('federation.handshake_unreachable', { peer: record.peer_node, recordId: record.id, message: error instanceof Error ? error.message : String(error) });
      return record;
    }
    const verification = await verifySignedMessage({ status: response.status, header: response.header, body: response.body }, (peer.manifest as NodeManifest).keys.chain, this.ctx.clock.now(), null);
    if (!verification.ok) {
      this.ctx.log('federation.handshake_answer_unverified', { peer: record.peer_node, recordId: record.id, code: verification.code });
      return record;
    }
    let answer: unknown;
    try {
      answer = JSON.parse(Buffer.from(response.body).toString('utf8'));
    } catch {
      return record;
    }
    const parsed = HandshakeResponseSchema.safeParse(answer);
    if (!parsed.success || parsed.data.nonce !== nonce || parsed.data.from !== record.peer_node || parsed.data.to !== identity.host) {
      this.ctx.log('federation.handshake_answer_invalid', { peer: record.peer_node, recordId: record.id });
      return record;
    }
    if (parsed.data.outcome === 'refused') return peeringRecords.peerAnswered(this.ctx.pool, record.id, { outcome: 'refused', code: parsed.data.code });
    return peeringRecords.peerAnswered(this.ctx.pool, record.id, { outcome: 'admitted', level: parsed.data.level as PeeringLevelCode, state: parsed.data.state });
  }

  /* ---------- Console: node identity and keys ---------- */

  private identityInput(body: InitializeNodeCommand | UpdateNodeCommand): NodeIdentityInput {
    const licences = { ...defaultDataLicences(), ...(body.licences ?? {}) } as Record<MeshDataClass, SyndicationTerm>;
    for (const c of MESH_DATA_CLASSES) {
      if (!DATA_LICENCE_RULES[c].allowed.includes(licences[c])) throw new ApiError('validation.schema', `a node may only publish the default or a stricter licence for ${c}`, { reason: 'licence_too_loose', items: [c] });
    }
    return {
      engineVersion: body.engineVersion ?? this.options.engine.version, engineSource: body.engineSource ?? this.options.engine.source, operatorName: body.operatorName, registration: body.registration,
      abuseContact: body.abuseContact, takedownContact: body.takedownContact, jurisdiction: body.jurisdiction, licences, tombstoneHours: body.tombstoneHours,
      offeredLevels: [...new Set(body.offeredLevels)] as PeeringLevelCode[], agentEnvelopesPerHour: body.agentEnvelopesPerHour,
    };
  }
  node(state: RequestState) {
    return this.read(state, async (trx) => {
      const identity = await nodeIdentity.current(trx);
      const keys = (await nodeKeys.chain(trx)).map(toNodeKey);
      const manifests = (await nodeManifests.history(trx, 20)).map(toManifestVersion);
      return { identity: identity ? toIdentity(identity) : null, keys, manifests };
    });
  }
  /** Initializes the node identity and generates the genesis key; the seed is sealed before it reaches the database. */
  initialize(e: Elevated, body: InitializeNodeCommand) {
    const input = this.identityInput(body);
    const sealer = this.sealer();
    return this.staff(e, body, { hubId: null, permission: 'admin.node.hubs.manage', action: 'federation.node_initialized', objectType: 'node_identity', objectId: NODE_OBJECT }, async (trx, cmd) => {
      const node = await trx.selectFrom('admin_node').select('id').executeTakeFirst();
      if (!node) throw new ApiError('validation.schema', 'the node is not set up yet', { reason: 'no_node' });
      const { publicKey, seed } = generateNodeKey();
      try {
        const sealed = await sealer.seal(seed, node.id, body.keyId);
        const row = await nodeIdentity.init(trx, cmd, { ...input, host: body.host, key: { keyId: body.keyId, publicKey, validFrom: wholeSecond(this.ctx.clock.now()), sealed } });
        return { result: await this.result(trx, cmd, 'applied', row.node_id, row.revision, null), identity: toIdentity(row), keys: (await nodeKeys.chain(trx)).map(toNodeKey) };
      } finally {
        seed.destroy();
      }
    });
  }
  update(e: Elevated, body: UpdateNodeCommand) {
    const input = this.identityInput(body);
    return this.staff(e, body, { hubId: null, permission: 'admin.node.hubs.manage', action: 'federation.node_updated', objectType: 'node_identity', objectId: NODE_OBJECT }, async (trx, cmd) => {
      const row = await nodeIdentity.update(trx, cmd, body.expectedRevision, input);
      return { result: await this.result(trx, cmd, 'applied', row.node_id, row.revision, null), identity: toIdentity(row) };
    });
  }
  /** Rotation (second person `ops.rotate_node_key`): the current key signs the hand-over to a freshly generated key. */
  rotateKey(e: Elevated, body: RotateKeyCommand) {
    const sealer = this.sealer();
    return this.staff(e, body, { hubId: null, permission: 'admin.node.keys.rotate', action: 'federation.key_rotated', objectType: 'node_key', objectId: NODE_OBJECT }, async (trx, cmd) => {
      const identity = await nodeIdentity.current(trx);
      if (!identity) throw new ApiError('access.not_found', 'the node identity is not initialized', { reason: 'node_not_configured' });
      const chain = (await nodeKeys.chain(trx)).map(toNodeKey);
      const current = chain.find((k) => k.retiredAt === null);
      if (!current) throw new ApiError('access.not_found', 'the node has no current key', { reason: 'node_not_configured' });
      if (body.compromisedSince !== null && Date.parse(body.compromisedSince) < Date.parse(current.validFrom)) throw new ApiError('validation.schema', 'a compromise lies within the key\'s validity', { reason: 'compromise_time' });
      const digestInput = keyRotationDigestInput({ nodeId: identity.node_id, previousKeyId: current.keyId, compromisedSince: body.compromisedSince });
      if (body.approvalId === null) return { result: await this.pending(trx, cmd, 'ops.rotate_node_key', { kind: 'node', nodeId: identity.node_id }, digestInput, identity.node_id, chain.length), keys: chain };
      if (chain.some((k) => k.keyId === body.nextKeyId)) throw new ApiError('validation.schema', 'key labels are unique in the chain', { reason: 'duplicate_key_id' });
      const rotatedAt = wholeSecond(this.ctx.clock.now());
      const { publicKey, seed } = generateNodeKey();
      try {
        const next: NodeKey = { keyId: body.nextKeyId, algorithm: 'ed25519', publicKey, validFrom: rotatedAt.toISOString(), retiredAt: null, revocation: null, rotation: null };
        const statement = rotationStatementFor(identity.host, current, next);
        const signed = await this.withSigner((signer) => signDocument('key_rotation', statement, signer.keyId, signer.sign), current.keyId);
        const sealed = await sealer.seal(seed, identity.node_id, body.nextKeyId);
        const row = await nodeKeys.rotate(trx, cmd, {
          approvalId: body.approvalId, previousKeyId: current.keyId, nextKeyId: body.nextKeyId, publicKey, rotatedAt, rotationSignature: signed.signature.value,
          compromisedSince: body.compromisedSince ? new Date(body.compromisedSince) : null, sealed,
        });
        return { result: await this.result(trx, cmd, 'applied', identity.node_id, row.position, null), keys: (await nodeKeys.chain(trx)).map(toNodeKey) };
      } finally {
        seed.destroy();
      }
    });
  }

  /* ---------- Console: peers and peering records ---------- */

  peers(state: RequestState) {
    return this.read(state, async (trx) => ({ items: (await federationPeers.list(trx)).map(toPeer) }));
  }
  records(state: RequestState, filter: { hubId?: string; peerNode?: string } = {}) {
    return this.read(state, async (trx) => ({ items: (await peeringRecords.list(trx, filter)).map(toPeeringRecord) }));
  }
  record(state: RequestState, id: string) {
    return this.read(state, async (trx) => {
      const row = await peeringRecords.get(trx, id);
      if (!row) throw new ApiError('access.not_found', 'access.not_found');
      const identity = await nodeIdentity.current(trx);
      return { record: toPeeringRecord(row), protocol: identity ? toProtocolRecord(row, identity.host) : null, events: (await peeringRecords.events(trx, id)).map(toEvent) };
    });
  }
  refusals(state: RequestState) {
    return this.read(state, async (trx) => ({ items: (await federationPeers.refusals(trx)).map(toRefusal) }));
  }
  private async view(trx: Transaction, cmd: CommandContext, row: PeeringRecordRow, outcome: 'applied' | 'pending_second_person' = 'applied', approvalRequestId: string | null = null) {
    return { result: await this.result(trx, cmd, outcome, row.id, row.revision, approvalRequestId, approvalRequestId ?? row.id), record: toPeeringRecord(row) };
  }

  /**
   * Asks a peer to connect: fetch and admit its manifest first (a refusal stores only the refusal record), then write
   * the outgoing record under the hub's authority (a second person for deal_routing and identity) and send the handshake.
   */
  async requestPeering(e: Elevated, body: RequestPeeringCommand) {
    const identity = await this.requireIdentity();
    if (body.peerNode === identity.host) throw new ApiError('validation.schema', 'a node does not peer with itself', { reason: 'self_peering' });
    // Only a launched hub asks to connect; an unknown or unlaunched one is refused alike, before any peer is contacted (the database repeats the check).
    if (!(await this.manifestHubs()).some((h) => h.hub_id === body.localHubId)) throw new ApiError('access.not_found', 'access.not_found');
    const peer = await this.peerForRequest(body.peerNode);
    if (peer.admission_state !== 'admitted') throw new ApiError('access.forbidden', 'the peer is not available for connection', { reason: 'federation.peer_restricted' });
    const theirs = peer.manifest as NodeManifest;
    if (!theirs.hubs.some((h) => h.id === body.peerHubId)) throw new ApiError('validation.schema', 'the peer hub is not in the peer\'s manifest', { reason: 'unknown_peer_hub' });
    if (!theirs.peeringPolicy.offered.includes(body.level)) throw new ApiError('validation.schema', 'the peer does not offer this level', { reason: 'level_not_offered_by_peer' });
    const terms = await this.terms(identity, theirs);
    const needsSecond = (SECOND_APPROVER_LEVELS as readonly string[]).includes(body.level);
    const written = await this.staff(e, body, { hubId: body.localHubId, permission: 'admin.federation.peer.edit', action: 'federation.peering_requested', objectType: 'peering_record', objectId: NODE_OBJECT }, async (trx, cmd) => {
      if (needsSecond && body.approvalId === null) {
        return { result: await this.pending(trx, cmd, 'federation.raise_peering_level', { kind: 'hub', hubId: body.localHubId }, peeringLevelDigestInput(body), NODE_OBJECT, 1), record: null };
      }
      const row = await peeringRecords.request(trx, cmd, { localHubId: body.localHubId, peerNode: body.peerNode, peerHubId: body.peerHubId, level: body.level as PeeringLevelCode, approvalId: body.approvalId, ...terms });
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), record: toPeeringRecord(row) };
    });
    // The record is committed with its audit row; the handshake goes out now and again on every refresh until the peer answers.
    if (written.record) await this.sendHandshakeFor(written.record.id);
    return written;
  }
  /** The peer's manifest for a request: fetched and re-admitted now; when unreachable, the one held and admitted within the last day. */
  private async peerForRequest(host: string): Promise<FederationPeerRow> {
    try {
      return await this.refreshPeer(host, 'request');
    } catch (error) {
      if (error instanceof FederationProtocolError) throw new ApiError(error.code === 'federation.peer_restricted' ? 'access.forbidden' : 'validation.schema', error.message, { reason: error.code });
      if (error instanceof PeerUnreachableError) {
        const held = await federationPeers.get(this.ctx.pool, host);
        if (held && held.admission_state === 'admitted' && held.refresh_due_at.getTime() > this.ctx.clock.now().getTime()) return held;
        throw new ApiError('validation.schema', 'the peer could not be reached', { reason: 'peer_unreachable' });
      }
      throw error;
    }
  }
  /** Sends the handshake of a record still awaiting the peer; a failure is logged and the next refresh tries again. */
  private async sendHandshakeFor(recordId: string): Promise<void> {
    const row = await peeringRecords.getForProtocol(this.ctx.pool, recordId);
    if (!row || row.state !== 'pending_approval' || row.phase !== 'awaiting_peer') return;
    try {
      await this.sendHandshake(row);
    } catch (error) {
      this.ctx.log('federation.handshake_failed', { recordId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  /** A person accepts an incoming request at most at the requested level; the acceptance handshake goes back to the peer after the commit. */
  async acceptPeering(e: Elevated, id: string, body: AcceptPeeringCommand) {
    const needsSecond = (SECOND_APPROVER_LEVELS as readonly string[]).includes(body.level);
    const written = await this.staff(e, body, { hubId: null, permission: 'admin.federation.peer.edit', action: 'federation.peering_accepted', objectType: 'peering_record', objectId: id }, async (trx, cmd) => {
      const current = await peeringRecords.get(trx, id);
      if (!current) throw new ApiError('access.not_found', 'access.not_found');
      if (!peeringLevelAtLeast(current.level, body.level)) throw new ApiError('validation.schema', 'acceptance grants at most the requested level', { reason: 'level_above_request' });
      if (needsSecond && body.approvalId === null) {
        const row = await peeringRecords.awaitSecondApprover(trx, cmd, id, body.expectedRevision);
        const request = await approvals.request(trx, cmd, { action: 'federation.raise_peering_level', scope: { kind: 'hub', hubId: row.local_hub_id }, actionDigest: computeDigest(peeringLevelDigestInput({ localHubId: row.local_hub_id, peerNode: row.peer_node, peerHubId: row.peer_hub_id, level: body.level })).value });
        return this.view(trx, cmd, row, 'pending_second_person', request.id);
      }
      const row = await peeringRecords.accept(trx, cmd, id, body.expectedRevision, body.level as PeeringLevelCode, body.approvalId);
      return this.view(trx, cmd, row);
    });
    // The committed body is returned unchanged (it is also the stored idempotent response); the handshake follows the commit.
    if (written.result.outcome === 'applied') await this.sendHandshakeFor(id);
    return written;
  }
  declinePeering(e: Elevated, id: string, body: RecordCommand) {
    return this.staff(e, body, { hubId: null, permission: 'admin.federation.peer.edit', action: 'federation.peering_declined', objectType: 'peering_record', objectId: id }, async (trx, cmd) =>
      this.view(trx, cmd, await peeringRecords.decline(trx, cmd, id, body.expectedRevision)));
  }
  lowerPeering(e: Elevated, id: string, body: LowerPeeringCommand) {
    return this.staff(e, body, { hubId: null, permission: 'admin.federation.peer.edit', action: 'federation.peering_lowered', objectType: 'peering_record', objectId: id }, async (trx, cmd) =>
      this.view(trx, cmd, await peeringRecords.lower(trx, cmd, id, body.expectedRevision, body.level as PeeringLevelCode)));
  }
  suspendPeering(e: Elevated, id: string, body: RecordCommand) {
    return this.staff(e, body, { hubId: null, permission: 'admin.federation.peer.edit', action: 'federation.peering_suspended', objectType: 'peering_record', objectId: id }, async (trx, cmd) =>
      this.view(trx, cmd, await peeringRecords.suspend(trx, cmd, id, body.expectedRevision)));
  }
  liftSuspension(e: Elevated, id: string, body: RecordCommand) {
    return this.staff(e, body, { hubId: null, permission: 'admin.federation.peer.edit', action: 'federation.peering_suspension_lifted', objectType: 'peering_record', objectId: id }, async (trx, cmd) =>
      this.view(trx, cmd, await peeringRecords.lift(trx, cmd, id, body.expectedRevision)));
  }
  /** Defederation: ends the record; feeds and new deliveries stop, history stays. */
  endPeering(e: Elevated, id: string, body: RecordCommand) {
    return this.staff(e, body, { hubId: null, permission: 'admin.federation.defederate', action: 'federation.defederated', objectType: 'peering_record', objectId: id }, async (trx, cmd) =>
      this.view(trx, cmd, await peeringRecords.end(trx, cmd, id, body.expectedRevision)));
  }
  /**
   * Console refresh: fetch and re-admit the peer's manifest now and resend the handshake of every record awaiting the
   * peer, then record who asked and the outcome in the request transaction (the fetch is idempotent, so a retry repeats it).
   */
  async refreshPeerCommand(e: Elevated, body: { peerNode: string } & Cmd) {
    const cmd = this.commandContext(e, body);
    // A plain read (not the request transaction): the idempotency record completes once, in the audited transaction below.
    const principal = e.state.principal as Principal;
    const visible = await withPrincipal(this.ctx.pool, { personId: principal.personId, authzEpoch: principal.authzEpoch }, (trx) => peeringRecords.list(trx, { peerNode: body.peerNode }));
    if (visible.length === 0) throw new ApiError('access.not_found', 'access.not_found');
    let peer: FederationPeerRow | null = null;
    let code: string | null = null;
    try {
      peer = await this.refreshPeer(body.peerNode, 'manual');
    } catch (error) {
      if (error instanceof FederationProtocolError) code = error.code;
      else if (error instanceof PeerUnreachableError) code = 'peer_unreachable';
      else throw error;
    }
    const records: PeeringRecordRow[] = [];
    if (peer && peer.admission_state === 'admitted') {
      for (const row of visible.filter((r) => r.state === 'pending_approval' && r.phase === 'awaiting_peer')) records.push(await this.sendHandshake(row));
    }
    const outcome = (code ?? (peer?.admission_state === 'admitted' ? 'admitted' : 'refused')).replace(/[^a-z0-9_.]/g, '_');
    return this.staff(e, body, { hubId: null, permission: 'admin.federation.peer.edit', action: 'federation.peer_refreshed', objectType: 'peering_record', objectId: visible[0]!.id }, async (trx) => {
      await peeringRecords.noteRefresh(trx, cmd, body.peerNode, outcome);
      return { peer: peer ? toPeer(peer) : null, code, records: records.map(toPeeringRecord) };
    });
  }

  /** `restrictedPlaces` helper for callers that hold the codes. */
  static restrictedOf(codes: Iterable<string>) {
    return restrictedPlaces(codes);
  }
  /** Visible for tests: the declared restrictions of a manifest. */
  static declaredRestrictions(manifest: NodeManifest, restricted: RestrictedPlaces) {
    return manifestRestrictions(manifest, restricted);
  }
  /** Which key signed at `createdAt` (visible for tests). */
  static keyFor(keys: readonly NodeKey[], keyId: string, createdAt: string) {
    return keyForSignature(keys, keyId, createdAt);
  }
}
