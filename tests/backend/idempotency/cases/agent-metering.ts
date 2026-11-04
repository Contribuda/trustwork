import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { createApp } from '../../../../apps/api/src/app.js';
import { approvals, staffAssignments, staffRoleDefinitions, type CommandContext } from '../../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../../packages/data/src/repositories/identity.js';
import { principalFor } from '../../../data/helpers/seed.js';
import { Client, type Harness } from '../../helpers/app.js';
import { addLogins, enrolNow, signIn } from '../../../admin/helpers.js';
import { codeNow } from '../../second-factor/helpers.js';
import { syntheticCost, syntheticTerms } from '../../../billing/agent-metering/helpers.js';
import { runs } from '../../../../packages/data/src/repositories/assistant.js';
import { meteredSteps } from '../../../../packages/data/src/repositories/agent-usage.js';
import type { AgentPlanVersionView, CreditPackVersionView, MeteredPriceVersion } from '../../../../packages/contracts/src/agent-metering.js';
import type { CrashCase } from '../cases.js';

async function as<T>(h: Harness, personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>) {
  const session = await withMaintenance(h.db.admin, (trx) => trx.insertInto('session').values({ person_id: personId, token_hash: randomBytes(32),
    idle_expires_at: new Date(Date.now() + 3600000), absolute_expires_at: new Date(Date.now() + 3600000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
  return withPrincipal(h.pool, await principalFor(h.db.admin, personId), async (trx) => {
    const e = await sessionElevations.insert(trx, { sessionId: session.id, personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 900000) });
    return fn(trx, { elevationId: e.id, requestId: 'req-' + randomUUID(), reasonCode: 'synthetic_test', reasonText: 'Synthetic metered price crash setup' });
  });
}

export default {
  name: 'AGT-004: agent usage price commands commit exactly once',
  async run({ h, exactlyOnce }) {
    const founder = (await h.db.admin.query<{ person_id: string; node: string }>("SELECT a.person_id,(SELECT id FROM trustwork.admin_node LIMIT 1) AS node FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap AND a.role='platform-owner' AND a.revoked_at IS NULL")).rows[0]!;
    assert.ok(founder, 'the admin fixture provides the actual founding administrator');
    const setup = await withMaintenance(h.db.admin, async (trx) => {
      const hub = await trx.insertInto('hub').values({ slug: 'synthetic-metering-crash', lifecycle: 'preparing' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('hub_profile').values({ hub_id: hub.id, node_id: founder.node, name: { en: 'Synthetic metering crash hub' }, default_locale: 'en', locales: ['en'], time_zone: 'UTC', currency: 'USD', created_by: founder.person_id }).execute();
      const people: string[] = [];
      for (const role of ['data-steward', 'editor-in-chief'] as const) {
        await staffRoleDefinitions.release(trx, { role, version: 904, scopes: ['hub'], permissions: ['admin.commerce.price.draft', 'admin.commerce.price.activate', 'admin.commerce.plan.activate', 'admin.assistant.reconcile'],
          caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
        people.push((await trx.insertInto('person').values({ display_name: 'Synthetic metering crash ' + role }).returning('id').executeTakeFirstOrThrow()).id);
      }
      return { hubId: hub.id, drafter: people[0]!, activator: people[1]! };
    });
    for (const [personId, role] of [[setup.drafter, 'data-steward'], [setup.activator, 'editor-in-chief']] as const) {
      await as(h, founder.person_id, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId, role, scope: { kind: 'hub', hubId: setup.hubId }, definitionVersion: 904 }));
    }
    const emails = ['synthetic-crash-metering-drafter@example.invalid', 'synthetic-crash-metering-activator@example.invalid'] as const;
    await addLogins(h, [[setup.drafter, emails[0]], [setup.activator, emails[1]]]);
    const app = await createApp({ env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', TRUSTWORK_HUB_ID: setup.hubId, MAIL_SECRET_KEY: randomBytes(32).toString('hex') }, pool: h.pool, clock: h.clock });
    try {
      const drafter = new Client(app);
      const activator = new Client(app);
      const secrets: Buffer[] = [];
      for (const [i, client] of [drafter, activator].entries()) { await signIn(client, emails[i]!); secrets.push(await enrolNow(h, client)); }
      h.clock.advance(30000);
      for (const [i, client] of [drafter, activator].entries()) assert.equal((await client.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[i]!) } }, { idempotencyKey: null })).status, 200);
      const count = async (action: string) => (await h.db.admin.query<{ n: number }>('SELECT count(*)::int n FROM trustwork.admin_audit_event WHERE action=$1 AND hub_id=$2', [action, setup.hubId])).rows[0]!.n;
      const reason = 'Synthetic crash test';
      const later = (hours: number) => new Date(Date.now() + hours * 3600000).toISOString();
      await exactlyOnce({ action: 'billing.metered_cost_record', client: drafter, url: '/v1/admin/billing/metered/costs', body: { reason, cost: syntheticCost() }, effects: () => count('billing.metered_cost_recorded') });
      const version = (await exactlyOnce({ action: 'billing.metered_price_draft', client: drafter, url: '/v1/admin/billing/metered/prices', body: { reason, terms: syntheticTerms({ effectiveFrom: later(1) }) }, effects: () => count('billing.metered_price_drafted') })).body as MeteredPriceVersion;
      const approval = await as(h, setup.activator, (trx, ctx) => approvals.request(trx, ctx, { action: 'commerce.activate_price_version', scope: { kind: 'hub', hubId: setup.hubId }, actionDigest: version.digest }));
      await as(h, setup.drafter, (trx, ctx) => approvals.decide(trx, ctx, approval.id, 'approve', version.digest));
      await exactlyOnce({ action: 'billing.metered_price_activate', client: activator, url: `/v1/admin/billing/metered/prices/${version.id}/activate`, body: { reason, digest: version.digest, approvalId: approval.id }, effects: () => count('billing.metered_price_activated') });
      const spare = (await drafter.post('/v1/admin/billing/metered/prices', { reason, terms: syntheticTerms({ effectiveFrom: later(2) }) })).body as MeteredPriceVersion;
      await exactlyOnce({ action: 'billing.metered_price_cancel', client: drafter, url: `/v1/admin/billing/metered/prices/${spare.id}/cancel`, body: { reason }, effects: () => count('billing.metered_price_cancelled') });
      const approve = async (digest: string) => {
        const request = await as(h, setup.activator, (trx, ctx) => approvals.request(trx, ctx, { action: 'commerce.activate_price_version', scope: { kind: 'hub', hubId: setup.hubId }, actionDigest: digest }));
        await as(h, setup.drafter, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
        return request.id;
      };
      const plan = (await exactlyOnce({ action: 'billing.plan_draft', client: drafter, url: '/v1/admin/billing/metered/plans', effects: () => count('billing.plan_drafted'), body: { reason, terms: {
        planKey: 'synthetic_crash', name: 'Synthetic crash plan', plan: { payerKind: 'person', moduleKeys: ['profile_keeper'], includedQuota: [], connections: 1, channels: 0, representativeIncluded: false },
        price: { amountMinor: '100', currency: 'USD', effectiveFrom: later(3), effectiveTo: null, acceptanceTextVersion: 'synthetic-plan-1' } } } })).body as AgentPlanVersionView;
      await exactlyOnce({ action: 'billing.plan_activate', client: activator, url: `/v1/admin/billing/metered/plans/${plan.id}/activate`, body: { reason, digest: plan.digest, approvalId: await approve(plan.digest) }, effects: () => count('billing.plan_activated') });
      const pack = (await exactlyOnce({ action: 'billing.credit_pack_draft', client: drafter, url: '/v1/admin/billing/metered/credit-packs', effects: () => count('billing.credit_pack_drafted'), body: { reason, terms: {
        packKey: 'synthetic_crash_pack', name: 'Synthetic crash pack', amountMinor: '100', currency: 'USD', creditsMinor: '100', validityDays: null, reminderDays: null, refundPolicyVersion: 1, effectiveFrom: later(4), effectiveTo: null, acceptanceTextVersion: 'synthetic-pack-1' } } })).body as CreditPackVersionView;
      await exactlyOnce({ action: 'billing.credit_pack_activate', client: activator, url: `/v1/admin/billing/metered/credit-packs/${pack.id}/activate`, body: { reason, digest: pack.digest, approvalId: await approve(pack.digest) }, effects: () => count('billing.credit_pack_activated') });
      const acceptances = async () => (await h.db.admin.query<{ n: number }>('SELECT count(*)::int n FROM trustwork.price_acceptance WHERE price_version_id=$1', [version.id])).rows[0]!.n;
      await exactlyOnce({ action: 'billing.price_accept', client: drafter, url: `/v1/billing/prices/${version.id}/accept`, body: { acceptanceTextVersion: 'synthetic-metered-1', amountMinor: '10', currency: 'USD', forCompany: false }, effects: acceptances });
      const stepId = await as(h, setup.drafter, async (trx) => {
        const run = await runs.start(trx, { principal_person_id: setup.drafter, kind: 'conversation' });
        const step = await meteredSteps.admit(trx, { hubId: setup.hubId, principal: { kind: 'person', id: setup.drafter }, moduleKey: 'research', capabilityId: null, runId: run.id, runStepId: randomUUID(), attemptId: randomUUID(), connectionId: null,
          meter: 'checks', providerClass: null, estimatedUnits: 1, budgetId: null, projectId: null });
        assert.ok(step.decision === 'admitted');
        await meteredSteps.finish(trx, step.stepId, 'unknown', null, 'synthetic:lost');
        return step.stepId;
      });
      await exactlyOnce({ action: 'billing.metered_step_reconcile', client: activator, url: `/v1/admin/billing/metered/steps/${stepId}/reconcile`, body: { reason, result: 'failed', units: null, evidence: 'synthetic:no-effect' }, effects: () => count('billing.metered_step_reconciled') });
    } finally { await app.close(); }
  },
} satisfies CrashCase;
