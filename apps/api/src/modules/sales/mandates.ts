import type { MandateActionV2, Money } from '../../deps/contracts.js';

/**
 * Mandate check for agent requests on quotes, negotiation, agreements and orders (ADR 010 decision 23: every operation
 * is reachable by the person's agent, but only under a structured, revocable mandate; chat text never authorizes). The
 * mandate store and the agent runtime are not part of this slice (AST-001), so the default port denies every agent
 * request (`access.mandate_scope`); persons act on their own authority. Money actions pass the amount so an adapter can
 * hold it against the mandate ceiling; private floors and budget ceilings are checked by the services in addition.
 */
export type DealMandateAction = Extract<MandateActionV2, 'prepare' | 'send_quote' | 'negotiate' | 'place_order' | 'accept_order'>;
export interface DealMandateCheck {
  personId: string;
  mandateId: string;
  action: DealMandateAction;
  context: { kind: 'rfq' | 'quote' | 'agreement' | 'order'; id: string };
  amount: Money | null;
  at: Date;
}
export interface DealMandatePort {
  allows(check: DealMandateCheck): Promise<boolean>;
}

/** Default: no mandate store yet, so no agent request is authorized. */
export class NoDealMandates implements DealMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}

/** Fake for tests and local demos: allows exactly the listed (person, mandate, action) triples, optionally up to a ceiling, and records every check. */
export class AllowListDealMandates implements DealMandatePort {
  readonly checks: DealMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string; action: DealMandateAction; ceiling?: Money }[]) {}
  async allows(check: DealMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId && a.action === check.action
      && (a.ceiling === undefined || (check.amount !== null && check.amount.currency === a.ceiling.currency && BigInt(check.amount.minorUnits) <= BigInt(a.ceiling.minorUnits))));
  }
}
