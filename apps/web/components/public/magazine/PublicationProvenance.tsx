import type { PublicationDetail } from '@/app/_lib/data';
import { t } from '@/app/_lib/i18n';
import { absoluteUrl } from '@/app/_lib/site';
import { localPath } from '@/app/_lib/localize';

/** No inferred editor, role, review or stale-edition claims: CNT-001 does not project that provenance yet. */
export function publicationJsonLd(item: PublicationDetail, url: string) {
  return {
    '@context': 'https://schema.org', '@type': item.format === 'news' ? 'NewsArticle' : 'Article',
    headline: item.title, url, datePublished: item.publishedAt, dateModified: item.content?.modifiedAt ?? item.correctedAt ?? item.publishedAt,
    inLanguage: item.content?.language,
    ...(item.correction ? { correction: { '@type': 'CorrectionComment', text: item.correction.note, dateCreated: item.correction.date } } : {}),
    ...(item.content?.notices.length ? { description: item.content.notices.join(' ') } : {}),
    ...(item.content?.sources.length ? { citation: item.content.sources.filter(s => s.url).map(s => s.url) } : {}),
  };
}
export function PublicationProvenance({ item }: { item: PublicationDetail }) {
  if (!item.content) return null;
  return <>
    <script type="application/ld+json">{JSON.stringify(publicationJsonLd(item, absoluteUrl(localPath(item.href)))).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}</script>
    {item.content.notices.map(note => <p className="art-note" key={note}>{note}</p>)}
    {item.content.sources.length ? <section className="art-block" aria-label={t('content.sources')}>
      <h2 className="art-block__title">{t('content.sources')}</h2>
      <ul>{item.content.sources.map((source, i) => <li key={i}>
        {source.url ? <a href={source.url} rel="noopener noreferrer">{source.name}</a> : source.name}
        {source.licence ? ` · ${source.licence}` : null}
      </li>)}</ul>
    </section> : null}
  </>;
}
