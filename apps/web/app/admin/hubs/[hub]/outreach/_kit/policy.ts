/*
 * The outreach policy contract (OUTR-001) for the outreach section, imported from its module rather than through the
 * `@trustwork/contracts/client` barrel: every client component that imports the barrel would otherwise carry these
 * schemas too, and the console reads them on the server only (bundle budget, scripts/ci/bundle-budget.json).
 */
export {
  floorViolations, OUTREACH_CHANNELS, OUTREACH_ENGINE_FLOOR, OUTREACH_MODES, OutreachJurisdictionPolicySchema, OutreachModeSchema, RECIPIENT_CLASSES, resolveOutreach,
} from '../../../../../../../../packages/contracts/src/outreach-policy.js';
export type { OutreachChannel, OutreachPolicy, RecipientClass } from '../../../../../../../../packages/contracts/src/outreach-policy.js';
