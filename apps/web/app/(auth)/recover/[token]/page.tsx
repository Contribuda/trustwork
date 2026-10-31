import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { ResetForm } from '@/components/auth/ResetForm';
import { DEFAULT_PASSWORD_POLICY } from '@trustwork/contracts/client';
import { t } from '@/app/_lib/i18n';
import { artwork } from '@/app/_lib/media';
import { primeLocale } from '@/app/_lib/locale';
import { demoModeEnabled } from '@/app/_lib/persona';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('auth.reset.title') };
}

/** Built per request: the labels follow the active locale. */
function points() {
  return [
    { icon: 'trust' as const, text: t('auth.points.recoverSafe') },
    { icon: 'companies' as const, text: t('auth.points.companies') },
    { icon: 'magazine' as const, text: t('auth.points.magazine') },
  ];
}

/** The single-use token is checked when it is spent (`POST /v1/auth/recovery/complete`); an invalid one turns the form into the status card. */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  await primeLocale();
  const { token } = await params;
  return (
    <AuthFrame headline={t('auth.visual.recoverHeadline')} subline={t('auth.visual.recoverSub')} media={artwork('blueprint-lines')} points={points()}>
      <ResetForm token={token} minPassword={DEFAULT_PASSWORD_POLICY.minLength} demoMode={demoModeEnabled()} />
    </AuthFrame>
  );
}
