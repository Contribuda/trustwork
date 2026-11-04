import { StaffInvitationViewSchema, type StaffInvitationView } from '../../../../../../../packages/contracts/src/staff-lifecycle.js';
import { HUB_US_ID } from '../../../_fixtures/ids.js';

/**
 * Staff invitations of the US demo hub (HC-150, fixtures only): one of each state the screen explains, so the demo shows
 * the whole path. Addresses use the reserved `.invalid` domain and nobody here is real. `rq-role-compliance` is the
 * pending second-person request of the approvals fixtures. Times are relative to the fixture clock (2026-10-31 12:00 UTC).
 */
const hub = { kind: 'hub' as const, hubId: HUB_US_ID };
const base = {
  scope: hub, definitionVersion: 1, validForSeconds: null, sensitive: false, status: 'pending' as const, expired: false, personId: null, invitedBy: 'p-staff-admin',
  reason: 'Synthetic invitation for the demo', expiresAt: '2026-11-05T09:00:00Z', respondedAt: null, approvalId: null, assignmentId: null, revision: 1,
};

export const STAFF_INVITATIONS: readonly StaffInvitationView[] = [
  { ...base, id: 'inv-waiting', email: 'new-editor@example.invalid', role: 'editor', reason: 'A second editor for the hub news' },
  { ...base, id: 'inv-accepted', email: 'new-moderator@example.invalid', role: 'moderator', status: 'accepted', personId: 'p-invited-moderator', validForSeconds: 90 * 86_400,
    respondedAt: '2026-10-30T15:00:00Z', revision: 2, reason: 'Moderation cover for the autumn' },
  { ...base, id: 'inv-sensitive', email: 'new-owner@example.invalid', role: 'hub-owner', sensitive: true, status: 'accepted', personId: 'p-invited-owner',
    respondedAt: '2026-10-30T16:00:00Z', revision: 2, reason: 'A second hub owner' },
  { ...base, id: 'inv-second-person', email: 'second-compliance@example.invalid', role: 'compliance-officer', sensitive: true, status: 'accepted', personId: 'p-invited-compliance', invitedBy: 'p-hub-owner',
    respondedAt: '2026-10-30T17:00:00Z', approvalId: 'rq-role-compliance', revision: 3, reason: 'A second compliance officer' },
  { ...base, id: 'inv-expired', email: 'late-reply@example.invalid', role: 'editor', expired: true, expiresAt: '2026-10-29T09:00:00Z', reason: 'Nobody answered in time' },
  { ...base, id: 'inv-declined', email: 'said-no@example.invalid', role: 'moderator', status: 'declined', personId: 'p-invited-declined', respondedAt: '2026-10-28T10:00:00Z', revision: 2, reason: 'Asked, and the person said no' },
].map((i) => StaffInvitationViewSchema.parse(i));
