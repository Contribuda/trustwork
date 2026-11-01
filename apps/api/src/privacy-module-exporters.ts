import type { Transaction } from './deps/data.js';
import type { Principal } from './deps/contracts.js';
import type { RequestState } from './common/request.js';
import type { AppContext } from './modules/identity/context.js';
import type { PrincipalService } from './modules/identity/principal.service.js';
import type { IdentityServices } from './modules/identity/identity.module.js';
import { toPerson, toMembership } from './modules/identity/serializers.js';
import { persons, emailBindings, credentials } from '../../../packages/data/src/repositories/identity.js';
import { memberships } from '../../../packages/data/src/repositories/company.js';
import { ExecutionService } from './modules/execution/execution.service.js';
import { NoExecutionMandates } from './modules/execution/mandates.js';
import { TrustService } from './modules/trust/trust.service.js';
import { ReputationService } from './modules/reputation/reputation.service.js';
import { PlansService } from './modules/plans/plans.service.js';
import { NoPlanMandates } from './modules/plans/mandates.js';
import { FileLicensingFacets } from './modules/plans/facets.js';
import { TasksService } from './modules/tasks/tasks.service.js';
import { NoTaskMandates } from './modules/tasks/mandates.js';
import { ConfiguredElectronicRecords } from './modules/transactions/electronic-records.js';
import { SupportService } from './modules/support/support.service.js';
import { CommunicationsService } from './modules/communications/communications.service.js';
import { NoCommsMandates } from './modules/communications/mandates.js';
import { communicationsSettingsFromEnv } from './modules/communications/communications.module.js';
import { billingAccounts, subscriptions, priceAcceptances } from '../../../packages/data/src/repositories/billing.js';
import { toPriceAcceptance, toBudget, toReservation } from './modules/billing/billing.service.js';
import type { PrivacySubject } from '../../../packages/contracts/src/privacy.js';

