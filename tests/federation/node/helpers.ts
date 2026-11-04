import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal, type DataPool, type Principal, type Transaction } from '@trustwork/data';
import { computeDigest, type ConsolePermission, type HubStaffRole } from '@trustwork/contracts';
import { adminDigests, adminSetup, approvals, staffAssignments, staffRoleDefinitions, type CommandContext, type StaffScope } from '../../../packages/data/src/repositories/admin.js';
import { deploymentAttestations } from '../../../packages/data/src/repositories/attestation.js';
import { sessionElevations } from '../../../packages/data/src/repositories/identity.js';
import { kernelReference, kernelSync } from '../../../packages/data/src/repositories/kernel.js';
import { hubs, type CreateHubInput } from '../../../packages/data/src/repositories/hubs.js';
import { canonicalize } from '../../../packages/contracts/src/common/canonical.js';
import { utf8Encode } from '../../../packages/contracts/src/common/encoding.js';
import { MESH_PROTOCOL, type Ed25519Sign, type NodeManifest } from '../../../packages/contracts/src/federation.js';
import type { ConsoleSecondPersonAction } from '../../../packages/contracts/src/hub.js';
import { signRequest, signResponse, type SignedFields } from '../../../apps/api/src/modules/federation/node/http-signatures.js';
import type { PeerResponse, PeerTransport } from '../../../apps/api/src/modules/federation/node/transport.js';
import { principalFor } from '../../data/helpers/seed.js';
import { CITY, manifest as fixtureManifest, NODE_SIGNERS, RFC8032, signerFor, type ManifestOptions } from '../protocol/fixtures.js';

/*
 * Synthetic world for the FED-001 suites. Every person, hub and node is synthetic; node names use the RFC 2606
 * example.org domain; the peer's keys are the published RFC 8032 test keys (public test data), our node's keys are
 * generated per test run and sealed with the in-process fake KMS. Nothing touches the network: the peer is a local fake.
 *
 * - founder: platform-owner (founding administrator; assigns staff; may rotate the node key as the second person)
 * - founder2: staff-admin (approves sensitive assignments)
 * - operator: node-operator (sets up the node identity, attests the deployment location, rotates the node key)
 * - owner: hub-owner of the hub (peering requests and decisions, defederation)
 * - officer: compliance-officer at the node (the second person for deal_routing and identity; reads refusals)
 * - moderator: moderator of the hub (no federation permission); outsider: a participant without any role
 */
