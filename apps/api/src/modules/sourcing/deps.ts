/**
 * Relative re-exports of the sourcing slice (PRC-004). The module imports the supply contracts and its own repository
 * directly so the shared package entries (`packages/contracts/src/index.ts`, `packages/data/src/index.ts`) stay
 * untouched; the `./supply` package export is an open integrator request (PRC-000).
 */
export {
  AwardDecisionSchema, BidLevelSheetPayloadSchema, BidLevelSheetSchema, BidLevelSheetVersionSchema, BidOutcomeNoticeSchema, feedbackBand, levelSheetTotals,
  type AwardDecision, type BidLevelSheetPayload, type BidLevelSheetVersion, type BidOutcomeNotice,
} from '../../../../../packages/contracts/src/supply/sourcing.js';
export { DraftBidLevelSheetCommandSchema, ExecuteAwardCommandSchema, NotifyOutcomesCommandSchema, ProposeAwardCommandSchema } from '../../../../../packages/contracts/src/supply/commands.js';
export { KeySchema } from '../../../../../packages/contracts/src/supply/common.js';
export { awardDecisions, eligibilityRules, levelSheets, outcomeNotices, sourcingAccess } from '../../../../../packages/data/src/repositories/sourcing.js';
export type { AwardDecisionRow, BidLevelSheetRow, BidLevelSheetVersionRow, BidOutcomeNoticeRow, SourcingEligibilityRuleSetRow } from '../../../../../packages/data/src/schema/sourcing.js';
export { quotes, quoteVersions, rfqInvitations, rfqs, rfqVersions, type QuoteRow, type QuoteVersionRow, type RfqRow, type RfqVersionRow } from '../sales/deps.js';
export { ElectronicRecordsConsentSchema } from '../../../../../packages/contracts/src/deals.js';
export { PROCUREMENT_HUB_DEFAULTS } from '../../../../../packages/contracts/src/supply/settings.js';
export { supplierRecords, type SupplierRecordRow, type SupplierStatus } from '../supplier-base/deps.js';
