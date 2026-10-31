import { z } from 'zod';
import { canonicalize } from './common/canonical.js';
import { DigestSchema } from './common/digest-schema.js';
import { fromBase64Url, toBase64Url, utf8Encode } from './common/encoding.js';
import { IdSchema, TimestampSchema, nfc } from './common/ids.js';
import { LocaleTagSchema } from './hub.js';
import { coveringRestrictedPlace, parseAddress, RestrictedPlaceCodeSchema, type RestrictedPlaces } from './sanctions.js';
import { DeploymentLocationAttestationSummarySchema, deploymentLocationRefusals, type DeploymentLocationAttestationSummary } from './sanctions-attestation.js';

/* ==========================================================================================================
 * Federation mesh protocol `trustwork-mesh/1` (FED-000, ADR 011, R39).
 *
 * The normative text for implementers is docs/engine/federation-protocol.md; conformance vectors live in
 * tests/federation/protocol/vectors. This module is client-safe: no `node:` import and no hashing or signature
 * computation. Digests and Ed25519 signatures are computed and verified by the caller (FED-001 adapters, the test
 * suite); the pure functions here build the exact bytes to hash or sign and check everything that needs no crypto.
 *
 * Rules carried by the schemas:
 * - only the `public` and `shared_party` projections cross a node boundary; `party_private`, `owner_private` and
 *   `staff_case` are refused by every envelope schema (ADR 011 decision 5);
 * - each object kind declares the projections, data classes, feed stream and consent bases it may carry;
 * - a manifest that declares a restricted place (jurisdiction, operator country, hub territory, country pack or
 *   attested location) is refused at validation (ADR 011 decision 12, ADR 014 decision 4);
 * - no record defined here carries a network address: nodes are DNS names, schemas are strict, and the payload scan
 *   refuses address-shaped keys and values;
 * - a person-related object travels only with a consent basis allowed for its kind, and a `shared_party` object only
 *   to the home nodes of the parties named in its audience; derived answers inherit the intersection of audiences.
 * ========================================================================================================== */

export const MESH_PROTOCOL = 'trustwork-mesh/1' as const;
export const MeshProtocolSchema = z.literal(MESH_PROTOCOL);
/** Version of the replica merge rule for revisions, conflicts and tombstones (MSH-F19). */
export const REPLICA_MERGE_METHOD = 'trustwork-merge-1' as const;
/** Well-known location of a node manifest. */
export const MANIFEST_PATH = '/.well-known/trustwork/manifest.json' as const;
/** HTTP endpoints of `trustwork-mesh/1`, relative to `https://<node>`. */
export const MESH_ENDPOINTS = {
  manifest: MANIFEST_PATH,
  handshake: '/federation/v1/handshake',
  feed: '/federation/v1/feeds/{stream}',
  inbox: '/federation/v1/inbox',
  object: '/federation/v1/objects/{globalId}',
} as const;

/* ---------- Error codes (English machine codes, fixed HTTP status) ---------- */

export const FEDERATION_ERROR_CODES = [
  'federation.peer_restricted',
  'federation.protocol_unsupported',
  'federation.manifest_invalid',
  'federation.signature_invalid',
  'federation.key_unknown',
  'federation.key_revoked',
  'federation.clock_skew',
  'federation.replay',
  'federation.digest_mismatch',
  'federation.projection_forbidden',
  'federation.not_peered',
  'federation.level_insufficient',
  'federation.not_addressed',
  'federation.transit_forbidden',
  'federation.delivery_conflict',
  'federation.replica_conflict',
  'federation.object_gone',
  'federation.payload_too_large',
  'federation.rate_limited',
] as const;
export const FederationErrorCodeSchema = z.enum(FEDERATION_ERROR_CODES);
export type FederationErrorCode = z.infer<typeof FederationErrorCodeSchema>;
/** `federation.peer_restricted` answers 451 (RFC 7725) like the visitor gate; it equals SANC-008's `FEDERATION_PEER_RESTRICTED`. */
export const FEDERATION_ERROR_STATUS: Readonly<Record<FederationErrorCode, number>> = Object.freeze({
  'federation.peer_restricted': 451,
  'federation.protocol_unsupported': 400,
  'federation.manifest_invalid': 422,
  'federation.signature_invalid': 401,
  'federation.key_unknown': 401,
  'federation.key_revoked': 401,
  'federation.clock_skew': 401,
  'federation.replay': 409,
  'federation.digest_mismatch': 422,
  'federation.projection_forbidden': 422,
  'federation.not_peered': 403,
  'federation.level_insufficient': 403,
  'federation.not_addressed': 421,
  'federation.transit_forbidden': 421,
  'federation.delivery_conflict': 409,
  'federation.replica_conflict': 409,
  'federation.object_gone': 410,
  'federation.payload_too_large': 413,
  'federation.rate_limited': 429,
});
/** Error body of every federation endpoint. `details` names fields and reasons, never an address or private value. */
export const FederationErrorSchema = z.strictObject({
  protocol: MeshProtocolSchema,
  code: FederationErrorCodeSchema,
  message: z.string().min(1).max(500),
  requestId: IdSchema,
});
export type FederationError = z.infer<typeof FederationErrorSchema>;

/* ---------- Node names and global identifiers ---------- */

const DNS_LABEL = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)';
const NODE_HOST_PATTERN = `${DNS_LABEL}(?:\\.${DNS_LABEL})*\\.[a-z][a-z0-9-]{0,61}[a-z0-9]`;
const NODE_HOST = new RegExp(`^${NODE_HOST_PATTERN}$`);

/**
 * A node is named by its lowercase DNS name (no scheme, port, path or trailing dot). An address literal is never a
 * node name, so no federation record can hold a network address in this field.
 */
export const NodeHostSchema = z
  .string()
  .max(253)
  .regex(NODE_HOST, 'lowercase DNS name of the node')
  .refine((value) => parseAddress(value) === null, { message: 'a node is a DNS name, never a network address' });
export type NodeHost = z.infer<typeof NodeHostSchema>;

/** Kinds of objects that travel in envelopes. */
export const PUBLIC_OBJECT_KINDS = [
  'publication', 'magazine_issue', 'event', 'company_profile', 'person_profile', 'catalogue_item', 'project', 'open_need',
  'reputation_snapshot', 'certificate', 'passport_credential',
] as const;
export const SHARED_PARTY_OBJECT_KINDS = [
  'introduction', 'rfq_invitation', 'rfq_version', 'quote_version', 'agreement', 'agreement_event', 'agent_envelope', 'review_submission',
] as const;
export const FEDERATED_OBJECT_KINDS = [...PUBLIC_OBJECT_KINDS, ...SHARED_PARTY_OBJECT_KINDS] as const;
export const FederatedObjectKindSchema = z.enum(FEDERATED_OBJECT_KINDS);
export type FederatedObjectKind = z.infer<typeof FederatedObjectKindSchema>;

/** Kinds a global identifier may name: envelope objects, parties, hubs and protocol documents. */
export const GLOBAL_ID_KINDS = [...FEDERATED_OBJECT_KINDS, 'person', 'company', 'hub', 'tombstone', 'takedown_notice', 'link_proposal', 'moderation_report'] as const;
export const GlobalIdKindSchema = z.enum(GLOBAL_ID_KINDS);
export type GlobalIdKind = z.infer<typeof GlobalIdKindSchema>;

const GLOBAL_ID = new RegExp(`^trustwork://(${NODE_HOST_PATTERN})/([a-z_]+)/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$`);
export interface GlobalIdParts {
  readonly host: string;
  readonly kind: GlobalIdKind;
  readonly localId: string;
}
/** Splits a global identifier for routing and display. Never used to authorize: the home node decides from its records. */
export function parseGlobalId(value: string): GlobalIdParts | null {
  const match = GLOBAL_ID.exec(value);
  if (!match) return null;
  const [, host, kind, localId] = match as unknown as [string, string, string, string];
  if (parseAddress(host) !== null || host.length > 253) return null;
  if (!GlobalIdKindSchema.safeParse(kind).success || !IdSchema.safeParse(localId).success) return null;
  return { host, kind: kind as GlobalIdKind, localId };
}
/** `trustwork://<node-host>/<kind>/<local-id>`: derived from the local opaque id (ADR 011 decision 3). */
export function formatGlobalId(parts: GlobalIdParts): string {
  const value = `trustwork://${parts.host}/${parts.kind}/${parts.localId}`;
  if (parseGlobalId(value) === null) throw new Error('not a valid global identifier');
  return value;
}
export const GlobalIdSchema = z.string().max(400).refine((value) => parseGlobalId(value) !== null, { message: 'trustwork://<node-host>/<kind>/<local-id>' });
export type GlobalId = z.infer<typeof GlobalIdSchema>;
const kindOf = (id: string): GlobalIdKind | null => parseGlobalId(id)?.kind ?? null;
const hostOf = (id: string): string | null => parseGlobalId(id)?.host ?? null;
/** A party on the mesh: a person or a company, by global identifier. */
export const PartyGlobalIdSchema = GlobalIdSchema.refine((value) => kindOf(value) === 'person' || kindOf(value) === 'company', { message: 'a party is a person or a company' });

/* ---------- Projections ---------- */

