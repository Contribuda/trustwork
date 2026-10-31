import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEDERATION_PEER_RESTRICTED,
  admitPeerAtHandshake,
  type AdmissionManifest,
  type AdmissionContext,
} from '../../../packages/compliance/src/admission/index.js';
import { fakeGate, type GateRequest } from '../../../packages/contracts/src/sanctions.js';
import type { DeploymentLocationAttestationSummary } from '../../../packages/contracts/src/sanctions-attestation.js';
import {
  DATA_LICENCE_RULES,
  FEDERATION_ERROR_STATUS,
  HandshakeResponseSchema,
  MESH_DATA_CLASSES,
  agreedLicences,
  defaultDataLicences,
  handshakeAdmissionPeer,
  handshakeRequestSchema,
  keyChainProblems,
  manifestRestrictions,
  nodeManifestSchema,
  verifyManifestSignatures,
  type NodeManifest,
} from '../../../packages/contracts/src/federation.js';
import { CITY, NATIONAL, RESTRICTED_CODES, TEST_ADDRESSES, manifest, nationalKeyChain, restricted, verifyEd25519 } from './fixtures.js';

const schema = nodeManifestSchema(restricted);
const messages = (value: unknown) => {
  const r = schema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};
const context: AdmissionContext = { restricted, geolocation: fakeGate(restricted), now: new Date('2026-11-02T08:00:00.000Z') };
const connection = (address: string): GateRequest => ({ address, header: () => null });

test('a well-formed US manifest validates and its own and rotation signatures verify', () => {
  const parsed = schema.parse(manifest());
  assert.ok(verifyManifestSignatures(parsed, verifyEd25519));
  const city = schema.parse(manifest({ node: CITY }));
  assert.ok(verifyManifestSignatures(city, verifyEd25519));
  assert.equal(verifyManifestSignatures(schema.parse(manifest({ signed: false })), verifyEd25519), false, 'an unsigned manifest never verifies');
  const tampered = { ...parsed, operator: { ...parsed.operator, name: 'Someone else' } };
  assert.equal(verifyManifestSignatures(tampered as NodeManifest, verifyEd25519), false);
});

test('ACCEPTANCE: restricted jurisdictions are rejected at manifest validation, for every listed place and every field', () => {
  assert.ok(RESTRICTED_CODES.length >= 8);
  for (const code of RESTRICTED_CODES) {
    const country = code.slice(0, 2);
    const asJurisdiction = messages(manifest({ jurisdiction: code }));
    assert.ok(asJurisdiction.some((m) => m.startsWith('jurisdiction: restricted place')), `${code}: ${asJurisdiction}`);
    assert.ok(messages(manifest({ territories: ['US', code] })).some((m) => m.startsWith('hubs.0.territories.1: restricted place')), `${code} as territory`);
    assert.ok(messages(manifest({ territories: [`${code}:somecity`] })).some((m) => /restricted place/.test(m)), `${code} as city territory`);
    if (code.length === 2) {
      assert.ok(messages(manifest({ operatorCountry: code })).some((m) => m.startsWith('operator.country: restricted place')), `${code} as operator country`);
      assert.ok(messages(manifest({ packs: [{ country: code, version: '1' }] })).some((m) => m.startsWith('packs.0.country: restricted place')), `${code} as pack`);
      assert.ok(messages(manifest({ attestation: { hostingCountry: code, hostingRegion: null } })).some((m) => m.startsWith('deploymentAttestation.hostingCountry: restricted place')), `${code} as hosting`);
    } else {
      assert.ok(messages(manifest({ attestation: { hostingCountry: country, hostingRegion: code } })).some((m) => m.startsWith('deploymentAttestation.hostingRegion: restricted place')), `${code} as hosting region`);
    }
  }
  // A subdivision of a country restricted as a whole is restricted; an unlisted subdivision of a partly restricted country is not.
  assert.ok(messages(manifest({ jurisdiction: 'RU-MOW' })).some((m) => /restricted place RU/.test(m)));
  assert.deepEqual(messages(manifest({ territories: ['US', 'UA-30'] })), []);
  // A hosting location in a country restricted only by region must name the region.
  assert.ok(messages(manifest({ attestation: { hostingCountry: 'UA', hostingRegion: null } })).some((m) => /must be stated with its region/.test(m)));
  assert.deepEqual(manifestRestrictions(schema.parse(manifest()), restricted), []);
});

