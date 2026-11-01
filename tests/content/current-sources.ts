import { withMaintenance, type DataPool } from '@trustwork/data';
import { publications, issues, type DraftInput } from '../../packages/data/src/repositories/content.js';
import { sources, importBatches, sourceItems } from '../../packages/data/src/repositories/sources.js';
import { sourceInput, item, type SourcesWorld } from '../sources/helpers.js';
import { draft, source, consentToMention, credit } from './helpers.js';

/** Real SRC-001 registration, batch activation and editorial linkage; no URL fetch or fabricated permission boolean. */
export async function currentSourceFixture(sw: SourcesWorld, admin: DataPool, number: number, options: {
  treatment?: DraftInput['treatment']; ambiguous?: boolean; format?: 'article' | 'news'; coauthor?: boolean;
} = {}) {
  const w = sw.content, p = sw.people, act = w.act.as;
  const input = sourceInput(p.stewardA, { url: `https://allow.synthetic-journal.example/feed-${number}.xml` });
  let registered = await sw.cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, input));
  registered = await sw.cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, registered.id, registered.revision, 'active'));
  const external = item(`current-${number}`);
  const stage = async (sourceId: string) => {
    const batch = await sw.cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, sourceId, { items: [external], fields: [], links: [] }));
    await sw.cmd(p.stewardB, (trx, ctx) => importBatches.decide(trx, ctx, batch.id, batch.revision, 'activate'));
    return withMaintenance(admin, trx => trx.selectFrom('source_item').selectAll().where('source_id', '=', sourceId).executeTakeFirstOrThrow());
  };
  const imported = await stage(registered.id);
  const ctxA = await w.act.elevate(p.editorA), ctxC = await w.act.elevate(p.chief);
  const marker = `Synthetic licensed ${number}`;
  let pub = await act(p.editorA, trx => publications.create(trx, ctxA, { hubId: w.hubId, owner: { kind: 'editorial' },
    format: options.format ?? 'article', articleFormat: options.format === 'news' ? null : 'practice', language: 'en', licence: 'cc_by', requiresReview: true,
    draft: draft({ title: `${marker} title`, body: `${marker} body`, sourceRefs: [source({ uri: external.url, name: `${marker} source` })], treatment: options.treatment ?? 'summary', eventTime: '2026-10-28T08:00:00.000Z' }),
    authorship: [{ kind: 'editorial', credit: `${marker} credit`, assistantAssisted: false }, ...(options.coauthor ? credit(p.coauthor, `${marker} coauthor`) : [])] }));
  if (options.coauthor) await consentToMention(admin, p.coauthor, pub.id);
  await act(p.editorA, trx => sourceItems.decide(trx, ctxA, imported.id, imported.revision, 'draft', pub.id));
  if (options.ambiguous) {
    let other = await sw.cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, { ...input, url: `${input.url}?other=1` }));
    other = await sw.cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, other.id, other.revision, 'active'));
    const second = await stage(other.id);
    await act(p.editorA, trx => sourceItems.decide(trx, ctxA, second.id, second.revision, 'draft', pub.id));
  }
  pub = await act(p.editorA, trx => publications.transition(trx, ctxA, pub.id, pub.revision, 'in_review'));
  pub = await act(p.chief, trx => publications.publish(trx, ctxC, pub.id, pub.revision, null));
  const version = (await act(p.chief, trx => publications.versions(trx, pub.id)))[0]!;
  let issue = await act(p.editorA, trx => issues.create(trx, ctxA, { hubId: w.hubId, number, date: '2026-11-01', theme: 'Synthetic rights verification', coverAssetId: null, editorLetterId: null }));
  issue = await act(p.editorA, trx => issues.curate(trx, ctxA, issue.id, issue.revision, { items: [{ position: 1, section: 'practice', publicationId: pub.id, publicationVersionId: version.id }], theme: null, coverAssetId: null, editorLetterId: null }));
  issue = await act(p.editorA, trx => issues.transition(trx, ctxA, issue.id, issue.revision, 'curated'));
  issue = await act(p.editorA, trx => issues.transition(trx, ctxA, issue.id, issue.revision, 'review'));
  issue = await act(p.chief, trx => issues.release(trx, ctxC, issue.id, issue.revision));
  return { pub, version, issue, registered, input, external, imported, marker };
}