/** The only projection layers that ever leave a node (ADR 011 decision 5). */
export const FEDERATED_PROJECTIONS = ['public', 'shared_party'] as const;
export type FederatedProjection = (typeof FEDERATED_PROJECTIONS)[number];
/** Layers that never federate: the schema refuses them with this message. */
export const NEVER_FEDERATED_PROJECTIONS = ['party_private', 'owner_private', 'staff_case'] as const;
const PROJECTION_REFUSAL = 'party_private, owner_private and staff_case projections never leave their node';
/** Parsing accepts every layer name so the refusal is explicit, then refuses the three private layers. */
export const FederatedProjectionSchema = z
  .enum(['public', 'shared_party', 'party_private', 'owner_private', 'staff_case'])
  .refine((value): value is FederatedProjection => (FEDERATED_PROJECTIONS as readonly string[]).includes(value), { message: PROJECTION_REFUSAL });

/* ---------- Data classes and licences (federation chapter, "Data licences") ---------- */

export const MESH_DATA_CLASSES = [
  'directory_facts', 'person_profiles', 'editorial_publications', 'member_publications', 'imported_items', 'magazine_issues', 'events',
  'open_needs', 'reputation_snapshots', 'reviews', 'certificates', 'images', 'deal_data',
] as const;
export const MeshDataClassSchema = z.enum(MESH_DATA_CLASSES);
export type MeshDataClass = z.infer<typeof MeshDataClassSchema>;

export const SYNDICATION_TERMS = [
  'open_data_with_attribution', 'cc_by_4_0', 'redisplay_with_attribution', 'mesh_only_redisplay', 'redisplay_unchanged', 'headline_and_link',
  'contents_and_links', 'verification_record', 'own_licence_only', 'source_licence', 'link_only', 'parties_only', 'none',
] as const;
export const SyndicationTermSchema = z.enum(SYNDICATION_TERMS);
export type SyndicationTerm = z.infer<typeof SyndicationTermSchema>;

/**
 * Per data class: the default term every manifest starts from and the terms a node may publish instead, ordered from
 * the default to the strictest. A node may only move right (stricter), never loosen (decided by the integrator on
 * 2026-10-30 under ADR 010 decision 10). `imported_items` defers to the source licence and `deal_data` is never
 * syndicated: it travels only to the parties' nodes.
 */
export const DATA_LICENCE_RULES: Readonly<Record<MeshDataClass, { readonly default: SyndicationTerm; readonly allowed: readonly SyndicationTerm[] }>> = Object.freeze({
  directory_facts: { default: 'open_data_with_attribution', allowed: ['open_data_with_attribution', 'redisplay_with_attribution', 'mesh_only_redisplay', 'link_only', 'none'] },
  person_profiles: { default: 'mesh_only_redisplay', allowed: ['mesh_only_redisplay', 'link_only', 'none'] },
  editorial_publications: { default: 'cc_by_4_0', allowed: ['cc_by_4_0', 'headline_and_link', 'link_only', 'none'] },
  member_publications: { default: 'headline_and_link', allowed: ['headline_and_link', 'link_only', 'none'] },
  imported_items: { default: 'source_licence', allowed: ['source_licence', 'none'] },
  magazine_issues: { default: 'contents_and_links', allowed: ['contents_and_links', 'link_only', 'none'] },
  events: { default: 'redisplay_with_attribution', allowed: ['redisplay_with_attribution', 'link_only', 'none'] },
  open_needs: { default: 'redisplay_with_attribution', allowed: ['redisplay_with_attribution', 'link_only', 'none'] },
  reputation_snapshots: { default: 'redisplay_unchanged', allowed: ['redisplay_unchanged', 'link_only', 'none'] },
  reviews: { default: 'none', allowed: ['none'] },
  certificates: { default: 'verification_record', allowed: ['verification_record', 'link_only', 'none'] },
  images: { default: 'own_licence_only', allowed: ['own_licence_only', 'none'] },
  deal_data: { default: 'parties_only', allowed: ['parties_only'] },
});
/**
 * Terms one envelope (one item) may carry for its data class. An item's own licence wins over the class default
 * (an author who chose CC BY 4.0, a source that allows redisplay); `none` never appears because such items stay home.
 */
export const ITEM_SYNDICATION_TERMS: Readonly<Record<MeshDataClass, readonly SyndicationTerm[]>> = Object.freeze({
  directory_facts: ['open_data_with_attribution', 'redisplay_with_attribution', 'mesh_only_redisplay', 'link_only'],
  person_profiles: ['mesh_only_redisplay', 'link_only'],
  editorial_publications: ['cc_by_4_0', 'headline_and_link', 'link_only'],
  member_publications: ['cc_by_4_0', 'headline_and_link', 'link_only'],
  imported_items: ['cc_by_4_0', 'redisplay_with_attribution', 'headline_and_link', 'link_only'],
  magazine_issues: ['contents_and_links', 'link_only'],
  events: ['redisplay_with_attribution', 'link_only'],
  open_needs: ['redisplay_with_attribution', 'link_only'],
  reputation_snapshots: ['redisplay_unchanged', 'link_only'],
  reviews: [],
  certificates: ['verification_record', 'link_only'],
  images: ['own_licence_only'],
  deal_data: ['parties_only'],
});
export function defaultDataLicences(): Record<MeshDataClass, SyndicationTerm> {
  return Object.fromEntries(MESH_DATA_CLASSES.map((c) => [c, DATA_LICENCE_RULES[c].default])) as Record<MeshDataClass, SyndicationTerm>;
}
/** The stricter of two published terms for a class (the agreed term of a peering agreement). */
export function stricterTerm(dataClass: MeshDataClass, a: SyndicationTerm, b: SyndicationTerm): SyndicationTerm {
  const allowed = DATA_LICENCE_RULES[dataClass].allowed;
  const ia = allowed.indexOf(a);
  const ib = allowed.indexOf(b);
  if (ia < 0 || ib < 0) throw new Error(`term not allowed for ${dataClass}`);
  return ia >= ib ? a : b;
}
export function agreedLicences(a: Record<MeshDataClass, SyndicationTerm>, b: Record<MeshDataClass, SyndicationTerm>): Record<MeshDataClass, SyndicationTerm> {
  return Object.fromEntries(MESH_DATA_CLASSES.map((c) => [c, stricterTerm(c, a[c], b[c])])) as Record<MeshDataClass, SyndicationTerm>;
}

/** Conditions attached to every licence; each is fixed or may only be tightened. */
export const MAX_TOMBSTONE_HOURS = 72;
export const LicenceConditionsSchema = z.strictObject({
  attributionVisible: z.literal(true),
  tombstoneHours: z.int().min(1).max(MAX_TOMBSTONE_HOURS),
  noResaleOfPersonalData: z.literal(true),
  noModelTrainingOutsideGovernedRetrieval: z.literal(true),
  neverPresentedAsLocal: z.literal(true),
});
export type LicenceConditions = z.infer<typeof LicenceConditionsSchema>;

/* ---------- Object kind rules ---------- */

export const FEED_STREAMS = ['publications', 'issues', 'events', 'directory', 'open_needs', 'reputation', 'certificates', 'tombstones'] as const;
export const FeedStreamSchema = z.enum(FEED_STREAMS);
export type FeedStream = z.infer<typeof FeedStreamSchema>;

/** Why an object about a person may travel at all. Nothing about a person crosses without one of these. */
export const CONSENT_BASES = ['profile_visibility_public', 'published_by_subject', 'credential_shared_by_subject', 'deal_participation'] as const;
export const ConsentBasisSchema = z.enum(CONSENT_BASES);
export type ConsentBasis = z.infer<typeof ConsentBasisSchema>;

export interface ObjectKindRule {
  readonly projection: FederatedProjection;
  readonly dataClasses: readonly MeshDataClass[];
  /** The pull stream for public kinds; `null` for kinds that travel only by addressed inbox delivery. */
  readonly stream: FeedStream | null;
  /** Consent bases accepted when the subject is a person. */
  readonly personConsent: readonly ConsentBasis[];
  /** The subject must be a person (`passport_credential`) or a company (`company_profile`), when set. */
  readonly subjectKind: 'person' | 'company' | null;
}
const pub = (dataClasses: MeshDataClass[], stream: FeedStream, personConsent: ConsentBasis[], subjectKind: 'person' | 'company' | null = null): ObjectKindRule =>
  ({ projection: 'public', dataClasses, stream, personConsent, subjectKind });
const deal = (): ObjectKindRule => ({ projection: 'shared_party', dataClasses: ['deal_data'], stream: null, personConsent: ['deal_participation'], subjectKind: null });

/**
 * Which projection, data classes, stream and consent each kind carries (step 3 of FED-000). Every kind carries exactly
 * one projection: public kinds are pulled from feeds and fetched by lookup, `shared_party` kinds are pushed only to the
 * home nodes of the parties. Reviews are not a kind: they never syndicate (a reviewer on another node submits a
 * `review_submission` through deal routing).
 */
export const OBJECT_KIND_RULES: Readonly<Record<FederatedObjectKind, ObjectKindRule>> = Object.freeze({
  publication: pub(['editorial_publications', 'member_publications', 'imported_items'], 'publications', ['published_by_subject']),
  magazine_issue: pub(['magazine_issues'], 'issues', []),
  event: pub(['events'], 'events', ['published_by_subject']),
  company_profile: pub(['directory_facts'], 'directory', [], 'company'),
  person_profile: pub(['person_profiles'], 'directory', ['profile_visibility_public'], 'person'),
  catalogue_item: pub(['directory_facts'], 'directory', []),
  project: pub(['open_needs'], 'open_needs', ['published_by_subject']),
  open_need: pub(['open_needs'], 'open_needs', ['published_by_subject']),
  reputation_snapshot: pub(['reputation_snapshots'], 'reputation', ['profile_visibility_public']),
  certificate: pub(['certificates'], 'certificates', ['profile_visibility_public', 'credential_shared_by_subject']),
  passport_credential: pub(['certificates'], 'certificates', ['credential_shared_by_subject'], 'person'),
  introduction: deal(),
  rfq_invitation: deal(),
  rfq_version: deal(),
  quote_version: deal(),
  agreement: deal(),
  agreement_event: deal(),
  agent_envelope: deal(),
  review_submission: deal(),
});
export function kindsOfStream(stream: FeedStream): FederatedObjectKind[] {
  return FEDERATED_OBJECT_KINDS.filter((kind) => OBJECT_KIND_RULES[kind].stream === stream);
}

