import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import {
  auditSequenceContinuous, canonicalize, CONSOLE_PERMISSIONS, CONSOLE_SECOND_PERSON_ACTIONS, HUB_STAFF_ROLES, KillSwitchScopeSchema, NODE_ONLY_PERMISSIONS,
  roleAllowedInScope, SENSITIVE_HUB_STAFF_ROLES,
} from '@trustwork/contracts';
import { bindTransaction, createPool, type DataPool } from '@trustwork/data';
import {
  adminAudit, adminDigests, adminSetup, approvals, featureFlags, incidents, staffAssignments, staffConflicts, staffRoleDefinitions, type CommandContext,
} from '../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../packages/data/src/repositories/identity.js';
import { SCREENING_SECOND_PERSON_ACTIONS } from '../../../packages/contracts/src/sanctions.js';
import { TABLE_COLUMNS } from '../../../packages/data/src/schema/admin.js';
import { provisionTestDatabase, SKIP_REASON, untilDatabaseTimePasses } from '../helpers/postgres.js';
import { actors, buildAdminWorld, rejects, settle, type AdminWorld } from './helpers.js';

const ADMIN_DIR = fileURLToPath(new URL('../../../packages/data/migrations/admin/', import.meta.url));
const ADMIN_TABLES = Object.keys(TABLE_COLUMNS).sort();

// Weight 2: the runtime pool holds up to ten connections for the racing tests.
const db = await provisionTestDatabase('admin_staff', { weight: 2 });

