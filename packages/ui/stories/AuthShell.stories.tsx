import type { Meta, StoryObj } from '@storybook/react-vite';
import { Lock, Mail } from 'lucide-react';
import { AuthShell } from '../src/components/AuthShell/AuthShell';
import { Button } from '../src/components/Button/Button';
import { Divider, Form, FormActions, FormAlert } from '../src/components/Form/Form';
import { Link } from '../src/components/Link/Link';
import { PasswordField, TextField } from '../src/components/TextField/TextField';
import { t } from '../src/i18n';
import { artworkFor } from '../src/media/index';

function LoginPage({ error, busy = false }: { error?: 'credentials' | 'rate' | 'expired' | 'offline'; busy?: boolean }) {
  return (
    <AuthShell brandHref="/" backHref="/" visual={{ headline: t('auth.visual.loginHeadline'), subline: t('auth.visual.loginSub'), media: artworkFor('timber-framing') }} privacyHref="/privacy" termsHref="/terms" helpHref="/help">
      <h1 style={{ fontSize: 'var(--text-h1-size)', lineHeight: 'var(--text-h1-line)' }}>{t('auth.login.title')}</h1>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: 24 }}>{t('auth.login.subtitle')}</p>
      <Form isBusy={busy} onSubmit={(e) => e.preventDefault()}>
        {error === 'credentials' ? (
          <FormAlert tone="error" autoFocus>
            {t('auth.error.invalidCredentials')}
          </FormAlert>
        ) : null}
        {error === 'rate' ? <FormAlert tone="warning">{t('auth.error.rateLimited', { minutes: 5 })}</FormAlert> : null}
        {error === 'expired' ? <FormAlert tone="info">{t('auth.sessionExpired')}</FormAlert> : null}
        {error === 'offline' ? <FormAlert tone="warning">{t('common.offline')}</FormAlert> : null}
        <TextField label={t('auth.email')} placeholder={t('auth.emailPlaceholder')} icon={Mail} autoComplete="username" inputMode="email" isDisabled={busy} {...(error === 'credentials' ? { defaultValue: 'example@example.ru' } : {})} />
        <PasswordField label={t('auth.password')} placeholder={t('auth.passwordPlaceholder')} icon={Lock} autoComplete="current-password" isDisabled={busy} />
        <div style={{ textAlign: 'right', marginTop: -8 }}>
          <Link href="/recover">{t('auth.forgot')}</Link>
        </div>
        <FormActions align="stretch">
          <Button type="submit" size="lg" isLoading={busy} pendingLabel={t('auth.submitting')} isDisabled={error === 'rate'}>
            {t('auth.submitLogin')}
          </Button>
        </FormActions>
        <Divider text={t('auth.or')} />
        <FormActions align="stretch">
          <Button variant="secondary" size="lg">
            {t('auth.apple')}
          </Button>
          <Button variant="secondary" size="lg">
            {t('auth.google')}
          </Button>
        </FormActions>
        <p style={{ textAlign: 'center' }}>
          {t('auth.noAccount')} <Link href="/signup">{t('auth.register')}</Link>
        </p>
      </Form>
    </AuthShell>
  );
}

const meta = { title: 'Shell/AuthShell', component: AuthShell, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof AuthShell>;
export default meta;
type Story = StoryObj;

export const Login: Story = { render: () => <LoginPage /> };
export const LoginCredentialsError: Story = { render: () => <LoginPage error="credentials" /> };
export const LoginRateLimited: Story = { render: () => <LoginPage error="rate" /> };
export const LoginSessionExpired: Story = { render: () => <LoginPage error="expired" /> };
export const LoginOffline: Story = { render: () => <LoginPage error="offline" /> };
export const LoginSubmitting: Story = { render: () => <LoginPage busy /> };
export const LoginMobile: Story = { render: () => <LoginPage />, globals: { viewport: { value: 'mobile375', isRotated: false } } };
