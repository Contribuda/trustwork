import type { MandateV2Decision } from '../../../../../../packages/contracts/src/agent-catalog.js';
import { evaluateJurisdictionAction, type JurisdictionResolution } from '../../../../../../packages/contracts/src/jurisdiction.js';
import type { Money } from '../../../../../../packages/contracts/src/common/money.js';

/**
 * Restriction composition for a future runtime hook. Pure only: no caller-supplied jurisdiction, approval or consent
 * is trusted, and this function does not dispatch an effect. Wiring requires authoritative applicability and a
 * database projection readable in the action transaction; see README.md.
 */
export function restrictMandateByJurisdiction(mandate: MandateV2Decision, resolution: JurisdictionResolution, amount: Money | null): { effect: 'allow' | 'ask' | 'deny'; reasons: string[] } {
  if (mandate.effect === 'deny') return { effect: 'deny', reasons: [mandate.reason] };
  const jurisdiction = evaluateJurisdictionAction(resolution, amount);
  if (jurisdiction.effect === 'deny') return jurisdiction;
  const reasons = [...new Set([...(mandate.effect === 'ask' ? mandate.reasons : []), ...jurisdiction.reasons])].sort();
  return { effect: mandate.effect === 'ask' || jurisdiction.effect === 'ask' ? 'ask' : 'allow', reasons };
}
