import type { Metadata } from 'next';
import { REVIEW_STATUSES } from '@trustwork/i18n-runtime/review-status';
import { switcherLanguages } from '@/components/locale/languages';
import { localeReview } from '@/components/locale/review';
import { currentLocale, longDate, t } from '@/app/_lib/i18n';
import { primePublicLocale, type LangParams } from '@/app/_lib/locale';
import { languageAlternates } from '@/app/_lib/site';

export async function generateMetadata({ params }: { params: LangParams }): Promise<Metadata> {
  const { lang } = await params;
  await primePublicLocale(lang);
  return { title: t('translations.title'), alternates: languageAlternates('/translations', lang) };
}

/** What the record of a language says, only when a review is on record. */
function ReviewCell({ tag }: { tag: string }) {
  const { reviewers, reviewedOn, namespaces, reviewLink } = localeReview(tag);
  if (!reviewedOn || !reviewLink) return t('translations.noReview');
  const list = new Intl.ListFormat(currentLocale(), { type: 'conjunction' });
  return (
    <>
      {t('translations.reviewed', { reviewers: list.format(reviewers), date: longDate(reviewedOn), namespaces: list.format(namespaces) })} <a href={reviewLink}>{t('translations.reviewLink')}</a>
    </>
  );
}

/**
 * The public note about translations (INTL-007, ADR 012 decision 30): what the review labels of the language picker
 * mean and where each language offered here stands. The same facts as data: `translations/status.json`. It imports no
 * client component and no icon, so its client chunk stays empty; the bundle budget has no room for more.
 */
export default async function TranslationsPage({ params }: { params: LangParams }) {
  const active = await primePublicLocale((await params).lang);
  return (
    <div className="pub pub-page">
      <div className="pub-wrap srch">
        <article className="legal-page tr-note" aria-labelledby="translations-title">
          <p className="pub-kicker">{t('translations.kicker')}</p>
          <h1 className="pub-h1" id="translations-title">
            {t('translations.title')}
          </h1>
          <p className="pub-lede">{t('translations.lede')}</p>
          <p>{t('translations.scope')}</p>
          <h2>{t('translations.labelsHeading')}</h2>
          <dl className="tr-labels">
            {REVIEW_STATUSES.map((status) => (
              <div key={status}>
                <dt>{t(`translations.status.${status}.label`)}</dt>
                <dd>{t(`translations.status.${status}.description`)}</dd>
              </div>
            ))}
          </dl>
          <h2>{t('translations.languagesHeading')}</h2>
          <table className="tr-table">
            <thead>
              <tr>
                <th scope="col">{t('translations.columnLanguage')}</th>
                <th scope="col">{t('translations.columnStatus')}</th>
                <th scope="col">{t('translations.columnReview')}</th>
              </tr>
            </thead>
            <tbody>
              {switcherLanguages(active).map((language) => (
                <tr key={language.tag}>
                  <th scope="row" lang={language.tag}>
                    {language.name}
                  </th>
                  <td>{language.review.label}</td>
                  <td>
                    <ReviewCell tag={language.tag} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>{t('translations.helpHeading')}</h2>
          <p>{t('translations.help')}</p>
        </article>
      </div>
    </div>
  );
}
