import type { LegalDocumentKind, PublicLegalDocument, PublicLegalDocuments } from '@trustwork/contracts/client';
import { NO_ACTIVE_TERMS_VERSION, termsAcceptanceVersion } from '@trustwork/contracts/client';

/**
 * The active version of one legal document for a visitor's language (QA-002 D4): the exact language, else the same
 * base language (`es` for `es-US`), else the first language the hub published it in; null when none is active.
 */
export function pickLegalDocument(documents: readonly PublicLegalDocument[], kind: LegalDocumentKind, locale: string): PublicLegalDocument | null {
  const ofKind = documents.filter((d) => d.kind === kind);
  const base = (tag: string) => tag.split('-')[0];
  return ofKind.find((d) => d.locale === locale) ?? ofKind.find((d) => base(d.locale) === base(locale)) ?? ofKind[0] ?? null;
}

/**
 * The `acceptedTermsVersion` a sign-up records: the id of the active terms text the visitor can read (the exact text by
 * id and digest), or the explicit `no-active-terms` marker while the hub has none. Never a version that looks final.
 */
export function termsVersionFor(legal: PublicLegalDocuments, locale: string): string {
  const terms = pickLegalDocument(legal.documents, 'terms', locale);
  return terms ? termsAcceptanceVersion(terms) : NO_ACTIVE_TERMS_VERSION;
}
