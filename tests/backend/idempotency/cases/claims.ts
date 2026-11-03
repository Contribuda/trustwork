import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import type { CrashCase } from '../cases.js';
import type { Client, Response } from '../../helpers/app.js';
import { count } from '../../hardening/helpers.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';

/** Test role definition over the console vocabulary (version 28, unused elsewhere), held at this case's own hub. */
const VERSION = 28;
const PERMISSIONS = ['admin.claims.read', 'admin.claims.decide', 'admin.claims.policy.edit', 'admin.claims.revoke'];

/**
 * CLM-001: every claim route classified in_transaction, through the BE-005 crash sequence. Two claimants submit and
 * withdraw; reviewer A decides and proposes, reviewer B confirms; a hand-over is revoked and the hub's periods are set.
 * The notices and their deliveries share the same transaction. Every person, hub and company is synthetic.
 */
export default {
  name: 'CLM-001: company claims, disputes, hand-overs and settings',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const hubId = '00000000-0000-4000-8000-00000000c904';
    const seeded = await withMaintenance(admin, async (trx) => {
      await trx.insertInto('hub').values({ id: hubId, slug: `synthetic-claims-${randomBytes(2).toString('hex')}`, lifecycle: 'public' }).execute();
      await trx.insertInto('staff_role_definition_version').values({ role: 'trust-reviewer', version: VERSION, scopes: ['hub'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' })
        .onConflict((oc) => oc.doNothing()).execute();
      const founder = await trx.selectFrom('staff_role_assignment').select('person_id').where('setup_bootstrap', '=', true).where('role', '=', 'platform-owner').executeTakeFirstOrThrow();
      const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
      const people = { a: await person('Synthetic Crash Claims Reviewer A'), b: await person('Synthetic Crash Claims Reviewer B'), c1: await person('Synthetic Crash Claimant One'), c2: await person('Synthetic Crash Claimant Two') };
      for (const id of [people.a, people.b]) {
        await trx.insertInto('staff_role_assignment').values({ person_id: id, role: 'trust-reviewer', scope_kind: 'hub', hub_id: hubId, definition_version: VERSION, granted_by: founder.person_id, reason: 'Synthetic crash test' }).execute();
      }
      const company = async (name: string) => (await trx.insertInto('company').values({ display_name: name, claim_status: 'unclaimed' } as never).returning('id').executeTakeFirstOrThrow()).id;
      return { people, single: await company('Synthetic Crash Claimed Builders'), contested: await company('Synthetic Crash Contested Builders'), held: await company('Synthetic Crash Held Builders') };
    });
    const { people, single, contested, held } = seeded;
    const email = (k: string) => `crash-claims-${k}@example.invalid`;
    await addLogins(h, Object.entries(people).map(([k, id]) => [id, email(k)]));
    const reviewers = {} as Record<'a' | 'b', Client>;
    for (const key of ['a', 'b'] as const) {
      h.staff.set(people[key], ['trust-reviewer']);
      reviewers[key] = h.client();
      await signIn(reviewers[key], email(key));
      const secret = await enrolNow(h, reviewers[key]);
      h.clock.advance(30_000);
      assert.equal((await reviewers[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
      const elevated = await reviewers[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
      assert.equal(elevated.status, 200, `elevate ${key}: ${JSON.stringify(elevated.body)}`);
      h.clock.reset();
    }
    const { a, b } = reviewers;
    const c1 = h.client();
    const c2 = h.client();
    await signIn(c1, email('c1'));
    await signIn(c2, email('c2'));
    const body = <T>(r: Response): T => { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body)); return r.body as T; };
    const cmd = (action: string, rest: Record<string, unknown>) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
    const run = (action: string, client: Client, url: string, rest: Record<string, unknown>, effects: () => Promise<number>) => exactlyOnce({ action, client, url, body: cmd(action, rest), effects });
    const audits = (action: string, objectId: string) => () => count(admin, "SELECT 1 FROM trustwork.admin_audit_event WHERE action = $1 AND outcome = 'applied' AND hub_id = $2 AND object_id = $3", [action, hubId, objectId]);
    const claimsOf = (companyId: string, state: string) => () => count(admin, 'SELECT 1 FROM trustwork.company_claim WHERE company_id = $1 AND state = $2', [companyId, state]);
    const base = `/v1/admin/hubs/${hubId}`;

    const recipeKey = 'crash-claims-recipe';
    const drafted = body<{ recipe: { id: string; revision: number } }>(await a.post(`${base}/verification/recipes`, cmd('claims.recipe', { key: recipeKey, subjectKind: 'company', trigger: 'claim_verified', recheckMonths: 12,
      badgeCategories: ['register_record_matches'], steps: [{ check: 'register_match', required: true }, { check: 'sanctions_screening', required: true }] }), { idempotencyKey: 'crash-claims.recipe' }));
    const recipeId = drafted.recipe.id;
    body(await a.post(`${base}/verification/recipes/${recipeId}/activate`, cmd('claims.recipe_activate', { expectedRevision: drafted.recipe.revision }), { idempotencyKey: 'crash-claims.recipe_activate' }));
    const submission = (companyId: string) => ({ hubId, companyId, level: 'verified', recipeId, tie: null });

    const submitted = body<{ claim: { id: string } }>(await exactlyOnce({ action: 'claims.submit', client: c1, url: '/v1/claims', body: submission(single), effects: claimsOf(single, 'open') }));
    await exactlyOnce({ action: 'claims.withdraw', client: c1, url: `/v1/claims/${submitted.claim.id}/withdraw`, body: {}, effects: claimsOf(single, 'withdrawn') });

    const again = body<{ claim: { id: string; revision: number } }>(await c2.post('/v1/claims', submission(single), { idempotencyKey: 'crash-claims.submit_again' }));
    await run('claims.decide', a, `${base}/claims/requests/${again.claim.id}/decide`, { expectedRevision: again.claim.revision, decision: 'rejected', officerMatch: false, note: 'Synthetic crash test note' },
      audits('claims.rejected', again.claim.id));

    const firstClaim = body<{ claim: { id: string } }>(await c1.post('/v1/claims', submission(contested), { idempotencyKey: 'crash-claims.submit_first' }));
    body(await c2.post('/v1/claims', submission(contested), { idempotencyKey: 'crash-claims.submit_second' }));
    const dispute = await withMaintenance(admin, (trx) => trx.selectFrom('claim_dispute').select(['id', 'revision']).where('company_id', '=', contested).executeTakeFirstOrThrow());
    const proposed = body<{ dispute: { revision: number } }>(await run('claims.dispute_propose', a, `${base}/claims/disputes/${dispute.id}/propose`,
      { expectedRevision: dispute.revision, winnerClaimId: firstClaim.claim.id, note: 'Synthetic crash test proposal' }, audits('claims.dispute_proposed', dispute.id)));
    await run('claims.dispute_confirm', b, `${base}/claims/disputes/${dispute.id}/confirm`, { expectedRevision: proposed.dispute.revision }, audits('claims.dispute_decided', dispute.id));

    // A hand-over as a decision would leave it (the approval path needs screening; tests/claims covers that path).
    const handoverId = await withMaintenance(admin, async (trx) => {
      const claim = await trx.insertInto('company_claim').values({ hub_id: hubId, company_id: held, claimant_id: people.c1, level: 'claimed', recipe_id: recipeId, state: 'approved', domain_tie: 'register_officer_match',
        decided_by: people.a, decided_at: new Date() } as never).returning('id').executeTakeFirstOrThrow();
      return (await trx.insertInto('company_handover').values({ hub_id: hubId, company_id: held, claim_id: claim.id, person_id: people.c1, level: 'claimed', membership_id: null, decided_by: people.a,
        cooling_until: new Date(Date.now() + 7 * 86_400_000) } as never).returning('id').executeTakeFirstOrThrow()).id;
    });
    await run('claims.handover_revoke', b, `${base}/claims/handovers/${handoverId}/revoke`, { revocationReason: 'Synthetic crash test revocation' }, audits('claims.revoked', handoverId));
    await run('claims.settings_set', a, `${base}/claims/settings`, { waitingDays: 5, coolingDays: 6 }, audits('claims.settings_set', hubId));
  },
} satisfies CrashCase;
