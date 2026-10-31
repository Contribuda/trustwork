import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createPool, withMaintenance, type DataPool } from '@trustwork/data';
import { staffConflicts, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { jurisdictionGate, jurisdictionHolds } from '../../packages/data/src/repositories/jurisdiction.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { TABLE_COLUMNS } from '../../packages/data/src/schema/jurisdiction.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { actors, buildAdminWorld, rejects, settle } from '../data/admin/helpers.js';

// Weight 2: the runtime pool races concurrent sightings and reviewers.
const db = await provisionTestDatabase('jurisdiction_holds', { weight: 2 });

/** A live session with a known token, as the API would create it (only the SHA-256 is stored). */
async function liveSession(admin: DataPool, personId: string, revoked = false): Promise<string> {
  const token = randomBytes(32);
  const hashHex = createHash('sha256').update(token).digest('hex');
  await withMaintenance(admin, (trx) => trx.insertInto('session').values({
    person_id: personId, token_hash: Buffer.from(hashHex, 'hex'), idle_expires_at: new Date(Date.now() + 3_600_000), absolute_expires_at: new Date(Date.now() + 3_600_000), auth_method: 'password',
    ...(revoked ? { revoked_at: new Date(), revoked_reason: 'logout' as const } : {}),
  }).execute());
  return hashHex;
}

test('jurisdiction holds: sightings hold the session person once, only compliance officers clear, never the subject, never deleted', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 10 });
  t.after(async () => { await runtime.end(); await db.close(); });
  // The restricted places synced into the kernel, as the maintenance command does on a real node.
  const reference = await kernelReference.fromRepository();
  await withMaintenance(db.admin, (trx) => kernelSync.apply(trx, reference));
  const w = await buildAdminWorld(db.admin);
  const { as, elevate, assign, assignSensitive } = actors(db.admin, runtime, w);
  const p = w.people;
  await withMaintenance(db.admin, (trx) => staffRoleDefinitions.release(trx, { version: 1, role: 'compliance-officer', scopes: ['node', 'hub'], permissions: ['admin.claims.read', 'admin.claims.decide'],
    caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));
  const nodeScope = { kind: 'node', nodeId: w.nodeId } as const;
  // Two compliance officers of the node (a sensitive role: assigned with a second person), an auditor, and a support agent with no say.
  await assignSensitive({ personId: p.moderator, role: 'compliance-officer', scope: nodeScope });
  await assignSensitive({ personId: p.ops, role: 'compliance-officer', scope: nodeScope });
  await assignSensitive({ personId: p.lead, role: 'compliance-officer', scope: nodeScope });
  await assign({ personId: p.auditor, role: 'auditor', scope: nodeScope });
  await assign({ personId: p.agent, role: 'support-agent', scope: { kind: 'hub', hubId: w.hubId } });

  const customerToken = await liveSession(db.admin, p.customer);
  let holdId = '';

  await t.test('no address column exists anywhere in the module', async () => {
    const { rows } = await db.admin.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name IN ('jurisdiction_hold', 'jurisdiction_refusal_count')");
    const names = [...new Set(rows.map((r) => r.column_name))].sort();
    assert.deepEqual(names, [...new Set([...TABLE_COLUMNS.jurisdiction_hold, ...TABLE_COLUMNS.jurisdiction_refusal_count])].sort());
    for (const name of names) assert.doesNotMatch(name, /ip|addr|address|network|host/, name);
  });

  await t.test('a sighting holds only the person of a live session, and concurrent sightings leave exactly one open hold', async () => {
    assert.equal(await jurisdictionGate.holdSession(runtime, { tokenHashHex: randomBytes(32).toString('hex'), place: 'CU', source: 'geolocation', dataset: 'fake' }), false, 'unknown token holds nobody');
    const revoked = await liveSession(db.admin, p.employee, true);
    assert.equal(await jurisdictionGate.holdSession(runtime, { tokenHashHex: revoked, place: 'CU', source: 'geolocation', dataset: 'fake' }), false, 'a revoked session holds nobody');
    await rejects(jurisdictionGate.holdSession(runtime, { tokenHashHex: customerToken, place: 'US', source: 'geolocation', dataset: 'fake' }), '22023', 'jurisdiction.not_restricted');
    await rejects(jurisdictionGate.holdSession(runtime, { tokenHashHex: customerToken, place: 'CU', source: 'staff_report' as 'geolocation', dataset: 'fake' }), '22023', 'jurisdiction.invalid_source');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => jurisdictionGate.holdSession(runtime, { tokenHashHex: customerToken, place: i % 2 ? 'UA-43' : 'CU', source: 'geolocation', dataset: 'fake' })));
    assert.equal(results.filter(Boolean).length, 1, 'exactly one call opened the hold; the first sighting stands');
    const open = await db.admin.query<{ id: string; place: string; n: number }>("SELECT id, place, count(*) OVER ()::int AS n FROM trustwork.jurisdiction_hold WHERE person_id = $1 AND cleared_at IS NULL", [p.customer]);
    assert.equal(open.rows[0]?.n, 1);
    holdId = open.rows[0]?.id as string;
    assert.equal(await jurisdictionGate.sessionHeld(runtime, customerToken), true);
    assert.equal(await jurisdictionGate.sessionHeld(runtime, await liveSession(db.admin, p.outsider)), false);
    assert.equal(await as(p.customer, (trx) => jurisdictionHolds.callerHeld(trx)), true, 'sign-in sees the hold of the caller');
    assert.equal(await as(p.outsider, (trx) => jurisdictionHolds.callerHeld(trx)), false);
  });

  await t.test('the runtime role cannot write, update, delete or truncate holds; only staff read them', async () => {
    await rejects(runtime.query("INSERT INTO trustwork.jurisdiction_hold (person_id, place, source, dataset) VALUES ($1, 'CU', 'geolocation', 'fake')", [p.outsider]), '42501');
    await rejects(runtime.query("UPDATE trustwork.jurisdiction_hold SET cleared_at = now() WHERE id = $1", [holdId]), '42501');
    await rejects(runtime.query('DELETE FROM trustwork.jurisdiction_hold WHERE id = $1', [holdId]), '42501');
    await rejects(runtime.query('TRUNCATE trustwork.jurisdiction_hold'), '42501');
    await rejects(db.admin.query('DELETE FROM trustwork.jurisdiction_hold WHERE id = $1', [holdId]), '23514', 'jurisdiction.hold_permanent');
    assert.equal((await as(p.customer, (trx) => jurisdictionHolds.list(trx))).length, 0, 'the subject does not read the record');
    assert.equal((await as(p.agent, (trx) => jurisdictionHolds.list(trx))).length, 0, 'staff without a compliance role read nothing');
    assert.equal((await as(p.outsider, (trx) => jurisdictionHolds.list(trx))).length, 0);
    assert.equal((await as(p.auditor, (trx) => jurisdictionHolds.list(trx, { open: true }))).length, 1, 'the auditor reads');
    assert.equal((await as(p.moderator, (trx) => jurisdictionHolds.list(trx, { personId: p.customer }))).length, 1, 'a compliance officer reads');
  });

  await t.test('clearing: compliance officers only, with an elevation and a reason, never the subject or a conflicted reviewer', async () => {
    const auditorCtx = await elevate(p.auditor);
    await rejects(as(p.auditor, (trx) => jurisdictionHolds.clear(trx, auditorCtx, { holdId, reason: 'Synthetic', evidence: 'call' })), '42501', 'admin.forbidden');
    const agentCtx = await elevate(p.agent);
    await rejects(as(p.agent, (trx) => jurisdictionHolds.clear(trx, agentCtx, { holdId, reason: 'Synthetic', evidence: 'call' })), '42501', 'admin.forbidden');
    await rejects(as(p.moderator, (trx) => jurisdictionHolds.clear(trx, { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'req-x', reasonCode: 'x', reasonText: 'x' }, { holdId, reason: 'Synthetic', evidence: 'call' })), '42501', 'admin.elevation_required');
    const moderatorCtx = await elevate(p.moderator);
    await rejects(as(p.moderator, (trx) => jurisdictionHolds.clear(trx, moderatorCtx, { holdId, reason: '   ', evidence: 'call' })), '22023', 'jurisdiction.reason_required');
    await rejects(as(p.moderator, (trx) => jurisdictionHolds.clear(trx, moderatorCtx, { holdId: '00000000-0000-4000-8000-000000000001', reason: 'Synthetic', evidence: 'call' })), 'P0002', 'jurisdiction.hold_not_found');
    // A declared conflict with the subject bars the reviewer.
    const declaration = await as(p.ops, (trx) => staffConflicts.declare(trx, { kind: 'person', id: p.customer }, 'Synthetic: a relative'));
    const opsCtx = await elevate(p.ops);
    await rejects(as(p.ops, (trx) => jurisdictionHolds.clear(trx, opsCtx, { holdId, reason: 'Synthetic', evidence: 'call' })), '42501', 'admin.conflict_of_interest');
    assert.ok(declaration.id);
    // A compliance officer who is the subject of their own hold cannot clear it.
    const moderatorToken = await liveSession(db.admin, p.moderator);
    assert.equal(await jurisdictionGate.holdSession(runtime, { tokenHashHex: moderatorToken, place: 'IR', source: 'geolocation', dataset: 'fake' }), true);
    const ownHold = (await db.admin.query<{ id: string }>('SELECT id FROM trustwork.jurisdiction_hold WHERE person_id = $1 AND cleared_at IS NULL', [p.moderator])).rows[0]?.id as string;
    await rejects(as(p.moderator, (trx) => jurisdictionHolds.clear(trx, moderatorCtx, { holdId: ownHold, reason: 'Synthetic: I am home', evidence: 'other' })), '42501', 'jurisdiction.self_clear');
  });

  await t.test('two reviewers race: exactly one clears, the other sees it cleared; the audit names the reviewer and the cleared row stays', async () => {
    const [a, b] = [await elevate(p.moderator), await elevate(p.lead)];
    // The moderator's own hold (previous step) is cleared by another officer; it does not stop them reviewing others in the database.
    const ownHold = (await db.admin.query<{ id: string }>('SELECT id FROM trustwork.jurisdiction_hold WHERE person_id = $1 AND cleared_at IS NULL', [p.moderator])).rows[0]?.id as string;
    await as(p.lead, (trx) => jurisdictionHolds.clear(trx, b, { holdId: ownHold, reason: 'Synthetic: confirmed home by call', evidence: 'call' }));
    const outcomes = await Promise.all([
      settle(as(p.moderator, (trx) => jurisdictionHolds.clear(trx, a, { holdId, reason: 'Synthetic: travel record', evidence: 'travel_record' }))),
      settle(as(p.lead, (trx) => jurisdictionHolds.clear(trx, b, { holdId, reason: 'Synthetic: document', evidence: 'document' }))),
    ]);
    assert.equal(outcomes.filter((o) => o === null).length, 1, 'exactly one reviewer cleared');
    assert.equal(outcomes.find((o) => o !== null)?.hint, 'jurisdiction.hold_cleared');
    const row = (await db.admin.query<{ cleared_by: string; clear_reason: string; clear_evidence: string }>('SELECT cleared_by, clear_reason, clear_evidence FROM trustwork.jurisdiction_hold WHERE id = $1', [holdId])).rows[0];
    assert.ok(row && [p.moderator, p.lead].includes(row.cleared_by));
    const audit = await db.admin.query<{ actor_person_id: string; permission: string; reason_text: string }>("SELECT actor_person_id, permission, reason_text FROM trustwork.admin_audit_event WHERE action = 'jurisdiction.hold_cleared' AND object_id = $1", [holdId]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]?.actor_person_id, row?.cleared_by);
    assert.equal(audit.rows[0]?.permission, 'admin.screening.holds.clear');
    await rejects(db.admin.query("UPDATE trustwork.jurisdiction_hold SET clear_reason = 'rewritten' WHERE id = $1", [holdId]), '23514', 'jurisdiction.hold_cleared');
    assert.equal(await jurisdictionGate.sessionHeld(runtime, customerToken), false, 'cleared: the person is served again');
  });

  await t.test('a new sighting after a clear holds again and the history keeps both rows', async () => {
    assert.equal(await jurisdictionGate.holdSession(runtime, { tokenHashHex: customerToken, place: 'KP', source: 'edge_header', dataset: 'edge-header' }), true);
    const history = await as(p.auditor, (trx) => jurisdictionHolds.list(trx, { personId: p.customer }));
    assert.equal(history.length, 2);
    assert.equal(history.filter((h) => h.cleared_at === null).length, 1);
  });

  await t.test('refusal counters: per day, place and door; no person, no address; refused for an unrestricted place', async () => {
    await jurisdictionGate.countRefusal(runtime, { place: 'CU', door: 'api', held: true });
    await jurisdictionGate.countRefusal(runtime, { place: 'CU', door: 'api', held: false });
    await jurisdictionGate.countRefusal(runtime, { place: 'UA-43', door: 'web', held: false });
    await rejects(jurisdictionGate.countRefusal(runtime, { place: 'US', door: 'api', held: false }), '22023', 'jurisdiction.not_restricted');
    const counts = await as(p.auditor, (trx) => jurisdictionHolds.refusalCounts(trx, new Date(Date.now() - 86_400_000)));
    const cu = counts.find((c) => c.place === 'CU' && c.door === 'api');
    assert.deepEqual([cu?.refusals, cu?.holds], [2, 1]);
    assert.equal((await as(p.outsider, (trx) => jurisdictionHolds.refusalCounts(trx, new Date(0)))).length, 0, 'counters are staff-only');
  });
});
