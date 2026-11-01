import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { privacyWorld } from '../../../privacy/helpers.js';
import type { CrashCase, CrashContext } from '../cases.js';
import type { Harness } from '../../helpers/app.js';
import { privacySourceFixture } from '../../../privacy/source-fixture.js';
import { sourceResolutionFixture } from '../../../privacy/source-resolution-fixture.js';
import { privacyPlanFixture } from '../../../privacy/plan-fixture.js';

export async function privacyCrashRoutes(h: Harness, exactlyOnce: CrashContext['exactlyOnce'], world: Awaited<ReturnType<typeof privacyWorld>>) {
  const count = async (table: string, condition = 'true') => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM trustwork.${table} WHERE ${condition}`)).rows[0]!.n;
  const subject = { kind: 'person', id: world.people.subject };
  const requested = await exactlyOnce({ action: 'privacy.request_create', client: world.subject, url: '/v1/privacy/requests', body: { subject, country: 'US', kind: 'erasure' }, effects: () => count('privacy_request') });
  const id = (requested.body as { id: string }).id;
  assert.ok(id);
  await exactlyOnce({ action: 'privacy.preference_set', client: world.subject, url: '/v1/privacy/preferences', body: {
    optOutSale: true, optOutSharing: true, limitSensitive: true, directMarketingObjection: true, gpc: true,
  }, effects: () => count('privacy_preference') });
  await exactlyOnce({ action: 'privacy.export_create', client: world.subject, url: '/v1/privacy/exports', body: { subject }, effects: () => count('privacy_export') });
  const held = await exactlyOnce({ action: 'privacy.hold_place', client: world.officer, url: '/v1/admin/privacy/holds',
    body: { requestId: id, reasonCode: 'litigation', evidenceRef: randomUUID() }, effects: () => count('legal_hold') });
  await exactlyOnce({ action: 'privacy.hold_release', client: world.officer, url: `/v1/admin/privacy/holds/${(held.body as { id: string }).id}/release`,
    body: { reasonCode: 'hold_resolved' }, effects: () => count('legal_hold', 'released_at IS NOT NULL') });
  const source = await privacySourceFixture(h, world);
  await exactlyOnce({ action: 'privacy.external_source_case', client: world.officer, url: '/v1/admin/privacy/external-source-cases', body: source.intake, effects: () => count('support_external_source_subject') });
  await exactlyOnce({ action: 'privacy.source_proof', client: world.officer, url: '/v1/admin/privacy/source-proofs', body: source.body, effects: () => count('privacy_source_proof') });
  await h.db.admin.query("INSERT INTO trustwork.privacy_country_policy(country,version,review,sources,deadline_days,retention_days) VALUES('ZZ','synthetic-source-crash','verified','[\"https://example.invalid/synthetic-policy\"]',3,0) ON CONFLICT(country) DO UPDATE SET review='verified',retention_days=0");
  const sourceResolution = await sourceResolutionFixture(h, world);
  const sourcePlanResponse = await exactlyOnce({ action: 'privacy.source_plan_propose', client: world.officer, url: '/v1/admin/privacy/source-plans',
    body: { requestId: sourceResolution.request.id, grantId: sourceResolution.grant.id }, effects: () => count('privacy_source_plan') });
  const sourcePlan = sourcePlanResponse.body as { id: string; digest: string };
  await exactlyOnce({ action: 'privacy.source_plan_approve', client: world.reviewer, url: `/v1/admin/privacy/source-plans/${sourcePlan.id}/approve`,
    body: { grantId: sourceResolution.second.id, digest: sourcePlan.digest }, effects: () => count('privacy_source_plan', "state='approved'") });
  await exactlyOnce({ action: 'privacy.source_plan_execute', client: world.officer, url: `/v1/admin/privacy/source-plans/${sourcePlan.id}/execute`,
    body: { digest: sourcePlan.digest }, effects: () => count('source_field_resolution') });
  const planFixture = await privacyPlanFixture(h, world);
  const proposed = await exactlyOnce({ action: 'privacy.plan_propose', client: world.officer, url: '/v1/admin/privacy/plans', body: { requestId: planFixture.request.id, grantId: planFixture.first.id }, effects: () => count('privacy_subject_plan') });
  const plan = proposed.body as { id: string; digest: string };
  await exactlyOnce({ action: 'privacy.plan_approve', client: world.reviewer, url: `/v1/admin/privacy/plans/${plan.id}/approve`, body: { grantId: planFixture.second.id, digest: plan.digest }, effects: () => count('privacy_subject_plan', "state='approved'") });
  await exactlyOnce({ action: 'privacy.plan_execute', client: world.officer, url: `/v1/admin/privacy/plans/${plan.id}/execute`, body: { digest: plan.digest }, effects: () => count('privacy_subject_plan', "state='blocked'") });
}
export default {
  name: 'PRV-001: requests, preferences, exports and audited holds',
  async run({ h, exactlyOnce }) { await privacyCrashRoutes(h, exactlyOnce, await privacyWorld(h)); },
} satisfies CrashCase;
