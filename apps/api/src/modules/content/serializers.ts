import { DIGEST_ALGORITHM, type Correction, type Publication, type PublicationVersion } from '../../deps/contracts.js';
import type { CorrectionRow, PublicationRow, PublicationVersionRow } from './deps.js';
import { SourceViewSchema } from './schemas.js';

/**
 * Row-to-contract serializers of the content module. Timestamps are RFC 3339 UTC with milliseconds (the same text the
 * database digests); digests are rendered in the contract's `{ algorithm, value }` form.
 */
export const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());
const isoRequired = (value: Date | string): string => new Date(value).toISOString();

type StoredSource = { uri: string; name: string; kind: string; sourceTime: string | null; observedAt: string; license: string | null; allowedUses?: unknown };
/** Stored sources as readers see them (name, type, licence, allowed uses). */
export function sourcesOf(refs: unknown): ReturnType<typeof SourceViewSchema.parse>[] {
  return ((refs ?? []) as StoredSource[]).map((s) => SourceViewSchema.parse({
    uri: s.uri, name: s.name, kind: s.kind, sourceTime: s.sourceTime ?? null, observedAt: s.observedAt, license: s.license ?? null, allowedUses: s.allowedUses ?? null,
  }));
}
/** The contract's sourceRefs: exactly the digested `{ uri, sourceTime, observedAt, license }`. */
export function contractSourceRefs(refs: unknown): PublicationVersion['sourceRefs'] {
  return ((refs ?? []) as StoredSource[]).map((s) => ({ uri: s.uri, sourceTime: s.sourceTime ?? null, observedAt: s.observedAt, license: s.license ?? null }));
}

export function toContractVersion(row: PublicationVersionRow): PublicationVersion {
  if (row.status !== 'published' || !row.content_digest) throw new Error('only published versions have the contract shape');
  return {
    publicationId: row.publication_id, version: row.version, title: row.title, body: row.body, sourceRefs: contractSourceRefs(row.source_refs), eventTime: iso(row.event_time),
    publishedAt: iso(row.published_at), correctionOf: row.correction_of, correctionNote: row.correction_note, contentDigest: { algorithm: DIGEST_ALGORITHM, value: row.content_digest },
  };
}

export function toContractPublication(row: PublicationRow, parts: {
  authorship: { author_kind: string; author_person_id: string | null; author_company_id: string | null; credit: string; assistant_assisted: boolean }[];
  editors: { person_id: string }[]; topics: string[]; links: { target_person_id: string | null; target_company_id: string | null; relation: string }[];
}): Publication {
  return {
    id: row.id, format: row.format, status: row.status,
    authorship: parts.authorship.map((a) => ({
      author: a.author_kind === 'editorial' ? { kind: 'editorial' as const } : a.author_kind === 'company' ? { kind: 'company' as const, id: a.author_company_id as string } : { kind: 'person' as const, id: a.author_person_id as string },
      credit: a.credit, assistantAssisted: a.assistant_assisted,
    })),
    editors: parts.editors.map((e) => e.person_id),
    topicIds: parts.topics,
    entityLinks: parts.links.map((l) => ({ party: l.target_person_id ? { kind: 'person' as const, id: l.target_person_id } : { kind: 'company' as const, id: l.target_company_id as string }, relation: l.relation })),
    currentVersion: row.current_version, revision: row.revision, createdAt: isoRequired(row.created_at),
  };
}

export function toContractCorrection(row: CorrectionRow): Correction {
  return {
    id: row.id,
    subject: row.subject_kind === 'publication'
      ? { kind: 'publication', id: row.publication_id as string, fromVersion: row.from_version, toVersion: row.to_version }
      : { kind: 'issue', id: row.issue_id as string, fromEdition: row.from_version, toEdition: row.to_version },
    reason: row.reason, correctedBy: row.corrected_by, correctedAt: isoRequired(row.corrected_at),
  };
}
