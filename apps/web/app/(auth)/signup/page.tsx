import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { SignupForm } from '@/components/auth/SignupForm';
import { DEFAULT_PASSWORD_POLICY } from '@trustwork/contracts/client';
import { getPrincipal, hrefFor, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { artwork } from '@/app/_lib/media';
import { safeNext } from '@/app/_lib/safe-next';
import { primeLocale } from '@/app/_lib/locale';
import { demoModeEnabled } from '@/app/_lib/persona';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('auth.signup.title') };
}

export default async function SignupPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const params = await searchParams;
  const principal = await getPrincipal(params);
  if (principal.kind === 'person') redirect(hrefFor(principal, '/app'));
  return (
    <AuthFrame
      headline={t('auth.visual.signupHeadline')}
      subline={t('auth.visual.signupSub')}
      media={artwork('blueprint-lines')}
      points={[
        { icon: 'people', text: t('auth.points.profile') },
        { icon: 'academy', text: t('auth.points.academy') },
        { icon: 'trust', text: t('auth.points.trust') },
      ]}
    >
      <SignupForm minPassword={DEFAULT_PASSWORD_POLICY.minLength} next={safeNext(params.next)} demoMode={demoModeEnabled()} />
    </AuthFrame>
  );
}
