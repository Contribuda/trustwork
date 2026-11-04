import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, withMaintenance, type DataPool } from '@trustwork/data';
import { computeDigest } from '@trustwork/contracts';
import { fakeNodeKeySealer, generateNodeKey } from '../../../apps/api/src/modules/federation/node/crypto.js';
import { peeringLevelDigestInput } from '../../../apps/api/src/modules/federation/node/schemas.js';
import { defaultDataLicences, type NodeManifest } from '../../../packages/contracts/src/federation.js';
import { federationPeers, nodeIdentity, nodeKeys, peeringRecords, type PeeringTerms } from '../../../packages/data/src/repositories/federation-node.js';
import { TABLE_COLUMNS } from '../../../packages/data/src/schema/federation-node.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { CITY, manifest as fixtureManifest } from '../protocol/fixtures.js';
import { buildWorld, OUR_HOST, PEER_HUB, rejects, RESTRICTED_ADDRESS, settle } from './helpers.js';

// Weight 2: the runtime pool races concurrent requests, acceptances, handshakes and nonces.
const db = await provisionTestDatabase('federation_node_data', { weight: 2 });

/*
 * FED-001 persistence under the restricted runtime role: who may write what, the double opt-in state machine with its
 * second approver, suspension and defederation, row-level security, append-only history, and the races that must resolve
 * to exactly one effect (one open record per hub pair, one acceptance, one handshake record, one nonce).
 */
