import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMISSION_POLICIES,
  ADMISSION_SERVICES,
  AdmissionRefusalRecordSchema,
  FEDERATION_PEER_RESTRICTED,
  admissionLogEvent,
  admitPeerAtHandshake,
  checkAdmission,
  type AdmissionAttestation,
  type AdmissionContext,
  type AdmissionDecision,
  type AdmissionManifest,
  type AdmissionRefusalRecord,
} from '../../../packages/compliance/src/admission/index.js';
import {
  edgeHeaderGate,
  fakeGate,
  loadRangeTable,
  parseAddress,
  rangesFileGate,
  restrictedPlaces,
  unconfiguredGate,
  upstreamGate,
  RANGE_TABLE_FORMAT,
  type GateRequest,
} from '../../../packages/contracts/src/sanctions.js';
import { DeploymentLocationAttestationSummarySchema, type DeploymentLocationAttestationSummary } from '../../../packages/contracts/src/sanctions-attestation.js';
import { RESTRICTED } from '../../../packages/country-packs/src/restricted.js';

/*
 * Fake manifests, attestations and documentation addresses only (RFC 5737: 192.0.2.0/24, 198.51.100.0/24,
 * 203.0.113.0/24; RFC 3849: 2001:db8::/32). The fake gate answers 192.0.2.0/24 and 2001:db8::/48 with the first listed
 * country (CU), 198.51.100.0/25 with the first listed subdivision (UA-09), and serves 203.0.113.0/24 and
 * 198.51.100.128/25. No real geolocation data, no network.
 */

const restricted = restrictedPlaces(RESTRICTED.places.map((place) => place.code));
const NOW = new Date('2026-10-31T12:00:00.000Z');
const context: AdmissionContext = { restricted, geolocation: fakeGate(restricted), now: NOW };

const SERVED_V4 = '203.0.113.10';
const RESTRICTED_V4 = '192.0.2.44';
const RESTRICTED_SUBDIVISION_V4 = '198.51.100.7';
const RESTRICTED_V6 = '2001:db8::5';
const MAPPED_RESTRICTED = '::ffff:192.0.2.9';
const SERVED_SUBDIVISION_RANGE_V4 = '198.51.100.200';
const ALL_TEST_ADDRESSES = [SERVED_V4, RESTRICTED_V4, RESTRICTED_SUBDIVISION_V4, RESTRICTED_V6, MAPPED_RESTRICTED, SERVED_SUBDIVISION_RANGE_V4];

function connection(address: string | null, headers: Record<string, string> = {}): GateRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { address, header: (name) => lower[name.toLowerCase()] ?? null };
}

function manifest(overrides: Partial<{ node: string; jurisdiction: string; operatorCountry: string; territories: string[] }> = {}): AdmissionManifest {
  return {
    node: overrides.node ?? 'build.example.org',
    protocol: ['trustwork-mesh/1'],
    jurisdiction: overrides.jurisdiction ?? 'US',
    operator: { name: 'Example Builders Cooperative (synthetic)', country: overrides.operatorCountry ?? 'US', abuse: 'abuse@example.org' },
    hubs: [{ id: 'us-tx', territories: overrides.territories ?? ['US', 'US-TX', 'US-TX:austin'], languages: ['en', 'es'] }],
    keys: { current: 'ed25519:synthetic' },
  };
}

function attestation(overrides: Partial<AdmissionAttestation> = {}): AdmissionAttestation {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    nodeId: '00000000-0000-4000-8000-000000000002',
    operatorEntityCountry: 'US',
    operatorEntityRegion: null,
    hostingCountry: 'US',
    hostingRegion: 'US-VA',
    gateMode: 'ranges_file',
    attestedAt: '2026-06-01T00:00:00.000Z',
    expiresAt: '2027-06-01T00:00:00.000Z',
    basis: 'operator_statement',
    ...overrides,
  };
}

