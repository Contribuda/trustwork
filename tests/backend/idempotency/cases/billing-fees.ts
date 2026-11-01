import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { createApp } from '../../../../apps/api/src/app.js';
import { approvals, staffAssignments, staffRoleDefinitions, type CommandContext } from '../../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../../packages/data/src/repositories/second-factor.js';
import { principalFor } from '../../../data/helpers/seed.js';
import { Client, type Harness } from '../../helpers/app.js';
import { addLogins, enrolNow, signIn } from '../../../admin/helpers.js';
import { codeNow } from '../../second-factor/helpers.js';
import { syntheticTerms } from '../../../billing/fees/helpers.js';
import type { PublicFee } from '../../../../packages/contracts/src/billing-fees.js';
import type { CrashCase } from '../cases.js';

async function as<T>(h: Harness, personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>) {
  const session = await withMaintenance(h.db.admin, (trx) => trx.insertInto('session').values({ person_id: personId, token_hash: randomBytes(32),
    idle_expires_at: new Date(Date.now()+3600000), absolute_expires_at: new Date(Date.now()+3600000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
  return withPrincipal(h.pool, await principalFor(h.db.admin, personId), async (trx) => {
    const e = await sessionElevations.insert(trx, { sessionId: session.id, personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now()+900000) });
    return fn(trx, { elevationId: e.id, requestId: 'req-'+randomUUID(), reasonCode: 'synthetic_test', reasonText: 'Synthetic fee crash setup' });
  });
}

export default {
  name: 'BILL-003: fee draft and exact-digest activation commit exactly once',
  async run({ h, exactlyOnce }) {
    const founder = (await h.db.admin.query<{ person_id: string; node: string }>("SELECT a.person_id,(SELECT id FROM trustwork.admin_node LIMIT 1) AS node FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap AND a.role='platform-owner' AND a.revoked_at IS NULL")).rows[0]!;
    assert.ok(founder, 'the admin fixture provides the actual founding administrator');
    const setup = await withMaintenance(h.db.admin, async (trx) => {
      const hub = await trx.insertInto('hub').values({ slug: 'synthetic-fee-crash', lifecycle: 'preparing' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('hub_profile').values({ hub_id: hub.id, node_id: founder.node, name: { en: 'Synthetic fee crash hub' }, default_locale: 'en', locales: ['en'], time_zone: 'UTC', currency: 'USD', created_by: founder.person_id }).execute();
      const people: string[] = [];
      for (const role of ['data-steward', 'editor-in-chief'] as const) {
        await staffRoleDefinitions.release(trx, { role, version: 903, scopes: ['hub'], permissions: ['admin.billing.fees.draft','admin.billing.fees.activate'],
          caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
        people.push((await trx.insertInto('person').values({ display_name: 'Synthetic fee crash '+role }).returning('id').executeTakeFirstOrThrow()).id);
      }
      return { hubId: hub.id, drafter: people[0]!, activator: people[1]! };
    });
    for (const [personId, role] of [[setup.drafter, 'data-steward'], [setup.activator, 'editor-in-chief']] as const) {
      await as(h, founder.person_id, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId, role, scope: { kind: 'hub', hubId: setup.hubId }, definitionVersion: 903 }));
    }
    await addLogins(h, [[setup.drafter,'synthetic-crash-fee-drafter@example.invalid'],[setup.activator,'synthetic-crash-fee-activator@example.invalid']]);
    const app = await createApp({ env: { API_HOST:'127.0.0.1',API_PORT:'0',PUBLIC_ORIGIN:'https://trustwork.test',TRUSTWORK_HUB_ID:setup.hubId,MAIL_SECRET_KEY:randomBytes(32).toString('hex') }, pool:h.pool,clock:h.clock });
    try {
      const drafter = new Client(app); const activator = new Client(app);
      const pairs = [[drafter,'synthetic-crash-fee-drafter@example.invalid'],[activator,'synthetic-crash-fee-activator@example.invalid']] as const;
      const secrets: Buffer[] = [];
      for (const [client,email] of pairs) { await signIn(client,email); secrets.push(await enrolNow(h,client)); }
      h.clock.advance(30000);
      for (const [i,[client]] of pairs.entries()) assert.equal((await client.post('/v1/admin/session/elevate',{proof:{method:'totp',code:codeNow(h,secrets[i]!)}},{idempotencyKey:null})).status,200);
      const count = async (action:string) => (await h.db.admin.query<{n:number}>('SELECT count(*)::int n FROM trustwork.admin_audit_event WHERE action=$1 AND hub_id=$2',[action,setup.hubId])).rows[0]!.n;
      const f = (await exactlyOnce({ action:'billing.fee_draft',client:drafter,url:'/v1/admin/billing/fees',body:{reason:'Synthetic crash test',terms:syntheticTerms({effectiveFrom:new Date(Date.now()+3600000).toISOString(),effectiveTo:null})},effects:()=>count('billing.fee_drafted') })).body as PublicFee;
      const approval = await as(h,setup.activator,(trx,ctx)=>approvals.request(trx,ctx,{action:'billing.activate_fee_version',scope:{kind:'hub',hubId:setup.hubId},actionDigest:f.digest}));
      await as(h,setup.drafter,(trx,ctx)=>approvals.decide(trx,ctx,approval.id,'approve',f.digest));
      await exactlyOnce({action:'billing.fee_activate',client:activator,url:`/v1/admin/billing/fees/${f.id}/activate`,body:{reason:'Synthetic crash test',digest:f.digest,approvalId:approval.id},effects:()=>count('billing.fee_activated')});
    } finally { await app.close(); }
  },
} satisfies CrashCase;
