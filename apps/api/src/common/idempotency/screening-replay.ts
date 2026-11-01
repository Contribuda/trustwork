import { complianceAppealReceipt } from '../../../../../packages/contracts/src/screening-disclosure.js';
import type { StoredResult } from './records.js';

/** Minimize legacy successful appeal responses without replaying their effects or rewriting retained evidence. */
export function minimizeScreeningReplay(action: string, result: StoredResult): StoredResult {
  return action === 'screening.appeal_file' && result.httpStatus >= 200 && result.httpStatus < 300
    ? { httpStatus: result.httpStatus, body: complianceAppealReceipt() }
    : result;
}
