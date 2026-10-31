import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { computeDigest } from '../../../packages/contracts/src/common/digest.js';
import { fromBase64Url, toBase64Url } from '../../../packages/contracts/src/common/encoding.js';
import {
  MESH_PROTOCOL,
  defaultDataLicences,
  rotationStatementFor,
  signDocument,
  type Ed25519Sign,
  type Ed25519Verify,
  type NodeKey,
} from '../../../packages/contracts/src/federation.js';
import { restrictedPlaces } from '../../../packages/contracts/src/sanctions.js';
import { RESTRICTED } from '../../../packages/country-packs/src/restricted.js';

/*
 * Synthetic fixtures only. Node names use the RFC 2606 `example.org` domain; keys are the published RFC 8032
 * section 7.1 test keys (TEST 1, 2 and 3), which are public test data and never node keys. No real operator, person,
 * company or address appears here, and nothing touches the network.
 */

export const restricted = restrictedPlaces(RESTRICTED.places.map((place) => place.code));
export const RESTRICTED_CODES: readonly string[] = RESTRICTED.places.map((place) => place.code);

/** RFC 8032 section 7.1 secret keys (32-byte seeds) and their published public keys. */
export const RFC8032 = {
  test1: { secret: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', public: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a' },
  test2: { secret: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', public: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c' },
  test3: { secret: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7', public: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025' },
} as const;
/** RFC 8032 TEST 1 signature of the empty message, to prove the adapter below is a conformant Ed25519. */
export const RFC8032_TEST1_EMPTY_SIGNATURE =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

const hex = (text: string) => Uint8Array.from(text.match(/../g)!.map((b) => parseInt(b, 16)));
export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function privateKeyOf(secretHex: string, publicHex: string) {
  return createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: toBase64Url(hex(secretHex)), x: toBase64Url(hex(publicHex)) }, format: 'jwk' });
}
/** Test signer over node:crypto (the FED-001 adapter will hold the key in the secret store instead). */
export function signerFor(key: { secret: string; public: string }): Ed25519Sign {
  const privateKey = privateKeyOf(key.secret, key.public);
  return (message) => new Uint8Array(cryptoSign(null, message, privateKey));
}
/** Derives the public key from the seed, independently of the published value. */
export function derivedPublicKey(key: { secret: string; public: string }): string {
  const jwk = createPublicKey(privateKeyOf(key.secret, key.public)).export({ format: 'jwk' }) as { x: string };
  return jwk.x;
}
export const publicKeyB64 = (key: { public: string }) => toBase64Url(hex(key.public));
export const verifyEd25519: Ed25519Verify = (publicKey, message, signature) => {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(publicKey) }, format: 'jwk' });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
};
export const sha256 = (bytes: Uint8Array | string) => new Uint8Array(createHash('sha256').update(bytes).digest());
export const b64urlToBytes = (text: string) => fromBase64Url(text)!;
export { computeDigest };

/* ---------- Nodes ---------- */

export const NOW = '2026-11-02T08:00:00.000Z';
export const NATIONAL = 'build.example.org';
export const CITY = 'austin.example.org';
export const THIRD = 'houston.example.org';

const NATIONAL_K1_FROM = '2026-01-01T00:00:00.000Z';
const NATIONAL_ROTATED_AT = '2026-10-01T00:00:00.000Z';