function peer(overrides: { manifest?: AdmissionManifest; attestation?: AdmissionAttestation | null; address?: string | null } = {}) {
  return {
    manifest: overrides.manifest ?? manifest(),
    attestation: overrides.attestation === undefined ? attestation() : overrides.attestation,
    observed: overrides.address === null ? null : connection(overrides.address ?? SERVED_V4),
  };
}

function refused(decision: AdmissionDecision): AdmissionRefusalRecord {
  assert.equal(decision.outcome, 'refused', `expected a refusal, got ${JSON.stringify(decision)}`);
  if (decision.outcome !== 'refused') throw new Error('unreachable');
  return decision.record;
}

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    out.push(key);
    stringLeaves(item, out);
  }
  return out;
}

/** The refusal record, the decision and the log event never carry an address, in any field or key. */
function assertNoAddress(decision: AdmissionDecision): void {
  const log = admissionLogEvent(decision);
  for (const artefact of [decision, log]) {
    const serialized = JSON.stringify(artefact);
    for (const address of ALL_TEST_ADDRESSES) assert.ok(!serialized.includes(address), `address ${address} leaked into ${serialized}`);
    for (const leaf of stringLeaves(artefact)) assert.equal(parseAddress(leaf), null, `a field reads as an address: ${leaf}`);
  }
  if (decision.outcome === 'refused') AdmissionRefusalRecordSchema.parse(decision.record);
}

test('a peer whose manifest, attestation and observed address are clean is admitted', () => {
  const decision = admitPeerAtHandshake(peer(), context);
  assert.deepEqual(decision, { outcome: 'admitted', service: 'federation_handshake', decidedAt: NOW.toISOString(), judged: ['declared', 'attested', 'observed'] });
  assert.equal(admissionLogEvent(decision), null);
});

test('a manifest declaring a restricted jurisdiction, operator country or territory is refused (ADR 011 decision 12)', () => {
  const cases: Array<[AdmissionManifest, string, string]> = [
    [manifest({ jurisdiction: 'RU' }), 'manifest_jurisdiction', 'RU'],
    [manifest({ jurisdiction: 'ru' }), 'manifest_jurisdiction', 'RU'],
    [manifest({ operatorCountry: 'IR' }), 'manifest_operator_country', 'IR'],
    [manifest({ territories: ['US', 'KP'] }), 'manifest_territory', 'KP'],
    [manifest({ territories: ['UA-30', 'UA-43:simferopol'] }), 'manifest_territory', 'UA-43'],
    [manifest({ territories: ['CU-03'] }), 'manifest_territory', 'CU'],
  ];
  for (const [m, source, place] of cases) {
    const record = refused(admitPeerAtHandshake(peer({ manifest: m }), context));
    assert.deepEqual(record.findings, [{ reason: 'restricted_place', kind: 'declared', source, place, dataset: 'declared' }]);
    assert.equal(record.subject, 'build.example.org');
  }
  // Region granularity for Ukraine: Kyiv and a whole-country territory are not restricted places.
  assert.equal(admitPeerAtHandshake(peer({ manifest: manifest({ jurisdiction: 'UA', operatorCountry: 'UA', territories: ['UA', 'UA-30', 'UA-46:lviv'] }), attestation: attestation({ operatorEntityCountry: 'UA', operatorEntityRegion: 'UA-30', hostingCountry: 'UA', hostingRegion: 'UA-46' }) }), context).outcome, 'admitted');
});