/* ---------- Payload backstop ---------- */

/** Canonical payload limit (UTF-8 bytes of the JCS form). */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_PAYLOAD_DEPTH = 32;
/**
 * Keys that never appear anywhere in a federated payload: network addresses, credentials, budgets and private
 * commercial constraints, mandate internals, staff and screening material, private contact data. The module's own
 * public or shared serializer is the primary control; this scan is the protocol's backstop and runs on both sides.
 */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'ip', 'ipAddress', 'clientAddress', 'remoteAddress', 'forwardedFor', 'xForwardedFor', 'userAgent',
  'password', 'passwordHash', 'token', 'tokenHash', 'secret', 'privateKey', 'apiKey', 'sessionId', 'sessions', 'emailBindings', 'providerIdentities',
  'budget', 'budgetRange', 'budgetId', 'transactionBudgetId', 'platformBudgetId', 'privateConstraint', 'privateConstraints', 'constraintRecordId',
  'floorPrice', 'priceFloor', 'reservePrice', 'walkAwayPrice', 'negotiationNotes', 'internalNotes', 'staffNotes', 'caseNotes',
  'mandateIds', 'mandateBindings', 'approvers', 'approvalPolicy', 'perActionCeiling', 'privateDataClasses', 'connectionId',
  'screening', 'screeningResult', 'screeningMatches', 'sanctionsMatch', 'jurisdictionHold',
  'email', 'emailAddress', 'phone', 'phoneNumber', 'dateOfBirth', 'homeAddress', 'personalAddress',
] as const;
const FORBIDDEN_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_PAYLOAD_KEYS);
/** A nested marker naming a private layer refuses the payload: `{ "projection": "owner_private" }` cannot be smuggled. */
const MARKER_KEYS: ReadonlySet<string> = new Set(['projection', 'audience', 'classification', 'layer', 'visibility', 'profileVisibility']);
const PRIVATE_MARKERS: ReadonlySet<string> = new Set(['party_private', 'owner_private', 'staff_case', 'restricted', 'private']);

export interface PayloadProblem {
  readonly path: string;
  readonly reason: 'forbidden_key' | 'private_marker' | 'network_address' | 'too_deep' | 'too_large' | 'not_canonicalizable';
}
/** Every reason a payload may not cross a node boundary, with JSON paths. Empty means the backstop passes. */
export function payloadProblems(payload: unknown): PayloadProblem[] {
  const problems: PayloadProblem[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_PAYLOAD_DEPTH) {
      problems.push({ path, reason: 'too_deep' });
      return;
    }
    if (typeof value === 'string') {
      if (parseAddress(value.trim()) !== null) problems.push({ path, reason: 'network_address' });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const at = `${path}.${key}`;
        if (FORBIDDEN_KEY_SET.has(key)) problems.push({ path: at, reason: 'forbidden_key' });
        if (MARKER_KEYS.has(key) && typeof item === 'string' && PRIVATE_MARKERS.has(item)) problems.push({ path: at, reason: 'private_marker' });
        walk(item, at, depth + 1);
      }
    }
  };
  walk(payload, '$', 0);
  if (problems.some((p) => p.reason === 'too_deep')) return problems;
  try {
    if (utf8Encode(canonicalize(payload)).length > MAX_PAYLOAD_BYTES) problems.push({ path: '$', reason: 'too_large' });
  } catch {
    problems.push({ path: '$', reason: 'not_canonicalizable' });
  }
  return problems;
}
const JsonObjectSchema = z.record(z.string(), z.unknown());

/* ---------- Signatures ---------- */

export const SIGNATURE_ALGORITHM = 'ed25519' as const;
/** A key label, unique within the node's key chain (`k1`, `2026-11`, ...). Not secret, not an address. */
export const KeyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'key label');
const base64UrlBytes = (bytes: number) =>
  z.string().regex(/^[A-Za-z0-9_-]+$/, 'base64url without padding').refine((value) => fromBase64Url(value)?.length === bytes, { message: `${bytes} bytes, base64url without padding` });
/** Raw 32-byte Ed25519 public key (RFC 8032), base64url without padding. */
export const Ed25519PublicKeySchema = base64UrlBytes(32);
/** Raw 64-byte Ed25519 signature, base64url without padding. */
export const Ed25519SignatureValueSchema = base64UrlBytes(64);

/** Detached object signature carried in every signed protocol document. */
export const ObjectSignatureSchema = z.strictObject({ algorithm: z.literal(SIGNATURE_ALGORITHM), keyId: KeyIdSchema, value: Ed25519SignatureValueSchema });
export type ObjectSignature = z.infer<typeof ObjectSignatureSchema>;

/** What a signature binds; the purpose is part of the signed bytes, so a signature for one document type never verifies another. */
export const SIGNATURE_PURPOSES = ['manifest', 'envelope', 'tombstone', 'takedown_notice', 'key_rotation', 'link_proposal', 'link_decision', 'moderation_report'] as const;
export type SignaturePurpose = (typeof SIGNATURE_PURPOSES)[number];

/**
 * The exact bytes an object signature covers (normative, docs/engine/federation-protocol.md "Object signatures"):
 *
 *   UTF-8( "trustwork-mesh/1" LF <purpose> LF JCS(document with signature = { algorithm, keyId }) )
 *
 * The document is taken as it travels, with its `signature` member replaced by the algorithm and key label alone (no
 * value), so the key choice is signed too. JCS is RFC 8785 (`canonicalize`). There is no trailing newline.
 */
export function objectSigningInput(purpose: SignaturePurpose, document: Record<string, unknown>, key: { algorithm: typeof SIGNATURE_ALGORITHM; keyId: string }): Uint8Array {
  const unsigned = { ...document, signature: { algorithm: key.algorithm, keyId: key.keyId } };
  return utf8Encode(`${MESH_PROTOCOL}\n${purpose}\n${canonicalize(unsigned)}`);
}
/** Verifier port: Ed25519 verification of `message` under a raw public key. FED-001 supplies the crypto adapter. */
export type Ed25519Verify = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
/** Signer port: Ed25519 signature of `message` with the node key held in the secret store (FED-001). */
export type Ed25519Sign = (message: Uint8Array) => Uint8Array;

/** Signs a document: computes the signing input and attaches the detached signature. */
export function signDocument<T extends Record<string, unknown>>(purpose: SignaturePurpose, document: T, keyId: string, sign: Ed25519Sign): T & { signature: ObjectSignature } {
  const rest: Record<string, unknown> = { ...document };
  delete rest['signature'];
  const input = objectSigningInput(purpose, rest, { algorithm: SIGNATURE_ALGORITHM, keyId });
  return { ...(rest as T), signature: { algorithm: SIGNATURE_ALGORITHM, keyId, value: toBase64Url(sign(input)) } };
}
/** Verifies a document's detached signature against a raw public key (the key selection rules are `keyForSignature`). */
export function verifyDocumentSignature(purpose: SignaturePurpose, document: Record<string, unknown> & { signature: ObjectSignature }, publicKey: string, verify: Ed25519Verify): boolean {
  const parsed = ObjectSignatureSchema.safeParse(document.signature);
  const key = fromBase64Url(publicKey);
  if (!parsed.success || key === null || key.length !== 32) return false;
  const signature = fromBase64Url(parsed.data.value);
  if (signature === null) return false;
  const rest: Record<string, unknown> = { ...document };
  delete rest['signature'];
  return verify(key, objectSigningInput(purpose, rest, { algorithm: parsed.data.algorithm, keyId: parsed.data.keyId }), signature);
}

/* ---------- Key chain and rotation ---------- */

/** The statement the previous key signs when it hands over to the next one (purpose `key_rotation`). */
export const KeyRotationStatementSchema = z.strictObject({
  protocol: MeshProtocolSchema,
  statement: z.literal('key_rotation'),
  node: NodeHostSchema,
  previousKeyId: KeyIdSchema,
  nextKeyId: KeyIdSchema,
  nextPublicKey: Ed25519PublicKeySchema,
  rotatedAt: TimestampSchema,
});
export type KeyRotationStatement = z.infer<typeof KeyRotationStatementSchema>;

export const NodeKeySchema = z
  .strictObject({
    keyId: KeyIdSchema,
    algorithm: z.literal(SIGNATURE_ALGORITHM),
    publicKey: Ed25519PublicKeySchema,
    validFrom: TimestampSchema,
    /** When the next key took over; signatures created at or after this instant are refused. */
    retiredAt: TimestampSchema.nullable(),
    /** Set when the key leaked: signatures created at or after `compromisedSince` are refused, even before retirement. */
    revocation: z.strictObject({ compromisedSince: TimestampSchema, revokedAt: TimestampSchema }).nullable(),
    /** `null` for the first key of the node; otherwise the hand-over signed by the previous key. */
    rotation: z.strictObject({ previousKeyId: KeyIdSchema, signature: ObjectSignatureSchema }).nullable(),
  })
  .refine((k) => k.retiredAt === null || Date.parse(k.retiredAt) > Date.parse(k.validFrom), { message: 'a key retires after it became valid', path: ['retiredAt'] })
  .refine((k) => k.rotation === null || k.rotation.signature.keyId === k.rotation.previousKeyId, { message: 'a rotation is signed by the previous key', path: ['rotation'] });
