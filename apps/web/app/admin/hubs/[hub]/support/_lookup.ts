import { participantsOf } from '../participants/_fixtures.js';
import { supportOf } from './_fixtures.js';

/** The support lookup of HC-30 (pure; HUBC-004). */

export function lookupData(hubId: string) {
  return { support: supportOf(hubId), participants: participantsOf(hubId) };
}
export type LookupData = ReturnType<typeof lookupData>;

/** Lookup kinds of HC-30. Exact e-mail is matched on the normalised value and never echoed back. */
export const LOOKUP_KINDS = ['email', 'name', 'company', 'identifier', 'id'] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];

export type Result = { kind: 'person'; id: string; name: string; masked: string; state: string } | { kind: 'company'; id: string; name: string; state: string };

/** The lookup itself: exact e-mail (normalised), name or company (contains), identifier and id (exact). */
export function lookup(data: LookupData, by: LookupKind, query: string): Result[] {
  const q = query.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const person = (id: string): Result[] => {
    const a = data.support.accounts.find((x) => x.summary.personId === id);
    return a ? [{ kind: 'person', id, name: a.summary.displayName, masked: a.summary.maskedEmail, state: a.summary.accountState }] : [];
  };
  const company = (id: string): Result[] => {
    const c = data.participants.companies.find((x) => x.id === id);
    return c && c.state !== 'sourced' ? [{ kind: 'company', id, name: c.name.value, state: c.state }] : [];
  };
  switch (by) {
    case 'email':
      return data.support.lookup.filter((l) => l.email === lower.normalize('NFC')).flatMap((l) => person(l.personId));
    case 'name':
      return data.support.accounts.filter((a) => a.summary.accountState !== 'erased' && a.summary.displayName.toLowerCase().includes(lower)).flatMap((a) => person(a.summary.personId));
    case 'company':
      return data.participants.companies.filter((c) => c.name.value.toLowerCase().includes(lower)).flatMap((c) => company(c.id));
    case 'identifier':
      return data.participants.companies.filter((c) => c.identifiers.some((i) => i.value.toLowerCase() === lower)).flatMap((c) => company(c.id));
    case 'id':
      return [...person(q), ...company(q)];
  }
}

