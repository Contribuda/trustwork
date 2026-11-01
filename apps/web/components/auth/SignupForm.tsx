'use client';

import { useState } from 'react';
import { SignupCommandSchema } from '@trustwork/contracts/client';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight, CheckCircle2, MailCheck } from 'lucide-react';
import { Button, Checkbox, Form, FormActions, FormAlert, PasswordField, TextField } from '@trustwork/ui';
import { PasswordStrength } from './PasswordStrength';
import { ProviderButtons } from './ProviderButtons';
import { mapFieldErrors, useAuthForm } from './useAuthForm';
import { t } from '@/app/_lib/i18n';

const FIELD_MAP = {
  name: { required: 'auth.error.nameRequired', invalid: 'auth.error.nameRequired' },
  email: { required: 'auth.error.emailRequired', format: 'auth.error.emailFormat', invalid: 'auth.error.emailFormat' },
  password: { required: 'auth.error.passwordRequired', too_short: 'auth.error.passwordTooShort', invalid: 'auth.error.passwordTooShort' },
  acceptedTermsVersion: { required: 'auth.error.termsRequired', invalid: 'auth.error.termsRequired' },
} as const;

/**
 * Signup with exactly one name field (`auth.name`, no surname), e-mail, password with the policy hint and a
 * non-blocking strength meter, terms checkbox whose links (the legal pages) are separate tab stops, and a «what happens
 * next» list. The recorded terms version is the active terms text's id, or `no-active-terms` with a visible note while
 * the hub has none (QA-002 D4).
 * `POST /v1/auth/signup` answers `202 verification_sent` for new and existing addresses alike (no account
 * enumeration, no session before verification): the form shows «Confirm your email» and can send the message
 * again. A demo deployment validates only, says that nothing was created or sent and offers the onboarding preview.
 */
