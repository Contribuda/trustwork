import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { CommandContext, StaffTarget } from './admin.js';
import type { StaffRoleAssignmentRow } from '../schema/admin.js';
import type {
  MyStaffInvitationRow, StaffAccessReviewCampaignRow, StaffAccessReviewItemRow, StaffAccountabilityOfferRow, StaffAccountabilityReadRow, StaffAccountabilityRow, StaffActivationJoinedRow,
  StaffActivationRow, StaffDirectoryRow, StaffEligibleRoleRow, StaffInvitationRow, StaffOffboardingRow,
} from '../schema/staff-lifecycle.js';
import '../schema/staff-lifecycle.js';

/**
 * Staff lifecycle and access governance (ADM-004, migration packages/data/migrations/staff-lifecycle; contract
 * packages/contracts/src/staff-lifecycle.ts).
 *
 * - **Reads** under `withPrincipal`: the staff directory of a hub (names for every staff member covering it; roles and
 *   second-factor state only with `admin.staff.read`), one person's active assignments covering the hub for the
 *   effective-access query, the invitations of a scope (row-level security: `admin.staff.read`), and the invitee's own
 *   open invitations. The directory reads answer "not found" (`admin.not_found`) to anyone who is not staff of the hub.
 * - **Commands**: invite (`admin.staff.assign`, elevated), respond (the invitee, by a verified address, with a second
 *   factor to accept), apply (the inviter, elevated; a sensitive role asks a second person first) and withdraw.
 * - **Eligible roles** (part 3): grant and revoke an eligibility (`admin.staff.assign` / `admin.staff.revoke`); the
 *   eligible person requests an activation with a fresh second factor (a non-sensitive role is active at once, a
 *   sensitive one asks a second person), a second person decides, the holder or `admin.staff.revoke` ends it early.
 *   The activation is an ordinary ADM-001 assignment with an end; nothing runs when the window ends.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);
const scopeArgs = (scope: StaffTarget) => ({
  kind: scope.kind, node: scope.kind === 'node' ? scope.nodeId : null, hub: scope.kind === 'hub' ? scope.hubId : null,
});

export const staffLifecycle = {
  async directory(trx: Transaction, hubId: string): Promise<StaffDirectoryRow[]> {
    const { rows } = await sql<StaffDirectoryRow>`SELECT * FROM trustwork.staff_directory(${hubId}::uuid)`.execute(trx);
    return rows;
  },
  async effectiveAssignments(trx: Transaction, hubId: string, personId: string): Promise<StaffRoleAssignmentRow[]> {
    const { rows } = await sql<StaffRoleAssignmentRow>`SELECT * FROM trustwork.staff_effective_assignments(${hubId}::uuid, ${personId}::uuid)`.execute(trx);
    return rows;
  },

  async invite(trx: Transaction, ctx: CommandContext, input: { email: string; role: string; scope: StaffTarget; definitionVersion: number; validForSeconds: number | null; functionKey?: string | null; functionTitle?: string | null }): Promise<StaffInvitationRow> {
    const s = scopeArgs(input.scope);
    const { rows } = await sql<StaffInvitationRow>`SELECT * FROM trustwork.staff_invite(${ctxJson(ctx)}::jsonb, ${input.email}::text, ${input.role}::text, ${s.kind}::text,
      ${s.node}::uuid, ${s.hub}::uuid, ${input.definitionVersion}::integer, ${input.validForSeconds}::bigint, ${input.functionKey ?? null}::text, ${input.functionTitle ?? null}::text)`.execute(trx);
    return rows[0] as StaffInvitationRow;
  },
  async respond(trx: Transaction, invitationId: string, accept: boolean): Promise<StaffInvitationRow> {
    const { rows } = await sql<StaffInvitationRow>`SELECT * FROM trustwork.staff_invitation_respond(${invitationId}::uuid, ${accept}::boolean)`.execute(trx);
    return rows[0] as StaffInvitationRow;
  },
  async apply(trx: Transaction, ctx: CommandContext, invitationId: string): Promise<{ invitation: StaffInvitationRow; outcome: 'applied' | 'pending_second_person' }> {
    const { rows } = await sql<{ invitation: StaffInvitationRow; outcome: 'applied' | 'pending_second_person' }>`SELECT to_jsonb(r.invitation) AS invitation, r.outcome
      FROM trustwork.staff_invitation_apply(${ctxJson(ctx)}::jsonb, ${invitationId}::uuid) r`.execute(trx);
    const row = rows[0]!;
    return { invitation: row.invitation, outcome: row.outcome };
  },
  async withdraw(trx: Transaction, ctx: CommandContext, invitationId: string): Promise<StaffInvitationRow> {
    const { rows } = await sql<StaffInvitationRow>`SELECT * FROM trustwork.staff_invitation_withdraw(${ctxJson(ctx)}::jsonb, ${invitationId}::uuid)`.execute(trx);
    return rows[0] as StaffInvitationRow;
  },
  /** Invitations of a hub (and of the node and platform) the reader may see under row-level security, newest first. */
  async invitations(trx: Transaction, hubId: string): Promise<StaffInvitationRow[]> {
    return trx.selectFrom('staff_invitation').selectAll().where((eb) => eb.or([eb('hub_id', '=', hubId), eb('scope_kind', 'in', ['node', 'platform'])]))
      .orderBy('created_at', 'desc').limit(200).execute();
  },
  async mine(trx: Transaction): Promise<MyStaffInvitationRow[]> {
    const { rows } = await sql<MyStaffInvitationRow>`SELECT * FROM trustwork.staff_my_invitations()`.execute(trx);
    return rows;
  },

  /* ---------- Part 3: eligible roles and activations ---------- */

  async grantEligible(trx: Transaction, ctx: CommandContext, input: { personId: string; role: string; scope: StaffTarget; definitionVersion: number; maxActivationSeconds: number; validForSeconds: number | null }): Promise<StaffEligibleRoleRow> {
    const s = scopeArgs(input.scope);
    const { rows } = await sql<StaffEligibleRoleRow>`SELECT * FROM trustwork.staff_grant_eligible_role(${ctxJson(ctx)}::jsonb, ${input.personId}::uuid, ${input.role}::text, ${s.kind}::text,
      ${s.node}::uuid, ${s.hub}::uuid, ${input.definitionVersion}::integer, ${input.maxActivationSeconds}::bigint, ${input.validForSeconds}::bigint)`.execute(trx);
    return rows[0] as StaffEligibleRoleRow;
  },
  async revokeEligible(trx: Transaction, ctx: CommandContext, eligibleRoleId: string): Promise<StaffEligibleRoleRow> {
    const { rows } = await sql<StaffEligibleRoleRow>`SELECT * FROM trustwork.staff_revoke_eligible_role(${ctxJson(ctx)}::jsonb, ${eligibleRoleId}::uuid)`.execute(trx);
    return rows[0] as StaffEligibleRoleRow;
  },
  async requestActivation(trx: Transaction, ctx: CommandContext, eligibleRoleId: string, windowSeconds: number): Promise<{ activation: StaffActivationRow; outcome: 'active' | 'pending_second_person' }> {
    const { rows } = await sql<{ activation: StaffActivationRow; outcome: 'active' | 'pending_second_person' }>`SELECT to_jsonb(r.activation) AS activation, r.outcome
      FROM trustwork.staff_activation_request(${ctxJson(ctx)}::jsonb, ${eligibleRoleId}::uuid, ${windowSeconds}::bigint) r`.execute(trx);
    const row = rows[0]!;
    return { activation: row.activation, outcome: row.outcome };
  },
  async decideActivation(trx: Transaction, ctx: CommandContext, activationId: string, decision: 'approve' | 'decline'): Promise<StaffActivationRow> {
    const { rows } = await sql<StaffActivationRow>`SELECT * FROM trustwork.staff_activation_decide(${ctxJson(ctx)}::jsonb, ${activationId}::uuid, ${decision}::text)`.execute(trx);
    return rows[0] as StaffActivationRow;
  },
  async endActivation(trx: Transaction, ctx: CommandContext, activationId: string): Promise<StaffActivationRow> {
    const { rows } = await sql<StaffActivationRow>`SELECT * FROM trustwork.staff_activation_end(${ctxJson(ctx)}::jsonb, ${activationId}::uuid)`.execute(trx);
    return rows[0] as StaffActivationRow;
  },
  /** Eligible roles covering a hub (hub, node and platform) the reader may see: their own, or all with `admin.staff.read`. */
  async eligibleRoles(trx: Transaction, hubId: string, personId?: string): Promise<StaffEligibleRoleRow[]> {
    let query = trx.selectFrom('staff_eligible_role').selectAll().where((eb) => eb.or([eb('hub_id', '=', hubId), eb('scope_kind', 'in', ['node', 'platform'])]));
    if (personId) query = query.where('person_id', '=', personId);
    return query.orderBy('created_at', 'desc').limit(500).execute();
  },
  /** Activations covering a hub, newest first, with what their assignment and approval say now. */
  async activations(trx: Transaction, hubId: string, personId?: string): Promise<StaffActivationJoinedRow[]> {
    let query = trx.selectFrom('staff_activation as a')
      .leftJoin('staff_role_assignment as s', 's.id', 'a.assignment_id')
      .leftJoin('second_person_approval as p', 'p.id', 'a.approval_id')
      .selectAll('a')
      .select(['s.revoked_at as assignment_revoked_at', 's.valid_until as assignment_valid_until', 'p.status as approval_status', 'p.request_expires_at as approval_request_expires_at', 'p.approved_by as approved_by'])
      .where((eb) => eb.or([eb('a.hub_id', '=', hubId), eb('a.scope_kind', 'in', ['node', 'platform'])]));
    if (personId) query = query.where('a.person_id', '=', personId);
    return query.orderBy('a.created_at', 'desc').limit(500).execute() as Promise<StaffActivationJoinedRow[]>;
  },
  /* ---------- Part 4: access reviews ---------- */

  async openAccessReview(trx: Transaction, ctx: CommandContext, input: { scope: StaffTarget; title: string; roles: string[] | null; dueInSeconds: number }): Promise<StaffAccessReviewCampaignRow> {
    const s = scopeArgs(input.scope);
    const { rows } = await sql<StaffAccessReviewCampaignRow>`SELECT * FROM trustwork.staff_access_review_open(${ctxJson(ctx)}::jsonb, ${s.kind}::text, ${s.node}::uuid, ${s.hub}::uuid,
      ${input.title}::text, ${input.roles}::text[], ${input.dueInSeconds}::bigint)`.execute(trx);
    return rows[0] as StaffAccessReviewCampaignRow;
  },
  async decideAccessReviewItem(trx: Transaction, ctx: CommandContext, itemId: string, verdict: 'keep' | 'remove'): Promise<StaffAccessReviewItemRow> {
    const { rows } = await sql<StaffAccessReviewItemRow>`SELECT * FROM trustwork.staff_access_review_decide(${ctxJson(ctx)}::jsonb, ${itemId}::uuid, ${verdict}::text)`.execute(trx);
    return rows[0] as StaffAccessReviewItemRow;
  },
  async withdrawAccessReview(trx: Transaction, ctx: CommandContext, campaignId: string): Promise<StaffAccessReviewCampaignRow> {
    const { rows } = await sql<StaffAccessReviewCampaignRow>`SELECT * FROM trustwork.staff_access_review_withdraw(${ctxJson(ctx)}::jsonb, ${campaignId}::uuid)`.execute(trx);
    return rows[0] as StaffAccessReviewCampaignRow;
  },
  /** Campaigns covering a hub (hub, node and platform) the reader may see (`admin.staff.read` at the scope), newest first. */
  async accessReviews(trx: Transaction, hubId: string): Promise<StaffAccessReviewCampaignRow[]> {
    return trx.selectFrom('staff_access_review_campaign').selectAll().where((eb) => eb.or([eb('hub_id', '=', hubId), eb('scope_kind', 'in', ['node', 'platform'])]))
      .orderBy('created_at', 'desc').limit(200).execute();
  },
  async accessReview(trx: Transaction, campaignId: string): Promise<StaffAccessReviewCampaignRow | undefined> {
    return trx.selectFrom('staff_access_review_campaign').selectAll().where('id', '=', campaignId).executeTakeFirst();
  },
  async accessReviewItems(trx: Transaction, campaignIds: string[]): Promise<StaffAccessReviewItemRow[]> {
    if (!campaignIds.length) return [];
    return trx.selectFrom('staff_access_review_item').selectAll().where('campaign_id', 'in', campaignIds).orderBy('role').orderBy('created_at').execute();
  },
  async accessReviewItem(trx: Transaction, itemId: string): Promise<StaffAccessReviewItemRow | undefined> {
    return trx.selectFrom('staff_access_review_item').selectAll().where('id', '=', itemId).executeTakeFirst();
  },

  /* ---------- Part 5: accountability and offboarding ---------- */

  async assignAccountability(trx: Transaction, ctx: CommandContext, input: { hubId: string; functionKey: string; kind: 'function_owner' | 'agent_role'; agentRoleKey: string | null; personId: string; requiredRole: string | null }): Promise<StaffAccountabilityRow> {
    const { rows } = await sql<StaffAccountabilityRow>`SELECT * FROM trustwork.staff_accountability_assign(${ctxJson(ctx)}::jsonb, ${input.hubId}::uuid, ${input.functionKey}::text, ${input.kind}::text,
      ${input.agentRoleKey}::text, ${input.personId}::uuid, ${input.requiredRole}::text)`.execute(trx);
    return rows[0] as StaffAccountabilityRow;
  },
  async endAccountability(trx: Transaction, ctx: CommandContext, id: string): Promise<StaffAccountabilityRow> {
    const { rows } = await sql<StaffAccountabilityRow>`SELECT * FROM trustwork.staff_accountability_end(${ctxJson(ctx)}::jsonb, ${id}::uuid)`.execute(trx);
    return rows[0] as StaffAccountabilityRow;
  },
  async resumeAccountability(trx: Transaction, ctx: CommandContext, id: string): Promise<StaffAccountabilityRow> {
    const { rows } = await sql<StaffAccountabilityRow>`SELECT * FROM trustwork.staff_accountability_resume(${ctxJson(ctx)}::jsonb, ${id}::uuid)`.execute(trx);
    return rows[0] as StaffAccountabilityRow;
  },
  async offerAccountability(trx: Transaction, ctx: CommandContext, id: string, toPersonId: string): Promise<StaffAccountabilityOfferRow> {
    const { rows } = await sql<StaffAccountabilityOfferRow>`SELECT * FROM trustwork.staff_accountability_offer(${ctxJson(ctx)}::jsonb, ${id}::uuid, ${toPersonId}::uuid)`.execute(trx);
    return rows[0] as StaffAccountabilityOfferRow;
  },
  async respondAccountabilityOffer(trx: Transaction, ctx: CommandContext, offerId: string, accept: boolean): Promise<{ offer: StaffAccountabilityOfferRow; accountability: StaffAccountabilityRow }> {
    const { rows } = await sql<{ offer: StaffAccountabilityOfferRow; accountability: StaffAccountabilityRow }>`SELECT to_jsonb(r.offer) AS offer, to_jsonb(r.accountability) AS accountability
      FROM trustwork.staff_accountability_respond(${ctxJson(ctx)}::jsonb, ${offerId}::uuid, ${accept}::boolean) r`.execute(trx);
    return rows[0]!;
  },
  /** The hub's accountability rows the caller may see, with whether each holder holds the needed role now. */
  async accountabilities(trx: Transaction, hubId: string): Promise<StaffAccountabilityReadRow[]> {
    const { rows } = await sql<{ accountability: StaffAccountabilityRow; holder_ok: boolean; holder_name: string }>`SELECT to_jsonb(r.accountability) AS accountability, r.holder_ok, r.holder_name
      FROM trustwork.staff_accountabilities(${hubId}::uuid) r`.execute(trx);
    return rows;
  },
  async pendingOffers(trx: Transaction, accountabilityIds: string[]): Promise<StaffAccountabilityOfferRow[]> {
    if (!accountabilityIds.length) return [];
    return trx.selectFrom('staff_accountability_offer').selectAll().where('accountability_id', 'in', accountabilityIds).where('status', '=', 'pending').orderBy('created_at').execute();
  },
  /** Offers to the signed-in person (row-level security shows them their own). */
  async myOffers(trx: Transaction, personId: string): Promise<StaffAccountabilityOfferRow[]> {
    return trx.selectFrom('staff_accountability_offer').selectAll().where('to_person_id', '=', personId).where('status', '=', 'pending').orderBy('created_at').execute();
  },
  async startOffboarding(trx: Transaction, ctx: CommandContext, personId: string, scope: StaffTarget): Promise<StaffOffboardingRow> {
    const s = scopeArgs(scope);
    const { rows } = await sql<StaffOffboardingRow>`SELECT * FROM trustwork.staff_offboarding_start(${ctxJson(ctx)}::jsonb, ${personId}::uuid, ${s.kind}::text, ${s.node}::uuid, ${s.hub}::uuid)`.execute(trx);
    return rows[0] as StaffOffboardingRow;
  },
  async completeOffboarding(trx: Transaction, ctx: CommandContext, id: string): Promise<StaffOffboardingRow> {
    const { rows } = await sql<StaffOffboardingRow>`SELECT * FROM trustwork.staff_offboarding_complete(${ctxJson(ctx)}::jsonb, ${id}::uuid)`.execute(trx);
    return rows[0] as StaffOffboardingRow;
  },
  async cancelOffboarding(trx: Transaction, ctx: CommandContext, id: string): Promise<StaffOffboardingRow> {
    const { rows } = await sql<StaffOffboardingRow>`SELECT * FROM trustwork.staff_offboarding_cancel(${ctxJson(ctx)}::jsonb, ${id}::uuid)`.execute(trx);
    return rows[0] as StaffOffboardingRow;
  },
  /** The checklist as JSON from the database (`admin.staff.read` at the offboarding's scope, else "not found"). */
  async offboardingChecklist(trx: Transaction, id: string): Promise<unknown> {
    const { rows } = await sql<{ checklist: unknown }>`SELECT trustwork.staff_offboarding_checklist(${id}::uuid) AS checklist`.execute(trx);
    return rows[0]?.checklist;
  },
  async offboarding(trx: Transaction, id: string): Promise<StaffOffboardingRow | undefined> {
    return trx.selectFrom('staff_offboarding').selectAll().where('id', '=', id).executeTakeFirst();
  },
  async offboardings(trx: Transaction, hubId: string): Promise<StaffOffboardingRow[]> {
    return trx.selectFrom('staff_offboarding').selectAll().where((eb) => eb.or([eb('hub_id', '=', hubId), eb('scope_kind', 'in', ['node', 'platform'])]))
      .orderBy('created_at', 'desc').limit(200).execute();
  },

  async activation(trx: Transaction, activationId: string): Promise<StaffActivationJoinedRow | undefined> {
    const rows = await trx.selectFrom('staff_activation as a')
      .leftJoin('staff_role_assignment as s', 's.id', 'a.assignment_id')
      .leftJoin('second_person_approval as p', 'p.id', 'a.approval_id')
      .selectAll('a')
      .select(['s.revoked_at as assignment_revoked_at', 's.valid_until as assignment_valid_until', 'p.status as approval_status', 'p.request_expires_at as approval_request_expires_at', 'p.approved_by as approved_by'])
      .where('a.id', '=', activationId).execute() as StaffActivationJoinedRow[];
    return rows[0];
  },
};
