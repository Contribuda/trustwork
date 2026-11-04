import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import type { CrashCase } from '../cases.js';
import type { Client, Response } from '../../helpers/app.js';
import { count } from '../../hardening/helpers.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';

/** Test role definition over the console vocabulary (version 27, unused elsewhere), held at this case's own hub. */
const VERSION = 27;
const PERMISSIONS = ['admin.claims.read', 'admin.claims.decide', 'admin.claims.policy.edit', 'admin.providers.toggle'];

/**
 * HUB-003: every verification route classified in_transaction, through the BE-005 crash sequence. Steward A registers
 * providers, drafts and activates recipes, records results and takes a provider live under steward B's approval.
 * Every person, hub, company and credential reference is synthetic.
 */
export default {
  name: 'HUB-003: verification providers, recipes and check results',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const hubId = '00000000-0000-4000-8000-00000000c903';
    const seeded = await withMaintenance(admin, async (trx) => {
      await trx.insertInto('hub').values({ id: hubId, slug: `synthetic-verify-${randomBytes(2).toString('hex')}`, lifecycle: 'public' }).execute();
      // The hub is in full mode, so the second person acts through a different role, with the same permissions here.
      for (const role of ['trust-reviewer', 'editor-in-chief'] as const) {
        await trx.insertInto('staff_role_definition_version').values({ role, version: VERSION, scopes: ['hub'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' })
          .onConflict((oc) => oc.doNothing()).execute();
      }
      const founder = await trx.selectFrom('staff_role_assignment').select('person_id').where('setup_bootstrap', '=', true).where('role', '=', 'platform-owner').executeTakeFirstOrThrow();
      const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
      const out = { a: await person('Synthetic Crash Verification Steward A'), b: await person('Synthetic Crash Verification Steward B'), owner: await person('Synthetic Crash Company Administrator') };
      for (const [id, role] of [[out.a, 'trust-reviewer'], [out.b, 'editor-in-chief']] as const) {
        await trx.insertInto('staff_role_assignment').values({ person_id: id, role, scope_kind: 'hub', hub_id: hubId, definition_version: VERSION, granted_by: founder.person_id, reason: 'Synthetic crash test' }).execute();
      }
      const companyId = (await trx.insertInto('company').values({ display_name: 'Synthetic Crash Verification Builders', claim_status: 'unclaimed' } as never).returning('id').executeTakeFirstOrThrow()).id;
      await trx.insertInto('membership').values({ person_id: out.owner, company_id: companyId, role: 'administrator', permissions: ['company.members.manage'], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
      const credentialId = (await trx.insertInto('provider_credential_ref').values({ hub_id: hubId, provider: 'synthetic_register', adapter: 'synthetic_register_api', mode: 'live', secret_store: 'env',
        secret_ref: 'env:SYNTHETIC_CRASH_REGISTER', registered_by: out.a }).returning('id').executeTakeFirstOrThrow()).id;
      return { people: out, companyId, credentialId };
    });
    const { people, companyId, credentialId } = seeded;
    const email = (k: string) => `crash-verification-${k}@example.invalid`;
    await addLogins(h, Object.entries(people).map(([k, id]) => [id, email(k)]));
    const clients = {} as Record<'a' | 'b', Client>;
    for (const key of ['a', 'b'] as const) {
      h.staff.set(people[key], [key === 'a' ? 'trust-reviewer' : 'editor-in-chief']);
      clients[key] = h.client();
      await signIn(clients[key], email(key));
      const secret = await enrolNow(h, clients[key]);
      h.clock.advance(30_000);
      assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
      const elevated = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
      assert.equal(elevated.status, 200, `elevate ${key}: ${JSON.stringify(elevated.body)}`);
      h.clock.reset();
    }
    const { a, b } = clients;
    const owner = h.client();
    await signIn(owner, email('owner'));
    const body = <T>(r: Response): T => { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body)); return r.body as T; };
    const cmd = (action: string, rest: Record<string, unknown>) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
    const run = (action: string, client: Client, url: string, rest: Record<string, unknown>, effects: () => Promise<number>) => exactlyOnce({ action, client, url, body: cmd(action, rest), effects });
    const audits = (action: string, objectId?: string) => () => count(admin, `SELECT 1 FROM trustwork.admin_audit_event WHERE action = $1 AND outcome = 'applied' AND hub_id = $2${objectId ? ' AND object_id = $3' : ''}`, objectId ? [action, hubId, objectId] : [action, hubId]);
    const base = `/v1/admin/hubs/${hubId}/verification`;

    const registered = body<{ provider: { id: string; revision: number } }>(await run('verification.provider_register', a, `${base}/providers`, {
      checkType: 'register_match', adapter: 'synthetic_crash_register', mode: 'manual', retentionDays: 365, legalBasis: 'statutory_public_register', costMinor: null,
    }, () => count(admin, 'SELECT 1 FROM trustwork.verification_provider WHERE hub_id = $1', [hubId])));
    const drafted = body<{ recipe: { id: string; revision: number } }>(await run('verification.recipe_draft', a, `${base}/recipes`, {
      key: 'crash-claim', subjectKind: 'company', trigger: 'claim_verified', recheckMonths: 12, badgeCategories: ['register_record_matches', 'sanctions_screening_clear'],
      steps: [{ check: 'register_match', required: true }, { check: 'sanctions_screening', required: true }],
    }, () => count(admin, 'SELECT 1 FROM trustwork.verification_recipe WHERE hub_id = $1', [hubId])));
    await run('verification.recipe_activate', a, `${base}/recipes/${drafted.recipe.id}/activate`, { expectedRevision: drafted.recipe.revision }, audits('verification.recipe_activated', drafted.recipe.id));
    await run('verification.check_record', a, `${base}/checks`, {
      subject: { kind: 'company', id: companyId }, recipeId: drafted.recipe.id, providerId: registered.provider.id, result: 'pass', evidenceRef: 'register:SYN-CRASH-1',
    }, () => count(admin, "SELECT 1 FROM trustwork.verification_check WHERE hub_id = $1 AND check_type = 'register_match'", [hubId]));
    await run('verification.screening_record', a, `${base}/checks/screening`, { subject: { kind: 'company', id: companyId }, recipeId: drafted.recipe.id },
      () => count(admin, "SELECT 1 FROM trustwork.verification_check WHERE hub_id = $1 AND check_type = 'sanctions_screening'", [hubId]));

    // Live mode: steward A asks, steward B approves the exact digest, steward A takes the provider live.
    const digest = body<{ actionDigest: string }>(await a.get(`${base}/providers/${registered.provider.id}/live-digest?credentialRefId=${credentialId}`)).actionDigest;
    const requested = body<{ approval: { id: string } }>(await a.post('/v1/admin/approvals', { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: 'crash-verification-approval',
      reason: 'Synthetic crash test', subject: { action: 'providers.enable_non_fake', scope: { kind: 'hub', hubId }, actionDigest: digest } }, { idempotencyKey: 'crash-verification-approval' }));
    body(await b.post(`/v1/admin/approvals/${requested.approval.id}/approve`, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: 'crash-verification-approve', reason: 'Synthetic crash test',
      actionDigest: digest }, { idempotencyKey: 'crash-verification-approve' }));
    await run('verification.provider_live', a, `${base}/providers/${registered.provider.id}/live`, { expectedRevision: registered.provider.revision, credentialRefId: credentialId, approvalId: requested.approval.id },
      audits('verification.provider_live', registered.provider.id));

    // An adverse result recorded by A; the company's administrator appeals; B (not the recorder) decides.
    const manual = body<{ provider: { id: string } }>(await a.post(`${base}/providers`, cmd('verification.provider_register_tax', { checkType: 'tax_status', adapter: 'synthetic_crash_tax',
      mode: 'manual', retentionDays: 365, legalBasis: 'statutory_public_register', costMinor: null }), { idempotencyKey: 'crash-verification.provider_register_tax' }));
    const taxRecipe = body<{ recipe: { id: string; revision: number } }>(await a.post(`${base}/recipes`, cmd('verification.recipe_draft_tax', { key: 'crash-tax', subjectKind: 'company',
      trigger: 'seller_onboarding', recheckMonths: 12, badgeCategories: ['tax_status_current'], steps: [{ check: 'tax_status', required: true }, { check: 'sanctions_screening', required: true }] }),
      { idempotencyKey: 'crash-verification.recipe_draft_tax' }));
    body(await a.post(`${base}/recipes/${taxRecipe.recipe.id}/activate`, cmd('verification.recipe_activate_tax', { expectedRevision: taxRecipe.recipe.revision }), { idempotencyKey: 'crash-verification.recipe_activate_tax' }));
    const adverse = body<{ check: { id: string } }>(await a.post(`${base}/checks`, cmd('verification.check_record_tax', { subject: { kind: 'company', id: companyId }, recipeId: taxRecipe.recipe.id,
      providerId: manual.provider.id, result: 'fail', evidenceRef: 'tax:SYN-CRASH-9' }), { idempotencyKey: 'crash-verification.check_record_tax' }));
    const appeal = body<{ appeal: { id: string; revision: number } }>(await exactlyOnce({ action: 'verification.appeal_file', client: owner, url: `/v1/verification/checks/${adverse.check.id}/appeals`,
      body: { reason: 'The tax registration was renewed last week.' }, effects: () => count(admin, 'SELECT 1 FROM trustwork.verification_appeal WHERE check_id = $1', [adverse.check.id]) }));
    await run('verification.appeal_decide', b, `${base}/appeals/${appeal.appeal.id}/decide`, { expectedRevision: appeal.appeal.revision, decision: 'overturned', note: 'Renewal confirmed.',
      evidenceRef: 'tax:SYN-CRASH-10' }, audits('verification.appeal_overturned', appeal.appeal.id));
  },
} satisfies CrashCase;
