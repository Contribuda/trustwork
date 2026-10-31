import { data } from '@/app/_lib/data';
import { currentLocale, t } from '@/app/_lib/i18n';
import { withPublicLocale } from '@/app/_lib/locale';
import { localPath } from '@/app/_lib/localize';
import { absoluteUrl } from '@/app/_lib/site';

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** RSS 2.0 of published news with the source name in the description; absolute links on the deployment's public URL (CFG-001) in the feed's language (its URL prefix, ADR 012 decision 27). */
export const GET = withPublicLocale(async (): Promise<Response> => {
  const link = (path: string) => absoluteUrl(localPath(path));
  const items = (await data.listNews())
    .slice(0, 50)
    .map(
      (card) =>
        `<item><title>${esc(card.title)}</title><link>${link(card.href)}</link><guid isPermaLink="true">${link(card.href)}</guid><pubDate>${new Date(card.publishedAt).toUTCString()}</pubDate><description>${esc(card.source ? `${card.lede} (${t('news.sources')}: ${card.source.name})` : card.lede)}</description></item>`,
    )
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(`${t('brand.name')} — ${t('publicNav.1')}`)}</title><link>${link('/news')}</link><description>${esc(t('news.lede'))}</description><language>${currentLocale()}</language>${items}</channel></rss>`;
  return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600' } });
});
