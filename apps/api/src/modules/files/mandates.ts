import type { MandateActionV2 } from '../../deps/contracts.js';

/**
 * Mandate check for agent requests on file operations (ADR 010 decision 23: every operation is reachable by the
 * person's agent, but only under a structured, revocable mandate; chat text never authorizes). The mandate store is not
 * part of this slice, so the default port denies every agent request (`access.mandate_scope`); persons act on their own
 * authority. The AGT runtime replaces it with an adapter over live mandates whose context covers the parent object.
 */
export interface FileMandateCheck {
  personId: string;
  mandateId: string;
  action: Extract<MandateActionV2, 'prepare' | 'record_evidence' | 'maintain_records'>;
  context: { kind: 'profile' | 'company' | 'project' | 'rfq' | 'quote' | 'agreement' | 'order' | 'publication'; id: string } | null;
  at: Date;
}
export interface FileMandatePort {
  allows(check: FileMandateCheck): Promise<boolean>;
}

/** Default: no mandate store yet, so no agent request is authorized. */
export class NoFileMandates implements FileMandatePort {
  async allows(): Promise<boolean> {
    return false;
  }
}

/** Fake for tests: allows exactly the listed (person, mandate, action) triples and records every check. */
export class AllowListFileMandates implements FileMandatePort {
  readonly checks: FileMandateCheck[] = [];
  constructor(private readonly allowed: readonly { personId: string; mandateId: string; action: FileMandateCheck['action'] }[]) {}
  async allows(check: FileMandateCheck): Promise<boolean> {
    this.checks.push(check);
    return this.allowed.some((a) => a.personId === check.personId && a.mandateId === check.mandateId && a.action === check.action);
  }
}
