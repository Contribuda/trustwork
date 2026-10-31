'use client';

import { useState } from 'react';
import { VerifyEmailCommandSchema } from '@trustwork/contracts/client';
import { MailCheck } from 'lucide-react';
import { Button, ButtonLink, EmptyState, FormActions, FormAlert } from '@trustwork/ui';
import { useAuthForm } from './useAuthForm';
import { t } from '@/app/_lib/i18n';
import { withBase } from '@/app/_lib/base-path';

/**
 * Confirms the e-mail address with the single-use token from the message. Success sets the first session cookie and
 * opens the onboarding; an invalid, expired or used token shows the status card with a way to sign in or sign up
 * again. A demo deployment confirms nothing.
 */
export function VerifyEmailForm({ token, demoMode }: { token: string; demoMode: boolean }) {
  const form = useAuthForm();
  const [invalid, setInvalid] = useState(false);

  if (invalid) {
    return (
      <div className="au-form">
        <h1 tabIndex={-1} className="au-form__title">
          {t('auth.verifyEmail.title')}
        </h1>
        <EmptyState
          tone="error"
          title={t('auth.verifyEmail.invalid')}
          headingLevel={2}
          actions={
            <>
              <ButtonLink href="/login">{t('auth.submitLogin')}</ButtonLink>
              <ButtonLink href="/signup" variant="secondary">
                {t('auth.register')}
              </ButtonLink>
            </>
          }
        >
          <p>{t('auth.verifyEmail.invalidBody')}</p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="au-form">
      <div className="au-verify">
        <span className="au-verify__icon" aria-hidden="true">
          <MailCheck size={26} strokeWidth={1.75} />
        </span>
        <h1 tabIndex={-1} className="au-form__title">
          {t('auth.verifyEmail.title')}
        </h1>
        <p className="au-form__sub">{t('auth.verifyEmail.body')}</p>
        {form.alert ? (
          <FormAlert tone={form.alert.tone} autoFocus>
            {form.alert.text}
          </FormAlert>
        ) : null}
        <FormActions align="stretch">
          <Button
            fullWidth
            isLoading={form.busy}
            pendingLabel={t('auth.verifyEmail.confirming')}
            onPress={async () => {
              const response = await form.submit({ path: '/v1/auth/verify-email', payload: { token }, schema: VerifyEmailCommandSchema, demo: demoMode });
              if (response.kind === 'demo') form.setAlert({ tone: 'info', text: t('demo.noAccountCreated') });
              else if (response.kind === 'ok') window.location.assign(withBase('/onboarding?created=1'));
              // A malformed, expired, used or unknown token: the same status card (existence is never disclosed).
              else if (response.kind === 'invalid' || (response.kind === 'error' && (response.error.code === 'access.not_found' || response.error.code === 'validation.schema'))) setInvalid(true);
            }}
          >
            {t('auth.verifyEmail.confirm')}
          </Button>
        </FormActions>
      </div>
    </div>
  );
}
