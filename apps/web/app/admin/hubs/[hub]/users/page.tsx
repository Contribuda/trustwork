import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import type { HubParams, PageSearchParams } from '../../../_components/context';
import { HubConsolePage } from '../../../_components/shell';
import { Users } from './_screen';

export async function generateMetadata() { await primeLocale(); return { title: t('consoleNav.users') }; }
export default async function UsersPage({ params, searchParams }: { params: HubParams; searchParams: PageSearchParams }) {
  const search = await searchParams;
  return <HubConsolePage params={params} searchParams={searchParams} section={{ group: 'home', id: 'users' }}>{(ctx) => Users(ctx, { rest: [], query: { view: typeof search.view === 'string' ? search.view : '' } })}</HubConsolePage>;
}
