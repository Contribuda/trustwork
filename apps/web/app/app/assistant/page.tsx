import type { Metadata } from 'next';
import { AssistantPageClient } from '@/components/workspace/AssistantPageClient';
import { PageHeader } from '@/components/workspace/parts';
import { data } from '@/app/_lib/data';
import { requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('assistant.title') };
}

/** The one assistant, full page: conversation shared with the overlay, mandates, approvals, runs (R09–R11, R29). */
export default async function AssistantPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/assistant');
  const view = await data.getAssistant(principal);
  return (
    <>
      <PageHeader title={t('assistant.title')} lede={t('assistantPage.lede')} />
      <AssistantPageClient view={view} />
    </>
  );
}
