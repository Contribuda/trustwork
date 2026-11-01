import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { sql } from 'kysely';
import { ReputationService } from '../../apps/api/src/modules/reputation/reputation.service.js';
import { ProfilesService } from '../../apps/api/src/modules/profiles/profiles.service.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { as, stateOf } from '../assistant/helpers.js';
import { buildAgentWorld } from './helpers.js';

const h = await startHarness('agt_service_revocation');
test('actual service invocation retains the original session and current role basis', { skip: h ? false : SKIP_REASON }, async t => {
  if (!h) return;
  t.after(() => h.close());
  await buildAgentWorld(h);
  const seed = await seedPersonas(h);
  const client = h.client(); await login(client, 'boris');
  const state = await stateOf(h,client,'synthetic-role-race');
  const service = h.created.app.get(ReputationService);
  const profiles = h.created.app.get(ProfilesService);
  const company = { kind: 'company' as const, id: seed.companies.supplier };
  const deny = (e: unknown) => ['access.not_found','access.forbidden','auth.session_invalid'].includes((e as { code?: string }).code ?? '');
  await t.test('owning read first blocks membership revocation; revocation first denies read and mutation with a cached principal', async () => {
    await service.own(company,state);
    const blocker = await h.db.admin.connect();
    let read: ReturnType<typeof service.own> | undefined; let revoker: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE trustwork.professional_credential IN ACCESS EXCLUSIVE MODE');
      read = service.own(company,state);
      let blocked = false;
      for (let attempt=0;attempt<200 && !blocked;attempt++) {
        blocked = (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%professional_credential%'")).rows[0]!.n>0;
        if (!blocked) await new Promise(r=>setTimeout(r,5));
      }
      assert.ok(blocked);
      let revoked = false;
      revoker = withMaintenance(h.db.admin,trx=>sql`UPDATE trustwork.membership SET permissions=ARRAY['company.members.manage']::text[] WHERE id=${seed.memberships.boris}::uuid`.execute(trx)).then(r=>{ revoked=true; return r; });
      await new Promise(r=>setTimeout(r,50));
      assert.equal(revoked,false,'the actual private read retains its current role until commit');
      await blocker.query('COMMIT');
      assert.equal((await read).projection,'owner_private');
      await revoker;
      await assert.rejects(service.own(company,state),deny);
      await assert.rejects(service.addPortfolioEntry({ holder: company, context: null, externalDescription: 'Synthetic work', title: 'Synthetic', role: 'Builder', period: { from:null,to:null }, scopeSummary:'Synthetic',visibility:'private',supersedesId:null },state),deny);
      assert.equal((await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.portfolio_entry WHERE holder_company_id=$1',[company.id])).rows[0]!.n,0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await read; await revoker; }
  });
  await t.test('a revoked real session cannot use a cached service state, including mandatory personal controls', async () => {
    const fresh = await stateOf(h,client,'synthetic-session-revocation');
    await profiles.myProfile(fresh);
    await withMaintenance(h.db.admin,trx=>sql`UPDATE trustwork.session SET revoked_at=clock_timestamp(),revoked_reason='logout' WHERE id=${fresh.session!.id}::uuid`.execute(trx));
    await assert.rejects(profiles.myProfile(fresh),deny);
    await assert.rejects(profiles.listConsents(fresh),deny);
  });
  await t.test('raw app role cannot lock another person session and worker role has no invocation grant', async () => {
    const other = h.client(); await login(other,'petr');
    const foreign = await stateOf(h,other,'synthetic-foreign-session');
    await assert.rejects(as(h,seed.people.carl,trx=>sql`SELECT trustwork.agent_modules_lock_authenticated_invocation(${foreign.session!.id}::uuid,NULL,NULL)`.execute(trx)));
    assert.equal((await h.db.admin.query<{ allowed: boolean }>("SELECT has_function_privilege('trustwork_worker','trustwork.agent_modules_lock_authenticated_invocation(uuid,uuid,integer)','EXECUTE') AS allowed")).rows[0]!.allowed,false);
  });
});