test('an attestation stating a restricted operator entity or hosting place is refused, with region granularity for Ukraine', () => {
  const cases: Array<[Partial<AdmissionAttestation>, string | null, string | null, string]> = [
    [{ hostingCountry: 'KP', hostingRegion: null }, 'attested_hosting', 'KP', 'restricted_place'],
    [{ operatorEntityCountry: 'CU' }, 'attested_operator_entity', 'CU', 'restricted_place'],
    [{ hostingCountry: 'UA', hostingRegion: 'UA-14' }, 'attested_hosting', 'UA-14', 'restricted_place'],
    [{ operatorEntityCountry: 'UA', operatorEntityRegion: 'UA-40' }, 'attested_operator_entity', 'UA-40', 'restricted_place'],
    [{ hostingCountry: 'UA', hostingRegion: null }, 'attested_hosting', null, 'region_required'],
    [{ hostingCountry: 'US', hostingRegion: 'CA-ON' }, null, null, 'evidence_invalid'],
  ];
  for (const [overrides, source, place, reason] of cases) {
    const record = refused(admitPeerAtHandshake(peer({ attestation: attestation(overrides) }), context));
    assert.deepEqual(record.findings, [{ reason, kind: 'attested', source, place, dataset: 'attestation' }]);
  }
  assert.equal(admitPeerAtHandshake(peer({ attestation: attestation({ hostingCountry: 'UA', hostingRegion: 'UA-30' }) }), context).outcome, 'admitted');
});

test('the SANC-009 attestation summary a peer publishes is accepted unchanged and judged', () => {
  const summary = (overrides: Partial<DeploymentLocationAttestationSummary>): DeploymentLocationAttestationSummary =>
    DeploymentLocationAttestationSummarySchema.parse({
      id: 'attestation-0001',
      nodeId: 'node-0001',
      operatorEntityCountry: 'US',
      operatorEntityRegion: 'US-DE',
      hostingCountry: 'US',
      hostingRegion: 'US-OR',
      gateMode: 'edge_header',
      statementDigest: 'a'.repeat(64),
      attestedAt: '2026-03-01T00:00:00Z',
      expiresAt: '2027-03-01T00:00:00Z',
      supersedesId: null,
      basis: 'operator_statement',
      ...overrides,
    });
  assert.equal(admitPeerAtHandshake({ ...peer(), attestation: summary({}) }, context).outcome, 'admitted');
  const sevastopol = refused(admitPeerAtHandshake({ ...peer(), attestation: summary({ hostingCountry: 'UA', hostingRegion: 'UA-40' }) }, context));
  assert.deepEqual(sevastopol.findings, [{ reason: 'restricted_place', kind: 'attested', source: 'attested_hosting', place: 'UA-40', dataset: 'attestation' }]);
  const moscow = refused(admitPeerAtHandshake({ ...peer(), attestation: summary({ operatorEntityCountry: 'RU', operatorEntityRegion: 'RU-MOW' }) }, context));
  assert.deepEqual(moscow.findings, [{ reason: 'restricted_place', kind: 'attested', source: 'attested_operator_entity', place: 'RU', dataset: 'attestation' }], 'one finding per place, not one per field');
});

test('an expired or unreadable attestation refuses; it is never treated as a verification', () => {
  const expired = refused(admitPeerAtHandshake(peer({ attestation: attestation({ expiresAt: '2026-10-31T11:59:59.000Z' }) }), context));
  assert.deepEqual(expired.findings.map((f) => f.reason), ['attestation_expired']);
  const verified = refused(admitPeerAtHandshake(peer({ attestation: { ...attestation(), basis: 'verified' } as unknown as AdmissionAttestation }), context));
  assert.deepEqual(verified.findings.map((f) => f.reason), ['evidence_invalid']);
});

test('an observed address in a restricted place is refused on our side, naming the place and the dataset only', () => {
  const cases: Array<[string, string]> = [
    [RESTRICTED_V4, 'CU'],
    [RESTRICTED_SUBDIVISION_V4, 'UA-09'],
    [RESTRICTED_V6, 'CU'],
    [MAPPED_RESTRICTED, 'CU'],
  ];
  for (const [address, place] of cases) {
    const decision = admitPeerAtHandshake(peer({ address }), context);
    const record = refused(decision);
    assert.deepEqual(record.findings, [{ reason: 'restricted_place', kind: 'observed', source: 'observed_location', place, dataset: 'fake' }]);
    assert.deepEqual(record.geolocation, { mode: 'fake', dataset: 'fake' });
    assertNoAddress(decision);
  }
  assert.equal(admitPeerAtHandshake(peer({ address: SERVED_SUBDIVISION_RANGE_V4 }), context).outcome, 'admitted');
});

