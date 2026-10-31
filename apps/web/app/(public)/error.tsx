'use client';

import { Button, EmptyState } from '@/components/ui';
import { t } from '@/app/_lib/i18n';

/** Public segment error boundary: the shell stays, the content area shows a retry. */
export default function PublicError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page page--narrow">
      <EmptyState tone="error" title={t('common.sectionLoadError')} actions={<Button onPress={reset}>{t('common.retry')}</Button>}>
        <p>{t('error.generic')}</p>
      </EmptyState>
    </div>
  );
}
