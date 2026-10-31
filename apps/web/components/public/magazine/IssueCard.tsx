import NextLink from '@/components/locale/LocalLink';
import { ArrowUpRight } from 'lucide-react';
import { MagazineCover } from '@/components/ui';
import { PdfButton } from '@/components/public/PdfButton';
import { rubricLabel } from './rubric';
import type { IssueView } from '@/app/_lib/data/types';
import { issueCover } from '@/app/_lib/media';
import { longDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

/** Archive card: medium cover, label, title, facts (items, pages, reading time) and the read / PDF actions. */
export function IssueCard({ issue, isCurrent = false }: { issue: IssueView; isCurrent?: boolean }) {
  const dateRange = `${longDate(issue.dateFrom)} — ${longDate(issue.dateTo)}`;
  return (
    <article className="mg-card">
      <div className="mg-card__cover">
        <MagazineCover issue={issue.number} dateRange={dateRange} title={typo(issue.title)} topics={issue.rubrics.slice(0, 3).map(rubricLabel)} media={issueCover(issue.number)} size="sm" href={issue.href} />
      </div>
      <div className="mg-card__body">
        <p className="mg-card__label">
          <strong>№ {issue.number}</strong>
          <span>{dateRange}</span>
          {isCurrent ? <span className="ev-badge ev-badge--paid">{t('magazine.current')}</span> : null}
        </p>
        <h3 className="mg-card__title">
          <NextLink href={issue.href}>{typo(issue.title)}</NextLink>
        </h3>
        <p className="mg-card__lede">{typo(issue.lede)}</p>
        <p className="mg-card__facts">
          <span>{t('magazine.itemsCount', { count: issue.itemsCount })}</span>
          {issue.pdf.state === 'ready' ? <span>{t('magazine.pagesCount', { count: issue.pdf.pages })}</span> : null}
          {issue.readMinutes ? <span>{t('magazine.readMinutes', { count: issue.readMinutes })}</span> : null}
          {issue.edition > 1 ? <span className="mg-entry__corr">{t('common.corrected')}</span> : null}
        </p>
        <div className="mg-card__actions">
          <NextLink href={issue.readerHref} className="pub-btn pub-btn--dark pub-btn--sm">
            {t('magazine.readOnline')}
            <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
          </NextLink>
          <PdfButton pdf={issue.pdf} size="sm" />
        </div>
      </div>
    </article>
  );
}