test('the refusal record never contains an address, whatever combination refused', () => {
  const decisions = [
    admitPeerAtHandshake(peer({ manifest: manifest({ jurisdiction: 'RU' }), address: RESTRICTED_V4 }), context),
    admitPeerAtHandshake(peer({ attestation: attestation({ hostingCountry: 'IR', hostingRegion: null }), address: RESTRICTED_V6 }), context),
    admitPeerAtHandshake(peer({ manifest: manifest({ territories: ['UA-43'] }), attestation: null, address: MAPPED_RESTRICTED }), context),
    checkAdmission({ service: 'registry_pull', subject: null, observed: connection(RESTRICTED_SUBDIVISION_V4) }, context),
    checkAdmission({ service: 'support', subject: 'support-case-0001', declaredPlaces: ['UA-14'], observed: connection(SERVED_V4) }, context),
  ];
  for (const decision of decisions) {
    refused(decision);
    assertNoAddress(decision);
  }
  // Every finding of the combined case is kept, so a reviewer sees all of them.
  const combined = refused(decisions[0] as AdmissionDecision);
  assert.deepEqual(combined.findings.map((f) => [f.source, f.place]), [['manifest_jurisdiction', 'RU'], ['observed_location', 'CU']]);
  const log = admissionLogEvent(decisions[0] as AdmissionDecision);
  assert.deepEqual(log, { event: 'admission.refused', service: 'federation_handshake', reasons: ['restricted_place'], places: ['CU', 'RU'], sources: ['manifest_jurisdiction', 'observed_location'], datasets: ['declared', 'fake'], at: NOW.toISOString() });
  assert.ok(!('subject' in (log as object)), 'the log event counts; it does not name the subject');
});

test('a strict refusal record rejects an extra field such as an address', () => {
  const record = refused(admitPeerAtHandshake(peer({ address: RESTRICTED_V4 }), context));
  assert.throws(() => AdmissionRefusalRecordSchema.parse({ ...record, address: RESTRICTED_V4 }));
  assert.throws(() => AdmissionRefusalRecordSchema.parse({ ...record, findings: [{ ...record.findings[0], address: RESTRICTED_V4 }] }));
  assert.throws(() => AdmissionRefusalRecordSchema.parse({ ...record, subject: RESTRICTED_V4 }));
  assert.throws(() => AdmissionRefusalRecordSchema.parse({ ...record, subject: RESTRICTED_V6 }));
});

test('a subject label that is an address is refused, not recorded', () => {
  for (const subject of [RESTRICTED_V4, SERVED_V4, RESTRICTED_V6, 'fe80::1%eth0']) {
    const decision = checkAdmission({ service: 'registry_pull', subject, observed: connection(SERVED_V4) }, context);
    const record = refused(decision);
    assert.equal(record.subject, null);
    assert.deepEqual(record.findings.map((f) => f.reason), ['subject_is_address']);
    assertNoAddress(decision);
  }
});

