import { ButtonLink, Link, StatusChip } from '@/components/ui';
import { PdfButton } from '@/components/public/PdfButton';
import type { IssueView } from '@/app/_lib/data';
import { longDate, t } from '@/app/_lib/i18n';
import { rubricLabel } from '@/components/public/magazine/rubric';

/** Issue block shared by `/magazine` (current) and `/magazine/[issue]`: cover, label, actions, short TOC, correction banner. */
export function IssueBlock({ issue, isCurrent, headingLevel = 2 }: { issue: IssueView; isCurrent: boolean; headingLevel?: 1 | 2 }) {
  const Heading = `h${headingLevel}` as const;
  const SubHeading = headingLevel === 1 ? 'h2' : 'h3';
  const dateRange = `${longDate(issue.dateFrom)} — ${longDate(issue.dateTo)}`;
  return (
    <section className="with-rail with-rail--cover" aria-labelledby={`issue-${issue.number}-title`}>
      <div className="cover" aria-hidden="true">
        <span>№ {issue.number}</span>
        <span>{issue.title}</span>
      </div>
      <div style={{ display: 'grid', gap: 'var(--space-3)', alignContent: 'start' }}>
        <p className="meta">
          {isCurrent ? (
            <StatusChip tone="info" size="sm">
              {t('magazine.current')}
            </StatusChip>
          ) : null}
          <span>{t('magazine.issueLabel', { number: issue.number, dateRange })}</span>
        </p>
        <Heading id={`issue-${issue.number}-title`} className="story__title" style={{ fontSize: 'var(--text-h2-size)', lineHeight: 'var(--text-h2-line)' }} {...(headingLevel === 1 ? { tabIndex: -1 } : {})}>
          {issue.title}
        </Heading>
        <p className="lede">{issue.lede}</p>
        <p className="meta">
          <span>{t('magazine.itemsCount', { count: issue.itemsCount })}</span>
          {issue.pdf.state === 'ready' ? <span>{t('magazine.pagesCount', { count: issue.pdf.pages })}</span> : null}
          <span>{t('magazine.edition', { edition: issue.edition, date: longDate(issue.releasedAt) })}</span>
        </p>
        {issue.edition > 1 ? (
          <div className="banner" role="status">
            <span>
              {t('common.corrected')}: {issue.corrections.map((c) => c.summary).join('; ')}
            </span>
            <Link href={`${issue.href}#corrections`}>{t('magazine.corrections')}</Link>
          </div>
        ) : null}
        <div className="row__actions">
          <ButtonLink href={issue.readerHref}>{t('magazine.readOnline')}</ButtonLink>
          <PdfButton pdf={issue.pdf} />
        </div>
        <p className="sr-note">{t('magazine.formatsHint')}</p>
        <div>
          <SubHeading className="story__title" style={{ fontSize: 'var(--text-body-lg-size)', marginBottom: 'var(--space-2)' }}>
            {t('magazine.inThisIssue')}
          </SubHeading>
          <ol className="list" style={{ gap: 'var(--space-2)' }}>
            {issue.items.map((item) => (
              <li key={item.position} className="meta">
                <span>{item.position}.</span>
                <Link href={`${issue.readerHref}#item-${item.position}`}>{item.title}</Link>
                <span>{rubricLabel(item.rubric)}</span>
                {item.isCorrected ? <span>{t('common.corrected')}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