/** The national node's chain: k1 (TEST 1) handed over to k2 (TEST 2) on 2026-10-01, signed by k1. */
export function nationalKeyChain(): NodeKey[] {
  const k1: NodeKey = { keyId: 'k1', algorithm: 'ed25519', publicKey: publicKeyB64(RFC8032.test1), validFrom: NATIONAL_K1_FROM, retiredAt: NATIONAL_ROTATED_AT, revocation: null, rotation: null };
  const k2Unsigned: NodeKey = {
    keyId: 'k2', algorithm: 'ed25519', publicKey: publicKeyB64(RFC8032.test2), validFrom: NATIONAL_ROTATED_AT, retiredAt: null, revocation: null,
    rotation: { previousKeyId: 'k1', signature: { algorithm: 'ed25519', keyId: 'k1', value: 'A'.repeat(86) } },
  };
  const statement = rotationStatementFor(NATIONAL, k1, k2Unsigned);
  const signed = signDocument('key_rotation', statement, 'k1', signerFor(RFC8032.test1));
  return [k1, { ...k2Unsigned, rotation: { previousKeyId: 'k1', signature: signed.signature } }];
}
export function cityKeyChain(): NodeKey[] {
  return [{ keyId: 'a1', algorithm: 'ed25519', publicKey: publicKeyB64(RFC8032.test3), validFrom: NATIONAL_K1_FROM, retiredAt: null, revocation: null, rotation: null }];
}
export const NODE_SIGNERS: Record<string, { keyId: string; sign: Ed25519Sign }> = {
  [NATIONAL]: { keyId: 'k2', sign: signerFor(RFC8032.test2) },
  [CITY]: { keyId: 'a1', sign: signerFor(RFC8032.test3) },
};

export function attestationSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-0001',
    nodeId: 'node-0001',
    operatorEntityCountry: 'US',
    operatorEntityRegion: 'US-TX',
    hostingCountry: 'US',
    hostingRegion: 'US-VA',
    gateMode: 'ranges_file' as const,
    statementDigest: 'a'.repeat(64),
    attestedAt: '2026-06-01T00:00:00.000Z',
    expiresAt: '2027-06-01T00:00:00.000Z',
    supersedesId: null,
    basis: 'operator_statement' as const,
    ...overrides,
  };
}

export interface ManifestOptions {
  node?: string;
  jurisdiction?: string;
  operatorCountry?: string;
  territories?: string[];
  packs?: { country: string; version: string }[];
  attestation?: Record<string, unknown>;
  licences?: Record<string, string>;
  offered?: string[];
  signed?: boolean;
}
/** A synthetic manifest for the national node (default) or the city node, signed with the node's current key. */
export function manifest(options: ManifestOptions = {}): Record<string, unknown> {
  const node = options.node ?? NATIONAL;
  const chain = node === NATIONAL ? nationalKeyChain() : cityKeyChain();
  const signer = NODE_SIGNERS[node] ?? NODE_SIGNERS[NATIONAL]!;
  const unsigned = {
    protocol: [MESH_PROTOCOL],
    node,
    engine: { version: '0.1.0', source: 'https://github.com/Contribuda/trustwork' },
    operator: {
      name: node === NATIONAL ? 'Example Builders Cooperative (synthetic)' : 'Austin Trades Example Association (synthetic)',
      country: options.operatorCountry ?? 'US',
      registration: { kind: 'us_ein', value: '00-0000000' },
      abuseContact: `mailto:abuse@${node}`,
      takedownContact: `https://${node}/legal/takedown`,
    },
    jurisdiction: options.jurisdiction ?? 'US',
    hubs: [{ id: node === NATIONAL ? 'us' : 'us-tx-austin', territories: options.territories ?? (node === NATIONAL ? ['US'] : ['US-TX', 'US-TX:austin']), languages: ['en', 'es'] }],
    packs: options.packs ?? [{ country: 'US', version: '2026.10.1' }],
    licences: { ...defaultDataLicences(), ...(options.licences ?? {}) },
    licenceConditions: { attributionVisible: true, tombstoneHours: 72, noResaleOfPersonalData: true, noModelTrainingOutsideGovernedRetrieval: true, neverPresentedAsLocal: true },
    peeringPolicy: { offered: options.offered ?? ['syndicate', 'trust_verifications', 'deal_routing'], secondApproverFor: ['deal_routing', 'identity'], agentEnvelopesPerHour: 60 },
    keys: { current: chain[chain.length - 1]!.keyId, chain },
    deploymentAttestation: attestationSummary(options.attestation),
    issuedAt: '2026-11-01T00:00:00.000Z',
  };
  if (options.signed === false) return { ...unsigned, signature: { algorithm: 'ed25519', keyId: signer.keyId, value: 'A'.repeat(86) } };
  return signDocument('manifest', unsigned, signer.keyId, signer.sign);
}