test('the edge-header and ranges-file adapters answer on our side and name their dataset', () => {
  const edge: AdmissionContext = { ...context, geolocation: edgeHeaderGate({ restricted, countryHeader: 'X-Edge-Country', regionHeader: 'X-Edge-Region' }) };
  const iran = refused(admitPeerAtHandshake({ ...peer(), observed: connection(SERVED_V4, { 'X-Edge-Country': 'IR' }) }, edge));
  assert.deepEqual(iran.findings, [{ reason: 'restricted_place', kind: 'observed', source: 'observed_location', place: 'IR', dataset: 'edge-header' }]);
  const crimea = refused(admitPeerAtHandshake({ ...peer(), observed: connection(SERVED_V4, { 'X-Edge-Country': 'UA', 'X-Edge-Region': '43' }) }, edge));
  assert.equal(crimea.findings[0]?.place, 'UA-43');
  assert.equal(admitPeerAtHandshake({ ...peer(), observed: connection(SERVED_V4, { 'X-Edge-Country': 'UA', 'X-Edge-Region': '30' }) }, edge).outcome, 'admitted');

  const table = loadRangeTable(
    {
      format: RANGE_TABLE_FORMAT,
      dataset: 'test-ranges',
      month: '2026-10',
      attribution: 'Synthetic table over documentation ranges',
      codes: ['KP', 'UA-14'],
      v4: [
        [0xcb007100, 0xcb00717f, 0],
        [0xcb007180, 0xcb0071ff, 1],
      ],
      v6: [],
    },
    restricted,
  );
  const ranges: AdmissionContext = { ...context, geolocation: rangesFileGate(table) };
  const kp = refused(admitPeerAtHandshake(peer({ address: '203.0.113.1' }), ranges));
  assert.deepEqual(kp.findings[0], { reason: 'restricted_place', kind: 'observed', source: 'observed_location', place: 'KP', dataset: 'test-ranges-2026-10' });
  assert.deepEqual(kp.geolocation, { mode: 'ranges_file', dataset: 'test-ranges-2026-10' });
  const donetsk = refused(admitPeerAtHandshake(peer({ address: '203.0.113.200' }), ranges));
  assert.equal(donetsk.findings[0]?.place, 'UA-14');
  assert.equal(admitPeerAtHandshake(peer({ address: RESTRICTED_V4 }), ranges).outcome, 'admitted', 'only the configured dataset answers');
});

test('each service requires its evidence; missing required evidence refuses (fail closed)', () => {
  const noAttestation = refused(admitPeerAtHandshake(peer({ attestation: null }), context));
  assert.deepEqual(noAttestation.findings, [{ reason: 'evidence_missing', kind: 'attested', source: null, place: null, dataset: null }]);
  const noObserved = refused(admitPeerAtHandshake(peer({ address: null }), context));
  assert.deepEqual(noObserved.findings.map((f) => [f.reason, f.kind]), [['evidence_missing', 'observed']]);
  const directory = refused(checkAdmission({ service: 'hub_directory', subject: 'build.example.org', observed: connection(SERVED_V4) }, context));
  assert.deepEqual(directory.findings.map((f) => [f.reason, f.kind]), [['evidence_missing', 'declared'], ['evidence_missing', 'attested']]);

  for (const service of ['release_channel', 'registry_pull', 'support', 'hosted_service'] as const) {
    assert.equal(checkAdmission({ service, subject: null, observed: connection(SERVED_V4) }, context).outcome, 'admitted', service);
    assert.equal(refused(checkAdmission({ service, subject: null }, context)).findings[0]?.reason, 'evidence_missing');
    assert.equal(refused(checkAdmission({ service, subject: null, observed: connection(RESTRICTED_V6) }, context)).findings[0]?.place, 'CU');
  }
  // Optional evidence is still judged when presented: a support request that states a restricted place is refused.
  const stated = refused(checkAdmission({ service: 'support', subject: 'support-case-0002', declaredPlaces: ['us', 'UA-09'], observed: connection(SERVED_V4) }, context));
  assert.deepEqual(stated.findings.map((f) => [f.source, f.place]), [['declared_place', 'UA-09']]);
  const statedJunk = refused(checkAdmission({ service: 'support', subject: 'support-case-0003', declaredPlaces: ['Crimea'], observed: connection(SERVED_V4) }, context));
  assert.equal(statedJunk.findings[0]?.reason, 'evidence_invalid');
});

