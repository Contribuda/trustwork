'use client';

import { useState } from 'react';
import NextLink from 'next/link';
import { MailCheck } from 'lucide-react';
import { Button, Form, FormActions, FormAlert, TextField } from '@trustwork/ui';
import { mapFieldErrors, useAuthForm } from './useAuthForm';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

const FIELD_MAP = { email: { required: 'auth.error.emailRequired', format: 'auth.error.emailFormat', invalid: 'auth.error.emailFormat' } } as const;

/** Recovery request: neutral confirmation regardless of whether the address exists; e-mail prefilled from login. */
export function RecoverForm({ initialEmail }: { initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const form = useAuthForm();

  if (sent) {
    return (
      <div className="au-form">
        <div className="au-verify">
          <span className="au-verify__icon" aria-hidden="true">
            <MailCheck size={26} strokeWidth={1.75} />
          </span>
          <h1 tabIndex={-1} className="au-form__title">
            {t('auth.recover.title')}
          </h1>
          <FormAlert tone="success" autoFocus>
            {t('auth.recover.sent')}
            <p className="au-form__note">{t('demo.noEmailSent')}</p>
          </FormAlert>
          <FormActions>
            <Button variant="secondary" isDisabled>
              {t('auth.recover.resend')}
            </Button>
            <NextLink href="/login" className="au-link">
              {t('auth.recover.backToLogin')}
            </NextLink>
          </FormActions>
        </div>
      </div>
    );
  }

  return (
    <div className="au-form">
      <div className="au-form__head">
        <h1 tabIndex={-1} className="au-form__title">
          {t('auth.recover.title')}
        </h1>
        <p className="au-form__sub">{typo(t('auth.recover.body'))}</p>
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
          const response = await form.submit('/api/auth/recover', { email }, (error) => mapFieldErrors(form.fieldIssues(error), FIELD_MAP));
          if (response.kind === 'ok') setSent(true);
        }}
      >
        <div className="au-form__fields">
          <TextField
            id="recover-email"
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
          <FormActions align="stretch">
            <Button type="submit" isLoading={form.busy} pendingLabel={t('auth.recover.sending')} fullWidth>
              {t('auth.recover.submit')}
            </Button>
          </FormActions>
        </div>
      </Form>
      <p className="au-form__switch">
        <NextLink href="/login" className="au-link">
          {t('auth.recover.backToLogin')}
        </NextLink>
      </p>
      <details className="au-details">
        <summary>{t('auth.recover.noMailbox')}</summary>
        <p>{typo(t('auth.recover.noMailboxBody'))}</p>
      </details>
    </div>
  );
}
