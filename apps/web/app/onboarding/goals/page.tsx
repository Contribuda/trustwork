import type { Metadata } from 'next';
import { GoalsStep } from '@/components/onboarding/GoalsStep';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('onboarding3.goals.title') };
}

export default async function GoalsPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/onboarding/goals');
  return (
    <OnboardingShell name={principal.displayName} step="goals">
      <GoalsStep nextHref={hrefFor(principal, '/onboarding/interests')} backHref={hrefFor(principal, '/onboarding')} skipHref={hrefFor(principal, '/onboarding/interests')} />
    </OnboardingShell>
  );
}
