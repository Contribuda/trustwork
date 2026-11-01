import { z } from 'zod';
import { IdSchema } from './common/ids.js';
import { ownComplianceStatus, ScreeningHoldReasonSchema, ScreeningSubjectRefSchema, type ScreeningState, type ScreeningSubjectRef } from './sanctions.js';

/**
 * The money and commitment gates (SANC-004; ADR 014 decisions 9, 12, 13, 15 and 16; handbook "Sanctions compliance",
 * SNC-F07, SNC-F14 and SNC-F19).
 *
 * - **Who is checked.** Every subject of a commitment or a money movement: both parties (a person or a company) and the
 *   person who acts (themself, a member acting for their company, or the principal of an agent). Each subject is on
 *   the caller's own side or on the counterparty's side.
 * - **What passes.** Only a subject whose effective screening state (SANC-003 `screeningState`) holds no money and who
 *   has no open jurisdiction hold (SANC-001). Unscreened, an `insufficient_name` result, an open or confirmed match, a
 *   result older than the active baseline versions, a missing or stale baseline, or a state that cannot be read all
 *   refuse (fail closed). No setting turns a gate off (decision 16).
 * - **What each side is told.** The caller's own side gets its own words (`screening.review_pending` with the status
 *   words of SANC-003, or `jurisdiction.restricted` for a hold). A counterparty refusal is one code with no detail at
 *   all (`commercial.counterparty_unavailable`, "the other party cannot transact right now"): never the reason, the
 *   status, a list, an entry or whether the cause is a hold or a match. A screening store that cannot answer, or a
 *   baseline that is missing or stale, is not about anyone: everybody gets `screening.unavailable`.
 * - **Nothing else reads it.** A refusal is never stored, never public, never an input to ranking, matching,
 *   recommendations or reputation.
 */

/** Codes of the gates. `jurisdiction.restricted` (451) is SANC-001's code, reused for an own-side hold. */
export const SCREENING_GATE_ERROR_CODES = ['screening.review_pending', 'screening.unavailable', 'commercial.counterparty_unavailable', 'jurisdiction.restricted'] as const;
export type ScreeningGateErrorCode = (typeof SCREENING_GATE_ERROR_CODES)[number];
/**
 * HTTP statuses. Every gate refusal is definite (nothing happened), so none is a 5xx: a client never mistakes it for an
 * unknown outcome to reconcile.
 */
export const SCREENING_GATE_ERROR_STATUS: Readonly<Record<ScreeningGateErrorCode, number>> = {
  'screening.review_pending': 403,
  'screening.unavailable': 409,
  'commercial.counterparty_unavailable': 409,
  'jurisdiction.restricted': 451,
};

/** What a gate protects. Money purposes serve PAY-001 and BILL-002; commitment purposes the commerce modules and agents. */
export const SCREENING_GATE_PURPOSES = ['quote_send', 'terms_accept', 'order_place', 'order_accept', 'order_change', 'agent_commit', 'payout_account', 'payout', 'sale'] as const;
export const ScreeningGatePurposeSchema = z.enum(SCREENING_GATE_PURPOSES);
export type ScreeningGatePurpose = z.infer<typeof ScreeningGatePurposeSchema>;

export const GATE_SIDES = ['own', 'counterparty'] as const;
export const GateSubjectSchema = z.strictObject({ subject: ScreeningSubjectRefSchema, side: z.enum(GATE_SIDES) });
export type GateSubject = z.infer<typeof GateSubjectSchema>;

/** One row of the database read (`trustwork.screening_gate_check`), parsed. */
export const GateStateSchema = z.strictObject({
  subject: ScreeningSubjectRefSchema,
  moneyHeld: z.boolean(),
  suspended: z.boolean(),
  reasons: z.array(ScreeningHoldReasonSchema),
  appealable: z.boolean(),
  placeHold: z.boolean(),
});
export type GateState = z.infer<typeof GateStateSchema>;

/** Locale keys (namespace `screening`) shown when the caller's own company cannot transact; details are on its compliance page. */
export const OWN_COMPANY_PAUSED_KEYS = ['screening.gate.companyPaused', 'screening.contact'] as const;

