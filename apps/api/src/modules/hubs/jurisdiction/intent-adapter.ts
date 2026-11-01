import { computeDigest, type Money } from '@trustwork/contracts';
import type { Transaction } from '../../../deps/data.js';
import { ApiError } from '../../../common/errors.js';
import { decide, type PolicyRequest, type PolicySettings } from '../../assistant/policy.js';
import { actionIntents } from '../../../../../../packages/data/src/repositories/assistant.js';
import { jurisdictionAuthority } from '../../../../../../packages/data/src/repositories/jurisdiction-policy.js';
import { evaluateJurisdictionAction, type JurisdictionLimits } from '../../../../../../packages/contracts/src/jurisdiction.js';

export function evaluateLimits(limits: JurisdictionLimits, amount: Money | null) {
  if (limits.consentRequirements.length) return { effect: 'deny' as const, reasons: ['jurisdiction_consent_evidence_unavailable'] };
  if (limits.approval === 'human_only') return { effect: 'deny' as const, reasons: ['jurisdiction_human_only'] };
  return evaluateJurisdictionAction({ ...limits, jurisdictions: [], disclosureTextKeys: {}, legalTextKeys: {} }, amount);
}

/**
 * Isolated ADR022 seam. Call within the real principal/action transaction, before creating an intent. The existing
 * assistant policy still owns mandate authority. A process hub default never chooses the applicable policy.
 * No chat, model reply, arbitrary counterparty, source, consent claim or locale is accepted as legal authority.
 */
export async function prepareJurisdictionIntent(trx: Transaction, request: PolicyRequest, settings: PolicySettings) {
  if (request.context.kind !== 'quote') throw new ApiError('access.forbidden', 'jurisdiction.applicability_unknown');
  const limits = await jurisdictionAuthority.limits(trx, request.context.id, request.action);
  const jurisdiction = evaluateLimits(limits, request.amount);
  const mandate = await decide(trx, { ...request, at: new Date() }, { ...settings, hubId: limits.hubId });
  const outcome = mandate.outcome;
  if (jurisdiction.effect === 'deny' || outcome.effect === 'deny') return { effect: 'deny' as const, reasons: jurisdiction.effect === 'deny' ? jurisdiction.reasons : [outcome.effect === 'deny' ? outcome.reason : 'jurisdiction_unavailable'], limits, mandate };
  return { effect: jurisdiction.effect === 'ask' || outcome.effect === 'ask' ? 'ask' as const : 'allow' as const,
    reasons: [...new Set([...jurisdiction.reasons, ...(outcome.effect === 'ask' ? outcome.reasons : [])])], limits, mandate };
}

/** A concrete intent carries the binding in its immutable action digest and in a separate append-only DB record. */
export async function recordJurisdictionIntent(trx: Transaction, input: {
  request: PolicyRequest; settings: PolicySettings; runId: string; capabilityId: string;
  effect: { provider: string; operation: string; payload: unknown };
}) {
  const prepared = await prepareJurisdictionIntent(trx, input.request, input.settings);
  if (prepared.effect === 'deny' || prepared.mandate.outcome.effect === 'deny' || prepared.limits.bindingDigest === null) throw new ApiError('access.forbidden', 'jurisdiction.execution_refused');
  const mandate = prepared.mandate.outcome;
  const digest = computeDigest({ kind: 'trustwork.assistant.jurisdiction-action.v2', mandate: { id: mandate.mandate.id, revision: mandate.mandate.revision },
    capabilityId: input.capabilityId, action: input.request.action, context: mandate.context, amount: input.request.amount, effect: input.effect,
    jurisdictionBinding: prepared.limits.bindingDigest }).value;
  const result = await actionIntents.record(trx, { runId: input.runId, mandateId: mandate.mandate.id, mandateRevision: mandate.mandate.revision,
    capabilityId: input.capabilityId, moduleKey: mandate.moduleKey, action: input.request.action, context: mandate.context,
    resolvedFromSelector: mandate.resolvedFromSelector, amount: input.request.amount, digest, effect: input.effect,
    decision: prepared.effect, askReasons: prepared.reasons });
  if (!result.intentId) throw new Error('jurisdiction action requires a durable intent');
  await jurisdictionAuthority.bind(trx, result.intentId, prepared.limits.bindingDigest);
  return { ...result, actionDigest: digest, limits: prepared.limits };
}

/** Refusal only. The caller must run current mandate/budget/consent/domain checks in this SAME transaction. */
export async function requireCurrentJurisdiction(trx: Transaction, intentId: string): Promise<void> {
  if (!await jurisdictionAuthority.recheck(trx, intentId)) throw new ApiError('access.forbidden', 'jurisdiction.policy_changed');
}
