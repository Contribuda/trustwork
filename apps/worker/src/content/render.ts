import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PublicProvenanceSchema } from '../../../../packages/contracts/src/provenance.js';

const Version = z.object({ provenance: PublicProvenanceSchema.optional(), title: z.string(), body: z.string().nullable(), language: z.string(), version: z.number(), publishedAt: z.string(), assistantAssisted: z.boolean(), correctionNote: z.string().nullable(),
  sourceRefs: z.array(z.object({ name: z.string(), uri: z.string(), license: z.string().nullable().optional() })) });
export const RenderSnapshotSchema = z.object({ revisionId: z.uuid(), issue: z.object({ number: z.number(), edition: z.number(), date: z.string(), theme: z.string().nullable(),
  digest: z.string(), corrections: z.array(z.object({ reason: z.string() })) }), items: z.array(z.object({ position: z.number(), section: z.string(), version: Version,
  publication: z.object({ current: z.object({ version: z.number(), correctionNote: z.string().nullable() }), authorship: z.array(z.object({ kind: z.string(), id: z.string().nullable(), credit: z.string(), assistantAssisted: z.boolean() })),
    corrections: z.array(z.object({ reason: z.string() })), editions: z.array(z.object({ role: z.string(), machineAssisted: z.boolean() })) }) })) });
