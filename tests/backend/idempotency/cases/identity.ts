import assert from 'node:assert/strict';
import { EMAILS } from '../../helpers/personas.js';
import type { CrashCase } from '../cases.js';

/**
 * QA-002 D1: the mailed invitation link accepts without a company id (`POST /v1/invitations/accept`). The mailbox proof
 * is consumed in the activation's transaction, so the crash sequence must activate the membership exactly once. Petr
 * is free again after the core memberships case ended his membership; the case ends the new one to leave him free.
 */
export default {
  name: 'QA-002 D1: invitation link accept',
  async run({ h, seed, as, exactlyOnce }) {
    const carl = await as('carl');
    const petr = await as('petr');
    const company = seed.companies.unrelated;
    const invite = await carl.post(`/v1/companies/${company}/memberships`, { companyId: company, inviteeEmail: EMAILS.petr, role: 'member', permissions: [] });
    assert.equal(invite.status, 202, JSON.stringify(invite.body));
    const mail = (await h.mail.lastTo(EMAILS.petr, 'membership_invitation'))!;
    const membershipId = mail.params.membershipId as string;
    const activated = async () => (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action = 'membership.activated' AND object_id = $1", [membershipId])).rows[0]?.n ?? 0;
    const accepted = await exactlyOnce({
      action: 'membership.accept_link', client: petr, url: '/v1/invitations/accept', body: { membershipId, invitationToken: mail.params.token as string },
      effects: activated,
    });
    const membership = accepted.body as { id: string; revision: number; status: string };
    assert.equal(membership.status, 'active');
    const ended = await carl.post(`/v1/companies/${company}/memberships/end`, { membershipId: membership.id, reason: 'crash test cleanup', expectedRevision: membership.revision });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
  },
} satisfies CrashCase;
