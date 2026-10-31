import { data } from '@/app/_lib/data';
import { t } from '@/app/_lib/i18n';

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** RSS 2.0 of published news with the source name in the description; absolute links follow the request origin. */
export function GET(request: Request): Response {
  const origin = new URL(request.url).origin;
  const items = data
    .listNews()
    .slice(0, 50)
    .map(
      (card) =>
        `<item><title>${esc(card.title)}</title><link>${origin}${card.href}</link><guid isPermaLink="true">${origin}${card.href}</guid><pubDate>${new Date(card.publishedAt).toUTCString()}</pubDate><description>${esc(card.source ? `${card.lede} (${t('news.sources')}: ${card.source.name})` : card.lede)}</description></item>`,
    )
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(`${t('brand.name')} — ${t('publicNav.1')}`)}</title><link>${origin}/news</link><description>${esc(t('news.lede'))}</description><language>ru</language>${items}</channel></rss>`;
  return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600' } });
}
