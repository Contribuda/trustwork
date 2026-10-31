import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MaterialPage } from '@/components/public/MaterialPage';
import { data } from '@/app/_lib/data';
import { t } from '@/app/_lib/i18n';
import { primePublicLocale } from '@/app/_lib/locale';
import { languageAlternates } from '@/app/_lib/site';

type Params = { params: Promise<{ lang: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await primePublicLocale((await params).lang);
  const { lang, slug } = await params;
  const item = await data.getPublication(slug, 'news');
  return { alternates: languageAlternates(`/news/${slug}`, lang), title: item ? item.title : t('error.notFoundTitle'), description: item?.lede };
}

/** News material: the shared material page with the primary-source card, «Ещё новости» and the news call to action. */
export default async function NewsDetailPage({ params }: Params) {
  await primePublicLocale((await params).lang);
  const { slug } = await params;
  const item = await data.getPublication(slug, 'news');
  if (!item) notFound();
  const more = (await data.listNews())
    .filter((n) => n.id !== item.id)
    .slice(0, 4);
  return (
    <MaterialPage
      item={item}
      section={{ href: '/news', label: t('publicNav.1'), topicParam: (topic) => `/news?topic=${topic}` }}
      more={more}
      moreTitle={t('detail.moreNews')}
      issue={(await data.getHome()).currentIssue}
      cta={{ title: t('news.ctaTitle'), body: t('news.ctaBody'), action: t('detail.suggest'), actionHref: '/login?next=%2Fapp%2Fpublications' }}
    />
  );
}
