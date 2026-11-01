import type { DataPool } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { gateRefusal } from './gate.js';
import { gateVerdict, screeningGates, type ScreeningGatePurpose } from './deps.js';

/** Mandate actions that commit (send an offer, bind terms, accept an order) or move money (`MONEY_ACTIONS`): the principal must be transactable. */
export const GATED_AGENT_ACTIONS: ReadonlySet<string> = new Set(['send_quote', 'place_order', 'accept_order', 'register', 'release_payment']);

/** The structural shape every module's mandate port shares (`allows(check)`). */
export interface MandatePortLike<C extends { personId: string; action: string }> {
  allows(check: C): Promise<boolean>;
}

/**
 * The gate on the mandate evaluation path (SANC-004; ADR 014 decision 13: "their agent cannot commit"). Wraps a
 * module's mandate port: before a commit action is evaluated (and a mandate use recorded), the agent's principal must
 * be transactable. A refusal is thrown with the same code and words the interface shows (`screening.review_pending`,
 * `jurisdiction.restricted`, `screening.unavailable`), so the agent reports it in the person's decisions and never
 * retries around it. Non-commit actions pass straight to the wrapped port.
 *
 * This is a pre-check in a short transaction of its own; the binding check runs again inside the commitment's own
 * transaction (`ScreeningGate.requireTransactable`) together with the counterparty.
 */
export class ScreenedMandates<C extends { personId: string; action: string }> implements MandatePortLike<C> {
  constructor(private readonly inner: MandatePortLike<C>, private readonly pool: DataPool, private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  async allows(check: C): Promise<boolean> {
    if (GATED_AGENT_ACTIONS.has(check.action)) await this.requirePrincipal(check.personId);
    return this.inner.allows(check);
  }

  private async requirePrincipal(personId: string): Promise<void> {
    const subjects = [{ subject: { kind: 'person' as const, id: personId }, side: 'own' as const }];
    const purpose: ScreeningGatePurpose = 'agent_commit';
    let states = null;
    try {
      states = await withoutPrincipal(this.pool, (trx) => screeningGates.check(trx, subjects.map((s) => s.subject)));
    } catch {
      states = null;
    }
    const verdict = gateVerdict(subjects, states, this.clock.now());
    if (!verdict.ok) throw gateRefusal(verdict, purpose);
  }
}
