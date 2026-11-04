import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { computeDigest, HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import type { Client, Harness } from '../../helpers/app.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, signIn } from '../../../admin/helpers.js';
import { principalFor } from '../../../data/helpers/seed.js';
import { staffAssignments, type CommandContext } from '../../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../../packages/data/src/repositories/identity.js';
import { kernelReference, kernelSync } from '../../../../packages/data/src/repositories/kernel.js';
import { federationPeers, peeringRecords } from '../../../../packages/data/src/repositories/federation-node.js';
import { defaultDataLicences, type NodeManifest } from '../../../../packages/contracts/src/federation.js';
import { CITY, manifest as fixtureManifest } from '../../../federation/protocol/fixtures.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[] = []): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

/** Test role definitions over the console vocabulary (version 13, unused elsewhere), held at the node so they cover every hub. */
const PERMISSIONS = ['admin.node.hubs.manage', 'admin.node.keys.rotate', 'admin.hub.read', 'admin.federation.read', 'admin.federation.peer.edit', 'admin.federation.defederate', 'admin.audit.read'];
const VERSION = 13;
const HOST = 'crash.example.org';

async function ctxOf(h: Harness, personId: string): Promise<CommandContext> {
  const session = await withMaintenance(h.db.admin, (trx) => trx.insertInto('session').values({ person_id: personId, token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 3_600_000), absolute_expires_at: new Date(Date.now() + 3_600_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
  const elevation = await withPrincipal(h.pool, await principalFor(h.db.admin, personId), (trx) => sessionElevations.insert(trx, { sessionId: session.id, personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 900_000) }));
  return { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic crash test setup' };
}
const as = async <T>(h: Harness, personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>): Promise<T> => {
  const ctx = await ctxOf(h, personId);
  return withPrincipal(h.pool, await principalFor(h.db.admin, personId), (trx) => fn(trx, ctx));
};

/**
 * FED-001: every federation route that completes in its transaction, crashed before and after the commit. One synthetic
 * node operator (assigned by the founding platform owner of the ADM-001 case) sets up the node identity, asks for a key
 * rotation (which asks a second person) and decides peering records of a synthetic hub with the Austin peer of the
 * protocol fixtures. The key-encryption key is a random test value set for this process only; every person, hub and
 * node is synthetic and nothing touches the network.
 */
export default {
  name: 'FED-001: node identity, key rotation request, peering decisions and defederation',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const founder = (await admin.query<{ person_id: string; node: string }>("SELECT a.person_id, (SELECT id FROM trustwork.admin_node LIMIT 1) AS node FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap AND a.revoked_at IS NULL AND a.role = 'platform-owner'")).rows[0];
    assert.ok(founder, 'the ADM-001 case set up the founding administrators');
    await withMaintenance(admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
    const steward = await withMaintenance(admin, async (trx) => {
      await trx.insertInto('staff_role_definition_version').values({ role: 'data-steward', version: VERSION, scopes: ['node'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' }).onConflict((oc) => oc.doNothing()).execute();
      return (await trx.insertInto('person').values({ display_name: 'Synthetic Federation Data Steward' }).returning('id').executeTakeFirstOrThrow()).id;
    });
    await as(h, founder.person_id, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId: steward, role: 'data-steward', scope: { kind: 'node', nodeId: founder.node }, definitionVersion: VERSION }));
    h.staff.set(steward, ['data-steward']);
    await addLogins(h, [[steward, 'crash-fed-steward@example.invalid']]);
    const client: Client = h.client();
    await signIn(client, 'crash-fed-steward@example.invalid');
    const secret = await enrolNow(h, client);
    h.clock.advance(30_000);
    const elevated = await client.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
    assert.equal(elevated.status, 200, `elevate: ${JSON.stringify(elevated.body)}`);
    const cmd = (action: string, rest: Record<string, unknown> = {}) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
    const run = (action: string, url: string, rest: Record<string, unknown>, effects: () => Promise<number>) => exactlyOnce({ action, client, url, body: cmd(action, rest), effects });
    const audited = (action: string) => () => count(h, "SELECT 1 FROM trustwork.admin_audit_event WHERE action = $1 AND outcome = 'applied'", [action]);
    const base = '/v1/admin/federation';

    // The launched hub the peering records belong to (inserted as maintenance, like the hubs case's launched fixture), and the key-encryption key of this test process.
    const hub = await withMaintenance(admin, async (trx) => {
      const row = await trx.insertInto('hub').values({ slug: 'synthetic-fed-crash-hub', lifecycle: 'public' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('hub_profile').values({ hub_id: row.id, node_id: founder.node, name: { en: 'Synthetic federation crash hub' }, default_locale: 'en', locales: ['en'], time_zone: 'America/Los_Angeles', currency: 'USD', created_by: steward }).execute();
      await trx.insertInto('hub_territory').values({ hub_id: row.id, level: 'place', code: 'US-CA:san-diego', place_key: 'san-diego' }).execute();
      return { hub_id: row.id };
    });
    const previousKek = process.env.TRUSTWORK_KEK;
    process.env.TRUSTWORK_KEK = randomBytes(32).toString('hex');
    try {
      // Node identity and keys.
      await run('federation.node_initialize', `${base}/node`, { host: HOST, operatorName: 'Synthetic Crash Builders', registration: null, abuseContact: `mailto:abuse@${HOST}`, takedownContact: `https://${HOST}/legal/takedown`, jurisdiction: 'US-CA' },
        () => count(h, 'SELECT 1 FROM trustwork.node_identity'));
      await run('federation.node_update', `${base}/node/update`, { expectedRevision: 1, operatorName: 'Synthetic Crash Builders Association', registration: null, abuseContact: `mailto:abuse@${HOST}`, takedownContact: `https://${HOST}/legal/takedown`, jurisdiction: 'US-CA' },
        audited('federation.node_updated'));
      await run('federation.key_rotate', `${base}/node/keys/rotate`, { nextKeyId: 'k2', compromisedSince: null, approvalId: null },
        () => count(h, "SELECT 1 FROM trustwork.second_person_approval WHERE action = 'ops.rotate_node_key'"));

      // Peering records: the Austin peer of the protocol fixtures is admitted and asks twice; one request is declined, the other accepted and then lowered, suspended, lifted and ended.
      const peerManifest = fixtureManifest({ node: CITY }) as NodeManifest;
      await federationPeers.record(h.pool, { peerNode: CITY, manifest: peerManifest, manifestDigest: computeDigest(peerManifest).value, manifestIssuedAt: new Date(peerManifest.issuedAt), currentKeyId: 'a1', attestationExpiresAt: new Date(peerManifest.deploymentAttestation.expiresAt), admitted: true, judged: ['declared', 'attested', 'observed'], trigger: 'handshake' });
      const terms = { licences: defaultDataLicences(), tombstoneHours: 72, agentEnvelopesPerHour: 60 };
      const incoming = (peerHubId: string) => peeringRecords.handshakeReceived(h.pool, { peerNode: CITY, peerHubId, localHubId: hub.hub_id, level: 'trust_verifications', manifestDigest: computeDigest(peerManifest).value, keyId: 'a1', ...terms });
      const declined = await incoming('us-tx-austin');
      await run('federation.peering_decline', `${base}/peerings/${declined.id}/decline`, { expectedRevision: declined.revision }, audited('federation.peering_declined'));
      const second = await incoming('us-tx-austin-east');
      // Acceptance commits first; the handshake to the peer is sent after the commit (the transport is offline here, so it is retried by refreshes).
      await run('federation.peering_accept', `${base}/peerings/${second.id}/accept`, { expectedRevision: second.revision, level: 'trust_verifications', approvalId: null }, audited('federation.peering_accepted'));
      const active = await peeringRecords.peerAnswered(h.pool, second.id, { outcome: 'admitted', level: 'trust_verifications', state: 'active' });
      assert.equal(active.state, 'active');
      // A request to the peer's hub of the manifest (its earlier record ended; the peer is held and admitted today, so the offline transport does not stop it) and a refresh of the peer.
      await run('federation.peering_request', `${base}/peerings`, { localHubId: hub.hub_id, peerNode: CITY, peerHubId: 'us-tx-austin', level: 'syndicate', approvalId: null },
        () => count(h, "SELECT 1 FROM trustwork.peering_record WHERE peer_hub_id = 'us-tx-austin' AND direction = 'outgoing'"));
      await run('federation.peer_refresh', `${base}/peers/refresh`, { peerNode: CITY }, audited('federation.peer_refreshed'));
      const revision = async () => (await admin.query<{ revision: number }>('SELECT revision FROM trustwork.peering_record WHERE id = $1', [active.id])).rows[0]!.revision;
      await run('federation.peering_lower', `${base}/peerings/${active.id}/lower`, { expectedRevision: await revision(), level: 'syndicate' }, audited('federation.peering_lowered'));
      await run('federation.peering_suspend', `${base}/peerings/${active.id}/suspend`, { expectedRevision: await revision() }, audited('federation.peering_suspended'));
      await run('federation.peering_lift', `${base}/peerings/${active.id}/lift`, { expectedRevision: await revision() }, audited('federation.peering_suspension_lifted'));
      await run('federation.defederate', `${base}/peerings/${active.id}/end`, { expectedRevision: await revision() }, audited('federation.defederated'));
    } finally {
      if (previousKek === undefined) delete process.env.TRUSTWORK_KEK;
      else process.env.TRUSTWORK_KEK = previousKek;
    }
  },
} satisfies CrashCase;
