import type { Metadata } from 'next';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { jurisdictionGateDescription } from '@/app/_lib/jurisdiction';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('jurisdiction.pageTitle'), robots: { index: false, follow: false } };
}

/**
 * The refusal page of the jurisdiction gate (SANC-001, ADR 014 decision 6). `proxy.ts` renders it in place of any page
 * requested from a restricted place, in the visitor's language. It says plainly and kindly what the law is, that it is
 * not about the person, that nothing in an account is deleted and whom to contact if the location is wrong, and it
 * credits the geolocation dataset when the dataset's licence asks for it. It names nobody and shows no address.
 */
export default async function RestrictedPage() {
  await primeLocale();
  const gate = jurisdictionGateDescription();
  return (
    <main id="main" className="page page--narrow" tabIndex={-1}>
      <section className="row" aria-labelledby="restricted-title">
        <h1 id="restricted-title" tabIndex={-1}>
          {t('jurisdiction.title')}
        </h1>
        <p>{t('jurisdiction.lead')}</p>
        <p>{t('jurisdiction.notPersonal')}</p>
        <p>{t('jurisdiction.nothingDeleted')}</p>
        <p>{t('jurisdiction.wrongPlace')}</p>
        {gate.attribution ? (
          <p>
            <small>{t('jurisdiction.attribution', { attribution: gate.attribution })}</small>
          </p>
        ) : null}
      </section>
    </main>
  );
}
