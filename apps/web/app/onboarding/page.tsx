import type { Metadata } from 'next';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { WhoStep } from '@/components/onboarding/WhoStep';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('onboarding3.pageTitle') };
}

/** `/onboarding`: step 1 of the optional profiling flow (R22); `?created=1` shows the «Аккаунт создан» pill. */
export default async function OnboardingPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const params = await searchParams;
  const principal = await requirePrincipal(searchParams, '/onboarding');
  return (
    <OnboardingShell name={principal.displayName} step="who">
      <WhoStep created={params.created === '1'} name={principal.displayName.split(' ')[0] ?? principal.displayName} nextHref={hrefFor(principal, '/onboarding/goals')} skipHref={hrefFor(principal, '/app')} />
    </OnboardingShell>
  );
}
