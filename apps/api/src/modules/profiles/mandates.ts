/**
 * Mandate check for the person's agent acting on their profile (ADR 010 decision 23: every capability is reachable
 * through the agent). Profile edits are commits under a `maintain_profile` mandate; consent, visibility, portraits and
 * licences are governance on the first-party form and never accept a delegated principal. The mandate store and the
 * agent runtime are not part of this slice, so the default port denies every agent request (`access.mandate_scope`);
 * persons act on their own authority.
 */
export interface ProfileMandateCheck {
  personId: string;
  mandateId: string;
  action: 'maintain_profile';
  at: Date;
}
export interface ProfileMandatePort {
  allows(check: ProfileMandateCheck): Promise<boolean>;
}

/** Default: no mandate store yet, so no agent request is authorized. */
export class NoProfileMandates implements ProfileMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}

/** Fake for tests and local demos: allows exactly the listed (person, mandate) pairs and records every check. */
export class AllowListProfileMandates implements ProfileMandatePort {
  readonly checks: ProfileMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string }[]) {}
  async allows(check: ProfileMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId);
  }
}