test('federation node persistence', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 12 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const { w, a } = await buildWorld(db.admin, runtime);
  const p = w.people;
  const peerManifest = fixtureManifest({ node: CITY }) as NodeManifest;
  const terms: PeeringTerms = { licences: defaultDataLicences(), tombstoneHours: 72, agentEnvelopesPerHour: 60 };
  const admitPeer = () => federationPeers.record(runtime, {
    peerNode: CITY, manifest: peerManifest, manifestDigest: computeDigest(peerManifest).value, manifestIssuedAt: new Date(peerManifest.issuedAt), currentKeyId: 'a1',
    attestationExpiresAt: new Date(peerManifest.deploymentAttestation.expiresAt), admitted: true, judged: ['declared', 'attested', 'observed'], trigger: 'handshake', fetched: true,
  });
  const count = async (query: string, params: unknown[] = []): Promise<number> => (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;
  const revisionOf = async (id: string) => (await db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.peering_record WHERE id = $1', [id])).rows[0]!.revision;

  await t.test('the schema mirror matches and no column names an address', async () => {
    for (const table of Object.keys(TABLE_COLUMNS)) {
      const columns: { column_name: string }[] = (await db.admin.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name = $1", [table])).rows;
      const mirrored: readonly string[] = (TABLE_COLUMNS as Record<string, readonly string[]>)[table]!;
      assert.deepEqual(columns.map((r) => r.column_name).sort(), [...mirrored].sort(), table);
      for (const { column_name: name } of columns) assert.doesNotMatch(name, /(^|_)(ip|addr|address|network|remote|observed)(_|$)/, `${table}.${name}`);
    }
  });

  await t.test('node identity: node staff only; the chain appends in order and keys are immutable', async () => {
    const { publicKey, seed } = generateNodeKey();
    const sealed = await fakeNodeKeySealer().seal(seed, w.nodeId, 'k1');
    seed.destroy();
    const input = { host: OUR_HOST, engineVersion: '0.1.0', engineSource: 'https://github.com/Contribuda/trustwork', operatorName: 'Synthetic San Diego Builders Association', registration: null, abuseContact: `mailto:abuse@${OUR_HOST}`, takedownContact: `https://${OUR_HOST}/legal/takedown`, jurisdiction: 'US-CA', licences: defaultDataLicences(), tombstoneHours: 72, offeredLevels: ['syndicate', 'trust_verifications', 'deal_routing', 'identity'] as const, agentEnvelopesPerHour: 60 };
    const key = { keyId: 'k1', publicKey, validFrom: new Date(), sealed };
    await rejects(a.cmd(p.owner, (trx, ctx) => nodeIdentity.init(trx, ctx, { ...input, offeredLevels: [...input.offeredLevels], key })), '42501', 'admin.forbidden');
    await rejects(a.cmd(p.outsider, (trx, ctx) => nodeIdentity.init(trx, ctx, { ...input, offeredLevels: [...input.offeredLevels], key })), '42501', 'admin.forbidden');
    await rejects(a.cmd(p.operator, (trx, ctx) => nodeIdentity.init(trx, ctx, { ...input, offeredLevels: [...input.offeredLevels], jurisdiction: 'UA-43', key })), '23514', 'federation.restricted_place');
    const identity = await a.cmd(p.operator, (trx, ctx) => nodeIdentity.init(trx, ctx, { ...input, offeredLevels: [...input.offeredLevels], key }));
    assert.equal(identity.host, OUR_HOST);
    await rejects(a.cmd(p.operator, (trx, ctx) => nodeIdentity.init(trx, ctx, { ...input, offeredLevels: [...input.offeredLevels], key })), '23505', 'federation.identity_exists');
    // Nobody reads the sealed seed directly; the runtime process reads the material through the definer and the owner cannot UPDATE or DELETE it.
    await assert.rejects(runtime.query('SELECT * FROM trustwork.node_key_secret'), /permission denied/);
    assert.equal((await nodeKeys.signingMaterial(runtime))?.key_id, 'k1');
    // The sealed material (ciphertext under the KEK) is readable only on the signer path, which marks its own transaction; a plain query gets nothing.
    await rejects(runtime.query('SELECT * FROM trustwork.federation_node_signing_material(NULL)'), '42501', 'federation.signer_only');
    await assert.rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('node_key_secret').execute()), /append-only/);
    // The chain appends in order and never edits an entry; a retired key retires once.
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('node_key').values({ node_id: w.nodeId, key_id: 'k9', position: 5, public_key: 'B'.repeat(43), valid_from: new Date(), created_by: p.operator }).execute()), '23514', 'federation.chain_order');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('node_key').set({ public_key: 'C'.repeat(43) }).where('key_id', '=', 'k1').execute()), '23000', 'admin.immutable');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('node_key').execute()), '23000', 'audit.append_only');
  });

  await t.test('peering requests: hub staff with the permission only; the peer must be admitted; deal_routing needs a second person bound to the exact peering', async () => {
    const request = (person: string, level: 'syndicate' | 'deal_routing', approvalId: string | null = null, peerHubId = PEER_HUB) =>
      a.cmd(person, (trx, ctx) => peeringRecords.request(trx, ctx, { localHubId: w.hubId, peerNode: CITY, peerHubId, level, approvalId, ...terms }));
    await rejects(request(p.owner, 'syndicate'), '42501', 'federation.peer_restricted');
    await admitPeer();
    await rejects(request(p.moderator, 'syndicate'), '42501', 'admin.forbidden');
    await rejects(request(p.outsider, 'syndicate'), '42501', 'admin.forbidden');
    await rejects(request(p.owner, 'deal_routing'), '42501', 'admin.approval_required');
    const digestInput = peeringLevelDigestInput({ localHubId: w.hubId, peerNode: CITY, peerHubId: PEER_HUB, level: 'deal_routing' });
    const approval = await a.approve(p.owner, p.officer, 'federation.raise_peering_level', { kind: 'hub', hubId: w.hubId }, digestInput);
    // The approval binds the level and the hub pair: another level or another peer hub is refused.
    await rejects(request(p.owner, 'syndicate', approval), '23514', 'admin.approval_mismatch');
    await rejects(request(p.owner, 'deal_routing', approval, 'other-hub'), '23514', 'admin.approval_mismatch');
    // Only the requester executes the approval.
    await rejects(request(p.officer, 'deal_routing', approval), '42501', 'admin.not_requester');
    const record = await request(p.owner, 'deal_routing', approval);
    assert.deepEqual([record.direction, record.state, record.phase, record.level, record.requested_by, record.second_approver_id, record.approval_id], ['outgoing', 'pending_approval', 'awaiting_peer', 'deal_routing', p.owner, p.officer, approval]);
    assert.ok(record.local_accepted_at && !record.peer_accepted_at);
    // One open record per hub pair; a consumed approval is spent.
    await rejects(request(p.owner, 'syndicate'), '23505');
    const second = await a.approve(p.owner, p.officer, 'federation.raise_peering_level', { kind: 'hub', hubId: w.hubId }, digestInput);
    await rejects(request(p.owner, 'deal_routing', second), '23505');
    // The peer refuses: the record ends and never changes again.
    const refused = await peeringRecords.peerAnswered(runtime, record.id, { outcome: 'refused', code: 'federation.peer_restricted' });
    assert.deepEqual([refused.state, refused.end_reason], ['ended', 'refused_by_peer']);
    await rejects(a.cmd(p.owner, (trx, ctx) => peeringRecords.suspend(trx, ctx, record.id, refused.revision)), '23514', 'federation.ended');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('peering_record').set({ level: 'identity' }).where('id', '=', record.id).execute()), '23000', 'federation.ended');
  });

  await t.test('races: concurrent requests for one hub pair, concurrent acceptances and concurrent handshakes resolve to exactly one effect', async () => {
    const request = () => a.cmd(p.owner, (trx, ctx) => peeringRecords.request(trx, ctx, { localHubId: w.hubId, peerNode: CITY, peerHubId: PEER_HUB, level: 'syndicate', approvalId: null, ...terms }));
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => settle(request())));
    assert.equal(outcomes.filter((o) => o === null).length, 1, 'exactly one request wins');
    assert.ok(outcomes.filter((o) => o !== null).every((o) => o!.code === '23505'));
    const open = (await db.admin.query<{ id: string }>("SELECT id FROM trustwork.peering_record WHERE state <> 'ended'")).rows;
    assert.equal(open.length, 1);
    // The peer accepts: its handshake answers our open record; repeated or concurrent handshakes change nothing more.
    const handshake = () => peeringRecords.handshakeReceived(runtime, { peerNode: CITY, peerHubId: PEER_HUB, localHubId: w.hubId, level: 'syndicate', manifestDigest: computeDigest(peerManifest).value, keyId: 'a1', ...terms });
    const answers = await Promise.all(Array.from({ length: 4 }, () => handshake()));
    assert.ok(answers.every((r) => r.id === open[0]!.id && r.state === 'active'));
    assert.equal(await count("SELECT 1 FROM trustwork.peering_record WHERE state <> 'ended'"), 1);
    assert.equal(await count("SELECT 1 FROM trustwork.peering_event WHERE peering_record_id = $1 AND event = 'peering.peer_accepted'", [open[0]!.id]), 1, 'one activation event');
    // Concurrent protective commands with the same revision: one wins, the others see a stale revision.
    const revision = await revisionOf(open[0]!.id);
    const protective = await Promise.all([
      settle(a.cmd(p.owner, (trx, ctx) => peeringRecords.suspend(trx, ctx, open[0]!.id, revision))),
      settle(a.cmd(p.owner, (trx, ctx) => peeringRecords.end(trx, ctx, open[0]!.id, revision))),
      settle(a.cmd(p.officer, (trx, ctx) => peeringRecords.suspend(trx, ctx, open[0]!.id, revision))),
    ]);
    assert.equal(protective.filter((o) => o === null).length, 1, 'exactly one protective command applies');
    assert.ok(protective.filter((o) => o !== null).every((o) => o!.hint === 'federation.revision_conflict' || o!.hint === 'federation.ended' || o!.hint === 'federation.invalid_transition'), JSON.stringify(protective));
    // Clean up for the next scenario: end whatever stands (defederation is always possible).
    const row = (await db.admin.query<{ state: string; revision: number }>('SELECT state, revision FROM trustwork.peering_record WHERE id = $1', [open[0]!.id])).rows[0]!;
    if (row.state !== 'ended') await a.cmd(p.owner, (trx, ctx) => peeringRecords.end(trx, ctx, open[0]!.id, row.revision));
  });

  await t.test('an incoming request: concurrent first handshakes create one record; concurrent acceptances activate it once; the second approver is enforced by the database', async () => {
    const handshake = (level: 'syndicate' | 'identity') => peeringRecords.handshakeReceived(runtime, { peerNode: CITY, peerHubId: PEER_HUB, localHubId: w.hubId, level, manifestDigest: computeDigest(peerManifest).value, keyId: 'a1', ...terms });
    const created = await Promise.all(Array.from({ length: 4 }, () => handshake('identity')));
    const ids = new Set(created.map((r) => r.id));
    assert.equal(ids.size, 1, 'one incoming record');
    const incoming = created[0]!;
    assert.deepEqual([incoming.direction, incoming.phase, incoming.requested_by, incoming.local_accepted_at], ['incoming', 'awaiting_acceptance', null, null]);
    // identity needs a second person; syndicate does not; acceptance grants at most the requested level.
    await rejects(a.cmd(p.owner, (trx, ctx) => peeringRecords.accept(trx, ctx, incoming.id, incoming.revision, 'identity', null)), '42501', 'admin.approval_required');
    await rejects(a.cmd(p.moderator, (trx, ctx) => peeringRecords.accept(trx, ctx, incoming.id, incoming.revision, 'syndicate', null)), '42501', 'admin.forbidden');
    const digestInput = peeringLevelDigestInput({ localHubId: w.hubId, peerNode: CITY, peerHubId: PEER_HUB, level: 'identity' });
    const approval = await a.approve(p.owner, p.officer, 'federation.raise_peering_level', { kind: 'hub', hubId: w.hubId }, digestInput);
    // Nobody approves their own request; the database refuses a self-approval at decision time (tested in DATA-002) and a consumed approval of someone else here.
    await rejects(a.cmd(p.officer, (trx, ctx) => peeringRecords.accept(trx, ctx, incoming.id, incoming.revision, 'identity', approval)), '42501', 'admin.not_requester');
    const concurrent = await Promise.all([
      settle(a.cmd(p.owner, (trx, ctx) => peeringRecords.accept(trx, ctx, incoming.id, incoming.revision, 'identity', approval))),
      settle(a.cmd(p.owner, (trx, ctx) => peeringRecords.accept(trx, ctx, incoming.id, incoming.revision, 'identity', approval))),
      settle(a.cmd(p.officer, (trx, ctx) => peeringRecords.accept(trx, ctx, incoming.id, incoming.revision, 'syndicate', null))),
    ]);
    assert.equal(concurrent.filter((o) => o === null).length, 1, 'exactly one acceptance');
    const accepted = (await db.admin.query<{ level: string; phase: string; requested_by: string; second_approver_id: string | null; approval_id: string | null }>('SELECT level, phase, requested_by, second_approver_id, approval_id FROM trustwork.peering_record WHERE id = $1', [incoming.id])).rows[0]!;
    assert.equal(accepted.phase, 'awaiting_peer');
    if (accepted.level === 'identity') assert.deepEqual([accepted.requested_by, accepted.second_approver_id, accepted.approval_id], [p.owner, p.officer, approval]);
    else assert.deepEqual([accepted.level, accepted.requested_by, accepted.second_approver_id], ['syndicate', p.officer, null]);
    // The peer's signed answer activates the record exactly once.
    const activated = await Promise.all([peeringRecords.peerAnswered(runtime, incoming.id, { outcome: 'admitted', level: 'identity', state: 'active' }), peeringRecords.peerAnswered(runtime, incoming.id, { outcome: 'admitted', level: 'identity', state: 'active' })]);
    assert.ok(activated.every((r) => r.state === 'active'));
    assert.equal(await count("SELECT 1 FROM trustwork.peering_event WHERE peering_record_id = $1 AND event = 'peering.activated'", [incoming.id]), 1);
    assert.equal(await federationPeers.flowAllowed(runtime, CITY, accepted.level === 'identity' ? 'identity' : 'syndicate', w.hubId), 'ok');
    // An active record above trust_verifications never loses its second approver, whoever writes it (the guard keeps the approval, the constraint the approver).
    if (accepted.level === 'identity') {
      const stripped = await settle(withMaintenance(db.admin, (trx) => trx.updateTable('peering_record').set({ second_approver_id: null, approval_id: null }).where('id', '=', incoming.id).execute()));
      assert.ok(stripped && ['23000', '23514'].includes(stripped.code ?? ''), JSON.stringify(stripped));
    }
    // Whoever won, an active record at identity without an approval is impossible to write directly.
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('peering_record').set({ level: 'identity', second_approver_id: null, approval_id: null }).where('id', '=', incoming.id).where('level', '=', 'syndicate').execute()).then(async (r) => { if (Number(r[0]?.numUpdatedRows ?? 0) === 0) throw Object.assign(new Error('no row'), { code: '23514' }); }), '23514');
  });

  await t.test('row-level security: federation staff of the node or the hub read records; others see nothing; refusals only for node compliance and audit readers', async () => {
    await federationPeers.refusal(runtime, { service: 'federation_handshake', subject: 'houston.example.org', decidedAt: new Date(), findings: [{ reason: 'restricted_place', kind: 'observed', source: 'observed_location', place: 'CU', dataset: 'fake' }], geolocation: { mode: 'fake', dataset: 'fake' } });
    const rows = async (person: string, table: 'peering_record' | 'federation_peer' | 'peering_event' | 'admission_refusal'): Promise<unknown[]> => a.as(person, (trx) => trx.selectFrom(table).selectAll().execute() as Promise<unknown[]>);
    assert.ok((await rows(p.owner, 'peering_record')).length >= 2);
    assert.ok((await rows(p.officer, 'peering_record')).length >= 2);
    assert.equal((await rows(p.operator, 'federation_peer')).length, 1);
    assert.equal((await rows(p.owner, 'federation_peer')).length, 1, 'hub staff see the peers their hub has records with');
    assert.deepEqual(await rows(p.moderator, 'peering_record'), []);
    assert.deepEqual(await rows(p.outsider, 'peering_record'), []);
    assert.deepEqual(await rows(p.moderator, 'peering_event'), []);
    assert.deepEqual(await rows(p.outsider, 'federation_peer'), []);
    assert.equal((await rows(p.officer, 'admission_refusal')).length, 1);
    assert.deepEqual(await rows(p.owner, 'admission_refusal'), [], 'audit.read at the hub does not open node-level refusal records');
    assert.deepEqual(await rows(p.outsider, 'admission_refusal'), []);
    // Everyone reads the identity, the public chain and the manifests; nobody the nonces.
    assert.equal((await rows(p.outsider, 'peering_record')).length, 0);
    assert.equal((await a.as(p.outsider, (trx) => trx.selectFrom('node_key').selectAll().execute())).length, 1);
    await assert.rejects(runtime.query('SELECT * FROM trustwork.federation_nonce'), /permission denied/);
  });

  await t.test('fail closed without any refresh: a peer past its refresh by more than a day, or with an expired attestation, has no flow, handshake or request until a fresh admission', async () => {
    const stale = { peerNode: CITY, peerHubId: 'us-tx-austin-stale', localHubId: w.hubId, level: 'syndicate' as const, manifestDigest: computeDigest(peerManifest).value, keyId: 'a1', ...terms };
    assert.equal(await federationPeers.flowAllowed(runtime, CITY, 'syndicate', w.hubId), 'ok');
    // Within the day after the due refresh the admission still stands; past that day it does not, whatever a timer did.
    await db.admin.query("UPDATE trustwork.federation_peer SET refresh_due_at = now() - interval '2 hours' WHERE peer_node = $1", [CITY]);
    assert.equal(await federationPeers.flowAllowed(runtime, CITY, 'syndicate', w.hubId), 'ok');
    await db.admin.query("UPDATE trustwork.federation_peer SET refresh_due_at = now() - interval '25 hours' WHERE peer_node = $1", [CITY]);
    assert.equal(await federationPeers.flowAllowed(runtime, CITY, 'syndicate', w.hubId), 'federation.peer_restricted');
    await rejects(peeringRecords.handshakeReceived(runtime, stale), '42501', 'federation.peer_restricted');
    await rejects(a.cmd(p.owner, (trx, ctx) => peeringRecords.request(trx, ctx, { localHubId: w.hubId, peerNode: CITY, peerHubId: 'us-tx-austin-stale', level: 'syndicate', approvalId: null, ...terms })), '42501', 'federation.peer_restricted');
    // An expired attestation fails closed the same way.
    await db.admin.query("UPDATE trustwork.federation_peer SET refresh_due_at = now() + interval '20 hours', attestation_expires_at = now() - interval '1 minute' WHERE peer_node = $1", [CITY]);
    assert.equal(await federationPeers.flowAllowed(runtime, CITY, 'syndicate', w.hubId), 'federation.peer_restricted');
    await rejects(peeringRecords.handshakeReceived(runtime, stale), '42501', 'federation.peer_restricted');
    // A fresh admission restores the flows; the records themselves were never touched.
    await admitPeer();
    assert.equal(await federationPeers.flowAllowed(runtime, CITY, 'syndicate', w.hubId), 'ok');
    assert.equal(await count("SELECT 1 FROM trustwork.peering_record WHERE peer_hub_id = 'us-tx-austin-stale'"), 0);
  });

  await t.test('only a fetch from the origin lifts a refusal or moves the refresh: a re-admission without a fetch keeps a refusal and moves nothing; a first row needs a fetch', async () => {
    const base = { peerNode: CITY, manifest: peerManifest, manifestDigest: computeDigest(peerManifest).value, manifestIssuedAt: new Date(peerManifest.issuedAt), currentKeyId: 'a1', attestationExpiresAt: new Date(peerManifest.deploymentAttestation.expiresAt), judged: ['declared', 'attested', 'observed'] };
    const state = async () => (await db.admin.query<{ admission_state: string; due: Date; revision: number }>('SELECT admission_state, refresh_due_at AS due, revision FROM trustwork.federation_peer WHERE peer_node = $1', [CITY])).rows[0]!;
    await admitPeer();
    const admitted = await state();
    // A refusal without a fetch (the address the gate refused) suspends the flows and moves no refresh.
    const refused = await federationPeers.record(runtime, { ...base, admitted: false, judged: [], trigger: 'refresh', suspensionReason: 'admission_refused', fetched: false });
    assert.equal(refused.admission_state, 'refused');
    assert.equal((await state()).due.getTime(), admitted.due.getTime(), 'no fetch, no refresh moved');
    assert.equal(await federationPeers.flowAllowed(runtime, CITY, 'syndicate', w.hubId), 'federation.peer_restricted');
    // An admission without a fetch (a handshake from a clean address, a deal, a changed statement) changes nothing: the row comes back as it is.
    const kept = await federationPeers.record(runtime, { ...base, admitted: true, trigger: 'handshake', fetched: false });
    assert.equal(kept.admission_state, 'refused');
    assert.equal(kept.revision, refused.revision, 'nothing written');
    assert.equal(await federationPeers.flowAllowed(runtime, CITY, 'syndicate', w.hubId), 'federation.peer_restricted');
    // A fetch from the origin that passes lifts the refusal and moves the refresh.
    const lifted = await federationPeers.record(runtime, { ...base, admitted: true, trigger: 'refresh', fetched: true });
    assert.equal(lifted.admission_state, 'admitted');
    assert.ok(lifted.refresh_due_at.getTime() > admitted.due.getTime(), 'the fetch moved the refresh');
    assert.equal(await federationPeers.flowAllowed(runtime, CITY, 'syndicate', w.hubId), 'ok');
    // A peer's first row comes from a fetch of its origin, never from a request.
    const stranger = { ...peerManifest, node: 'elpaso.example.org' } as NodeManifest;
    await rejects(federationPeers.record(runtime, { ...base, peerNode: 'elpaso.example.org', manifest: stranger, manifestDigest: computeDigest(stranger).value, admitted: true, trigger: 'handshake', fetched: false }), '22023', 'federation.fetch_required');
    assert.equal(await count("SELECT 1 FROM trustwork.federation_peer WHERE peer_node = 'elpaso.example.org'"), 0);
  });

  await t.test('replay nonces: concurrent notes of one nonce accept exactly once; expired nonces are purged', async () => {
    const nonce = randomBytes(24).toString('base64url');
    const results = await Promise.all(Array.from({ length: 6 }, () => federationPeers.noteNonce(runtime, { peerNode: CITY, keyId: 'a1', nonce, expiresAt: new Date(Date.now() + 300_000) })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await federationPeers.noteNonce(runtime, { peerNode: CITY, keyId: 'a2', nonce, expiresAt: new Date(Date.now() + 300_000) }), true, 'a nonce is remembered per key');
    await db.admin.query("UPDATE trustwork.federation_nonce SET expires_at = now() - interval '10 minutes' WHERE nonce = $1", [nonce]);
    assert.equal(await federationPeers.purgeNonces(runtime), 2);
  });

  await t.test('no address reaches a record: checks on subjects, events, manifests and refusals; the peer name is a DNS name', async () => {
    await rejects(federationPeers.refusal(runtime, { service: 'federation_handshake', subject: RESTRICTED_ADDRESS, decidedAt: new Date(), findings: [{ reason: 'evidence_missing' }], geolocation: null }), '22023', 'federation.subject_is_address');
    const record = (await db.admin.query<{ id: string }>('SELECT id FROM trustwork.peering_record LIMIT 1')).rows[0]!;
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('peering_event').values({ peering_record_id: record.id, event: 'peering.note', details: sql`${JSON.stringify({ seenFrom: RESTRICTED_ADDRESS })}::jsonb` }).execute()), '23514');
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('peering_event').values({ peering_record_id: record.id, event: 'peering.note', reason: RESTRICTED_ADDRESS }).execute()), '23514');
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('admission_refusal').values({ node_id: w.nodeId, service: 'federation_handshake', subject: 'ok.example.org', decided_at: new Date(), findings: sql`${JSON.stringify([{ place: '2001:db8::5' }])}::jsonb`, geolocation: null }).execute()), '23514');
    await rejects(federationPeers.record(runtime, { peerNode: '192.0.2.44', manifest: peerManifest, manifestDigest: computeDigest(peerManifest).value, manifestIssuedAt: new Date(), currentKeyId: 'a1', attestationExpiresAt: new Date(Date.now() + 86_400_000), admitted: true, judged: [], trigger: 'manual', fetched: true }), '22023', 'federation.host_invalid');
    const { rows } = await db.admin.query<{ ok: boolean }>("SELECT trustwork.federation_is_address(x) AS ok FROM unnest(ARRAY['192.0.2.44', '[2001:db8::5]:443', '::ffff:192.0.2.9', '2001:db8::', 'austin.example.org', 'US-TX:austin', '2026-11-01T00:00:00.000Z', '0.1.0']) x");
    assert.deepEqual(rows.map((r) => r.ok), [true, true, true, true, false, false, false, false]);
  });

  await t.test('history is never rewritten: events, refusals and manifests are append-only for every writer', async () => {
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('peering_event').execute()), '23000');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('peering_event').set({ event: 'peering.rewritten' }).execute()), '23000');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('admission_refusal').execute()), '23000');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('peering_record').execute()), '23000', 'audit.append_only');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('federation_peer').execute()), '23000', 'audit.append_only');
  });
});
