import type { CredentialCheckOutcome } from './deps.js';

/**
 * Credential register adapter (REP-001). A hub verifies licences, insurance and certificates against the issuing
 * register of its country pack (for example a state contractor licence board). This slice ships only a fake: no
 * provider account, no external call. A lookup is read-only, so repeating it after an unknown outcome (`unavailable`)
 * has no side effect; the unknown outcome is recorded as such and never turns into "checked".
 */
export interface CredentialLookup { jurisdiction: string; credentialType: string; issuer: string; number: string | null }
export interface CredentialRegisterResult { outcome: CredentialCheckOutcome; validUntil: string | null; sourceRef: string | null }
export interface CredentialRegisterPort {
  /** Stored with every check (`register_code`), so a check names the register that answered. */
  readonly code: string;
  lookup(query: CredentialLookup): Promise<CredentialRegisterResult>;
}

/**
 * Deterministic synthetic register: numbers starting `SYN-OK-` match (valid until the date after the prefix when it
 * has one, `SYN-OK-2027-12-31-…`), `SYN-SUSP-` are suspended, `SYN-REV-` revoked, `SYN-DOWN-` leave the register
 * unavailable, `SYN-WRONG-` mismatch; anything else (or no number) is not found.
 */
export class FakeCredentialRegister implements CredentialRegisterPort {
  readonly code = 'fake.synthetic-register';
  readonly lookups: CredentialLookup[] = [];
  async lookup(query: CredentialLookup): Promise<CredentialRegisterResult> {
    this.lookups.push(query);
    const n = query.number ?? '';
    const ref = n ? `synthetic:${query.jurisdiction}:${query.credentialType}` : null;
    if (n.startsWith('SYN-OK-')) {
      const date = /^SYN-OK-(\d{4}-\d{2}-\d{2})/.exec(n)?.[1] ?? null;
      return { outcome: 'match', validUntil: date, sourceRef: ref };
    }
    if (n.startsWith('SYN-SUSP-')) return { outcome: 'suspended', validUntil: null, sourceRef: ref };
    if (n.startsWith('SYN-REV-')) return { outcome: 'revoked', validUntil: null, sourceRef: ref };
    if (n.startsWith('SYN-DOWN-')) return { outcome: 'unavailable', validUntil: null, sourceRef: null };
    if (n.startsWith('SYN-WRONG-')) return { outcome: 'mismatch', validUntil: null, sourceRef: ref };
    return { outcome: 'not_found', validUntil: null, sourceRef: null };
  }
}

/** Bounds a lookup: a register that does not answer in time is `unavailable`, never a failure of the holder. */
export async function boundedLookup(port: CredentialRegisterPort, query: CredentialLookup, timeoutMs = 5000): Promise<CredentialRegisterResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CredentialRegisterResult>((resolve) => { timer = setTimeout(() => resolve({ outcome: 'unavailable', validUntil: null, sourceRef: null }), timeoutMs); });
  try {
    return await Promise.race([port.lookup(query).catch((): CredentialRegisterResult => ({ outcome: 'unavailable', validUntil: null, sourceRef: null })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
