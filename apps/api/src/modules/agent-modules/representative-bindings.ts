import type { RepresentativeService } from '../assistant-goals/representative.service.js';
import type { ServiceCapabilityBinding, ServiceCapabilityBindings } from './service-bindings.js';
const control: ServiceCapabilityBinding = {
  boundary: 'first_party_control', serializeNegotiation: true,
  reason: 'Current first-party authority inspection, confirmation and withdrawal are non-purchasable. Owning company, accountable person, step-up and separation rules remain authoritative. This is not an MCP summary projection.',
};
export const REPRESENTATIVE_SERVICE_BINDINGS = {
  view: control, myCompanyMandates: control, listCompanyMandates: control,
  configure: control, accept: control, suspend: control, resume: control, disable: control,
  grant: control, reconfirm: control, revoke: control,
} satisfies ServiceCapabilityBindings<RepresentativeService>;
