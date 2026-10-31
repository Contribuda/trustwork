'use client';

import { Button, ButtonLink } from '@/components/ui';
import { useDemoHref } from '@/components/DemoHref';
import { t } from '@/app/_lib/i18n';

/** Workspace error boundary: the shell stays, the content area shows a retry and a way back to the overview (persona preserved). */
export default function WorkspaceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const href = useDemoHref();
  return (
    <section className="row" aria-labelledby="ws-error-title" style={{ maxWidth: '40rem' }}>
      <h1 id="ws-error-title" tabIndex={-1}>
        {t('ws.pageError')}
      </h1>
      <p>{t('error.generic')}</p>
      <div className="row__actions">
        <Button onPress={reset}>{t('ws.retry')}</Button>
        <ButtonLink href={href('/app')} variant="secondary">
          {t('ws.backToOverview')}
        </ButtonLink>
      </div>
    </section>
  );
}
