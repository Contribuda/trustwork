import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { CAPABILITIES } from '@trustwork/contracts';
import { auth, auditEvents, companies, memberships, ownershipTransfers, participations, permissionGrants, projects, PrincipalError, sessions, withMaintenance, withPrincipal, type Principal } from '@trustwork/data';
import { provisionTestDatabase, SKIP_REASON, sqlState } from './helpers/postgres.js';
import { principalFor, seedFixtures, type Seed } from './helpers/seed.js';

const db = await provisionTestDatabase('access');

test('identity and access persistence under the restricted runtime role', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const seed: Seed = await seedFixtures(db.admin);
  const principal = (personId: string) => principalFor(db.admin, personId);
  const rejects = async (promise: Promise<unknown>, state: string, pattern?: RegExp) => {
    const error = await promise.then(() => null, (e: unknown) => e);
    assert.ok(error, 'expected a rejection');
    assert.equal(sqlState(error), state, String(error));
    if (pattern) assert.match(String((error as Error).message), pattern);
  };

  await t.test('RL-07: the runtime login is not a superuser, cannot bypass RLS, owns nothing and is not an owner member', async () => {
    const { rows } = await db.app.query<{ rolsuper: boolean; rolbypassrls: boolean; owner_member: boolean; user: string }>(
      "SELECT rolsuper, rolbypassrls, pg_has_role(current_user, 'trustwork_owner', 'MEMBER') AS owner_member, current_user AS user FROM pg_roles WHERE rolname = current_user",
    );
    assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false, owner_member: false, user: db.appLoginRole });
    const group = await db.admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'trustwork_app'");
    assert.deepEqual(group.rows[0], { rolsuper: false, rolbypassrls: false });
    const owned = await db.admin.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'trustwork' AND tableowner IN ('trustwork_app', $1)", [db.appLoginRole]);
    assert.equal(owned.rows[0]?.n, 0);
  });

  await t.test('RL-06: the runtime role cannot disable RLS, create policies, become the owner or truncate', async () => {
    await rejects(db.app.query('ALTER TABLE trustwork.membership DISABLE ROW LEVEL SECURITY'), '42501');
    await rejects(db.app.query('CREATE POLICY p ON trustwork.membership FOR SELECT TO trustwork_app USING (true)'), '42501');
    await rejects(db.app.query('SET ROLE trustwork_owner'), '42501');
    await rejects(db.app.query('TRUNCATE trustwork.audit_event'), '42501');
    await rejects(db.app.query('DELETE FROM trustwork.session'), '42501');
    await rejects(db.app.query('SELECT trustwork.maintenance_on()'), '42501');
  });

  await t.test('RLS inventory: every party table is ENABLE + FORCE', async () => {
    const { rows } = await db.admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'trustwork' AND c.relkind = 'r' ORDER BY relname",
    );
    const forced = rows.filter((r) => r.relrowsecurity && r.relforcerowsecurity).map((r) => r.relname);
    const kernel = ['evidence_artifact', 'exchange_rate_snapshot', 'hub', 'hub_territory', 'jurisdiction', 'restricted_place', 'step_term_relation', 'taxonomy_release', 'taxonomy_term', 'unit', 'unit_conversion_rule']; // DATA-003
    const billing = ['billing_account', 'budget', 'credit_grant', 'entitlement', 'ledger_entry', 'marketplace_fee_version', 'meter', 'meter_rate_version', 'offer', 'price_acceptance', 'price_version', 'reservation', 'subscription', 'subscription_plan_version', 'usage_record']; // BILL-001
    const plans = ['permit_record', 'plan', 'plan_change', 'plan_dependency', 'plan_item', 'plan_item_state', 'plan_share', 'plan_version', 'project_diary_entry', 'project_location']; // PLAN-001
    const commerce = ['bundle_component', 'need', 'need_line', 'offering', 'offering_version', 'offering_version_private', 'rfq', 'rfq_invitation', 'rfq_private_constraint', 'rfq_version']; // COM-001
    const files = ['file_artifact_state']; // FILE-001
    const transactions = ['acceptance_event', 'agreement', 'agreement_buyer_private', 'agreement_seller_private', 'amendment_request', 'commercial_order', 'negotiation_round', 'obligation', 'order_change', 'quote', 'quote_line', 'quote_private_constraint', 'quote_version', 'tax_determination']; // COM-002
    const profiles = ['bookmark', 'consent_record', 'experience_entry', 'follow', 'media_licence', 'person_preference', 'person_profile', 'portrait', 'profile_tombstone', 'reading_progress']; // PPL-001
    assert.deepEqual(forced, ['auth_token', 'company', 'company_private', 'credential', 'directory_handle', 'email_binding', 'login_failure', 'membership', 'object_participation', 'ownership_transfer', 'permission_grant', 'person', 'project', 'session', ...kernel, ...billing, ...plans, ...commerce, ...files, ...transactions, ...profiles].sort());
  });

  await t.test('RL-12: the SECURITY DEFINER allowlist is exactly the reviewed set with a pinned search_path', async () => {
    const { rows }: { rows: { proname: string; proconfig: string[] | null; app_exec: boolean; public_exec: boolean }[] } = await db.admin.query(
      `SELECT p.proname, p.proconfig, has_function_privilege('trustwork_app', p.oid, 'EXECUTE') AS app_exec, has_function_privilege('${db.appLoginRole}', p.oid, 'EXECUTE') AS public_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork' AND p.prosecdef ORDER BY proname`,
    );
    assert.deepEqual(rows.map((r) => r.proname).sort(), [
      'admission_admit', 'admission_issue', 'admission_revoke', 'admission_settle',
      'apply_ownership_transfer', 'auth_claim_unverified_binding', 'auth_consume_token', 'auth_disable_password', 'auth_issue_token', 'auth_login_failure_count', 'auth_lookup_password_credential', 'auth_lookup_provider_credential', 'auth_lookup_session', 'auth_person_epoch', 'auth_record_login_failure', 'auth_register_person', 'auth_register_provider_person',
      'auth_clear_login_failures', 'auth_login_throttle', 'auth_prove_mailbox', 'auth_signup',
      'bump_epochs_for_membership', 'bump_epochs_for_participation', 'can_manage_resource', 'current_membership_has', 'end_membership', 'finalize_ownership_transfer', 'lease_jobs', 'owns_resource', 'participates_in_resource', 'public_person_read', 'public_project_read', 'reconcile_job', 'set_principal', 'sweep_expired', 'verify_person_id',
      'ensure_monthly_partitions', 'release_job', 'worker_sweep_expired',
      'directory_create_company', 'directory_public_people', 'directory_public_projects', 'directory_public_resolve', 'directory_set_handle', // BE-003
      'billing_close_budget', 'billing_grant_budget', 'billing_ledger_balanced', 'billing_release', 'billing_reserve', 'billing_set_budget_limit', 'billing_settle', // BILL-001
      'plan_project_can', 'plan_shared_view', // PLAN-001
      'catalogue_public_offerings', 'catalogue_published_version', 'offering_can', 'rfq_can', 'rfq_flag_stale', 'rfq_invitee', 'rfq_public_read', // COM-001
      'files_hidden', 'files_register_upload', 'files_complete_upload', 'files_request_deletion', 'files_copy', 'files_move', // FILE-001 (API role)
      'files_scan_target', 'files_record_scan', 'files_deletion_target', 'files_request_erasure', 'files_finish_deletion', 'files_apply_tombstone', 'files_expired_uploads', 'files_discard_upload', // FILE-001 (worker role)
      'agreement_side', 'order_side', 'quote_side', 'transactions_quote_for_share', 'transactions_rfq_for_share', // COM-002
      'profiles_company_people', 'profiles_consented_mentions', 'profiles_public_profile', 'profiles_public_consent', // PPL-001
    ].sort());
    // REL-001: worker-only entry points (trustwork_worker), never executable by the API role. BE-002: the API role
    // also lost the caller-chosen sweep and the job lease/reconcile helpers the worker owns. FILE-001 adds the files
    // worker entry points.
    const workerOnly = new Set(['ensure_monthly_partitions', 'release_job', 'worker_sweep_expired', 'sweep_expired', 'lease_jobs', 'reconcile_job',
      'files_scan_target', 'files_record_scan', 'files_deletion_target', 'files_request_erasure', 'files_finish_deletion', 'files_apply_tombstone', 'files_expired_uploads', 'files_discard_upload']);
    for (const row of rows) {
      assert.ok(row.proconfig?.some((c) => c === 'search_path=trustwork, pg_temp'), `${row.proname} pins search_path`);
      assert.equal(row.app_exec, !row.proname.startsWith('bump_') && !workerOnly.has(row.proname), `${row.proname} executable by trustwork_app only when allowlisted`);
    }
    const publicExec = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork' AND has_function_privilege(0, p.oid, 'EXECUTE')");
    assert.equal(publicExec.rows[0]?.n, 0, 'no function is executable by PUBLIC');
  });

  await t.test('RL-01: without a principal every party table yields zero rows for the runtime role', async () => {
    for (const table of ['person', 'email_binding', 'credential', 'session', 'auth_token', 'membership', 'permission_grant', 'object_participation', 'company_private', 'project']) {
      const result: pg.QueryResult<{ n: number }> = await db.app.query(`SELECT count(*)::int AS n FROM trustwork.${table}`);
      assert.equal(result.rows[0]?.n, 0, table);
    }
    await rejects(db.app.query('SELECT count(*) FROM trustwork.login_failure'), '42501');
    const companiesVisible: pg.QueryResult<{ n: number }> = await db.app.query('SELECT count(*)::int AS n FROM trustwork.company');
    assert.equal(companiesVisible.rows[0]?.n, 3, 'company existence is public; party-private company data lives in company_private');
    await rejects(db.app.query('UPDATE trustwork.project SET owner_person_id = $1', [seed.people.carl]), '42501', /permission denied/);
    const blindUpdate: pg.QueryResult = await db.app.query("UPDATE trustwork.project SET name = 'hijacked'");
    assert.equal(blindUpdate.rowCount, 0, 'no identity: no project row is updatable');
    const blindCompany: pg.QueryResult = await db.app.query("UPDATE trustwork.company SET display_name = 'hijacked'");
    assert.equal(blindCompany.rowCount, 0);
    await rejects(db.app.query('SELECT password_hash FROM trustwork.credential'), '42501', /permission denied for table credential/);
    await rejects(db.app.query("UPDATE trustwork.person SET authz_epoch = 99"), '42501');
  });

  await t.test('RL-05c and RL-08: a self-set maintenance flag changes nothing; invalid identity text aborts the transaction', async () => {
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      await client.query("SELECT set_config('trustwork.company_id', $1, true)", [seed.companies.supplier]);
      assert.equal((await client.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.object_participation')).rows[0]?.n, 0);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SELECT set_config('trustwork.person_id', 'not-a-uuid', true)");
      await rejects(client.query('SELECT count(*) FROM trustwork.object_participation'), '22P02');
      await client.query('ROLLBACK');
    } finally {
      client.release(true);
    }
  });

  await t.test('withPrincipal: parties see their own rows, companies through active membership, nothing across companies', async () => {
    const petr = await principal(seed.people.petr);
    const petrRows = await withPrincipal(db.app, petr, async (trx) => {
      assert.equal((await trx.selectFrom('person').select('id').where('id', '=', petr.personId).executeTakeFirst())?.id, petr.personId);
      assert.equal((await trx.selectFrom('person').select('id').where('id', '=', seed.people.carl).executeTakeFirst()), undefined, 'private profiles of others are not visible');
      assert.equal((await trx.selectFrom('person').select('id').where('id', '=', seed.people.pure).executeTakeFirst())?.id, seed.people.pure, 'public profiles are visible');
      return participations.listForResource(trx, 'project', seed.project);
    });
    assert.deepEqual(petrRows.map((r) => r.id).sort(), [seed.participations.ownerOnPersonalProject, seed.participations.supplierOnPersonalProject].sort(), 'the owner (manage_participants) sees every row of the project');

    const boris = await principal(seed.people.boris);
    const borisRows = await withPrincipal(db.app, boris, (trx) => participations.liveForResource(trx, 'project', seed.project, new Date('2026-10-15T00:00:00Z')));
    assert.equal(borisRows.length, 1, 'a member of the participant company sees the company row of the personal project');
    assert.equal(borisRows[0]?.party_company_id, seed.companies.supplier);

    const carl = await principal(seed.people.carl);
    assert.deepEqual(await withPrincipal(db.app, carl, (trx) => participations.listForResource(trx, 'project', seed.project)), [], 'an unrelated company member sees nothing');
    assert.equal((await withPrincipal(db.app, carl, (trx) => trx.selectFrom('object_participation').selectAll().execute())).length, 0);
    assert.equal(await withPrincipal(db.app, carl, (trx) => projects.getById(trx, seed.project)), undefined, 'a private project is not found for an unrelated principal');
    assert.equal(await withPrincipal(db.app, petr, (trx) => projects.getById(trx, seed.project)).then((p) => p?.private_notes), 'owner only');
    // BE-001 (20261027121000): a scoped participant reads the project row (participates_in_resource); the application
    // serializer restricts the fields to the shared_party projection, never the row itself.
    assert.equal(await withPrincipal(db.app, boris, (trx) => projects.getById(trx, seed.project)).then((p) => p?.id), seed.project, 'a scoped participant reads the project row through RLS; field projection is the application layer');

    const anna = await principal(seed.people.anna);
    const annaRows = await withPrincipal(db.app, anna, (trx) => trx.selectFrom('object_participation').select(['id', 'resource_kind']).orderBy('resource_kind').execute());
    assert.deepEqual(annaRows.map((r) => r.resource_kind), ['quote', 'rfq']);

    const xenia = await principal(seed.people.xenia);
    assert.equal((await withPrincipal(db.app, xenia, (trx) => trx.selectFrom('object_participation').selectAll().execute())).length, 0, 'a former member of the company has no company context');
    const xeniaMemberships = await withPrincipal(db.app, xenia, (trx) => memberships.listForPerson(trx, xenia.personId));
    assert.equal(xeniaMemberships[0]?.status, 'ended');
  });

  await t.test('the maintenance flag is restored when set_principal returns and never visible to the runtime role', async () => {
    const petr = await principal(seed.people.petr);
    const settings = await withPrincipal(db.app, petr, async (trx) => {
      const { sql } = await import('kysely');
      return (await sql<{ m: string; p: string; c: string }>`SELECT current_setting('trustwork.maintenance', true) AS m, current_setting('trustwork.person_id', true) AS p, current_setting('trustwork.company_id', true) AS c`.execute(trx)).rows[0];
    });
    assert.deepEqual(settings, { m: '', p: petr.personId, c: '' });
  });

  await t.test('RL-03/RL-02: identity does not survive commit, rollback, a savepoint rollback or an errored checkout', async () => {
    const single = new pg.Pool({ ...db.appConfig, max: 1 });
    t.after(() => single.end());
    const petr = await principal(seed.people.petr);
    assert.equal((await withPrincipal(single, petr, (trx) => participations.listForResource(trx, 'project', seed.project))).length, 2);
    const afterCommit = await single.query<{ n: number; p: string }>("SELECT (SELECT count(*)::int FROM trustwork.object_participation) AS n, coalesce(current_setting('trustwork.person_id', true), '') AS p");
    assert.deepEqual(afterCommit.rows[0], { n: 0, p: '' }, 'same pooled connection after COMMIT has no identity');

    await assert.rejects(withPrincipal(single, petr, async (trx) => {
      assert.equal((await participations.listForResource(trx, 'project', seed.project)).length, 2);
      throw new Error('simulated failure after identity was set');
    }), /simulated failure/);
    const afterError = await single.query<{ n: number; p: string }>("SELECT (SELECT count(*)::int FROM trustwork.object_participation) AS n, coalesce(current_setting('trustwork.person_id', true), '') AS p");
    assert.deepEqual(afterError.rows[0], { n: 0, p: '' }, 'the errored connection was destroyed; the fresh one has no identity');

    const client = await single.connect();
    try {
      await client.query('BEGIN');
      await client.query('SAVEPOINT before_identity');
      await client.query('SELECT trustwork.set_principal($1::uuid, $2::integer)', [petr.personId, petr.authzEpoch]);
      assert.equal((await client.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.object_participation')).rows[0]?.n, 2);
      await client.query('ROLLBACK TO SAVEPOINT before_identity');
      assert.equal((await client.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.object_participation')).rows[0]?.n, 0, 'RL-04: savepoint rollback discards the identity');
      await client.query('ROLLBACK');
      assert.equal((await client.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.object_participation')).rows[0]?.n, 0);
    } finally {
      client.release(true);
    }
  });

  await t.test('withPrincipal isolation across concurrent connections', async () => {
    const petr = await principal(seed.people.petr);
    const carl = await principal(seed.people.carl);
    const results = await Promise.all([
      withPrincipal(db.app, petr, async (trx) => {
        const first = await participations.listForResource(trx, 'project', seed.project);
        await new Promise((r) => setTimeout(r, 30));
        const second = await participations.listForResource(trx, 'project', seed.project);
        return [first.length, second.length];
      }),
      withPrincipal(db.app, carl, async (trx) => {
        const first = await participations.listForResource(trx, 'project', seed.project);
        await new Promise((r) => setTimeout(r, 30));
        const second = await participations.listForResource(trx, 'project', seed.project);
        return [first.length, second.length];
      }),
      withPrincipal(db.app, petr, async (trx) => (await participations.listForResource(trx, 'project', seed.project)).length),
    ]);
    assert.deepEqual(results, [[2, 2], [0, 0], 2]);
  });

  await t.test('set_principal rejects unknown people, stale epochs and malformed input', async () => {
    await assert.rejects(withPrincipal(db.app, { personId: '00000000-0000-4000-8000-000000000000', authzEpoch: 1 }, async () => 0), (e: unknown) => e instanceof PrincipalError && e.code === 'access.no_principal');
    await assert.rejects(withPrincipal(db.app, { personId: 'person-petr', authzEpoch: 1 }, async () => 0), (e: unknown) => e instanceof PrincipalError && e.code === 'access.invalid_principal');
    await assert.rejects(withPrincipal(db.app, { personId: seed.people.petr, authzEpoch: 0 }, async () => 0), (e: unknown) => e instanceof PrincipalError && e.code === 'access.invalid_principal');
    const petr = await principal(seed.people.petr);
    await assert.rejects(withPrincipal(db.app, { ...petr, authzEpoch: petr.authzEpoch + 1 }, async () => 0), (e: unknown) => e instanceof PrincipalError && e.code === 'access.stale_epoch');
  });

  await t.test('invariant 1: one active employer; ended -> new allowed; activation needs authority; historical rows cannot be reassigned or revived', async () => {
    const anna = await principal(seed.people.anna);
    const invited = await withPrincipal(db.app, anna, (trx) => memberships.invite(trx, { person_id: anna.personId, company_id: seed.companies.supplier, role: 'member', permissions: [], invited_by: null }));
    assert.equal(invited.status, 'invited');
    await rejects(withPrincipal(db.app, anna, (trx) => memberships.activate(trx, invited.id, invited.revision)), '23000', /activation_not_authorised|not authorised/);
    const boris = await principal(seed.people.boris);
    await rejects(withPrincipal(db.app, boris, (trx) => memberships.activate(trx, invited.id, invited.revision)), '23505', /membership_one_active_employer/);
    const ended = await withPrincipal(db.app, anna, async (trx) => {
      const current = await memberships.activeForPerson(trx, anna.personId);
      assert.equal(current?.id, seed.memberships.anna);
      return memberships.end(trx, current!.id, current!.revision, anna.personId, 'fixture: moving to the supplier');
    });
    assert.equal(ended?.status, 'ended');
    const stale = await assert.rejects(withPrincipal(db.app, anna, async () => 0), (e: unknown) => e instanceof PrincipalError && e.code === 'access.stale_epoch').then(() => true);
    assert.ok(stale, 'invariant 8: ending a membership bumps the epoch, so the old principal is refused');
    const annaAgain = await principal(seed.people.anna);
    assert.equal(annaAgain.authzEpoch, anna.authzEpoch + 1);
    assert.equal((await withPrincipal(db.app, annaAgain, (trx) => trx.selectFrom('object_participation').selectAll().execute())).length, 0, 'company rows are gone after the membership ended');
    await rejects(withPrincipal(db.app, annaAgain, (trx) => memberships.activate(trx, invited.id, invited.revision)), '23000', /activation_not_authorised|not authorised/);
    const activated = await withPrincipal(db.app, boris, (trx) => memberships.activate(trx, invited.id, invited.revision));
    assert.equal(activated?.status, 'active', 'a colleague with company.members.manage approves the request');
    const annaSupplier = await principal(seed.people.anna);
    assert.equal(annaSupplier.authzEpoch, annaAgain.authzEpoch + 1, 'activation bumps the epoch again');
    assert.equal((await withPrincipal(db.app, annaSupplier, (trx) => participations.listForResource(trx, 'project', seed.project))).length, 1, 'now a member of the supplier, Anna sees the supplier participation');

    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('membership').set({ person_id: seed.people.carl }).where('id', '=', seed.memberships.anna).execute()), '23000', /cannot be reassigned/);
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('membership').set({ status: 'active', ended_at: null, ended_by: null, ended_reason: null }).where('id', '=', seed.memberships.anna).execute()), '23000', /ended -> active/);
    await rejects(withPrincipal(db.app, annaSupplier, (trx) => trx.updateTable('membership').set({ person_id: seed.people.carl }).where('id', '=', activated!.id).execute()), '42501');
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('membership').values({ person_id: seed.people.carl, company_id: seed.companies.mixed, role: 'member', status: 'active', valid_from: new Date() }).execute()), '23505');
  });

  await t.test('invariant 8 for participation: revoke bumps the party epoch; revocation is final; rows are not reassigned', async () => {
    const petr = await principal(seed.people.petr);
    const borisBefore = await principal(seed.people.boris);
    const supplierEpochBefore = (await withMaintenance(db.admin, (trx) => trx.selectFrom('company').select('authz_epoch').where('id', '=', seed.companies.supplier).executeTakeFirstOrThrow())).authz_epoch;
    const row = await withPrincipal(db.app, petr, async (trx) => participations.listForResource(trx, 'project', seed.project).then((r) => r.find((x) => x.party_company_id === seed.companies.supplier)!));
    const revoked = await withPrincipal(db.app, petr, (trx) => participations.revoke(trx, row.id, row.revision, 'fixture: supplier dropped'));
    assert.ok(revoked?.revoked_at);
    const supplierEpochAfter = (await withMaintenance(db.admin, (trx) => trx.selectFrom('company').select('authz_epoch').where('id', '=', seed.companies.supplier).executeTakeFirstOrThrow())).authz_epoch;
    assert.equal(supplierEpochAfter, supplierEpochBefore + 1);
    assert.equal((await withPrincipal(db.app, borisBefore, (trx) => participations.liveForResource(trx, 'project', seed.project))).length, 0, 'revoked rows are no longer live for the supplier member');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('object_participation').set({ revoked_at: null, revoked_reason: null }).where('id', '=', row.id).execute()), '23000', /un-revoked/);
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('object_participation').set({ party_company_id: seed.companies.unrelated }).where('id', '=', row.id).execute()), '23000', /reassigned/);
    const regrant = await withPrincipal(db.app, petr, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: seed.project, party_company_id: seed.companies.supplier, party_person_id: null, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', granted_by_person_id: petr.personId }));
    assert.notEqual(regrant.id, row.id, 're-grant after revoke is a new row');
    await rejects(withPrincipal(db.app, petr, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: seed.project, party_company_id: seed.companies.supplier, party_person_id: null, side: 'participant', capabilities: ['negotiate'], audience: 'shared_party', granted_by_person_id: petr.personId })), '23505', /participation_one_live_per_company/);
    await rejects(withPrincipal(db.app, petr, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: seed.project, party_person_id: seed.people.carl, party_company_id: null, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', granted_by_person_id: seed.people.anna })), '42501', /row-level security/);
    const carl = await principal(seed.people.carl);
    await rejects(withPrincipal(db.app, carl, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: seed.project, party_person_id: carl.personId, party_company_id: null, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', granted_by_person_id: carl.personId })), '42501', /row-level security/);
    assert.equal(await withPrincipal(db.app, carl, (trx) => participations.revoke(trx, regrant.id, regrant.revision, 'not mine')), undefined, 'an outsider cannot even see the row to revoke it');
  });

  await t.test('capability vocabulary and party XOR are enforced in SQL from the frozen contracts', async () => {
    let petr = await principal(seed.people.petr);
    const resource = (await withPrincipal(db.app, petr, (trx) => projects.insert(trx, { owner_person_id: petr.personId, creator_person_id: petr.personId, name: 'Vocabulary probe' }))).id;
    const grantable = CAPABILITIES.filter((c) => c !== 'read.public' && c !== 'staff.case_read');
    await rejects(withPrincipal(db.app, petr, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: resource, party_person_id: seed.people.pure, party_company_id: null, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', granted_by_person_id: petr.personId })), '42501', /row-level security/);
    await withPrincipal(db.app, petr, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: resource, party_person_id: petr.personId, party_company_id: null, side: 'owner', capabilities: ['manage_participants'], audience: 'owner_private', granted_by_person_id: petr.personId }));
    petr = await principal(seed.people.petr); // the owner row bumped Petr's own epoch (invariant 8)
    const ok = await withPrincipal(db.app, petr, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: resource, party_person_id: seed.people.pure, party_company_id: null, side: 'participant', capabilities: [...grantable], audience: 'owner_private', granted_by_person_id: petr.personId }));
    assert.equal(ok.capabilities.length, grantable.length);
    const base = { resource_kind: 'project' as const, resource_id: resource, party_company_id: null, side: 'participant' as const, audience: 'shared_party' as const, granted_by_person_id: petr.personId };
    await rejects(withPrincipal(db.app, petr, (trx) => participations.grant(trx, { ...base, party_person_id: seed.people.carl, capabilities: ['read.public'] })), '23514');
    await rejects(withPrincipal(db.app, petr, (trx) => participations.grant(trx, { ...base, party_person_id: seed.people.carl, capabilities: ['admin.everything'] })), '23514');
    await rejects(withPrincipal(db.app, petr, (trx) => participations.grant(trx, { ...base, party_person_id: seed.people.carl, capabilities: [] })), '23514');
    await rejects(withPrincipal(db.app, petr, (trx) => participations.grant(trx, { ...base, party_person_id: seed.people.carl, capabilities: ['staff.case_read'] })), '23514', /participation_staff_case/);
    await rejects(withPrincipal(db.app, petr, (trx) => participations.grant(trx, { ...base, party_person_id: seed.people.carl, party_company_id: seed.companies.mixed, capabilities: ['read.shared'] })), '23514', /participation_party_xor/);
    await rejects(withPrincipal(db.app, petr, (trx) => participations.grant(trx, { ...base, party_person_id: null, capabilities: ['read.shared'] })), '23514', /participation_party_xor/);
    await rejects(withPrincipal(db.app, petr, (trx) => trx.insertInto('object_participation').values({ ...base, party_person_id: seed.people.carl, capabilities: ['read.shared'], audience: 'public' as never }).execute()), '23514');
  });

  await t.test('invariant 1: project owner is exactly one person XOR company; ownership moves only through an accepted transfer', async () => {
    const petr = await principal(seed.people.petr);
    const base = { creator_person_id: petr.personId, name: 'XOR probe' };
    await rejects(withPrincipal(db.app, petr, (trx) => projects.insert(trx, { ...base, owner_person_id: petr.personId, owner_company_id: seed.companies.mixed })), '23514', /project_owner_xor/);
    await rejects(withPrincipal(db.app, petr, (trx) => projects.insert(trx, { ...base, owner_person_id: null, owner_company_id: null })), '42501', /row-level security/);
    await rejects(withMaintenance(db.admin, (trx) => projects.insert(trx, { ...base, owner_person_id: null, owner_company_id: null })), '23514', /project_owner_xor/);
    await rejects(withPrincipal(db.app, petr, (trx) => projects.insert(trx, { ...base, owner_person_id: null, owner_company_id: seed.companies.mixed })), '42501', /row-level security/);
    await rejects(withPrincipal(db.app, petr, (trx) => projects.insert(trx, { ...base, creator_person_id: seed.people.carl, owner_person_id: petr.personId, owner_company_id: null })), '42501', /row-level security/);
    const created = await withPrincipal(db.app, petr, (trx) => projects.insert(trx, { ...base, owner_person_id: petr.personId, owner_company_id: null }));
    const carl = await principal(seed.people.carl);
    // P2-R4: nobody updates owner columns directly, not even the owner; managers cannot propose or apply transfers
    await rejects(withPrincipal(db.app, petr, (trx) => trx.updateTable('project').set({ owner_company_id: seed.companies.mixed, owner_person_id: null }).where('id', '=', created.id).execute()), '42501');
    await rejects(withPrincipal(db.app, carl, (trx) => trx.updateTable('project').set({ owner_person_id: carl.personId }).where('id', '=', created.id).execute()), '42501');
    assert.equal(await withPrincipal(db.app, carl, (trx) => projects.setLeader(trx, created.id, created.revision, carl.personId)), undefined, 'an unrelated principal cannot see the project');
    await withPrincipal(db.app, petr, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: created.id, party_person_id: petr.personId, party_company_id: null, side: 'owner', capabilities: ['manage_participants', 'transfer_ownership'], audience: 'owner_private', granted_by_person_id: petr.personId }));
    const petr2 = await principal(seed.people.petr);
    await withPrincipal(db.app, petr2, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: created.id, party_person_id: carl.personId, party_company_id: null, side: 'participant', capabilities: ['read.shared', 'manage_participants'], audience: 'shared_party', granted_by_person_id: petr2.personId }));
    const carlManager = await principal(seed.people.carl);
    assert.equal((await withPrincipal(db.app, carlManager, (trx) => projects.getById(trx, created.id)))?.id, created.id, 'a manager reads the project');
    await rejects(withPrincipal(db.app, carlManager, (trx) => trx.insertInto('ownership_transfer').values({ project_id: created.id, from_person_id: petr.personId, to_person_id: carlManager.personId, proposed_by: carlManager.personId, expires_at: new Date('2027-01-01T00:00:00Z') }).execute()), '42501', /row-level security/);
    const toCarl = await withPrincipal(db.app, petr2, (trx) => ownershipTransfers.propose(trx, { project_id: created.id, from_person_id: petr.personId, to_person_id: carl.personId, proposed_by: petr.personId, expires_at: new Date('2027-01-01T00:00:00Z') }));
    await rejects(withPrincipal(db.app, petr2, (trx) => projects.applyOwnershipTransfer(trx, toCarl.id)), '23000', /consent/);
    await rejects(withPrincipal(db.app, petr2, (trx) => ownershipTransfers.transition(trx, toCarl.id, toCarl.revision, 'accepted_by_recipient')), '23000', /recipient/);
    await rejects(withPrincipal(db.app, petr2, (trx) => ownershipTransfers.transition(trx, toCarl.id, toCarl.revision, 'effective')), '23000', /proposed -> effective/);
    const consented = await withPrincipal(db.app, carlManager, (trx) => ownershipTransfers.transition(trx, toCarl.id, toCarl.revision, 'accepted_by_recipient'));
    assert.ok(consented?.recipient_consent_at);
    await rejects(withPrincipal(db.app, carlManager, (trx) => projects.applyOwnershipTransfer(trx, toCarl.id)), '23000', /not applicable|not_authorised/);
    await rejects(withPrincipal(db.app, carlManager, (trx) => ownershipTransfers.transition(trx, toCarl.id, consented!.revision, 'effective')), '23000', /apply_ownership_transfer|apply_required/);
    await rejects(withPrincipal(db.app, carlManager, (trx) => ownershipTransfers.transition(trx, toCarl.id, consented!.revision, 'withdrawn')), '23000', /proposer/);
    await rejects(withPrincipal(db.app, petr2, (trx) => ownershipTransfers.transition(trx, toCarl.id, consented!.revision, 'proposed')), '23000', /accepted_by_recipient -> proposed/);
    const applied = await withPrincipal(db.app, petr2, (trx) => projects.applyOwnershipTransfer(trx, toCarl.id));
    assert.deepEqual([applied.owner_person_id, applied.owner_company_id, applied.revision], [carl.personId, null, 2]);
    assert.equal((await withPrincipal(db.app, carlManager, (trx) => ownershipTransfers.listForProject(trx, created.id)))[0]?.status, 'effective');
    await rejects(withPrincipal(db.app, petr2, (trx) => projects.applyOwnershipTransfer(trx, toCarl.id)), '23000', /not applicable|not_authorised/);
    const expired = await withPrincipal(db.app, carlManager, (trx) => ownershipTransfers.propose(trx, { project_id: created.id, from_person_id: carl.personId, to_person_id: petr.personId, proposed_by: carl.personId, expires_at: new Date(Date.now() + 1000) }));
    await withPrincipal(db.app, petr2, (trx) => ownershipTransfers.transition(trx, expired.id, expired.revision, 'accepted_by_recipient'));
    await withMaintenance(db.admin, (trx) => trx.updateTable('ownership_transfer').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', expired.id).execute());
    await rejects(withPrincipal(db.app, carlManager, (trx) => projects.applyOwnershipTransfer(trx, expired.id)), '23000', /expired/);
    const boris = await principal(seed.people.boris);
    const companyOwned = await withPrincipal(db.app, boris, (trx) => projects.insert(trx, { creator_person_id: boris.personId, owner_company_id: seed.companies.supplier, owner_person_id: null, name: 'Supplier project' }));
    const toBoris = await withPrincipal(db.app, boris, (trx) => ownershipTransfers.propose(trx, { project_id: companyOwned.id, from_company_id: seed.companies.supplier, to_person_id: boris.personId, proposed_by: boris.personId, expires_at: new Date('2027-01-01T00:00:00Z') }));
    await withPrincipal(db.app, boris, (trx) => ownershipTransfers.transition(trx, toBoris.id, toBoris.revision, 'accepted_by_recipient'));
    const transferred = await withPrincipal(db.app, boris, (trx) => projects.applyOwnershipTransfer(trx, toBoris.id));
    assert.deepEqual([transferred.owner_person_id, transferred.owner_company_id, transferred.revision], [boris.personId, null, 2]);
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('project').set({ owner_company_id: seed.companies.mixed }).where('id', '=', created.id).execute()), '23514', /project_owner_xor/);
  });

  await t.test('P1-2: party-private company data and private projects are closed without identity and to other parties', async () => {
    const anna = await principal(seed.people.anna);
    const carl = await principal(seed.people.carl);
    const annaEmployer = (await withPrincipal(db.app, anna, (trx) => memberships.activeForPerson(trx, anna.personId)))?.company_id as string;
    const privateRows = await withPrincipal(db.app, anna, (trx) => trx.selectFrom('company_private').selectAll().execute());
    assert.deepEqual(privateRows.map((r) => r.company_id), annaEmployer === seed.companies.mixed ? [seed.companies.mixed] : [], 'only the active employer private row is visible');
    assert.equal(await withPrincipal(db.app, carl, (trx) => companies.getPrivate(trx, seed.companies.mixed)), undefined);
    assert.deepEqual(await withPrincipal(db.app, carl, (trx) => trx.selectFrom('company_private').selectAll().execute()), []);
    const own = await withPrincipal(db.app, carl, (trx) => companies.upsertPrivate(trx, seed.companies.unrelated, { internal_notes: 'carl only' }));
    assert.equal(own.internal_notes, 'carl only');
    await rejects(withPrincipal(db.app, carl, (trx) => companies.upsertPrivate(trx, seed.companies.mixed, { internal_notes: 'intrusion' })), '42501', /row-level security/);
    const foreignUpdate = await withPrincipal(db.app, carl, (trx) => trx.updateTable('company').set({ display_name: 'hijacked' }).where('id', '=', seed.companies.mixed).executeTakeFirst());
    assert.equal(Number(foreignUpdate.numUpdatedRows), 0, 'a non-member cannot update another company');
    assert.equal((await withPrincipal(db.app, carl, (trx) => companies.getById(trx, seed.companies.mixed)))?.display_name, 'Fixture Facades LLC', 'public company fields stay readable');
    assert.equal((await withMaintenance(db.admin, (trx) => companies.getById(trx, seed.companies.mixed)))?.display_name, 'Fixture Facades LLC');
  });

  await t.test('P1-3: no self-escalation through write policies', async () => {
    const carl = await principal(seed.people.carl);
    const pure = await principal(seed.people.pure);
    // self-join as administrator / with permissions / already active
    await rejects(withPrincipal(db.app, pure, (trx) => memberships.invite(trx, { person_id: pure.personId, company_id: seed.companies.mixed, role: 'administrator', permissions: [], invited_by: null })), '42501', /row-level security/);
    await rejects(withPrincipal(db.app, pure, (trx) => memberships.invite(trx, { person_id: pure.personId, company_id: seed.companies.mixed, role: 'member', permissions: ['company.members.manage'], invited_by: null })), '42501', /row-level security/);
    await rejects(withPrincipal(db.app, pure, (trx) => trx.insertInto('membership').values({ person_id: pure.personId, company_id: seed.companies.mixed, role: 'member', status: 'active', valid_from: new Date() }).execute()), '42501', /row-level security/);
    await rejects(withPrincipal(db.app, pure, (trx) => trx.insertInto('membership').values({ person_id: pure.personId, company_id: seed.companies.mixed, role: 'member', invited_by: seed.people.anna }).execute()), '42501', /row-level security/);
    const request = await withPrincipal(db.app, pure, (trx) => memberships.invite(trx, { person_id: pure.personId, company_id: seed.companies.mixed, role: 'member', permissions: [], invited_by: null }));
    assert.equal(request.status, 'invited');
    // P1-R1: self-request cannot be self-activated; the inviter cannot activate on the invitee's behalf either
    await rejects(withPrincipal(db.app, pure, (trx) => memberships.activate(trx, request.id, request.revision)), '23000', /activation_not_authorised|not authorised/);
    // P1-R2: self-invite through the employer branch (as administrator or otherwise) and inviting without company.members.manage
    const borisM = await principal(seed.people.boris);
    await rejects(withPrincipal(db.app, borisM, (trx) => memberships.invite(trx, { person_id: borisM.personId, company_id: seed.companies.supplier, role: 'administrator', permissions: ['company.members.manage'], invited_by: borisM.personId })), '42501', /row-level security/);
    await rejects(withPrincipal(db.app, borisM, (trx) => memberships.invite(trx, { person_id: borisM.personId, company_id: seed.companies.supplier, role: 'member', permissions: [], invited_by: borisM.personId })), '42501', /row-level security/);
    const annaPlain = await principal(seed.people.anna); // active at the supplier without company.members.manage
    await rejects(withPrincipal(db.app, annaPlain, (trx) => memberships.invite(trx, { person_id: seed.people.xenia, company_id: seed.companies.supplier, role: 'member', permissions: [], invited_by: annaPlain.personId })), '42501', /row-level security/);
    await rejects(withPrincipal(db.app, borisM, (trx) => trx.insertInto('membership').values({ person_id: seed.people.xenia, company_id: seed.companies.supplier, role: 'member', status: 'active', valid_from: new Date(), invited_by: borisM.personId }).execute()), '42501', /row-level security/);
    // an invitation is accepted by the invitee only; the inviter cannot change the inviter column
    const xeniaInvite = await withPrincipal(db.app, borisM, (trx) => memberships.invite(trx, { person_id: seed.people.xenia, company_id: seed.companies.supplier, role: 'member', permissions: [], invited_by: borisM.personId }));
    await rejects(withPrincipal(db.app, borisM, (trx) => memberships.activate(trx, xeniaInvite.id, xeniaInvite.revision)), '23000', /activation_not_authorised|not authorised/);
    await rejects(withPrincipal(db.app, await principal(seed.people.xenia), (trx) => trx.updateTable('membership').set({ invited_by: null }).where('id', '=', xeniaInvite.id).execute()), '42501');
    const xeniaActive = await withPrincipal(db.app, await principal(seed.people.xenia), (trx) => memberships.activate(trx, xeniaInvite.id, xeniaInvite.revision));
    assert.equal(xeniaActive?.status, 'active', 'the invitee accepts their own invitation');
    assert.equal((await withPrincipal(db.app, await principal(seed.people.xenia), (trx) => companies.getPrivate(trx, seed.companies.supplier))), undefined, 'no private row yet, but visible scope is the supplier now');
    // self-promote
    const carlMembership = (await withPrincipal(db.app, carl, (trx) => memberships.activeForPerson(trx, carl.personId)))!;
    await rejects(withPrincipal(db.app, carl, (trx) => trx.updateTable('company').set({ claim_status: 'verified' }).where('id', '=', seed.companies.unrelated).execute()), '42501', /permission denied/); // P2-R1b: verification is not a runtime write
    await rejects(withPrincipal(db.app, carl, (trx) => trx.updateTable('company').set({ verified_domains: ['example.invalid'] }).where('id', '=', seed.companies.unrelated).execute()), '42501');
    await rejects(withPrincipal(db.app, carl, (trx) => memberships.changeRole(trx, carlMembership.id, carlMembership.revision, 'administrator', ['company.members.manage', 'company.billing.manage'])), '23000', /self_promotion|member manager/);
    await rejects(withPrincipal(db.app, pure, (trx) => memberships.changeRole(trx, request.id, request.revision, 'administrator', [])), '23000', /self_promotion|member manager/);
    // a colleague of the active employer may change roles; an outsider cannot see the row
    const invitedByCarl = await withPrincipal(db.app, carl, (trx) => memberships.invite(trx, { person_id: seed.people.pure, company_id: seed.companies.unrelated, role: 'member', permissions: [], invited_by: carl.personId }));
    const promoted = await withPrincipal(db.app, carl, (trx) => memberships.changeRole(trx, invitedByCarl.id, invitedByCarl.revision, 'administrator', ['company.members.manage']));
    assert.equal(promoted?.role, 'administrator');
    assert.equal(await withPrincipal(db.app, await principal(seed.people.pure), (trx) => memberships.changeRole(trx, carlMembership.id, carlMembership.revision, 'member', [])), undefined, 'rows of other companies are invisible (Pure re-resolved: the role change bumped her epoch)');
    // widen own capabilities / extend own validity; revoking oneself stays allowed
    const boris = await principal(seed.people.boris);
    const supplierRow = (await withPrincipal(db.app, boris, (trx) => participations.liveForResource(trx, 'project', seed.project)))[0]!;
    await rejects(withPrincipal(db.app, boris, (trx) => trx.updateTable('object_participation').set({ capabilities: ['read.shared', 'manage_participants', 'transfer_ownership'] }).where('id', '=', supplierRow.id).execute()), '23000', /self_amplification|manager of the resource/);
    await rejects(withPrincipal(db.app, boris, (trx) => trx.updateTable('object_participation').set({ audience: 'owner_private' }).where('id', '=', supplierRow.id).execute()), '23000', /self_amplification|manager of the resource/);
    await rejects(withPrincipal(db.app, boris, (trx) => trx.updateTable('object_participation').set({ valid_until: new Date('2099-01-01T00:00:00Z') }).where('id', '=', supplierRow.id).execute()), '23000', /self_amplification|manager of the resource/);
    const petr = await principal(seed.people.petr);
    const narrowed = await withPrincipal(db.app, petr, (trx) => trx.updateTable('object_participation').set({ capabilities: ['read.shared'] }).where('id', '=', supplierRow.id).returningAll().executeTakeFirst());
    assert.deepEqual(narrowed?.capabilities, ['read.shared'], 'the manager may change the grant');
    const selfRevoked = await withPrincipal(db.app, await principal(seed.people.boris), (trx) => participations.revoke(trx, supplierRow.id, narrowed!.revision, 'leaving the project'));
    assert.ok(selfRevoked?.revoked_at, 'a party may revoke itself');
    // forge an owner row on someone else's project / a second owner row
    await rejects(withPrincipal(db.app, carl, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: seed.project, party_person_id: carl.personId, party_company_id: null, side: 'owner', capabilities: ['manage_participants'], audience: 'owner_private', granted_by_person_id: carl.personId })), '42501', /row-level security/);
    await rejects(withPrincipal(db.app, carl, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: seed.project, party_person_id: null, party_company_id: seed.companies.unrelated, side: 'owner', capabilities: ['manage_participants'], audience: 'owner_private', granted_by_person_id: carl.personId })), '42501', /row-level security/);
    await rejects(withMaintenance(db.admin, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: seed.project, party_person_id: seed.people.carl, party_company_id: null, side: 'owner', capabilities: ['manage_participants'], audience: 'owner_private', granted_by_person_id: seed.people.carl })), '23505', /participation_one_live_owner/);
    // self-grant of permissions
    await rejects(withPrincipal(db.app, carl, (trx) => permissionGrants.grant(trx, { principal_person_id: carl.personId, principal_company_id: null, action: 'company.billing.manage', granted_by: carl.personId })), '42501', /row-level security/);
    await rejects(withPrincipal(db.app, carl, (trx) => permissionGrants.grant(trx, { principal_person_id: seed.people.pure, principal_company_id: null, action: 'company.billing.manage', granted_by: seed.people.anna })), '42501', /row-level security/);
    const granted = await withPrincipal(db.app, carl, (trx) => permissionGrants.grant(trx, { principal_person_id: seed.people.pure, principal_company_id: null, action: 'company.billing.view', granted_by: carl.personId }));
    assert.equal(granted.principal_person_id, seed.people.pure);
  });

  await t.test('P2-4: epoch bumps do not move the optimistic revision; a future valid_from gives no company context', async () => {
    const before = await withMaintenance(db.admin, (trx) => trx.selectFrom('person').select(['revision', 'authz_epoch', 'updated_at']).where('id', '=', seed.people.pure).executeTakeFirstOrThrow());
    const pure = await principal(seed.people.pure);
    await withPrincipal(db.app, pure, (trx) => participations.grant(trx, { resource_kind: 'project', resource_id: '22222222-2222-4222-8222-222222222222', party_person_id: pure.personId, party_company_id: null, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', granted_by_person_id: pure.personId }).catch(() => undefined));
    await withMaintenance(db.admin, (trx) => trx.updateTable('person').set({ authz_epoch: before.authz_epoch + 1 }).where('id', '=', seed.people.pure).execute());
    const after = await withMaintenance(db.admin, (trx) => trx.selectFrom('person').select(['revision', 'authz_epoch', 'updated_at']).where('id', '=', seed.people.pure).executeTakeFirstOrThrow());
    assert.equal(after.authz_epoch, before.authz_epoch + 1);
    assert.equal(after.revision, before.revision, 'revision unchanged by an epoch-only update');
    assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
    const edited = await withPrincipal(db.app, await principal(seed.people.pure), (trx) => trx.updateTable('person').set({ display_name: 'Fixture Participant (edited)' }).where('id', '=', seed.people.pure).returningAll().executeTakeFirstOrThrow());
    assert.equal(edited.revision, before.revision + 1, 'a real change still bumps the revision');
    await withMaintenance(db.admin, (trx) => trx.insertInto('membership').values({ person_id: seed.people.pure, company_id: seed.companies.unrelated, role: 'member', status: 'active', valid_from: new Date(Date.now() + 86_400_000) }).execute());
    const { sql } = await import('kysely');
    const context = await withPrincipal(db.app, await principal(seed.people.pure), async (trx) => (await sql<{ c: string }>`SELECT current_setting('trustwork.company_id', true) AS c`.execute(trx)).rows[0]?.c);
    assert.equal(context, '', 'a membership that is not yet valid gives no company context');
  });

  await t.test('audit_event is append-only: the runtime role may only insert; UPDATE/DELETE raise even for the owner', async () => {
    const petr = await principal(seed.people.petr);
    // The runtime role appends without reading back (REL-001 revoked its SELECT on audit_event); the owner reads the id.
    const lastAuditId = async () => (await db.admin.query<{ id: string }>('SELECT max(id)::text AS id FROM trustwork.audit_event')).rows[0]!.id;
    await withPrincipal(db.app, petr, (trx) => auditEvents.append(trx, { actor_person_id: petr.personId, action: 'project.create', object_kind: 'project', object_id: seed.project, basis: [{ kind: 'owner' }], authz_epoch: petr.authzEpoch }));
    const event = { id: await lastAuditId() };
    assert.ok(Number(event.id) >= 1);
    await rejects(withPrincipal(db.app, petr, (trx) => trx.updateTable('audit_event').set({ reason: 'tamper' }).where('id', '=', event.id).execute()), '42501');
    await rejects(withPrincipal(db.app, petr, (trx) => trx.deleteFrom('audit_event').where('id', '=', event.id).execute()), '42501');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('audit_event').set({ reason: 'tamper' }).where('id', '=', event.id).execute()), '23000', /append-only/);
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('audit_event').where('id', '=', event.id).execute()), '23000', /append-only/);
    await rejects(db.admin.query('DELETE FROM trustwork.audit_event WHERE id = $1', [event.id]), '23000', /append-only/);
    await withPrincipal(db.app, petr, (trx) => auditEvents.append(trx, { action: 'project.update', object_kind: 'project', object_id: seed.project }));
    const next = { id: await lastAuditId() };
    assert.ok(Number(next.id) > Number(event.id), 'monotonic sequence');
  });

  await t.test('RL-16/RL-17: SECURITY DEFINER lookups return minimal columns and dummy rows; direct reads stay closed', async () => {
    const hashHex = seed.sessionTokenHashHex;
    assert.equal((await db.app.query('SELECT id FROM trustwork.session WHERE token_hash = $1', [Buffer.from(hashHex, 'hex')])).rowCount, 0, 'direct select without identity returns nothing');
    const session = await auth.lookupSession(db.app, hashHex);
    assert.ok(session);
    assert.deepEqual(Object.keys(session).sort(), ['absolute_expires_at', 'auth_method', 'authenticated_at', 'authz_epoch', 'idle_expires_at', 'person_id', 'revoked_at', 'session_id']);
    assert.equal(session.person_id, seed.people.pure);
    assert.equal(await auth.lookupSession(db.app, 'ab'.repeat(32)), null);

    const unknown = await auth.lookupPasswordCredential(db.app, 'nobody@example.invalid');
    assert.equal(unknown.person_id, null);
    assert.match(unknown.password_hash, /^\$argon2id\$/);
    const known = await auth.lookupPasswordCredential(db.app, 'pure@example.invalid');
    assert.equal(known.person_id, seed.people.pure);
    assert.equal(known.email_verified, true);
    assert.notEqual(known.password_hash, unknown.password_hash);
    assert.deepEqual(Object.keys(known).sort(), ['authz_epoch', 'credential_id', 'disabled_at', 'email_verified', 'password_hash', 'person_id']);
    assert.equal(await auth.lookupProviderCredential(db.app, 'google', 'no-such-subject'), null);

    const registered = await auth.registerPerson(db.app, { displayName: 'Fixture Newcomer', emailNormalized: 'newcomer@example.invalid', passwordHash: '$argon2id$fixture', verifyTokenHashHex: createHash('sha256').update('verify-1').digest('hex'), verifyExpiresAt: new Date(Date.now() + 3_600_000) });
    assert.ok(registered);
    assert.equal(await auth.registerPerson(db.app, { displayName: 'Dup', emailNormalized: 'newcomer@example.invalid', passwordHash: 'x', verifyTokenHashHex: createHash('sha256').update('verify-2').digest('hex'), verifyExpiresAt: new Date(Date.now() + 3_600_000) }), null, 'duplicate e-mail is not an error (enumeration-safe)');
    const consumed = await auth.consumeToken(db.app, createHash('sha256').update('verify-1').digest('hex'), 'verify_email');
    assert.equal(consumed?.person_id, registered);
    assert.equal(await auth.consumeToken(db.app, createHash('sha256').update('verify-1').digest('hex'), 'verify_email'), null, 'single use');
    assert.equal(await auth.consumeToken(db.app, createHash('sha256').update('verify-2').digest('hex'), 'verify_email'), null, 'never issued');
    assert.equal(await auth.issueToken(db.app, { emailNormalized: 'nobody@example.invalid', kind: 'recovery', tokenHashHex: 'cd'.repeat(32), expiresAt: new Date(Date.now() + 1000), requireVerified: true }), null);
    assert.equal(await auth.issueToken(db.app, { emailNormalized: 'newcomer@example.invalid', kind: 'recovery', tokenHashHex: 'cd'.repeat(32), expiresAt: new Date(Date.now() + 1000), requireVerified: true }), null, 'unverified binding cannot recover');
    const recovery = await auth.issueToken(db.app, { emailNormalized: 'pure@example.invalid', kind: 'recovery', tokenHashHex: 'ef'.repeat(32), expiresAt: new Date(Date.now() - 1000), requireVerified: true });
    assert.equal(recovery, seed.people.pure);
    assert.equal(await auth.consumeToken(db.app, 'ef'.repeat(32), 'recovery'), null, 'expired token is not consumable');
    const viaGoogle = await auth.registerProviderPerson(db.app, { displayName: 'Fixture Google Person', emailNormalized: 'google-first@example.invalid', provider: 'google', subject: 'sub-123', emailVerified: true });
    assert.ok(viaGoogle);
    assert.equal(await auth.registerProviderPerson(db.app, { displayName: 'Dup', emailNormalized: 'google-first@example.invalid', provider: 'apple', subject: 'other', emailVerified: false }), null, 'bound e-mail');
    assert.equal(await auth.registerProviderPerson(db.app, { displayName: 'Dup', emailNormalized: 'another@example.invalid', provider: 'google', subject: 'sub-123', emailVerified: false }), null, 'bound provider subject');
    assert.equal((await auth.lookupProviderCredential(db.app, 'google', 'sub-123'))?.person_id, viaGoogle);
    assert.equal(await auth.lookupPasswordCredential(db.app, 'google-first@example.invalid').then((r) => r.person_id), null, 'no password credential: dummy row');
    assert.equal(await auth.recordLoginFailure(db.app, 'ab'.repeat(32), 900, 86_400), 1);
    assert.equal(await auth.recordLoginFailure(db.app, 'ab'.repeat(32), 900, 86_400), 2);

    const newcomer: Principal = { personId: registered as string, authzEpoch: 1 };
    const visible = await withPrincipal(db.app, newcomer, async (trx) => {
      const bindings = await trx.selectFrom('email_binding').select(['email_normalized', 'verified_at']).execute();
      const credentials = await trx.selectFrom('credential').select(['kind', 'provider']).execute();
      const others = await trx.selectFrom('session').selectAll().execute();
      const created = await sessions.insert(trx, { person_id: newcomer.personId, token_hash_hex: '12'.repeat(32), idle_expires_at: new Date(Date.now() + 60_000), absolute_expires_at: new Date(Date.now() + 120_000), auth_method: 'password' });
      return { bindings, credentials, others: others.length, created: created.person_id };
    });
    assert.deepEqual(visible.bindings.map((b) => [b.email_normalized, b.verified_at]), [['newcomer@example.invalid', null]]);
    assert.deepEqual(visible.credentials, [{ kind: 'password', provider: null }]);
    assert.equal(visible.others, 0, 'another person\'s session is invisible');
    assert.equal(visible.created, newcomer.personId);
    await rejects(withPrincipal(db.app, newcomer, (trx) => sessions.insert(trx, { person_id: seed.people.pure, token_hash_hex: '34'.repeat(32), idle_expires_at: new Date(Date.now() + 60_000), absolute_expires_at: new Date(Date.now() + 120_000), auth_method: 'password' })), '42501', /row-level security/);
  });
});