type Def = { role: HubStaffRole; scopes: ('platform' | 'node' | 'hub')[]; permissions: ConsolePermission[] };
export const DEFINITIONS: Def[] = [
  { role: 'platform-owner', scopes: ['platform'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read', 'admin.audit.read', 'admin.node.keys.rotate'] },
  { role: 'staff-admin', scopes: ['platform', 'node', 'hub'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read'] },
  { role: 'node-operator', scopes: ['node'], permissions: ['admin.node.hubs.manage', 'admin.node.keys.rotate', 'admin.hub.read', 'admin.federation.read'] },
  { role: 'hub-owner', scopes: ['hub'], permissions: ['admin.hub.read', 'admin.federation.read', 'admin.federation.peer.edit', 'admin.federation.defederate', 'admin.audit.read'] },
  { role: 'compliance-officer', scopes: ['node', 'hub'], permissions: ['admin.hub.read', 'admin.federation.read', 'admin.federation.peer.edit', 'admin.audit.read', 'admin.hub.jurisdiction.edit'] },
  { role: 'moderator', scopes: ['hub'], permissions: ['admin.moderation.read'] },
];

export type Key = 'founder' | 'founder2' | 'operator' | 'owner' | 'officer' | 'moderator' | 'outsider';
export const KEYS: Key[] = ['founder', 'founder2', 'operator', 'owner', 'officer', 'moderator', 'outsider'];
export interface NodeWorld {
  nodeId: string;
  hubId: string;
  hubSlug: string;
  people: Record<Key, string>;
  sessions: Record<Key, string>;
}

export const OUR_HOST = 'sandiego.example.org';
export const PEER_HOST = CITY;
export const PEER_HUB = 'us-tx-austin';
export const HUB_SLUG = 'synthetic-sd-reference';
/** Documentation address ranges (RFC 5737): the fake gate serves 203.0.113.0/24 and refuses 192.0.2.0/24. */
export const SERVED_ADDRESS = '203.0.113.10';
export const RESTRICTED_ADDRESS = '192.0.2.44';

export const US_HUB: Omit<CreateHubInput, 'slug'> = {
  name: { en: 'Synthetic San Diego demo hub', es: 'Centro de demostracion sintetico de San Diego' },
  defaultLocale: 'en', locales: ['en', 'es'], timeZone: 'America/Los_Angeles', currency: 'USD', countryPack: null,
  territories: [{ level: 'country', code: 'US' }, { level: 'region', code: 'US-CA' }, { level: 'place', code: 'US-CA:san-diego' }],
};
export const US_ATTESTATION = { operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE', hostingCountry: 'US', hostingRegion: 'US-VA', gateMode: 'upstream_gate' as const };

export async function syncKernel(admin: DataPool): Promise<void> {
  const reference = await kernelReference.fromRepository();
  await withMaintenance(admin, (trx) => kernelSync.apply(trx, reference));
}

export async function buildNodeWorld(admin: DataPool): Promise<Omit<NodeWorld, 'hubId' | 'hubSlug'>> {
  return withMaintenance(admin, async (trx) => {
    for (const def of DEFINITIONS) {
      await staffRoleDefinitions.release(trx, { version: 1, role: def.role, scopes: def.scopes, permissions: def.permissions, caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
    const { id: nodeId } = await adminSetup.createNode(trx, 'Synthetic federation node');
    const people = {} as Record<Key, string>;
    const sessions = {} as Record<Key, string>;
    for (const key of KEYS) {
      people[key] = (await trx.insertInto('person').values({ display_name: `Synthetic ${key}` }).returning('id').executeTakeFirstOrThrow()).id;
      sessions[key] = (await trx.insertInto('session').values({
        person_id: people[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password',
      }).returning('id').executeTakeFirstOrThrow()).id;
    }
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder, role: 'platform-owner', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder2, role: 'staff-admin', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    return { nodeId, people, sessions };
  });
}

export function actors(adminPool: DataPool, runtime: DataPool, world: Omit<NodeWorld, 'hubId' | 'hubSlug'>) {
  const principal = (personId: string): Promise<Principal> => principalFor(adminPool, personId);
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(runtime, await principal(personId), fn);
  const keyOf = (personId: string) => KEYS.find((k) => world.people[k] === personId) as Key;
  const elevate = async (personId: string, validForSeconds = 900): Promise<CommandContext> => {
    const elevation = await as(personId, (trx) => sessionElevations.insert(trx, { sessionId: world.sessions[keyOf(personId)], personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + validForSeconds * 1000) }));
    return { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic federation test' };
  };
  const cmd = async <T>(personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>): Promise<T> => {
    const ctx = await elevate(personId);
    return as(personId, (trx) => fn(trx, ctx));
  };
  const assign = async (input: { personId: string; role: HubStaffRole; scope: StaffScope }) => cmd(world.people.founder, (trx, ctx) => staffAssignments.assign(trx, ctx, { ...input, definitionVersion: 1 }));
  const assignSensitive = async (input: { personId: string; role: HubStaffRole; scope: StaffScope }) => {
    const digest = adminDigests.assignment({ breakglass: false, personId: input.personId, role: input.role, scope: input.scope, definitionVersion: 1 });
    const ownerCtx = await elevate(world.people.founder);
    const request = await as(world.people.founder, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: input.scope, actionDigest: digest }));
    await cmd(world.people.founder2, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    return as(world.people.founder, (trx) => staffAssignments.assign(trx, ownerCtx, { ...input, definitionVersion: 1, approvalId: request.id }));
  };
  /** Second person: `requester` asks for the action at the scope with the digest, `approver` approves; returns the approval id. */
  const approve = async (requester: string, approver: string, action: ConsoleSecondPersonAction, scope: StaffScope, digestInput: unknown): Promise<string> => {
    const digest = computeDigest(digestInput).value;
    const request = await cmd(requester, (trx, ctx) => approvals.request(trx, ctx, { action, scope, actionDigest: digest }));
    await cmd(approver, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    return request.id;
  };
  const createHub = async (slug: string, input: Omit<CreateHubInput, 'slug'> = US_HUB) => cmd(world.people.operator, (trx, ctx) => hubs.create(trx, ctx, { slug, ...input }));
  const attest = async () => cmd(world.people.operator, (trx, ctx) => deploymentAttestations.attest(trx, ctx, { ...US_ATTESTATION, supersedes: null, statementVersion: 'deployment-location-1' }));
  /** Assigns every role of the world: operator at the node, owner and moderator at the hub, officer at the node. */
  const assignRoles = async (hubId: string) => {
    await assignSensitive({ personId: world.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: world.nodeId } });
    await assignSensitive({ personId: world.people.owner, role: 'hub-owner', scope: { kind: 'hub', hubId } });
    await assignSensitive({ personId: world.people.officer, role: 'compliance-officer', scope: { kind: 'node', nodeId: world.nodeId } });
    await assign({ personId: world.people.moderator, role: 'moderator', scope: { kind: 'hub', hubId } });
  };
  return { principal, as, elevate, cmd, assign, assignSensitive, approve, createHub, attest, assignRoles };
}

/**
 * A hub fixture at a given lifecycle stage (the HUB-001 lifecycle needs every launch gate, so the suites insert the
 * launched reference hub as maintenance, like the hubs crash case does): the anchor, its profile and its territories.
 */
export async function insertHub(admin: DataPool, input: { nodeId: string; createdBy: string; slug: string; lifecycle: 'draft' | 'preparing' | 'soft_launch' | 'public'; territories?: { level: 'country' | 'region' | 'place'; code: string }[] }): Promise<string> {
  return withMaintenance(admin, async (trx) => {
    const hub = await trx.insertInto('hub').values({ slug: input.slug, lifecycle: input.lifecycle }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('hub_profile').values({ hub_id: hub.id, node_id: input.nodeId, name: US_HUB.name, default_locale: 'en', locales: ['en', 'es'], time_zone: US_HUB.timeZone, currency: 'USD', created_by: input.createdBy }).execute();
    for (const t of input.territories ?? US_HUB.territories) {
      await trx.insertInto('hub_territory').values({ hub_id: hub.id, level: t.level, code: t.code, place_key: t.level === 'place' ? t.code.split(':')[1] ?? null : null }).execute();
    }
    return hub.id;
  });
}

/** The whole world: roles, the launched reference hub, the synced kernel and the attestation. */
export async function buildWorld(admin: DataPool, runtime: DataPool): Promise<{ w: NodeWorld; a: ReturnType<typeof actors> }> {
  await syncKernel(admin);
  const base = await buildNodeWorld(admin);
  const a = actors(admin, runtime, base);
  await a.assignSensitive({ personId: base.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: base.nodeId } });
  const hubId = await insertHub(admin, { nodeId: base.nodeId, createdBy: base.people.operator, slug: HUB_SLUG, lifecycle: 'public' });
  await a.assignSensitive({ personId: base.people.owner, role: 'hub-owner', scope: { kind: 'hub', hubId } });
  await a.assignSensitive({ personId: base.people.officer, role: 'compliance-officer', scope: { kind: 'node', nodeId: base.nodeId } });
  await a.assign({ personId: base.people.moderator, role: 'moderator', scope: { kind: 'hub', hubId } });
  await a.attest();
  return { w: { ...base, hubId, hubSlug: HUB_SLUG }, a };
}

/* ---------- The local fake peer ---------- */

export interface FakePeer {
  host: string;
  /** The manifest the peer serves; replaced to simulate a change, a rotation or a revocation. */
  manifest: () => Record<string, unknown>;
  /** The server address our transport resolves the peer's name to (observed evidence of the admission check). */
  remoteAddress: string | null;
  signer: { keyId: string; sign: Ed25519Sign };
  /** How the peer answers our handshake; default: admitted, pending a person. */
  answer: (request: Record<string, unknown>) => Record<string, unknown>;
  /** Manifest fetch outcome override (status) to simulate an unreachable or broken peer. */
  manifestStatus?: number;
  /** Raw manifest bytes override (an oversized or malformed answer). */
  manifestBytes?: () => Uint8Array;
  /** A peer that drips: the manifest answer arrives only after this many milliseconds. */
  manifestDelayMs?: number;
}
export interface HandshakeCall { host: string; body: Record<string, unknown>; fields: SignedFields }

/** A transport that never touches the network: every host is a fake peer built on the protocol fixtures. */
export class FakePeerTransport implements PeerTransport {
  readonly peers = new Map<string, FakePeer>();
  readonly handshakes: HandshakeCall[] = [];
  readonly manifestFetches: string[] = [];
  /** Every name resolved, and the address each connection was pinned to (proves a judged address is the one connected to). */
  readonly resolves: string[] = [];
  readonly connections: { host: string; address: string }[] = [];
  constructor(private readonly now: () => Date) {}

  async resolve(host: string): Promise<string | null> {
    const peer = this.peers.get(host);
    if (!peer) throw new Error(`fake transport: no such peer ${host}`);
    this.resolves.push(host);
    return peer.remoteAddress;
  }

  add(peer: FakePeer): FakePeer {
    this.peers.set(peer.host, peer);
    return peer;
  }
  private respond(peer: FakePeer, status: number, body: Record<string, unknown>): PeerResponse {
    const bytes = utf8Encode(canonicalize(body));
    const fields = signResponse({ status, body: bytes, signer: peer.signer, now: this.now() });
    return { status, header: (name) => (fields as Record<string, string>)[name.toLowerCase()] ?? null, body: bytes, remoteAddress: peer.remoteAddress };
  }
  async fetchManifest(host: string, address: string): Promise<PeerResponse> {
    const peer = this.peers.get(host);
    if (!peer) throw new Error(`fake transport: no such peer ${host}`);
    this.manifestFetches.push(host);
    this.connections.push({ host, address });
    if (peer.manifestDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, peer.manifestDelayMs));
    const bytes = peer.manifestBytes ? peer.manifestBytes() : utf8Encode(canonicalize(peer.manifest()));
    return { status: peer.manifestStatus ?? 200, header: () => null, body: bytes, remoteAddress: address };
  }
  async postHandshake(host: string, address: string, body: Uint8Array, fields: SignedFields): Promise<PeerResponse> {
    const peer = this.peers.get(host);
    if (!peer) throw new Error(`fake transport: no such peer ${host}`);
    this.connections.push({ host, address });
    const request = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
    this.handshakes.push({ host, body: request, fields });
    const answer = peer.answer(request);
    return this.respond(peer, answer.outcome === 'refused' ? 451 : 200, answer);
  }
}

/** The Austin peer of the protocol fixtures (key a1 = RFC 8032 TEST 3), served from a documentation address. */
export function austinPeer(transport: FakePeerTransport, now: () => Date, options: ManifestOptions = {}): FakePeer {
  let current: Record<string, unknown> = fixtureManifest({ node: CITY, ...options });
  const peer: FakePeer = {
    host: CITY,
    manifest: () => current,
    remoteAddress: SERVED_ADDRESS,
    signer: { keyId: NODE_SIGNERS[CITY]!.keyId, sign: NODE_SIGNERS[CITY]!.sign },
    answer: (request) => ({
      protocol: MESH_PROTOCOL, outcome: 'admitted', from: CITY, to: request.from, manifestDigest: computeDigest(current), level: request.requestedLevel, state: 'pending_approval',
      nonce: request.nonce, issuedAt: now().toISOString(),
    }),
  };
  (peer as FakePeer & { setManifest: (m: Record<string, unknown>) => void }).setManifest = (m) => { current = m; };
  return transport.add(peer);
}
export const setPeerManifest = (peer: FakePeer, manifest: Record<string, unknown>) => (peer as FakePeer & { setManifest: (m: Record<string, unknown>) => void }).setManifest(manifest);

/** A handshake request from the Austin peer to our node, signed with the peer's key as the peer would. */
export function peerHandshake(input: { to: string; responderHub: string; level?: string; manifest?: Record<string, unknown>; now: Date; signer?: { keyId: string; sign: Ed25519Sign }; nonce?: string; bodyOverride?: Record<string, unknown> }) {
  const request = {
    protocol: MESH_PROTOCOL, from: CITY, to: input.to, manifest: input.manifest ?? fixtureManifest({ node: CITY }), requestedLevel: input.level ?? 'syndicate',
    hubs: { initiator: PEER_HUB, responder: input.responderHub }, nonce: input.nonce ?? Buffer.from(randomBytes(24)).toString('base64url'), issuedAt: input.now.toISOString(),
    ...(input.bodyOverride ?? {}),
  };
  const body = utf8Encode(canonicalize(request));
  const signer = input.signer ?? { keyId: NODE_SIGNERS[CITY]!.keyId, sign: NODE_SIGNERS[CITY]!.sign };
  const fields = signRequest({ method: 'POST', targetUri: `https://${input.to}/federation/v1/handshake`, body, signer, now: input.now });
  return { request, body, fields };
}
/** A signer that is not the peer's: RFC 8032 TEST 1, never in the Austin chain. */
export const forgedSigner = { keyId: NODE_SIGNERS[CITY]!.keyId, sign: signerFor(RFC8032.test1) };

export const asManifest = (value: unknown): NodeManifest => value as NodeManifest;

interface PgError { code?: string; hint?: string; message?: string; detail?: string }
export async function settle(promise: Promise<unknown>): Promise<PgError | null> {
  return promise.then(() => null, (e: unknown) => e as PgError);
}
export async function rejects(promise: Promise<unknown>, state: string, hint?: string): Promise<PgError> {
  const error = await settle(promise);
  assert.ok(error, `expected a rejection${hint ? ` (${hint})` : ''}`);
  assert.equal(error.code, state, `${error.message} (hint ${error.hint}, detail ${error.detail})`);
  if (hint) assert.equal(error.hint, hint, `${error.message} (detail ${error.detail})`);
  return error;
}
