import { data } from '@/app/_lib/data';
import { currentLocale, t } from '@/app/_lib/i18n';
import { withRequestLocale } from '@/app/_lib/locale';

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** RSS 2.0 of published news with the source name in the description; absolute links follow the request origin; texts in the visitor's language. */
export const GET = withRequestLocale(async (request: Request): Promise<Response> => {
  const origin = new URL(request.url).origin;
  const items = (await data.listNews())
    .slice(0, 50)
    .map(
      (card) =>
        `<item><title>${esc(card.title)}</title><link>${origin}${card.href}</link><guid isPermaLink="true">${origin}${card.href}</guid><pubDate>${new Date(card.publishedAt).toUTCString()}</pubDate><description>${esc(card.source ? `${card.lede} (${t('news.sources')}: ${card.source.name})` : card.lede)}</description></item>`,
    )
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(`${t('brand.name')} — ${t('publicNav.1')}`)}</title><link>${origin}/news</link><description>${esc(t('news.lede'))}</description><language>${currentLocale()}</language>${items}</channel></rss>`;
  return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600', vary: 'Cookie' } });
});