test('administration persistence: staff roles, approvals, break-glass and the append-only audit under the runtime role', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  const pools: { runtime?: DataPool } = {};
  t.after(async () => { await pools.runtime?.end(); await db.close(); });

  await t.test('every admin migration file is applied by npm run db:migrate on an empty database', async () => {
    const files = readdirSync(ADMIN_DIR).filter((f) => f.endsWith('.sql')).sort();
    assert.ok(files.length >= 3);
    const env = { ...process.env, DATABASE_URL: db.adminConfig.connectionString as string };
    const npm = process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath]] as const : ['npm', []] as const;
    const run = spawnSync(npm[0], [...npm[1], 'run', '--silent', 'db:migrate'], { encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    for (const file of files) assert.match(run.stdout, new RegExp(`applying ${file.replace('.', '\\.')}`), `${file} applied by db:migrate`);
    const { rows } = await db.admin.query<{ filename: string }>('SELECT filename FROM trustwork.migration_ledger WHERE filename = ANY($1)', [files]);
    assert.deepEqual(rows.map((r) => r.filename).sort(), files);
    const again = spawnSync(npm[0], [...npm[1], 'run', '--silent', 'db:migrate'], { encoding: 'utf8', env });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing to apply/);
  });

  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 10 });
  pools.runtime = runtime;
  const w: AdminWorld = await buildAdminWorld(db.admin);
  const { as, elevate, owner } = actors(db.admin, runtime, w);
  const p = w.people;
  const hubScope = { kind: 'hub', hubId: w.hubId } as const;

  await t.test('schema: every admin table is ENABLE + FORCE RLS, owned by trustwork_owner; the runtime may only read, and insert audit and access-log rows', async () => {
    const { rows } = await db.admin.query<{ relname: string; force: boolean; owner: string }>(
      `SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS force, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'trustwork' AND c.relname = ANY($1) ORDER BY relname`, [ADMIN_TABLES]);
    assert.deepEqual(rows.map((r) => r.relname), ADMIN_TABLES);
    assert.ok(rows.every((r) => r.force && r.owner === 'trustwork_owner'));
    for (const table of ADMIN_TABLES) {
      const priv: { s: boolean; i: boolean; u: boolean; d: boolean; t: boolean; r: boolean } | undefined = (await db.admin.query<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean; r: boolean }>(
        `SELECT has_table_privilege('trustwork_app', $1, 'SELECT') AS s, has_any_column_privilege('trustwork_app', $1, 'INSERT') AS i,
                has_any_column_privilege('trustwork_app', $1, 'UPDATE') AS u, has_table_privilege('trustwork_app', $1, 'DELETE') AS d,
                has_table_privilege('trustwork_app', $1, 'TRUNCATE') AS t, has_any_column_privilege('trustwork_app', $1, 'REFERENCES') AS r`, [`trustwork.${table}`])).rows[0];
      assert.deepEqual(priv, { s: !['admin_sequence', 'support_external_source_subject'].includes(table), i: table === 'admin_audit_event' || table === 'access_log_entry', u: false, d: false, t: false, r: false }, table);
    }
    for (const column of ['id', 'sequence', 'occurred_at']) {
      const c: { x: boolean } | undefined = (await db.admin.query<{ x: boolean }>("SELECT has_column_privilege('trustwork_app', 'trustwork.admin_audit_event', $1, 'INSERT') AS x", [column])).rows[0];
      assert.equal(c?.x, false, `the runtime never chooses audit ${column}`);
    }
    const worker = await db.admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'trustwork' AND c.relname = ANY($1)
         AND has_table_privilege('trustwork_worker', c.oid, 'SELECT') ORDER BY relname`, [ADMIN_TABLES]);
    assert.deepEqual(worker.rows.map((r) => r.relname), ['feature_flag', 'kill_switch', 'maintenance_window'], 'the worker reads only enforcement state');
    const definers = await db.admin.query<{ proname: string; cfg: string[] }>(
      "SELECT p.proname, p.proconfig AS cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork' AND p.prosecdef AND p.proname LIKE 'admin%'");
    assert.ok(definers.rows.length > 20);
    for (const row of definers.rows) {
      assert.ok(row.cfg.includes('search_path=trustwork, pg_temp'), `${row.proname} pins search_path`);
      assert.ok(row.cfg.includes('trustwork.maintenance=on'), `${row.proname} runs with the function-scoped maintenance flag`);
    }
    const invokerHelpers = ['admin_resolve_permission', 'admin_resolve_any', 'admin_authorize', 'admin_record', 'admin_require_elevation', 'admin_conflicted', 'admin_grant_usable', 'admin_target'];
    for (const name of invokerHelpers) {
      const r: { x: boolean } | undefined = (await db.admin.query<{ x: boolean }>(
        "SELECT bool_or(has_function_privilege('trustwork_app', p.oid, 'EXECUTE')) AS x FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork' AND p.proname = $1", [name])).rows[0];
      assert.equal(r?.x, false, `${name} is not callable by the runtime role`);
    }
  });

  await t.test('engine vocabularies in SQL equal the frozen contracts', async () => {
    const q = async <T>(text: string, params: unknown[] = []) => (await db.admin.query<{ v: T }>(text, params)).rows[0]?.v as T;
    assert.deepEqual(await q<string[]>('SELECT trustwork.admin_staff_roles() AS v'), [...HUB_STAFF_ROLES]);
    assert.deepEqual([...await q<string[]>('SELECT trustwork.admin_sensitive_roles() AS v')].sort(), [...SENSITIVE_HUB_STAFF_ROLES].sort());
    assert.deepEqual([...await q<string[]>('SELECT trustwork.admin_node_only_permissions() AS v')].sort(), [...NODE_ONLY_PERMISSIONS].sort());
    // SANC-003 registered its two screening actions in the data layer only (data integrator agreement); the frozen console
    // vocabulary is unchanged, and the generic approval commands refuse them (no permission maps to them).
    assert.deepEqual(await q<string[]>('SELECT trustwork.admin_second_person_actions() AS v'), [...CONSOLE_SECOND_PERSON_ACTIONS, ...SCREENING_SECOND_PERSON_ACTIONS]);
    for (const action of SCREENING_SECOND_PERSON_ACTIONS) assert.equal(await q<string[] | null>('SELECT trustwork.admin_action_permissions($1) AS v', [action]), null, `${action} has no generic permission`);
    const vocabulary = new Set<string>(CONSOLE_PERMISSIONS);
    for (const action of CONSOLE_SECOND_PERSON_ACTIONS) {
      const perms = await q<string[] | null>('SELECT trustwork.admin_action_permissions($1) AS v', [action]);
      assert.ok(perms && perms.length > 0 && perms.every((x) => vocabulary.has(x)), `${action} maps to console permissions`);
    }
    for (const role of HUB_STAFF_ROLES) for (const scope of ['platform', 'node', 'hub'] as const) {
      assert.equal(await q<boolean>('SELECT trustwork.admin_role_allowed_in_scope($1, $2) AS v', [role, scope]), roleAllowedInScope(role, scope), `${role}@${scope}`);
    }
    const kinds = KillSwitchScopeSchema.options.map((o) => o.shape.kind.value);
    const def: { d: string } | undefined = (await db.admin.query<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'kill_switch_scope_kind_check'")).rows[0];
    for (const kind of kinds) {
      assert.ok(def?.d.includes(`'${kind}'`), `kill switch kind ${kind}`);
      const perms = await q<string[]>('SELECT trustwork.admin_kill_switch_permissions($1) AS v', [kind]);
      assert.ok(perms.every((x) => vocabulary.has(x)));
    }
    assert.ok((await q<string[]>('SELECT trustwork.admin_support_permissions() AS v')).every((x) => vocabulary.has(x)));
  });

  await t.test('trustwork-digest-1 in SQL equals computeDigest of the contracts (canonical JSON included)', async () => {
    const tricky = { b: 'quote " backslash \\ tab \t newline \n bell \u0007 del \u007f', a: ['é', 'ğ', 'ա', 'ა', '漢字', '😀'], n: [0, -5, 9007199254740991], z: null, t: true, nested: { y: 1, x: [] } };
    const c: { c: string } | undefined = (await db.admin.query<{ c: string }>('SELECT trustwork.admin_canonical_json($1::jsonb) AS c', [JSON.stringify(tricky)])).rows[0];
    assert.equal(c?.c, canonicalize(tricky));
    await rejects(db.admin.query("SELECT trustwork.admin_canonical_json('{\"x\": 1.5}'::jsonb)"), '22023', 'validation.not_canonicalizable');
    const assignment = { breakglass: true, personId: p.ops, role: 'hub-owner' as const, scope: hubScope, definitionVersion: 1, incidentId: w.company, validForSeconds: 7200 };
    const a: { d: string } | undefined = (await db.admin.query<{ d: string }>("SELECT trustwork.admin_assignment_digest('staff.grant_breakglass', $1, 'hub-owner', 'hub', NULL, $2, 1, true, $3, 7200) AS d", [p.ops, w.hubId, w.company])).rows[0];
    assert.equal(a?.d, adminDigests.assignment(assignment));
    const pl: { d: string } | undefined = (await db.admin.query<{ d: string }>("SELECT trustwork.admin_assignment_digest('staff.assign_sensitive_role', $1, 'staff-admin', 'platform', NULL, NULL, 1, false, NULL, NULL) AS d", [p.ops])).rows[0];
    assert.equal(pl?.d, adminDigests.assignment({ breakglass: false, personId: p.ops, role: 'staff-admin', scope: { kind: 'platform' }, definitionVersion: 1 }));
    const ids = [p.customer, p.employee, p.customer];
    const g: { d: string } | undefined = (await db.admin.query<{ d: string }>("SELECT trustwork.admin_case_grant_digest($1, 'project', $2::uuid[], 'evidence', ARRAY['payment_refs','credentials','negotiation_private'], 'Synthetic purpose', 3600, NULL) AS d", [w.company, ids])).rows[0];
    assert.equal(g?.d, adminDigests.caseGrant({ supportCaseId: w.company, objectType: 'project', objectIds: ids, projectionClass: 'evidence', purpose: 'Synthetic purpose', expiresInSeconds: 3600 }));
    const s: { d: string } | undefined = (await db.admin.query<{ d: string }>("SELECT trustwork.admin_sanction_digest($1, $2, NULL, 4, 'posting', NULL) AS d", [w.company, p.customer])).rows[0];
    assert.equal(s?.d, adminDigests.sanction({ moderationCaseId: w.company, subject: { kind: 'person', id: p.customer }, level: 4, featureScope: 'posting', durationSeconds: null }));
    const k: { d: string } | undefined = (await db.admin.query<{ d: string }>('SELECT trustwork.admin_kill_switch_release_digest($1, $2) AS d', [w.company, 'Synthetic note ✓'])).rows[0];
    assert.equal(k?.d, adminDigests.killSwitchRelease(w.company, 'Synthetic note ✓'));
  });

  await t.test('setup: two founding administrators at most, maintenance only; the runtime role never writes staff rows directly', async () => {
    await rejects(owner((trx) => adminSetup.bootstrapFirstAdmin(trx, { personId: p.ops, role: 'platform-owner', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'third' })), '23514', 'admin.bootstrap_closed');
    await rejects(owner((trx) => adminSetup.createNode(trx, 'second node')), '23505');
    await rejects(as(p.owner, (trx) => trx.insertInto('staff_role_assignment').values({ person_id: p.ops, role: 'auditor', scope_kind: 'platform', definition_version: 1, granted_by: p.owner, reason: 'x' }).execute()), '42501');
    await rejects(as(p.owner, (trx) => trx.updateTable('staff_role_assignment').set({ revoked_at: new Date(), revoked_by: p.owner, revoke_reason: 'x' }).execute()), '42501');
    await rejects(as(p.owner, (trx) => trx.updateTable('second_person_approval').set({ status: 'approved' }).execute()), '42501');
    await rejects(as(p.owner, (trx) => trx.insertInto('staff_role_definition_version').values({ role: 'auditor', version: 9, scopes: ['hub'], permissions: ['admin.audit.read'], grant_max_hours: 1, sod_mode: 'reduced' }).execute()), '42501');
    // A definition that grants a node-only permission inside a hub is refused by the contract and by the database.
    await assert.rejects(owner((trx) => staffRoleDefinitions.release(trx, { version: 2, role: 'support-agent', scopes: ['hub'], permissions: ['admin.ops.restore.execute'], caps: { creditCapMinorUnits: null, grantMaxHours: 1 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null })));
    await rejects(owner((trx) => trx.insertInto('staff_role_definition_version').values({ role: 'support-agent', version: 2, scopes: ['hub'], permissions: ['admin.ops.restore.execute'], grant_max_hours: 1, sod_mode: 'reduced' }).execute()), '23514');
    await rejects(owner((trx) => trx.insertInto('staff_role_definition_version').values({ role: 'hub-owner', version: 2, scopes: ['platform'], permissions: ['admin.audit.read'], grant_max_hours: 1, sod_mode: 'reduced' }).execute()), '23514', 'admin.role_scope');
    await rejects(owner((trx) => trx.updateTable('staff_role_definition_version').set({ grant_max_hours: 1 }).where('role', '=', 'auditor').execute()), '23000', 'audit.append_only');
  });

  await t.test('elevation (BE-004 session_elevation): every staff command needs a live elevation of the caller on a live session of the caller', async () => {
    const ctx = await elevate(p.owner);
    const adminCtx = await elevate(p.admin);
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, { ...adminCtx }, { personId: p.lead, role: 'support-lead', scope: hubScope, definitionVersion: 1 })), '42501', 'admin.elevation_required');
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, { ...ctx, reasonText: '' }, { personId: p.lead, role: 'support-lead', scope: hubScope, definitionVersion: 1 })), '22023', 'admin.context_invalid');
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, { ...ctx, elevationId: 'not-a-uuid' }, { personId: p.lead, role: 'support-lead', scope: hubScope, definitionVersion: 1 })), '22023', 'admin.context_invalid');
    // A staff role alone is not enough: a person cannot forge an elevation on someone else's session.
    await rejects(as(p.owner, (trx) => sessionElevations.insert(trx, { sessionId: w.sessions.admin as string, personId: p.owner, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) })), '23514');
    await as(p.owner, (trx) => sessionElevations.revokeForSession(trx, w.sessions.owner as string, 'ended', new Date()));
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ctx, { personId: p.lead, role: 'support-lead', scope: hubScope, definitionVersion: 1 })), '42501', 'admin.elevation_required');
    const short = await elevate(p.owner, 1);
    await untilDatabaseTimePasses(db.admin, new Date(Date.now() + 1100));
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, short, { personId: p.lead, role: 'support-lead', scope: hubScope, definitionVersion: 1 })), '42501', 'admin.elevation_required');
    // An elevation dies with its session.
    const live = await elevate(p.owner);
    await owner((trx) => trx.updateTable('session').set({ revoked_at: new Date(), revoked_reason: 'logout' }).where('id', '=', w.sessions.owner as string).execute());
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, live, { personId: p.lead, role: 'support-lead', scope: hubScope, definitionVersion: 1 })), '42501', 'admin.elevation_required');
    const fresh = await owner((trx) => trx.insertInto('session').values({ person_id: p.owner, token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000),
      absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
    w.sessions.owner = fresh.id;
  });

  let ownerCtx: CommandContext;
  let adminCtx: CommandContext;
  await t.test('assignments: by staff administrators only, never to oneself, never above the grantor\'s scope; sensitive roles consume an approval of exactly that assignment', async () => {
    ownerCtx = await elevate(p.owner);
    adminCtx = await elevate(p.admin);
    const agent = await as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.agent, role: 'support-agent', scope: hubScope, definitionVersion: 1 }));
    assert.equal(agent.granted_by, p.owner);
    assert.equal(agent.approved_by, null);
    await as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.lead, role: 'support-lead', scope: hubScope, definitionVersion: 1 }));
    await as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.moderator, role: 'moderator', scope: hubScope, definitionVersion: 1 }));
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.owner, role: 'auditor', scope: hubScope, definitionVersion: 1 })), '42501', 'admin.self_grant');
    const agentCtx = await elevate(p.agent);
    await rejects(as(p.agent, (trx) => staffAssignments.assign(trx, agentCtx, { personId: p.outsider, role: 'support-agent', scope: hubScope, definitionVersion: 1 })), '42501', 'admin.forbidden');
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.ops, role: 'hub-owner', scope: { kind: 'platform' }, definitionVersion: 1 })), '23514', 'admin.role_scope');
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.outsider, role: 'moderator', scope: { kind: 'platform' }, definitionVersion: 1 })), '23514', 'admin.role_scope');

    // Sensitive: hub-owner for hubOwner. Without approval, with a mismatching approval, and properly.
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.hubOwner, role: 'hub-owner', scope: hubScope, definitionVersion: 1 })), '42501', 'admin.approval_required');
    const digest = adminDigests.assignment({ breakglass: false, personId: p.hubOwner, role: 'hub-owner', scope: hubScope, definitionVersion: 1 });
    const request = await as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: hubScope, actionDigest: digest }));
    await as(p.admin, (trx) => approvals.decide(trx, adminCtx, request.id, 'approve', digest));
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.hubOwner, role: 'hub-owner', scope: hubScope, definitionVersion: 1, validForSeconds: 3600, approvalId: request.id })), '23514', 'admin.approval_mismatch');
    const hubOwner = await as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.hubOwner, role: 'hub-owner', scope: hubScope, definitionVersion: 1, approvalId: request.id }));
    assert.equal(hubOwner.approved_by, p.admin);
    assert.equal((await as(p.owner, (trx) => approvals.get(trx, request.id)))?.status, 'consumed');
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.hubOwner, role: 'hub-owner', scope: hubScope, definitionVersion: 1, approvalId: request.id })), '23514', 'admin.approval_consumed');

    // The holder can never be the second approver of their own sensitive role.
    const selfDigest = adminDigests.assignment({ breakglass: false, personId: p.admin, role: 'staff-admin', scope: hubScope, definitionVersion: 1 });
    const selfReq = await as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: hubScope, actionDigest: selfDigest }));
    await as(p.admin, (trx) => approvals.decide(trx, adminCtx, selfReq.id, 'approve', selfDigest));
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.admin, role: 'staff-admin', scope: hubScope, definitionVersion: 1, approvalId: selfReq.id })), '42501', 'admin.self_approval');

    // Even the maintenance path cannot create a sensitive assignment without a consumed, matching approval.
    await rejects(owner((trx) => trx.insertInto('staff_role_assignment').values({ person_id: p.ops, role: 'staff-admin', scope_kind: 'platform', definition_version: 1, granted_by: p.owner, approved_by: p.admin, approval_id: request.id, reason: 'x' }).execute()), '42501', 'admin.approval_mismatch');
    await rejects(owner((trx) => trx.insertInto('staff_role_assignment').values({ person_id: p.ops, role: 'auditor', scope_kind: 'platform', definition_version: 1, granted_by: p.agent, reason: 'x' }).execute()), '42501', 'admin.forbidden');
    await rejects(owner((trx) => trx.updateTable('staff_role_assignment').set({ role: 'auditor' }).where('id', '=', agent.id).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.deleteFrom('staff_role_assignment').where('id', '=', agent.id).execute()), '23000', 'audit.append_only');

    // A hub-scoped staff administrator cannot act on another hub.
    const hubOwnerCtx = await elevate(p.hubOwner);
    await rejects(as(p.hubOwner, (trx) => staffAssignments.assign(trx, hubOwnerCtx, { personId: p.otherAgent, role: 'support-agent', scope: { kind: 'hub', hubId: w.otherHubId }, definitionVersion: 1 })), '42501', 'admin.forbidden');
    await as(p.hubOwner, (trx) => staffAssignments.assign(trx, hubOwnerCtx, { personId: p.lead2, role: 'support-lead', scope: hubScope, definitionVersion: 1 }));
    await as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.otherAgent, role: 'support-agent', scope: { kind: 'hub', hubId: w.otherHubId }, definitionVersion: 1 }));
  });

  await t.test('second-person approvals: self-approval refused, the digest is restated, the approver holds an executing permission, only the requester executes', async () => {
    const digest = adminDigests.assignment({ breakglass: false, personId: p.ops, role: 'staff-admin', scope: hubScope, definitionVersion: 1 });
    const req = await as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: hubScope, actionDigest: digest }));
    assert.equal(req.status, 'pending');
    assert.ok(req.request_expires_at.getTime() - req.requested_at.getTime() === 7 * 86_400_000);
    await rejects(as(p.owner, (trx) => approvals.decide(trx, ownerCtx, req.id, 'approve', digest)), '42501', 'admin.self_approval');
    await rejects(as(p.admin, (trx) => approvals.decide(trx, adminCtx, req.id, 'approve', 'f'.repeat(64))), '23514', 'access.approval_digest_mismatch');
    const leadCtx = await elevate(p.lead);
    await rejects(as(p.lead, (trx) => approvals.decide(trx, leadCtx, req.id, 'approve', digest)), '42501', 'admin.forbidden');
    await rejects(as(p.admin, (trx) => approvals.decide(trx, adminCtx, req.id, 'approve', digest, 73 * 3600)), '22023', 'admin.approval_too_long');
    const ok = await as(p.admin, (trx) => approvals.decide(trx, adminCtx, req.id, 'approve', digest));
    assert.equal(ok.expires_at!.getTime() - ok.approved_at!.getTime(), 72 * 3_600_000);
    // Another staff administrator (hubOwner) tries to execute it: only the requester may.
    const hubOwnerCtx = await elevate(p.hubOwner);
    await rejects(as(p.hubOwner, (trx) => staffAssignments.assign(trx, hubOwnerCtx, { personId: p.ops, role: 'staff-admin', scope: hubScope, definitionVersion: 1, approvalId: req.id })), '42501', 'admin.not_requester');
    await rejects(as(p.owner, (trx) => approvals.consume(trx, { approvalId: req.id, action: 'staff.assign_sensitive_role', scope: { kind: 'hub', hubId: w.otherHubId }, actionDigest: digest, ref: p.ops })), '23514', 'admin.approval_mismatch');
    await rejects(as(p.owner, (trx) => approvals.consume(trx, { approvalId: req.id, action: 'staff.switch_sod_mode', scope: hubScope, actionDigest: digest, ref: p.ops })), '23514', 'admin.approval_mismatch');
    await as(p.owner, (trx) => approvals.withdraw(trx, req.id));
    await rejects(as(p.owner, (trx) => approvals.consume(trx, { approvalId: req.id, action: 'staff.assign_sensitive_role', scope: hubScope, actionDigest: digest, ref: p.ops })), '23514', 'admin.approval_not_approved');
    // A declined request is never executable; an unknown action is refused.
    const declined = await as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: hubScope, actionDigest: digest }));
    await as(p.admin, (trx) => approvals.decide(trx, adminCtx, declined.id, 'decline', digest));
    await rejects(as(p.owner, (trx) => approvals.consume(trx, { approvalId: declined.id, action: 'staff.assign_sensitive_role', scope: hubScope, actionDigest: digest, ref: p.ops })), '23514', 'admin.approval_not_approved');
    await rejects(as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.do_anything', scope: hubScope, actionDigest: digest })), '23514', 'admin.unknown_action');
    // A requester without an executing permission cannot ask (support agents do not assign staff).
    const agentCtx = await elevate(p.agent);
    await rejects(as(p.agent, (trx) => approvals.request(trx, agentCtx, { action: 'staff.assign_sensitive_role', scope: hubScope, actionDigest: digest })), '42501', 'admin.forbidden');
    // Even the owner path cannot approve one's own request, rewrite a request or delete an approval.
    await rejects(owner((trx) => trx.updateTable('second_person_approval').set({ status: 'approved', approved_by: p.owner, approved_at: new Date(), expires_at: new Date(Date.now() + 3_600_000) }).where('id', '=', declined.id).execute()), '23514');
    await rejects(owner((trx) => trx.updateTable('second_person_approval').set({ action_digest: 'a'.repeat(64) }).where('id', '=', declined.id).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.deleteFrom('second_person_approval').where('id', '=', declined.id).execute()), '23000', 'audit.append_only');
    const pending = await as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: hubScope, actionDigest: digest }));
    const forced = await owner((trx) => trx.updateTable('second_person_approval').set({ status: 'approved', approved_by: p.admin, approved_at: new Date(), expires_at: new Date(Date.now() + 500 * 3_600_000) })
      .where('id', '=', pending.id).returningAll().executeTakeFirstOrThrow());
    assert.ok(forced.expires_at!.getTime() - forced.approved_at!.getTime() <= 72 * 3_600_000, 'the database caps every approval at 72 hours');
  });

  await t.test('concurrency: two approvers racing on one request, and two executions racing on one approval: exactly one wins each time', async () => {
    const hubOwnerCtx = await elevate(p.hubOwner);
    for (let round = 0; round < 5; round++) {
      const digest = adminDigests.assignment({ breakglass: false, personId: p.ops, role: 'compliance-officer', scope: hubScope, definitionVersion: round + 1 });
      const req = await as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: hubScope, actionDigest: digest }));
      const results = await Promise.allSettled([
        as(p.admin, (trx) => approvals.decide(trx, adminCtx, req.id, 'approve', digest)),
        as(p.hubOwner, (trx) => approvals.decide(trx, hubOwnerCtx, req.id, round % 2 ? 'decline' : 'approve', digest)),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `round ${round}: one decision`);
      const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.equal((loser.reason as { hint?: string }).hint, 'admin.approval_not_pending');
      const stored = await as(p.owner, (trx) => approvals.get(trx, req.id));
      assert.ok(stored && ['approved', 'declined'].includes(stored.status));
    }
    const digest = 'c'.repeat(64);
    const req = await as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.switch_sod_mode', scope: hubScope, actionDigest: digest }));
    await as(p.admin, (trx) => approvals.decide(trx, adminCtx, req.id, 'approve', digest));
    const executions = await Promise.allSettled([1, 2, 3, 4].map(() => as(p.owner, (trx) => approvals.consume(trx, { approvalId: req.id, action: 'staff.switch_sod_mode', scope: hubScope, actionDigest: digest, ref: req.id }))));
    assert.equal(executions.filter((r) => r.status === 'fulfilled').length, 1, 'an approval is consumed exactly once');
    for (const r of executions.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) assert.equal((r.reason as { hint?: string }).hint, 'admin.approval_consumed');
  });

  await t.test('expiry: an expired approval cannot be executed, by the command or by the owner path', async () => {
    const digest = 'd'.repeat(64);
    const req = await as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.switch_sod_mode', scope: hubScope, actionDigest: digest }));
    const approved = await as(p.admin, (trx) => approvals.decide(trx, adminCtx, req.id, 'approve', digest, 1));
    await untilDatabaseTimePasses(db.admin, approved.expires_at as Date);
    await rejects(as(p.owner, (trx) => approvals.consume(trx, { approvalId: req.id, action: 'staff.switch_sod_mode', scope: hubScope, actionDigest: digest, ref: req.id })), '23514', 'admin.approval_expired');
    await rejects(owner((trx) => trx.updateTable('second_person_approval').set({ status: 'consumed', consumed_ref: req.id, consumed_at: new Date() }).where('id', '=', req.id).execute()), '23514', 'admin.approval_expired');
  });

  let incidentId: string;
  await t.test('break-glass: names an open incident, needs a second person, lasts at most 12 hours, is marked in the audit and expires', async () => {
    const incident = await as(p.owner, (trx) => incidents.open(trx, ownerCtx, { scope: { kind: 'hub', hubId: w.hubId }, kind: 'security', severity: 'sev2', title: 'Synthetic incident' }));
    incidentId = incident.id;
    const input = { breakglass: true, personId: p.ops, role: 'hub-owner' as const, scope: hubScope, definitionVersion: 1, incidentId, validForSeconds: 2 };
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { ...input, validForSeconds: 13 * 3600 })), '23514', 'admin.breakglass_too_long');
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { ...input, validForSeconds: null })), '23514', 'admin.breakglass_too_long');
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, input)), '42501', 'admin.approval_required');
    await rejects(owner((trx) => trx.insertInto('staff_role_assignment').values({ person_id: p.ops, role: 'auditor', scope_kind: 'hub', hub_id: w.hubId, definition_version: 1, granted_by: p.owner, reason: 'x',
      breakglass: true, incident_id: incidentId, valid_until: new Date(Date.now() + 13 * 3_600_000) }).execute()), '23514', 'admin.breakglass_too_long');
    const digest = adminDigests.assignment(input);
    const req = await as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.grant_breakglass', scope: hubScope, actionDigest: digest }));
    await as(p.admin, (trx) => approvals.decide(trx, adminCtx, req.id, 'approve', digest));
    const glass = await as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { ...input, approvalId: req.id }));
    assert.equal(glass.breakglass, true);
    assert.equal(glass.valid_until!.getTime() - glass.valid_from.getTime(), 2000);
    const linked = await owner((trx) => trx.selectFrom('incident').select('linked_actions').where('id', '=', incidentId).executeTakeFirstOrThrow());
    assert.deepEqual(linked.linked_actions, [{ kind: 'breakglass', assignmentId: glass.id }]);
    // ops-engineer is not assigned yet: break-glass is the only role, so the audit row is marked.
    const opsCtx = await elevate(p.ops);
    assert.equal(await as(p.ops, (trx) => staffAssignments.hasPermission(trx, 'admin.flags.edit', hubScope)), true);
    const flag = await as(p.ops, (trx) => featureFlags.set(trx, opsCtx, { scope: hubScope, key: 'synthetic.banner', value: false, description: 'Synthetic flag', declaredEffect: 'ui', expiresAt: new Date(Date.now() + 86_400_000) }));
    const audit = await owner((trx) => trx.selectFrom('admin_audit_event').selectAll().where('object_id', '=', flag.id).executeTakeFirstOrThrow());
    assert.deepEqual([audit.breakglass, audit.actor_role, audit.permission, audit.scope_kind, audit.hub_id], [true, 'hub-owner', 'admin.flags.edit', 'hub', w.hubId]);
    await untilDatabaseTimePasses(db.admin, glass.valid_until as Date);
    assert.equal(await as(p.ops, (trx) => staffAssignments.hasPermission(trx, 'admin.flags.edit', hubScope)), false, 'break-glass expired');
    await rejects(as(p.ops, (trx) => featureFlags.set(trx, opsCtx, { scope: hubScope, key: 'synthetic.banner', value: true, description: 'Synthetic flag', declaredEffect: 'ui', expiresAt: new Date(Date.now() + 86_400_000) })), '42501', 'admin.forbidden');
    // A resolved incident no longer supports break-glass.
    await as(p.owner, (trx) => incidents.update(trx, ownerCtx, incidentId, { status: 'resolved' }));
    const digest2 = adminDigests.assignment({ ...input, validForSeconds: 60 });
    const req2 = await as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.grant_breakglass', scope: hubScope, actionDigest: digest2 }));
    await as(p.admin, (trx) => approvals.decide(trx, adminCtx, req2.id, 'approve', digest2));
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { ...input, validForSeconds: 60, approvalId: req2.id })), '23514', 'admin.incident_not_open');
    await rejects(as(p.owner, (trx) => incidents.update(trx, ownerCtx, incidentId, { status: 'closed' })), '23514');
    const closed = await as(p.owner, (trx) => incidents.update(trx, ownerCtx, incidentId, { status: 'closed', postReviewRef: 'review-synthetic-1' }));
    assert.equal(closed.closed_by, p.owner);
    await rejects(as(p.owner, (trx) => incidents.update(trx, ownerCtx, incidentId, { status: 'mitigated' })), '23514', 'admin.invalid_transition');
  });

  await t.test('separation of duties in full mode: an auditor is never also an ops engineer', async () => {
    await as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.ops, role: 'ops-engineer', scope: { kind: 'platform' }, definitionVersion: 1 }));
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.ops, role: 'auditor', scope: hubScope, definitionVersion: 1 })), '23514', 'admin.sod_conflict');
    await as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.auditor, role: 'auditor', scope: { kind: 'platform' }, definitionVersion: 1 }));
    await rejects(as(p.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: p.auditor, role: 'ops-engineer', scope: hubScope, definitionVersion: 1 })), '23514', 'admin.sod_conflict');
  });

  await t.test('audit: the runtime role cannot update, delete or truncate audit rows; no role can; the sequence is gap-free under concurrency and rollback', async () => {
    const someId = (await owner((trx) => trx.selectFrom('admin_audit_event').select('id').limit(1).executeTakeFirstOrThrow())).id;
    await rejects(as(p.owner, (trx) => trx.updateTable('admin_audit_event').set({ reason_text: 'rewritten' }).where('id', '=', someId).execute()), '42501');
    await rejects(as(p.owner, (trx) => trx.deleteFrom('admin_audit_event').where('id', '=', someId).execute()), '42501');
    await rejects(runtime.query('TRUNCATE trustwork.admin_audit_event'), '42501');
    await rejects(runtime.query('UPDATE trustwork.admin_sequence SET last_value = 0'), '42501');
    await rejects(runtime.query('SELECT * FROM trustwork.admin_sequence'), '42501');
    await rejects(owner((trx) => trx.updateTable('admin_audit_event').set({ reason_text: 'rewritten' }).where('id', '=', someId).execute()), '23000', 'audit.append_only');
    await rejects(owner((trx) => trx.deleteFrom('admin_audit_event').where('id', '=', someId).execute()), '23000', 'audit.append_only');
    await rejects(owner(async (trx) => sql`TRUNCATE trustwork.admin_audit_event`.execute(trx)), '23000', 'audit.append_only');
    await rejects(owner(async (trx) => sql`TRUNCATE trustwork.access_log_entry`.execute(trx)), '23000', 'audit.append_only');

    // Runtime INSERT of a denied attempt: own elevation and a role held at the scope; nothing else.
    const lead = await elevate(p.lead);
    const denied = { actorPersonId: p.lead, actorRole: 'support-lead' as const, scope: hubScope, permission: 'admin.support.grant.approve', elevationId: lead.elevationId,
      action: 'support.grant_approve', objectType: 'case_access_grant', objectId: w.company, reasonCode: 'denied_attempt', reasonText: 'Synthetic denial', outcome: 'denied' as const, requestId: 'req-denied-1' };
    await as(p.lead, (trx) => adminAudit.append(trx, denied));
    await rejects(as(p.lead, (trx) => adminAudit.append(trx, { ...denied, elevationId: ownerCtx.elevationId })), '42501');
    await rejects(as(p.lead, (trx) => adminAudit.append(trx, { ...denied, actorRole: 'hub-owner' })), '42501');
    await rejects(as(p.lead, (trx) => adminAudit.append(trx, { ...denied, scope: { kind: 'hub', hubId: w.otherHubId } })), '42501');
    await rejects(as(p.lead, (trx) => adminAudit.append(trx, { ...denied, actorPersonId: p.agent })), '42501');
    await rejects(as(p.customer, (trx) => adminAudit.append(trx, { ...denied, actorPersonId: p.customer })), '42501');
    await rejects(as(p.lead, (trx) => trx.insertInto('admin_audit_event').values({ actor_person_id: p.lead, actor_role: 'support-lead', scope_kind: 'hub', hub_id: w.hubId, permission: 'admin.support.grant.approve',
      session_elevation_id: lead.elevationId, action: 'x', object_type: 'x', object_id: w.company, reason_code: 'x', reason_text: 'x', outcome: 'denied', request_id: 'r', sequence: '999' } as never).execute()), '42501');
    // An applied second-person action is never recorded without its approver and digest.
    await rejects(as(p.lead, (trx) => adminAudit.append(trx, { ...denied, action: 'support.reset_second_factor', outcome: 'applied' })), '23514');

    // Concurrent writers plus a rolled-back insert: committed sequences stay contiguous.
    const writers = Array.from({ length: 8 }, (_, i) => as(p.owner, (trx) => featureFlags.set(trx, ownerCtx, { scope: hubScope, key: `synthetic.race_${i}`, value: i, description: 'Synthetic race flag', declaredEffect: 'ui', expiresAt: new Date(Date.now() + 86_400_000) })));
    const rolledBack = (async () => {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        const principal = await actors(db.admin, runtime, w).principal(p.lead);
        await client.query('SELECT trustwork.set_principal($1, $2)', [principal.personId, principal.authzEpoch]);
        await adminAudit.append(bindTransaction(client), { ...denied, requestId: 'req-rolled-back' });
        await client.query('ROLLBACK');
      } finally {
        client.release(true);
      }
    })();
    await Promise.all([...writers, rolledBack]);
    const sequences = (await owner((trx) => trx.selectFrom('admin_audit_event').select('sequence').orderBy('sequence').execute())).map((r) => Number(r.sequence));
    assert.equal(sequences[0], 1);
    assert.ok(auditSequenceContinuous(sequences), `gap-free: ${sequences.join(',')}`);
    const counter = await owner((trx) => trx.selectFrom('admin_sequence').select('last_value').where('name', '=', 'admin_audit_event').executeTakeFirstOrThrow());
    assert.equal(Number(counter.last_value), sequences.length);
  });

  await t.test('row-level security: people see their own staff rows; readers see what their scope covers; outsiders see nothing', async () => {
    assert.equal((await as(p.customer, (trx) => staffAssignments.list(trx))).length, 0);
    assert.equal((await as(p.customer, (trx) => adminAudit.list(trx))).length, 0);
    assert.equal((await as(p.customer, (trx) => trx.selectFrom('second_person_approval').select('id').execute())).length, 0);
    assert.equal((await as(p.customer, (trx) => trx.selectFrom('incident').select('id').execute())).length, 0);
    const agentRows = await as(p.agent, (trx) => staffAssignments.list(trx));
    assert.deepEqual(agentRows.map((r) => r.person_id), [p.agent], 'staff see their own assignments only');
    const agentAudit = await as(p.agent, (trx) => adminAudit.list(trx));
    assert.ok(agentAudit.every((r) => r.actor_person_id === p.agent));
    const all = await owner((trx) => trx.selectFrom('staff_role_assignment').select('id').execute());
    assert.equal((await as(p.owner, (trx) => staffAssignments.list(trx))).length, all.length, 'a platform staff reader sees every assignment');
    const hubOwnerRows = await as(p.hubOwner, (trx) => staffAssignments.list(trx));
    assert.ok(hubOwnerRows.every((r) => r.hub_id === w.hubId), 'a hub reader sees only that hub');
    const auditCount = (await owner((trx) => trx.selectFrom('admin_audit_event').select('id').execute())).length;
    assert.equal((await as(p.auditor, (trx) => adminAudit.list(trx, { limit: 10_000 }))).length, auditCount, 'a platform auditor reads the whole audit');
    // Unauthenticated runtime sessions read nothing staff-related.
    for (const table of ['staff_role_assignment', 'second_person_approval', 'admin_audit_event', 'session_elevation', 'staff_conflict_declaration', 'incident']) {
      const counted: { n: number } | undefined = (await runtime.query<{ n: number }>(`SELECT count(*)::int AS n FROM trustwork.${table}`)).rows[0];
      assert.equal(counted?.n, 0, table);
    }
  });

  await t.test('conflicts: declared by the staff member, ended only as a recorded staff action', async () => {
    const declaration = await as(p.ops, (trx) => staffConflicts.declare(trx, { kind: 'company', id: w.company }, 'Synthetic relative works there'));
    await rejects(as(p.ops, (trx) => trx.updateTable('staff_conflict_declaration').set({ ended_at: new Date() }).where('id', '=', declaration.id).execute()), '42501');
    const opsCtx = await elevate(p.ops);
    await rejects(as(p.agent, async (trx) => staffConflicts.end(trx, await elevate(p.agent), declaration.id)), 'P0002', 'admin.not_found');
    const ended = await as(p.ops, (trx) => staffConflicts.end(trx, opsCtx, declaration.id));
    assert.ok(ended.ended_at);
    await rejects(owner((trx) => trx.updateTable('staff_conflict_declaration').set({ reason: 'changed' }).where('id', '=', declaration.id).execute()), '23000', 'admin.immutable');
  });

  await t.test('leaving: revoking a person\'s last role ends their elevations and open approval requests at once; revocation is final', async () => {
    const hubOwnerCtx = await elevate(p.hubOwner);
    const digest = 'e'.repeat(64);
    const pending = await as(p.hubOwner, (trx) => approvals.request(trx, hubOwnerCtx, { action: 'staff.assign_sensitive_role', scope: hubScope, actionDigest: digest }));
    const assignment = (await owner((trx) => trx.selectFrom('staff_role_assignment').select('id').where('person_id', '=', p.hubOwner).where('revoked_at', 'is', null).execute()));
    assert.equal(assignment.length, 1);
    await rejects(as(p.agent, async (trx) => staffAssignments.revoke(trx, await elevate(p.agent), assignment[0]!.id)), '42501', 'admin.forbidden');
    const revoked = await as(p.owner, (trx) => staffAssignments.revoke(trx, ownerCtx, assignment[0]!.id));
    assert.equal(revoked.revoked_by, p.owner);
    assert.equal((await owner((trx) => trx.selectFrom('second_person_approval').select('status').where('id', '=', pending.id).executeTakeFirstOrThrow())).status, 'revoked');
    assert.equal((await owner((trx) => trx.selectFrom('session_elevation').select('revoked_reason').where('id', '=', hubOwnerCtx.elevationId).executeTakeFirstOrThrow())).revoked_reason, 'ended');
    await rejects(as(p.hubOwner, (trx) => staffAssignments.assign(trx, hubOwnerCtx, { personId: p.outsider, role: 'support-agent', scope: hubScope, definitionVersion: 1 })), '42501', 'admin.elevation_required');
    // Even with a new elevation row the former staff member holds no permission any more.
    const again = await elevate(p.hubOwner);
    await rejects(as(p.hubOwner, (trx) => staffAssignments.assign(trx, again, { personId: p.outsider, role: 'support-agent', scope: hubScope, definitionVersion: 1 })), '42501', 'admin.forbidden');
    await rejects(as(p.owner, (trx) => staffAssignments.revoke(trx, ownerCtx, assignment[0]!.id)), '23514', 'admin.invalid_transition');
    const audit = await owner((trx) => trx.selectFrom('admin_audit_event').selectAll().where('object_id', '=', assignment[0]!.id).where('action', '=', 'staff.revoke_role').executeTakeFirstOrThrow());
    assert.ok(audit.before_digest && audit.after_digest && audit.before_digest !== audit.after_digest, 'audit holds digests of the before and after images');
  });

  await t.test('no staff command leaves a mutation without an audit row', async () => {
    const assignments = await owner((trx) => trx.selectFrom('staff_role_assignment').select(['id', 'setup_bootstrap']).execute());
    for (const a of assignments.filter((x) => !x.setup_bootstrap)) {
      const audited = await owner((trx) => trx.selectFrom('admin_audit_event').select('id').where('object_id', '=', a.id).where('outcome', '=', 'applied').execute());
      assert.ok(audited.length >= 1, `assignment ${a.id} audited`);
    }
    const refused = await settle(as(p.agent, async (trx) => staffAssignments.assign(trx, await elevate(p.agent), { personId: p.outsider, role: 'support-agent', scope: hubScope, definitionVersion: 1 })));
    assert.ok(refused);
  });
});
