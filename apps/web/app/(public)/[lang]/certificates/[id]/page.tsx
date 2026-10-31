import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight, BadgeCheck, CircleX } from 'lucide-react';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { SRLogo } from '@/components/public/SRMark';
import { data } from '@/app/_lib/data';
import { longDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { primePublicLocale } from '@/app/_lib/locale';
import { languageAlternates } from '@/app/_lib/site';

type Params = { params: Promise<{ lang: string; id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang, id } = await params;
  await primePublicLocale(lang);
  return { title: t('sr.certPageTitle'), alternates: languageAlternates(`/certificates/${id}`, lang) };
}

/** Public check of a platform certificate by its number: course, date, score and the holder's public card. */
export default async function CertificatePage({ params }: Params) {
  await primePublicLocale((await params).lang);
  const { id } = await params;
  const hit = await data.getPlatformCertificate(id);
  return (
    <div className="pub pub-page">
      <div className="pub-wrap srch">
        <h1 className="pub-h1">{t('sr.certPageTitle')}</h1>
        {hit ? (
          <article className="sr-cert sr-cert--page" aria-label={t('sr.certNumber', { id: hit.certificate.id })}>
            <div className="sr-cert__head">
              <span className="sr-cert__logo" aria-hidden="true">
                <SRLogo size={22} tone="white" />
              </span>
              <span className="sr-cert__valid">
                <BadgeCheck size={16} strokeWidth={2} aria-hidden="true" />
                {t('sr.certValid')}
              </span>
            </div>
            <p className="pub-kicker">{t('sr.certCourse')}</p>
            <h2 className="sr-cert__title">{typo(hit.certificate.course.title)}</h2>
            <p className="sr-cert__summary">{typo(hit.certificate.course.summary)}</p>
            <dl className="art-facts sr-cert__facts">
              <div>
                <dt>{t('sr.certHolder')}</dt>
                <dd>
                  <NextLink href={hit.holder.href} className="sr-cert__holder">
                    <PersonAvatar name={hit.holder.displayName} portrait={hit.holder.portrait} size={36} />
                    <span>
                      {hit.holder.displayName}
                      <span className="sr-cert__holder-role">{hit.holder.roleLine}</span>
                    </span>
                  </NextLink>
                </dd>
              </div>
              <div>
                <dt>{t('sr.certNumberLabel')}</dt>
                <dd>{hit.certificate.id}</dd>
              </div>
              <div>
                <dt>{t('sr.certIssuedLabel')}</dt>
                <dd>{longDate(hit.certificate.issuedAt)}</dd>
              </div>
              {hit.certificate.score !== null ? (
                <div>
                  <dt>{t('sr.certScoreLabel')}</dt>
                  <dd>{hit.certificate.score}%</dd>
                </div>
              ) : null}
            </dl>
            <p className="cp-section__note">{t('sr.certIssuedBy')}</p>
            <div className="pub-actions">
              <NextLink href={hit.holder.href} className="pub-btn pub-btn--dark">
                {t('sr.certOpenProfile')}
              </NextLink>
              <NextLink href={`${hit.holder.href}#academy`} className="pub-more">
                {t('sr.certAll')}
                <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
          </article>
        ) : (
          <div className="cp-empty">
            <CircleX size={20} strokeWidth={1.75} aria-hidden="true" />
            <p>{t('sr.certInvalid')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