export type NodeKey = z.infer<typeof NodeKeySchema>;

/** The rotation statement a key entry claims, rebuilt from the chain (the previous key signs this). */
export function rotationStatementFor(node: string, previous: NodeKey, next: NodeKey): KeyRotationStatement {
  return { protocol: MESH_PROTOCOL, statement: 'key_rotation', node, previousKeyId: previous.keyId, nextKeyId: next.keyId, nextPublicKey: next.publicKey, rotatedAt: next.validFrom };
}

export type KeyChainProblem =
  | 'empty' | 'duplicate_key_id' | 'genesis_has_rotation' | 'rotation_missing' | 'rotation_out_of_order' | 'handover_gap'
  | 'current_not_last' | 'current_retired' | 'rotation_signature_invalid';
/**
 * Structural rules of a key chain, oldest first: unique labels; the first key has no rotation; every later key names
 * its predecessor and starts exactly when the predecessor retires; the current key is the last one and not retired.
 * With a verifier, every hand-over signature is checked against the previous key.
 */
export function keyChainProblems(node: string, keys: readonly NodeKey[], current: string, verify?: Ed25519Verify): KeyChainProblem[] {
  const problems: KeyChainProblem[] = [];
  if (keys.length === 0) return ['empty'];
  if (new Set(keys.map((k) => k.keyId)).size !== keys.length) problems.push('duplicate_key_id');
  keys.forEach((key, i) => {
    if (i === 0) {
      if (key.rotation !== null) problems.push('genesis_has_rotation');
      return;
    }
    const previous = keys[i - 1]!;
    if (key.rotation === null) {
      problems.push('rotation_missing');
      return;
    }
    if (key.rotation.previousKeyId !== previous.keyId) problems.push('rotation_out_of_order');
    if (previous.retiredAt !== key.validFrom) problems.push('handover_gap');
    if (verify && key.rotation.previousKeyId === previous.keyId) {
      const statement = rotationStatementFor(node, previous, key);
      if (!verifyDocumentSignature('key_rotation', { ...statement, signature: key.rotation.signature }, previous.publicKey, verify)) problems.push('rotation_signature_invalid');
    }
  });
  const last = keys[keys.length - 1]!;
  if (last.keyId !== current) problems.push('current_not_last');
  if (last.retiredAt !== null) problems.push('current_retired');
  return [...new Set(problems)];
}

export type KeySelection = { readonly ok: true; readonly key: NodeKey } | { readonly ok: false; readonly code: 'federation.key_unknown' | 'federation.key_revoked' };
/**
 * The key that may have made a signature labelled `keyId` at `createdAt`: known, already valid, not yet retired and
 * not compromised at that instant. Signatures made by a retired key before its retirement stay valid (replicas keep
 * verifying); a compromised key's signatures from `compromisedSince` on are refused.
 */
export function keyForSignature(keys: readonly NodeKey[], keyId: string, createdAt: string): KeySelection {
  const key = keys.find((k) => k.keyId === keyId);
  const at = Date.parse(createdAt);
  if (!key || !Number.isFinite(at)) return { ok: false, code: 'federation.key_unknown' };
  if (at < Date.parse(key.validFrom)) return { ok: false, code: 'federation.key_unknown' };
  if (key.revocation !== null && at >= Date.parse(key.revocation.compromisedSince)) return { ok: false, code: 'federation.key_revoked' };
  if (key.retiredAt !== null && at >= Date.parse(key.retiredAt)) return { ok: false, code: 'federation.key_revoked' };
  return { ok: true, key };
}

/* ---------- Manifest ---------- */

export const PEERING_LEVELS = ['syndicate', 'trust_verifications', 'deal_routing', 'identity'] as const;
export const PeeringLevelSchema = z.enum(PEERING_LEVELS);
export type PeeringLevel = z.infer<typeof PeeringLevelSchema>;
/** Raising a peering to these levels needs a second approver (MSH-F04). */
export const SECOND_APPROVER_LEVELS: readonly PeeringLevel[] = ['deal_routing', 'identity'];

/** A hub territory: a country (`US`), a subdivision (`US-TX`) or a city inside one (`US-TX:austin`). */
export const TerritorySchema = z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?(?::[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)?$/, 'ISO 3166 code, optionally :city');
export function territoryPlace(territory: string): string {
  return territory.split(':', 1)[0]!;
}

const ContactSchema = z.string().max(320).regex(/^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, 'mailto: or https: contact of a role, not a person');
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

const manifestShape = {
  protocol: z.array(z.string().regex(/^trustwork-mesh\/\d+$/)).min(1).max(8).refine((v) => v.includes(MESH_PROTOCOL), { message: `must offer ${MESH_PROTOCOL}` }),
  node: NodeHostSchema,
  engine: z.strictObject({ version: SemverSchema, source: z.string().max(300).regex(/^https:\/\/\S+$/) }),
  operator: z.strictObject({
    name: z.string().overwrite(nfc).trim().min(1).max(200),
    /** The country of the operator's legal entity (the admission check reads it as `operator.country`). */
    country: z.string().regex(/^[A-Z]{2}$/),
    registration: z.strictObject({ kind: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), value: z.string().trim().min(1).max(64) }).nullable(),
    abuseContact: ContactSchema,
    takedownContact: ContactSchema,
  }),
  /** Where the operator answers legally: a country or a subdivision. */
  jurisdiction: RestrictedPlaceCodeSchema,
  hubs: z
    .array(z.strictObject({ id: IdSchema, territories: z.array(TerritorySchema).min(1).max(500), languages: z.array(LocaleTagSchema).min(1).max(20) }))
    .min(1)
    .max(200),
  packs: z.array(z.strictObject({ country: z.string().regex(/^[A-Z]{2}$/), version: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/) })).max(300),
  licences: z.strictObject(Object.fromEntries(MESH_DATA_CLASSES.map((c) => [c, SyndicationTermSchema])) as Record<MeshDataClass, typeof SyndicationTermSchema>),
  licenceConditions: LicenceConditionsSchema,
  peeringPolicy: z.strictObject({
    offered: z.array(PeeringLevelSchema).min(1).max(4),
    secondApproverFor: z.tuple([z.literal('deal_routing'), z.literal('identity')]),
    /** Agent envelopes accepted per peer and hour at `deal_routing` (MSH-F12). */
    agentEnvelopesPerHour: z.int().min(0).max(10_000),
  }),
  keys: z.strictObject({ current: KeyIdSchema, chain: z.array(NodeKeySchema).min(1).max(100) }),
  /** The operator's published deployment-location attestation summary (SANC-009): evidence, never a verification. */
  deploymentAttestation: DeploymentLocationAttestationSummarySchema,
  issuedAt: TimestampSchema,
  signature: ObjectSignatureSchema,
};

/** Every restricted place a manifest declares, with the field that declares it (empty when admissible). */
export interface ManifestRestriction {
  readonly path: string;
  readonly place: string;
  readonly reason: 'restricted' | 'region_required';
}
export function manifestRestrictions(
  manifest: { jurisdiction: string; operator: { country: string }; hubs: readonly { territories: readonly string[] }[]; packs: readonly { country: string }[]; deploymentAttestation: DeploymentLocationAttestationSummary },
  restricted: RestrictedPlaces,
): ManifestRestriction[] {
  const out: ManifestRestriction[] = [];
  const check = (path: string, code: string) => {
    const place = coveringRestrictedPlace(code, restricted);
    if (place !== null) out.push({ path, place, reason: 'restricted' });
  };
  check('jurisdiction', manifest.jurisdiction);
  check('operator.country', manifest.operator.country);
  manifest.hubs.forEach((hub, h) => hub.territories.forEach((territory, t) => check(`hubs[${h}].territories[${t}]`, territoryPlace(territory))));
  manifest.packs.forEach((pack, p) => check(`packs[${p}].country`, pack.country));
  const fieldPath = { operator_entity_country: 'operatorEntityCountry', operator_entity_region: 'operatorEntityRegion', hosting_country: 'hostingCountry', hosting_region: 'hostingRegion' } as const;
  for (const refusal of deploymentLocationRefusals(manifest.deploymentAttestation, restricted)) {
    out.push({ path: `deploymentAttestation.${fieldPath[refusal.field]}`, place: coveringRestrictedPlace(refusal.place, restricted) ?? refusal.place, reason: refusal.reason });
  }
  return out;
}

/**
 * The signed node manifest served at `/.well-known/trustwork/manifest.json` (ADR 011 decision 2). The schema needs the
 * authoritative restricted list (`restrictedPlaces(...)` over `@trustwork/country-packs` `restricted.json`): a manifest
 * that declares a restricted place anywhere is refused here, before any signature or admission work (ADR 011
 * decision 12). There is deliberately no list-free manifest schema to validate with.
 */
