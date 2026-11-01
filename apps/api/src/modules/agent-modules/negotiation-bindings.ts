import type { EnvelopesService } from '../assistant-goals/envelopes.service.js';
import { ENVELOPE_INTENT_ACTION } from '../assistant-goals/contracts.js';
import { ApiError } from '../../common/errors.js';
import type { ServiceCapabilityBinding, ServiceCapabilityBindings } from './service-bindings.js';

const verbs = { negotiate: 'negotiate', communicate: 'message', schedule: 'schedule', introduce: 'introduce' } as const;
const list = (suffix: string): ServiceCapabilityBinding => ({ resolve: async (_trx, p) =>
  [null, ...(p.membership?.permissions.includes('company.deals.manage') ? [p.membership.companyId] : [])]
    .map(companyId => ({ capabilityId: `negotiation.${suffix}`, companyId })) });

/** Resolve the exact stored speaker. The owning delivery command still checks context, receiver, terms and approval. */
export const NEGOTIATION_SERVICE_BINDINGS = {
  send: { serializeNegotiation: true, async resolve(trx, p, args) {
    const body = args[0] as Parameters<EnvelopesService['send']>[0];
    const verb = ENVELOPE_INTENT_ACTION[body.intent];
    if (verb !== 'negotiate' && verb !== 'communicate' && verb !== 'schedule' && verb !== 'introduce') throw new ApiError('access.mandate_scope');
    const capabilityId = `negotiation.${verbs[verb]}`;
    if (body.actingAs.kind === 'own_agent') {
      const row = await trx.selectFrom('mandate').select(['principal_person_id', 'grantee_kind', 'on_behalf_company_id']).where('id', '=', body.actingAs.mandateId).executeTakeFirst();
      if (!row || row.principal_person_id !== p.personId || row.grantee_kind !== 'own_agent'
        || (row.on_behalf_company_id !== null && row.on_behalf_company_id !== p.membership?.companyId)) throw new ApiError('access.not_found');
      return [{ capabilityId, companyId: row.on_behalf_company_id }];
    }
    const cm = await trx.selectFrom('company_mandate').selectAll().where('id', '=', body.actingAs.companyMandateId).executeTakeFirst();
    if (!cm || cm.company_id !== p.membership?.companyId) throw new ApiError('access.not_found');
    if (body.actingAs.kind === 'colleague_agent') {
      if (cm.executor_kind !== 'person_agent' || cm.executor_person_id !== p.personId) throw new ApiError('access.not_found');
      return [{ capabilityId, companyId: cm.company_id }];
    }
    const rep = await trx.selectFrom('company_representative').select(['id', 'accountable_person_id']).where('company_id', '=', cm.company_id).executeTakeFirst();
    if (cm.executor_kind !== 'company_representative' || !rep || cm.representative_id !== rep.id || rep.accountable_person_id !== p.personId) throw new ApiError('access.not_found');
    return [{ capabilityId, companyId: cm.company_id, representativeOf: cm.company_id }];
  } },
  listEnvelopes: list('list_envelopes'), listNegotiations: list('list_sessions'),
  getNegotiation: { async resolve(trx, p, args) {
    const row = await trx.selectFrom('negotiation_session').selectAll().where('id', '=', args[0] as string).executeTakeFirst();
    if (!row) throw new ApiError('access.not_found');
    const companyId = p.membership && ((row.party_a_kind === 'company' && row.party_a_id === p.membership.companyId)
      || (row.party_b_kind === 'company' && row.party_b_id === p.membership.companyId)) ? p.membership.companyId : null;
    return [{ capabilityId: 'negotiation.get_session', companyId }];
  } },
} satisfies ServiceCapabilityBindings<EnvelopesService>;
