import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { consentFixture } from '../../../hubs/jurisdiction/consent-fixture.js';
import { sharedAuthorityFixture } from '../../../hubs/jurisdiction/shared-fixture.js';
import { jurisdictionEvidence } from '../../../../packages/data/src/repositories/jurisdiction-policy.js';
import type { CrashCase } from '../cases.js';

export default {
  name: 'HUB-005: exact consent, revocation and reviewed applicability commit atomically',
  async run({ h, exactlyOnce }) {
    const f = await consentFixture(h.db.admin, h.pool, await sharedAuthorityFixture(h.db.admin, h.pool));
    await f.publishLegal();
    const clients = { moderator: h.client(), owner: h.client(), officer: h.client() };
    for (const key of ['moderator', 'owner', 'officer'] as const) {
      const token = randomBytes(32).toString('base64url');
      await h.db.admin.query('UPDATE trustwork.session SET token_hash=$1 WHERE id=$2', [createHash('sha256').update(token).digest(), f.world.sessions[key]]);
      clients[key].setSessionCookie(token);
      if (key !== 'moderator') { h.staff.set(f.p[key], [key === 'owner' ? 'hub-owner' : 'compliance-officer']); await f.a.elevate(f.p[key]); }
    }
    const count = (table: string) => async () => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int n FROM trustwork.${table}`)).rows[0]!.n;
    const url = `/v1/jurisdiction-consents/quotes/${f.quoteId}`;
    const preview = await clients.moderator.get(url); assert.equal(preview.status, 200);
    const noticeDigest = (preview.body as { notices: { noticeDigest: string }[] }).notices[0]!.noticeDigest;
    const consent = await exactlyOnce({ action: 'jurisdiction.consent_grant', client: clients.moderator, url, body: { noticeDigest, locale: 'en' }, effects: count('jurisdiction_consent_receipt') });
    await exactlyOnce({ action: 'jurisdiction.consent_revoke', client: clients.moderator, url: `/v1/jurisdiction-consents/${(consent.body as { receiptId: string }).receiptId}/revoke`, body: {}, effects: count('jurisdiction_consent_revocation') });
    const evidence = await withMaintenance(h.db.admin, trx => jurisdictionEvidence.stageApplicability(trx, {
      subjectKind: 'person', subjectId: f.p.outsider, hubId: f.hubId, jurisdictions: ['US'], evidenceId: 'synthetic.crashEvidence', evidenceDigest: 'e'.repeat(64),
      effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveUntil: '2099-01-01T00:00:00.000Z',
    }));
    const body = { evidenceDigest: evidence.digest, reason: 'Synthetic crash review' };
    const proposal = await exactlyOnce({ action: 'jurisdiction.applicability_propose', client: clients.owner, url: `/v1/admin/jurisdiction-applicability/evidence/${evidence.id}/review`, body, effects: count('jurisdiction_applicability_review') });
    await exactlyOnce({ action: 'jurisdiction.applicability_activate', client: clients.officer, url: `/v1/admin/jurisdiction-applicability/reviews/${(proposal.body as { reviewId: string }).reviewId}/activate`, body, effects: count('jurisdiction_applicability_activation') });
  },
} satisfies CrashCase;
