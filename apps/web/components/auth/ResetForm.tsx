'use client';

import { useState } from 'react';
import { Button, ButtonLink, EmptyState, Form, FormActions, FormAlert, PasswordField } from '@trustwork/ui';
import { PasswordStrength } from './PasswordStrength';
import { mapFieldErrors, useAuthForm } from './useAuthForm';
import { t } from '@/app/_lib/i18n';

const FIELD_MAP = { newPassword: { required: 'auth.error.passwordRequired', too_short: 'auth.error.passwordTooShort', invalid: 'auth.error.passwordTooShort' } } as const;

/** Reset step: invalid/expired tokens show a status card without a form; a valid demo token exercises the policy and hold states. */
export function ResetForm({ token, tokenState, minPassword }: { token: string; tokenState: 'valid' | 'invalid'; minPassword: number }) {
  const [password, setPassword] = useState('');
  const form = useAuthForm();

  if (tokenState === 'invalid') {
    return (
      <div className="au-form">
        <h1 tabIndex={-1} className="au-form__title">
          {t('auth.reset.title')}
        </h1>
        <EmptyState tone="error" title={t('auth.reset.tokenInvalid')} headingLevel={2} actions={<ButtonLink href="/recover">{t('auth.reset.requestNew')}</ButtonLink>}>
          <p>{t('auth.reset.tokenExpired')}</p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="au-form">
      <div className="au-form__head">
        <h1 tabIndex={-1} className="au-form__title">
          {t('auth.reset.title')}
        </h1>
        <p className="au-form__sub">{t('auth.reset.body')}</p>
      </div>
      {form.alert ? (
        <FormAlert tone={form.alert.code === 'auth.recovery.on_hold' ? 'warning' : form.alert.tone} autoFocus>
          {form.alert.text}
        </FormAlert>
      ) : null}
      <Form
        validationBehavior="aria"
        {...(form.hydrated ? { 'data-hydrated': '' } : {})}
        isBusy={form.busy}
        onSubmit={async (event) => {
          event.preventDefault();
          await form.submit('/api/auth/recover/reset', { token, newPassword: password }, (error) => mapFieldErrors(form.fieldIssues(error), FIELD_MAP, { min: minPassword }));
        }}
      >
        <div className="au-form__fields">
          <div>
            <PasswordField
              id="reset-newPassword"
              label={t('settings.security.newPassword')}
              value={password}
              onChange={setPassword}
              placeholder={t('auth.passwordNewPlaceholder')}
              autoComplete="new-password"
              description={t('auth.passwordHint', { min: minPassword })}
              errorMessage={form.fields.newPassword}
              isDisabled={form.busy}
            />
            <PasswordStrength password={password} min={minPassword} />
          </div>
          <FormActions align="stretch">
            <Button type="submit" isLoading={form.busy} pendingLabel={t('auth.reset.saving')} fullWidth>
              {t('auth.reset.submit')}
            </Button>
          </FormActions>
        </div>
      </Form>
    </div>
  );
}