test('manifest rules: licences only stricter, key chain intact, signed with the current key, unique hubs', () => {
  assert.deepEqual(messages(manifest({ licences: { person_profiles: 'link_only', editorial_publications: 'headline_and_link' } })), []);
  assert.ok(messages(manifest({ licences: { person_profiles: 'open_data_with_attribution' } })).some((m) => m.startsWith('licences.person_profiles')));
  assert.ok(messages(manifest({ licences: { reviews: 'redisplay_with_attribution' } })).some((m) => m.startsWith('licences.reviews')));
  assert.ok(messages(manifest({ licences: { deal_data: 'none' } })).some((m) => m.startsWith('licences.deal_data')));
  for (const c of MESH_DATA_CLASSES) assert.equal(DATA_LICENCE_RULES[c].allowed[0], DATA_LICENCE_RULES[c].default, c);

  const m = manifest() as Record<string, unknown> & { keys: { current: string; chain: unknown[] }; signature: Record<string, unknown> };
  assert.ok(messages({ ...m, keys: { ...m.keys, current: 'k1' } }).some((x) => /current_not_last/.test(x)));
  assert.ok(messages({ ...m, signature: { ...m.signature, keyId: 'k1' } }).some((x) => x.startsWith('signature.keyId')));
  assert.ok(messages({ ...m, licenceConditions: { attributionVisible: true, tombstoneHours: 96, noResaleOfPersonalData: true, noModelTrainingOutsideGovernedRetrieval: true, neverPresentedAsLocal: true } }).some((x) => x.startsWith('licenceConditions.tombstoneHours')));
  assert.ok(messages({ ...m, protocol: ['trustwork-mesh/2'] }).some((x) => x.startsWith('protocol')));
  assert.ok(messages({ ...m, operatorAddress: '192.0.2.44' }).length > 0, 'strict: no extra fields');
  const hubs = m['hubs'] as unknown[];
  assert.ok(messages({ ...m, hubs: [...hubs, ...hubs] }).some((x) => x.startsWith('hubs: hub ids are unique')));

  const chain = nationalKeyChain();
  assert.deepEqual(keyChainProblems(NATIONAL, chain, 'k2', verifyEd25519), []);
  assert.deepEqual(keyChainProblems(NATIONAL, [chain[1]!], 'k2'), ['genesis_has_rotation']);
  assert.deepEqual(keyChainProblems(NATIONAL, [chain[0]!, { ...chain[1]!, validFrom: '2026-10-02T00:00:00.000Z' }], 'k2'), ['handover_gap']);
  assert.ok(keyChainProblems(NATIONAL, [chain[0]!, { ...chain[1]!, rotation: null }], 'k2').includes('rotation_missing'));
  const forged = { ...chain[1]!, publicKey: chain[0]!.publicKey };
  assert.deepEqual(keyChainProblems(NATIONAL, [chain[0]!, forged], 'k2', verifyEd25519), ['rotation_signature_invalid'], 'a rotation not signed by the previous key for this next key');
  assert.deepEqual(keyChainProblems(CITY, chain, 'k2', verifyEd25519), ['rotation_signature_invalid'], 'the node name is bound in the rotation');
});

test('peering licences: the agreed term per class is the stricter of both manifests', () => {
  const a = { ...defaultDataLicences(), person_profiles: 'link_only' as const };
  const b = { ...defaultDataLicences(), editorial_publications: 'headline_and_link' as const, events: 'none' as const };
  const agreed = agreedLicences(a, b);
  assert.equal(agreed.person_profiles, 'link_only');
  assert.equal(agreed.editorial_publications, 'headline_and_link');
  assert.equal(agreed.events, 'none');
  assert.equal(agreed.directory_facts, 'open_data_with_attribution');
});

function handshake(overrides: Record<string, unknown> = {}, manifestOptions: Parameters<typeof manifest>[0] = {}) {
  return {
    protocol: 'trustwork-mesh/1',
    from: NATIONAL,
    to: CITY,
    manifest: manifest(manifestOptions),
    requestedLevel: 'syndicate',
    hubs: { initiator: 'us', responder: 'us-tx-austin' },
    nonce: 'aGFuZHNoYWtlLW5vbmNlLTAwMDE',
    issuedAt: '2026-11-02T08:00:00.000Z',
    ...overrides,
  };
}