export function nodeManifestSchema(restricted: RestrictedPlaces) {
  return z
    .strictObject(manifestShape)
    .superRefine((m, ctx) => {
      for (const r of manifestRestrictions(m, restricted)) {
        ctx.addIssue({ code: 'custom', path: r.path.split(/[.[\]]/).filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s)), message: r.reason === 'restricted' ? `restricted place ${r.place} cannot join the mesh` : `a location in ${r.place} must be stated with its region` });
      }
      for (const c of MESH_DATA_CLASSES) {
        if (!DATA_LICENCE_RULES[c].allowed.includes(m.licences[c])) ctx.addIssue({ code: 'custom', path: ['licences', c], message: 'a node may only publish the default or a stricter licence' });
      }
      if (new Set(m.hubs.map((h) => h.id)).size !== m.hubs.length) ctx.addIssue({ code: 'custom', path: ['hubs'], message: 'hub ids are unique' });
      if (new Set(m.peeringPolicy.offered).size !== m.peeringPolicy.offered.length) ctx.addIssue({ code: 'custom', path: ['peeringPolicy', 'offered'], message: 'levels are unique' });
      for (const p of keyChainProblems(m.node, m.keys.chain, m.keys.current)) ctx.addIssue({ code: 'custom', path: ['keys'], message: `key chain: ${p}` });
      if (m.signature.keyId !== m.keys.current) ctx.addIssue({ code: 'custom', path: ['signature', 'keyId'], message: 'the manifest is signed with the current key' });
    });
}
export type NodeManifest = z.infer<ReturnType<typeof nodeManifestSchema>>;

/** Verifies a parsed manifest's own signature and every rotation in its key chain. */
export function verifyManifestSignatures(manifest: NodeManifest, verify: Ed25519Verify): boolean {
  const current = manifest.keys.chain.find((k) => k.keyId === manifest.keys.current);
  if (!current) return false;
  if (keyChainProblems(manifest.node, manifest.keys.chain, manifest.keys.current, verify).length > 0) return false;
  const selected = keyForSignature(manifest.keys.chain, manifest.signature.keyId, manifest.issuedAt);
  return selected.ok && verifyDocumentSignature('manifest', manifest, selected.key.publicKey, verify);
}

/* ---------- Envelopes ---------- */

export const EnvelopeAudienceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('public') }),
  z.strictObject({
    kind: z.literal('parties'),
    /** The parties of the deal, by global identifier; only their home nodes may receive the envelope. */
    parties: z.array(PartyGlobalIdSchema).min(2).max(20),
    /** The home nodes of those parties (derived from the identifiers), the only valid recipients. */
    nodes: z.array(NodeHostSchema).min(1).max(20),
  }),
]);
export type EnvelopeAudience = z.infer<typeof EnvelopeAudienceSchema>;

export const EnvelopeConsentSchema = z.strictObject({
  basis: ConsentBasisSchema,
  /** When the home node recorded the basis (visibility choice, publication, credential share or deal participation); the record stays home. */
  recordedAt: TimestampSchema,
});

const envelopeShape = {
  protocol: MeshProtocolSchema,
  id: GlobalIdSchema,
  kind: FederatedObjectKindSchema,
  revision: z.int().min(1),
  homeNode: NodeHostSchema,
  projection: FederatedProjectionSchema,
  dataClass: MeshDataClassSchema,
  syndication: SyndicationTermSchema,
  audience: EnvelopeAudienceSchema,
  /** The person or company the object is about, if any; drives consent and entity links. */
  subject: PartyGlobalIdSchema.nullable(),
  consent: EnvelopeConsentSchema.nullable(),
  /** True when an agent produced the content; the receiving node and its agent treat it as untrusted text either way. */
  agentGenerated: z.boolean(),
  /** The home node's public or shared projection, exactly as its serializer produced it. */
  payload: JsonObjectSchema,
  /** `trustwork-digest-1` over the JCS bytes of `payload`. */
  digest: DigestSchema,
  issuedAt: TimestampSchema,
  signature: ObjectSignatureSchema,
};

/**
 * A signed envelope (ADR 011 decision 4). Refused when the projection is private, when the kind does not carry that
 * projection, data class or stream, when the syndication term is `none` or not allowed for the class, when the
 * audience does not fit the projection, when a person subject has no allowed consent basis, or when the payload fails
 * the backstop scan.
 */
export const FederatedEnvelopeSchema = z.strictObject(envelopeShape).superRefine((e, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const rule = OBJECT_KIND_RULES[e.kind];
  const id = parseGlobalId(e.id);
  if (id && id.kind !== e.kind) issue(['id'], 'the identifier names the envelope kind');
  if (id && id.host !== e.homeNode) issue(['homeNode'], 'the home node is the host of the identifier (one writer per object)');
  if (e.projection !== rule.projection) issue(['projection'], `${e.kind} travels only in the ${rule.projection} projection`);
  if (!rule.dataClasses.includes(e.dataClass)) issue(['dataClass'], `${e.kind} carries ${rule.dataClasses.join(', ')}`);
  if (e.syndication === 'none') issue(['syndication'], 'an item marked syndication none never leaves its node');
  else if (!ITEM_SYNDICATION_TERMS[e.dataClass].includes(e.syndication)) issue(['syndication'], `term not allowed for ${e.dataClass}`);
  if (e.projection === 'public' && e.audience.kind !== 'public') issue(['audience'], 'a public envelope has the public audience');
  if (e.projection === 'shared_party') {
    const audience = e.audience;
    if (audience.kind !== 'parties') issue(['audience'], 'a shared_party envelope names its parties');
    else {
      const homes = new Set(audience.parties.map(hostOf));
      if (new Set(audience.parties).size !== audience.parties.length) issue(['audience', 'parties'], 'parties are unique');
      if (new Set(audience.nodes).size !== audience.nodes.length || audience.nodes.some((n) => !homes.has(n)) || [...homes].some((h) => h === null || !audience.nodes.includes(h))) {
        issue(['audience', 'nodes'], 'nodes are exactly the home nodes of the parties');
      }
      if (!audience.nodes.includes(e.homeNode)) issue(['audience', 'nodes'], 'the home node is one of the parties\' nodes');
      if (e.subject !== null && !audience.parties.includes(e.subject)) issue(['subject'], 'the subject of a deal object is one of its parties');
    }
  }
  const subjectKind = e.subject === null ? null : kindOf(e.subject);
  if (rule.subjectKind !== null && subjectKind !== rule.subjectKind) issue(['subject'], `${e.kind} is about a ${rule.subjectKind}`);
  if (subjectKind === 'person') {
    if (e.consent === null) issue(['consent'], 'an object about a person travels only with a consent basis');
    else if (!rule.personConsent.includes(e.consent.basis)) issue(['consent', 'basis'], `${e.kind} accepts ${rule.personConsent.join(', ') || 'no person subject'}`);
  }
  if (e.kind === 'agent_envelope' && !e.agentGenerated) issue(['agentGenerated'], 'an agent envelope is labelled agent-generated');
  for (const p of payloadProblems(e.payload)) issue(['payload'], `${p.reason} at ${p.path}`);
});
export type FederatedEnvelope = z.infer<typeof FederatedEnvelopeSchema>;

/** The digest input of an envelope: the payload itself (`trustwork-digest-1` = SHA-256 of `JCS(payload)`). */
export function envelopeDigestInput(envelope: { payload: Record<string, unknown> }): Record<string, unknown> {
  return envelope.payload;
}

/* ---------- Tombstones and takedowns ---------- */

export const TOMBSTONE_REASONS = ['deleted', 'unpublished', 'erased', 'retracted', 'takedown', 'licence_ended'] as const;
export const TombstoneReasonSchema = z.enum(TOMBSTONE_REASONS);
export type TombstoneReason = z.infer<typeof TombstoneReasonSchema>;
/** Reasons after which the object never comes back under the same identifier. */
export const TERMINAL_TOMBSTONE_REASONS: readonly TombstoneReason[] = ['erased', 'takedown'];
/** What a receiving node must purge; all four, always. */
export const TOMBSTONE_PURGE_TARGETS = ['replica', 'search_index', 'cache', 'saved_answers'] as const;

/** A signed tombstone (MSH-F14): metadata only, no content. Peers apply it before `applyBy`. */
export const FederationTombstoneSchema = z
  .strictObject({
    protocol: MeshProtocolSchema,
    id: GlobalIdSchema,
    target: GlobalIdSchema,
    targetKind: FederatedObjectKindSchema,
    homeNode: NodeHostSchema,
    /** The last revision the tombstone covers; replicas at or below it are removed. */
    revision: z.int().min(1),
    reason: TombstoneReasonSchema,
    purge: z.tuple([z.literal('replica'), z.literal('search_index'), z.literal('cache'), z.literal('saved_answers')]),
    issuedAt: TimestampSchema,
    applyBy: TimestampSchema,
    signature: ObjectSignatureSchema,
  })
  .superRefine((t, ctx) => {
    if (kindOf(t.id) !== 'tombstone') ctx.addIssue({ code: 'custom', path: ['id'], message: 'a tombstone has a tombstone identifier' });
    if (hostOf(t.id) !== t.homeNode || hostOf(t.target) !== t.homeNode) ctx.addIssue({ code: 'custom', path: ['homeNode'], message: 'only the home node tombstones its objects' });
    if (kindOf(t.target) !== t.targetKind) ctx.addIssue({ code: 'custom', path: ['targetKind'], message: 'the target identifier names the target kind' });
    const window = Date.parse(t.applyBy) - Date.parse(t.issuedAt);
    if (!(window > 0 && window <= MAX_TOMBSTONE_HOURS * 3_600_000)) ctx.addIssue({ code: 'custom', path: ['applyBy'], message: `applied within ${MAX_TOMBSTONE_HOURS} hours of issue` });
  });
export type FederationTombstone = z.infer<typeof FederationTombstoneSchema>;

