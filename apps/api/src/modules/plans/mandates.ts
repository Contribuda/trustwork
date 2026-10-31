/**
 * Mandate check for agent drafts and proposals (ADR 012 decision 13: an agent may draft and propose a plan version only
 * under a mandate, and never approves). The mandate store and the agent runtime are not part of this slice, so the
 * default port denies every agent request (`access.mandate_scope`); persons act on their own authority. When the
 * mandate tables exist (AGT runtime), an adapter checks a live `prepare` mandate whose context covers the project.
 */
export interface PlanMandateCheck {
  personId: string;
  mandateId: string;
  projectId: string;
  action: 'prepare';
  at: Date;
}
export interface PlanMandatePort {
  allows(check: PlanMandateCheck): Promise<boolean>;
}

/** Default: no mandate store yet, so no agent request is authorized. */
export class NoPlanMandates implements PlanMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}

/** Fake for tests and local demos: allows exactly the listed (person, mandate, project) triples and records every check. */
export class AllowListPlanMandates implements PlanMandatePort {
  readonly checks: PlanMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string; projectId: string }[]) {}
  async allows(check: PlanMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId && a.projectId === check.projectId);
  }
}
