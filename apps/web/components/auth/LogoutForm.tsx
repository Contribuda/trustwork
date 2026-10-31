'use client';

import { LogOut } from 'lucide-react';
import { Button, ButtonLink, FormActions, FormAlert } from '@trustwork/ui';
import { useAuthForm } from './useAuthForm';
import { t } from '@/app/_lib/i18n';
import { withBase } from '@/app/_lib/base-path';

/** Ends the current session (`POST /v1/auth/logout`, the API clears the cookie) and returns to the home page. */
export function LogoutForm({ name }: { name: string }) {
  const form = useAuthForm();
  return (
    <div className="au-form">
      <div className="au-form__head">
        <h1 tabIndex={-1} className="au-form__title">
          {t('auth.logout.title')}
        </h1>
        <p className="au-form__sub">{t('auth.logout.body', { name })}</p>
      </div>
      {form.alert ? (
        <FormAlert tone={form.alert.tone} autoFocus>
          {form.alert.text}
        </FormAlert>
      ) : null}
      <FormActions align="stretch">
        <Button
          fullWidth
          icon={LogOut}
          isLoading={form.busy}
          pendingLabel={t('auth.logout.pending')}
          onPress={async () => {
            const response = await form.submit({ path: '/v1/auth/logout', payload: null });
            // An already ended session is signed out too: the API clears the cookie either way.
            if (response.kind === 'ok' || (response.kind === 'error' && response.error.code === 'auth.session_invalid')) window.location.assign(withBase('/'));
          }}
        >
          {t('auth.logout.submit')}
        </Button>
        <ButtonLink href="/app" variant="ghost">
          {t('auth.logout.cancel')}
        </ButtonLink>
      </FormActions>
    </div>
  );
}
