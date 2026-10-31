import { rubricLabel } from '@/components/public/magazine/rubric';
import { data } from '@/app/_lib/data';
import { currentLocale, t } from '@/app/_lib/i18n';
import { withRequestLocale } from '@/app/_lib/locale';

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** RSS 2.0 of released issues (one entry per issue with its contents); absolute links follow the request origin; texts in the visitor's language. */
export const GET = withRequestLocale((request: Request): Response => {
  const origin = new URL(request.url).origin;
  const { archive } = data.getMagazine();
  const items = archive
    .map((issue) => {
      const contents = issue.items.map((i) => `${String(i.position).padStart(2, '0')}. ${i.title} (${rubricLabel(i.rubric)})`).join('; ');
      return `<item><title>${esc(`${t('magazine.issueTitle', { number: issue.number })} — ${issue.title}`)}</title><link>${origin}${issue.href}</link><guid isPermaLink="true">${origin}${issue.href}</guid><pubDate>${new Date(issue.releasedAt).toUTCString()}</pubDate><description>${esc(`${issue.lede} ${contents}`)}</description></item>`;
    })
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(`${t('brand.name')} — ${t('magazine.pageTitle')}`)}</title><link>${origin}/magazine</link><description>${esc(t('magazine.lede'))}</description><language>${currentLocale()}</language>${items}</channel></rss>`;
  return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600', vary: 'Cookie' } });
});
