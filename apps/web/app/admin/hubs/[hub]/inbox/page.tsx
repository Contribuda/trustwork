import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import type { HubParams, PageSearchParams } from '../../../_components/context';
import { HubConsolePage } from '../../../_components/shell';
import { Inbox } from './_screen';

export async function generateMetadata() { await primeLocale(); return { title: t('consoleNav.inbox') }; }
export default async function InboxPage({ params, searchParams }: { params: HubParams; searchParams: PageSearchParams }) {
  const search = await searchParams;
  const query = Object.fromEntries(['view', 'item', 'demoResult'].map((key) => [key, typeof search[key] === 'string' ? search[key] : '']));
  return <HubConsolePage params={params} searchParams={searchParams} section={{ group: 'home', id: 'inbox' }}>{(ctx) => Inbox(ctx, { rest: [], query })}</HubConsolePage>;
}
