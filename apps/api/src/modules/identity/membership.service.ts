import { sql } from 'kysely';
import { InvitationPreviewSchema, toPublicCompany, wouldRemoveLastAdministrator, type Company, type InvitationPreview, type Membership, type Principal, type PublicCompany } from '../../deps/contracts.js';
import { auditEvents, auth, companies, mailLocales, memberships, outbox, preIdentity, type Transaction } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from './context.js';
import type { PrincipalService } from './principal.service.js';
import { daysOf } from './mail.js';
import { toCompany, toMembership } from './serializers.js';
import { randomToken, sha256Hex } from './tokens.js';

type MembershipRoleValue = Membership['role'];
type MembershipPermissions = Membership['permissions'];

/**
 * Company membership flows per DATA-001 hardening: invitations from a member manager, acceptance by the invitee with
 * mailbox proof, role changes, and membership end running the full revocation sequence (owner-run command) plus the
 * mandate placeholder hook. The e-mail of an invitee must belong to a verified account; responses do not reveal it.
 */
export class MembershipService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService) {}

  async publicCompany(id: string): Promise<PublicCompany> {
    const row = await withoutPrincipal(this.ctx.pool, (trx) => companies.getById(trx, id));
    if (!row) throw new ApiError('access.not_found');
    return toPublicCompany(toCompany(row, null));
  }

  /** Member view: public fields plus the private row for active members (R28: own company only). */
  async company(id: string, state: RequestState): Promise<{ company: PublicCompany; privateView: Pick<Company, 'internalNotes' | 'billingAccountId' | 'verifiedDomains'> | null; membership: Membership | null }> {
    if (!state.principal) return { company: await this.publicCompany(id), privateView: null, membership: null };
    return this.principals.runAs(state, async (trx, principal) => {
      const row = await companies.getById(trx, id);
      if (!row) throw new ApiError('access.not_found');
      const member = principal.membership?.companyId === id;
      const priv = member ? await companies.getPrivate(trx, id) : undefined;
      const full = toCompany(row, priv ?? null);
      const own = member ? await memberships.getById(trx, principal.membership?.membershipId as string) : undefined;
      return {
        company: toPublicCompany(full),
        // billingAccountId is a billing setting: visible only with company.billing.manage (or .view).
        privateView: member ? { internalNotes: full.internalNotes, billingAccountId: principal.membership?.permissions.some((p) => p === 'company.billing.manage' || p === 'company.billing.view') ? full.billingAccountId : null, verifiedDomains: full.verifiedDomains } : null,
        membership: own ? toMembership(own) : null,
      };
    });
  }

  private requireMember(principal: Principal, companyId: string): NonNullable<Principal['membership']> {
    if (!principal.membership || principal.membership.companyId !== companyId) throw new ApiError('access.not_found');
    return principal.membership;
  }

  async list(companyId: string, state: RequestState): Promise<{ items: Membership[] }> {
    return this.principals.runAs(state, async (trx, principal) => {
      this.requireMember(principal, companyId);
      return { items: (await memberships.listForCompany(trx, companyId)).map(toMembership) };
    });
  }

  /**
   * Identical acknowledgement whether or not the address belongs to a verified account. The mail is written in the
   * invitee's recorded language (their last own sign-in or verification), else the inviter's chosen language (the
   * request's languages), else the hub default (QA-002 D5); the worker picks the first language the hub serves.
   */
  async invite(companyId: string, input: { companyId: string; inviteeEmail: string; role: MembershipRoleValue; permissions: MembershipPermissions }, state: RequestState, inviterLocales: readonly string[] = []): Promise<{ status: 'invited' }> {
    if (input.companyId !== companyId) throw new ApiError('validation.schema', 'companyId does not match the route');
    const principal = state.principal as Principal;
    const membership = this.requireMember(principal, companyId);
    if (!membership.permissions.includes('company.members.manage')) throw new ApiError('membership.permission_missing');
    if (!principal.emailVerified) throw new ApiError('auth.email_unverified');
    const token = randomToken();
    const expiresAt = new Date(this.ctx.clock.now().getTime() + this.ctx.config.tokens.invitationMs);
    const inviteeId = await auth.issueToken(this.ctx.pool, {
      emailNormalized: input.inviteeEmail, kind: 'membership_invitation', tokenHashHex: sha256Hex(token), expiresAt, requireVerified: true,
    });
    if (inviteeId && inviteeId !== principal.personId) {
      await this.principals.runAs(state, async (trx, p) => {
        const existing = (await memberships.listForCompany(trx, companyId)).find((m) => m.person_id === inviteeId && (m.status === 'invited' || m.status === 'active'));
        if (existing?.status === 'active') return;
        // A pending invitation is re-sent with a fresh mailbox proof instead of a duplicate row.
        let row = existing;
        if (!row) {
          row = await memberships.invite(trx, { person_id: inviteeId, company_id: companyId, role: input.role, permissions: input.permissions, invited_by: p.personId });
          await auditEvents.append(trx, { actor_person_id: p.personId, on_behalf_of_company_id: companyId, action: 'membership.invited', object_kind: 'membership', object_id: row.id, request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { role: input.role, permissions: input.permissions } });
          await outbox.append(trx, { aggregate_kind: 'membership', aggregate_id: row.id, revision: row.revision, type: 'membership.invited', payload: { companyId } });
        }
        const company = await companies.getById(trx, companyId);
        const inviteeLocale = await mailLocales.forMail(trx, inviteeId);
        await this.ctx.mail.record(trx, {
          to: input.inviteeEmail, template: 'membership_invitation',
          params: { membershipId: row.id, companyId, company: company?.display_name ?? '', days: daysOf(this.ctx.config.tokens.invitationMs) },
          secret: { token, expiresAt },
          locales: [...new Set([...(inviteeLocale ? [inviteeLocale] : []), ...inviterLocales])].slice(0, 6),
        });
      });
    }
    return { status: 'invited' };
  }

  async accept(companyId: string, input: { membershipId: string; invitationToken: string }, state: RequestState): Promise<Membership> {
    return this.acceptInvitation(companyId, input, state);
  }

  /**
   * The mailed link (`/invitations/<membershipId>/<token>`, QA-002 D1): the company comes from the membership itself, so
   * the link needs no company id. The same checks as `accept`: single use, expiry, and only the invited person.
   */
  async acceptLink(input: { membershipId: string; invitationToken: string }, state: RequestState): Promise<Membership> {
    return this.acceptInvitation(null, input, state);
  }

  /**
   * What the invitation page shows before the invitee accepts: the company's public name and the offered role. It
   * checks the mailbox proof exactly as accepting would (valid, unexpired, unused, the signed-in person's own, for an
   * invited membership) inside a savepoint that is always rolled back, so previewing never spends the proof. Every
   * failure is the same not found as a wrong token, so nothing about other people's invitations leaks.
   */
  async previewLink(input: { membershipId: string; invitationToken: string }, state: RequestState): Promise<InvitationPreview> {
    const principal = state.principal as Principal;
    if (!principal.emailVerified) throw new ApiError('auth.email_unverified');
    return this.principals.runAs(state, async (trx, p) => {
      await sql`SAVEPOINT invitation_preview`.execute(trx);
      try {
        const row = await this.checkInvitation(trx, p, null, input);
        const company = await companies.getById(trx, row.company_id);
        return InvitationPreviewSchema.parse({ membershipId: row.id, company: { id: row.company_id, name: company?.display_name ?? '' }, role: row.role });
      } finally {
        await sql`ROLLBACK TO SAVEPOINT invitation_preview`.execute(trx);
      }
    });
  }

  /** Consumes the mailbox proof and returns the invited membership of the signed-in person, or refuses. */
  private async checkInvitation(trx: Transaction, p: Principal, companyId: string | null, input: { membershipId: string; invitationToken: string }) {
    const consumed = await preIdentity.consumeToken(trx, sha256Hex(input.invitationToken), 'membership_invitation');
    if (!consumed || consumed.person_id !== p.personId) throw new ApiError('access.not_found', 'invitation is invalid or expired');
    const row = await memberships.getById(trx, input.membershipId);
    if (!row || row.person_id !== p.personId || (companyId !== null && row.company_id !== companyId)) throw new ApiError('access.not_found');
    if (row.status !== 'invited') throw new ApiError('membership.invitation_expired');
    return row;
  }

  private async acceptInvitation(companyId: string | null, input: { membershipId: string; invitationToken: string }, state: RequestState): Promise<Membership> {
    const principal = state.principal as Principal;
    if (!principal.emailVerified) throw new ApiError('auth.email_unverified');
    return this.principals.runAs(state, async (trx, p) => {
      // The mailbox proof is consumed in the same transaction as the activation (and its idempotency completion), so a
      // crash before COMMIT leaves the invitation usable for the retry instead of burning it without an effect.
      const row = await this.checkInvitation(trx, p, companyId, input);
      const activated = await memberships.activate(trx, row.id, row.revision, this.ctx.clock.now());
      if (!activated) throw new ApiError('validation.revision_conflict');
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'membership.activated', object_kind: 'membership', object_id: row.id, request_id: state.requestId, authz_epoch: p.authzEpoch });
      await outbox.append(trx, { aggregate_kind: 'membership', aggregate_id: row.id, revision: activated.revision, type: 'membership.activated', payload: { companyId: row.company_id } });
      return toMembership(activated);
    });
  }

  async change(companyId: string, input: { membershipId: string; role: MembershipRoleValue; permissions: MembershipPermissions; expectedRevision: number }, state: RequestState): Promise<Membership> {
    const principal = state.principal as Principal;
    const membership = this.requireMember(principal, companyId);
    if (!membership.permissions.includes('company.members.manage')) throw new ApiError('membership.permission_missing');
    return this.principals.runAs(state, async (trx, p) => {
      const rows = await memberships.listForCompany(trx, companyId);
      const target = rows.find((m) => m.id === input.membershipId);
      if (!target) throw new ApiError('access.not_found');
      if (target.person_id === p.personId) throw new ApiError('access.forbidden', 'own role and permissions are changed by a colleague', { reason: 'self_promotion' });
      if (target.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (input.role !== 'administrator' && wouldRemoveLastAdministrator(toMembership(target), rows.map(toMembership))) throw new ApiError('membership.last_administrator');
      const changed = await memberships.changeRole(trx, target.id, input.expectedRevision, input.role, input.permissions);
      if (!changed) throw new ApiError('validation.revision_conflict');
      await auditEvents.append(trx, { actor_person_id: p.personId, on_behalf_of_company_id: companyId, action: 'membership.changed', object_kind: 'membership', object_id: target.id, request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { before: { role: target.role, permissions: target.permissions }, after: { role: input.role, permissions: input.permissions } } });
      await outbox.append(trx, { aggregate_kind: 'membership', aggregate_id: target.id, revision: changed.revision, type: 'membership.changed', payload: { companyId } });
      return toMembership(changed);
    });
  }

  /** Self or member manager; the database runs the revocation sequence atomically; mandates hook is called in the same request. */
  async end(companyId: string, input: { membershipId: string; reason: string; expectedRevision: number }, state: RequestState): Promise<{ membership: Membership; revokedParticipations: number; revokedGrants: number; admissionEpoch: string }> {
    return this.principals.runAs(state, async (trx, p) => {
      const target = await memberships.getById(trx, input.membershipId);
      if (!target || target.company_id !== companyId) throw new ApiError('access.not_found');
      if (target.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const self = target.person_id === p.personId;
      if (!self && !(p.membership?.companyId === companyId && p.membership.permissions.includes('company.members.manage'))) throw new ApiError('membership.permission_missing');
      const ended = await memberships.endWithRevocation(trx, target.id, input.reason);
      await this.ctx.mandates.revokeForPerson(ended.person_id, ended.company_id, `membership ${ended.membership_id} ended`);
      await auditEvents.append(trx, {
        actor_person_id: p.personId, on_behalf_of_company_id: self ? null : companyId, action: 'membership.ended', object_kind: 'membership', object_id: target.id,
        request_id: state.requestId, authz_epoch: p.authzEpoch, reason: input.reason, basis: { revokedParticipations: ended.revoked_participations, revokedGrants: ended.revoked_grants, admissionEpoch: ended.admission_epoch },
      });
      await outbox.append(trx, { aggregate_kind: 'membership', aggregate_id: target.id, revision: ended.revision, type: 'membership.ended', payload: { companyId, personId: ended.person_id, admissionEpoch: ended.admission_epoch } });
      await outbox.append(trx, { aggregate_kind: 'person', aggregate_id: ended.person_id, revision: 1, type: 'authz.epoch_bumped', payload: { companyId } });
      const after = await memberships.getById(trx, target.id);
      return { membership: toMembership(after ?? { ...target, status: 'ended', ended_at: this.ctx.clock.now(), ended_by: p.personId, ended_reason: input.reason, revision: ended.revision }), revokedParticipations: ended.revoked_participations, revokedGrants: ended.revoked_grants, admissionEpoch: ended.admission_epoch };
    });
  }
}
