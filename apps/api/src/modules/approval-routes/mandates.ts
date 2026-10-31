import type { MandateActionV2 } from '../../deps/contracts.js';

/**
 * Agent check for the approval operations an agent may perform (ADR 010 decision 23): drafting a route version
 * (`prepare`), delegating, withdrawing and revoking (`maintain_records`). Deciding a step and activating a route are
 * the human-only verb `approve`: those commands never consult this port and refuse every agent request, whatever a
 * mandate, an extension or a connection says. The default port refuses every agent request; `app.module.ts` wires the
 * AST-001 mandate store.
 */
export interface ApprovalMandateCheck {
  personId: string;
  mandateId: string;
  action: Extract<MandateActionV2, 'prepare' | 'maintain_records'>;
  context: { kind: 'company'; id: string };
  at: Date;
}
export interface ApprovalMandatePort {
  allows(check: ApprovalMandateCheck): Promise<boolean>;
}

export class NoApprovalMandates implements ApprovalMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}

/** Fake for tests: allows exactly the listed (person, mandate, action) triples, whatever action is asked, and records every check. */
export class AllowListApprovalMandates implements ApprovalMandatePort {
  readonly checks: ApprovalMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string; action: string }[]) {}
  async allows(check: ApprovalMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId && a.action === check.action);
  }
}
