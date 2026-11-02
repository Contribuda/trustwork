import { createHash } from 'node:crypto';
import {
  REGISTER_ADAPTERS, SourcedObservationSchema, normaliseIdentifier, type SourcedObservation,
} from '../../../../../packages/contracts/src/sourced-facts.js';

/**
 * Deterministic fake register adapters (REG-001). They never call out: every answer is derived from a hash of the
 * adapter and the identifier (or record reference) so tests and demos see the same facts every time. Links point to
 * the reserved `.invalid` domain, which never resolves, so a synthetic fact can never pass for a real register record.
 * Live adapters replace these only after a hub's second person activates live mode with a credential reference.
 */
export type FakeSubject = { identifierValue: string | null; recordRef?: string };

const day = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const pick = <T>(items: readonly T[], n: number): T => items[n % items.length] as T;

function seed(adapter: string, key: string): number {
  return createHash('sha256').update(`trustwork-fake-register:${adapter}:${key}`).digest().readUInt32BE(0);
}

function link(adapter: string, ref: string): string {
  return `https://synthetic-register.invalid/${adapter}/${encodeURIComponent(ref)}`;
}

export function fakeObservations(adapterId: string, subjects: readonly FakeSubject[], now: Date): SourcedObservation[] {
  const adapter = REGISTER_ADAPTERS.find((a) => a.id === adapterId);
  if (!adapter || adapter.withoutCredentials !== 'fake') throw new Error(`no fake for register adapter ${adapterId}`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const observedAt = now.toISOString();
  const out: SourcedObservation[] = [];
  for (const subject of subjects) {
    const value = subject.identifierValue;
    const key = value === null ? (subject.recordRef ?? '') : normaliseIdentifier(value);
    if (key === '') throw new Error('a fake subject needs an identifier or a record reference');
    const n = seed(adapterId, key);
    const ref = subject.recordRef ?? key.slice(0, 32);
    const identified = { identifierKind: adapter.identifierKind, identifierValue: adapter.identifierKind === null ? null : value };
    switch (adapterId) {
      case 'us_ca_cslb_licence_file': {
        const validUntil = isoDay(today + ((n % 760) - 30) * day);
        out.push({ kind: 'licence_status', recordRef: ref, link: link(adapterId, ref), observedAt, validUntil,
          subject: { ...identified, holderKind: n % 5 === 0 ? 'natural_person' : 'organisation' },
          value: { status: validUntil < isoDay(today) ? 'expired' : pick(['active', 'active', 'active', 'suspended', 'inactive'] as const, n >>> 3),
            classifications: [pick(['A', 'B', 'C-10', 'C-36', 'C-20'], n >>> 5)], issuedOn: isoDay(today - (400 + (n % 4000)) * day) } });
        break;
      }
      case 'us_sam_entity': {
        const validUntil = isoDay(today + ((n % 395) - 30) * day);
        const expired = validUntil < isoDay(today);
        out.push({ kind: 'sam_registration', recordRef: ref, link: link(adapterId, ref), observedAt, validUntil,
          subject: { ...identified, holderKind: 'organisation' }, value: { status: expired ? 'expired' : 'active', purpose: pick(['all_awards', 'financial_assistance_only'] as const, n >>> 4) } });
        const excluded = n % 11 === 0;
        out.push({ kind: 'sam_exclusion', recordRef: ref, link: link(adapterId, ref), observedAt, validUntil: null,
          subject: { ...identified, holderKind: 'organisation' },
          value: { status: excluded ? 'excluded' : 'not_excluded', exclusionType: excluded ? 'ineligible_proceedings_pending' : null } });
        break;
      }
      case 'us_osha_inspections': {
        out.push({ kind: 'safety_inspection', recordRef: ref, link: link(adapterId, ref), observedAt, validUntil: null,
          subject: { identifierKind: null, identifierValue: null, holderKind: 'organisation' },
          value: { inspectionRef: ref, openedOn: isoDay(today - (30 + (n % 900)) * day), inspectionType: pick(['planned', 'complaint', 'accident', 'referral', 'follow_up'] as const, n >>> 2),
            status: n % 3 === 0 ? 'open' : 'closed', citations: n % 4 } });
        break;
      }
      case 'gleif_lei': {
        const validUntil = isoDay(today + ((n % 395) - 30) * day);
        out.push({ kind: 'lei_record', recordRef: ref, link: link(adapterId, ref), observedAt, validUntil,
          subject: { ...identified, holderKind: 'organisation' },
          value: { registrationStatus: validUntil < isoDay(today) ? 'lapsed' : 'issued', entityStatus: 'active' } });
        break;
      }
      default:
        throw new Error(`no fake for register adapter ${adapterId}`);
    }
  }
  return out.map((o) => SourcedObservationSchema.parse(o) as SourcedObservation);
}