/* ---------- Objects ---------- */

export const gid = (host: string, kind: string, id: string) => `trustwork://${host}/${kind}/${id}`;

export interface EnvelopeOptions {
  kind?: string;
  id?: string;
  homeNode?: string;
  projection?: string;
  dataClass?: string;
  syndication?: string;
  audience?: unknown;
  subject?: string | null;
  consent?: unknown;
  agentGenerated?: boolean;
  payload?: Record<string, unknown>;
  revision?: number;
}
/** A public editorial publication from the national node by default; every field can be overridden. */
export function envelope(options: EnvelopeOptions = {}): Record<string, unknown> {
  const homeNode = options.homeNode ?? NATIONAL;
  const kind = options.kind ?? 'publication';
  const payload = options.payload ?? {
    title: 'Facade fire safety after the 2026 code cycle',
    lede: 'What changes for cladding on mid-rise buildings.',
    topics: ['facades', 'fire-safety'],
    authorDisplayName: 'Editorial team',
    publishedAt: '2026-11-01T09:00:00.000Z',
    canonicalUrl: `https://${homeNode}/news/facade-fire-safety`,
  };
  const unsigned = {
    protocol: MESH_PROTOCOL,
    id: options.id ?? gid(homeNode, kind, 'pub-7b0c'),
    kind,
    revision: options.revision ?? 3,
    homeNode,
    projection: options.projection ?? 'public',
    dataClass: options.dataClass ?? 'editorial_publications',
    syndication: options.syndication ?? 'cc_by_4_0',
    audience: options.audience ?? { kind: 'public' },
    subject: options.subject === undefined ? null : options.subject,
    consent: options.consent === undefined ? null : options.consent,
    agentGenerated: options.agentGenerated ?? false,
    payload,
    digest: computeDigest(payload),
    issuedAt: NOW,
  };
  const signer = NODE_SIGNERS[homeNode] ?? NODE_SIGNERS[NATIONAL]!;
  return signDocument('envelope', unsigned, signer.keyId, signer.sign);
}

/** A shared_party quote version from the city node to a buyer on the national node. */
export function dealEnvelope(options: EnvelopeOptions = {}): Record<string, unknown> {
  const seller = gid(CITY, 'company', 'co-austin-glazing');
  const buyer = gid(NATIONAL, 'company', 'co-national-builder');
  return envelope({
    kind: 'quote_version',
    homeNode: CITY,
    id: gid(CITY, 'quote_version', 'qv-1'),
    projection: 'shared_party',
    dataClass: 'deal_data',
    syndication: 'parties_only',
    audience: { kind: 'parties', parties: [buyer, seller], nodes: [NATIONAL, CITY] },
    subject: seller,
    payload: { rfqVersion: { id: 'rfqv-2', version: 2, digest: { algorithm: 'trustwork-digest-1', value: 'b'.repeat(64) } }, currency: 'USD', totalMinorUnits: '1250000', validUntil: '2026-12-01T00:00:00.000Z' },
    revision: 1,
    ...options,
  });
}

export function tombstone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const unsigned = {
    protocol: MESH_PROTOCOL,
    id: gid(NATIONAL, 'tombstone', 'ts-1'),
    target: gid(NATIONAL, 'publication', 'pub-7b0c'),
    targetKind: 'publication',
    homeNode: NATIONAL,
    revision: 3,
    reason: 'unpublished',
    purge: ['replica', 'search_index', 'cache', 'saved_answers'],
    issuedAt: NOW,
    applyBy: '2026-11-05T08:00:00.000Z',
    ...overrides,
  };
  return signDocument('tombstone', unsigned, 'k2', NODE_SIGNERS[NATIONAL]!.sign);
}

/** Documentation addresses (RFC 5737, RFC 3849) used to prove no record carries one. */
export const TEST_ADDRESSES = ['192.0.2.44', '198.51.100.7', '203.0.113.10', '2001:db8::5', '::ffff:192.0.2.9'];
