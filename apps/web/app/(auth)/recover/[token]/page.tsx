import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { ResetForm } from '@/components/auth/ResetForm';
import { fakeAuth } from '@/app/_lib/auth-fake';
import { t } from '@/app/_lib/i18n';
import { artwork } from '@/app/_lib/media';
import { primeLocale } from '@/app/_lib/locale';

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

/** The token is checked server-side before the form renders; unknown tokens get the status card, never a form. */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  await primeLocale();
  const { token } = await params;
  return (
    <AuthFrame headline={t('auth.visual.recoverHeadline')} subline={t('auth.visual.recoverSub')} media={artwork('blueprint-lines')} points={points()}>
      <ResetForm token={token} tokenState={fakeAuth.tokenState(token)} minPassword={fakeAuth.policy.minLength} />
    </AuthFrame>
  );
}
