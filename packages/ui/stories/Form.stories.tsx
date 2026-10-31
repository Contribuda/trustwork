import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Button } from '../src/components/Button/Button';
import { Divider, Fieldset, Form, FormActions, FormAlert, FormRow } from '../src/components/Form/Form';
import { PasswordField, TextField } from '../src/components/TextField/TextField';
import { t } from '../src/i18n';

const meta = { title: 'Forms/Form helpers', component: Form } satisfies Meta<typeof Form>;
export default meta;
type Story = StoryObj;

export const Alerts: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
      <FormAlert tone="info">{t('auth.sessionExpired')}</FormAlert>
      <FormAlert tone="success" title={t('common.saved')}>
        Настройки обновлены.
      </FormAlert>
      <FormAlert tone="warning">{t('auth.error.rateLimited', { minutes: 5 })}</FormAlert>
      <FormAlert tone="error" title={t('form.errorSummaryTitle')} errors={[{ id: 'email', label: t('auth.error.emailRequired') }, { id: 'password', label: t('auth.error.passwordRequired') }]}>
        {t('form.errorCount', { count: 2 })}
      </FormAlert>
    </div>
  ),
};

export const Layout: Story = {
  render: () => (
    <Form className="" aria-label="Контакты">
      <Fieldset legend="Контакты" description="Как с вами связаться по закупке.">
        <FormRow columns={2}>
          <TextField label={t('auth.name')} />
          <TextField label={t('auth.email')} inputMode="email" autoComplete="email" />
        </FormRow>
        <TextField label="Телефон" inputMode="tel" autoComplete="tel" description="Необязательно" />
      </Fieldset>
      <Divider />
      <FormActions align="end">
        <Button variant="secondary">{t('common.cancel')}</Button>
        <Button>{t('common.save')}</Button>
      </FormActions>
    </Form>
  ),
};

function LoginForm({ initialError = false }: { initialError?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  return (
    <Form
      isBusy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        window.setTimeout(() => {
          setBusy(false);
          setError(true);
        }, 800);
      }}
    >
      {error ? (
        <FormAlert tone="error" autoFocus>
          {t('auth.error.invalidCredentials')}
        </FormAlert>
      ) : null}
      <TextField label={t('auth.email')} name="email" autoComplete="username" inputMode="email" isRequired isDisabled={busy} />
      <PasswordField label={t('auth.password')} name="password" autoComplete="current-password" isRequired isDisabled={busy} />
      <FormActions align="stretch">
        <Button type="submit" isLoading={busy} pendingLabel={t('auth.submitting')}>
          {t('auth.submitLogin')}
        </Button>
      </FormActions>
      <Divider text={t('auth.or')} />
      <FormActions align="stretch">
        <Button variant="secondary">{t('auth.apple')}</Button>
        <Button variant="secondary">{t('auth.google')}</Button>
      </FormActions>
    </Form>
  );
}

export const SubmitFlow: Story = { render: () => <LoginForm /> };
export const SubmitError: Story = { render: () => <LoginForm initialError /> };
