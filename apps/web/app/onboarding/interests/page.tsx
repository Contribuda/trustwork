import type { Metadata } from 'next';
import { InterestsStep } from '@/components/onboarding/InterestsStep';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('onboarding3.interests.title') };
}

export default async function InterestsPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/onboarding/interests');
  return (
    <OnboardingShell name={principal.displayName} step="interests">
      <InterestsStep nextHref={hrefFor(principal, '/onboarding/profile')} backHref={hrefFor(principal, '/onboarding/goals')} skipHref={hrefFor(principal, '/onboarding/profile')} />
    </OnboardingShell>
  );
}
