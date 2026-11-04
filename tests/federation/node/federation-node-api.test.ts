import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { computeDigest, HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { createApp, type CreatedApp } from '../../../apps/api/src/app.js';
import { fakeNodeKeySealer } from '../../../apps/api/src/modules/federation/node/crypto.js';
import { FederationNodeService, REFRESH_LOCK } from '../../../apps/api/src/modules/federation/node/federation-node.service.js';
import { FederationRefreshTimer } from '../../../apps/api/src/modules/federation/node/federation-node.module.js';
import { federationPeers } from '../../../packages/data/src/repositories/federation-node.js';
import { signRequest, verifySignedMessage } from '../../../apps/api/src/modules/federation/node/http-signatures.js';
import { MAX_PEER_BODY, PeerUnreachableError } from '../../../apps/api/src/modules/federation/node/transport.js';
import { keyRotationDigestInput, peeringLevelDigestInput } from '../../../apps/api/src/modules/federation/node/schemas.js';
import { canonicalize } from '../../../packages/contracts/src/common/canonical.js';
import { utf8Encode } from '../../../packages/contracts/src/common/encoding.js';
import {
  HandshakeResponseSchema, keyChainProblems, nodeManifestSchema, rotationStatementFor, signDocument, verifyManifestSignatures, type NodeKey, type NodeManifest,
} from '../../../packages/contracts/src/federation.js';
import { verifyEd25519 } from '../../../apps/api/src/modules/federation/node/crypto.js';
import { Client, SKIP_REASON, startHarness, type Response } from '../../backend/helpers/app.js';
import { codeNow } from '../../backend/second-factor/helpers.js';
import { addLogins, enrolNow, expectRefusal, PASSWORD, signIn } from '../../admin/helpers.js';
import { attestationSummary, CITY, cityKeyChain, manifest as fixtureManifest, NODE_SIGNERS, publicKeyB64, restricted, RFC8032, signerFor } from '../protocol/fixtures.js';
import { asManifest, austinPeer, buildWorld, FakePeerTransport, forgedSigner, HUB_SLUG, insertHub, OUR_HOST, PEER_HOST, PEER_HUB, peerHandshake, RESTRICTED_ADDRESS, SERVED_ADDRESS, setPeerManifest, type Key } from './helpers.js';

// Weight 2: two apps' pools and concurrent handshakes share the file's slot.
const h = await startHarness('federation_node_api');
const emailOf = (key: Key) => `fed-${key.toLowerCase()}@example.invalid`;
type Staff = 'founder' | 'operator' | 'owner' | 'officer' | 'moderator';
const STAFF: Staff[] = ['founder', 'operator', 'owner', 'officer', 'moderator'];
const MANIFEST_URL = '/.well-known/trustwork/manifest.json';
const HANDSHAKE_URL = '/federation/v1/handshake';
const ADMIN = '/v1/admin/federation';
/** A manifest for another synthetic node, derived from the Austin fixture and signed with the given key (default a1). */
function manifestFor(host: string, overrides: Record<string, unknown> = {}, signer: { keyId: string; sign: (m: Uint8Array) => Uint8Array } = { keyId: 'a1', sign: signerFor(RFC8032.test3) }): Record<string, unknown> {
  const base = fixtureManifest({ node: CITY }) as NodeManifest;
  const unsigned: Record<string, unknown> = { ...base, node: host, operator: { ...base.operator, abuseContact: `mailto:abuse@${host}`, takedownContact: `https://${host}/legal/takedown` }, ...overrides };
  delete unsigned['signature'];
  return signDocument('manifest', unsigned, signer.keyId, signer.sign) as unknown as Record<string, unknown>;
}
/** An attestation of the right shape (365 days of validity) that has already expired. */
const EXPIRED_ATTESTATION = { attestedAt: '2025-09-01T00:00:00.000Z', expiresAt: '2026-09-01T00:00:00.000Z' };

interface Reverified { peer: string; keyId: string; since: string }

test('federation node API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const { w, a } = await buildWorld(h.db.admin, h.pool);
  await addLogins(h, ([...STAFF, 'outsider'] as const).map((k) => [w.people[k], emailOf(k)]));
  const now = () => h.clock.now();
  const transport = new FakePeerTransport(now);
  const austin = austinPeer(transport, now);
  const reverified: Reverified[] = [];
  const app: CreatedApp = await createApp({
    env: {
      API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: w.hubId,
      MAIL_SECRET_KEY: randomBytes(32).toString('hex'), TRUSTWORK_JURISDICTION_GATE: 'fake',
    },
    pool: h.pool, clock: h.clock,
    federation: { sealer: fakeNodeKeySealer(), transport, peerDeadlineMs: 500, inboundFetchCooldownMs: 1_000, reverification: { reverify: async (peer, keyId, since) => { reverified.push({ peer, keyId, since: since.toISOString() }); return 3; } } },
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
  const service = app.app.get(FederationNodeService);
  t.after(async () => { await app.close(); await h.close(); });

  const clients = {} as Record<Staff | 'outsider', Client>;
  const secrets = {} as Record<Staff, Buffer>;
  for (const key of [...STAFF, 'outsider'] as const) {
    clients[key] = new Client(app);
    await signIn(clients[key], emailOf(key));
    if (key !== 'outsider') secrets[key] = await enrolNow(h, clients[key]);
  }
  const elevate = async (key: Staff) => {
    h.clock.advance(30_000);
    assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    const response = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key]) } }, { idempotencyKey: null });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  const command = (key: Staff | 'outsider', url: string, body: Record<string, unknown> = {}): Promise<Response> => {
    const idempotencyKey = `fed-${randomUUID()}`;
    return clients[key].post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey, reason: 'Synthetic federation console action', ...body }, { idempotencyKey });
  };
  const ok = (response: Response, status = 200) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    return response.body as Record<string, unknown> & { result: { outcome: string; approvalRequestId: string | null; objectId: string; revision: number } };
  };
  /** A mesh request as a peer sends it: raw bytes, the signature fields, no cookie, from a documentation address. */
  const mesh = async (bytes: Uint8Array, fields: Record<string, string>, remoteAddress = SERVED_ADDRESS) => {
    const response = await app.fastify.inject({ method: 'POST', url: HANDSHAKE_URL, headers: { ...fields, 'user-agent': 'trustwork-peer/1.0' }, payload: Buffer.from(bytes), remoteAddress });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown>, raw: response.rawPayload as Buffer, header: (name: string) => (response.headers[name] as string | undefined) ?? null };
  };
  const ourChain = async (): Promise<NodeKey[]> => asManifest(ok(await new Client(app).get(MANIFEST_URL)) as unknown).keys.chain;
  const count = async (query: string, params: unknown[] = []): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;
  const identityBody = { host: OUR_HOST, operatorName: 'Synthetic San Diego Builders Association', registration: { kind: 'us_ein', value: '00-0000000' }, abuseContact: `mailto:abuse@${OUR_HOST}`, takedownContact: `https://${OUR_HOST}/legal/takedown`, jurisdiction: 'US-CA' };

  await t.test('negative: no manifest before the node is set up; the console refuses anonymous, participants and unelevated staff', async () => {
    expectRefusal(await new Client(app).get(MANIFEST_URL), 404, 'access.not_found', 'node_not_configured');
    expectRefusal(await new Client(app).get(`${ADMIN}/node`), 401, 'auth.session_invalid');
    expectRefusal(await clients.outsider.get(`${ADMIN}/node`), 403, 'access.forbidden', 'staff');
    expectRefusal(await command('outsider', `${ADMIN}/node`, identityBody), 403, 'access.forbidden', 'staff');
    expectRefusal(await clients.operator.get(`${ADMIN}/node`), 403, 'access.forbidden', 'elevation');
    expectRefusal(await command('operator', `${ADMIN}/node`, identityBody), 403, 'access.forbidden', 'elevation');
  });

  for (const key of STAFF) await elevate(key);

  await t.test('the node identity and genesis key: node staff only, a restricted jurisdiction refused, the seed sealed and never readable', async () => {
    expectRefusal(await command('owner', `${ADMIN}/node`, identityBody), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await command('officer', `${ADMIN}/node`, identityBody), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await command('operator', `${ADMIN}/node`, { ...identityBody, jurisdiction: 'RU' }), 422, 'validation.schema', 'restricted_place');
    expectRefusal(await command('operator', `${ADMIN}/node`, { ...identityBody, licences: { person_profiles: 'open_data_with_attribution' } }), 422, 'validation.schema', 'licence_too_loose');
    const created = ok(await command('operator', `${ADMIN}/node`, identityBody), 201) as unknown as { result: { outcome: string }; keys: NodeKey[] };
    assert.equal(created.result.outcome, 'applied');
    assert.deepEqual(created.keys.map((k) => [k.keyId, k.rotation, k.retiredAt]), [['k1', null, null]]);
    expectRefusal(await command('operator', `${ADMIN}/node`, identityBody), 409, 'validation.revision_conflict', 'identity_exists');
    // The sealed seed is in a table no runtime role can read; the public chain is readable by anyone.
    await assert.rejects(h.pool.query('SELECT * FROM trustwork.node_key_secret'), /permission denied/);
    const secret = (await h.db.admin.query<{ ciphertext: Buffer; kek_id: string }>('SELECT ciphertext, kek_id FROM trustwork.node_key_secret')).rows[0]!;
    assert.equal(secret.kek_id, 'kms:fake-node-kek');
    assert.notEqual(secret.ciphertext.toString('base64url'), created.keys[0]!.publicKey);
    const denied = (await h.db.admin.query("SELECT action, outcome FROM trustwork.admin_audit_event WHERE actor_person_id = $1 AND outcome = 'denied'", [w.people.officer])).rows;
    assert.deepEqual(denied, [{ action: 'federation.node_initialized', outcome: 'denied' }]);
  });

  await t.test('the manifest is served signed at the well-known URL, validates under the restricted list and names the hub by slug', async () => {
    const response = await new Client(app).get(MANIFEST_URL);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.headers['cache-control'], 'public, max-age=300');
    const manifest = nodeManifestSchema(restricted).parse(response.body);
    assert.ok(verifyManifestSignatures(manifest, verifyEd25519), 'the manifest signature verifies against its own chain');
    assert.equal(manifest.node, OUR_HOST);
    assert.equal(manifest.operator.country, 'US');
    assert.equal(manifest.jurisdiction, 'US-CA');
    assert.deepEqual(manifest.hubs, [{ id: HUB_SLUG, territories: ['US', 'US-CA', 'US-CA:san-diego'], languages: ['en', 'es'] }]);
    assert.equal(manifest.deploymentAttestation.hostingRegion, 'US-VA');
    assert.deepEqual(manifest.peeringPolicy.offered, ['syndicate', 'trust_verifications', 'deal_routing', 'identity']);
    const again = await new Client(app).get(MANIFEST_URL);
    assert.deepEqual(again.body, response.body, 'the same document is served while nothing changed');
    assert.equal(await count('SELECT 1 FROM trustwork.node_manifest'), 1);
    const view = ok(await clients.operator.get(`${ADMIN}/node`)) as unknown as { identity: { host: string }; manifests: { version: number }[] };
    assert.equal(view.identity.host, OUR_HOST);
    assert.deepEqual(view.manifests.map((m) => m.version), [1]);
  });

  await t.test('first contact: a handshake from a host this node does not hold is refused without a lookup, a fetch or a row, whatever name it carries; a person\'s peering request is what makes a host known; the mesh route is rate-limited', async () => {
    const resolves = transport.resolves.length;
    const fetches = transport.manifestFetches.length;
    const rows = async () => ({ peers: await count('SELECT 1 FROM trustwork.federation_peer'), refusals: await count('SELECT 1 FROM trustwork.admission_refusal'), nonces: await count('SELECT 1 FROM trustwork.federation_nonce'), records: await count('SELECT 1 FROM trustwork.peering_record') });
    const before = await rows();
    // Austin's genuine, well-formed handshake before anyone here asked for Austin: a clean refusal, nothing else.
    const early = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now() });
    const refused = await mesh(early.body, early.fields);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'federation.not_peered');
    assert.ok(refused.header('signature-input'), 'the refusal is signed');
    // A flood of invented names, each with its own self-signed manifest under its own key: nothing resolved, fetched or stored, and the cooldown table stays empty.
    const stranger = { keyId: 'a1', sign: signerFor(RFC8032.test1) };
    for (let i = 0; i < 25; i++) {
      const host = `n${i}.attacker.example`;
      const hs = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now(), manifest: manifestFor(host, {}, stranger), signer: stranger, bodyOverride: { from: host } });
      assert.equal((await mesh(hs.body, hs.fields)).body.code, 'federation.not_peered', host);
    }
    assert.equal(transport.resolves.length, resolves, 'no stranger is resolved');
    assert.equal(transport.manifestFetches.length, fetches, 'no stranger is fetched');
    assert.deepEqual(await rows(), before, 'no row of any kind');
    assert.equal((service as unknown as { inboundFetches: Map<string, number> }).inboundFetches.size, 0, 'no cooldown entry for a stranger');
    // The only path that contacts a new host: a person of a hub here requests peering. Austin is resolved, judged, fetched
    // from its origin and held; the fake peer answers; the record is ended again so Austin's own request below starts clean.
    const requested = ok(await command('owner', `${ADMIN}/peerings`, { localHubId: w.hubId, peerNode: PEER_HOST, peerHubId: PEER_HUB, level: 'syndicate', approvalId: null }), 201) as unknown as { record: { id: string; state: string } };
    assert.equal(transport.manifestFetches.length, fetches + 1);
    assert.deepEqual(transport.connections.slice(-2).map((c) => c.address), [SERVED_ADDRESS, SERVED_ADDRESS], 'the fetch and the handshake went to the judged address');
    assert.equal(await count("SELECT 1 FROM trustwork.federation_peer WHERE peer_node = $1 AND admission_state = 'admitted'", [CITY]), 1);
    const row = (await h.db.admin.query<{ state: string; phase: string; revision: number }>('SELECT state, phase, revision FROM trustwork.peering_record WHERE id = $1', [requested.record.id])).rows[0]!;
    assert.deepEqual([row.state, row.phase], ['pending_approval', 'awaiting_peer'], 'the peer\'s person has not accepted yet');
    ok(await command('owner', `${ADMIN}/peerings/${requested.record.id}/end`, { expectedRevision: row.revision }));
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: false, code: 'federation.not_peered' });
    // The mesh route carries the per-address burst limit of the auth routes (here 2 per minute): the third request is answered 429 before anything is read (unsigned probes, so the two that get through write nothing).
    const limited = await createApp({
      env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', TRUSTWORK_HUB_ID: w.hubId, MAIL_SECRET_KEY: randomBytes(32).toString('hex'), TRUSTWORK_JURISDICTION_GATE: 'fake', AUTH_RATE_LIMIT_PER_MINUTE: '2' },
      pool: h.pool, clock: h.clock, federation: { sealer: fakeNodeKeySealer(), transport }, logSink: () => undefined,
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const hs = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now() });
        const r = await limited.fastify.inject({ method: 'POST', url: HANDSHAKE_URL, headers: { 'content-type': 'application/json', 'user-agent': 'trustwork-peer/1.0' }, payload: Buffer.from(hs.body), remoteAddress: SERVED_ADDRESS });
        statuses.push(r.statusCode);
        if (i === 2) assert.equal((JSON.parse(r.body) as { code: string }).code, 'auth.throttled');
      }
      assert.deepEqual(statuses, [401, 401, 429]);
      assert.deepEqual(await rows(), { ...before, peers: before.peers + 1, records: before.records + 1 }, 'only the held peer and the ended record of the request were added; the probes wrote nothing');
    } finally {
      await limited.close();
    }
  });

  await t.test('unlaunched hubs: a draft and a preparing hub are absent from the manifest, and a handshake or request naming them is refused like an unknown hub', async () => {
    const draftId = (await a.createHub('synthetic-sd-draft')).hub_id;
    const preparingId = await insertHub(h.db.admin, { nodeId: w.nodeId, createdBy: w.people.operator, slug: 'synthetic-sd-preparing', lifecycle: 'preparing' });
    await a.assignSensitive({ personId: w.people.owner, role: 'hub-owner', scope: { kind: 'hub', hubId: draftId } });
    const manifest = nodeManifestSchema(restricted).parse((await new Client(app).get(MANIFEST_URL)).body);
    assert.deepEqual(manifest.hubs.map((x) => x.id), [HUB_SLUG], 'only launched hubs are published');
    assert.ok(!JSON.stringify(manifest).includes('synthetic-sd-draft') && !JSON.stringify(manifest).includes('synthetic-sd-preparing'));
    // A handshake naming the draft, the preparing or an unknown slug gets the same answer.
    const answers = [] as { status: number; code: unknown }[];
    for (const slug of ['synthetic-sd-draft', 'synthetic-sd-preparing', 'no-such-hub']) {
      const hs = peerHandshake({ to: OUR_HOST, responderHub: slug, now: now() });
      const r = await mesh(hs.body, hs.fields);
      answers.push({ status: r.status, code: r.body.code });
    }
    assert.deepEqual(answers, Array.from({ length: 3 }, () => ({ status: 421, code: 'federation.not_addressed' })));
    assert.equal(await count("SELECT 1 FROM trustwork.peering_record WHERE state <> 'ended'"), 0);
    // A request from the draft or the preparing hub gets the answer an unknown hub gets.
    for (const hubId of [draftId, preparingId, randomUUID()]) {
      expectRefusal(await command('owner', `${ADMIN}/peerings`, { localHubId: hubId, peerNode: PEER_HOST, peerHubId: PEER_HUB, level: 'syndicate', approvalId: null }), 404, 'access.not_found');
    }
    assert.equal(await count("SELECT 1 FROM trustwork.peering_record WHERE state <> 'ended'"), 0);
  });

  await t.test('handshake: unsigned, forged, replayed, expired, tampered and misaddressed requests are refused with the protocol codes; no record is written', async () => {
    const good = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now() });
    // Unsigned: answered and counted, nothing fetched, nothing written.
    const fetchesBefore = transport.manifestFetches.length;
    const refusalsBefore = await count('SELECT 1 FROM trustwork.admission_refusal');
    const unsigned = await mesh(good.body, { 'content-type': 'application/json' });
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.body.code, 'federation.signature_invalid');
    assert.ok(unsigned.header('signature-input'), 'our refusal is signed with the node key');
    assert.equal(transport.manifestFetches.length, fetchesBefore, 'an unsigned request fetches nothing');
    // Forged: another key under the peer's label. The trust anchor is the peer's own well-known manifest, so the forgery fails
    // against the real chain, and its nonce is not remembered: the peer's genuine request with the same nonce is no replay.
    const nonce = randomBytes(24).toString('base64url');
    const forged = peerHandshake({ to: OUR_HOST, responderHub: 'no-such-hub', now: now(), signer: forgedSigner, nonce });
    assert.equal((await mesh(forged.body, forged.fields)).body.code, 'federation.signature_invalid');
    const genuine = peerHandshake({ to: OUR_HOST, responderHub: 'no-such-hub', now: now(), nonce });
    assert.equal((await mesh(genuine.body, genuine.fields)).body.code, 'federation.not_addressed', 'the forged request did not poison the nonce');
    assert.equal((await mesh(genuine.body, genuine.fields)).body.code, 'federation.replay');
    // Expired: signed ten minutes ago.
    const stale = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: new Date(now().getTime() - 10 * 60_000) });
    const expired = await mesh(stale.body, stale.fields);
    assert.equal(expired.status, 401);
    assert.equal(expired.body.code, 'federation.clock_skew');
    // Tampered: the bytes differ from the signed digest.
    const tampered = await mesh(utf8Encode(Buffer.from(good.body).toString('utf8').replace('"requestedLevel":"syndicate"', '"requestedLevel":"identity"')), good.fields);
    assert.equal(tampered.status, 422);
    assert.equal(tampered.body.code, 'federation.digest_mismatch');
    // Misaddressed: another node's name in `to`.
    const other = peerHandshake({ to: 'other.example.org', responderHub: HUB_SLUG, now: now() });
    assert.equal((await mesh(other.body, other.fields)).body.code, 'federation.not_addressed');
    // Unknown hub on our side.
    const noHub = peerHandshake({ to: OUR_HOST, responderHub: 'no-such-hub', now: now() });
    assert.equal((await mesh(noHub.body, noHub.fields)).body.code, 'federation.not_addressed');
    // An unknown key label cannot force a fetch per request: the shape checks come first (a stale forged request fetches
    // nothing), and an inbound request makes this node fetch a host's manifest at most once per cooldown.
    const unknownLabel = { keyId: 'zz', sign: signerFor(RFC8032.test1) };
    const fetchesAtStart = transport.manifestFetches.length;
    const staleUnknown = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: new Date(now().getTime() - 10 * 60_000), signer: unknownLabel });
    assert.equal((await mesh(staleUnknown.body, staleUnknown.fields)).body.code, 'federation.clock_skew');
    assert.equal(transport.manifestFetches.length, fetchesAtStart, 'a stale request with an unknown label fetches nothing');
    const freshUnknown = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now(), signer: unknownLabel });
    assert.equal((await mesh(freshUnknown.body, freshUnknown.fields)).body.code, 'federation.key_unknown');
    const afterFirst = transport.manifestFetches.length;
    assert.ok(afterFirst <= fetchesAtStart + 1, 'at most one fetch');
    for (let i = 0; i < 5; i++) {
      const again = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now(), signer: unknownLabel });
      assert.equal((await mesh(again.body, again.fields)).body.code, 'federation.key_unknown');
    }
    assert.equal(transport.manifestFetches.length, afterFirst, 'repeated unknown labels fetch nothing more within the cooldown');
    assert.equal(await count("SELECT 1 FROM trustwork.peering_record WHERE state <> 'ended'"), 0);
    assert.equal(await count('SELECT 1 FROM trustwork.admission_refusal'), refusalsBefore, 'no refusal is written against a peer by an unverified request');
    // The only peer row came from the peer's own origin, fetched for the person's request, never from a request body.
    assert.equal((await h.db.admin.query<{ d: string }>('SELECT manifest_digest AS d FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]?.d, computeDigest(fixtureManifest({ node: CITY })).value);
  });

  await t.test('handshake: a peer declaring a restricted place, an expired attestation or connecting from a restricted place is refused with 451 and only a refusal record', async () => {
    const refusalsBefore = await count('SELECT 1 FROM trustwork.admission_refusal');
    // Declared: the peer's own origin serves a manifest naming a restricted jurisdiction. Judged on the fetched manifest.
    setPeerManifest(austin, fixtureManifest({ node: CITY, jurisdiction: 'RU' }));
    await assert.rejects(service.refreshPeer(CITY, 'refresh'), (e: Error & { code?: string }) => e.code === 'federation.peer_restricted');
    // A handshake carrying that manifest is refused as well; the body is never the trust anchor and nothing more is written.
    const restrictedManifest = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now(), manifest: fixtureManifest({ node: CITY, jurisdiction: 'RU' }) });
    const refused = await mesh(restrictedManifest.body, restrictedManifest.fields);
    assert.ok([451, 422].includes(refused.status), JSON.stringify(refused.body));
    assert.ok(!JSON.stringify(refused.body).includes('RU'), 'no finding is echoed');
    // Attested: an expired attestation in the served manifest.
    setPeerManifest(austin, fixtureManifest({ node: CITY, attestation: EXPIRED_ATTESTATION }));
    assert.equal((await service.refreshPeer(CITY, 'refresh')).admission_state, 'refused');
    setPeerManifest(austin, fixtureManifest({ node: CITY }));
    assert.equal((await service.refreshPeer(CITY, 'refresh')).admission_state, 'admitted');
    // Observed: the connection comes from a restricted documentation range (the service judges it after the door; the door itself refuses too).
    const fromRestricted = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now() });
    const observed = await service.receiveHandshake({ method: 'POST', url: HANDSHAKE_URL, header: (name) => fromRestricted.fields[name] ?? null, body: JSON.parse(Buffer.from(fromRestricted.body).toString()), rawBody: fromRestricted.body, address: RESTRICTED_ADDRESS, requestId: 'req-observed' });
    assert.equal(observed.status, 451, JSON.stringify(observed.body));
    assert.ok(observed.fields?.signature, 'the refusal is signed');
    const refusals = (await h.db.admin.query<{ subject: string; findings: { reason: string; source: string | null; place: string | null; dataset: string | null }[] }>('SELECT subject, findings FROM trustwork.admission_refusal ORDER BY created_at')).rows.slice(refusalsBefore);
    assert.equal(refusals.length, 3);
    assert.ok(refusals.every((r) => r.subject === CITY));
    assert.ok(refusals[0]!.findings.some((f) => f.reason === 'restricted_place' && f.source === 'manifest_jurisdiction' && f.place === 'RU' && f.dataset === 'declared'));
    assert.ok(refusals[1]!.findings.some((f) => f.reason === 'attestation_expired'));
    assert.ok(refusals[2]!.findings.some((f) => f.source === 'observed_location' && f.dataset === 'fake'));
    assert.ok(!JSON.stringify(refusals).includes(RESTRICTED_ADDRESS) && !JSON.stringify(refusals).includes(SERVED_ADDRESS), 'refusal records hold no address');
    assert.equal(await count("SELECT 1 FROM trustwork.peering_record WHERE state <> 'ended'"), 0);
    // Compliance readers see the records; hub staff without the permission do not.
    const seen = ok(await clients.officer.get(`${ADMIN}/refusals`)) as unknown as { items: unknown[] };
    assert.ok(seen.items.length >= 3);
    assert.deepEqual(ok(await clients.moderator.get(`${ADMIN}/refusals`)), { items: [] });
  });

  let incomingId = '';
  await t.test('handshake: a valid request from the Austin peer is admitted on all three kinds of evidence, answered with a signed pending response, and creates an incoming record a person must accept', async () => {
    // The observed refusal above left the peer refused; a handshake lifts nothing by itself, but once the cooldown passed it
    // makes this node fetch the origin again, and that fetch passes.
    const fetches = transport.manifestFetches.length;
    const probe = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now() });
    const stillRefused = await mesh(probe.body, probe.fields);
    assert.equal(stillRefused.status, 451, 'within the cooldown no fetch, and a handshake lifts nothing');
    assert.equal(transport.manifestFetches.length, fetches);
    h.clock.advance(1_500);
    const good = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now() });
    const response = await mesh(good.body, good.fields);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(transport.manifestFetches.length, fetches + 1, 'the fetch from the origin lifted the refusal');
    const answer = HandshakeResponseSchema.parse(response.body);
    assert.equal(answer.outcome, 'admitted');
    if (answer.outcome !== 'admitted') return;
    assert.equal(answer.level, 'syndicate');
    assert.equal(answer.state, 'pending_approval');
    assert.equal(answer.nonce, good.request.nonce);
    const verified = await verifySignedMessage({ status: 200, body: new Uint8Array(response.raw), header: response.header }, await ourChain(), now(), null);
    assert.equal(verified.ok, true, JSON.stringify(verified));
    // A repeated handshake is idempotent (no second record); a replayed one is refused.
    const replay = await mesh(good.body, good.fields);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.code, 'federation.replay');
    // The exact bytes are what the digest covers: a non-canonical body (a space after the brace) verifies because the raw bytes are checked.
    const again = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now() });
    const spaced = utf8Encode(Buffer.from(again.body).toString('utf8').replace('{', '{ '));
    const spacedFields = signRequest({ method: 'POST', targetUri: `https://${OUR_HOST}${HANDSHAKE_URL}`, body: spaced, signer: { keyId: NODE_SIGNERS[CITY]!.keyId, sign: NODE_SIGNERS[CITY]!.sign }, now: now() });
    const repeated = await mesh(spaced, spacedFields);
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    assert.equal(await count("SELECT 1 FROM trustwork.peering_record WHERE state <> 'ended'"), 1, 'a repeated handshake is idempotent');
    const peer = (await h.db.admin.query<{ admission_state: string; admission_judged: string[]; admission_trigger: string }>('SELECT admission_state, admission_judged, admission_trigger FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!;
    assert.deepEqual(peer, { admission_state: 'admitted', admission_judged: ['declared', 'attested', 'observed'], admission_trigger: 'handshake' });
    const listed = ok(await clients.owner.get(`${ADMIN}/peerings`)) as unknown as { items: { id: string; direction: string; state: string; phase: string; level: string; peerAcceptedAt: string | null; requestedBy: string | null }[] };
    assert.equal(listed.items.length, 2, 'the ended record of the first request stays in history');
    const records = { items: listed.items.filter((r) => r.state !== 'ended') };
    assert.equal(records.items.length, 1);
    assert.deepEqual([records.items[0]!.direction, records.items[0]!.state, records.items[0]!.phase, records.items[0]!.level, records.items[0]!.requestedBy], ['incoming', 'pending_approval', 'awaiting_acceptance', 'syndicate', null]);
    assert.ok(records.items[0]!.peerAcceptedAt);
    incomingId = records.items[0]!.id;
    assert.deepEqual(ok(await clients.moderator.get(`${ADMIN}/peerings`)), { items: [] }, 'row-level security: no federation permission, no rows');
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: false, code: 'federation.not_peered' }, 'nothing flows before the double opt-in');
  });

  await t.test('acceptance: a person of the hub accepts at syndicate; the acceptance handshake goes back and the record activates on the peer\'s signed answer', async () => {
    // Existence never leaks: staff without a federation permission see no record at all.
    expectRefusal(await command('moderator', `${ADMIN}/peerings/${incomingId}/accept`, { expectedRevision: 1, level: 'syndicate', approvalId: null }), 404, 'access.not_found');
    expectRefusal(await command('outsider', `${ADMIN}/peerings/${incomingId}/accept`, { expectedRevision: 1, level: 'syndicate', approvalId: null }), 403, 'access.forbidden', 'staff');
    expectRefusal(await command('owner', `${ADMIN}/peerings/${incomingId}/accept`, { expectedRevision: 1, level: 'identity', approvalId: null }), 422, 'validation.schema', 'level_above_request');
    expectRefusal(await command('owner', `${ADMIN}/peerings/${incomingId}/accept`, { expectedRevision: 9, level: 'syndicate', approvalId: null }), 409, 'validation.revision_conflict', 'revision_conflict');
    const before = transport.handshakes.length;
    const accepted = ok(await command('owner', `${ADMIN}/peerings/${incomingId}/accept`, { expectedRevision: 1, level: 'syndicate', approvalId: null })) as unknown as { result: { outcome: string }; record: { state: string; phase: string; requestedBy: string; localAcceptedAt: string } };
    assert.equal(accepted.result.outcome, 'applied');
    // The response is the committed acceptance (awaiting the peer); the handshake went out after the commit and the peer's answer activated the record.
    assert.deepEqual([accepted.record.state, accepted.record.phase, accepted.record.requestedBy], ['pending_approval', 'awaiting_peer', w.people.owner]);
    assert.equal(transport.handshakes.length, before + 1, 'the acceptance handshake was sent to the peer');
    const sent = transport.handshakes[before]!;
    assert.equal(sent.body.from, OUR_HOST);
    assert.equal(sent.body.requestedLevel, 'syndicate');
    assert.deepEqual(sent.body.hubs, { initiator: HUB_SLUG, responder: PEER_HUB });
    assert.ok(verifyManifestSignatures(asManifest(sent.body.manifest), verifyEd25519), 'our handshake carries our signed manifest');
    const theirView = await verifySignedMessage({ method: 'POST', targetUri: `https://${CITY}/federation/v1/handshake`, body: utf8Encode(canonicalize(sent.body)), header: (name) => (sent.fields as Record<string, string>)[name] ?? null }, await ourChain(), now(), null);
    assert.equal(theirView.ok, true, 'the peer can verify our request against our manifest');
    const detail = ok(await clients.owner.get(`${ADMIN}/peerings/${incomingId}`)) as unknown as { record: { state: string; phase: string }; events: { event: string }[]; protocol: { state: string; level: string } };
    assert.deepEqual([detail.record.state, detail.record.phase], ['active', 'complete']);
    assert.deepEqual(detail.events.map((e) => e.event), ['peering.requested_by_peer', 'peering.accepted', 'peering.activated']);
    assert.deepEqual([detail.protocol.state, detail.protocol.level], ['active', 'syndicate']);
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: true });
    assert.deepEqual(await service.flowAllowed(CITY, 'deal_routing'), { ok: false, code: 'federation.level_insufficient' });
  });

  await t.test('defederation: one person with the permission ends the record; feeds and deliveries stop; history and events stay', async () => {
    const current = (await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.peering_record WHERE id = $1', [incomingId])).rows[0]!;
    expectRefusal(await command('officer', `${ADMIN}/peerings/${incomingId}/end`, { expectedRevision: current.revision }), 403, 'access.forbidden', 'forbidden');
    const ended = ok(await command('owner', `${ADMIN}/peerings/${incomingId}/end`, { expectedRevision: current.revision })) as unknown as { record: { state: string; endReason: string; endedAt: string } };
    assert.deepEqual([ended.record.state, ended.record.endReason], ['ended', 'defederated']);
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: false, code: 'federation.not_peered' });
    expectRefusal(await command('owner', `${ADMIN}/peerings/${incomingId}/suspend`, { expectedRevision: current.revision + 1 }), 409, 'validation.revision_conflict', 'ended');
    const rows = (await h.db.admin.query<{ event: string }>('SELECT event FROM trustwork.peering_event WHERE peering_record_id = $1 ORDER BY occurred_at', [incomingId])).rows;
    assert.deepEqual(rows.map((r) => r.event), ['peering.requested_by_peer', 'peering.accepted', 'peering.activated', 'peering.defederated']);
    await assert.rejects(h.db.admin.query('DELETE FROM trustwork.peering_record WHERE id = $1', [incomingId]), /never deleted/);
    await assert.rejects(h.db.admin.query('DELETE FROM trustwork.peering_event WHERE peering_record_id = $1', [incomingId]), /append-only|not allowed|forbid/i);
  });

  let outgoingId = '';
  await t.test('an outgoing request at deal_routing needs a second approver: pending, approved through the approvals route, then the record awaits the peer', async () => {
    const body = { localHubId: w.hubId, peerNode: PEER_HOST, peerHubId: PEER_HUB, level: 'deal_routing', approvalId: null };
    expectRefusal(await command('moderator', `${ADMIN}/peerings`, body), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await command('owner', `${ADMIN}/peerings`, { ...body, peerHubId: 'nowhere' }), 422, 'validation.schema', 'unknown_peer_hub');
    expectRefusal(await command('owner', `${ADMIN}/peerings`, { ...body, level: 'identity' }), 422, 'validation.schema', 'level_not_offered_by_peer');
    const pending = ok(await command('owner', `${ADMIN}/peerings`, body), 201);
    assert.equal(pending.result.outcome, 'pending_second_person');
    assert.equal(await count("SELECT 1 FROM trustwork.peering_record WHERE state <> 'ended'"), 0, 'no record before the second person');
    const approvalId = pending.result.approvalRequestId as string;
    const digest = computeDigest(peeringLevelDigestInput({ localHubId: w.hubId, peerNode: PEER_HOST, peerHubId: PEER_HUB, level: 'deal_routing' })).value;
    expectRefusal(await command('owner', `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: digest }), 403, 'access.second_approver_required');
    ok(await command('officer', `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: digest }));
    // The approval binds the level: syndicate under a deal_routing approval is refused.
    expectRefusal(await command('owner', `${ADMIN}/peerings`, { ...body, level: 'syndicate', approvalId }), 409, 'access.approval_digest_mismatch');
    const before = transport.handshakes.length;
    const applied = ok(await command('owner', `${ADMIN}/peerings`, { ...body, approvalId }), 201) as unknown as { result: { outcome: string }; record: { id: string; direction: string; state: string; phase: string; level: string; secondApproverId: string; requestedBy: string } };
    assert.equal(applied.result.outcome, 'applied');
    assert.deepEqual([applied.record.direction, applied.record.state, applied.record.phase, applied.record.level, applied.record.secondApproverId, applied.record.requestedBy], ['outgoing', 'pending_approval', 'awaiting_peer', 'deal_routing', w.people.officer, w.people.owner]);
    assert.equal(transport.handshakes.length, before + 1, 'the handshake went out after the commit');
    assert.equal(transport.handshakes[before]!.body.requestedLevel, 'deal_routing');
    outgoingId = applied.record.id;
    const afterAnswer = ok(await clients.owner.get(`${ADMIN}/peerings/${outgoingId}`)) as unknown as { events: { event: string }[] };
    assert.deepEqual(afterAnswer.events.map((e) => e.event), ['peering.requested', 'peering.admitted_by_peer']);
    // A refresh re-sends the handshake of a record still awaiting the peer and is audited; without the edit permission nothing is fetched or sent.
    const fetchesBeforeDenied = transport.manifestFetches.length;
    expectRefusal(await command('operator', `${ADMIN}/peers/refresh`, { peerNode: PEER_HOST }), 403, 'access.forbidden', 'forbidden');
    assert.equal(transport.manifestFetches.length, fetchesBeforeDenied);
    assert.equal(transport.handshakes.length, before + 1);
    const refreshed = ok(await command('owner', `${ADMIN}/peers/refresh`, { peerNode: PEER_HOST })) as unknown as { peer: { admission: { state: string } }; records: { id: string }[] };
    assert.equal(refreshed.peer.admission.state, 'admitted');
    assert.deepEqual(refreshed.records.map((r) => r.id), [outgoingId]);
    assert.equal(transport.handshakes.length, before + 2);
    assert.equal(await count("SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'federation.peer_refreshed' AND outcome = 'applied'"), 1);
    expectRefusal(await command('owner', `${ADMIN}/peerings`, { ...body, approvalId }), 403, 'access.approval_required', 'approval_consumed');
    assert.deepEqual(await service.flowAllowed(CITY, 'deal_routing'), { ok: false, code: 'federation.not_peered' }, 'nothing flows until the peer\'s person accepts');
  });

  await t.test('a self-signed genesis manifest for the peer\'s name does not take the peer over: the request fails against the chain fetched from the peer\'s origin and the pending record stays pending', async () => {
    const genesis: NodeKey = { keyId: 'a1', algorithm: 'ed25519', publicKey: publicKeyB64(RFC8032.test1), validFrom: '2026-01-01T00:00:00.000Z', retiredAt: null, revocation: null, rotation: null };
    const forgedUnsigned: Record<string, unknown> = { ...(fixtureManifest({ node: CITY }) as NodeManifest), keys: { current: 'a1', chain: [genesis] }, issuedAt: '2026-11-02T00:00:00.000Z' };
    delete forgedUnsigned['signature'];
    const forgedManifest = signDocument('manifest', forgedUnsigned, 'a1', signerFor(RFC8032.test1)) as unknown as Record<string, unknown>;
    assert.ok(verifyManifestSignatures(asManifest(forgedManifest), verifyEd25519), 'the forgery is self-consistent');
    const before = (await h.db.admin.query<{ manifest_digest: string; refresh_due_at: Date }>('SELECT manifest_digest, refresh_due_at FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!;
    const takeover = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, level: 'deal_routing', now: now(), manifest: forgedManifest, signer: { keyId: 'a1', sign: signerFor(RFC8032.test1) } });
    const answer = await mesh(takeover.body, takeover.fields);
    assert.equal(answer.status, 401, JSON.stringify(answer.body));
    assert.equal(answer.body.code, 'federation.signature_invalid');
    const after = (await h.db.admin.query<{ manifest_digest: string; refresh_due_at: Date }>('SELECT manifest_digest, refresh_due_at FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!;
    assert.deepEqual(after, before, 'the held chain is untouched');
    const record = (await h.db.admin.query<{ state: string; phase: string }>('SELECT state, phase FROM trustwork.peering_record WHERE id = $1', [outgoingId])).rows[0]!;
    assert.deepEqual(record, { state: 'pending_approval', phase: 'awaiting_peer' });
  });

  await t.test('the peer\'s acceptance arrives as a handshake from the accepting node: the outgoing record activates at deal_routing on both acceptances', async () => {
    const acceptance = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, level: 'deal_routing', now: now() });
    const response = await mesh(acceptance.body, acceptance.fields);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const answer = HandshakeResponseSchema.parse(response.body);
    assert.ok(answer.outcome === 'admitted' && answer.state === 'active' && answer.level === 'deal_routing');
    const detail = ok(await clients.owner.get(`${ADMIN}/peerings/${outgoingId}`)) as unknown as { record: { state: string; level: string; peerAcceptedAt: string }; events: { event: string }[] };
    assert.deepEqual([detail.record.state, detail.record.level], ['active', 'deal_routing']);
    assert.ok(detail.record.peerAcceptedAt);
    // Two admissions by the peer: the request's handshake and the refresh's resend; then the peer's acceptance.
    assert.deepEqual(detail.events.map((e) => e.event), ['peering.requested', 'peering.admitted_by_peer', 'peering.admitted_by_peer', 'peering.peer_accepted']);
    assert.deepEqual(await service.flowAllowed(CITY, 'deal_routing', w.hubId), { ok: true });
    assert.deepEqual(await service.flowAllowed(CITY, 'identity'), { ok: false, code: 'federation.level_insufficient' });
    // Lowering is a one-person protective command; raising in place is refused.
    const lowered = ok(await command('owner', `${ADMIN}/peerings/${outgoingId}/lower`, { expectedRevision: detail.record.state === 'active' ? (await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.peering_record WHERE id = $1', [outgoingId])).rows[0]!.revision : 0, level: 'trust_verifications' })) as unknown as { record: { level: string; revision: number } };
    assert.equal(lowered.record.level, 'trust_verifications');
    expectRefusal(await command('owner', `${ADMIN}/peerings/${outgoingId}/lower`, { expectedRevision: lowered.record.revision, level: 'deal_routing' }), 409, 'validation.revision_conflict', 'invalid_transition');
    assert.deepEqual(await service.flowAllowed(CITY, 'deal_routing'), { ok: false, code: 'federation.level_insufficient' });
  });

  await t.test('a handshake moves no refresh: only a fetch from the origin does, so a stolen key cannot keep an archived manifest alive past the next due refresh', async () => {
    const DALLAS = 'dallas.example.org';
    const a1 = cityKeyChain()[0]!;
    const dallas = transport.add({ host: DALLAS, manifest: () => manifestFor(DALLAS), remoteAddress: SERVED_ADDRESS, signer: { keyId: 'a1', sign: signerFor(RFC8032.test3) }, answer: austin.answer });
    const due = async () => (await h.db.admin.query<{ d: Date }>('SELECT refresh_due_at AS d FROM trustwork.federation_peer WHERE peer_node = $1', [DALLAS])).rows[0]!.d.getTime();
    const dallasHandshake = (manifest: Record<string, unknown>) => {
      const hs = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now(), manifest });
      return mesh(utf8Encode(canonicalize({ ...hs.request, from: DALLAS })), signRequest({ method: 'POST', targetUri: `https://${OUR_HOST}${HANDSHAKE_URL}`, body: utf8Encode(canonicalize({ ...hs.request, from: DALLAS })), signer: dallas.signer, now: now() }));
    };
    h.clock.advance(1_500);
    // Before a person here asked for Dallas its handshake is refused and nothing is looked up or fetched; the fetch a request makes holds it.
    const unknownDallas = await dallasHandshake(dallas.manifest());
    assert.equal(unknownDallas.status, 403, JSON.stringify(unknownDallas.body));
    assert.equal(unknownDallas.body.code, 'federation.not_peered');
    assert.ok(!transport.manifestFetches.includes(DALLAS) && !transport.resolves.includes(DALLAS), 'a stranger is neither resolved nor fetched');
    await service.refreshPeer(DALLAS, 'request');
    assert.equal((await dallasHandshake(dallas.manifest())).status, 200);
    const firstDue = await due();
    const fetches = transport.manifestFetches.length;
    assert.equal((await dallasHandshake(dallas.manifest())).status, 200);
    assert.equal(await due(), firstDue, 'a verified handshake re-admits but does not move the refresh');
    assert.equal(transport.manifestFetches.length, fetches, 'and fetches nothing while the held manifest is not due');
    // The stolen-key scenario: the origin rotates to a2 and revokes a1; an attacker holding a1 keeps sending handshakes.
    const rotatedAt = '2026-11-02T06:00:00.000Z';
    const a2: NodeKey = { keyId: 'a2', algorithm: 'ed25519', publicKey: publicKeyB64(RFC8032.test1), validFrom: rotatedAt, retiredAt: null, revocation: null, rotation: { previousKeyId: 'a1', signature: { algorithm: 'ed25519', keyId: 'a1', value: 'A'.repeat(86) } } };
    const statement = signDocument('key_rotation', rotationStatementFor(DALLAS, { ...a1, retiredAt: rotatedAt }, a2), 'a1', signerFor(RFC8032.test3));
    const revokedA1: NodeKey = { ...a1, retiredAt: rotatedAt, revocation: { compromisedSince: '2026-10-20T00:00:00.000Z', revokedAt: rotatedAt } };
    const archived = dallas.manifest();
    dallas.manifest = () => manifestFor(DALLAS, { keys: { current: 'a2', chain: [revokedA1, { ...a2, rotation: { previousKeyId: 'a1', signature: statement.signature } }] }, issuedAt: rotatedAt }, { keyId: 'a2', sign: signerFor(RFC8032.test1) });
    h.clock.advance(1_500);
    assert.equal((await dallasHandshake(archived)).status, 200, 'until the manifest is due the held chain answers the archived manifest');
    await h.db.admin.query("UPDATE trustwork.federation_peer SET refresh_due_at = now() - interval '1 minute' WHERE peer_node = $1", [DALLAS]);
    h.clock.advance(1_500);
    const refusedStolen = await dallasHandshake(archived);
    assert.equal(refusedStolen.status, 401, JSON.stringify(refusedStolen.body));
    assert.equal(refusedStolen.body.code, 'federation.key_revoked', 'the due handshake made this node fetch; the revocation was seen and the stolen key refused');
    assert.equal(transport.manifestFetches.length, fetches + 1);
    assert.ok((await due()) > Date.now(), 'the fetch moved the refresh');
    assert.deepEqual(reverified.filter((r) => r.peer === DALLAS), [{ peer: DALLAS, keyId: 'a1', since: '2026-10-20T00:00:00.000Z' }]);
  });

  await t.test('nothing unauthenticated changes peer state: an unsigned or forged request carrying the peer\'s manifest with a restricted place suspends nothing, writes no refusal and moves no refresh', async () => {
    const snapshot = () => h.db.admin.query<{ manifest_digest: string; refresh_due_at: Date; admission_state: string }>('SELECT manifest_digest, refresh_due_at, admission_state FROM trustwork.federation_peer WHERE peer_node = $1', [CITY]).then((r) => r.rows[0]!);
    const before = await snapshot();
    const refusalsBefore = await count('SELECT 1 FROM trustwork.admission_refusal');
    const fetches = transport.manifestFetches.length;
    const poisoned = fixtureManifest({ node: CITY, jurisdiction: 'RU' });
    const anonymous = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now(), manifest: poisoned });
    assert.equal((await mesh(anonymous.body, { 'content-type': 'application/json' })).status, 401);
    const forged = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now(), manifest: poisoned, signer: forgedSigner });
    assert.equal((await mesh(forged.body, forged.fields)).status, 401);
    assert.deepEqual(await snapshot(), before, 'the peer row is untouched');
    assert.equal(await count('SELECT 1 FROM trustwork.admission_refusal'), refusalsBefore, 'no false refusal against the victim');
    assert.equal(transport.manifestFetches.length, fetches, 'the attacker cannot make us fetch');
    assert.equal((await h.db.admin.query<{ suspended_at: Date | null; state: string }>('SELECT suspended_at, state FROM trustwork.peering_record WHERE id = $1', [outgoingId])).rows[0]!.suspended_at, null, 'the active record is not suspended');
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: true });
  });

  await t.test('re-admission: a changed peer manifest with an expired attestation suspends every flow; a renewed admission lifts it; a restricted territory refuses and suspends', async () => {
    setPeerManifest(austin, fixtureManifest({ node: CITY, attestation: EXPIRED_ATTESTATION }));
    const refreshed = ok(await command('owner', `${ADMIN}/peers/refresh`, { peerNode: PEER_HOST })) as unknown as { peer: { admission: { state: string; trigger: string } } | null; code: string | null };
    assert.equal(refreshed.peer?.admission.state, 'refused');
    assert.equal(refreshed.peer?.admission.trigger, 'manual');
    const suspended = (await h.db.admin.query<{ suspension_reason: string; state: string }>('SELECT suspension_reason, state FROM trustwork.peering_record WHERE id = $1', [outgoingId])).rows[0]!;
    assert.deepEqual(suspended, { suspension_reason: 'attestation_expired', state: 'active' });
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: false, code: 'federation.peer_restricted' });
    // A person cannot lift what the admission check imposed.
    const revision = (await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.peering_record WHERE id = $1', [outgoingId])).rows[0]!.revision;
    expectRefusal(await command('owner', `${ADMIN}/peerings/${outgoingId}/lift`, { expectedRevision: revision }), 409, 'validation.revision_conflict', 'invalid_transition');
    setPeerManifest(austin, fixtureManifest({ node: CITY }));
    await service.refreshPeer(CITY, 'refresh');
    assert.equal((await h.db.admin.query<{ suspension_reason: string | null }>('SELECT suspension_reason FROM trustwork.peering_record WHERE id = $1', [outgoingId])).rows[0]!.suspension_reason, null);
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: true });
    // A restricted territory in the changed manifest: refused through the admission check, flows suspended, refusal recorded.
    const refusalsBefore = await count('SELECT 1 FROM trustwork.admission_refusal');
    setPeerManifest(austin, fixtureManifest({ node: CITY, territories: ['US-TX', 'CU'] }));
    const restrictedRefresh = ok(await command('owner', `${ADMIN}/peers/refresh`, { peerNode: PEER_HOST })) as unknown as { peer: null; code: string };
    assert.deepEqual(restrictedRefresh, { peer: null, code: 'federation.peer_restricted', records: [] });
    assert.equal(await count('SELECT 1 FROM trustwork.admission_refusal'), refusalsBefore + 1);
    assert.equal((await h.db.admin.query<{ suspension_reason: string | null }>('SELECT suspension_reason FROM trustwork.peering_record WHERE id = $1', [outgoingId])).rows[0]!.suspension_reason, 'admission_refused');
    setPeerManifest(austin, fixtureManifest({ node: CITY }));
    await service.refreshPeer(CITY, 'refresh');
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: true });
    // The peer's name now resolves to a restricted place: refused before any connection, and every flow with the held peer pauses.
    austin.remoteAddress = RESTRICTED_ADDRESS;
    const connections = transport.connections.length;
    const peerState = async () => (await h.db.admin.query<{ admission_state: string; due: Date }>('SELECT admission_state, refresh_due_at AS due FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!;
    const suspensionOf = async () => (await h.db.admin.query<{ suspension_reason: string | null }>('SELECT suspension_reason FROM trustwork.peering_record WHERE id = $1', [outgoingId])).rows[0]!.suspension_reason;
    const dueBefore = (await peerState()).due;
    await assert.rejects(service.refreshPeer(CITY, 'refresh'), (e: Error & { code?: string }) => e.code === 'federation.peer_restricted');
    assert.equal(transport.connections.length, connections, 'never contacted');
    assert.equal(await suspensionOf(), 'admission_refused');
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: false, code: 'federation.peer_restricted' });
    // The suspension bought the peer nothing: the refresh is due as it was, and a signed handshake from a clean address
    // carrying the held manifest lifts nothing (the origin's address is judged again and refused; the peer stays refused).
    assert.deepEqual(await peerState(), { admission_state: 'refused', due: dueBefore }, 'a suspension without a fetch moves no refresh');
    h.clock.advance(1_500);
    const clean = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now() });
    const notLifted = await mesh(clean.body, clean.fields);
    assert.equal(notLifted.status, 451, JSON.stringify(notLifted.body));
    assert.equal(transport.connections.length, connections, 'still never contacted');
    assert.deepEqual(await peerState(), { admission_state: 'refused', due: dueBefore });
    assert.equal(await suspensionOf(), 'admission_refused');
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: false, code: 'federation.peer_restricted' });
    austin.remoteAddress = SERVED_ADDRESS;
    h.clock.advance(1_500);
    await service.refreshPeer(CITY, 'refresh');
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: true });
    // A console refresh before the due time that finds the origin refusing (expired attestation), then a handshake from a
    // clean address carrying that served manifest: the refusal stands. The next fetch that passes lifts it, whoever caused it.
    setPeerManifest(austin, fixtureManifest({ node: CITY, attestation: EXPIRED_ATTESTATION }));
    const early = ok(await command('owner', `${ADMIN}/peers/refresh`, { peerNode: PEER_HOST })) as unknown as { peer: { admission: { state: string } } | null };
    assert.equal(early.peer?.admission.state, 'refused');
    assert.equal(await suspensionOf(), 'attestation_expired');
    h.clock.advance(1_500);
    const afterEarly = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now(), manifest: fixtureManifest({ node: CITY, attestation: EXPIRED_ATTESTATION }) });
    const stillRefused = await mesh(afterEarly.body, afterEarly.fields);
    assert.equal(stillRefused.status, 451, JSON.stringify(stillRefused.body));
    assert.equal((await peerState()).admission_state, 'refused');
    assert.equal(await suspensionOf(), 'attestation_expired');
    setPeerManifest(austin, fixtureManifest({ node: CITY }));
    h.clock.advance(1_500);
    const fetchesBeforeLift = transport.manifestFetches.length;
    const passing = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now() });
    const liftedByFetch = await mesh(passing.body, passing.fields);
    assert.equal(liftedByFetch.status, 200, JSON.stringify(liftedByFetch.body));
    assert.equal(transport.manifestFetches.length, fetchesBeforeLift + 1, 'the handshake found the peer refused and fetched; the origin passed; the fetch lifted');
    assert.equal((await peerState()).admission_state, 'admitted');
    assert.equal(await suspensionOf(), null);
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: true });
  });

  await t.test('operator suspension and lift, both audited; suspension stops flows without ending the record', async () => {
    const revision = (await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.peering_record WHERE id = $1', [outgoingId])).rows[0]!.revision;
    const suspended = ok(await command('owner', `${ADMIN}/peerings/${outgoingId}/suspend`, { expectedRevision: revision })) as unknown as { record: { suspended: { reason: string }; revision: number } };
    assert.equal(suspended.record.suspended.reason, 'operator');
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: false, code: 'federation.not_peered' });
    const lifted = ok(await command('officer', `${ADMIN}/peerings/${outgoingId}/lift`, { expectedRevision: suspended.record.revision })) as unknown as { record: { suspended: null; state: string } };
    assert.deepEqual([lifted.record.suspended, lifted.record.state], [null, 'active']);
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: true });
    const audited = (await h.db.admin.query<{ action: string }>("SELECT action FROM trustwork.admin_audit_event WHERE object_id = $1 AND outcome = 'applied' ORDER BY sequence", [outgoingId])).rows.map((r) => r.action);
    assert.deepEqual(audited.filter((x) => x !== 'federation.peer_refreshed'), ['federation.raise_peering_level', 'federation.peering_lowered', 'federation.peering_suspended', 'federation.peering_suspension_lifted']);
  });

  await t.test('key rotation on the peer: an unknown key label triggers an immediate manifest refresh; a published revocation triggers re-verification of what that key signed', async () => {
    const a1 = cityKeyChain()[0]!;
    const rotatedAt = '2026-11-01T12:00:00.000Z';
    const a2Unsigned: NodeKey = { keyId: 'a2', algorithm: 'ed25519', publicKey: publicKeyB64(RFC8032.test1), validFrom: rotatedAt, retiredAt: null, revocation: null, rotation: { previousKeyId: 'a1', signature: { algorithm: 'ed25519', keyId: 'a1', value: 'A'.repeat(86) } } };
    const statement = signDocument('key_rotation', rotationStatementFor(CITY, { ...a1, retiredAt: rotatedAt }, a2Unsigned), 'a1', signerFor(RFC8032.test3));
    const chain: NodeKey[] = [{ ...a1, retiredAt: rotatedAt }, { ...a2Unsigned, rotation: { previousKeyId: 'a1', signature: statement.signature } }];
    assert.deepEqual(keyChainProblems(CITY, chain, 'a2', verifyEd25519), []);
    const rotatedManifest = (overrides: Partial<NodeManifest> = {}) => {
      const base = fixtureManifest({ node: CITY }) as NodeManifest;
      const unsigned: Record<string, unknown> = { ...base, ...overrides, keys: { current: 'a2', chain: overrides.keys?.chain ?? chain }, issuedAt: overrides.issuedAt ?? '2026-11-01T12:00:00.000Z' };
      delete unsigned['signature'];
      return signDocument('manifest', unsigned, 'a2', signerFor(RFC8032.test1)) as unknown as Record<string, unknown>;
    };
    setPeerManifest(austin, rotatedManifest());
    austin.signer = { keyId: 'a2', sign: signerFor(RFC8032.test1) };
    const fetches = transport.manifestFetches.length;
    // A request signed with the new key arrives before any refresh: key_unknown is answered by refreshing the manifest once.
    const signedWithA2 = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now(), signer: austin.signer, manifest: rotatedManifest() });
    const verification = await service.verifyPeerMessage(CITY, { method: 'POST', targetUri: `https://${OUR_HOST}${HANDSHAKE_URL}`, body: signedWithA2.body, header: (name) => (signedWithA2.fields as Record<string, string>)[name] ?? null });
    assert.equal(verification.ok, true, JSON.stringify(verification));
    assert.equal(transport.manifestFetches.length, fetches + 1, 'federation.key_unknown refreshed the manifest immediately');
    assert.equal((await h.db.admin.query<{ current_key_id: string }>('SELECT current_key_id FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!.current_key_id, 'a2');
    // Signatures made by a1 before its retirement still verify; those at or after a published compromise are refused.
    const revokedChain: NodeKey[] = [{ ...chain[0]!, revocation: { compromisedSince: '2026-10-15T00:00:00.000Z', revokedAt: '2026-11-01T12:00:00.000Z' } }, chain[1]!];
    setPeerManifest(austin, rotatedManifest({ keys: { current: 'a2', chain: revokedChain } }));
    await service.refreshPeer(CITY, 'refresh');
    assert.deepEqual(reverified.filter((r) => r.peer === CITY), [{ peer: CITY, keyId: 'a1', since: '2026-10-15T00:00:00.000Z' }]);
    const noticed = (await h.db.admin.query<{ key_id: string; objects_flagged: number }>('SELECT key_id, objects_flagged FROM trustwork.peer_key_revocation WHERE peer_node = $1', [CITY])).rows;
    assert.deepEqual(noticed, [{ key_id: 'a1', objects_flagged: 3 }]);
    const held = (await h.db.admin.query<{ manifest: NodeManifest }>('SELECT manifest FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!.manifest;
    assert.equal(FederationNodeService.keyFor(held.keys.chain, 'a1', '2026-10-01T00:00:00.000Z').ok, true);
    assert.deepEqual(FederationNodeService.keyFor(held.keys.chain, 'a1', '2026-10-20T00:00:00.000Z'), { ok: false, code: 'federation.key_revoked' });
    const heldDigest = (await h.db.admin.query<{ d: string }>('SELECT manifest_digest AS d FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!.d;
    // Rollback: an older manifest (the genesis-only one) is refused and the held one kept.
    setPeerManifest(austin, fixtureManifest({ node: CITY }));
    await assert.rejects(service.refreshPeer(CITY, 'refresh'), /older than the one held/);
    // A dropped revocation: a later manifest whose chain forgets that a1 was compromised is refused and the held one kept.
    setPeerManifest(austin, rotatedManifest({ issuedAt: '2026-11-01T13:00:00.000Z' } as Partial<NodeManifest>));
    await assert.rejects(service.refreshPeer(CITY, 'refresh'), /drops a published revocation/);
    assert.equal((await h.db.admin.query<{ d: string }>('SELECT manifest_digest AS d FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!.d, heldDigest);
    assert.equal(await count("SELECT 1 FROM trustwork.peer_key_revocation WHERE peer_node = $1", [CITY]), 1);
    // Equivocation: a different successor of a1 suspends every flow and stops trusting the node's new signatures.
    const otherA2: NodeKey = { ...a2Unsigned, keyId: 'a2-other', publicKey: publicKeyB64(RFC8032.test2) };
    const otherStatement = signDocument('key_rotation', rotationStatementFor(CITY, { ...a1, retiredAt: rotatedAt }, otherA2), 'a1', signerFor(RFC8032.test3));
    const forkedChain: NodeKey[] = [revokedChain[0]!, { ...otherA2, rotation: { previousKeyId: 'a1', signature: otherStatement.signature } }];
    const forkedUnsigned: Record<string, unknown> = { ...(fixtureManifest({ node: CITY }) as NodeManifest), keys: { current: 'a2-other', chain: forkedChain }, issuedAt: '2026-11-01T12:30:00.000Z' };
    delete forkedUnsigned['signature'];
    setPeerManifest(austin, signDocument('manifest', forkedUnsigned, 'a2-other', signerFor(RFC8032.test2)) as unknown as Record<string, unknown>);
    await assert.rejects(service.refreshPeer(CITY, 'refresh'), /two successors/);
    assert.equal((await h.db.admin.query<{ suspension_reason: string }>('SELECT suspension_reason FROM trustwork.peering_record WHERE id = $1', [outgoingId])).rows[0]!.suspension_reason, 'equivocation');
    assert.ok((await h.db.admin.query<{ equivocation_at: Date | null }>('SELECT equivocation_at FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!.equivocation_at);
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: false, code: 'federation.peer_restricted' }, 'a chain break closes every flow until the operator confirms the chain');
    setPeerManifest(austin, rotatedManifest({ keys: { current: 'a2', chain: revokedChain } }));
  });

  await t.test('our key rotation: a second person (ops.rotate_node_key), the hand-over signed by the retiring key, a new manifest version that verifies and keeps the old one verifiable', async () => {
    expectRefusal(await command('owner', `${ADMIN}/node/keys/rotate`, { nextKeyId: 'k2' }), 403, 'access.forbidden', 'forbidden');
    const pending = ok(await command('operator', `${ADMIN}/node/keys/rotate`, { nextKeyId: 'k2' }));
    assert.equal(pending.result.outcome, 'pending_second_person');
    const digest = computeDigest(keyRotationDigestInput({ nodeId: w.nodeId, previousKeyId: 'k1', compromisedSince: null })).value;
    expectRefusal(await command('operator', `/v1/admin/approvals/${pending.result.approvalRequestId}/approve`, { actionDigest: digest }), 403, 'access.second_approver_required');
    ok(await command('founder', `/v1/admin/approvals/${pending.result.approvalRequestId}/approve`, { actionDigest: digest }));
    const v1 = nodeManifestSchema(restricted).parse((await new Client(app).get(MANIFEST_URL)).body);
    const rotated = ok(await command('operator', `${ADMIN}/node/keys/rotate`, { nextKeyId: 'k2', approvalId: pending.result.approvalRequestId })) as unknown as { keys: NodeKey[] };
    assert.deepEqual(rotated.keys.map((k) => [k.keyId, k.retiredAt !== null, k.rotation?.previousKeyId ?? null]), [['k1', true, null], ['k2', false, 'k1']]);
    assert.equal(rotated.keys[0]!.retiredAt, rotated.keys[1]!.validFrom);
    const v2 = nodeManifestSchema(restricted).parse((await new Client(app).get(MANIFEST_URL)).body);
    assert.equal(v2.keys.current, 'k2');
    assert.equal(v2.signature.keyId, 'k2');
    assert.ok(verifyManifestSignatures(v2, verifyEd25519));
    assert.deepEqual(keyChainProblems(OUR_HOST, v2.keys.chain, 'k2', verifyEd25519), []);
    // The earlier manifest was signed by k1 before its retirement: still valid under the new chain.
    assert.equal(FederationNodeService.keyFor(v2.keys.chain, 'k1', v1.issuedAt).ok, true);
    assert.equal(await count('SELECT 1 FROM trustwork.node_manifest'), 2);
    assert.equal(await count('SELECT 1 FROM trustwork.node_key_secret'), 2);
    // Signing continues with k2 only: a response to a peer verifies against the new chain.
    const probe = peerHandshake({ to: OUR_HOST, responderHub: HUB_SLUG, now: now() });
    const answer = await mesh(probe.body, probe.fields);
    const verified = await verifySignedMessage({ status: answer.status, body: new Uint8Array(answer.raw), header: answer.header }, v2.keys.chain, now(), null);
    assert.equal(verified.ok && verified.keyId, 'k2', JSON.stringify([answer.status, answer.body, verified]));
  });

  await t.test('before the first delivery of a new deal the admission runs again; a lapsed admission stops new deliveries without rewriting history', async () => {
    // The equivocation finding stands; a fresh admission still records the outcome.
    const beforeRows = await count('SELECT 1 FROM trustwork.peering_record');
    const refused = await service.admitDealDelivery(CITY, 'deal-0001', { address: RESTRICTED_ADDRESS, header: () => null }, w.hubId);
    assert.deepEqual(refused, { ok: false, code: 'federation.peer_restricted' });
    const deals = (await h.db.admin.query<{ deal_ref: string; outcome: string }>('SELECT deal_ref, outcome FROM trustwork.peer_deal_admission WHERE peer_node = $1 ORDER BY decided_at', [CITY])).rows;
    assert.deepEqual(deals, [{ deal_ref: 'deal-0001', outcome: 'refused' }]);
    assert.equal(await count('SELECT 1 FROM trustwork.peering_record'), beforeRows, 'history is not rewritten');
    assert.deepEqual(await service.flowAllowed(CITY, 'syndicate'), { ok: false, code: 'federation.peer_restricted' });
    const admitted = await service.admitDealDelivery(CITY, 'deal-0002', { address: SERVED_ADDRESS, header: () => null }, w.hubId);
    assert.deepEqual(admitted, { ok: false, code: 'federation.peer_restricted' }, 'the admission passes again but the equivocation finding stands until the operator confirms the chain');
    assert.equal((await h.db.admin.query<{ admission_state: string; admission_trigger: string }>('SELECT admission_state, admission_trigger FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!.admission_trigger, 'deal_delivery');
  });

  await t.test('a peer whose server resolves to a restricted place is refused when we ask to connect; daily refresh picks up due peers', async () => {
    const houston = austinPeer(transport, now);
    houston.host = 'houston.example.org';
    houston.remoteAddress = RESTRICTED_ADDRESS;
    const houstonUnsigned: Record<string, unknown> = { ...(fixtureManifest({ node: CITY }) as NodeManifest), node: 'houston.example.org', operator: { ...(fixtureManifest({ node: CITY }) as NodeManifest).operator, abuseContact: 'mailto:abuse@houston.example.org', takedownContact: 'https://houston.example.org/legal/takedown' } };
    delete houstonUnsigned['signature'];
    const houstonManifest = signDocument('manifest', houstonUnsigned, 'a1', signerFor(RFC8032.test3)) as unknown as Record<string, unknown>;
    transport.peers.delete(CITY);
    transport.add({ ...houston, manifest: () => houstonManifest });
    transport.add(austin);
    const refusalsBefore = await count('SELECT 1 FROM trustwork.admission_refusal');
    expectRefusal(await command('owner', `${ADMIN}/peerings`, { localHubId: w.hubId, peerNode: 'houston.example.org', peerHubId: PEER_HUB, level: 'syndicate', approvalId: null }), 403, 'access.forbidden', 'federation.peer_restricted');
    assert.equal(await count('SELECT 1 FROM trustwork.admission_refusal'), refusalsBefore + 1);
    const finding = (await h.db.admin.query<{ findings: { source: string; dataset: string }[] }>('SELECT findings FROM trustwork.admission_refusal ORDER BY created_at DESC LIMIT 1')).rows[0]!.findings;
    assert.ok(finding.some((f) => f.source === 'observed_location' && f.dataset === 'fake'));
    assert.equal(await count("SELECT 1 FROM trustwork.peering_record WHERE peer_node = 'houston.example.org'"), 0);
    assert.ok(transport.resolves.includes('houston.example.org') && !transport.manifestFetches.includes('houston.example.org') && transport.connections.every((c) => c.host !== 'houston.example.org'), 'a restricted address is judged before any connection and never contacted');
    assert.ok(transport.connections.filter((c) => c.host === CITY).every((c) => c.address === SERVED_ADDRESS), 'every connection goes to the judged address');
    // Daily refresh: a peer whose manifest is older than a day is fetched again.
    await h.db.admin.query("UPDATE trustwork.federation_peer SET refresh_due_at = now() - interval '1 minute' WHERE peer_node = $1", [CITY]);
    const fetches = transport.manifestFetches.length;
    const due = await service.refreshDue();
    assert.deepEqual(due.map((d) => d.host), [CITY]);
    assert.equal(transport.manifestFetches.length, fetches + 1);
    assert.ok((await h.db.admin.query<{ due: Date }>('SELECT refresh_due_at AS due FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!.due.getTime() > Date.now() + 23 * 3_600_000);
    assert.deepEqual(await service.refreshDue(), []);
  });

  await t.test('the refresh timer: off with a fake transport unless opted in, one instance at a time under the advisory lock, cleared on shutdown; one failed peer does not stop the rest', async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const waitUntil = async (condition: () => boolean, ms: number) => { const until = Date.now() + ms; while (!condition() && Date.now() < until) await sleep(50); assert.ok(condition(), 'condition within time'); };
    assert.equal(app.app.get(FederationRefreshTimer).active, false, 'a fake transport without opt-in starts no timer');
    // One failed peer does not stop the rest: Houston (held and admitted here through a direct record) answers 500, Austin refreshes.
    const houstonManifest = asManifest(transport.peers.get('houston.example.org')!.manifest());
    await federationPeers.record(h.pool, { peerNode: 'houston.example.org', manifest: houstonManifest, manifestDigest: computeDigest(houstonManifest).value, manifestIssuedAt: new Date(houstonManifest.issuedAt), currentKeyId: 'a1', attestationExpiresAt: new Date(houstonManifest.deploymentAttestation.expiresAt), admitted: true, judged: ['declared', 'attested', 'observed'], trigger: 'manual', fetched: true });
    transport.peers.get('houston.example.org')!.manifestStatus = 500;
    transport.peers.get('houston.example.org')!.remoteAddress = SERVED_ADDRESS;
    await h.db.admin.query("UPDATE trustwork.federation_peer SET refresh_due_at = now() - interval '2 minutes' WHERE peer_node = 'houston.example.org'");
    await h.db.admin.query("UPDATE trustwork.federation_peer SET refresh_due_at = now() - interval '1 minute' WHERE peer_node = $1", [CITY]);
    const locked = await service.refreshDueLocked();
    assert.deepEqual(locked, { refreshed: [{ host: 'houston.example.org', outcome: 'failed' }, { host: CITY, outcome: 'admitted' }] });
    assert.ok((await h.db.admin.query<{ due: Date }>("SELECT refresh_due_at AS due FROM trustwork.federation_peer WHERE peer_node = 'houston.example.org'")).rows[0]!.due.getTime() < Date.now(), 'the failed peer stays due');
    // A second instance with the timer on (short interval for the test), while another instance holds the lock.
    const app2 = await createApp({
      env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', TRUSTWORK_HUB_ID: w.hubId, MAIL_SECRET_KEY: randomBytes(32).toString('hex'), TRUSTWORK_JURISDICTION_GATE: 'fake' },
      pool: h.pool, clock: h.clock, federation: { sealer: fakeNodeKeySealer(), transport, refresh: { enabled: true, intervalMs: 100 } }, logSink: () => undefined,
    });
    const timer = app2.app.get(FederationRefreshTimer);
    assert.equal(timer.active, true);
    transport.peers.get('houston.example.org')!.manifestStatus = 200;
    const lockHolder = await h.db.admin.connect();
    try {
      await lockHolder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [REFRESH_LOCK]);
      await h.db.admin.query("UPDATE trustwork.federation_peer SET refresh_due_at = now() - interval '1 minute' WHERE peer_node = $1", [CITY]);
      const fetches = transport.manifestFetches.length;
      assert.deepEqual(await service.refreshDueLocked(), { skipped: 'locked' });
      await sleep(400);
      assert.equal(transport.manifestFetches.length, fetches, 'nothing is fetched while another instance refreshes');
      await lockHolder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [REFRESH_LOCK]);
      await waitUntil(() => transport.manifestFetches.length > fetches, 5_000);
    } finally {
      lockHolder.release();
    }
    // Shutdown is deterministic: the interval is cleared, a tick in flight is awaited and begins no further fetch, so the
    // count read after close() is final.
    await app2.close();
    assert.equal(timer.active, false, 'the timer is cleared on shutdown');
    await h.db.admin.query("UPDATE trustwork.federation_peer SET refresh_due_at = now() - interval '1 minute' WHERE peer_node = $1", [CITY]);
    const afterClose = transport.manifestFetches.length;
    await timer.tick();
    await sleep(400);
    assert.equal(transport.manifestFetches.length, afterClose, 'no tick after shutdown');
    await service.refreshDue();
  });

  await t.test('limits and a hijacked origin: an oversized body is refused before it is read, an oversized peer answer is dropped, and a peer whose origin starts serving another genesis key is marked and closed', async () => {
    const big = Buffer.alloc(MAX_PEER_BODY + 1, 0x20);
    const tooLarge = await app.fastify.inject({ method: 'POST', url: HANDSHAKE_URL, headers: { 'content-type': 'application/json' }, payload: big, remoteAddress: SERVED_ADDRESS });
    assert.equal(tooLarge.statusCode, 413);
    assert.equal((JSON.parse(tooLarge.body) as { code: string }).code, 'federation.payload_too_large');
    const houston = transport.peers.get('houston.example.org')!;
    houston.manifestStatus = 200;
    houston.manifestBytes = () => new Uint8Array(MAX_PEER_BODY + 1);
    await assert.rejects(service.refreshPeer('houston.example.org', 'manual'), (e: unknown) => e instanceof PeerUnreachableError && /too large/.test(String((e.cause as Error).message)));
    delete houston.manifestBytes;
    // Hijacked origin: Houston's well-known URL starts serving a manifest with another genesis key.
    const genesis: NodeKey = { keyId: 'a1', algorithm: 'ed25519', publicKey: publicKeyB64(RFC8032.test1), validFrom: '2026-01-01T00:00:00.000Z', retiredAt: null, revocation: null, rotation: null };
    const hijackedUnsigned: Record<string, unknown> = { ...asManifest(houston.manifest()), keys: { current: 'a1', chain: [genesis] }, issuedAt: '2026-11-03T00:00:00.000Z' };
    delete hijackedUnsigned['signature'];
    const heldDigest = (await h.db.admin.query<{ d: string }>("SELECT manifest_digest AS d FROM trustwork.federation_peer WHERE peer_node = 'houston.example.org'")).rows[0]!.d;
    houston.manifest = () => signDocument('manifest', hijackedUnsigned, 'a1', signerFor(RFC8032.test1)) as unknown as Record<string, unknown>;
    await assert.rejects(service.refreshPeer('houston.example.org', 'refresh'), /another genesis key/);
    const row = (await h.db.admin.query<{ d: string; e: Date | null }>("SELECT manifest_digest AS d, equivocation_at AS e FROM trustwork.federation_peer WHERE peer_node = 'houston.example.org'")).rows[0]!;
    assert.equal(row.d, heldDigest, 'the held chain is kept');
    assert.ok(row.e, 'recorded for staff');
    assert.deepEqual(await service.flowAllowed('houston.example.org', 'syndicate'), { ok: false, code: 'federation.peer_restricted' });
  });

  await t.test('outbound connections fail closed: no address judgement, no connection; private addresses refused; a dripping peer hits the deadline; a manifest naming another node writes no refusal against that node', async () => {
    const envFor = (gate: string, extra: Record<string, string> = {}) => ({ API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', TRUSTWORK_HUB_ID: w.hubId, MAIL_SECRET_KEY: randomBytes(32).toString('hex'), TRUSTWORK_JURISDICTION_GATE: gate, ...extra });
    const connections = transport.connections.length;
    for (const [gate, extra] of [['edge_header', { TRUSTWORK_JURISDICTION_COUNTRY_HEADER: 'x-synthetic-country' }], ['upstream_gate', {}]] as const) {
      const other = await createApp({ env: envFor(gate, extra), pool: h.pool, clock: h.clock, federation: { sealer: fakeNodeKeySealer(), transport }, logSink: () => undefined });
      try {
        await assert.rejects(other.app.get(FederationNodeService).refreshPeer(CITY, 'manual'), /address judgement must be configured before federation goes live/, gate);
        // The console explains the same when a person asks to connect.
        const otherService = other.app.get(FederationNodeService);
        assert.deepEqual((await otherService.refreshDue(new Date(Date.now() + 365 * 86_400_000), 1)).map((r) => r.outcome), ['failed'], `${gate}: the daily refresh fails closed too`);
      } finally {
        await other.close();
      }
    }
    assert.equal(transport.connections.length, connections, 'a gate that cannot judge an address connects nowhere');
    // Private, loopback and link-local addresses are refused before connecting, whatever the gate says.
    for (const address of ['10.1.2.3', '127.0.0.1', '169.254.1.1', '192.168.0.9', '::1', 'fe80::1', '::ffff:10.0.0.1']) {
      austin.remoteAddress = address;
      await assert.rejects(service.refreshPeer(CITY, 'manual'), (e: unknown) => e instanceof PeerUnreachableError && /private, loopback or link-local/.test(String((e.cause as Error).message)), address);
    }
    austin.remoteAddress = SERVED_ADDRESS;
    assert.equal(transport.connections.length, connections);
    // A dripping peer: the exchange ends at the deadline, the refresh run goes on, nothing hangs.
    const houston = transport.peers.get('houston.example.org')!;
    houston.manifestDelayMs = 5_000;
    const started = Date.now();
    await h.db.admin.query("UPDATE trustwork.federation_peer SET refresh_due_at = now() - interval '1 minute' WHERE peer_node IN ($1, $2)", ['houston.example.org', CITY]);
    const run = await service.refreshDue();
    assert.ok(Date.now() - started < 3_000, 'the deadline, not the peer, ends the exchange');
    assert.deepEqual(run.map((r) => [r.host, r.outcome]).sort(), [[CITY, 'admitted'], ['houston.example.org', 'failed']]);
    delete houston.manifestDelayMs;
    // A manifest at one origin naming another node: refused as invalid, and no refusal names the node it claims to be.
    const refusals = await count('SELECT 1 FROM trustwork.admission_refusal');
    transport.add({ host: 'evil.example.org', manifest: () => manifestFor('victim.example.org', { jurisdiction: 'RU' }), remoteAddress: SERVED_ADDRESS, signer: { keyId: 'a1', sign: signerFor(RFC8032.test3) }, answer: austin.answer });
    await assert.rejects(service.refreshPeer('evil.example.org', 'manual'), (e: Error & { code?: string }) => e.code === 'federation.manifest_invalid');
    assert.equal(await count('SELECT 1 FROM trustwork.admission_refusal'), refusals, 'no refusal at all, and none naming victim.example.org');
    assert.equal(await count("SELECT 1 FROM trustwork.admission_refusal WHERE subject = 'victim.example.org'"), 0);
    assert.equal(await count("SELECT 1 FROM trustwork.federation_peer WHERE peer_node IN ('evil.example.org', 'victim.example.org')"), 0);
  });

  await t.test('no federation record carries a network address', async () => {
    for (const table of ['federation_peer', 'peering_record', 'peering_event', 'admission_refusal', 'node_identity', 'node_manifest', 'peer_deal_admission', 'peer_key_revocation']) {
      const rows = (await h.db.admin.query(`SELECT to_jsonb(t) AS row FROM trustwork.${table} t`)).rows as { row: unknown }[];
      const text = JSON.stringify(rows);
      assert.ok(!text.includes(RESTRICTED_ADDRESS) && !text.includes(SERVED_ADDRESS) && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text.replace(/"\d+\.\d+\.\d+"/g, '')), `${table} holds no address`);
      const columns = (await h.db.admin.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name = $1", [table])).rows;
      for (const { column_name: name } of columns) assert.doesNotMatch(name, /(^|_)(ip|addr|address|network|remote)(_|$)/, `${table}.${name}`);
    }
    assert.equal(await count("SELECT 1 FROM trustwork.federation_nonce WHERE peer_node = $1", [CITY]) > 0, true, 'nonces are remembered until the signature expires');
    assert.ok(attestationSummary().basis === 'operator_statement');
  });
});
