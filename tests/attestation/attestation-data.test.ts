import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withMaintenance, type DataPool } from '@trustwork/data';
import { computeDigest } from '@trustwork/contracts';
import { deploymentAttestationStatement, DeploymentLocationAttestationSchema } from '../../packages/contracts/src/sanctions-attestation.js';
import { deploymentAttestations, type AttestationInput } from '../../packages/data/src/repositories/attestation.js';
import { staffAssignments } from '../../packages/data/src/repositories/admin.js';
import { TABLE_COLUMNS } from '../../packages/data/src/schema/attestation.js';
import type { DeploymentLocationAttestationRow } from '../../packages/data/src/schema/attestation.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { actors, buildAttestationWorld, rejects, settle, syncRestrictedPlaces, US_STATEMENT, withHeldNodeLock } from './helpers.js';

// Weight 2: the runtime pool races concurrent attestations.
const db = await provisionTestDatabase('deployment_attestation', { weight: 2 });

const view = (row: DeploymentLocationAttestationRow) => DeploymentLocationAttestationSchema.parse({
  id: row.id, nodeId: row.node_id, operatorEntityCountry: row.operator_entity_country, operatorEntityRegion: row.operator_entity_region, hostingCountry: row.hosting_country,
  hostingRegion: row.hosting_region, gateMode: row.gate_mode, statementVersion: row.statement_version, statementDigest: row.statement_digest, attestedBy: row.attested_by,
  attesterRole: row.attester_role, permission: row.permission, sessionElevationId: row.session_elevation_id, breakglass: row.breakglass, attestedAt: row.attested_at.toISOString(),
  expiresAt: row.expires_at.toISOString(), supersedesId: row.supersedes_id, basis: 'operator_statement',
});

