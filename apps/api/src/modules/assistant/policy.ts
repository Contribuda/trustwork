import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeDigest, evaluateMandateV2, MandateV2Schema, type ContextRef, type MandateActionV2, type MandateAskReason, type MandateDenyReason, type MandateV2, type MandateV2Decision, type Money,
} from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { findRepositoryRoot, mandates, stops, type MandateRow } from './deps.js';

/**
 * Pure and database-backed policy pieces of the assistant runtime (AST-001). The decision itself is
 * `evaluateMandateV2` from the agent catalogue contracts: it takes structured facts only, so chat text, envelope notes
 * and connection prose cannot reach it. The database commands repeat the numbers under the mandate row lock.
 */

/** Settings every decision needs; per-hub values come from the hub agent policy when HUB-002 stores it. */
export interface PolicySettings {
  /** Deployment hub (kill switches of other hubs do not apply); null means every hub-scoped switch applies. */
  hubId: string | null;
  /** Actions the hub never lets a mandate pre-authorize (`HubAgentPolicy.forbiddenPreAuthorization`). */
  forbiddenPreAuthorization: readonly MandateActionV2[];
  /** Restricted-places predicate (authoritative list in packages/country-packs/packs/restricted.json). */
  isRestricted: (code: string) => boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/**
 * Reads the authoritative restricted-places list from the country packs at start-up (the API build does not compile
 * the country-packs package; plans/facets.ts reads pack data the same way). Fail-closed: without the list every place
 * counts as restricted, so a mandate whose context names a region is refused rather than allowed.
 */
export function restrictedPlacesFromPacks(root: string | null = findRepositoryRoot()): (code: string) => boolean {
  const path = root ? join(root, 'packages', 'country-packs', 'packs', 'restricted.json') : null;
  if (!path || !existsSync(path)) return () => true;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { places?: { code?: unknown }[] };
    const codes = new Set((parsed.places ?? []).map((p) => (typeof p.code === 'string' ? p.code.toUpperCase() : '')).filter((c) => /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(c)));
    if (codes.size === 0) return () => true;
    return (code: string) => {
      const upper = code.toUpperCase();
      return codes.has(upper) || codes.has(upper.split('-')[0] ?? '');
    };
  } catch {
    return () => true;
  }
}

/** The confirmed mandate of a row, or null when the stored snapshot no longer parses (fail-closed). */
export function mandateOf(row: Pick<MandateRow, 'snapshot'>): MandateV2 | null {
  const parsed = MandateV2Schema.safeParse(row.snapshot);
  return parsed.success ? parsed.data : null;
}

/** trustwork-digest-1 of a mandate snapshot (what the person confirmed, or what a proposal shows). */
export function mandateDigest(mandate: MandateV2): string {
  return computeDigest(mandate).value;
}

/** The exact action an approval binds: mandate revision, capability, verb, concrete context, amount and effect. */
export interface ActionDescription {
  mandate: { id: string; revision: number };
  capabilityId: string;
  action: MandateActionV2;
  context: ContextRef;
  amount: Money | null;
  effect: { provider: string; operation: string; payload: unknown } | null;
}
export function actionDigest(action: ActionDescription): string {
  return computeDigest({ kind: 'trustwork.assistant.action', mandate: action.mandate, capabilityId: action.capabilityId, action: action.action, context: action.context, amount: action.amount, effect: action.effect }).value;
}

/**
 * Field names that carry party-private constraints. An effect payload handed to a provider, a counterparty or another
 * agent never contains them: the builder refuses the payload instead of trusting a caller to strip it.
 */
