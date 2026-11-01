import type { MandateActionV2 } from '../../deps/contracts.js';

/**
 * Agent check for the supplier base operations (ADR 010 decision 23): maintaining records, counterparties, the import
 * and recording an assessment are `maintain_records` (the company's own internal procurement records); drafting an
 * assessment is `prepare`; the supplier's answer to a shared assessment is `communicate` on behalf of the supplier
 * company. The default port refuses every agent request; `app.module.ts` wires the AST-001 mandate store.
 */
export interface SupplierBaseMandateCheck {
  personId: string;
  mandateId: string;
  action: Extract<MandateActionV2, 'prepare' | 'maintain_records' | 'communicate'>;
  context: { kind: 'company'; id: string };
  at: Date;
}
export interface SupplierBaseMandatePort {
  allows(check: SupplierBaseMandateCheck): Promise<boolean>;
}

export class NoSupplierBaseMandates implements SupplierBaseMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}

/** Fake for tests: allows exactly the listed (person, mandate, action) triples and records every check. */
export class AllowListSupplierBaseMandates implements SupplierBaseMandatePort {
  readonly checks: SupplierBaseMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string; action: string }[]) {}
  async allows(check: SupplierBaseMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId && a.action === check.action);
  }
}