test('deployment-location attestation: node staff attest under an elevation, restricted places are refused, renewals supersede once, everything is audited', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 10 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w = await buildAttestationWorld(db.admin);
  const { as, elevate, assignRoles } = actors(db.admin, runtime, w);
  const p = w.people;
  const attest = async (personId: string, input: AttestationInput, supersedes: string | null, ctxOverride?: Awaited<ReturnType<typeof elevate>>) => {
    const ctx = ctxOverride ?? (await elevate(personId));
    return as(personId, (trx) => deploymentAttestations.attest(trx, ctx, { ...input, supersedes, statementVersion: 'deployment-location-1' }));
  };
  const head = async () => (await deploymentAttestations.currentOnPool(runtime))?.id ?? null;

  await t.test('the module stores no address and nothing detected about the server', async () => {
    const { rows } = await db.admin.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name = 'deployment_location_attestation'");
    assert.deepEqual(rows.map((r) => r.column_name).sort(), [...TABLE_COLUMNS.deployment_location_attestation].sort());
    for (const { column_name: name } of rows) assert.doesNotMatch(name, /(^|_)(ip|addr|address|network|detected|observed)(_|$)/, name);
  });

  await t.test('an unsynced restricted list refuses every attestation (fail closed)', async () => {
    await assignRoles();
    await rejects(attest(p.operator, US_STATEMENT, null), '55000', 'attestation.restricted_list_unsynced');
    await syncRestrictedPlaces(db.admin);
  });

  await t.test('negative authorization: participants, hub-scoped staff, staff without an attesting permission, and missing, expired or foreign elevations', async () => {
    // A participant without any role, a hub moderator, the node's auditor and compliance officer: no attesting permission.
    for (const key of ['outsider', 'moderator', 'auditor', 'officer', 'founder2'] as const) {
      await rejects(attest(p[key], US_STATEMENT, null), '42501', 'admin.forbidden');
    }
    // The hub owner holds admin.hub.jurisdiction.edit, but at the hub: a hub scope never covers the node.
    await rejects(attest(p.hubOwner, US_STATEMENT, null), '42501', 'admin.forbidden');
    // The node operator without a live elevation of their own.
    const ctx = await elevate(p.operator);
    await rejects(attest(p.operator, US_STATEMENT, null, { ...ctx, elevationId: '00000000-0000-4000-8000-000000000000' }), '42501', 'admin.elevation_required');
    const foreign = await elevate(p.founder);
    await rejects(attest(p.operator, US_STATEMENT, null, { ...ctx, elevationId: foreign.elevationId }), '42501', 'admin.elevation_required');
    const expired = await elevate(p.operator, 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await rejects(attest(p.operator, US_STATEMENT, null, expired), '42501', 'admin.elevation_required');
    await rejects(attest(p.operator, US_STATEMENT, null, { ...ctx, reasonText: '' }), '22023', 'admin.context_invalid');
    // No identity at all.
    await rejects(runtime.query("SELECT trustwork.attestation_attest($1::jsonb, 'US', NULL, 'US', NULL, 'upstream_gate', NULL, 'deployment-location-1')", [JSON.stringify(ctx)]), '28000', 'access.no_principal');
    assert.equal(await head(), null, 'nothing was recorded');
  });

  await t.test('restricted places are refused for the entity and the hosting, at country and region level, and a region is required where the list has regions', async () => {
    const cases: Array<[Partial<AttestationInput>, string, string]> = [
      [{ operatorEntityCountry: 'RU', operatorEntityRegion: null }, 'attestation.restricted_place', 'operator_entity_country:RU:restricted'],
      [{ operatorEntityCountry: 'RU', operatorEntityRegion: 'RU-MOW' }, 'attestation.restricted_place', 'operator_entity_region:RU-MOW:restricted'],
      [{ hostingCountry: 'IR' }, 'attestation.restricted_place', 'hosting_country:IR:restricted'],
      [{ hostingCountry: 'CU' }, 'attestation.restricted_place', 'hosting_country:CU:restricted'],
      [{ hostingCountry: 'KP' }, 'attestation.restricted_place', 'hosting_country:KP:restricted'],
      [{ hostingCountry: 'UA', hostingRegion: 'UA-43' }, 'attestation.restricted_place', 'hosting_region:UA-43:restricted'],
      [{ hostingCountry: 'UA', hostingRegion: 'UA-40' }, 'attestation.restricted_place', 'hosting_region:UA-40:restricted'],
      [{ operatorEntityCountry: 'UA', operatorEntityRegion: 'UA-14' }, 'attestation.restricted_place', 'operator_entity_region:UA-14:restricted'],
      [{ operatorEntityCountry: 'UA', operatorEntityRegion: 'UA-09' }, 'attestation.restricted_place', 'operator_entity_region:UA-09:restricted'],
      [{ hostingCountry: 'UA', hostingRegion: null }, 'attestation.region_required', 'hosting_region:UA:region_required'],
      [{ operatorEntityCountry: 'UA', operatorEntityRegion: null }, 'attestation.region_required', 'operator_entity_region:UA:region_required'],
    ];
    for (const [change, hint, detail] of cases) {
      const error = await rejects(attest(p.operator, { ...US_STATEMENT, ...change }, null), '23514', hint);
      assert.ok(error.detail?.split(',').includes(detail), `${JSON.stringify(change)}: ${error.detail}`);
    }
    await rejects(attest(p.operator, { ...US_STATEMENT, hostingRegion: 'CA-ON' }, null), '22023', 'attestation.invalid_place');
    await rejects(attest(p.operator, { ...US_STATEMENT, gateMode: 'fake' as 'upstream_gate' }, null), '22023', 'attestation.invalid_gate_mode');
    await rejects(as(p.operator, async (trx) => deploymentAttestations.attest(trx, await elevate(p.operator), { ...US_STATEMENT, supersedes: null, statementVersion: 'deployment-location-0' })), '22023', 'attestation.statement_version');
    assert.equal(await head(), null, 'nothing was recorded');
  });

  await t.test('a refused attempt leaves a denied audit row naming the places, never the attestation; recording needs authority and a refused statement', async () => {
    const ctx = await elevate(p.operator);
    const sequence = await as(p.operator, (trx) => deploymentAttestations.recordRefusal(trx, ctx, { ...US_STATEMENT, hostingCountry: 'UA', hostingRegion: 'UA-43' }));
    const { rows } = await db.admin.query('SELECT * FROM trustwork.admin_audit_event WHERE sequence = $1', [sequence]);
    const row = rows[0];
    assert.equal(row.outcome, 'denied');
    assert.equal(row.action, 'jurisdiction.location_refused');
    assert.equal(row.actor_person_id, p.operator);
    assert.equal(row.session_elevation_id, ctx.elevationId);
    assert.equal(row.reason_code, 'denied_restricted_place');
    assert.match(row.reason_text, /^refused hosting_region:UA-43:restricted; Synthetic attestation test$/);
    await rejects(as(p.operator, async (trx) => deploymentAttestations.recordRefusal(trx, await elevate(p.operator), US_STATEMENT)), '22023', 'attestation.not_refused');
    await rejects(as(p.hubOwner, async (trx) => deploymentAttestations.recordRefusal(trx, await elevate(p.hubOwner), { ...US_STATEMENT, hostingCountry: 'IR' })), '42501', 'admin.forbidden');
  });

  let first: DeploymentLocationAttestationRow;
  await t.test('the node operator attests: one row bound to the person, role, permission and elevation by the statement digest, and audited in the same transaction', async () => {
    const ctx = await elevate(p.operator);
    first = await attest(p.operator, US_STATEMENT, null, ctx);
    assert.equal(first.attested_by, p.operator);
    assert.equal(first.attester_role, 'node-operator');
    assert.equal(first.permission, 'admin.node.hubs.manage');
    assert.equal(first.session_elevation_id, ctx.elevationId);
    assert.equal(first.node_id, w.nodeId);
    assert.equal(first.supersedes_id, null);
    assert.equal(first.expires_at.getTime() - first.attested_at.getTime(), 365 * 86_400_000, 'expires 365 days after it was made');
    const record = view(first);
    assert.equal(computeDigest(deploymentAttestationStatement(record)).value, first.statement_digest, 'the application recomputes the database digest');
    const { rows } = await db.admin.query("SELECT * FROM trustwork.admin_audit_event WHERE object_type = 'deployment_location_attestation' AND object_id = $1", [first.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'jurisdiction.location_attested');
    assert.equal(rows[0].outcome, 'applied');
    assert.equal(rows[0].actor_person_id, p.operator);
    assert.equal(rows[0].actor_role, 'node-operator');
    assert.equal(rows[0].permission, 'admin.node.hubs.manage');
    assert.equal(rows[0].session_elevation_id, ctx.elevationId);
    assert.equal(rows[0].scope_kind, 'node');
    assert.equal(rows[0].node_id, w.nodeId);
    assert.equal(rows[0].request_id, ctx.requestId);
    assert.equal(rows[0].before_digest, null);
    assert.equal(await head(), first.id);
    assert.equal(await deploymentAttestations.inForce(runtime, new Date()), true);
    assert.equal(await deploymentAttestations.inForce(runtime, new Date(first.expires_at.getTime())), false, 'not in force at its expiry');
    assert.equal(await deploymentAttestations.inForce(runtime, new Date(first.attested_at.getTime() - 1000)), false, 'not in force before it was made');
  });

  await t.test('append-only: the runtime role cannot write, and nobody updates, deletes or truncates an attestation', async () => {
    await rejects(runtime.query("INSERT INTO trustwork.deployment_location_attestation (node_id, operator_entity_country, hosting_country, gate_mode, statement_version, statement_digest, attested_by, attester_role, permission, session_elevation_id, expires_at) VALUES ($1, 'US', 'US', 'upstream_gate', 'deployment-location-1', $2, $3, 'node-operator', 'admin.node.hubs.manage', $4, now() + interval '365 days')",
      [w.nodeId, 'a'.repeat(64), p.operator, first.session_elevation_id]), '42501');
    await rejects(runtime.query("UPDATE trustwork.deployment_location_attestation SET hosting_country = 'DE'"), '42501');
    await rejects(runtime.query('DELETE FROM trustwork.deployment_location_attestation'), '42501');
    await rejects(runtime.query('TRUNCATE trustwork.deployment_location_attestation'), '42501');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('deployment_location_attestation').set({ hosting_country: 'DE' }).where('id', '=', first.id).execute()), '23000', 'audit.append_only');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('deployment_location_attestation').where('id', '=', first.id).execute()), '23000', 'audit.append_only');
    await rejects(db.admin.query("INSERT INTO trustwork.deployment_location_attestation (node_id, operator_entity_country, hosting_country, gate_mode, statement_version, statement_digest, attested_by, attester_role, permission, session_elevation_id, expires_at, attested_at) VALUES ($1, 'US', 'US', 'upstream_gate', 'deployment-location-1', $2, $3, 'node-operator', 'admin.node.hubs.manage', $4, now() + interval '365 days', now())",
      [w.nodeId, 'a'.repeat(64), p.operator, first.session_elevation_id]), '42501', 'attestation.command_only');
  });

  await t.test('reads: node staff see the full rows; hub staff and participants see none, but everyone reads the current attestation without the attesting person', async () => {
    for (const key of ['operator', 'founder', 'auditor', 'officer'] as const) {
      const rows = await as(p[key], (trx) => deploymentAttestations.history(trx));
      assert.deepEqual(rows.map((r) => r.id), [first.id], key);
    }
    for (const key of ['hubOwner', 'moderator', 'outsider', 'founder2'] as const) {
      assert.deepEqual(await as(p[key], (trx) => deploymentAttestations.history(trx)), [], key);
      const current = await as(p[key], (trx) => deploymentAttestations.current(trx));
      assert.equal(current?.id, first.id, key);
      assert.ok(current && !('attested_by' in current) && !('session_elevation_id' in current), 'the summary names no person and no elevation');
    }
    assert.equal((await runtime.query('SELECT count(*)::int AS n FROM trustwork.deployment_location_attestation')).rows[0].n, 0, 'no principal: no row');
  });

  let second: DeploymentLocationAttestationRow;
  await t.test('renewal supersedes the current attestation exactly once; a stale predecessor is refused', async () => {
    await rejects(attest(p.founder, US_STATEMENT, null), '23514', 'attestation.stale');
    const ctx = await elevate(p.founder);
    second = await attest(p.founder, { ...US_STATEMENT, hostingCountry: 'DE', hostingRegion: 'DE-HE' }, first.id, ctx);
    assert.equal(second.supersedes_id, first.id);
    assert.equal(second.attester_role, 'platform-owner');
    assert.equal(second.permission, 'admin.hub.jurisdiction.edit', 'the platform owner attests through the jurisdiction permission');
    assert.equal(await head(), second.id);
    await rejects(attest(p.operator, US_STATEMENT, first.id), '23514', 'attestation.stale');
    const { rows } = await db.admin.query("SELECT action, before_digest, after_digest FROM trustwork.admin_audit_event WHERE object_type = 'deployment_location_attestation' AND object_id = $1", [second.id]);
    assert.equal(rows[0].action, 'jurisdiction.location_renewed');
    assert.ok(rows[0].before_digest, 'a renewal audits the superseded row too');
    assert.equal(computeDigest(deploymentAttestationStatement(view(second))).value, second.statement_digest);
  });

  await t.test('concurrency: simultaneous renewals of the same attestation record exactly one; the others are told it is stale', async () => {
    const contexts = await Promise.all([elevate(p.operator), elevate(p.founder), elevate(p.operator), elevate(p.founder)]);
    // Hold the node's attestation lock so that all four pass authorization and queue on it before any of them decides.
    const results = await withHeldNodeLock(db.admin, w.nodeId, contexts.length, () => Promise.all(contexts.map((ctx, i) => settle(attest(i % 2 ? p.founder : p.operator, US_STATEMENT, second.id, ctx)))));
    assert.equal(results.filter((r) => r === null).length, 1, 'exactly one renewal is recorded');
    for (const error of results.filter((r) => r !== null)) assert.equal(error?.hint, 'attestation.stale');
    const { rows } = await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.deployment_location_attestation WHERE supersedes_id = $1', [second.id]);
    assert.equal(rows[0]?.n, 1);
    const audits = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.admin_audit_event WHERE action IN ('jurisdiction.location_attested', 'jurisdiction.location_renewed') AND outcome = 'applied'");
    assert.equal(audits.rows[0]?.n, 3, 'one applied audit row per recorded attestation');
  });

  await t.test('concurrency: simultaneous first attestations on a fresh node record exactly one', async () => {
    const fresh = await provisionTestDatabase('deployment_attestation_first', { weight: 2 });
    if (!fresh) return;
    await fresh.migrate();
    await fresh.createAppLogin();
    const pool: DataPool = createPool({ ...fresh.appConfig, max: 10 });
    try {
      const world = await buildAttestationWorld(fresh.admin);
      const a = actors(fresh.admin, pool, world);
      await a.assignRoles();
      await syncRestrictedPlaces(fresh.admin);
      const contexts = await Promise.all([a.elevate(world.people.operator), a.elevate(world.people.founder), a.elevate(world.people.operator)]);
      const results = await withHeldNodeLock(fresh.admin, world.nodeId, contexts.length, () => Promise.all(contexts.map((ctx, i) => settle(a.as(i === 1 ? world.people.founder : world.people.operator, (trx) => deploymentAttestations.attest(trx, ctx, { ...US_STATEMENT, supersedes: null, statementVersion: 'deployment-location-1' }))))));
      assert.equal(results.filter((r) => r === null).length, 1);
      for (const error of results.filter((r) => r !== null)) assert.equal(error?.hint, 'attestation.stale');
      assert.equal((await fresh.admin.query('SELECT count(*)::int AS n FROM trustwork.deployment_location_attestation')).rows[0].n, 1);
    } finally {
      await pool.end();
      await fresh.close();
    }
  });

  await t.test('a revoked role attests no more, and the restricted list growing takes the current attestation out of force', async () => {
    const assignment = await withMaintenance(db.admin, (trx) => trx.selectFrom('staff_role_assignment').select('id').where('person_id', '=', p.operator).where('role', '=', 'node-operator').executeTakeFirstOrThrow());
    const operatorCtx = await elevate(p.operator);
    const founderCtx = await elevate(p.founder);
    await as(p.founder, (trx) => staffAssignments.revoke(trx, founderCtx, assignment.id));
    const current = await head();
    const refused = await rejects(attest(p.operator, US_STATEMENT, current, operatorCtx), '42501');
    assert.ok(['admin.forbidden', 'admin.elevation_required'].includes(refused.hint ?? ''), refused.hint);
    assert.equal(await deploymentAttestations.inForce(runtime, new Date()), true);
    const currentRow = await deploymentAttestations.currentOnPool(runtime);
    // A synthetic addition of the current hosting country to the restricted list (rolled back below).
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      await client.query("INSERT INTO trustwork.restricted_place (code, basis) VALUES ($1, 'Synthetic test addition')", [currentRow?.hosting_country]);
      const { rows } = await client.query('SELECT trustwork.attestation_in_force(now()) AS v');
      assert.equal(rows[0].v, false, 'an attestation naming a place restricted now is not in force');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    assert.equal(await deploymentAttestations.inForce(runtime, new Date()), true);
  });
});
