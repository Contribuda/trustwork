/** Every implemented API module participates in subject planning, even when its exporter is unavailable. */
import { PRIVACY_MODULE_INVENTORY, type PrivacyResponseDraftPackage } from '../../../../../../packages/contracts/src/privacy.js';
export { PRIVACY_MODULE_INVENTORY };

/**
 * Operator assistants can prepare this data only (`privacy_response_draft_prepare`). It deliberately contains no
 * approval or execution capability: `humanDecisionsRequired` names what people must still decide.
 */
export type PrivacyResponseDraft = PrivacyResponseDraftPackage;