export type RenderSnapshot = z.infer<typeof RenderSnapshotSchema>;
export type PdfRenderer = (snapshot: unknown, signal: AbortSignal) => Promise<Buffer>;
/** Narrow optional-runtime boundary: backend images do not install a browser or its development types. */
interface LocalBrowser {
  close(): Promise<void>;
  newContext(options: { javaScriptEnabled: false; serviceWorkers: 'block' }): Promise<{
    route(pattern: string, handler: (route: { abort(): Promise<void> }) => Promise<void>): Promise<void>;
    newPage(): Promise<{
      setContent(html: string, options: { waitUntil: 'load'; timeout: number }): Promise<void>;
      pdf(options: { format: 'A4'; printBackground: true; tagged: true; displayHeaderFooter: true; headerTemplate: string; footerTemplate: string }): Promise<Buffer>;
    }>;
  }>;
}
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const locales = new Set(['en', 'es', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn']);

/** Text only: no HTML/Markdown interpretation, remote images, URL previews, scripts or renderer navigation. */
export const renderLocalPdf: PdfRenderer = async (input, signal) => {
  if (JSON.stringify(input).length > 4_000_000) throw new Error('Content render input exceeds the local renderer limit');
  const snapshot = RenderSnapshotSchema.parse(input);
  const requested = snapshot.items[0]?.version.language ?? 'en';
  const locale = locales.has(requested) ? requested : locales.has(requested.split('-')[0]!) ? requested.split('-')[0]! : 'en';
  const dictionary = JSON.parse(await readFile(new URL(`../../../web/locales/${locale}/content.json`, import.meta.url), 'utf8')) as { content: Record<string, string> };
  const label = (key: string, args: Record<string, string> = {}) => {
    const value = dictionary.content[key];
    if (!value) throw new Error(`Missing content PDF locale key: ${key}`);
    return value.replace(/\{(\w+)\}/g, (_, name: string) => args[name] ?? `{${name}}`);
  };
  const provenanceDictionary = JSON.parse(await readFile(new URL(`../../../web/locales/${locale}/provenance.json`, import.meta.url), 'utf8')) as { provenance: Record<string,string | Record<string,string>> };
  const provLabel = (key: string) => { const value = provenanceDictionary.provenance[key]; if (typeof value !== 'string') throw new Error(`Missing provenance label: ${key}`); return value; };
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(snapshot.issue.date));
  const edition = label('pdfEdition', { number: number(snapshot.issue.number), edition: number(snapshot.issue.edition), date });
  const paragraph = (text: string, className = '') => `<p class="${className}">${escape(text)}</p>`;
  const html = `<!doctype html><html lang="${escape(locale)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(edition)}</title><style>
    @page { size: A4; margin: 22mm 20mm 23mm; }
    body { font: 11pt/1.65 sans-serif; color: #172c2b; overflow-wrap: anywhere; }
    h1 { font: bold 28pt/1.18 serif; margin: 12mm 0 8mm; } h2 { font: bold 22pt/1.25 serif; margin: 5mm 0; break-after: avoid; }
    .masthead { border-top: 4pt solid #17654e; padding-top: 5mm; font-size: 10pt; } .note { border-left: 2pt solid #bd7e2a; padding-left: 4mm; }
    p { white-space: pre-wrap; margin: 0 0 4mm; orphans: 3; widows: 3; } .credit, .source { font-size: 9pt; }
    article { break-before: page; } .toc { margin: 8mm 0; }
  </style></head><body><div class="masthead">${escape(edition)}</div><h1>${escape(snapshot.issue.theme ?? edition)}</h1>
  ${snapshot.issue.corrections.map(c => paragraph(label('pdfCorrection', { note: c.reason }), 'note')).join('')}
  <div class="toc">${snapshot.items.map(i => paragraph(`${number(i.position)}. ${i.version.title}`)).join('')}</div>
  ${snapshot.items.map(i => {
    const v = i.version;
    const prov = v.provenance;
    const recorded = prov?.availability === 'recorded' ? prov : null;
    const provenanceLines = [
      ...(prov?.availability === 'unavailable' ? [provLabel('unavailable')] : []),
      ...(recorded ? [provLabel('declarationEvidence')] : []),
      ...(recorded && recorded.kind !== 'none' ? [provLabel(recorded.kind === 'machine_translation' ? 'machineReviewed' : recorded.kind === 'generated' ? 'generated' : 'aiAssisted')] : []),
      ...(recorded?.credits.responsible_editor ? [`${provLabel('responsibleEditor')}: ${recorded.credits.responsible_editor}`] : recorded ? [provLabel('revoked')] : []),
      ...(recorded?.credits.translation_reviewer ? [`${provLabel('reviewer')}: ${recorded.credits.translation_reviewer}`] : []),
      ...(recorded?.roles.length ? [`${provLabel('declaredRoles')}: ${recorded.roles.map(role => (provenanceDictionary.provenance.roles as Record<string,string>)[role]).join(' · ')}`] : []),
      ...(recorded?.translation ? [`${provLabel('originalLink')}: ${recorded.translation.originalLanguage} · ${number(recorded.translation.originalVersion)}`] : []),
      ...(recorded?.translation?.stale ? [provLabel('stale')] : []),
    ];
    const credits = i.publication.authorship.filter(a => (a.kind === 'editorial' || a.id !== null) && !/^(ai|artificial intelligence|chatgpt|claude|codex|\u0438\u0438)$/iu.test(a.credit.trim())).map(a => a.credit).join(' · ');
    return `<article lang="${escape(v.language)}"><div class="masthead">${escape(edition)}</div><h2>${escape(v.title)}</h2>${paragraph(credits, 'credit')}
      ${paragraph(label('pdfVersion', { version: number(v.version), language: v.language }), 'credit')}
      ${[...new Set([v.correctionNote, i.publication.current.correctionNote].filter((note): note is string => !!note))].map(note => paragraph(label('pdfCorrection', { note }), 'note')).join('')}
      ${v.assistantAssisted || i.publication.authorship.some(a => a.assistantAssisted) ? paragraph(label('pdfAssisted'), 'note') : ''}
      ${i.publication.editions.some(e => e.role === 'original' && e.machineAssisted) ? paragraph(label('machineTranslation'), 'note') : ''}
      ${provenanceLines.map(line => paragraph(line,'note')).join('')}
      ${(v.body ?? '').split(/\n\s*\n/).map(p => paragraph(p)).join('')}
      ${v.sourceRefs.length ? `<h3>${escape(label('sources'))}</h3>` : ''}
      ${v.sourceRefs.map(s => paragraph([s.name, s.uri, s.license].filter(Boolean).join(' · '), 'source')).join('')}</article>`;
  }).join('')}</body></html>`;
  signal.throwIfAborted();
  // Resolve only when explicitly enabled in a local runtime with the installed browser package.
  const localBrowserPackage: string = 'playwright';
  const { chromium } = await import(localBrowserPackage) as { chromium: { launch(options: { headless: true }): Promise<LocalBrowser> } };
  const browser = await chromium.launch({ headless: true });
  const abort = () => { void browser.close(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
    const bytes = await page.pdf({ format: 'A4', printBackground: true, tagged: true, displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;text-align:center;font-size:9px;color:#555"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
    signal.throwIfAborted();
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    await browser.close();
  }
};