export const TAKEDOWN_REASONS = ['legal_demand', 'licence_ended', 'rights_holder_request', 'court_order', 'privacy_request'] as const;
/** A takedown notice pushed to peers' inboxes: the reason category, never the requester's identity or private evidence. */
export const TakedownNoticeSchema = z
  .strictObject({
    protocol: MeshProtocolSchema,
    id: GlobalIdSchema,
    target: GlobalIdSchema,
    homeNode: NodeHostSchema,
    reason: z.enum(TAKEDOWN_REASONS),
    /** Public reference to the legal basis category (for example `us.dmca.512c`), no personal data. */
    legalBasis: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/).nullable(),
    issuedAt: TimestampSchema,
    signature: ObjectSignatureSchema,
  })
  .superRefine((t, ctx) => {
    if (kindOf(t.id) !== 'takedown_notice') ctx.addIssue({ code: 'custom', path: ['id'], message: 'a takedown notice has a takedown_notice identifier' });
    if (hostOf(t.id) !== t.homeNode) ctx.addIssue({ code: 'custom', path: ['homeNode'], message: 'the notice comes from its issuing node' });
  });
export type TakedownNotice = z.infer<typeof TakedownNoticeSchema>;

/** A moderation report forwarded to the home node's moderators: the target and the clause, never the reporter. */
export const ForwardedReportSchema = z
  .strictObject({
    protocol: MeshProtocolSchema,
    id: GlobalIdSchema,
    target: GlobalIdSchema,
    fromNode: NodeHostSchema,
    clauseCode: z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/),
    issuedAt: TimestampSchema,
    signature: ObjectSignatureSchema,
  })
  .superRefine((r, ctx) => {
    if (kindOf(r.id) !== 'moderation_report' || hostOf(r.id) !== r.fromNode) ctx.addIssue({ code: 'custom', path: ['id'], message: 'a forwarded report is a moderation_report of the sending node' });
    if (hostOf(r.target) === r.fromNode) ctx.addIssue({ code: 'custom', path: ['target'], message: 'a report is forwarded to the target\'s home node' });
  });

/* ---------- Entity links ---------- */

export const MeshLinkProposalSchema = z
  .strictObject({
    protocol: MeshProtocolSchema,
    id: GlobalIdSchema,
    fromNode: NodeHostSchema,
    /** The proposer's own record. */
    local: PartyGlobalIdSchema,
    /** The other node's record about the same subject. */
    remote: PartyGlobalIdSchema,
    evidence: z.discriminatedUnion('kind', [
      /** Same registration identifier kind and value from the same country pack. Companies only. */
      z.strictObject({ kind: z.literal('identifier_match'), country: z.string().regex(/^[A-Z]{2}$/), identifierKind: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), value: z.string().trim().min(1).max(64) }),
      /** A statement signed by an administrator of both records (digest of the statement held on both nodes). Companies only. */
      z.strictObject({ kind: z.literal('admin_signed_statement'), statementDigest: DigestSchema }),
      /** The person signed in on both nodes and confirmed. People only; never inferred from an e-mail address. */
      z.strictObject({ kind: z.literal('person_confirmed'), confirmedLocalAt: TimestampSchema, confirmedRemoteAt: TimestampSchema }),
    ]),
    proposedAt: TimestampSchema,
    signature: ObjectSignatureSchema,
  })
  .superRefine((l, ctx) => {
    const issue = (path: string[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (kindOf(l.id) !== 'link_proposal' || hostOf(l.id) !== l.fromNode) issue(['id'], 'a link proposal is a link_proposal of the proposing node');
    if (hostOf(l.local) !== l.fromNode) issue(['local'], 'the local record belongs to the proposing node');
    if (hostOf(l.remote) === l.fromNode) issue(['remote'], 'a link connects records on two nodes');
    if (kindOf(l.local) !== kindOf(l.remote)) issue(['remote'], 'a link connects records of the same kind');
    const person = kindOf(l.local) === 'person';
    if (person && l.evidence.kind !== 'person_confirmed') issue(['evidence'], 'a person is linked only by their own confirmation on both nodes');
    if (!person && l.evidence.kind === 'person_confirmed') issue(['evidence'], 'a company is linked by an identifier match or a signed statement');
  });
export type MeshLinkProposal = z.infer<typeof MeshLinkProposalSchema>;
/** The steward's answer. A link is never a merge: there is no merge decision and the steward stays anonymous to peers. */
export const MeshLinkDecisionSchema = z.strictObject({
  protocol: MeshProtocolSchema,
  proposal: GlobalIdSchema,
  fromNode: NodeHostSchema,
  decision: z.enum(['accepted', 'rejected', 'withdrawn']),
  decidedAt: TimestampSchema,
  signature: ObjectSignatureSchema,
}).refine((d) => kindOf(d.proposal) === 'link_proposal', { message: 'answers a link proposal', path: ['proposal'] });
export type MeshLinkDecision = z.infer<typeof MeshLinkDecisionSchema>;

/* ---------- Feeds ---------- */

export const FeedCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/, 'opaque cursor');
export const FEED_PAGE_MAX_ITEMS = 200;
export const FeedItemSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('envelope'), envelope: FederatedEnvelopeSchema }),
  z.strictObject({ type: z.literal('tombstone'), tombstone: FederationTombstoneSchema }),
]);
export type FeedItem = z.infer<typeof FeedItemSchema>;
/**
 * `GET /federation/v1/feeds/<stream>?after=<cursor>`: a page of the home node's own public objects. Feeds carry only
 * public envelopes of the stream's kinds and tombstones, all homed on the serving node (no re-serving of replicas).
 */
export const FeedPageSchema = z
  .strictObject({
    protocol: MeshProtocolSchema,
    node: NodeHostSchema,
    stream: FeedStreamSchema,
    after: FeedCursorSchema.nullable(),
    items: z.array(FeedItemSchema).max(FEED_PAGE_MAX_ITEMS),
    next: FeedCursorSchema.nullable(),
    generatedAt: TimestampSchema,
  })
  .superRefine((page, ctx) => {
    const kinds = kindsOfStream(page.stream);
    page.items.forEach((item, i) => {
      const home = item.type === 'envelope' ? item.envelope.homeNode : item.tombstone.homeNode;
      if (home !== page.node) ctx.addIssue({ code: 'custom', path: ['items', i], message: 'a feed serves only objects homed on its node' });
      if (item.type === 'envelope') {
        if (item.envelope.projection !== 'public') ctx.addIssue({ code: 'custom', path: ['items', i, 'envelope', 'projection'], message: 'feeds carry only public envelopes' });
        if (page.stream === 'tombstones' || !kinds.includes(item.envelope.kind)) ctx.addIssue({ code: 'custom', path: ['items', i, 'envelope', 'kind'], message: `not a ${page.stream} kind` });
      } else if (page.stream !== 'tombstones' && !kinds.includes(item.tombstone.targetKind)) {
        ctx.addIssue({ code: 'custom', path: ['items', i, 'tombstone', 'targetKind'], message: `not a ${page.stream} kind` });
      } else if (OBJECT_KIND_RULES[item.tombstone.targetKind].stream === null) {
        ctx.addIssue({ code: 'custom', path: ['items', i, 'tombstone', 'targetKind'], message: 'tombstones of deal objects go to the parties\' inboxes' });
      }
    });
  });
export type FeedPage = z.infer<typeof FeedPageSchema>;

/* ---------- Inbox ---------- */

export const InboxItemSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('envelope'), envelope: FederatedEnvelopeSchema }),
  z.strictObject({ type: z.literal('tombstone'), tombstone: FederationTombstoneSchema }),
  z.strictObject({ type: z.literal('takedown_notice'), notice: TakedownNoticeSchema }),
  z.strictObject({ type: z.literal('moderation_report'), report: ForwardedReportSchema }),
  z.strictObject({ type: z.literal('link_proposal'), proposal: MeshLinkProposalSchema }),
  z.strictObject({ type: z.literal('link_decision'), decision: MeshLinkDecisionSchema }),
]);
export type InboxItem = z.infer<typeof InboxItemSchema>;

const inboxItemOrigin = (item: InboxItem): string | null => {
  switch (item.type) {
    case 'envelope': return item.envelope.homeNode;
    case 'tombstone': return item.tombstone.homeNode;
    case 'takedown_notice': return item.notice.homeNode;
    case 'moderation_report': return item.report.fromNode;
    case 'link_proposal': return item.proposal.fromNode;
    case 'link_decision': return item.decision.fromNode;
  }
};

/**
 * `POST /federation/v1/inbox`: one addressed delivery. `(senderNode, deliveryId)` is unique at the receiver
 * (idempotent processing). The sender is the origin of the item: there is no transit through a third node. A
 * `shared_party` envelope goes only to a node of its audience, and only shared_party envelopes are pushed.
 */
