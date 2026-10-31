import NextLink from '@/components/locale/LocalLink';
import { ArrowDown, ArrowUpRight, BookOpen, Clock, FileText } from 'lucide-react';
import { MagazineCover } from '@/components/ui';
import { PdfButton } from '@/components/public/PdfButton';
import { RubricChip, rubricLabel } from './rubric';
import type { IssueView } from '@/app/_lib/data/types';
import { issueCover } from '@/app/_lib/media';
import { longDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

/**
 * Issue opener shared by the magazine landing (h2) and the issue page (h1): tilted cover, label, title, lede,
 * facts, read / PDF actions, the correction banner and a short «В этом номере» list linking into the reader.
 */
export function IssueHero({ issue, isCurrent, headingLevel = 2, contentsHref }: { issue: IssueView; isCurrent: boolean; headingLevel?: 1 | 2; contentsHref: string }) {
  const Heading = `h${headingLevel}` as const;
  const dateRange = `${longDate(issue.dateFrom)} — ${longDate(issue.dateTo)}`;
  const topics = issue.rubrics.slice(0, 3).map(rubricLabel);
  return (
    <section className="mg-hero" aria-labelledby={`issue-${issue.number}-title`}>
      <div className="mg-hero__cover">
        <MagazineCover issue={issue.number} dateRange={dateRange} title={typo(issue.title)} topics={topics} media={issueCover(issue.number)} size="lg" href={issue.readerHref} />
      </div>
      <div className="mg-hero__text">
        <p className="mg-hero__label">
          {isCurrent ? <span className="ev-badge ev-badge--paid">{t('magazine.current')}</span> : null}
          <span>{t('magazine.issueLabel', { number: issue.number, dateRange })}</span>
        </p>
        <Heading className="mg-hero__title" id={`issue-${issue.number}-title`} {...(headingLevel === 1 ? { tabIndex: -1 } : {})}>
          {typo(issue.title)}
        </Heading>
        <p className="mg-hero__lede">{typo(issue.lede)}</p>
        <ul className="mg-hero__facts">
          <li>
            <BookOpen size={15} strokeWidth={2} aria-hidden="true" />
            {t('magazine.itemsCount', { count: issue.itemsCount })}
          </li>
          {issue.readMinutes ? (
            <li>
              <Clock size={15} strokeWidth={2} aria-hidden="true" />
              {t('magazine.readMinutes', { count: issue.readMinutes })}
            </li>
          ) : null}
          <li>
            <FileText size={15} strokeWidth={2} aria-hidden="true" />
            {issue.pdf.state === 'ready' ? t('magazine.pagesCount', { count: issue.pdf.pages }) : t('magazine.pdfPending')}
          </li>
        </ul>
        {issue.edition > 1 ? (
          <div className="mg-banner mg-hero__banner" role="status">
            <span className="mg-banner__body">
              {t('common.corrected')}: {issue.corrections.map((c) => typo(c.summary)).join('; ')}
            </span>
            <NextLink href={`${issue.href}#corrections`} className="mg-banner__link">
              {t('magazine.corrections')}
            </NextLink>
          </div>
        ) : null}
        <div className="mg-hero__actions">
          <NextLink href={issue.readerHref} className="pub-btn pub-btn--dark">
            {t('magazine.readOnline')}
            <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
          </NextLink>
          <PdfButton pdf={issue.pdf} />
        </div>
        <p className="mg-hero__hint">{t('magazine.formatsHint')}</p>
        <div className="mg-hero__toc">
          <span className="mg-hero__toc-title">{t('magazine.inThisIssue')}</span>
          <ol className="mg-toc">
            {issue.items.slice(0, 5).map((item) => (
              <li key={item.position} className="mg-toc__row">
                <span className="mg-toc__num">{String(item.position).padStart(2, '0')}</span>
                <NextLink href={`${issue.readerHref}#item-${item.position}`} className="mg-toc__link">
                  {typo(item.title)}
                </NextLink>
                <span className="mg-toc__meta">
                  <RubricChip rubric={item.rubric} />
                  {item.readMinutes ? <span className="mg-toc__min">{t('magazine.minutesShort', { count: item.readMinutes })}</span> : null}
                </span>
              </li>
            ))}
          </ol>
          {issue.items.length > 5 ? (
            <NextLink href={contentsHref} className="pub-more mg-hero__all" scroll={false}>
              {t('magazine.fullContents')} · {t('magazine.materialsCount', { count: issue.items.length })}
              <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          ) : null}
        </div>
      </div>
    </section>
  );
}
