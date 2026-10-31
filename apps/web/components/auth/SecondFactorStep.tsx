'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Form, FormActions, FormAlert, TextField } from '@trustwork/ui';
import { useAuthForm } from './useAuthForm';
import { t } from '@/app/_lib/i18n';
import { RECOVERY_CODE, TOTP_CODE } from './second-factor-codes';

/**
 * Second step of sign-in (BE-004): after the password (or a provider) the API answers `second_factor_required` and keeps
 * the pending sign-in in a short-lived cookie; this form sends the code from the authenticator app, or one recovery
 * code, to `POST /v1/auth/second-factor`. A wrong code clears the field and says so without blaming the password; an
 * expired or spent sign-in sends the person back to the first step. The heading takes focus when the step appears.
 */
export function SecondFactorStep({ onDone, onRestart }: { onDone: () => void; onRestart: () => void }) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const form = useAuthForm();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <div className="au-form">
      <div className="au-form__head">
        <h1 ref={heading} tabIndex={-1} className="au-form__title">
          {t('auth.secondFactor.title')}
        </h1>
        <p className="au-form__sub">{recovery ? t('auth.secondFactor.recoveryBody') : t('auth.secondFactor.body')}</p>
      </div>
      {form.alert ? (
        <FormAlert tone={form.alert.tone} autoFocus>
          {form.alert.text}
        </FormAlert>
      ) : null}
      <Form
        validationBehavior="aria"
        {...(form.hydrated ? { 'data-hydrated': '' } : {})}
        aria-label={t('auth.secondFactor.formTitle')}
        isBusy={form.busy}
        onSubmit={async (event) => {
          event.preventDefault();
          const value = code.trim();
          if (!(recovery ? RECOVERY_CODE : TOTP_CODE).test(value)) {
            setFieldError(recovery ? t('auth.secondFactor.recoveryFormat') : t('auth.secondFactor.codeFormat'));
            return;
          }
          setFieldError(undefined);
          const response = await form.submit({ path: '/v1/auth/second-factor', payload: { proof: { method: recovery ? 'recovery_code' : 'totp', code: value } } });
          if (response.kind === 'ok') {
            onDone();
            return;
          }
          if (response.kind !== 'error') return;
          setCode('');
          if (response.error.code === 'auth.invalid_credentials') form.setAlert({ tone: 'error', text: t('auth.secondFactor.invalidCode'), code: response.error.code });
          else if (response.error.code === 'auth.session_invalid') form.setAlert({ tone: 'warning', text: t('auth.secondFactor.expired'), code: response.error.code });
        }}
      >
        <div className="au-form__fields">
          <TextField
            id="login-code"
            label={recovery ? t('auth.secondFactor.recoveryLabel') : t('auth.secondFactor.codeLabel')}
            description={recovery ? t('auth.secondFactor.recoveryHint') : t('auth.secondFactor.codeHint')}
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            errorMessage={fieldError}
            isDisabled={form.busy}
            isRequired
          />
          <FormActions align="stretch">
            <Button type="submit" isLoading={form.busy} pendingLabel={t('auth.submitting')} isDisabled={form.alert?.code === 'auth.throttled'} fullWidth>
              {t('auth.secondFactor.submit')}
            </Button>
          </FormActions>
          <div className="au-form__row">
            <Button
              variant="ghost"
              size="sm"
              onPress={() => {
                setRecovery(!recovery);
                setCode('');
                setFieldError(undefined);
                form.setAlert(null);
              }}
            >
              {recovery ? t('auth.secondFactor.useApp') : t('auth.secondFactor.useRecovery')}
            </Button>
            <Button variant="ghost" size="sm" onPress={onRestart}>
              {t('auth.secondFactor.restart')}
            </Button>
          </div>
        </div>
      </Form>
    </div>
  );
}