export const InboxDeliverySchema = z
  .strictObject({
    protocol: MeshProtocolSchema,
    deliveryId: IdSchema,
    senderNode: NodeHostSchema,
    recipientNode: NodeHostSchema,
    sentAt: TimestampSchema,
    item: InboxItemSchema,
  })
  .superRefine((d, ctx) => {
    if (d.senderNode === d.recipientNode) ctx.addIssue({ code: 'custom', path: ['recipientNode'], message: 'a node does not deliver to itself' });
    if (inboxItemOrigin(d.item) !== d.senderNode) ctx.addIssue({ code: 'custom', path: ['senderNode'], message: 'no transit: the sender is the origin of the item' });
    if (d.item.type === 'envelope') {
      const e = d.item.envelope;
      if (e.projection !== 'shared_party') ctx.addIssue({ code: 'custom', path: ['item', 'envelope', 'projection'], message: 'public objects are pulled from feeds, not pushed' });
      else if (e.audience.kind === 'parties' && !e.audience.nodes.includes(d.recipientNode)) ctx.addIssue({ code: 'custom', path: ['recipientNode'], message: 'delivered only to a home node of a party' });
    }
    if (d.item.type === 'moderation_report' && hostOf(d.item.report.target) !== d.recipientNode) ctx.addIssue({ code: 'custom', path: ['recipientNode'], message: 'a report goes to the target\'s home node' });
    if (d.item.type === 'link_proposal' && hostOf(d.item.proposal.remote) !== d.recipientNode) ctx.addIssue({ code: 'custom', path: ['recipientNode'], message: 'a link proposal goes to the remote record\'s node' });
  });
export type InboxDelivery = z.infer<typeof InboxDeliverySchema>;

export const InboxReceiptSchema = z.strictObject({
  protocol: MeshProtocolSchema,
  deliveryId: IdSchema,
  /** `accepted` the first time, `duplicate` for the same delivery again (same digest), `rejected` with a code. */
  state: z.enum(['accepted', 'duplicate', 'rejected']),
  code: FederationErrorCodeSchema.nullable(),
  receivedAt: TimestampSchema,
}).refine((r) => (r.state === 'rejected') === (r.code !== null), { message: 'a code exactly when rejected', path: ['code'] });
export type InboxReceipt = z.infer<typeof InboxReceiptSchema>;

/**
 * Idempotent inbox processing for one `(senderNode, deliveryId)`: the first delivery is accepted, a repeat with the
 * same body digest is a duplicate (answered with the stored receipt, no second effect), a repeat with a different body
 * is refused as `federation.delivery_conflict`. The receiver stores the body digest under a unique constraint, so
 * concurrent repeats resolve to exactly one acceptance.
 */
export function inboxDeliveryDecision(existingBodyDigest: string | null, incomingBodyDigest: string): { state: 'accepted' | 'duplicate' } | { state: 'rejected'; code: 'federation.delivery_conflict' } {
  if (existingBodyDigest === null) return { state: 'accepted' };
  return existingBodyDigest === incomingBodyDigest ? { state: 'duplicate' } : { state: 'rejected', code: 'federation.delivery_conflict' };
}

/* ---------- Handshake and peering ---------- */

const NonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22,86}$/, 'base64url nonce of 16 to 64 bytes');

/**
 * `POST /federation/v1/handshake` (RFC 9421-signed with the initiator's current key). Carries everything the receiving
 * node's admission check (SANC-008 `admitPeerAtHandshake`) needs that the initiator can state: the signed manifest
 * (jurisdiction, operator country, hub territories) and, inside it, the published deployment-location attestation
 * summary. The observed place comes from the receiver's own door and is never part of the request or of any record.
 */
export function handshakeRequestSchema(restricted: RestrictedPlaces) {
  return z
    .strictObject({
      protocol: MeshProtocolSchema,
      from: NodeHostSchema,
      to: NodeHostSchema,
      manifest: nodeManifestSchema(restricted),
      requestedLevel: PeeringLevelSchema,
      hubs: z.strictObject({ initiator: IdSchema, responder: IdSchema }),
      nonce: NonceSchema,
      issuedAt: TimestampSchema,
    })
    .superRefine((h, ctx) => {
      if (h.from === h.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'a node does not peer with itself' });
      if (h.manifest.node !== h.from) ctx.addIssue({ code: 'custom', path: ['manifest', 'node'], message: 'the manifest is the initiator\'s own' });
      if (!h.manifest.hubs.some((hub) => hub.id === h.hubs.initiator)) ctx.addIssue({ code: 'custom', path: ['hubs', 'initiator'], message: 'the initiating hub is in the manifest' });
      if (!h.manifest.peeringPolicy.offered.includes(h.requestedLevel)) ctx.addIssue({ code: 'custom', path: ['requestedLevel'], message: 'a node requests only a level it offers itself' });
    });
}
export type HandshakeRequest = z.infer<ReturnType<typeof handshakeRequestSchema>>;

/**
 * The peer as the admission check reads it: the manifest and its attestation summary. The caller adds `observed`
 * (the connection as its own door sees it) and calls `admitPeerAtHandshake` from `packages/compliance`.
 */
export function handshakeAdmissionPeer(request: HandshakeRequest): { manifest: NodeManifest; attestation: DeploymentLocationAttestationSummary } {
  return { manifest: request.manifest, attestation: request.manifest.deploymentAttestation };
}

export const HandshakeResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    protocol: MeshProtocolSchema,
    outcome: z.literal('admitted'),
    from: NodeHostSchema,
    to: NodeHostSchema,
    /** The responder's manifest digest; the initiator fetches and validates the manifest itself. */
    manifestDigest: DigestSchema,
    /** At most the requested level; above `syndicate` only after the responder's second approver (then `pending_approval`). */
    level: PeeringLevelSchema,
    state: z.enum(['active', 'pending_approval']),
    nonce: NonceSchema,
    issuedAt: TimestampSchema,
  }),
  z.strictObject({
    protocol: MeshProtocolSchema,
    outcome: z.literal('refused'),
    from: NodeHostSchema,
    to: NodeHostSchema,
    /** `federation.peer_restricted` (451) when the admission check refused; no findings, places or addresses are echoed. */
    code: FederationErrorCodeSchema,
    nonce: NonceSchema,
    issuedAt: TimestampSchema,
  }),
]);
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

/** Order of levels: each includes the rights of the ones before it. */
export function peeringLevelAtLeast(level: PeeringLevel, required: PeeringLevel): boolean {
  return PEERING_LEVELS.indexOf(level) >= PEERING_LEVELS.indexOf(required);
}
/** The level a delivery needs: public pulls `syndicate`, badges `trust_verifications`, deal objects `deal_routing`. */
export function requiredPeeringLevel(item: InboxItem | { type: 'feed' } | { type: 'badge' } | { type: 'sign_in' }): PeeringLevel {
  switch (item.type) {
    case 'feed': return 'syndicate';
    case 'badge': return 'trust_verifications';
    case 'sign_in': return 'identity';
    case 'envelope': return 'deal_routing';
    default: return 'syndicate';
  }
}

/**
 * The peering agreement as each side records it (ADR 011 decision 6). No address, no screening detail, no person data
 * beyond the local staff identifiers that approved it (they never leave the node). The admission outcome is stored by
 * reference to the SANC-008 decision, not as evidence.
 */
