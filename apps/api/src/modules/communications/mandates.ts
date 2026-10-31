import type { MandateActionV2 } from '../../deps/contracts.js';

/**
 * Mandate check for agent-written messages (ADR 010 decisions 4 and 23): an agent writes into a context thread on
 * behalf of its person only under a confirmed `communicate` mandate for that context; chat text never authorizes.
 * The default port refuses every agent request; app.module.ts wires the AST-001 mandate store.
 */
export interface CommsMandateCheck {
  personId: string;
  mandateId: string;
  action: Extract<MandateActionV2, 'communicate'>;
  context: { kind: string; id: string };
  at: Date;
}
export interface CommsMandatePort {
  allows(check: CommsMandateCheck): Promise<boolean>;
}
export class NoCommsMandates implements CommsMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}
/** Fake for tests: allows exactly the listed (person, mandate) pairs and records every check. */
export class AllowListCommsMandates implements CommsMandatePort {
  readonly checks: CommsMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string }[]) {}
  async allows(check: CommsMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId);
  }
}
