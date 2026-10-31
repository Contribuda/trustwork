import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, FileText } from 'lucide-react';
import { Breadcrumb } from '@/components/ui';
import { IssueCard } from '@/components/public/magazine/IssueCard';
import { IssueContents } from '@/components/public/magazine/IssueContents';
import { IssueHero } from '@/components/public/magazine/IssueHero';
import { data } from '@/app/_lib/data';
import { issueCover } from '@/app/_lib/media';
import { longDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { primePublicLocale } from '@/app/_lib/locale';
import { languageAlternates } from '@/app/_lib/site';

type Params = { params: Promise<{ lang: string; issue: string }> };

function parseNumber(raw: string): number | null {
  return /^\d{1,6}$/.test(raw) ? Number(raw) : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await primePublicLocale((await params).lang);
  const { lang, issue } = await params;
  const number = parseNumber(issue);
  const found = number === null ? null : await data.getIssue(number);
  if (!found) return { alternates: languageAlternates(`/magazine/${issue}`, lang), title: t('error.notFoundTitle') };
  const title = `${t('magazine.issueTitle', { number: found.issue.number })} — ${found.issue.title}`;
  return { alternates: languageAlternates(`/magazine/${issue}`, lang), title, description: found.issue.lede, openGraph: { title, description: found.issue.lede, type: 'article', images: [{ url: issueCover(found.issue.number).src, alt: t('magazine.coverAlt') }] } };
}

/** Issue page: opener (h1), full contents, corrections, PDF facts, previous / next issue and other issues. */
export default async function IssuePage({ params }: Params) {
  await primePublicLocale((await params).lang);
  const { issue: raw } = await params;
  const number = parseNumber(raw);
  const found = number === null ? null : await data.getIssue(number);
  if (!found) notFound();
  const { issue, previous, next } = found;
  const magazine = await data.getMagazine();
  const others = magazine.archive.filter((i) => i.number !== issue.number).slice(0, 3);
  return (
    <div className="pub pub-page mg">
      <div className="pub-wrap">
        <div className="pub-crumbs">
          <Breadcrumb
            items={[
              { id: 'home', label: t('publicNav.0'), href: '/' },
              { id: 'magazine', label: t('publicNav.7'), href: '/magazine' },
              { id: 'self', label: t('magazine.issueTitle', { number: issue.number }) },
            ]}
          />
        </div>
        <IssueHero issue={issue} isCurrent={next === null} headingLevel={1} contentsHref="#contents" />
        <IssueContents issue={issue} id="contents" />

        <div className="mg-issue__grid">
          <section className="pub-section mg-corrections" id="corrections" aria-labelledby="corrections-title">
            <h2 className="pub-h2 pub-h2--sm" id="corrections-title">
              {t('magazine.corrections')}
            </h2>
            {issue.corrections.length ? (
              <ul className="mg-corrections__list">
                {issue.corrections.map((c) => (
                  <li key={c.id}>
                    <strong>{typo(c.itemTitle)}</strong>
                    <span>{typo(c.summary)}</span>
                    <span className="mg-corrections__meta">{t('magazine.edition', { edition: c.toEdition, date: longDate(c.date) })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cp-section__note">{t('magazine.noCorrections')}</p>
            )}
          </section>
          <section className="pub-section mg-pdf" id="pdf" aria-labelledby="pdf-title">
            <h2 className="pub-h2 pub-h2--sm" id="pdf-title">
              <FileText size={18} strokeWidth={2} aria-hidden="true" />
              {t('magazine.downloadPdf')}
            </h2>
            {issue.pdf.state === 'ready' ? (
              <p className="mg-pdf__meta">
                <span>{t('magazine.downloadPdfMeta', { size: issue.pdf.size })}</span>
                <span>{t('magazine.pagesCount', { count: issue.pdf.pages })}</span>
                <span>{t('magazine.edition', { edition: issue.edition, date: longDate(issue.releasedAt) })}</span>
              </p>
            ) : (
              <p className="mg-pdf__meta">
                <span>{t('magazine.pdfPending')}</span>
              </p>
            )}
            <p className="cp-section__note">{issue.pdf.state === 'ready' ? t('magazine.pdfAfterLaunchReason') : t('magazine.pdfPendingReason')}</p>
          </section>
        </div>

        <nav aria-label={t('magazine.allIssues')} className="mg-issue__nav">
          {previous ? (
            <NextLink href={previous.href} className="mg-issue__nav-link">
              <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
              <span>
                <span className="mg-issue__nav-label">{t('magazine.previousIssue')}</span>
                <span className="mg-issue__nav-title">
                  № {previous.number} · {typo(previous.title)}
                </span>
              </span>
            </NextLink>
          ) : (
            <span />
          )}
          {next ? (
            <NextLink href={next.href} className="mg-issue__nav-link mg-issue__nav-link--next">
              <span>
                <span className="mg-issue__nav-label">{t('magazine.nextIssue')}</span>
                <span className="mg-issue__nav-title">
                  № {next.number} · {typo(next.title)}
                </span>
              </span>
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          ) : (
            <NextLink href="/magazine/archive" className="mg-issue__nav-link mg-issue__nav-link--next">
              <span>
                <span className="mg-issue__nav-label">{t('magazine.archiveTitle')}</span>
                <span className="mg-issue__nav-title">{t('magazine.archiveAll')}</span>
              </span>
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          )}
        </nav>

        {others.length ? (
          <section className="pub-section" aria-labelledby="others-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="others-title">
                {t('magazine.otherIssues')}
              </h2>
              <NextLink href="/magazine/archive" className="pub-more">
                {t('magazine.archiveAll')}
                <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="mg-grid">
              {others.map((i) => (
                <IssueCard key={i.id} issue={i} isCurrent={magazine.current?.number === i.number} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
