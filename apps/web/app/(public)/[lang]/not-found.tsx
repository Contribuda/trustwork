import NextLink from '@/components/locale/LocalLink';
import { t } from '@/app/_lib/i18n';

/**
 * Public 404 inside the public document and shell, in the language of the address (WEB-005): unknown public addresses
 * and entries that do not exist or are not public (existence is never disclosed). The layout primed the locale; this
 * boundary renders after it.
 */
export default function PublicNotFound() {
  return (
    <div className="page page--narrow">
      <section className="row" aria-labelledby="public-404-title">
        <h1 id="public-404-title" tabIndex={-1}>
          {t('error.notFoundTitle')}
        </h1>
        <p>{t('error.notFoundBody')}</p>
        <div className="row__actions">
          <NextLink href="/" className="pub-btn pub-btn--dark">
            {t('auth.backHome')}
          </NextLink>
        </div>
      </section>
    </div>
  );
}
