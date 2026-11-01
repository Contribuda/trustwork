import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MaterialPage } from '@/components/public/MaterialPage';
import { data } from '@/app/_lib/data';
import { t } from '@/app/_lib/i18n';
import { primePublicLocale } from '@/app/_lib/locale';
import { languageAlternates } from '@/app/_lib/site';

type Params = { searchParams: Promise<{ version?: string }>; params: Promise<{ lang: string; slug: string }> };

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  await primePublicLocale((await params).lang);
  const { lang, slug } = await params;
  const item = await data.getPublication(slug, 'article', 'web', (await searchParams).version ? Number((await searchParams).version) : undefined);
  return { alternates: languageAlternates(`/articles/${slug}`, lang), title: item ? item.title : t('error.notFoundTitle'), description: item?.lede };
}

/** Article: the shared material page with the author card (for people), «Ещё статьи» and the articles call to action. */
export default async function ArticleDetailPage({ params, searchParams }: Params) {
  await primePublicLocale((await params).lang);
  const { slug } = await params;
  const item = await data.getPublication(slug, 'article', 'web', (await searchParams).version ? Number((await searchParams).version) : undefined);
  if (!item) notFound();
  const authorHandle = item.authorKind === 'person' && item.authorHref ? item.authorHref.split('/').pop() : null;
  const author = authorHandle ? await data.getPerson(authorHandle) : null;
  const more = (await data.listArticles())
    .filter((n) => n.id !== item.id)
    .slice(0, 4);
  return (
    <MaterialPage
      item={item}
      section={{ href: '/articles', label: t('publicNav.2'), topicParam: (topic) => `/articles?topic=${topic}` }}
      more={more}
      moreTitle={t('detail.moreArticles')}
      issue={(await data.getHome()).currentIssue}
      author={author}
      cta={{ title: t('articles.ctaTitle'), body: t('articles.ctaBody'), action: t('articles.suggest'), actionHref: '/login?next=%2Fapp%2Fpublications' }}
    />
  );
}
