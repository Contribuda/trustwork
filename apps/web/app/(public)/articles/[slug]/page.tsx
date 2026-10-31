import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MaterialPage } from '@/components/public/MaterialPage';
import { data } from '@/app/_lib/data';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await primeLocale();
  const { slug } = await params;
  const item = data.getPublication(slug, 'article');
  return { title: item ? item.title : t('error.notFoundTitle'), description: item?.lede };
}

/** Article: the shared material page with the author card (for people), «Ещё статьи» and the articles call to action. */
export default async function ArticleDetailPage({ params }: Params) {
  await primeLocale();
  const { slug } = await params;
  const item = data.getPublication(slug, 'article');
  if (!item) notFound();
  const authorSlug = item.authorKind === 'person' && item.authorHref ? item.authorHref.split('/').pop() : null;
  const author = authorSlug ? data.getPerson(authorSlug) : null;
  const more = data
    .listArticles()
    .filter((n) => n.id !== item.id)
    .slice(0, 4);
  return (
    <MaterialPage
      item={item}
      section={{ href: '/articles', label: t('publicNav.2'), topicParam: (topic) => `/articles?topic=${topic}` }}
      more={more}
      moreTitle={t('detail.moreArticles')}
      issue={data.getHome().currentIssue}
      author={author}
      cta={{ title: t('articles.ctaTitle'), body: t('articles.ctaBody'), action: t('articles.suggest'), actionHref: '/login?next=%2Fapp%2Fpublications' }}
    />
  );
}
