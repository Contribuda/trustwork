/** Every implemented API module participates in subject planning, even when its exporter is unavailable. */
import { PRIVACY_MODULE_INVENTORY } from '../../../../../../packages/contracts/src/privacy.js';
export { PRIVACY_MODULE_INVENTORY };

/** Operator assistants can prepare this data only. It deliberately contains no approval or execution capability. */
export interface PrivacyResponseDraft {
  state: 'Draft'; requestId: string; inventory: typeof PRIVACY_MODULE_INVENTORY;
  unresolved: readonly { module: string; capability: 'export' | 'erase' | 'redact' | 'pseudonymize'; reason: string }[];
}
