import { ArchiveSchema, FeedSchema, PublicIssueSchema, PublicPublicationSchema, PublicVersionViewSchema, PublicationSchema, type PublicPublication } from '@trustwork/contracts/client';
import { z } from 'zod';
import { currentLocale, t } from '../../i18n';
import type { Transport } from './transport';
import type { IssueView, IssueItem, PublicationDetail, TopicKey, RubricKey, Principal, MyPublicationRow } from '../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const topics = new Set(['materials', 'technologies', 'markets', 'regulation', 'projects', 'people', 'events']);
const rubrics = new Set(['analysis', 'practice', 'report', 'interview', 'people', 'projectStory', 'materials', 'opinion', 'week', 'numbers', 'qa']);
/** External references are links only. They are never fetched for previews or images. */
export function publicSourceUrl(value: string): string | null {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
/** Freeform credit is not proof of an agent being a person. Never turn AI into an author. */
export function authorCredit(p: Pick<PublicPublication, 'authorship'>): string {
  return p.authorship.filter(a => a.kind === 'editorial' || a.id !== null).map(a => a.credit.trim()).filter(c => c && !/^(ai|artificial intelligence|chatgpt|claude|codex|\u0438\u0438)$/iu.test(c)).join(' · ');
}
export function publicationView(p: PublicPublication, v: PublicPublication['current'] = p.current): PublicationDetail {
  const translation = p.editions.find(e => e.role === 'original');
  const provenance = v.provenance;
  const recorded = provenance?.availability === 'recorded' ? provenance : null;
  const notices = [
    ...(provenance?.availability === 'unavailable' ? [t('provenance.unavailable')] : []),
    ...(recorded?.kind === 'ai_assisted' ? [t('provenance.aiAssisted')] : []),
    ...(recorded?.kind === 'generated' ? [t('provenance.generated')] : []),
    ...(recorded?.kind === 'machine_translation' ? [t('provenance.machineReviewed')] : []),
    ...(recorded ? [t('provenance.declarationEvidence')] : []),
    ...(recorded?.credits.responsible_editor ? [`${t('provenance.responsibleEditor')}: ${recorded.credits.responsible_editor}`] : recorded ? [t('provenance.revoked')] : []),
    ...(recorded?.credits.translation_reviewer ? [`${t('provenance.reviewer')}: ${recorded.credits.translation_reviewer}`] : []),
    ...(recorded?.roles.length ? [`${t('provenance.declaredRoles')}: ${recorded.roles.map(role => t(`provenance.roles.${role}`)).join(' · ')}`] : []),
    ...(recorded?.translation?.stale ? [t('provenance.stale')] : []),
    ...(v.language !== currentLocale() ? [t('content.original', { language: v.language })] : []),
    ...(v.assistantAssisted || p.authorship.some(a => a.assistantAssisted) ? [t('articles.assistantAssisted')] : []),
    ...(translation?.machineAssisted ? [t('content.machineTranslation')] : []),
    ...(p.retraction ? [t('content.retracted', { note: p.retraction.note })] : []),
  ];
  return {
    live: true, id: p.id, slug: p.id, href: `/${p.format === 'news' ? 'news' : 'articles'}/${p.id}`, format: p.format,
    articleFormat: p.articleFormat === 'project_story' ? 'projectStory' : p.articleFormat,
    title: v.title, shortTitle: null, lede: '', topics: p.topics.filter((x): x is TopicKey => topics.has(x)),
    authorKind: p.authorship[0]?.kind ?? 'editorial', authorLabel: authorCredit(p), authorHref: null,
    assistantAssisted: v.assistantAssisted || p.authorship.some(a => a.assistantAssisted),
    publishedAt: p.firstPublishedAt, eventTime: v.eventTime, isCorrected: p.corrections.length > 0,
    correctedAt: p.corrections.at(-1)?.correctedAt ?? null, readMinutes: null, region: null, source: null,
    body: v.body ?? '', version: v.version,
    correction: v.correctionNote && v.correctionOf ? { note: v.correctionNote, date: v.publishedAt, fromVersion: v.correctionOf } : null,
    history: p.versions.map(x => ({ version: x.version, publishedAt: x.publishedAt, note: x.correctionNote })), mentions: [], related: [],
    content: { provenance, language: v.language, notices, sources: v.sourceRefs.map(s => ({ name: s.name, url: publicSourceUrl(s.uri), licence: s.license })), modifiedAt: p.retraction?.retractedAt ?? v.publishedAt, retracted: p.status === 'retracted' },
  };
}

/** Existing public projections only; workspace reads retain the request's session. No demo fallback. */
export function contentData(transport: Transport, pdfAvailable?: (path: string) => Promise<boolean>) {
  const read = (path: `/v1/${string}`) => transport.get(path, { anonymous: true });
  async function publication(id: string, channel: 'web' | 'feed' = 'web'): Promise<PublicPublication | null> {
    if (!UUID.test(id)) return null;
    const body = await read(`/v1/publications/${id}?channel=${channel}`);
    return body === null ? null : PublicPublicationSchema.parse(body);
  }
  async function list(format: 'news' | 'article', topic?: TopicKey) {
    const body = await read(`/v1/publications?format=${format}&limit=100${topic ? `&topic=${encodeURIComponent(topic)}` : ''}`);
    if (body === null) return [];
    // Hydrate authoritative detail projections: feed credits alone do not identify the author kind or disclosures.
    const result: PublicationDetail[] = [];
    for (const row of FeedSchema.parse(body).items) {
      const p = await publication(row.id);
      if (p && p.format === format) result.push(publicationView(p));
    }
    return result;
  }
  async function getIssueView(number: number, edition?: number, channel: 'web' | 'feed' = 'web'): Promise<IssueView | null> {
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const body = await read(`/v1/magazine/issues/${number}${edition ? `?edition=${edition}` : ''}`);
    if (body === null) return null;
    const view = PublicIssueSchema.parse(body), issue = view.issue;
    const items: IssueItem[] = [];
    for (const i of view.items) {
      const p = i.withheld ? null : await publication(i.publicationId,channel);
      const raw = p ? await read(`/v1/publications/${i.publicationId}/versions/${i.publicationVersion}?channel=${channel}`) : null;
      const pinned = raw === null ? null : PublicVersionViewSchema.parse(raw);
      const card = p ? publicationView(p) : null;
      const notices = p && pinned ? publicationView(p, pinned).content?.notices ?? [] : [];
      const correction = card?.correction?.note ?? pinned?.correctionNote;
      const format = !i.withheld && i.articleFormat === 'project_story' ? 'projectStory' : !i.withheld ? i.articleFormat : null;
      items.push({ position: i.position, section: i.section, rubric: (rubrics.has(i.section) ? i.section : format && rubrics.has(format) ? format : 'analysis') as RubricKey,
        title: pinned?.title ?? t('content.withheld'), slug: i.publicationId, publicationId: i.publicationId, version: i.publicationVersion,
        ...(card ? { publicationHref: card.href } : {}), correctionNote: correction ?? null, isCorrected: !!correction, articleFormat: card?.articleFormat ?? null,
        body: [...notices, pinned?.body ?? t('content.withheld'), ...(pinned?.sourceRefs.length ? [t('content.sources'), ...pinned.sourceRefs.map(s => [s.name, publicSourceUrl(s.uri), s.license].filter(Boolean).join(' · '))] : [])].filter(Boolean).join('\n\n'),
        lede: '', readMinutes: null, authorKind: card?.authorKind ?? 'editorial', authorLabel: pinned ? card?.authorLabel ?? '' : '', authorHref: null,
        topics: card?.topics ?? [], quiz: [], mentions: [] });
    }
    const pdfHref = `/v1/magazine/issues/${number}/pdf?edition=${issue.edition}`;
    const available = issue.renderArtifacts.some(r => r.format === 'pdf') && await pdfAvailable?.(pdfHref);
    return { id: issue.id, number: issue.number, href: `/magazine/${number}`, readerHref: `/magazine/${number}/read`, title: view.theme ?? t('magazine.issueTitle', { number }),
      lede: '', dateFrom: issue.date, dateTo: issue.date, releasedAt: view.releasedAt, nextReleaseAt: null, edition: issue.edition,
      status: issue.status === 'corrected' ? 'corrected' : 'released', itemsCount: items.length, readMinutes: 0,
      rubrics: [...new Set(items.map(i => i.rubric))], items, pdf: available ? { state: 'available', href: pdfHref } : { state: 'pending' }, poll: null, glossary: [], live: true,
      corrections: view.corrections.map(c => ({ id: `${issue.id}-${c.toEdition}`, itemTitle: '', summary: c.reason, date: c.correctedAt, fromEdition: c.fromEdition, toEdition: c.toEdition })) };
  }
  async function getMagazine(channel: 'web' | 'feed' = 'web') {
    const body = await read('/v1/magazine/issues');
    const archive: IssueView[] = [];
    if (body !== null) for (const i of ArchiveSchema.parse(body).issues) {
      const issue = await getIssueView(i.number, i.currentEdition,channel);
      if (issue) archive.push(issue);
    }
    return { current: archive[0] ?? null, archive };
  }
  async function listMyPublications(principal: Principal): Promise<MyPublicationRow[]> {
    if (principal.kind !== 'person') throw new Error('Workspace data requires a signed-in principal');
    const body = await transport.get('/v1/me/publications');
    if (body === null) return [];
    const rows = z.strictObject({ items: z.array(PublicationSchema) }).parse(body).items;
    const out: MyPublicationRow[] = [];
    for (const p of rows) {
      const raw = await transport.get(`/v1/publications/${p.id}/manage`);
      if (raw === null) continue;
      // This view is already authorized by CNT-001. Only the fields needed for this row leave the adapter.
      const v = z.object({ projection: z.literal('working'), draft: z.object({ title: z.string(), updatedAt: z.string() }).nullable(), versions: z.array(z.object({ contract: z.object({ title: z.string(), publishedAt: z.string().nullable() }) })) }).parse(raw);
      const latest = v.versions.at(-1)?.contract;
      out.push({ shownInKnown: false, id: p.id, title: v.draft?.title ?? latest?.title ?? '', format: p.format,
        authorLabel: p.authorship.map(a => a.credit).filter(c => !/^(ai|chatgpt|claude|codex|\u0438\u0438)$/iu.test(c.trim())).join(' · '), status: p.status,
        updatedAt: v.draft?.updatedAt ?? latest?.publishedAt ?? p.createdAt, shownIn: [],
        href: p.currentVersion && ['news', 'article', 'magazine_piece'].includes(p.format) ? `/${p.format === 'news' ? 'news' : 'articles'}/${p.id}` : null });
    }
    return out;
  }
  return {
    listNews: (topic?: TopicKey) => list('news', topic),
    listArticles: async (format?: string) => (await list('article')).filter(p => !format || p.articleFormat === format),
    getPublication: async (id: string, format: 'news' | 'article', channel: 'web' | 'feed' = 'web', version?: number) => { const p = await publication(id,channel); if (!p || !(p.format === format || format === 'article' && p.format === 'magazine_piece')) return null;
      if (version === undefined) return publicationView(p);
      if (!Number.isSafeInteger(version) || version < 1) return null;
      const raw = await read(`/v1/publications/${id}/versions/${version}?channel=${channel}`);
      return raw === null ? null : publicationView(p,PublicVersionViewSchema.parse(raw)); },
    getMagazine, listMyPublications,
    getIssue: async (number: number) => { const { archive } = await getMagazine(); const index = archive.findIndex(i => i.number === number); return index < 0 ? null : { issue: archive[index]!, previous: archive[index + 1] ?? null, next: archive[index - 1] ?? null }; },
    listRubrics: async () => { const { archive } = await getMagazine(); return [...rubrics].map(key => ({ key: key as RubricKey, count: archive.flatMap(i => i.items).filter(i => i.rubric === key).length, latestIssue: archive.find(i => i.rubrics.includes(key as RubricKey))?.number ?? null })); },
    listRubricEntries: async (key: RubricKey) => (await getMagazine()).archive.flatMap(issue => issue.items.filter(i => i.rubric === key).map(item => ({ item, issue }))),
    listMagazineAuthors: async () => [],
  };
}
