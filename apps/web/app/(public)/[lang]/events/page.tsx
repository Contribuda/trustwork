import type { Metadata } from 'next';
import type { LangParams } from '@/app/_lib/locale';
import type { PageSearchParams } from '@/app/_lib/principal';
import { isFilteredQuery } from '@/app/_lib/public-paths';
import { languageAlternates, publicRobots } from '@/app/_lib/site';
import { EventsView, viewMetadata } from './view';

type Props = { params: LangParams; searchParams: PageSearchParams };

/** A filtered address (filters, search, pagination) is canonical to the list itself and not indexed (WEB-005). */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { lang } = await params;
  const query = new URLSearchParams(Object.entries(await searchParams).flatMap(([key, value]) => (Array.isArray(value) ? value.map((v) => [key, v]) : value === undefined ? [] : [[key, value]])));
  const alternates = languageAlternates('/events', lang);
  return { ...(await viewMetadata(lang)), ...(isFilteredQuery(query) ? { alternates: { canonical: alternates.canonical }, robots: { ...publicRobots(), index: false } } : { alternates }) };
}

export default async function Page({ params, searchParams }: Props) {
  return <EventsView lang={(await params).lang} query={await searchParams} />;
}
