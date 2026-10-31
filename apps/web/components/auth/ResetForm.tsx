'use client';

import { useState } from 'react';
import { RecoveryCompleteCommandSchema } from '@trustwork/contracts/client';
import { Button, ButtonLink, EmptyState, Form, FormActions, FormAlert, PasswordField } from '@trustwork/ui';
import { PasswordStrength } from './PasswordStrength';
import { mapFieldErrors, useAuthForm } from './useAuthForm';
import { t } from '@/app/_lib/i18n';

const FIELD_MAP = { newPassword: { required: 'auth.error.passwordRequired', too_short: 'auth.error.passwordTooShort', too_long: 'auth.error.passwordTooLong', invalid: 'auth.error.passwordTooShort' } } as const;

/**
 * Reset step (`POST /v1/auth/recovery/complete`). The token is single-use and checked only when it is spent, so the
 * page cannot pre-check it: an invalid, expired or used token answers `access.not_found` and the form gives way to the
 * status card. Success ends every session (no automatic sign-in) and leads to the login. In a demo deployment the
 * form validates only and says that no password changes there.
 */
export function ResetForm({ token, minPassword, demoMode }: { token: string; minPassword: number; demoMode: boolean }) {
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'form' | 'invalid' | 'done'>('form');
  const form = useAuthForm();

  if (state === 'invalid') {
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

  if (state === 'done') {
    return (
      <div className="au-form">
        <h1 tabIndex={-1} className="au-form__title">
          {t('auth.reset.title')}
        </h1>
        <FormAlert tone="success" autoFocus>
          {t('auth.reset.success')}
          <p className="au-form__note">{t('auth.reset.otherSessions')}</p>
        </FormAlert>
        <FormActions>
          <ButtonLink href="/login">{t('auth.submitLogin')}</ButtonLink>
        </FormActions>
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
        <FormAlert tone={form.alert.tone} autoFocus>
          {form.alert.text}
        </FormAlert>
      ) : null}
      <Form
        validationBehavior="aria"
        {...(form.hydrated ? { 'data-hydrated': '' } : {})}
        isBusy={form.busy}
        onSubmit={async (event) => {
          event.preventDefault();
          const tokenMalformed = !RecoveryCompleteCommandSchema.shape.token.safeParse(token).success;
          if (tokenMalformed) {
            setState('invalid');
            return;
          }
          const response = await form.submit({
            path: '/v1/auth/recovery/complete',
            payload: { token, newPassword: password },
            schema: RecoveryCompleteCommandSchema,
            demo: demoMode,
            onError: (error) => mapFieldErrors(form.fieldIssues(error), FIELD_MAP, { min: minPassword }),
          });
          if (response.kind === 'demo') form.setAlert({ tone: 'info', text: t('demo.noPasswordChanged') });
          else if (response.kind === 'ok') setState('done');
          else if (response.kind === 'error' && (response.error.code === 'access.not_found' || (response.error.code === 'validation.schema' && form.fieldIssues(response.error).some((issue) => issue.path === 'token')))) setState('invalid');
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
