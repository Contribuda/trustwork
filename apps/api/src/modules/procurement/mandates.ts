import type { MandateActionV2 } from '../../deps/contracts.js';

/**
 * Mandate check for agent requests on commerce operations (ADR 010 decision 23: every operation is reachable by the
 * person's agent, but only under a structured, revocable mandate; chat text never authorizes). The mandate store and
 * the agent runtime are not part of this slice, so the default port denies every agent request
 * (`access.mandate_scope`); persons act on their own authority. When the mandate tables exist (AGT runtime), an
 * adapter evaluates a live mandate (`evaluateMandateV2`) whose context covers the object.
 */
export interface CommerceMandateCheck {
  personId: string;
  mandateId: string;
  /** The mandate kind the capability needs (`prepare` for drafts, `publish`, `communicate`). */
  action: Extract<MandateActionV2, 'prepare' | 'publish' | 'communicate'>;
  context: { kind: 'rfq' | 'catalogue_offering' | 'project' | 'company' | 'profile'; id: string };
  at: Date;
}
export interface CommerceMandatePort {
  allows(check: CommerceMandateCheck): Promise<boolean>;
}

/** Default: no mandate store yet, so no agent request is authorized. */
export class NoCommerceMandates implements CommerceMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}

/** Fake for tests and local demos: allows exactly the listed (person, mandate, action) triples and records every check. */
export class AllowListCommerceMandates implements CommerceMandatePort {
  readonly checks: CommerceMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string; action: CommerceMandateCheck['action'] }[]) {}
  async allows(check: CommerceMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId && a.action === check.action);
  }
}
