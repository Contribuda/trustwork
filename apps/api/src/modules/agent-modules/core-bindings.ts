import type { GoalsService } from '../assistant-goals/goals.service.js';
import type { ServiceCapabilityBinding, ServiceCapabilityBindings } from './service-bindings.js';

const operation = (suffix: string): ServiceCapabilityBinding => ({
  capabilityId: `core.${suffix}`,
  async company(trx, principal, args) {
    const first = args[0];
    let company: string | null = null;
    if (typeof first === 'string' && /^[a-f0-9-]{36}$/i.test(first)) {
      company = (await trx.selectFrom('goal').select('on_behalf_company_id').where('id', '=', first).executeTakeFirst())?.on_behalf_company_id ?? null;
    } else if (first && typeof first === 'object' && 'onBehalfOf' in first) {
      const onBehalfOf = first.onBehalfOf as { kind: string; id: string } | null;
      company = onBehalfOf?.kind === 'company' ? onBehalfOf.id : null;
    }
    return company === principal.membership?.companyId ? company : null;
  },
});
const list = (suffix: string): ServiceCapabilityBinding => ({
  async resolve(_trx, principal) {
    return [null, ...(principal.membership ? [principal.membership.companyId] : [])].map(companyId => ({ capabilityId: `core.${suffix}`, companyId }));
  },
});
const control = (reason: string): ServiceCapabilityBinding => ({ boundary: 'first_party_control', reason });

export const CORE_SERVICE_BINDINGS = {
  listGoals: list('list_goals'), getGoal: operation('get_goal'), createGoal: operation('create_goal'),
  recordEvidence: operation('record_goal_evidence'), generateReport: operation('generate_goal_report'), listReports: list('list_reports'),
  getConfirmation: control('Reading the exact proposed authority is part of first-party confirmation.'),
  confirmGoal: control('First-party structured mandate confirmation cannot be sold or disabled by module policy.'),
  setGoalStatus: control('The person retains goal pause and closure; resumption does not bypass subsequent dispatch checks.'),
  shareReport: control('Only the person controls report disclosure; owning report RLS still applies.'),
  listJobSubscriptions: control('The person must be able to find and stop subscriptions under disabled policy.'),
  createJobSubscription: operation('create_job_subscription'),
  setJobSubscriptionStatus: control('Subscription stop remains available; restart still needs fresh runtime authority.'),
  listEscalations: control('Safety decisions remain visible under disabled policy.'),
  resolveEscalation: control('The person can resolve a safety escalation; resolution grants no execution authority.'),
} satisfies ServiceCapabilityBindings<GoalsService>;
