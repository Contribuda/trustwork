import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { withMaintenance, withPrincipal, type Principal } from '@trustwork/data';
import { evidenceArtifacts, type NewEvidenceInput } from '../../../packages/data/src/repositories/kernel.js';
import { provisionTestDatabase, SKIP_REASON, sqlState } from '../helpers/postgres.js';
import { principalFor, seedFixtures, type Seed } from '../helpers/seed.js';

/**
 * Evidence artifacts (DATA-003): access needs the authorized parent AND the artifact's own classification; content
 * identity is immutable; uploads are pending until the scanner (maintenance) marks them clean. Real PostgreSQL, real
 * runtime role, fixture parties from packages/contracts/fixtures.
 */
const db = await provisionTestDatabase('kernel_evidence');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

test('evidence artifacts under the restricted runtime role', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const seed: Seed = await seedFixtures(db.admin);
  const as = async (personId: string) => principalFor(db.admin, personId);
  const rlsDenied = (e: unknown) => sqlState(e) === '42501';
  const upload = (principal: Principal, overrides: Partial<NewEvidenceInput> = {}) => withPrincipal(db.app, principal, (trx) => evidenceArtifacts.create(trx, {
    owner: { personId: principal.personId }, parent: { kind: 'project', id: seed.project }, classification: 'shared',
    storageKey: `evidence/${randomUUID()}`, sha256: sha(randomUUID()), bytes: 1024, mediaType: 'application/pdf', uploadedBy: principal.personId, ...overrides,
  }));
  const visible = async (personId: string, id: string) => (await withPrincipal(db.app, await as(personId), (trx) => evidenceArtifacts.get(trx, id))) !== undefined;
  const markClean = (id: string) => withMaintenance(db.admin, (trx) => evidenceArtifacts.setScanState(trx, id, 'clean'));

  const petr = await as(seed.people.petr);
  const shared = await upload(petr);
  const ownerOnly = await upload(petr, { classification: 'owner_private' });
  const partyPrivate = await upload(petr, { classification: 'party_private' });
  const publicOne = await upload(petr, { classification: 'public' });

  await t.test('the owner sees every own artifact at once; pending artifacts are hidden from everyone else', async () => {
    for (const a of [shared, ownerOnly, partyPrivate, publicOne]) assert.equal(await visible(seed.people.petr, a.id), true);
    const row = await withPrincipal(db.app, petr, (trx) => evidenceArtifacts.get(trx, shared.id));
    assert.equal(row?.scan_state, 'pending');
    assert.equal(await visible(seed.people.boris, shared.id), false, 'a participant waits for the scan');
  });

  await t.test('after a clean scan: shared reaches parties of the parent only; private classes stay with the owner', async () => {
    for (const a of [shared, ownerOnly, partyPrivate, publicOne]) await markClean(a.id);
    assert.equal(await visible(seed.people.boris, shared.id), true, 'supplier member participates in the project');
    assert.equal(await visible(seed.people.boris, ownerOnly.id), false);
    assert.equal(await visible(seed.people.boris, partyPrivate.id), false);
    assert.equal(await visible(seed.people.carl, shared.id), false, 'unrelated company');
    assert.equal(await visible(seed.people.anna, shared.id), false, 'another company');
    assert.equal(await visible(seed.people.xenia, shared.id), false, 'former member of a company');
    const list = await withPrincipal(db.app, await as(seed.people.boris), (trx) => evidenceArtifacts.forParent(trx, 'project', seed.project));
    assert.deepEqual(list.map((a) => a.id).sort(), [shared.id, publicOne.id].sort());
  });

  await t.test('public artifacts follow the parent: hidden while the project is private, visible once it is public', async () => {
    assert.equal(await visible(seed.people.carl, publicOne.id), false);
    await withMaintenance(db.admin, (trx) => trx.updateTable('project').set({ publicity_enabled: true }).where('id', '=', seed.project).execute());
    try {
      assert.equal(await visible(seed.people.carl, publicOne.id), true);
      assert.equal(await visible(seed.people.carl, shared.id), false, 'a public parent does not open shared artifacts');
    } finally {
      await withMaintenance(db.admin, (trx) => trx.updateTable('project').set({ publicity_enabled: false }).where('id', '=', seed.project).execute());
    }
  });

  await t.test('quarantined artifacts are never served to non-owners', async () => {
    const infected = await upload(petr);
    await withMaintenance(db.admin, (trx) => evidenceArtifacts.setScanState(trx, infected.id, 'quarantined'));
    assert.equal(await visible(seed.people.boris, infected.id), false);
    assert.equal(await visible(seed.people.petr, infected.id), true, 'the owner sees the quarantine state');
  });

  await t.test('without an identity nothing is visible', async () => {
    const { rows } = await db.app.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.evidence_artifact');
    assert.equal(rows[0]?.n, 0);
  });

  await t.test('uploads: every forged or out-of-scope field is refused by the policy or by column privileges', async () => {
    const carl = await as(seed.people.carl);
    await assert.rejects(upload(carl), rlsDenied, 'not a party of the project');
    await assert.rejects(upload(petr, { uploadedBy: seed.people.anna }), rlsDenied, 'forged uploader');
    await assert.rejects(upload(petr, { owner: { personId: seed.people.anna } }), rlsDenied, 'someone else as owner');
    await assert.rejects(upload(petr, { owner: { companyId: seed.companies.supplier } }), rlsDenied, 'a company that is not the active employer');
    await assert.rejects(upload(petr, { classification: 'restricted' as never }), rlsDenied, 'restricted is staff-only');
    await assert.rejects(upload(petr, { parent: { kind: 'person', id: seed.people.anna } }), rlsDenied, 'another person as parent');
    await assert.rejects(upload(petr, { parent: { kind: 'company', id: seed.companies.mixed } }), rlsDenied, 'a company petr does not work for');
    await assert.rejects(upload(petr, { parent: { kind: 'rfq', id: randomUUID() } }), rlsDenied, 'an unknown resource');
    const xenia = await as(seed.people.xenia);
    await assert.rejects(upload(xenia, { owner: { companyId: seed.companies.mixed }, parent: { kind: 'company', id: seed.companies.mixed } }), rlsDenied, 'a former member has no company context');
    // Column privileges: scan state and legal hold are never runtime inputs.
    for (const column of ['scan_state', 'legal_hold']) {
      await assert.rejects(withPrincipal(db.app, petr, (trx) => trx.insertInto('evidence_artifact').values({
        owner_person_id: petr.personId, parent_kind: 'person', parent_id: petr.personId, classification: 'shared', storage_key: `evidence/${randomUUID()}`,
        sha256: sha('x'), bytes: '1', media_type: 'text/plain', uploaded_by: petr.personId, ...(column === 'scan_state' ? { scan_state: 'clean' as const } : { legal_hold: true }),
      }).execute()), (e: unknown) => sqlState(e) === '42501' && /permission denied/.test(String(e)), column);
    }
    for (const [field, value] of [['sha256', 'ABC'], ['media_type', 'not a type'], ['storage_key', '../escape']] as const) {
      await assert.rejects(upload(petr, { [field === 'media_type' ? 'mediaType' : field === 'storage_key' ? 'storageKey' : 'sha256']: value }), (e: unknown) => sqlState(e) === '23514', field);
    }
  });

  await t.test('company-owned artifacts: a member uploads for the active employer onto a resource the company participates in', async () => {
    const boris = await as(seed.people.boris);
    const companyOwned = await upload(boris, { owner: { companyId: seed.companies.supplier }, classification: 'party_private' });
    await markClean(companyOwned.id);
    assert.equal(await visible(seed.people.boris, companyOwned.id), true);
    assert.equal(await visible(seed.people.petr, companyOwned.id), false, 'party_private stays with the supplier even for the project owner');
    const profile = await upload(boris, { owner: { companyId: seed.companies.supplier }, parent: { kind: 'company', id: seed.companies.supplier }, classification: 'public' });
    await markClean(profile.id);
    assert.equal(await visible(seed.people.carl, profile.id), true, 'public company-profile evidence (a licence certificate) is visible with any identity');
    const petrProfile = await upload(petr, { parent: { kind: 'person', id: petr.personId }, classification: 'public' });
    await markClean(petrProfile.id);
    assert.equal(await visible(seed.people.carl, petrProfile.id), false, 'public evidence on a private profile follows the profile');
    await withMaintenance(db.admin, (trx) => trx.updateTable('person').set({ profile_visibility: 'public' }).where('id', '=', petr.personId).execute());
    try {
      assert.equal(await visible(seed.people.carl, petrProfile.id), true);
    } finally {
      await withMaintenance(db.admin, (trx) => trx.updateTable('person').set({ profile_visibility: 'private' }).where('id', '=', petr.personId).execute());
    }
  });

  await t.test('the runtime role never updates or deletes; content identity is immutable even for maintenance', async () => {
    await assert.rejects(withPrincipal(db.app, petr, (trx) => trx.updateTable('evidence_artifact').set({ classification: 'public' }).where('id', '=', shared.id).execute()), rlsDenied);
    await assert.rejects(withPrincipal(db.app, petr, (trx) => trx.deleteFrom('evidence_artifact').where('id', '=', shared.id).execute()), rlsDenied);
    for (const change of [{ classification: 'public' as const }, { owner_person_id: seed.people.anna }, { parent_id: randomUUID() }, { sha256: sha('other') }, { storage_key: 'evidence/moved' }]) {
      await assert.rejects(withMaintenance(db.admin, (trx) => trx.updateTable('evidence_artifact').set(change).where('id', '=', shared.id).execute()), (e: unknown) => (e as { hint?: string }).hint === 'kernel.evidence_immutable', JSON.stringify(change));
    }
    await withMaintenance(db.admin, (trx) => trx.updateTable('evidence_artifact').set({ legal_hold: true }).where('id', '=', ownerOnly.id).execute());
    await assert.rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('evidence_artifact').where('id', '=', ownerOnly.id).execute()), (e: unknown) => (e as { hint?: string }).hint === 'kernel.legal_hold');
  });

  await t.test('concurrency: two uploads racing for one storage key: exactly one commits', async () => {
    const key = `evidence/${randomUUID()}`;
    const boris = await as(seed.people.boris);
    const results = await Promise.allSettled([upload(petr, { storageKey: key }), upload(boris, { storageKey: key, owner: { personId: boris.personId }, uploadedBy: boris.personId })]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(sqlState(failure.reason), '23505');
  });

  await t.test('concurrency: revoking a participation hides shared artifacts from the next transaction', async () => {
    const client = new pg.Client(db.adminConfig);
    await client.connect();
    try {
      assert.equal(await visible(seed.people.boris, shared.id), true);
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE trustwork_owner');
      await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      await client.query("UPDATE trustwork.object_participation SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [seed.participations.supplierOnPersonalProject]);
      assert.equal(await visible(seed.people.boris, shared.id), true, 'uncommitted revocation is not yet visible');
      await client.query('COMMIT');
      assert.equal(await visible(seed.people.boris, shared.id), false);
    } finally {
      await client.end();
    }
  });
});