test('an unconfigured geolocation port refuses where an observed place is required; an attested upstream gate is trusted', () => {
  const unconfigured = refused(admitPeerAtHandshake(peer(), { ...context, geolocation: unconfiguredGate() }));
  assert.deepEqual(unconfigured.findings.map((f) => f.reason), ['geolocation_unconfigured']);
  assert.deepEqual(unconfigured.geolocation, { mode: 'unconfigured', dataset: null });
  assert.equal(admitPeerAtHandshake(peer({ address: RESTRICTED_V4 }), { ...context, geolocation: upstreamGate() }).outcome, 'admitted', 'the upstream check refuses before traffic arrives');
});

test('an unreadable manifest refuses instead of being skipped', () => {
  const missing = { node: 'build.example.org', operator: { country: 'US' }, hubs: [] } as unknown as AdmissionManifest;
  assert.deepEqual(refused(admitPeerAtHandshake(peer({ manifest: missing }), context)).findings.map((f) => f.reason), ['evidence_invalid']);
  const word = refused(admitPeerAtHandshake(peer({ manifest: manifest({ jurisdiction: 'Russia' }) }), context));
  assert.deepEqual(word.findings.map((f) => f.reason), ['evidence_invalid']);
  const badTerritory = refused(admitPeerAtHandshake(peer({ manifest: manifest({ territories: ['US', ':austin'] }) }), context));
  assert.deepEqual(badTerritory.findings.map((f) => f.reason), ['evidence_invalid']);
});

test('negative authorization: nothing a caller passes admits a restricted party', () => {
  // Override-looking fields on the request, the manifest or the attestation are ignored.
  const forged = {
    ...peer({ address: RESTRICTED_V4 }),
    allow: true,
    bypass: 'staff',
    policy: { requires: [] },
  } as unknown as ReturnType<typeof peer>;
  assert.equal(admitPeerAtHandshake(forged, context).outcome, 'refused');
  const exception = { ...manifest({ jurisdiction: 'RU' }), exception: 'owner-approved', allowlisted: true } as AdmissionManifest;
  assert.equal(admitPeerAtHandshake(peer({ manifest: exception }), context).outcome, 'refused');
  assert.equal(checkAdmission({ service: 'registry_pull', subject: null, observed: connection(RESTRICTED_V4), requires: [] } as unknown as Parameters<typeof checkAdmission>[0], context).outcome, 'refused');

  // One restricted piece of evidence is enough, whatever the others say.
  assert.equal(admitPeerAtHandshake(peer({ attestation: attestation({ hostingCountry: 'RU', hostingRegion: null }) }), context).outcome, 'refused');

  // The policy table is frozen and the service is a closed set.
  assert.ok(Object.isFrozen(ADMISSION_POLICIES));
  for (const service of ADMISSION_SERVICES) {
    assert.ok(Object.isFrozen(ADMISSION_POLICIES[service]));
    assert.ok(Object.isFrozen(ADMISSION_POLICIES[service].requires));
    assert.ok(ADMISSION_POLICIES[service].requires.includes('observed'), `${service} always judges the connection on our side`);
  }
  assert.throws(() => {
    (ADMISSION_POLICIES as unknown as Record<string, unknown>).federation_handshake = { requires: [] };
  }, TypeError);
  assert.throws(() => {
    (ADMISSION_POLICIES.federation_handshake.requires as unknown as string[]).length = 0;
  }, TypeError);
  assert.throws(() => checkAdmission({ service: 'trusted_partner' as never, subject: null, observed: connection(RESTRICTED_V4) }, context));
});

test('the check does not mutate its inputs', () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) deepFreeze(item);
      Object.freeze(value);
    }
    return value;
  };
  const input = deepFreeze(peer({ manifest: manifest({ territories: ['US', 'UA-43:simferopol'] }) }));
  assert.equal(admitPeerAtHandshake(input, context).outcome, 'refused');
});

