import type { Metadata } from 'next';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { ProfileStep } from '@/components/onboarding/ProfileStep';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('onboarding3.profile.title') };
}

export default async function ProfilePage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/onboarding/profile');
  return (
    <OnboardingShell name={principal.displayName} step="profile">
      <ProfileStep name={principal.displayName} nextHref={hrefFor(principal, '/onboarding/done')} backHref={hrefFor(principal, '/onboarding/interests')} skipHref={hrefFor(principal, '/onboarding/done')} />
    </OnboardingShell>
  );
}
