'use client';

import { ButtonLink } from '@/components/ui';
import { useDemoHref } from '@/components/DemoHref';
import { t } from '@/app/_lib/i18n';

/** Workspace 404 inside the shell: unknown sections and objects the principal may not see (never «forbidden»); persona preserved. */
export default function WorkspaceNotFound() {
  const href = useDemoHref();
  return (
    <section className="row" aria-labelledby="ws-404-title" style={{ maxWidth: '40rem' }}>
      <h1 id="ws-404-title" tabIndex={-1}>
        {t('ws.notFoundTitle')}
      </h1>
      <p>{t('ws.notFoundBody')}</p>
      <div className="row__actions">
        <ButtonLink href={href('/app')} variant="secondary">
          {t('ws.backToOverview')}
        </ButtonLink>
      </div>
    </section>
  );
}
