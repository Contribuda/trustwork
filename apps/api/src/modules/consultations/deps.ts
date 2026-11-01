/**
 * Relative re-exports of the consultations slice (CONS-001). The module imports its own contract and repository files
 * directly so the shared package entries (`packages/contracts/src/client.ts`, `packages/data/src/index.ts`) stay
 * untouched; adding them to those barrels is integrator bookkeeping.
 */
export * from '../../../../../packages/contracts/src/consultations.js';
export { credentialStatus, type CredentialCheckOutcome } from '../../../../../packages/contracts/src/reputation-builder.js';
export {
  availabilityWindows, consultationAgreements, consultationBookings, consultationCatalogue, consultationDeliverables, consultationOfferings, consultationProjects, consultationReminders,
  consultationRequestPrivate, consultationRequests, consultationSessions, mentoringRelationships,
  type ConsultationPartyScope, type CredentialFactsRow, type OfferingFactsRow, type PublicConsultationOfferingRow,
} from '../../../../../packages/data/src/repositories/consultations.js';
export type {
  AvailabilityWindowRow, ConsultationBookingRow, ConsultationDeliverableRow, ConsultationOfferingRow, ConsultationReminderRow, ConsultationRequestPrivateRow, ConsultationRequestRow,
  ConsultationSessionRow, MentoringRelationshipRow,
} from '../../../../../packages/data/src/schema/consultations.js';
export { acceptanceEvents, agreements, obligations, electronicRecordsSatisfied, type AcceptanceEventRow, type AgreementRow, type ObligationRow } from '../sales/deps.js';
export { executionAgreements, executionClaims, executionConfirmations } from '../execution/deps.js';
export { planItemStates, planParts, plans, projectLocations, rowToItem, isoDate } from '../plans/deps.js';
export { toLocation } from '../plans/serializers.js';