export type GateVerdict =
  | { ok: true }
  | { ok: false; code: 'screening.unavailable'; details: Record<string, never> }
  | { ok: false; code: 'jurisdiction.restricted'; details: Record<string, never> }
  | { ok: false; code: 'screening.review_pending'; details: { subject: ScreeningSubjectRef; messageKeys: string[] } }
  | { ok: false; code: 'commercial.counterparty_unavailable'; details: Record<string, never> };

const sameSubject = (a: ScreeningSubjectRef, b: ScreeningSubjectRef) => a.kind === b.kind && a.id === b.id;

/**
 * The decision of a gate over the states read for its subjects (pure; the API and the tests share it). A subject
 * missing from `states` counts as unreadable. Order: the store or the lists unavailable, then the caller's own side
 * (a hold before any screening reason), then the counterparty. The caller's own words come before the counterparty's,
 * so the caller can act on them, and a counterparty refusal never carries anything.
 */
export function gateVerdict(subjects: readonly GateSubject[], states: readonly GateState[] | null, now: Date = new Date()): GateVerdict {
  if (subjects.length === 0) return { ok: false, code: 'screening.unavailable', details: {} };
  if (states === null) return { ok: false, code: 'screening.unavailable', details: {} };
  const read = subjects.map((s) => ({ ...s, state: states.find((x) => sameSubject(x.subject, s.subject)) ?? null }));
  if (read.some((r) => r.state === null || r.state.reasons.includes('lists_unavailable'))) return { ok: false, code: 'screening.unavailable', details: {} };
  const own = read.filter((r) => r.side === 'own');
  if (own.some((r) => r.state!.placeHold)) return { ok: false, code: 'jurisdiction.restricted', details: {} };
  const ownHeld = own.find((r) => r.state!.moneyHeld);
  if (ownHeld) return { ok: false, code: 'screening.review_pending', details: { subject: ownHeld.subject, messageKeys: ownWords(ownHeld.state!, now) } };
  if (read.some((r) => r.side === 'counterparty' && (r.state!.placeHold || r.state!.moneyHeld))) return { ok: false, code: 'commercial.counterparty_unavailable', details: {} };
  return { ok: true };
}

/** The caller's own status words: a person's are SANC-003's; a company's point to its compliance page (administrators only). */
function ownWords(state: GateState, now: Date): string[] {
  if (state.subject.kind === 'company') return [...OWN_COMPANY_PAUSED_KEYS];
  const s: ScreeningState = { subject: state.subject, moneyHeld: state.moneyHeld, suspended: state.suspended, reasons: state.reasons, lastOutcome: null, lastScreenedAt: null, checkedAt: now.toISOString() };
  return ownComplianceStatus(s, state.appealable).messageKeys;
}

/**
 * Subjects of a two-party act: the caller's own party, the counterparty and the acting person. The acting person is
 * checked as the caller's own side (they bind it), unless they are the own party already.
 */
export function dealSubjects(own: ScreeningSubjectRef, counterparty: ScreeningSubjectRef, actingPersonId: string): GateSubject[] {
  const out: GateSubject[] = [{ subject: own, side: 'own' }];
  if (!(own.kind === 'person' && own.id === actingPersonId)) out.push({ subject: { kind: 'person', id: actingPersonId }, side: 'own' });
  if (!out.some((s) => sameSubject(s.subject, counterparty))) out.push({ subject: counterparty, side: 'counterparty' });
  return out;
}

/**
 * Keys a counterparty-facing refusal, view or event must never contain (projection tests). The counterparty refusal has
 * no `details` at all; these keys are what a leak would look like.
 */
export const COUNTERPARTY_FORBIDDEN_GATE_KEYS = ['reasons', 'reason', 'messageKeys', 'status', 'moneyHeld', 'suspended', 'placeHold', 'appealable', 'lastOutcome', 'subject', 'listCode', 'entryUid', 'match'] as const;

/** Payout country of a payee (ISO 3166-1 alpha-2 or a subdivision code), as PAY-001 and BILL-002 pass it. */
export const PayoutCountrySchema = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/);
/** A payee as the money gates see it: who receives and the payout country they declared. */
export const PayeeSchema = z.strictObject({ subject: ScreeningSubjectRefSchema, payoutCountry: PayoutCountrySchema, declaredBy: IdSchema });
export type Payee = z.infer<typeof PayeeSchema>;
