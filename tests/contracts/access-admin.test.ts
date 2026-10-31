import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../packages/contracts/src/index.js';

const at = '2026-10-27T10:00:00Z';
const participation: c.ObjectParticipation = {
  id: 'p-1',
  resource: { kind: 'rfq', id: 'rfq-1' },
  party: { kind: 'company', id: 'company-1' },
  side: 'buyer',
  capabilities: ['read.shared', 'read.party_private', 'manage_participants', 'invite'],
  audience: 'party_private',
  validFrom: at,
  validUntil: '2026-12-01T00:00:00Z',
  grantedBy: { personId: 'person-a', onBehalfOf: null },
  revokedAt: null,
  revokedReason: null,
  revision: 1,
  caseRef: null,
};

test('object participation: XOR party, no stored read.public, staff case needs a case ref, validity window', () => {
  assert.ok(c.ObjectParticipationSchema.safeParse(participation).success);
  assert.equal(c.ObjectParticipationSchema.safeParse({ ...participation, party: { kind: 'company', id: 'c', personId: 'p' } }).success, false);
  assert.equal(c.ObjectParticipationSchema.safeParse({ ...participation, capabilities: ['read.public'] }).success, false);
  assert.equal(c.ObjectParticipationSchema.safeParse({ ...participation, capabilities: ['staff.case_read'] }).success, false);
  assert.ok(c.ObjectParticipationSchema.safeParse({ ...participation, side: 'staff', capabilities: ['staff.case_read'], caseRef: 'case-1', audience: 'shared_party' }).success);
  assert.equal(c.ObjectParticipationSchema.safeParse({ ...participation, audience: 'shared' }).success, false, 'research name shared is replaced by shared_party');
  const now = new Date('2026-11-01T00:00:00Z');
  assert.ok(c.participationActive(participation, now));
  assert.equal(c.participationActive(participation, new Date('2026-12-02T00:00:00Z')), false, 'expired at evaluation time');
  assert.equal(c.participationActive({ ...participation, revokedAt: at }, now), false);
  assert.equal(c.participationActive(participation, new Date('invalid')), false);
});
test('grants cannot amplify: capabilities and audience are bounded by the grantor', () => {
  const grantor = { capabilities: participation.capabilities, audience: participation.audience };
  assert.ok(c.canGrant(grantor, { capabilities: ['read.shared'], audience: 'shared_party' }));
  assert.equal(c.canGrant(grantor, { capabilities: ['commit_order'], audience: 'shared_party' }), false);
  assert.equal(c.canGrant(grantor, { capabilities: ['read.shared'], audience: 'owner_private' }), false);
  assert.equal(c.canGrant(grantor, { capabilities: ['staff.case_read'], audience: 'shared_party' }), false);
  assert.equal(c.canGrant({ capabilities: ['read.shared'], audience: 'shared_party' }, { capabilities: ['read.shared'], audience: 'shared_party' }), false, 'needs manage_participants');
});
test('principal and policy decision shapes', () => {
  const principal: c.Principal = {
    personId: 'person-a',
    emailVerified: true,
    authenticatedAt: at,
    authzEpoch: 3,
    membership: { companyId: 'company-1', membershipId: 'm-1', role: 'member', permissions: ['company.deals.manage'], companyAuthzEpoch: 1 },
    staff: [],
    delegation: null,
  };
  assert.ok(c.PrincipalSchema.safeParse(principal).success);
  assert.equal(c.PrincipalSchema.safeParse({ ...principal, membership: [{ companyId: 'c1' }, { companyId: 'c2' }] }).success, false, 'single employer only');
  assert.equal(c.PrincipalSchema.safeParse({ ...principal, staff: ['superuser'] }).success, false);
  assert.ok(c.PolicyDecisionSchema.safeParse({ effect: 'deny', reason: 'no_participation', authzEpoch: 3, evaluatedAt: at, disclose: 'not_found' }).success);
  assert.ok(c.PolicyDecisionSchema.safeParse({ effect: 'allow', projection: 'party_private', side: 'buyer', basis: [{ kind: 'participation', id: 'p-1', revision: 1 }], authzEpoch: 3, evaluatedAt: at }).success);
  assert.equal(c.PolicyDecisionSchema.safeParse({ effect: 'allow', projection: 'party_private', side: 'buyer', basis: [], authzEpoch: 3, evaluatedAt: at }).success, false, 'allow needs a basis');
  assert.ok(
    c.PolicyInputSchema.safeParse({ principal: null, action: 'read.shared', resource: { kind: 'rfq', id: 'rfq-1', ownerParty: { kind: 'company', id: 'c' }, lifecycle: 'published', publishedProjection: true } }).success,
  );
});
test('membership: one active employer, last administrator, transitions', () => {
  const invited: c.Membership = {
    id: 'm-2',
    personId: 'person-a',
    companyId: 'company-2',
    role: 'member',
    permissions: [],
    status: 'invited',
    invitedBy: 'person-b',
    invitedAt: at,
    validFrom: null,
    endedAt: null,
    endedBy: null,
    endedReason: null,
    revision: 1,
  };
  const active: c.Membership = { ...invited, id: 'm-1', companyId: 'company-1', role: 'administrator', status: 'active', validFrom: at };
  assert.ok(c.MembershipSchema.safeParse(active).success);
  assert.equal(c.MembershipSchema.safeParse({ ...active, validFrom: null }).success, false);
  assert.equal(c.MembershipSchema.safeParse({ ...active, status: 'ended' }).success, false, 'ended needs endedAt');
  assert.equal(c.canActivateMembership(invited, [active]), 'membership.already_employed');
  assert.equal(c.canActivateMembership(invited, [{ ...active, status: 'ended', endedAt: at, endedBy: 'person-a' }]), 'ok');
  assert.equal(c.canActivateMembership({ ...invited, status: 'expired' }, []), 'membership.invitation_expired');
  assert.ok(c.wouldRemoveLastAdministrator(active, [active]));
  assert.equal(c.wouldRemoveLastAdministrator(active, [active, { ...active, id: 'm-3', personId: 'person-c' }]), false);
  assert.ok(c.membershipTransitionAllowed('invited', 'active'));
  assert.equal(c.membershipTransitionAllowed('ended', 'active'), false);
  assert.equal(c.membershipTransitionAllowed('declined', 'active'), false);
});
test('case access grant: requester differs from approver, at most 72 hours, always-excluded field classes', () => {
  const grant = {
    id: 'g-1',
    supportCaseId: 'case-1',
    requestedBy: 'person-support',
    approvedBy: 'person-lead',
    approvalDigest: c.computeDigest({ case: 1 }),
    objectSelector: { type: 'rfq', ids: ['rfq-1'] },
    projectionClass: 'diagnostic',
    excludedFieldClasses: ['negotiation_private', 'credentials', 'payment_refs'],
    purpose: 'Investigate missing notification',
    requestedAt: at,
    approvedAt: '2026-10-27T11:00:00Z',
    expiresAt: '2026-10-30T11:00:00Z',
    revokedAt: null,
    revokedBy: null,
    legalExceptionRef: null,
  };
  assert.ok(c.CaseAccessGrantSchema.safeParse(grant).success);
  assert.equal(c.CaseAccessGrantSchema.safeParse({ ...grant, approvedBy: 'person-support' }).success, false);
  assert.equal(c.CaseAccessGrantSchema.safeParse({ ...grant, expiresAt: '2026-10-30T11:00:01Z' }).success, false, '72h + 1s');
  assert.equal(c.CaseAccessGrantSchema.safeParse({ ...grant, expiresAt: at }).success, false, 'expiry before approval');
  assert.equal(c.CaseAccessGrantSchema.safeParse({ ...grant, excludedFieldClasses: ['credentials', 'payment_refs'] }).success, false, 'negotiation_private cannot be included');
  assert.equal(c.CaseAccessGrantSchema.safeParse({ ...grant, projectionClass: 'owner_private' }).success, false);
  const parsed = c.CaseAccessGrantSchema.parse(grant);
  assert.ok(c.caseGrantActive(parsed, new Date('2026-10-28T00:00:00Z')));
  assert.equal(c.caseGrantActive(parsed, new Date('2026-10-31T00:00:00Z')), false);
  assert.equal(c.caseGrantActive({ ...parsed, revokedAt: at }, new Date('2026-10-28T00:00:00Z')), false);
});
test('staff roles, definitions, SoD mode and sensitive assignments', () => {
  const definition = {
    version: 1,
    role: 'support-lead',
    permissions: ['admin.support.grant.approve', 'admin.support.case.close'],
    caps: { creditCapMinorUnits: null, grantMaxHours: 72 },
    sodConflicts: ['support-agent'],
    sodMode: 'reduced',
    releasedAt: at,
    releasedBy: 'person-owner',
  };
  assert.ok(c.StaffRoleDefinitionSchema.safeParse(definition).success);
  assert.equal(c.StaffRoleDefinitionSchema.safeParse({ ...definition, caps: { creditCapMinorUnits: null, grantMaxHours: 96 } }).success, false);
  assert.equal(c.StaffRoleDefinitionSchema.safeParse({ ...definition, permissions: ['admin.everything'] }).success, false);
  assert.equal(c.StaffRoleDefinitionSchema.safeParse({ ...definition, sodMode: 'none' }).success, false);
  const assignment = {
    id: 'a-1',
    personId: 'person-x',
    role: 'editor',
    scope: 'platform',
    definitionVersion: 1,
    validFrom: at,
    validUntil: null,
    grantedBy: 'person-admin',
    approvedBy: null,
    reason: 'Editorial hire',
    revokedAt: null,
    revokedBy: null,
  };
  assert.ok(c.StaffRoleAssignmentSchema.safeParse(assignment).success);
  assert.equal(c.StaffRoleAssignmentSchema.safeParse({ ...assignment, role: 'commercial-admin' }).success, false, 'sensitive role needs a second approver');
  assert.equal(c.StaffRoleAssignmentSchema.safeParse({ ...assignment, role: 'commercial-admin', approvedBy: 'person-admin' }).success, false, 'approver equals grantor');
  assert.ok(c.StaffRoleAssignmentSchema.safeParse({ ...assignment, role: 'commercial-admin', approvedBy: 'person-owner' }).success);
  assert.ok(c.ADMIN_PERMISSIONS.every((p) => /^admin\.[a-z]+(\.[a-z]+)+$/.test(p)));
  for (const action of c.A_PLUS_2_ACTIONS) assert.ok(c.requiresSecondApprover(action, 'reduced') && c.requiresSecondApprover(action, 'full'));
  assert.equal(c.requiresSecondApprover('publications.publish', 'full'), false);
});
test('second-person approval binds the action digest; audit events record approver and digests', () => {
  const digest = c.computeDigest({ priceVersionId: 'price-1' });
  const approval = {
    id: 'ap-1',
    action: 'commerce.activate_price_version',
    actionDigest: digest,
    requestedBy: 'person-commercial',
    approvedBy: 'person-owner',
    approvedAt: at,
    expiresAt: '2026-10-27T12:00:00Z',
    revokedAt: null,
  };
  assert.ok(c.SecondPersonApprovalSchema.safeParse(approval).success);
  assert.equal(c.SecondPersonApprovalSchema.safeParse({ ...approval, approvedBy: 'person-commercial' }).success, false);
  const parsed = c.SecondPersonApprovalSchema.parse(approval);
  const now = new Date('2026-10-27T11:00:00Z');
  assert.ok(c.approvalBindsAction(parsed, 'commerce.activate_price_version', digest, now));
  assert.equal(c.approvalBindsAction(parsed, 'commerce.activate_price_version', c.computeDigest({ priceVersionId: 'price-2' }), now), false);
  assert.equal(c.approvalBindsAction(parsed, 'privacy.execute_erasure', digest, now), false);
  assert.equal(c.approvalBindsAction(parsed, 'commerce.activate_price_version', digest, new Date('2026-10-27T13:00:00Z')), false);
  const event = {
    id: 'e-1',
    sequence: 10,
    occurredAt: at,
    actorPersonId: 'person-commercial',
    actorRole: 'commercial-admin',
    permission: 'admin.commerce.price.activate',
    sessionElevationId: 'elev-1',
    caseId: null,
    secondApproverPersonId: 'person-owner',
    approvalDigest: digest,
    action: 'commerce.activate_price_version',
    objectType: 'price_version',
    objectId: 'price-1',
    objectRevisionBefore: 1,
    objectRevisionAfter: 2,
    beforeDigest: c.computeDigest({ status: 'draft' }),
    afterDigest: c.computeDigest({ status: 'active' }),
    reasonCode: 'scheduled_release',
    reasonText: 'Release approved by owner',
    outcome: 'applied',
    requestId: 'req-1',
    clientFingerprintHash: c.computeDigest('fp').value,
    retentionClass: 'audit_long',
  };
  assert.ok(c.AdminAuditEventSchema.safeParse(event).success);
  assert.equal(c.AdminAuditEventSchema.safeParse({ ...event, secondApproverPersonId: null, approvalDigest: null }).success, false, 'applied A+2 action without approver');
  assert.ok(c.AdminAuditEventSchema.safeParse({ ...event, secondApproverPersonId: null, approvalDigest: null, outcome: 'denied' }).success, 'denied attempts are logged without approver');
  assert.equal(c.AdminAuditEventSchema.safeParse({ ...event, secondApproverPersonId: 'person-commercial' }).success, false, 'self-approval');
  assert.equal(c.AdminAuditEventSchema.safeParse({ ...event, payload: { secret: 1 } }).success, false, 'payloads never enter the audit row');
  assert.ok(c.auditSequenceContinuous([1, 2, 3]));
  assert.equal(c.auditSequenceContinuous([1, 3]), false);
  assert.ok(
    c.AccessLogEntrySchema.safeParse({
      id: 'l-1',
      sequence: 1,
      readAt: at,
      actorPersonId: 'person-support',
      grantId: 'g-1',
      caseRef: { kind: 'support_case', id: 'case-1' },
      kind: 'case_read',
      objectType: 'rfq',
      objectId: 'rfq-1',
      fieldsHash: c.computeDigest(['title']).value,
    }).success,
  );
});
