import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { withBase } from '@/app/_lib/base-path';

/**
 * "Not found" inside the console document, in the visitor's language (the console layout's `VisitorDocument`). It
 * reads exactly like the public 404 and never says that a console exists: a person without a staff role, an unknown
 * hub and a section closed to the viewer look the same.
 */
export default async function AdminNotFound() {
  await primeLocale();
  return (
    <main id="main" className="page page--narrow" tabIndex={-1}>
      <section className="row" aria-labelledby="admin-404-title">
        <h1 id="admin-404-title" tabIndex={-1}>
          {t('error.notFoundTitle')}
        </h1>
        <p>{t('error.notFoundBody')}</p>
        <div className="row__actions">
          <a href={withBase('/')} className="pub-btn pub-btn--dark">
            {t('auth.backHome')}
          </a>
        </div>
      </section>
    </main>
  );
}
