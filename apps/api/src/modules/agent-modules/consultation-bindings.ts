import type { Principal } from '../../deps/contracts.js';
import type { ConsultationsService } from '../consultations/consultations.service.js';
import type { ServiceCapabilityBinding, ServiceCapabilityBindings } from './service-bindings.js';

const target = (suffix: string, companyId: string | null = null) => ({ capabilityId: `consultation.${suffix}`, companyId });
const personal = (suffix: string): ServiceCapabilityBinding => ({ capabilityId: `consultation.${suffix}` });
const currentCompany = (p: Principal, id: string | null | undefined) => p.membership?.companyId === id ? id : null;
const idOf = (args: readonly unknown[]) => typeof args[0] === 'string' && /^[a-f0-9-]{36}$/i.test(args[0]) ? args[0] : null;
const mixed = (suffix: string, permission = 'company.deals.manage'): ServiceCapabilityBinding => ({ resolve: async (_trx, p) => [target(suffix),
  ...(p.membership?.permissions.includes(permission as never) ? [target(suffix, p.membership.companyId)] : [])] });
const offering = (suffix: string, inputId = false): ServiceCapabilityBinding => ({ async resolve(trx, p, args) {
  const id = inputId ? (args[0] as Parameters<ConsultationsService['registerOffering']>[0]).offeringId : idOf(args);
  const row = id && /^[a-f0-9-]{36}$/i.test(id) ? await trx.selectFrom('offering').select('owner_company_id').where('id', '=', id).executeTakeFirst() : undefined;
  return [target(suffix, currentCompany(p, row?.owner_company_id))];
} });
const request = (suffix: string, requesterSuffix = suffix): ServiceCapabilityBinding => ({ async resolve(trx, p, args) {
  const id = idOf(args);
  const row = id ? await trx.selectFrom('consultation_request').select(['requester_person_id', 'offering_owner_company_id']).where('id', '=', id).executeTakeFirst() : undefined;
  return [row?.requester_person_id === p.personId ? target(requesterSuffix) : target(suffix, currentCompany(p, row?.offering_owner_company_id))];
} });
const booking = (suffix: string, source: 'booking' | 'agreement' | 'deliverable' = 'booking'): ServiceCapabilityBinding => ({ async resolve(trx, p, args) {
  let id = idOf(args);
  if (source === 'deliverable' && id) id = (await trx.selectFrom('consultation_deliverable').select('booking_id').where('id', '=', id).executeTakeFirst())?.booking_id ?? null;
  const row = id ? await trx.selectFrom('consultation_booking').select(['client_person_id', 'seller_company_id']).where(source === 'agreement' ? 'agreement_id' : 'id', '=', id).executeTakeFirst() : undefined;
  return [target(suffix, row?.client_person_id === p.personId ? null : currentCompany(p, row?.seller_company_id))];
} });
const publicProjection: ServiceCapabilityBinding = { boundary: 'public_projection', reason: 'Accepted public offering or explicitly published deliverable, owning public serializer, trusted serving context, no participant identity.' };

/** Every exported CONS-001 operation. The original mandate, fee, immutable terms and human decision checks still run. */
export const CONSULTATION_SERVICE_BINDINGS = {
  registerOffering: offering('register_offering', true), updateOffering: offering('update_offering'), listOfferings: mixed('list_offerings', 'company.catalogue.edit'),
  publicOfferings: publicProjection, publicDeliverable: publicProjection,
  openWindow: personal('open_window'), closeWindow: personal('close_window'), listWindows: personal('list_availability'),
  createRequest: personal('request'), setRequestPrivate: personal('set_request_private'), withdrawRequest: personal('withdraw_request'),
  getRequest: request('get_brief', 'get_request'), listRequests: mixed('list_requests'), declineRequest: request('decline_request'), propose: request('propose'),
  withdrawProposal: booking('withdraw_proposal'), acceptProposal: personal('accept_proposal'), declineProposal: personal('decline_proposal'),
  withdrawAcceptance: personal('withdraw_acceptance'), confirmBooking: booking('confirm_booking', 'agreement'), declineAgreement: booking('decline_agreement', 'agreement'),
  cancel: booking('cancel'), recordSession: booking('record_session'), deliver: booking('deliver'), decideDeliverable: booking('decide_deliverable', 'deliverable'),
  publishDeliverable: booking('publish_deliverable', 'deliverable'), getBooking: booking('get_booking'), listBookings: mixed('list_bookings'), calendar: booking('get_calendar'),
  proposeMentoring: personal('propose_mentoring'), respondMentoring: personal('respond_mentoring'), changeMentoring: personal('change_mentoring'), listMentoring: personal('list_mentoring'),
} satisfies ServiceCapabilityBindings<ConsultationsService>;
