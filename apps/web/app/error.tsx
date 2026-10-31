'use client';

import { Button, ButtonLink } from '@/components/ui';
import { t } from '@/app/_lib/i18n';

/** Root error boundary: Russian copy, retry via `reset`, no stack traces in product UI. */
export default function RootError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
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
  );
}
