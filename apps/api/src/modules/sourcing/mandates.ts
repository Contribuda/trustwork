import type { MandateActionV2, Money } from '../../deps/contracts.js';

/**
 * Agent check for the sourcing operations (ADR 010 decision 23). Levelling, freezing a sheet and proposing an award are
 * `prepare`: an agent drafts, a person approves. The default port refuses every agent request; `app.module.ts` wires the
 * AST-001 mandate store with module key `sourcing_desk`. Approving is `human_only` and never reaches this port.
 */
export type SourcingMandateAction = Extract<MandateActionV2, 'prepare' | 'communicate' | 'place_order'>;
export interface SourcingMandateCheck {
  personId: string;
  mandateId: string;
  action: SourcingMandateAction;
  context: { kind: 'rfq'; id: string };
  amount: Money | null;
  at: Date;
}
export interface SourcingMandatePort {
  allows(check: SourcingMandateCheck): Promise<boolean>;
}

export class NoSourcingMandates implements SourcingMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}

/** Fake for tests: allows exactly the listed (person, mandate, action) triples and records every check. */
export class AllowListSourcingMandates implements SourcingMandatePort {
  readonly checks: SourcingMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string; action: string }[]) {}
  async allows(check: SourcingMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId && a.action === check.action);
  }
}
