import NextLink from 'next/link';
import { RubricChip } from './rubric';
import type { IssueView } from '@/app/_lib/data/types';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

/** Full table of contents in two columns: position, title (reader deep link), lede, author, rubric and reading time. */
export function IssueContents({ issue, id = 'contents', headingLevel = 2 }: { issue: IssueView; id?: string; headingLevel?: 2 | 3 }) {
  const Heading = `h${headingLevel}` as const;
  return (
    <section className="pub-section mg-contents" id={id} aria-labelledby={`${id}-title`}>
      <div className="pub-h2-row">
        <Heading className="pub-h2" id={`${id}-title`}>
          {t('magazine.contentsTitle')}
        </Heading>
        <span className="mg-contents__count">{t('magazine.itemsCount', { count: issue.itemsCount })}</span>
      </div>
      <ol className="mg-contents__list">
        {issue.items.map((item) => (
          <li key={item.position} className="mg-entry">
            <span className="mg-entry__num">{String(item.position).padStart(2, '0')}</span>
            <div className="mg-entry__body">
              <div className="mg-entry__head">
                <NextLink href={`${issue.readerHref}#item-${item.position}`} className="mg-entry__title">
                  {typo(item.title)}
                </NextLink>
                <RubricChip rubric={item.rubric} link />
              </div>
              <p className="mg-entry__lede">{typo(item.lede)}</p>
              <p className="mg-entry__meta">
                {item.authorHref ? (
                  <NextLink href={item.authorHref} className="mg-entry__author">
                    {item.authorLabel}
                  </NextLink>
                ) : (
                  <span>{item.authorLabel}</span>
                )}
                {item.readMinutes ? <span>{t('magazine.readMinutes', { count: item.readMinutes })}</span> : null}
                {item.isCorrected ? <span className="mg-entry__corr">{t('common.corrected')}</span> : null}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
