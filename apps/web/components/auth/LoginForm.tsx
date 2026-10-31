'use client';

import { useEffect, useState } from 'react';
import { LoginCommandSchema } from '@trustwork/contracts/client';
import NextLink from 'next/link';
import { Button, Form, FormActions, FormAlert, PasswordField, TextField } from '@trustwork/ui';
import { ProviderButtons } from './ProviderButtons';
import { SecondFactorStep } from './SecondFactorStep';
import { mapFieldErrors, useAuthForm } from './useAuthForm';
import { errorMessage, t } from '@/app/_lib/i18n';
import { safeNext } from '@/app/_lib/safe-next';
import { withBase } from '@/app/_lib/base-path';

const FIELD_MAP = {
  email: { required: 'auth.error.emailRequired', format: 'auth.error.emailFormat', invalid: 'auth.error.emailFormat' },
  password: { required: 'auth.error.passwordRequired', invalid: 'auth.error.passwordRequired' },
} as const;

/**
 * Classic e-mail/password login (R21) against `POST /v1/auth/login` (WEB-004): contract validation in the browser,
 * then the API sets the session cookie and the browser opens `next` (or the workspace) with a full navigation so every
 * server component renders for the new session. Invalid credentials clear the password and keep the e-mail; «Forgot
 * the password?» carries the e-mail to `/recover` (WCAG 2.2 3.3.7). The e-mail typed at signup is prefilled once from
 * the browser session, never from other users. Demo deployments validate only and say that nobody signs in there.
 * A person with a second factor continues with `SecondFactorStep` (BE-004), also when a provider sign-in returns with
 * `?auth=second_factor_required`.
 */
export function LoginForm({ next, reason, demoMode, secondFactor = false }: { next: string | null; reason: string | null; demoMode: boolean; secondFactor?: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState<'password' | 'second_factor'>(secondFactor ? 'second_factor' : 'password');
  const form = useAuthForm();
  const throttled = form.alert?.code === 'auth.throttled';
  useEffect(() => {
    try {
      const remembered = window.sessionStorage.getItem('trustwork.signup.email');
      if (remembered) setEmail(remembered);
    } catch {
      /* storage unavailable */
    }
  }, []);

  if (stage === 'second_factor') {
    return <SecondFactorStep onDone={() => window.location.assign(withBase(safeNext(next) ?? '/app'))} onRestart={() => setStage('password')} />;
  }

  return (
    <div className="au-form">
      <div className="au-form__head">
        <h1 tabIndex={-1} className="au-form__title">
          {t('auth.login.title')}
        </h1>
        <p className="au-form__sub">{t('auth.login.subtitle')}</p>
      </div>
      {reason === 'expired' ? <FormAlert tone="info">{t('auth.sessionExpired')}</FormAlert> : null}
      {reason === 'jurisdiction_hold' && !form.alert ? <FormAlert tone="warning">{errorMessage('auth.jurisdiction_hold')}</FormAlert> : null}
      {form.alert ? (
        <FormAlert
          tone={form.alert.tone}
          autoFocus
          errors={Object.entries(form.fields)
            .filter(([, v]) => v)
            .map(([k, v]) => ({ id: `login-${k}`, label: v! }))}
        >
          {form.alert.text}
        </FormAlert>
      ) : null}
      <Form
        validationBehavior="aria"
        {...(form.hydrated ? { 'data-hydrated': '' } : {})}
        aria-label={t('auth.formTitleLogin')}
        isBusy={form.busy}
        onSubmit={async (event) => {
          event.preventDefault();
          const response = await form.submit({ path: '/v1/auth/login', payload: { email, password }, schema: LoginCommandSchema, demo: demoMode, onError: (error) => mapFieldErrors(form.fieldIssues(error), FIELD_MAP) });
          if (response.kind === 'demo') form.setAlert({ tone: 'info', text: t('demo.noAccountCreated') });
          else if (response.kind === 'ok' && response.body.status === 'second_factor_required') {
            setPassword('');
            setStage('second_factor');
          } else if (response.kind === 'ok') window.location.assign(withBase(safeNext(next) ?? '/app'));
          else if (response.kind === 'error' && response.error.code === 'auth.invalid_credentials') setPassword('');
        }}
      >
        <div className="au-form__fields">
          <TextField
            id="login-email"
            label={t('auth.email')}
            value={email}
            onChange={setEmail}
            placeholder={t('auth.emailPlaceholder')}
            autoComplete="username"
            inputMode="email"
            type="email"
            errorMessage={form.fields.email}
            isDisabled={form.busy}
          />
          <PasswordField
            id="login-password"
            label={t('auth.password')}
            value={password}
            onChange={setPassword}
            placeholder={t('auth.passwordPlaceholder')}
            autoComplete="current-password"
            errorMessage={form.fields.password}
            isDisabled={form.busy}
          />
          <div className="au-form__row">
            <NextLink href={email ? `/recover?email=${encodeURIComponent(email)}` : '/recover'} className="au-link">
              {t('auth.forgot')}
            </NextLink>
          </div>
          <FormActions align="stretch">
            <Button type="submit" isLoading={form.busy} pendingLabel={t('auth.submitting')} isDisabled={throttled} fullWidth>
              {t('auth.submitLogin')}
            </Button>
          </FormActions>
        </div>
      </Form>
      <div className="au-divider" role="separator" aria-label={t('auth.or')}>
        <span>{t('auth.or')}</span>
      </div>
      <ProviderButtons mode="login" />
      <p className="au-form__switch">
        <span>{t('auth.noAccount')}</span>
        <NextLink href={safeNext(next) ? `/signup?next=${encodeURIComponent(safeNext(next)!)}` : '/signup'} className="au-link">
          {t('auth.register')}
        </NextLink>
      </p>
    </div>
  );
}
