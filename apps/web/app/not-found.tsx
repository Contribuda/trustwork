import type { Metadata } from 'next';
import { ButtonLink } from '@/components/ui';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('error.notFoundTitle') };
}

/**
 * Root 404: used for unknown routes and for private slugs (never «forbidden», existence is not disclosed).
 * Primes the request-scoped locale itself: the not-found boundary renders outside the page tree, so without
 * this it would read the module-level store last written by another visitor's request.
 */
export default async function NotFound() {
  await primeLocale();
  return (
    <main id="main" className="page page--narrow" tabIndex={-1}>
      <section className="row" aria-labelledby="root-404-title">
        <h1 id="root-404-title" tabIndex={-1}>
          {t('error.notFoundTitle')}
        </h1>
        <p>{t('error.notFoundBody')}</p>
        <div className="row__actions">
          <ButtonLink href="/">{t('auth.backHome')}</ButtonLink>
        </div>
      </section>
    </main>
  );
}