test('handshake request carries what admitPeerAtHandshake needs and the bridge types line up', () => {
  const request = handshakeRequestSchema(restricted).parse(handshake());
  const peer = handshakeAdmissionPeer(request);
  // Compile-time compatibility with SANC-008: the manifest and attestation are passed as they are.
  const asAdmission: AdmissionManifest = peer.manifest;
  const asAttestation: DeploymentLocationAttestationSummary = peer.attestation;
  assert.equal(asAdmission.node, NATIONAL);
  assert.equal(asAttestation.basis, 'operator_statement');
  const decision = admitPeerAtHandshake({ ...peer, observed: connection('203.0.113.10') }, context);
  assert.equal(decision.outcome, 'admitted');
  assert.deepEqual(decision.outcome === 'admitted' ? decision.judged : null, ['declared', 'attested', 'observed']);
});

test('handshake: a restricted manifest never parses; a restricted attestation or observed place is refused with federation.peer_restricted (451)', () => {
  const hs = handshakeRequestSchema(restricted);
  assert.equal(hs.safeParse(handshake({}, { jurisdiction: 'CU' })).success, false);
  assert.equal(hs.safeParse(handshake({}, { territories: ['IR'] })).success, false);
  assert.equal(hs.safeParse(handshake({}, { attestation: { hostingCountry: 'KP', hostingRegion: null } })).success, false);

  // The observed place is judged by the receiver at its own door (fake gate: 192.0.2.0/24 is the first listed country).
  const request = hs.parse(handshake());
  const refused = admitPeerAtHandshake({ ...handshakeAdmissionPeer(request), observed: connection('192.0.2.44') }, context);
  assert.equal(refused.outcome, 'refused');
  assert.equal(FEDERATION_PEER_RESTRICTED, 'federation.peer_restricted');
  assert.equal(FEDERATION_ERROR_STATUS[FEDERATION_PEER_RESTRICTED], 451);

  // An expired attestation (published long ago) is refused by admission even though the manifest shape is valid.
  const stale = hs.parse(handshake({}, { attestation: { attestedAt: '2025-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z' } }));
  assert.equal(admitPeerAtHandshake({ ...handshakeAdmissionPeer(stale), observed: connection('203.0.113.10') }, context).outcome, 'refused');

  const response = HandshakeResponseSchema.parse({ protocol: 'trustwork-mesh/1', outcome: 'refused', from: CITY, to: NATIONAL, code: FEDERATION_PEER_RESTRICTED, nonce: request.nonce, issuedAt: '2026-11-02T08:00:01.000Z' });
  assert.equal(response.outcome, 'refused');
  assert.equal(HandshakeResponseSchema.safeParse({ ...response, findings: [{ place: 'CU' }] }).success, false, 'no findings echoed');
  assert.equal(HandshakeResponseSchema.safeParse({ ...response, peerAddress: '192.0.2.44' }).success, false, 'no address echoed');
});

test('handshake: no network address appears in the request, the parsed manifest or the refusal record', () => {
  const request = handshakeRequestSchema(restricted).parse(handshake());
  const refused = admitPeerAtHandshake({ ...handshakeAdmissionPeer(request), observed: connection('192.0.2.44') }, context);
  const serialized = JSON.stringify([request, refused]);
  for (const address of TEST_ADDRESSES) assert.ok(!serialized.includes(address), address);
  assert.equal(handshakeRequestSchema(restricted).safeParse({ ...handshake(), from: '192.0.2.44' }).success, false);
  assert.equal(handshakeRequestSchema(restricted).safeParse({ ...handshake(), observedAddress: '192.0.2.44' }).success, false);
});

test('handshake request rules: own manifest, own hub, a level it offers, not to itself', () => {
  const hs = handshakeRequestSchema(restricted);
  assert.equal(hs.safeParse(handshake({ from: CITY, to: NATIONAL })).success, false, 'manifest of another node');
  assert.equal(hs.safeParse(handshake({ to: NATIONAL })).success, false, 'to itself');
  assert.equal(hs.safeParse(handshake({ hubs: { initiator: 'mx', responder: 'us-tx-austin' } })).success, false, 'unknown initiating hub');
  assert.equal(hs.safeParse(handshake({ requestedLevel: 'identity' })).success, false, 'level not offered');
  assert.equal(hs.safeParse(handshake({ nonce: 'short' })).success, false);
  assert.ok(hs.safeParse(handshake({ requestedLevel: 'deal_routing' })).success);
});
