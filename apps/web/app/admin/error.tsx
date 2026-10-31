'use client';

import { Button, ButtonLink } from '@trustwork/ui';
import { t } from '@/app/_lib/i18n';

/**
 * Console error boundary: an inline error with Retry and a way to the workspace. Client components on console routes
 * receive only the root namespaces, so this uses the shared `error.*` and design-system keys.
 */
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="admin-main" className="admin-main admin-main--error" tabIndex={-1}>
      <section className="admin-state" aria-labelledby="admin-error-title" role="alert">
        <h1 id="admin-error-title" tabIndex={-1} className="admin-h1">
          {t('error.pageTitle')}
        </h1>
        <p>{t('error.generic')}</p>
        {error.digest ? <p className="admin-note">{error.digest}</p> : null}
        <div className="admin-form__actions">
          <Button onPress={reset}>{t('common.retry')}</Button>
          <ButtonLink href="/app" variant="secondary">
            {t('common.back')}
          </ButtonLink>
        </div>
      </section>
    </main>
  );
}
