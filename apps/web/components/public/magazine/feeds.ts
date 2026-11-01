export type FeedEntry = { id: string; url: string; title: string; text: string; published: string; modified: string; language: string; authors?: string[] };
export type ReaderFeed = { title: string; url: string; feedUrl: string; language: string; entries: FeedEntry[] };
export function xmlEscape(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
/** Inert text only: no HTML, remote images, tracking parameters or untrusted markup. */
export function serializeFeed(feed: ReaderFeed, format: 'rss' | 'atom' | 'json'): { body: string; type: string } {
  if (format === 'json') return { type: 'application/feed+json', body: JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: feed.title, home_page_url: feed.url, feed_url: feed.feedUrl, language: feed.language,
    items: feed.entries.map(e => ({ id: e.id, url: e.url, title: e.title, content_text: e.text, date_published: e.published, date_modified: e.modified, language: e.language })) }) };
  const x = xmlEscape;
  if (format === 'atom') return { type: 'application/atom+xml', body: `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${x(feed.language)}"><id>${x(feed.url)}</id><title>${x(feed.title)}</title><link href="${x(feed.url)}"/><link rel="self" href="${x(feed.feedUrl)}"/><updated>${x(feed.entries.map(e => e.modified).sort().at(-1) ?? '1970-01-01T00:00:00.000Z')}</updated>${feed.entries.filter(e => e.authors?.length).map(e => `<entry><id>${x(e.id)}</id><title>${x(e.title)}</title>${(e.authors ?? []).map(a => `<author><name>${x(a)}</name></author>`).join('')}<link href="${x(e.url)}"/><published>${x(e.published)}</published><updated>${x(e.modified)}</updated><content type="text">${x(e.text)}</content></entry>`).join('')}</feed>` };
  return { type: 'application/rss+xml', body: `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${x(feed.title)}</title><link>${x(feed.url)}</link><description>${x(feed.title)}</description><language>${x(feed.language)}</language>${feed.entries.map(e => `<item><title>${x(e.title)}</title><link>${x(e.url)}</link><guid isPermaLink="false">${x(e.id)}</guid><pubDate>${new Date(e.modified).toUTCString()}</pubDate><description>${x(e.text)}</description></item>`).join('')}</channel></rss>` };
}
