import type { Principal } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import type { TasksService } from '../tasks/tasks.service.js';
import type { ServiceCapabilityBinding, ServiceCapabilityBindings, ServiceCapabilityTarget } from './service-bindings.js';

const target = (suffix: string, companyId: string | null = null): ServiceCapabilityTarget => ({ capabilityId: `task_marketplace.${suffix}`, companyId });
const currentCompany = (p: Principal, id: string | null | undefined) => p.membership?.companyId === id ? id : null;
const personal = (suffix: string): ServiceCapabilityBinding => ({ capabilityId: `task_marketplace.${suffix}` });
const scope = (p: Principal): (string | null)[] => p.membership?.permissions.includes('company.deals.manage') ? [null, p.membership.companyId] : [null];
const mixed = (suffix: string): ServiceCapabilityBinding => ({ resolve: async (_trx, p) => scope(p).map(company => target(suffix, company)) });
const idOf = (args: readonly unknown[]): string | null => typeof args[0] === 'string' && /^[a-f0-9-]{36}$/i.test(args[0]) ? args[0] : null;
const offer = (suffix: string): ServiceCapabilityBinding => ({
  async resolve(trx, p, args) {
    const id = idOf(args);
    const row = id ? await trx.selectFrom('task_offer').select('offeror_company_id').where('id', '=', id).executeTakeFirst() : undefined;
    return [target(suffix, currentCompany(p, row?.offeror_company_id))];
  },
});
const agreement = (suffix: string): ServiceCapabilityBinding => ({
  async resolve(trx, p, args) {
    const id = idOf(args);
    const row = id ? await trx.selectFrom('agreement').select('seller_company_id').where('id', '=', id).executeTakeFirst() : undefined;
    return [target(suffix, currentCompany(p, row?.seller_company_id))];
  },
});
async function assignmentCompany(trx: Transaction, p: Principal, args: readonly unknown[]): Promise<string | null> {
  const id = idOf(args);
  const row = id ? await trx.selectFrom('task_assignment').select(['owner_person_id', 'assignee_company_id']).where('id', '=', id).executeTakeFirst() : undefined;
  return row?.owner_person_id === p.personId ? null : currentCompany(p, row?.assignee_company_id);
}
const assignment = (suffix: string): ServiceCapabilityBinding => ({ capabilityId: `task_marketplace.${suffix}`, company: assignmentCompany });

/** Exact source-service operations. Party classification never replaces the owning authorizer, fee or projection port. */
export const TASK_SERVICE_BINDINGS = {
  createRequest: personal('draft_request'), saveDraft: personal('save_request_draft'), publish: personal('publish_request'),
  setPrivate: personal('set_request_private'), invite: personal('invite'), cancel: personal('cancel_request'), listRequests: personal('list_requests'),
  listOpen: personal('list_open_requests'), listInvitations: mixed('list_invitations'), listOffers: mixed('list_offers'), listAssignments: mixed('list_assignments'),
  getRequest: { async resolve(trx, p, args) {
    const id = idOf(args);
    const row = id ? await trx.selectFrom('task_request').select('owner_person_id').where('id', '=', id).executeTakeFirst() : undefined;
    return !row || row.owner_person_id === p.personId ? [target('get_request')] : scope(p).map(company => target('get_brief', company));
  } },
  createOffer: { async resolve(_trx, p, args) {
    const input = args[0] as Parameters<TasksService['createOffer']>[0];
    return [target('draft_offer', input.offeror.kind === 'company' ? currentCompany(p, input.offeror.id) : null)];
  } },
  saveOffer: offer('save_offer_draft'), sendOffer: offer('send_offer'), withdrawOffer: offer('withdraw_offer'), getOffer: offer('get_offer'),
  acceptOffer: personal('accept_offer'), withdrawAcceptance: personal('withdraw_acceptance'),
  confirmAgreement: agreement('confirm_agreement'), declineAgreement: agreement('decline_agreement'),
  getAssignment: assignment('get_assignment'), review: assignment('review'),
  record: { async resolve(trx, p, args) {
    const input = args[1] as Parameters<TasksService['record']>[1];
    return [target(input.kind === 'delivery_claim' ? 'record_delivery' : 'decide_delivery', await assignmentCompany(trx, p, args))];
  } },
} satisfies ServiceCapabilityBindings<TasksService>;
