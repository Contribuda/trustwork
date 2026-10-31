'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { newIdempotencyKey, postJson } from '@/app/_lib/api-client';
import { t } from '@/app/_lib/i18n';

/**
 * Read marks for live notifications (COMMS-001): `POST /v1/notifications/:id/read` or `/read-all`, then the server
 * components re-render with the new counts. A failure is announced politely and nothing else changes.
 */
export function MarkReadButton({ id, all = false }: { id?: string; all?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const label = all ? t('notifications.markAllRead') : t('notifications.markRead');
  async function submit() {
    setBusy(true);
    setFailed(false);
    const result = await postJson(all ? '/v1/notifications/read-all' : `/v1/notifications/${encodeURIComponent(id ?? '')}/read`, null, { idempotencyKey: key });
    setBusy(false);
    if (result.kind === 'ok') router.refresh();
    else setFailed(true);
  }
  return (
    <>
      <button type="button" className="ws-row__action" onClick={submit} disabled={busy} aria-busy={busy}>
        {label}
      </button>
      <span role="status" aria-live="polite" className="ws-note">
        {failed ? t('notifications.markFailed') : ''}
      </span>
    </>
  );
}