test('concurrency: parallel handshakes keep their own evidence and results', async () => {
  const addresses = [SERVED_V4, RESTRICTED_V4, SERVED_SUBDIVISION_RANGE_V4, RESTRICTED_SUBDIVISION_V4, RESTRICTED_V6, '203.0.113.77'];
  const jurisdictions = ['US', 'US', 'IR', 'US', 'UZ', 'GE'];
  const runs = Array.from({ length: 240 }, (_, i) => ({ i, address: addresses[i % addresses.length] as string, jurisdiction: jurisdictions[i % jurisdictions.length] as string }));
  const decisions = await Promise.all(
    runs.map(
      (run) =>
        new Promise<{ run: (typeof runs)[number]; decision: AdmissionDecision }>((resolve) => {
          setImmediate(() => resolve({ run, decision: admitPeerAtHandshake(peer({ manifest: manifest({ node: `node-${run.i}.example.org`, jurisdiction: run.jurisdiction }), address: run.address }), context) }));
        }),
    ),
  );
  let refusedCount = 0;
  for (const { run, decision } of decisions) {
    const restrictedAddress = run.address === RESTRICTED_V4 || run.address === RESTRICTED_SUBDIVISION_V4 || run.address === RESTRICTED_V6;
    const restrictedJurisdiction = run.jurisdiction === 'IR';
    assert.equal(decision.outcome, restrictedAddress || restrictedJurisdiction ? 'refused' : 'admitted', `run ${run.i}`);
    if (decision.outcome === 'refused') {
      refusedCount += 1;
      assert.equal(decision.record.subject, `node-${run.i}.example.org`);
      assert.equal(decision.record.findings.some((f) => f.source === 'manifest_jurisdiction'), restrictedJurisdiction);
      assert.equal(decision.record.findings.some((f) => f.source === 'observed_location'), restrictedAddress);
      assertNoAddress(decision);
    }
  }
  // Index 0..5 repeats: 1 (CU v4), 2 (IR jurisdiction), 3 (UA-09), 4 (CU v6) refuse; 0 and 5 are admitted.
  assert.equal(refusedCount, 160);
});

test('FED-001 handshake contract: a fake receiving service stores refusal records without addresses', () => {
  const stored: AdmissionRefusalRecord[] = [];
  const peers: string[] = [];
  function receiveHandshake(manifestJson: string, attestationSummary: AdmissionAttestation | null, observed: GateRequest): { status: number; code?: string } {
    const decision = admitPeerAtHandshake({ manifest: JSON.parse(manifestJson) as AdmissionManifest, attestation: attestationSummary, observed }, context);
    if (decision.outcome === 'refused') {
      stored.push(decision.record);
      return { status: 451, code: FEDERATION_PEER_RESTRICTED };
    }
    peers.push(JSON.parse(manifestJson).node);
    return { status: 200 };
  }
  assert.deepEqual(receiveHandshake(JSON.stringify(manifest()), attestation(), connection(SERVED_V4)), { status: 200 });
  assert.deepEqual(receiveHandshake(JSON.stringify(manifest({ node: 'crimea.example.net', territories: ['UA-43'] })), attestation(), connection(SERVED_V4)), { status: 451, code: 'federation.peer_restricted' });
  assert.deepEqual(receiveHandshake(JSON.stringify(manifest({ node: 'hidden.example.net' })), attestation(), connection(RESTRICTED_V6)), { status: 451, code: 'federation.peer_restricted' });
  assert.deepEqual(receiveHandshake(JSON.stringify(manifest({ node: 'attested.example.net' })), attestation({ hostingCountry: 'KP', hostingRegion: null }), connection(SERVED_V4)), { status: 451, code: 'federation.peer_restricted' });
  assert.deepEqual(peers, ['build.example.org']);
  assert.deepEqual(stored.map((r) => [r.subject, r.findings[0]?.source, r.findings[0]?.place]), [
    ['crimea.example.net', 'manifest_territory', 'UA-43'],
    ['hidden.example.net', 'observed_location', 'CU'],
    ['attested.example.net', 'attested_hosting', 'KP'],
  ]);
  const serialized = JSON.stringify(stored);
  for (const address of ALL_TEST_ADDRESSES) assert.ok(!serialized.includes(address));
});