export function SignupForm({ minPassword, next, demoMode, termsVersion, termsDraft }: { minPassword: number; next: string | null; demoMode: boolean; termsVersion: string; termsDraft: boolean }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);
  const form = useAuthForm();
  const resend = useAuthForm();
  const payload = (): Record<string, unknown> => ({ name, email, password, ...(terms ? { acceptedTermsVersion: termsVersion } : {}) });

  if (verifyPending) {
    return (
      <div className="au-form">
        <div className="au-verify">
          <span className="au-verify__icon" aria-hidden="true">
            <MailCheck size={26} strokeWidth={1.75} />
          </span>
          <h1 tabIndex={-1} className="au-form__title">
            {t('auth.verify.title')}
          </h1>
          <FormAlert tone="info" autoFocus>
            {t('auth.verify.body', { email })}
            {demoMode ? <p className="au-form__note">{t('demo.noEmailSent')}</p> : null}
          </FormAlert>
          {resend.alert ? <FormAlert tone={resend.alert.tone}>{resend.alert.text}</FormAlert> : null}
          <ol className="au-steps">
            <li>
              <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />
              {t('auth.verify.step1')}
            </li>
            <li>
              <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />
              {t('auth.verify.step2')}
            </li>
            <li>
              <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />
              {t('auth.verify.step3')}
            </li>
          </ol>
          <FormActions>
            <Button
              variant="secondary"
              isDisabled={demoMode}
              isLoading={resend.busy}
              pendingLabel={t('auth.submitting')}
              onPress={async () => {
                const response = await resend.submit({ path: '/v1/auth/signup', payload: payload() });
                if (response.kind === 'ok') resend.setAlert({ tone: 'success', text: t('auth.verify.resent') });
              }}
            >
              {t('auth.verify.resend')}
            </Button>
            <Button variant="ghost" onPress={() => setVerifyPending(false)}>
              {t('auth.verify.changeEmail')}
            </Button>
          </FormActions>
          {demoMode ? (
            <NextLink href="/onboarding?persona=reader&created=1" className="au-link au-link--demo">
              {t('auth.verify.demoOnboarding')}
              <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="au-form">
      <div className="au-form__head">
        <h1 tabIndex={-1} className="au-form__title">
          {t('auth.signup.title')}
        </h1>
        <p className="au-form__sub">{t('auth.signup.subtitle')}</p>
      </div>
      {form.alert ? (
        <FormAlert
          tone={form.alert.tone}
          autoFocus
          errors={Object.entries(form.fields)
            .filter(([, v]) => v)
            .map(([k, v]) => ({ id: `signup-${k}`, label: v! }))}
        >
          {form.alert.text}
        </FormAlert>
      ) : null}
      <Form
        validationBehavior="aria"
        {...(form.hydrated ? { 'data-hydrated': '' } : {})}
        aria-label={t('auth.formTitleSignup')}
        isBusy={form.busy}
        onSubmit={async (event) => {
          event.preventDefault();
          const response = await form.submit({ path: '/v1/auth/signup', payload: payload(), schema: SignupCommandSchema, demo: demoMode, onError: (error) => mapFieldErrors(form.fieldIssues(error), FIELD_MAP, { min: minPassword }) });
          if (response.kind === 'ok' || response.kind === 'demo') {
            form.setAlert(null);
            try {
              window.sessionStorage.setItem('trustwork.signup.email', email);
            } catch {
              /* storage unavailable */
            }
            setVerifyPending(true);
          }
        }}
      >
        <div className="au-form__fields">
          <TextField id="signup-name" label={t('auth.name')} value={name} onChange={setName} placeholder={t('auth.namePlaceholder')} autoComplete="name" errorMessage={form.fields.name} isDisabled={form.busy} />
          <TextField
            id="signup-email"
            label={t('auth.email')}
            value={email}
            onChange={setEmail}
            placeholder={t('auth.emailPlaceholder')}
            autoComplete="email"
            inputMode="email"
            type="email"
            errorMessage={form.fields.email}
            isDisabled={form.busy}
          />
          <div>
            <PasswordField
              id="signup-password"
              label={t('auth.password')}
              value={password}
              onChange={setPassword}
              placeholder={t('auth.passwordNewPlaceholder')}
              autoComplete="new-password"
              description={t('auth.passwordHint', { min: minPassword })}
              errorMessage={form.fields.password}
              isDisabled={form.busy}
            />
            <PasswordStrength password={password} min={minPassword} />
          </div>
          <div id="signup-acceptedTermsVersion">
            <Checkbox isSelected={terms} onChange={setTerms} isDisabled={form.busy} {...(form.fields.acceptedTermsVersion ? { isInvalid: true, 'aria-describedby': 'signup-terms-error' } : {})}>
              {t('auth.acceptTermsPrefix')} <NextLink href="/legal/terms">{t('auth.termsLink')}</NextLink> {t('auth.and')} <NextLink href="/legal/privacy">{t('auth.privacyLink')}</NextLink>
            </Checkbox>
            {termsDraft ? <p className="au-form__note">{t('auth.termsDraft')}</p> : null}
            {form.fields.acceptedTermsVersion ? (
              <p id="signup-terms-error" className="au-form__error" role="alert">
                {form.fields.acceptedTermsVersion}
              </p>
            ) : null}
          </div>
          <FormActions align="stretch">
            <Button type="submit" isLoading={form.busy} pendingLabel={t('auth.signingUp')} fullWidth>
              {t('auth.submitSignup')}
            </Button>
          </FormActions>
        </div>
      </Form>
      <div className="au-divider" role="separator" aria-label={t('auth.or')}>
        <span>{t('auth.or')}</span>
      </div>
      <ProviderButtons mode="signup" />
      <p className="au-form__switch">
        <span>{t('auth.haveAccount')}</span>
        <NextLink href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'} className="au-link">
          {t('auth.submitLogin')}
        </NextLink>
      </p>
    </div>
  );
}
