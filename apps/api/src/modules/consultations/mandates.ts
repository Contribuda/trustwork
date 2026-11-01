import type { MandateActionV2, Money } from '../../deps/contracts.js';

/**
 * Mandate check for agent requests on consultation operations (ADR 010 decision 23: every operation is reachable by the
 * person's agent, but only under a structured, revocable mandate; chat text never authorizes). The default port denies
 * every agent request (`access.mandate_scope`); the app wires the AST-001 mandate store (module key `consultation`).
 * Money actions pass the amount so the store can hold it against the mandate ceiling; the requester's private budget
 * ceiling is checked by the service in addition. Delivering and accepting a deliverable and publishing it are never
 * delegated.
 */
export type ConsultationMandateAction = Extract<MandateActionV2, 'prepare' | 'publish' | 'schedule' | 'communicate' | 'send_quote' | 'place_order' | 'accept_order' | 'record_evidence'>;
export interface ConsultationMandateCheck {
  personId: string;
  mandateId: string;
  action: ConsultationMandateAction;
  context: { kind: 'consultation' | 'catalogue_offering' | 'agreement' | 'project' | 'profile'; id: string };
  amount: Money | null;
  at: Date;
}
export interface ConsultationMandatePort {
  allows(check: ConsultationMandateCheck): Promise<boolean>;
}

/** Default: no mandate store wired, so no agent request is authorized. */
export class NoConsultationMandates implements ConsultationMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}

/** Fake for tests: allows exactly the listed (person, mandate, action) triples, optionally up to a ceiling, and records every check. */
export class AllowListConsultationMandates implements ConsultationMandatePort {
  readonly checks: ConsultationMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string; action: ConsultationMandateAction; ceiling?: Money }[]) {}
  async allows(check: ConsultationMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId && a.action === check.action
      && (a.ceiling === undefined || (check.amount !== null && check.amount.currency === a.ceiling.currency && BigInt(check.amount.minorUnits) <= BigInt(a.ceiling.minorUnits))));
  }
}
