import type { Metadata } from 'next';
import { DoneStep } from '@/components/onboarding/DoneStep';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { data } from '@/app/_lib/data';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('onboarding3.done.pageTitle') };
}

export default async function DonePage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/onboarding/done');
  return (
    <OnboardingShell name={principal.displayName} step="done">
      <DoneStep name={principal.displayName} workspaceHref={hrefFor(principal, '/app')} settingsHref={hrefFor(principal, '/app/settings')} courses={data.listCourses()} />
    </OnboardingShell>
  );
}
