import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { SignupForm } from '@/components/auth/SignupForm';
import { DEFAULT_PASSWORD_POLICY } from '@trustwork/contracts/client';
import { getPrincipal, hrefFor, type PageSearchParams } from '@/app/_lib/principal';
import { currentLocale, t } from '@/app/_lib/i18n';
import { data } from '@/app/_lib/data';
import { termsVersionFor } from '@/app/_lib/legal';
import { NO_ACTIVE_TERMS_VERSION } from '@trustwork/contracts/client';
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
  // The terms version sign-up records: the active terms text the visitor can read, or the explicit draft marker.
  const termsVersion = termsVersionFor(await data.getLegalDocuments(), currentLocale());
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
      <SignupForm minPassword={DEFAULT_PASSWORD_POLICY.minLength} next={safeNext(params.next)} demoMode={demoModeEnabled()} termsVersion={termsVersion} termsDraft={termsVersion === NO_ACTIVE_TERMS_VERSION} />
    </AuthFrame>
  );
}
