import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { privacyWorld } from '../../../privacy/helpers.js';
import type { CrashCase, CrashContext } from '../cases.js';
import type { Harness } from '../../helpers/app.js';

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
}
export default {
  name: 'PRV-001: requests, preferences, exports and audited holds',
  async run({ h, exactlyOnce }) { await privacyCrashRoutes(h, exactlyOnce, await privacyWorld(h)); },
} satisfies CrashCase;