/** Only composition-root readers; all calls share the download's real principal and locked transaction. */
export async function composeModuleExports(input: {
  ctx: AppContext; identity: IdentityServices; trx: Transaction; principals: PrincipalService;
  principal: Principal; state: RequestState; subject: PrivacySubject; projectIds: string[]; agreementIds: string[];
}): Promise<Record<string, unknown>> {
  const { ctx, identity, trx, principals, state, subject, projectIds, agreementIds } = input;
  const data: Record<string, unknown> = {};
  const each = async <T, R>(items: readonly T[], read: (item: T) => Promise<R>) => {
    const result: R[] = [];
    for (const item of items) result.push(await read(item));
    return result;
  };
  if (subject.kind === 'person') {
    const person = await persons.getById(trx, subject.id);
    if (!person) throw new Error('export subject disappeared');
    data.identity = { person: toPerson(person, await emailBindings.listForPerson(trx, subject.id), await credentials.listForPerson(trx, subject.id)),
      memberships: (await trx.selectFrom('membership').selectAll().where('person_id', '=', subject.id).orderBy('created_at').execute()).map(toMembership) };
    const support = new SupportService(ctx, principals);
    // The UI's ownCases list is bounded at 200. Enumerate all ids, then use its owning projection for each.
    const cases = await trx.selectFrom('support_case').select('id').where('requester_person_id', '=', subject.id).orderBy('id').execute();
    data.support = { cases: await each(cases, (r) => support.ownCase(state, r.id)), actions: await support.ownActions(state), access: await support.ownAccessRecords(state) };
  } else {
    data.companyMemberships = (await memberships.listForCompany(trx, subject.id)).map(toMembership);
  }
  const plans = new PlansService(ctx, principals, identity.participations, new NoPlanMandates(), new FileLicensingFacets());
  const planRows = projectIds.length ? await trx.selectFrom('plan').select(['id', 'project_id']).where('project_id', 'in', projectIds).orderBy('id').execute() : [];
  data.plans = await each(planRows, async (r) => ({
    current: await plans.get(r.project_id, state),
    versions: await each(await trx.selectFrom('plan_version').select('id').where('plan_id', '=', r.id).orderBy('version').execute(), (v) => plans.getVersion(r.project_id, v.id, state)),
    itemStates: await plans.listItemStates(r.project_id, state), changes: await plans.listChanges(r.project_id, state),
    timing: await plans.timingFacts(r.project_id, state), shares: await plans.listShares(r.project_id, state),
    location: await plans.getLocation(r.project_id, state), permits: await plans.listPermits(r.project_id, state), diary: await plans.listDiary(r.project_id, state),
  }));
  const execution = new ExecutionService(ctx, principals, new NoExecutionMandates(), { hubId: null });
  const trust = new TrustService(ctx, principals, { hubId: null });
  // Execution is defined only for fully confirmed agreements. Retain unconfirmed terms in the agreement export.
  const confirmed = agreementIds.length ? await trx.selectFrom('agreement').select('id').where('id', 'in', agreementIds).where('status', 'in', ['accepted_by_both', 'superseded']).execute() : [];
  data.execution = await each(confirmed, (r) => execution.view(r.id, state));
  data.trust = await each(confirmed, (r) => trust.listReviews(r.id, state));
  const reputation = new ReputationService(ctx, principals, { hubId: null, register: { code: 'unavailable', lookup: async () => { throw new Error('export cannot call a credential register'); } } });
  data.reputation = { own: await reputation.own(subject, state), confirmations: await reputation.inbox(subject, state) };
  const tasks = new TasksService(ctx, principals, new NoTaskMandates(), new ConfiguredElectronicRecords());
  const requests = subject.kind === 'person' ? await tasks.listRequests(state) : { requests: [] }; const offers = await tasks.listOffers(state);
  const assignments = agreementIds.length ? await trx.selectFrom('task_assignment').select('id').where('agreement_id', 'in', agreementIds).orderBy('id').execute() : [];
  data.tasks = {
    requests: await each(requests.requests, (r) => tasks.getRequest(r.id, state)), offers: await each(offers.offers.filter((r) => r.offeror.kind === subject.kind && r.offeror.id === subject.id), (r) => tasks.getOffer(r.offerId, state)),
    assignments: await each(assignments, (r) => tasks.getAssignment(r.id, state)), invitations: subject.kind === 'person' ? await tasks.listInvitations(state) : { invitations: [] },
  };
  const comms = new CommunicationsService(ctx, principals, new NoCommsMandates(), { providers: [], send: async () => { throw new Error('export cannot dispatch'); } }, communicationsSettingsFromEnv());
  // A person export excludes an employer's threads. RLS plus the owning thread service enforce current participation.
  const contexts = [...projectIds, ...agreementIds];
  const threadRows = contexts.length ? await trx.selectFrom('context_thread').select('id').where('context_id', 'in', contexts).orderBy('id').execute() : [];
  const communications: Record<string, unknown> = { threads: await each(threadRows, (r) => comms.getThread(r.id, state)) };
  if (subject.kind === 'person') {
    const notifications: unknown[] = []; let cursor: string | undefined;
    do {
      const page = await comms.listNotifications({ limit: 100, ...(cursor ? { cursor } : {}) }, state);
      notifications.push(...page.items); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    communications.notifications = notifications;
    communications.preferences = await comms.getPreferences(state);
    communications.channels = await comms.listGrants(state);
  }
  data.communications = communications;
  const accounts = await billingAccounts.listForParty(trx, subject);
  const budgets = await trx.selectFrom('budget').selectAll().where(subject.kind === 'person' ? 'owner_person_id' : 'owner_company_id', '=', subject.id).orderBy('id').execute();
  data.billing = {
    accounts: await each(accounts, async (account) => ({ account, subscriptions: await subscriptions.listForAccount(trx, account.id),
      acceptances: (await priceAcceptances.listForAccount(trx, account.id)).map(toPriceAcceptance) })),
    budgets: await each(budgets, async (b) => ({ budget: toBudget(b), reservations: (await trx.selectFrom('reservation').selectAll().where('budget_id', '=', b.id).orderBy('id').execute()).map(toReservation) })),
  };
  return data;
}
