'use client';

import { Button, ButtonLink } from '@/components/ui';
import { t } from '@/app/_lib/i18n';

/**
 * Last-resort error boundary: it replaces a failed document (there is no shared root layout, WEB-005), so it renders its
 * own `<html>`; the copy comes from the messages the failed document already delivered, retry via `reset`, no stack
 * traces in product UI. Page and section errors are caught by the boundaries inside each document first.
 */
export default function RootError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang={typeof document === 'undefined' ? undefined : document.documentElement.lang || undefined}>
      <body>
        <main id="main" className="page page--narrow" tabIndex={-1}>
          <section className="row" aria-labelledby="root-error-title">
            <h1 id="root-error-title" tabIndex={-1}>
              {t('error.pageTitle')}
            </h1>
            <p>{t('error.generic')}</p>
            <div className="row__actions">
              <Button onPress={reset}>{t('common.retry')}</Button>
              <ButtonLink href="/" variant="secondary">
                {t('auth.backHome')}
              </ButtonLink>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