const PRIVATE_KEY = /floor|ceiling|budget|private|constraint|ownernotes|offerornotes|approvers|conditions|limits|reservation/i;
export class PrivateFieldError extends Error {
  constructor(readonly path: string) {
    super('the effect payload carries a private field');
    this.name = 'PrivateFieldError';
  }
}
/** Throws `PrivateFieldError` when any key of the payload (at any depth) names a private constraint. */
export function assertShareable(payload: unknown, path = 'payload'): void {
  if (Array.isArray(payload)) {
    payload.forEach((item, index) => assertShareable(item, `${path}[${index}]`));
    return;
  }
  if (payload !== null && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (PRIVATE_KEY.test(key)) throw new PrivateFieldError(`${path}.${key}`);
      assertShareable(value, `${path}.${key}`);
    }
  }
}

export type PolicyOutcome =
  | { effect: 'allow'; mandate: MandateV2; moduleKey: string; context: ContextRef; resolvedFromSelector: boolean }
  | { effect: 'ask'; mandate: MandateV2; moduleKey: string; context: ContextRef; resolvedFromSelector: boolean; reasons: MandateAskReason[] }
  | { effect: 'deny'; reason: MandateDenyReason | 'not_found' };

export interface PolicyRequest {
  personId: string;
  mandateId: string;
  /** Candidate module keys of the calling capability; the first one the mandate covers is used. */
  moduleKeys: readonly string[];
  action: MandateActionV2;
  context: ContextRef;
  amount: Money | null;
  projectId: string | null;
  at: Date;
}

/**
 * Runs the pure policy inside the principal's transaction: loads the mandate (RLS: only the principal's own), the
 * facts (committed amount, actions in the window, approvals at this revision) and the first blocking kill switch or
 * stop. Condition facts are not resolved here, so a mandate with conditions asks (or stops) instead of allowing.
 */
export async function decide(trx: Transaction, request: PolicyRequest, settings: PolicySettings): Promise<{ outcome: PolicyOutcome; row: MandateRow | null }> {
  if (!isUuid(request.mandateId)) return { outcome: { effect: 'deny', reason: 'not_found' }, row: null };
  const row = await mandates.get(trx, request.mandateId);
  if (!row || row.principal_person_id !== request.personId) return { outcome: { effect: 'deny', reason: 'not_found' }, row: null };
  const mandate = mandateOf(row);
  if (!mandate) return { outcome: { effect: 'deny', reason: 'invalid_mandate' }, row };
  const moduleKey = request.moduleKeys.find((k) => mandate.moduleKeys.includes(k)) ?? request.moduleKeys[0] ?? 'core';
  const ceiling = mandate.limits.ceiling;
  const facts = await mandates.facts(trx, row, ceiling?.currency ?? null, mandate.limits.perWindow?.windowHours ?? null);
  const blockedBy = await stops.blockedBy(trx, { hubId: settings.hubId, moduleKey, action: request.action, personId: request.personId, connectionId: null });
  const decision: MandateV2Decision = evaluateMandateV2(mandate, {
    moduleKey,
    action: request.action,
    context: request.context,
    contextFacts: { categories: [], region: null, projectId: request.projectId ?? (request.context.kind === 'project' ? request.context.id : null) },
    amount: request.amount,
    committedUnderMandate: ceiling ? { minorUnits: facts.committedMinor, currency: ceiling.currency } : null,
    actionsInWindow: facts.actionsInWindow,
    approvalsAtRevision: facts.approvalsAtRevision,
    conditionFacts: {},
    actor: { kind: 'own_agent', personId: request.personId },
    via: { kind: 'first_party' },
    hub: { forbiddenPreAuthorization: settings.forbiddenPreAuthorization },
    blockedBySwitchId: blockedBy,
    isRestricted: settings.isRestricted,
  }, request.at);
  if (decision.effect === 'deny') return { outcome: { effect: 'deny', reason: decision.reason }, row };
  const base = { mandate, moduleKey, context: decision.context, resolvedFromSelector: decision.resolvedFromSelector };
  return { outcome: decision.effect === 'allow' ? { effect: 'allow', ...base } : { effect: 'ask', ...base, reasons: decision.reasons }, row };
}
