import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import { SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../admin/helpers.js';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { actors, buildHubWorld, syncKernel, type HubWorld } from '../hubs/helpers.js';

const h = await startHarness('datasets_api');
const PERMISSIONS = ['admin.sources.read', 'admin.datasets.read', 'admin.datasets.edit', 'admin.datasets.activate', 'admin.links.decide'];
const USES = {
  displayHeadlineAndLink: true, displaySummary: true, storeFullText: false, indexForSearch: true, sendToModelProviders: false, translate: false, rewriteWithAttribution: false,
  reuseImages: false, syndicateToPeers: false,
};

/**
 * MINE-001 through the HTTP API on real PostgreSQL with real sessions, TOTP and elevated sessions: staff routes refuse
 * a participant, an unelevated staff member and staff of another hub; reputation never reaches the database as an
 * output; a person dataset with public display is refused; the proposer cannot activate; records carry provenance
 * from the source; a dataset of another hub is not found; the do-not-collect answer names only a count. Every person,
 * hub, company, record and source is synthetic.
 */
test('MINE-001 datasets API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const admin = h.db.admin;
  await syncKernel(admin);
  const w: HubWorld = await buildHubWorld(admin);
  const a = actors(admin, h.pool, w);
  await withMaintenance(admin, (trx) => staffRoleDefinitions.release(trx, { version: 1, role: 'data-steward', scopes: ['hub'], permissions: PERMISSIONS as never,
    caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub('synthetic-datasets-api')).hub_id;
  const otherHubId = (await a.createHub('synthetic-datasets-other')).hub_id;
  const seeded = await withMaintenance(admin, async (trx) => {
    const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    const people = { staff: await person('Synthetic Datasets Staff'), second: await person('Synthetic Datasets Second'), elsewhere: await person('Synthetic Other Hub Steward'),
      participant: await person('Synthetic Participant') };
    const sourceId = (await trx.insertInto('source').values({
      hub_id: hubId, kind: 'register_open_data', name: 'Synthetic API Business Register', url: 'https://register.synthetic-api.invalid/data', reader_kind: 'official_register',
      purposes: ['company_directory'], licence_kind: 'statutory_public', allowed_uses: JSON.stringify(USES), attribution_template: 'Source: Synthetic API Business Register',
      takedown_contact: 'records@synthetic-api.invalid', owner_person_id: people.staff, personal_data: false, proposed_by_person: people.staff, edited_by: people.staff, status: 'active',
      activated_by: people.second, activated_at: new Date(),
    } as never).returning('id').executeTakeFirstOrThrow()).id;
    return { people, sourceId };
  });
  for (const [key, hub] of [['staff', hubId], ['second', hubId], ['elsewhere', otherHubId]] as const) {
    await a.assign({ personId: seeded.people[key], role: 'data-steward' as never, scope: { kind: 'hub', hubId: hub } });
  }
  const { people, sourceId } = seeded;
  const email = (k: string) => `datasets-api-${k}@example.invalid`;
  await addLogins(h, Object.entries(people).map(([k, id]) => [id, email(k)]));
  const clients = {} as Record<keyof typeof people | 'unelevated', Client>;
  clients.unelevated = h.client();
  await signIn(clients.unelevated, email('staff'));
  for (const key of ['staff', 'second', 'elsewhere', 'participant'] as const) {
    clients[key] = h.client();
    await signIn(clients[key], email(key));
    if (key === 'participant') continue;
    h.staff.set(people[key], ['data-steward']);
    const secret = await enrolNow(h, clients[key]);
    h.clock.advance(30_000);
    assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    assert.equal((await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null })).status, 200);
    h.clock.reset();
  }
  const base = `/v1/admin/hubs/${hubId}/datasets`;
  const send = (client: Client, url: string, rest: Record<string, unknown>): Promise<Response> => {
    const key = `datasets-${randomUUID()}`;
    return client.post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: key, reason: 'Synthetic datasets action', ...rest }, { idempotencyKey: key });
  };
  const code = (r: Response) => (r.body as { code?: string } | null)?.code;
  const dataset = {
    subject: 'companies', name: 'Synthetic API register mirror', sourceIds: [sourceId], purpose: 'Companies of the state for the directory and claim checks.',
    legalBasis: 'statutory_public_register', personalData: { present: false, naturalPersons: false, categories: [] }, impactAssessmentRef: null,
    retention: { className: 'register_mirror', days: 365 }, outputs: ['directory_sourced_records'], publicDisplay: true, subjectNotice: false, refreshScheduleId: null,
  };

  await t.test('negative authorization: participant, unelevated staff, staff of another hub', async () => {
    for (const client of [clients.participant, clients.unelevated]) assert.equal((await send(client, base, dataset)).status, 403);
    const elsewhere = await send(clients.elsewhere, base, dataset);
    assert.equal(elsewhere.status, 403);
    assert.equal(code(elsewhere), 'access.forbidden');
    assert.equal((await clients.participant.get(base)).status, 403);
  });

  await t.test('reputation is never an output and people data is never displayed', async () => {
    assert.equal((await send(clients.staff, base, { ...dataset, outputs: ['reputation'] })).status, 422);
    const people = await send(clients.staff, base, { ...dataset, subject: 'people', legalBasis: 'consent', publicDisplay: true, impactAssessmentRef: randomUUID(),
      personalData: { present: true, naturalPersons: true, categories: ['name'] } });
    assert.equal(people.status, 422, JSON.stringify(people.body));
  });

  await t.test('a steward proposes, another activates; records carry the source\'s provenance; other hubs find nothing', async () => {
    const proposed = await send(clients.staff, base, dataset);
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const d = (proposed.body as { dataset: { id: string; revision: number } }).dataset;
    const self = await send(clients.staff, `${base}/${d.id}/activate`, { expectedRevision: d.revision, approvalId: null });
    assert.equal(self.status, 403);
    const active = await send(clients.second, `${base}/${d.id}/activate`, { expectedRevision: d.revision, approvalId: null });
    assert.equal(active.status, 200, JSON.stringify(active.body));
    const ingested = await send(clients.staff, `${base}/${d.id}/records`, { records: [{ sourceId, externalKey: 'API-1', identifierKind: 'US-CA-SOS', identifierValue: '8100001',
      naturalPerson: false, fields: { legalName: 'Synthetic API Builders', status: 'active' }, sourceUrl: 'https://register.synthetic-api.invalid/entity/API-1', method: 'structured_feed' }] });
    assert.equal(ingested.status, 200, JSON.stringify(ingested.body));
    assert.deepEqual((ingested.body as { counts: unknown }).counts, { stored: 1, unchanged: 0, droppedDoNotCollect: 0 });
    const records = await clients.staff.get(`${base}/${d.id}/records`);
    const item = (records.body as { items: Array<{ provenance: { sourceUrl: string; licenceSnapshot: Record<string, boolean> } }> }).items[0]!;
    assert.equal(item.provenance.sourceUrl, 'https://register.synthetic-api.invalid/entity/API-1');
    assert.equal(item.provenance.licenceSnapshot.displayHeadlineAndLink, true);
    assert.equal((await clients.elsewhere.get(`/v1/admin/hubs/${otherHubId}/datasets/${d.id}`)).status, 404, 'a dataset of another hub is not found');
    const dnc = await send(clients.staff, `${base}/do-not-collect`, { kind: 'identifier', value: '8100001', entryReason: 'objection' });
    assert.equal(dnc.status, 200, JSON.stringify(dnc.body));
    assert.deepEqual(dnc.body, { buried: 1 });
    const after = (await clients.staff.get(`${base}/${d.id}/records`)).body as { items: unknown[]; tombstones: Array<{ reason: string; keyDigest: string }> };
    assert.deepEqual(after.items, []);
    assert.deepEqual(after.tombstones.map((s) => s.reason), ['do_not_collect']);
    assert.ok(!JSON.stringify(after).includes('API-1'), 'a tombstone keeps only a digest of the key');
  });
});
