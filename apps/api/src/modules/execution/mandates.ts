/**
 * Mandate check for agent requests on execution records (ADR 010 decision 23: the person's agent may record claims,
 * attach evidence and report defects, but only under a structured, revocable `record_evidence` mandate; chat text never
 * authorizes). Deciding on a claim, disputing, appealing and reviewing are human-only and have no agent path at all.
 * The mandate store is not part of this slice (AST-001), so the default port denies every agent request.
 */
export interface ExecutionMandateCheck {
  personId: string;
  mandateId: string;
  action: 'record_evidence';
  context: { kind: 'agreement'; id: string };
  at: Date;
}
export interface ExecutionMandatePort {
  allows(check: ExecutionMandateCheck): Promise<boolean>;
}

/** Default: no mandate store yet, so no agent request is authorized. */
export class NoExecutionMandates implements ExecutionMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}

/** Fake for tests and local demos: allows exactly the listed (person, mandate) pairs and records every check. */
export class AllowListExecutionMandates implements ExecutionMandatePort {
  readonly checks: ExecutionMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string }[]) {}
  async allows(check: ExecutionMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId);
  }
}
