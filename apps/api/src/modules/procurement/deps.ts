/**
 * Relative re-exports of the commerce slice (COM-001). The catalogue and procurement modules import their contract and
 * repository files directly so the shared package entries (`packages/contracts/src/client.ts`,
 * `packages/data/src/index.ts`) stay untouched; adding them to those barrels is integrator bookkeeping.
 */
export * from '../../../../../packages/contracts/src/commerce.js';
export {
  bundleComponents, cataloguePublic, commercePlanLinks, needs, offeringPrivate, offerings, offeringVersions, rfqInvitations, rfqPrivate, rfqPublic, rfqs, rfqVersions,
  type NeedLineInsert, type NeedPatch, type PublicOfferingRow, type PublicRfqRow, type RfqPrivateInput,
} from '../../../../../packages/data/src/repositories/commerce.js';
export type {
  NeedLineRow, NeedRow, OfferingRow, OfferingVersionPrivateRow, OfferingVersionRow, RfqInvitationRow, RfqPrivateConstraintRow, RfqRow, RfqVersionRow,
} from '../../../../../packages/data/src/schema/commerce.js';
export { planItemStates } from '../../../../../packages/data/src/repositories/plans.js';