export const PeeringRecordSchema = z
  .strictObject({
    id: IdSchema,
    localNode: NodeHostSchema,
    localHubId: IdSchema,
    peerNode: NodeHostSchema,
    peerHubId: IdSchema,
    level: PeeringLevelSchema,
    state: z.enum(['pending_approval', 'active', 'ended']),
    licences: z.strictObject(Object.fromEntries(MESH_DATA_CLASSES.map((c) => [c, SyndicationTermSchema])) as Record<MeshDataClass, typeof SyndicationTermSchema>),
    tombstoneHours: z.int().min(1).max(MAX_TOMBSTONE_HOURS),
    agentEnvelopesPerHour: z.int().min(0).max(10_000),
    peerManifestDigest: DigestSchema,
    peerKeyId: KeyIdSchema,
    admission: z.strictObject({ outcome: z.literal('admitted'), decidedAt: TimestampSchema, judged: z.tuple([z.literal('declared'), z.literal('attested'), z.literal('observed')]) }),
    requestedBy: IdSchema,
    secondApproverId: IdSchema.nullable(),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema.nullable(),
    revision: z.int().min(1),
  })
  .superRefine((p, ctx) => {
    const issue = (path: string[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (p.localNode === p.peerNode) issue(['peerNode'], 'a node does not peer with itself');
    const needsSecond = SECOND_APPROVER_LEVELS.includes(p.level);
    if (needsSecond && p.state === 'active' && p.secondApproverId === null) issue(['secondApproverId'], 'deal_routing and identity need a second approver');
    if (p.secondApproverId !== null && p.secondApproverId === p.requestedBy) issue(['secondApproverId'], 'the second approver is another person');
    if ((p.state === 'ended') !== (p.endedAt !== null)) issue(['endedAt'], 'endedAt is set exactly when ended');
    for (const c of MESH_DATA_CLASSES) if (!DATA_LICENCE_RULES[c].allowed.includes(p.licences[c])) issue(['licences', c], 'agreed terms come from the allowed terms');
  });
export type PeeringRecord = z.infer<typeof PeeringRecordSchema>;

/* ---------- HTTP message signatures (RFC 9421) and content digests (RFC 9530) ---------- */

/** Every mesh request and response is signed under this label with these parameters. */
export const HTTP_SIGNATURE_LABEL = 'tw' as const;
export const HTTP_SIGNATURE_MAX_AGE_SECONDS = 300;
export const HTTP_SIGNATURE_CLOCK_SKEW_SECONDS = 60;
/** Covered components: requests with a body, requests without one, and responses. */
export const HTTP_COVERED_COMPONENTS = {
  requestWithBody: ['@method', '@target-uri', 'content-digest', 'content-type'],
  requestWithoutBody: ['@method', '@target-uri'],
  response: ['@status', 'content-digest', 'content-type'],
} as const;

export interface HttpSignatureParams {
  readonly created: number;
  readonly expires: number;
  readonly keyid: string;
  readonly nonce: string | null;
}
function standardBase64(bytes: Uint8Array): string {
  const url = toBase64Url(bytes).replace(/-/g, '+').replace(/_/g, '/');
  return url + '='.repeat((4 - (url.length % 4)) % 4);
}
function fromStandardBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  return fromBase64Url(text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'));
}
/** `Content-Digest` field value for a SHA-256 of the body (RFC 9530): `sha-256=:<base64>:`. */
export function contentDigestField(sha256: Uint8Array): string {
  if (sha256.length !== 32) throw new Error('sha-256 is 32 bytes');
  return `sha-256=:${standardBase64(sha256)}:`;
}
export function parseContentDigestField(value: string): Uint8Array | null {
  const match = /^sha-256=:([A-Za-z0-9+/=]+):$/.exec(value.trim());
  const bytes = match ? fromStandardBase64(match[1]!) : null;
  return bytes !== null && bytes.length === 32 ? bytes : null;
}
/** The `@signature-params` inner list (RFC 9421 section 2.3), parameters in this fixed order. */
export function signatureParamsValue(components: readonly string[], params: HttpSignatureParams): string {
  const list = components.map((c) => `"${c}"`).join(' ');
  const nonce = params.nonce === null ? '' : `;nonce="${params.nonce}"`;
  return `(${list});created=${params.created};expires=${params.expires};keyid="${params.keyid}";alg="${SIGNATURE_ALGORITHM}"${nonce};tag="${MESH_PROTOCOL}"`;
}
export interface HttpMessageView {
  readonly method?: string | undefined;
  readonly targetUri?: string | undefined;
  readonly status?: number | undefined;
  /** Field lookup by lowercase name; returns the combined field value or null. */
  readonly field: (name: string) => string | null;
}
/**
 * The RFC 9421 signature base (section 2.5): one line per covered component, `"<name>": <value>`, then the
 * `"@signature-params"` line, joined by LF with no trailing newline. Throws if a covered field is missing.
 */
export function httpSignatureBase(message: HttpMessageView, components: readonly string[], params: HttpSignatureParams): string {
  const lines = components.map((component) => {
    let value: string | null;
    if (component === '@method') value = message.method?.toUpperCase() ?? null;
    else if (component === '@target-uri') value = message.targetUri ?? null;
    else if (component === '@status') value = message.status === undefined ? null : String(message.status);
    else value = message.field(component);
    if (value === null) throw new Error(`missing covered component ${component}`);
    if (/[\r\n]/.test(value)) throw new Error(`component ${component} contains a line break`);
    return `"${component}": ${value.trim()}`;
  });
  lines.push(`"@signature-params": ${signatureParamsValue(components, params)}`);
  return lines.join('\n');
}
/** The `Signature-Input` and `Signature` field values for the mesh label. */
export function httpSignatureFields(components: readonly string[], params: HttpSignatureParams, signature: Uint8Array): { signatureInput: string; signature: string } {
  return { signatureInput: `${HTTP_SIGNATURE_LABEL}=${signatureParamsValue(components, params)}`, signature: `${HTTP_SIGNATURE_LABEL}=:${standardBase64(signature)}:` };
}
/** Parses the mesh label out of `Signature-Input` and `Signature`; null when absent or not in the mesh's exact form. */
export function parseHttpSignatureFields(signatureInput: string, signature: string): { components: string[]; params: HttpSignatureParams; signature: Uint8Array } | null {
  const input = new RegExp(`(?:^|,\\s*)${HTTP_SIGNATURE_LABEL}=\\(([^)]*)\\);created=(\\d+);expires=(\\d+);keyid="([^"]+)";alg="ed25519"(?:;nonce="([A-Za-z0-9_-]+)")?;tag="trustwork-mesh/1"(?:\\s*,|$)`).exec(signatureInput);
  const sig = new RegExp(`(?:^|,\\s*)${HTTP_SIGNATURE_LABEL}=:([A-Za-z0-9+/=]+):(?:\\s*,|$)`).exec(signature);
  if (!input || !sig) return null;
  const components = input[1]!.trim() === '' ? [] : input[1]!.trim().split(/\s+/).map((c) => c.replace(/^"|"$/g, ''));
  const bytes = fromStandardBase64(sig[1]!);
  if (bytes === null || bytes.length !== 64 || !KeyIdSchema.safeParse(input[4]).success) return null;
  return { components, params: { created: Number(input[2]), expires: Number(input[3]), keyid: input[4]!, nonce: input[5] ?? null }, signature: bytes };
}
/**
 * Freshness and coverage rules a receiver applies before verifying the bytes: the expected components are covered,
 * `expires - created` is at most the maximum age, `now` lies within the window (with clock skew), and a request with a
 * body carries a nonce (replay protection: the receiver remembers `(keyid, nonce)` until `expires`).
 */
export function httpSignatureProblems(
  parsed: { components: readonly string[]; params: HttpSignatureParams },
  expected: readonly string[],
  nowSeconds: number,
): ('components' | 'window' | 'clock_skew' | 'nonce_missing')[] {
  const problems: ('components' | 'window' | 'clock_skew' | 'nonce_missing')[] = [];
  if (expected.some((c) => !parsed.components.includes(c))) problems.push('components');
  const { created, expires, nonce } = parsed.params;
  if (!(expires > created && expires - created <= HTTP_SIGNATURE_MAX_AGE_SECONDS)) problems.push('window');
  if (nowSeconds + HTTP_SIGNATURE_CLOCK_SKEW_SECONDS < created || nowSeconds - HTTP_SIGNATURE_CLOCK_SKEW_SECONDS > expires) problems.push('clock_skew');
  if (expected.includes('content-digest') && expected.includes('@method') && nonce === null) problems.push('nonce_missing');
  return problems;
}

/* ---------- Replicas: merge rule and audiences ---------- */

export type ReplicaState =
  | { readonly kind: 'none' }
  | { readonly kind: 'replica'; readonly revision: number; readonly digest: string }
  | { readonly kind: 'tombstoned'; readonly revision: number; readonly reason: TombstoneReason };
export type ReplicaDecision =
  | { readonly action: 'store' | 'replace' | 'ignore_stale' | 'ignore_duplicate' | 'apply_tombstone' }
  | { readonly action: 'reject'; readonly code: 'federation.replica_conflict' | 'federation.object_gone' };

/**
 * `trustwork-merge-1` (MSH-F19): what a receiving node does with an incoming envelope or tombstone for an object it may
 * already hold. The home node is the only writer, so revisions order everything:
 * - a higher revision replaces, a lower one is stale, the same revision with the same digest is a duplicate;
 * - the same revision with a different digest is home-node equivocation: refused and flagged, never resolved locally;
 * - a tombstone removes every revision up to its own; after `erased` or `takedown` the identifier never returns,
 *   after other reasons only a strictly higher revision may republish; an erasure or takedown always overrides an
 *   earlier non-terminal tombstone.
 */
export function replicaDecision(state: ReplicaState, incoming: { kind: 'envelope'; revision: number; digest: string } | { kind: 'tombstone'; revision: number; reason: TombstoneReason }): ReplicaDecision {
  if (incoming.kind === 'tombstone') {
    if (state.kind === 'tombstoned') {
      const escalates = TERMINAL_TOMBSTONE_REASONS.includes(incoming.reason) && !TERMINAL_TOMBSTONE_REASONS.includes(state.reason);
      return escalates || incoming.revision > state.revision ? { action: 'apply_tombstone' } : { action: 'ignore_duplicate' };
    }
    if (state.kind === 'replica' && state.revision > incoming.revision) return { action: 'ignore_stale' };
    return { action: 'apply_tombstone' };
  }
  if (state.kind === 'none') return { action: 'store' };
  if (state.kind === 'tombstoned') {
    if (TERMINAL_TOMBSTONE_REASONS.includes(state.reason)) return { action: 'reject', code: 'federation.object_gone' };
    return incoming.revision > state.revision ? { action: 'store' } : { action: 'reject', code: 'federation.object_gone' };
  }
  if (incoming.revision > state.revision) return { action: 'replace' };
  if (incoming.revision < state.revision) return { action: 'ignore_stale' };
  return incoming.digest === state.digest ? { action: 'ignore_duplicate' } : { action: 'reject', code: 'federation.replica_conflict' };
}

/** Who may read a replica: everyone for public replicas, only the named parties for shared_party replicas. */
export type ReplicaAudience = { readonly kind: 'public' } | { readonly kind: 'parties'; readonly parties: readonly string[] };
export function replicaAudience(envelope: { audience: EnvelopeAudience }): ReplicaAudience {
  return envelope.audience.kind === 'public' ? { kind: 'public' } : { kind: 'parties', parties: [...envelope.audience.parties].sort() };
}
/**
 * The audience of anything derived from several replicas (a search answer, a summary): the intersection of the source
 * audiences (R31). Public sources do not narrow it; any shared_party source limits it to the parties common to all.
 */
export function intersectReplicaAudiences(audiences: readonly ReplicaAudience[]): ReplicaAudience {
  const restricting = audiences.filter((a): a is { kind: 'parties'; parties: readonly string[] } => a.kind === 'parties');
  if (restricting.length === 0) return { kind: 'public' };
  const [first, ...rest] = restricting;
  const parties = [...new Set(first!.parties)].filter((p) => rest.every((a) => a.parties.includes(p)));
  return { kind: 'parties', parties: parties.sort() };
}
export function mayReadReplica(audience: ReplicaAudience, readerParties: readonly string[]): boolean {
  return audience.kind === 'public' || audience.parties.some((p) => readerParties.includes(p));
}
