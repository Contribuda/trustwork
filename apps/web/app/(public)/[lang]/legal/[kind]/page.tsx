import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { LegalDocumentKind, PublicLegalDocument } from '@trustwork/contracts/client';
import { FileText, TriangleAlert } from 'lucide-react';
import { data } from '@/app/_lib/data';
import { currentLocale, longDate, t } from '@/app/_lib/i18n';
import { primePublicLocale } from '@/app/_lib/locale';
import { languageAlternates } from '@/app/_lib/site';
import { pickLegalDocument } from '@/app/_lib/legal';

type Params = { params: Promise<{ lang: string; kind: string }> };

/** The two legal pages sign-up links to; the address names the page, the hub's document kind is behind it. */
const PAGES = { terms: 'terms', privacy: 'privacy_notice' } as const satisfies Record<string, LegalDocumentKind>;
type PageKey = keyof typeof PAGES;
const pageOf = (kind: string): PageKey | null => (Object.hasOwn(PAGES, kind) ? (kind as PageKey) : null);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang, kind } = await params;
  await primePublicLocale(lang);
  const page = pageOf(kind);
  if (!page) return { title: t('error.notFoundTitle') };
  return { title: t(`legal.${page}.title`), alternates: languageAlternates(`/legal/${page}`, lang) };
}

function Body({ document }: { document: PublicLegalDocument }) {
  // Plain text as the hub's staff wrote it: paragraphs on blank lines, line breaks kept, nothing interpreted as markup.
  return (
    <div className="legal-text">
      {document.body.split(/\n\s*\n/).map((paragraph, index) => (
        <p key={index} style={{ whiteSpace: 'pre-line' }}>
          {paragraph}
        </p>
      ))}
    </div>
  );
}

/**
 * Terms of use and privacy notice (QA-002 D4): the hub's active legal document version (HUB-001, activated after
 * counsel approval and a second person) in the visitor's language where the hub has one, else in the language it
 * exists in with a note. Without an active version the page says plainly that the text is a draft and not in force;
 * it never shows a text that looks final. A legal page is an open door of the jurisdiction gate (ADR 014 decision 6).
 */
export default async function LegalPage({ params }: Params) {
  const { lang, kind } = await params;
  await primePublicLocale(lang);
  const page = pageOf(kind);
  if (!page) notFound();
  const legal = await data.getLegalDocuments();
  const locale = currentLocale();
  const document = pickLegalDocument(legal.documents, PAGES[page], locale);
  const language = document && document.locale !== locale ? new Intl.DisplayNames([locale], { type: 'language' }).of(document.locale) ?? document.locale : null;
  return (
    <div className="pub pub-page">
      <div className="pub-wrap srch">
        <article className="legal-page" aria-labelledby="legal-title">
          <p className="pub-kicker">
            <FileText size={14} strokeWidth={2} aria-hidden="true" /> {t('legal.kicker')}
          </p>
          <h1 className="pub-h1" id="legal-title">
            {t(`legal.${page}.title`)}
          </h1>
          {document ? (
            <>
              <p className="pub-lede">{t('legal.inForce', { version: document.version, date: longDate(document.activatedAt ?? '') })}</p>
              {language ? <p className="pub-lede">{t('legal.otherLanguage', { language })}</p> : null}
              <Body document={document} />
              <p>
                <small>{t('legal.digest', { algorithm: 'SHA-256', digest: document.bodyDigest })}</small>
              </p>
            </>
          ) : (
            <section className="legal-draft" role="note" aria-labelledby="legal-draft-title">
              <h2 className="pub-h2" id="legal-draft-title">
                <TriangleAlert size={18} strokeWidth={2} aria-hidden="true" /> {t('legal.draftTitle')}
              </h2>
              <p>{t(`legal.${page}.draftBody`)}</p>
              <p>{t('legal.draftNoAgreement')}</p>
            </section>
          )}
        </article>
      </div>
    </div>
  );
}
