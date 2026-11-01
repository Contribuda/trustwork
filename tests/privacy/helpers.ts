import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import type { Harness } from '../backend/helpers/app.js';
import { buildAdminWorld } from '../data/admin/helpers.js';
import { principalFor } from '../data/helpers/seed.js';
import { addLogins, enrolNow, signIn } from '../admin/helpers.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { adminDigests, approvals, staffAssignments, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../packages/data/src/repositories/identity.js';

export async function privacyWorld(h: Harness) {
  const founders = async () => (await h.db.admin.query<{ person_id: string; role: string }>("SELECT person_id, role FROM trustwork.staff_role_assignment WHERE setup_bootstrap AND revoked_at IS NULL AND role IN ('platform-owner','staff-admin')")).rows;
  if ((await founders()).length === 0) await buildAdminWorld(h.db.admin);
  const rows = await founders();
  const owner = rows.find((r) => r.role === 'platform-owner')!.person_id;
  const admin = rows.find((r) => r.role === 'staff-admin')!.person_id;
  const as = async <T>(id: string, fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(h.pool, await principalFor(h.db.admin, id), fn);
  const context = async (id: string) => {
    const session = await withMaintenance(h.db.admin, (trx) => trx.insertInto('session').values({ person_id: id, token_hash: randomBytes(32),
      idle_expires_at: new Date(Date.now() + 3_600_000), absolute_expires_at: new Date(Date.now() + 3_600_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
    const elevation = await as(id, (trx) => sessionElevations.insert(trx, { personId: id, sessionId: session.id, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 900_000) }));
    return { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic privacy fixture' };
  };
  const people = await withMaintenance(h.db.admin, async (trx) => {
    await staffRoleDefinitions.release(trx, { version: 137, role: 'privacy-officer', scopes: ['platform'],
      permissions: ['admin.privacy.hold', 'admin.privacy.erasure.execute', 'admin.privacy.request.read', 'admin.privacy.export',
        'admin.support.case.create', 'admin.support.grant.request', 'admin.support.grant.approve', 'admin.sources.manage', 'admin.sources.import.activate'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 24 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    const officer = await trx.insertInto('person').values({ display_name: 'Synthetic Privacy Officer' }).returning('id').executeTakeFirstOrThrow();
    const subject = await trx.insertInto('person').values({ display_name: 'Synthetic Privacy Subject' }).returning('id').executeTakeFirstOrThrow();
    const reviewer = await trx.insertInto('person').values({ display_name: 'Synthetic Second Privacy Officer' }).returning('id').executeTakeFirstOrThrow();
    return { officer: officer.id, subject: subject.id, reviewer: reviewer.id };
  });
  const ownerCtx = await context(owner); const adminCtx = await context(admin);
  const scope = { kind: 'platform' as const };
  const digest = adminDigests.assignment({ personId: people.officer, role: 'privacy-officer', scope, definitionVersion: 137, breakglass: false });
  const approval = await as(owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope, actionDigest: digest }));
  await as(admin, (trx) => approvals.decide(trx, adminCtx, approval.id, 'approve', digest));
  await as(owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: people.officer, role: 'privacy-officer', scope, definitionVersion: 137, approvalId: approval.id }));
  const reviewerDigest = adminDigests.assignment({ personId: people.reviewer, role: 'privacy-officer', scope, definitionVersion: 137, breakglass: false });
  const reviewerApproval = await as(owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope, actionDigest: reviewerDigest }));
  await as(admin, (trx) => approvals.decide(trx, adminCtx, reviewerApproval.id, 'approve', reviewerDigest));
  await as(owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId: people.reviewer, role: 'privacy-officer', scope, definitionVersion: 137, approvalId: reviewerApproval.id }));
  h.staff.set(people.officer, ['privacy-officer']);
  h.staff.set(people.reviewer, ['privacy-officer']);
  const email = (id: string) => `synthetic-${id}@example.invalid`;
  await addLogins(h, [[people.officer, email(people.officer)], [people.subject, email(people.subject)], [people.reviewer, email(people.reviewer)]]);
  const officer = h.client(); const subject = h.client(); const reviewer = h.client();
  await signIn(officer, email(people.officer)); await signIn(subject, email(people.subject)); await signIn(reviewer, email(people.reviewer));
  const secret = await enrolNow(h, officer);
  h.clock.advance(30_000);
  const elevated = await officer.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
  assert.equal(elevated.status, 200, JSON.stringify(elevated.body)); h.clock.reset();
  const reviewerSecret = await enrolNow(h, reviewer);
  h.clock.advance(30_000);
  const reviewerElevated = await reviewer.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, reviewerSecret) } }, { idempotencyKey: null });
  assert.equal(reviewerElevated.status, 200, JSON.stringify(reviewerElevated.body)); h.clock.reset();
  return { people, officer, reviewer, subject, as, context };
}
