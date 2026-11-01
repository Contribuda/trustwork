import { data } from '@/app/_lib/data';
import { currentLocale, t } from '@/app/_lib/i18n';
import { localPath } from '@/app/_lib/localize';
import { absoluteUrl } from '@/app/_lib/site';
import { serializeFeed, type FeedEntry } from './feeds';

export async function contentFeedResponse(section: 'news' | 'articles' | 'magazine', format: 'rss' | 'atom' | 'json'): Promise<Response> {
  const link = (path: string) => absoluteUrl(localPath(path));
  const entries: FeedEntry[] = [];
  if (section === 'magazine') {
    for (const issue of (await data.getMagazine()).archive) entries.push({ id: link(issue.href), url: link(issue.readerHref), title: issue.title, language: currentLocale(), published: issue.releasedAt,
      modified: issue.corrections.at(-1)?.date ?? issue.releasedAt, authors: [...new Set(issue.items.map(i => i.authorLabel).filter(Boolean))],
      text: [...issue.corrections.map(c => `${t('common.corrected')}: ${c.summary}`), ...issue.items.map(i => `${i.title}\n${i.correctionNote ? `${t('common.corrected')}: ${i.correctionNote}\n` : ''}${i.body}`)].join('\n\n') });
  } else {
    const cards = section === 'news' ? await data.listNews() : await data.listArticles();
    for (const card of cards.slice(0, 50)) {
      const item = await data.getPublication(card.slug, section === 'news' ? 'news' : 'article');
      if (!item) continue;
      entries.push({ id: link(item.href), url: link(item.href), title: item.title, published: item.publishedAt,
        authors: item.authorLabel ? [item.authorLabel] : [], modified: item.content?.modifiedAt ?? item.correctedAt ?? item.publishedAt, language: item.content?.language ?? currentLocale(),
        text: [item.correction ? `${t('common.corrected')}: ${item.correction.note}` : '', ...(item.content?.notices ?? []), item.body,
          ...(item.content?.sources.map(s => `${s.name}${s.url ? ` (${s.url})` : ''}${s.licence ? ` · ${s.licence}` : ''}`) ?? [])].filter(Boolean).join('\n\n') });
    }
  }
  const filename = format === 'rss' ? 'feed.xml' : format === 'atom' ? 'atom.xml' : 'feed.json';
  const serialized = serializeFeed({ title: `${t('brand.name')} · ${t(section === 'news' ? 'publicNav.1' : section === 'articles' ? 'articles.title' : 'magazine.pageTitle')}`, url: link(`/${section}`), feedUrl: link(`/${section}/${filename}`), language: currentLocale(), entries }, format);
  return new Response(serialized.body, { headers: { 'content-type': `${serialized.type}; charset=utf-8`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}
