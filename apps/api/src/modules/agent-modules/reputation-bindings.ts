import type { Party } from '../../deps/contracts.js';
import type { ReputationService } from '../reputation/reputation.service.js';
import type { ServiceCapabilityBinding, ServiceCapabilityBindings } from './service-bindings.js';

const party = (value: unknown): string | null => {
  const p = value as Party | undefined;
  return p?.kind === 'company' ? p.id : null;
};
const operation = (suffix: string, field?: 'holder' | 'requester', firstPartyOnly = false): ServiceCapabilityBinding => ({
  capabilityId: `reputation_builder.${suffix}`, firstPartyOnly,
  async company(_trx, principal, args) {
    const company = party(field ? (args[0] as Record<string, unknown>)[field] : args[0]);
    return company === principal.membership?.companyId ? company : null;
  },
});
const request = (suffix: string): ServiceCapabilityBinding => ({
  capabilityId: `reputation_builder.${suffix}`, firstPartyOnly: true,
  async company(trx, _principal, args) {
    const id = args[0];
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) return null;
    return (await trx.selectFrom('confirmation_request').select('requester_company_id').where('id', '=', id).executeTakeFirst())?.requester_company_id ?? null;
  },
});
const control = (reason: string): ServiceCapabilityBinding => ({ boundary: 'first_party_control', reason });

export const REPUTATION_SERVICE_BINDINGS = {
  own: operation('explain_my_reputation'), inbox: operation('list_confirmation_requests'),
  publicView: { boundary: 'public_projection', reason: 'REP-001 public credentials and consented portfolio are public regardless of plan; private numbers and documents remain excluded.' },
  recordCredential: operation('record_credential', 'holder', true), addPortfolioEntry: operation('publish_portfolio_entry', 'holder', true),
  requestConfirmation: operation('send_confirmation_request', 'requester', true), remind: request('remind_confirmation_request'),
  checkCredential: {
    capabilityId: 'reputation_builder.check_credential', firstPartyOnly: true,
    async company(trx, _principal, args) {
      const id = args[0];
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) return null;
      return (await trx.selectFrom('professional_credential').select('holder_company_id').where('id', '=', id).executeTakeFirst())?.holder_company_id ?? null;
    },
  },
  withdraw: control('A person can withdraw a confirmation request even after a plan or module is disabled.'),
  answer: control('Counterparty confirmation and consent are human-only owning actions, never purchased capacity.'),
  declareRelation: control('Conflict disclosures remain available independently of commercial policy.'),
  fileAppeal: control('Appeal rights cannot depend on a subscription.'), appealLimitation: control('Appealing a safety limitation cannot depend on a subscription.'),
} satisfies ServiceCapabilityBindings<ReputationService>;
