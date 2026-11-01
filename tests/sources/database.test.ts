import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { computeDigest } from '@trustwork/contracts';
import { bindTransaction, withMaintenance, type Transaction } from '@trustwork/data';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import { publicContent, publications, type ContentStaffContext } from '../../packages/data/src/repositories/content.js';
import {
  importBatches, publicSources, recordLinks, sourceItems, sources, sourcesWorker, sponsoredPolicy, takedowns, type StagedItemInput,
} from '../../packages/data/src/repositories/sources.js';
import type { SourceItemRow, SourceRow } from '../../packages/data/src/schema/sources.js';
import { contentSourceRef, MOST_RESTRICTIVE_USES, parseRsl, sponsoredPolicyDigestInput } from '../../packages/contracts/src/sources.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { refused } from '../content/helpers.js';
import { buildSourcesWorld, DISPLAY_ONLY, item, OPEN_USES, robotsInput, sourceInput, uuid, type SourcesWorld } from './helpers.js';

/**
 * SRC-001 on real PostgreSQL under the runtime role: the registry with licence flags, legal basis, robots, terms and RSL
 * checks; separation of duties for activation, batches, items and links; the human review queue (no imported item is
 * published without a person's decision); the egress rule (a display-only source never reaches a model provider or a
 * peer); takedown with tombstones; the sponsored policy (off by default, second person, never a ranking input); and
 * concurrency. Every person, hub, source and site is synthetic.
 */
const db = await provisionTestDatabase('sources_db');

test('source registry persistence under the restricted runtime role', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const w: SourcesWorld = await buildSourcesWorld(db.admin, db.app);
  const p = w.people;
  const as = <T>(person: string, fn: (trx: Transaction) => Promise<T>) => w.act.as(person, fn);
  const cmd = <T>(person: string, fn: (trx: Transaction, ctx: ContentStaffContext) => Promise<T>) => w.cmd(person, fn);
  const anon = async <T>(fn: (trx: Transaction) => Promise<T>): Promise<T> => {
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      return await fn(bindTransaction(client));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };
  const count = async (query: string, params: unknown[] = []) => (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

  /** Registers (stewardA) and activates (stewardB) a source. */
  const activeSource = async (over: Parameters<typeof sourceInput>[1] = {}): Promise<SourceRow> => {
    const s = await cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(p.stewardA, over)));
    return cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, s.id, s.revision, 'active'));
  };
  /** Stages (stewardA) and activates (stewardB) a batch; returns its items. */
  const importItems = async (sourceId: string, items: StagedItemInput[], fields: Parameters<typeof importBatches.stage>[3]['fields'] = []): Promise<SourceItemRow[]> => {
    const batch = await cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, sourceId, { items, fields, links: [] }));
    await cmd(p.stewardB, (trx, ctx) => importBatches.decide(trx, ctx, batch.id, batch.revision, 'activate'));
    return as(p.stewardA, (trx) => sourceItems.list(trx, w.hubId, { batchId: batch.id }));
  };
  /** The editor's decision `draft`: a CNT-001 editorial news draft citing the item with `uses`, then the decision, in one transaction. */
  const draftFromItem = (editor: string, row: SourceItemRow, opts: { uses?: Record<string, boolean>; assisted?: boolean } = {}) => cmd(editor, async (trx, ctx) => {
    const source = await sources.get(trx, row.source_id) as SourceRow;
    const uses = opts.uses ?? await sourceItems.effectiveUses(trx, row.id);
    const ref = contentSourceRef({ name: source.name, readerKind: source.reader_kind as never, licence: { kind: source.licence_kind as never, name: source.licence_name } },
      { url: row.url, sourceTime: row.source_time?.toISOString() ?? null, observedAt: row.observed_at.toISOString(), effectiveUses: uses as never });
    const pub = await publications.create(trx, ctx, {
      hubId: w.hubId, owner: { kind: 'editorial' }, format: 'news', articleFormat: null, language: 'en', licence: 'all_rights', requiresReview: true,
      draft: { title: row.title, body: '', language: 'en', sourceRefs: [ref], treatment: 'headline_link', eventTime: '2026-10-28T08:00:00.000Z', assistantAssisted: opts.assisted ?? false },
      authorship: [{ kind: 'editorial', credit: 'Synthetic editorial office', assistantAssisted: opts.assisted ?? false }],
    });
    const decided = await sourceItems.decide(trx, ctx, row.id, row.revision, 'draft', pub.id);
    return { pub, decided };
  });

  await t.test('the runtime role writes nothing directly and only hub staff with a registry permission read the registry', async () => {
    const s = await cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(p.stewardA)));
    await refused(as(p.stewardA, (trx) => sql`UPDATE trustwork.source SET status = 'active' WHERE id = ${s.id}::uuid`.execute(trx)), '42501');
    await refused(as(p.stewardA, (trx) => sql`INSERT INTO trustwork.source_item (hub_id) VALUES (${w.hubId}::uuid)`.execute(trx)), '42501');
    await refused(as(p.stewardA, (trx) => sql`DELETE FROM trustwork.source WHERE id = ${s.id}::uuid`.execute(trx)), '42501');
    assert.equal((await as(p.stewardB, (trx) => sources.get(trx, s.id)))?.id, s.id);
    assert.equal((await as(p.editorA, (trx) => sources.get(trx, s.id)))?.id, s.id, 'editors read sources for the review queue');
    for (const who of [p.moderator, p.outsider, p.writer, p.otherSteward]) assert.equal(await as(who, (trx) => sources.get(trx, s.id)), undefined, 'no row for people without a registry permission at this hub');
    assert.equal(await anon((trx) => trx.selectFrom('source').select('id').executeTakeFirst()), undefined, 'nothing without a principal');
    // Negative authorization for every command family.
    await refused(cmd(p.moderator, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(p.moderator))), '42501', 'admin.forbidden');
    await refused(cmd(p.editorA, (trx, ctx) => sources.setStatus(trx, ctx, s.id, s.revision, 'active')), '42501', 'admin.forbidden');
    await refused(cmd(p.otherSteward, (trx, ctx) => sources.setStatus(trx, ctx, s.id, s.revision, 'active')), '42501', 'admin.forbidden');
    await refused(cmd(p.officerA, (trx, ctx) => sources.takedown(trx, ctx, { sourceId: s.id, itemId: null }, 'legal_demand', 'Synthetic')), '42501', 'admin.forbidden');
    await refused(as(p.stewardA, (trx) => sources.register(trx, { elevationId: uuid(), requestId: 'req-x', reasonCode: 'x', reasonText: 'x' }, w.hubId, sourceInput(p.stewardA))), '42501', 'admin.elevation_required');
    // The audit row of the registration names the actor and the reason.
    assert.equal(await count("SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'source.registered' AND object_id = $1 AND actor_person_id = $2", [s.id, p.stewardA]), 1);
  });

  await t.test('provider preparation enforces live elevation and exact hub permission in PostgreSQL', async () => {
    const source = await activeSource();
    const [row] = await importItems(source.id, [item('prepare')]);
    assert.ok(row);
    const invalid = { elevationId: uuid(), requestId: 'prepare-invalid', reasonCode: 'test', reasonText: 'Synthetic test' };
    await refused(as(p.stewardA, (trx) => sources.preparePolicyCheck(trx, invalid, w.hubId, source.id)), '42501', 'admin.elevation_required');
    await refused(as(p.editorA, (trx) => sourceItems.prepareAssist(trx, invalid, w.hubId, row.id, row.revision)), '42501', 'admin.elevation_required');
    await refused(cmd(p.editorA, (trx, ctx) => sources.preparePolicyCheck(trx, ctx, w.hubId, source.id)), '42501', 'admin.forbidden');
    await refused(cmd(p.stewardA, (trx, ctx) => sourceItems.prepareAssist(trx, ctx, w.hubId, row.id, row.revision)), '42501', 'admin.forbidden');
    await refused(cmd(p.otherSteward, (trx, ctx) => sources.preparePolicyCheck(trx, ctx, w.hubId, source.id)), '42501', 'admin.forbidden');
    await refused(cmd(p.editorA, (trx, ctx) => sourceItems.prepareAssist(trx, ctx, w.otherHubId, row.id, row.revision)), '42501', 'admin.forbidden');
    await refused(cmd(p.editorA, (trx, ctx) => sourceItems.prepareAssist(trx, ctx, w.hubId, row.id, row.revision + 1)), '40001', 'sources.revision_conflict');
  });

  await t.test('licence rules hold for every writer: no licence, rewriting without text, personal data without a legal basis', async () => {
    const restricted = { ...MOST_RESTRICTIVE_USES, displayHeadlineAndLink: true, displaySummary: true, indexForSearch: true };
    const ok = await cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(p.stewardA, { licence: { kind: 'unknown', name: null, url: null, agreementRef: null }, allowedUses: restricted })));
    assert.equal(ok.licence_kind, 'unknown');
    await refused(cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(p.stewardA, { licence: { kind: 'all_rights_reserved', name: null, url: null, agreementRef: null }, allowedUses: { ...restricted, storeFullText: true } }))), '23514', 'sources.licence_restricts_use');
    await refused(cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(p.stewardA, { allowedUses: { ...OPEN_USES, storeFullText: false } }))), '23514', 'sources.rewrite_needs_full_text');
    await refused(cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(p.stewardA, { personalData: true }))), '23514', 'sources.legal_basis_required');
    await refused(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.source SET allowed_uses = ${JSON.stringify(OPEN_USES)}::jsonb WHERE id = ${ok.id}::uuid`.execute(trx)), '23514');
  });

  await t.test('separation of duties and crawling preconditions on activation', async () => {
    const feed = await cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(p.stewardA)));
    await refused(cmd(p.stewardA, (trx, ctx) => sources.setStatus(trx, ctx, feed.id, feed.revision, 'active')), '42501', 'sources.self_activation');
    const active = await cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, feed.id, feed.revision, 'active'));
    assert.equal(active.activated_by, p.stewardB);
    await refused(cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, feed.id, feed.revision, 'paused')), '40001', 'sources.revision_conflict');

    const page = await cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(p.stewardA, { kind: 'web_page', url: 'https://allow.synthetic-maker.example/guides/' })));
    await refused(cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, page.id, page.revision, 'active')), '23514', 'sources.robots_not_allowed');
    await cmd(p.stewardA, (trx, ctx) => sources.recordRobots(trx, ctx, page.id, robotsInput('allow.synthetic-maker.example', { allowed: false, status: 'forbidden', allowedPaths: [], disallowedPaths: ['/'] })));
    let row = await as(p.stewardB, (trx) => sources.get(trx, page.id)) as SourceRow;
    await refused(cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, page.id, row.revision, 'active')), '23514', 'sources.robots_not_allowed');
    await refused(cmd(p.stewardA, (trx, ctx) => sources.recordRobots(trx, ctx, page.id, robotsInput('other.synthetic-maker.example'))), '23514', 'sources.robots_domain');
    await cmd(p.stewardA, (trx, ctx) => sources.recordRobots(trx, ctx, page.id, robotsInput('allow.synthetic-maker.example')));
    row = await as(p.stewardB, (trx) => sources.get(trx, page.id)) as SourceRow;
    await refused(cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, page.id, row.revision, 'active')), '23514', 'sources.terms_not_permitted');
    row = await cmd(p.stewardA, (trx, ctx) => sources.recordTerms(trx, ctx, page.id, row.revision, { termsUrl: 'https://allow.synthetic-maker.example/terms', termsDigest: 'c'.repeat(64), automatedAccess: 'unclear', notes: 'Synthetic review' }));
    await refused(cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, page.id, row.revision, 'active')), '23514', 'sources.terms_not_permitted');
    row = await cmd(p.stewardA, (trx, ctx) => sources.recordTerms(trx, ctx, page.id, row.revision, { termsUrl: 'https://allow.synthetic-maker.example/terms', termsDigest: 'c'.repeat(64), automatedAccess: 'permitted', notes: 'Synthetic review' }));
    assert.equal(row.terms_reviewed_by, p.stewardA, 'a person recorded the terms decision');
    row = await cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, page.id, row.revision, 'active'));
    assert.equal(row.status, 'active');

    // A changed robots.txt pauses the source; resuming needs a fresh check and a person other than the last editor.
    await cmd(p.stewardA, (trx, ctx) => sources.recordRobots(trx, ctx, page.id, robotsInput('allow.synthetic-maker.example')));
    row = await as(p.stewardB, (trx) => sources.get(trx, page.id)) as SourceRow;
    assert.deepEqual([row.status, row.pause_reason], ['paused', 'robots_changed']);
    await refused(cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, page.id, row.revision, 'active')), '23514', 'sources.fresh_check_required');
    await cmd(p.stewardB, (trx, ctx) => sources.recordRobots(trx, ctx, page.id, robotsInput('allow.synthetic-maker.example', { robotsDigest: 'd'.repeat(64) })));
    row = await as(p.stewardB, (trx) => sources.get(trx, page.id)) as SourceRow;
    row = await cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, page.id, row.revision, 'active'));
    assert.equal(row.status, 'active');
    // A changed terms page pauses it too.
    row = await cmd(p.stewardA, (trx, ctx) => sources.recordTerms(trx, ctx, page.id, row.revision, { termsUrl: 'https://allow.synthetic-maker.example/terms', termsDigest: 'e'.repeat(64), automatedAccess: 'permitted', notes: 'Synthetic terms changed' }));
    assert.deepEqual([row.status, row.pause_reason], ['paused', 'terms_changed']);
    assert.equal(await count("SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'source.paused_terms_changed' AND object_id = $1", [page.id]), 1);

    // Widening the terms of an active source sends it back to review; the editor cannot re-activate it.
    const narrow = await activeSource({ allowedUses: DISPLAY_ONLY });
    const widened = await cmd(p.stewardB, (trx, ctx) => sources.setTerms(trx, ctx, narrow.id, narrow.revision, { ...sourceInput(p.stewardB), allowedUses: OPEN_USES }));
    assert.equal(widened.status, 'proposed');
    await refused(cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, narrow.id, widened.revision, 'active')), '42501', 'sources.self_activation');
    assert.equal((await cmd(p.stewardA, (trx, ctx) => sources.setStatus(trx, ctx, narrow.id, widened.revision, 'active'))).status, 'active');
  });

  await t.test('RSL readings narrow at once, never widen, and failures close every flag', async () => {
    const s = await activeSource();
    const searchOnly = parseRsl('<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license><permits type="usage">search</permits></license></content></rsl>', 'https://allow.synthetic-journal.example/feed.xml');
    let row = await cmd(p.stewardA, (trx, ctx) => sources.recordRsl(trx, ctx, s.id, s.revision, { status: 'parsed', digest: 'f'.repeat(64), ceiling: searchOnly.ceiling, suggested: searchOnly.suggested }));
    assert.equal(row.allowed_uses.sendToModelProviders, false, 'a stricter reading applies at once');
    assert.equal(row.allowed_uses.storeFullText, true, 'flags RSL does not speak to are left to the licence');
    assert.equal(row.status, 'active');
    await refused(cmd(p.stewardA, (trx, ctx) => sources.setTerms(trx, ctx, s.id, row.revision, { ...sourceInput(p.stewardA), allowedUses: OPEN_USES })), '23514', 'sources.rsl_forbids_use');
    const failed = parseRsl('<rsl', 'https://allow.synthetic-journal.example/feed.xml');
    row = await cmd(p.stewardA, (trx, ctx) => sources.recordRsl(trx, ctx, s.id, row.revision, { status: failed.status, digest: 'a'.repeat(64), ceiling: failed.ceiling, suggested: failed.suggested }));
    assert.deepEqual(row.allowed_uses, MOST_RESTRICTIVE_USES, 'acceptance: an unreadable RSL document leaves the most restrictive flags');
    assert.deepEqual(row.rsl_ceiling, MOST_RESTRICTIVE_USES);
    // Even a caller that claims a failed reading with open flags gets the most restrictive ceiling.
    row = await cmd(p.stewardA, (trx, ctx) => sources.recordRsl(trx, ctx, s.id, row.revision, { status: 'failed', digest: 'b'.repeat(64), ceiling: OPEN_USES, suggested: OPEN_USES }));
    assert.deepEqual(row.rsl_ceiling, MOST_RESTRICTIVE_USES);
    await refused(cmd(p.stewardA, (trx, ctx) => sources.setTerms(trx, ctx, s.id, row.revision, { ...sourceInput(p.stewardA), allowedUses: DISPLAY_ONLY })), '23514', 'sources.rsl_forbids_use');
    // Only a publisher agreement on record overrides the machine-readable terms.
    row = await cmd(p.stewardA, (trx, ctx) => sources.setTerms(trx, ctx, s.id, row.revision, { ...sourceInput(p.stewardA), licence: { kind: 'publisher_agreement', name: 'Synthetic agreement', url: null, agreementRef: uuid() }, allowedUses: OPEN_USES }));
    assert.equal(row.allowed_uses.sendToModelProviders, true);
    // A reading that cannot be satisfied directly by the database: a parsed reading whose suggestion exceeds its ceiling.
    await refused(cmd(p.stewardA, (trx, ctx) => sources.recordRsl(trx, ctx, s.id, row.revision, { status: 'parsed', digest: 'c'.repeat(64), ceiling: DISPLAY_ONLY, suggested: OPEN_USES })), '23514');
  });

  await t.test('import: an active source, licence-checked text, a second person activates the batch (racing activators: one wins)', async () => {
    const proposed = await cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(p.stewardA)));
    await refused(cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, proposed.id, { items: [item('p1')], fields: [], links: [] })), '23514', 'sources.source_not_active');
    const display = await activeSource({ allowedUses: DISPLAY_ONLY });
    await refused(cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, display.id, { items: [item('d1', { summary: 'Synthetic summary' })], fields: [], links: [] })), '23514', 'sources.licence_forbids_summary');
    await refused(cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, display.id, { items: [item('d1', { fullText: 'Synthetic full text' })], fields: [], links: [] })), '23514', 'sources.licence_forbids_full_text');
    const open = await activeSource();
    const batch = await cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, open.id, { items: [item('o1', { summary: 'Synthetic summary', fullText: 'Synthetic full text' }), item('o2')], fields: [], links: [] }));
    assert.deepEqual(batch.counts, { items: 2, duplicates: 0, fields: 0, links: 0 });
    assert.equal(batch.licence_snapshot.allowedUses.storeFullText, true);
    await refused(cmd(p.stewardA, (trx, ctx) => importBatches.decide(trx, ctx, batch.id, batch.revision, 'activate')), '42501', 'sources.self_activation');
    await refused(cmd(p.editorA, (trx, ctx) => importBatches.decide(trx, ctx, batch.id, batch.revision, 'activate')), '42501', 'admin.forbidden');
    // A second import repeating an external id counts it as a duplicate instead of storing it twice.
    const again = await cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, open.id, { items: [item('o1'), item('o3')], fields: [], links: [] }));
    assert.deepEqual(again.counts, { items: 1, duplicates: 1, fields: 0, links: 0 });
    // Two second persons race on the same batch: exactly one decision commits.
    const ctxB = await w.act.elevate(p.stewardB);
    await w.act.assign({ personId: p.chief, role: 'data-steward', scope: { kind: 'hub', hubId: w.hubId } });
    const ctxC = await w.act.elevate(p.chief);
    const results = await Promise.allSettled([
      as(p.stewardB, (trx) => importBatches.decide(trx, ctxB, batch.id, batch.revision, 'activate')),
      as(p.chief, (trx) => importBatches.decide(trx, ctxC, batch.id, batch.revision, 'reject')),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => (r.status === 'rejected' ? (r.reason as { hint?: string }).hint : 'ok'))));
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(['sources.batch_decided', 'sources.revision_conflict'].includes((loser.reason as { hint: string }).hint));
  });

  await t.test('acceptance: no imported item is published without a person\'s decision', async () => {
    const s = await activeSource();
    const batch = await cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, s.id, { items: [item('q1'), item('q2'), item('q3'), item('q4')], fields: [], links: [] }));
    const staged = await as(p.editorA, (trx) => sourceItems.list(trx, w.hubId, { batchId: batch.id }));
    assert.equal(staged.length, 4);
    assert.ok(staged.every((i) => i.status === 'queued' && i.publication_id === null));
    await refused(cmd(p.editorA, (trx, ctx) => sourceItems.decide(trx, ctx, staged[0]!.id, staged[0]!.revision, 'discard', null)), '23514', 'sources.batch_not_activated');
    assert.equal((await as(p.editorA, (trx) => sourceItems.queue(trx, w.hubId))).filter((i) => i.import_batch_id === batch.id).length, 0, 'staged items are not in the queue yet');
    await cmd(p.stewardB, (trx, ctx) => importBatches.decide(trx, ctx, batch.id, batch.revision, 'activate'));
    const queue = (await as(p.editorA, (trx) => sourceItems.queue(trx, w.hubId))).filter((i) => i.import_batch_id === batch.id);
    assert.equal(queue.length, 4, 'activated items wait for a person');
    // Nothing reaches a public projection while items wait; no function publishes an item; the worker cannot decide.
    assert.equal(await count("SELECT 1 FROM trustwork.publication WHERE hub_id = $1 AND status IN ('published', 'scheduled', 'corrected')", [w.hubId]), 0);
    assert.equal(await count("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork' AND p.proname LIKE 'sources%publish%'"), 0);
    const grants = await db.admin.query<{ w: boolean; a: boolean }>(`SELECT has_function_privilege('trustwork_worker', 'trustwork.sources_decide_item(jsonb, uuid, integer, text, uuid)', 'EXECUTE') AS w,
      has_function_privilege('trustwork_app', 'trustwork.sources_decide_item(jsonb, uuid, integer, text, uuid)', 'EXECUTE') AS a`);
    assert.deepEqual(grants.rows[0], { w: false, a: true });
    // Every writer, maintenance included: a drafted or discarded item names the person who decided.
    await refused(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.source_item SET status = 'discarded' WHERE id = ${queue[0]!.id}::uuid`.execute(trx)), '23514');
    // The person who staged the batch does not decide its items; people without the review permission neither.
    await assert.rejects(draftFromItem(p.stewardA, queue[0]!), (e: { hint?: string }) => ['admin.forbidden', 'sources.self_review', 'content.not_authorised'].includes(e.hint ?? ''));
    await w.act.assign({ personId: p.stewardA, role: 'editor', scope: { kind: 'hub', hubId: w.hubId } });
    await assert.rejects(draftFromItem(p.stewardA, queue[0]!), (e: { hint?: string }) => e.hint === 'sources.self_review');
    await refused(cmd(p.moderator, (trx, ctx) => sourceItems.decide(trx, ctx, queue[0]!.id, queue[0]!.revision, 'discard', null)), '42501', 'admin.forbidden');
    // An editor turns an item into a publication draft: a draft, not published, absent from public projections.
    const { pub, decided } = await draftFromItem(p.editorA, queue[0]!);
    assert.deepEqual([decided.status, decided.decided_by, decided.publication_id], ['drafted', p.editorA, pub.id]);
    assert.equal(pub.status, 'draft');
    assert.equal(await anon((trx) => publicContent.publication(trx, w.hubId, pub.id)), null, 'not public');
    // Publishing is CNT-001's separate decision with its own four eyes: the drafting editor cannot publish it alone.
    const ctxA = await w.act.elevate(p.editorA);
    const inReview = await as(p.editorA, (trx) => publications.transition(trx, ctxA, pub.id, pub.revision, 'in_review'));
    await refused(as(p.editorA, (trx) => publications.publish(trx, ctxA, pub.id, inReview.revision, null)), '42501', 'content.self_review');
    // The draft must be the decider's own editorial draft citing the item, with flags no wider than the item's.
    await refused(cmd(p.editorB, (trx, ctx) => sourceItems.decide(trx, ctx, queue[1]!.id, queue[1]!.revision, 'draft', pub.id)), '23514', 'sources.publication_mismatch');
    const narrowed = await as(p.stewardA, (trx) => sources.get(trx, s.id)) as SourceRow;
    await cmd(p.stewardB, (trx, ctx) => sources.setTerms(trx, ctx, s.id, narrowed.revision, { ...sourceInput(p.stewardB), allowedUses: DISPLAY_ONLY }));
    const q3 = await as(p.editorB, (trx) => sourceItems.get(trx, queue[2]!.id)) as SourceItemRow;
    await assert.rejects(draftFromItem(p.editorB, q3, { uses: OPEN_USES }), (e: { hint?: string }) => e.hint === 'sources.source_ref_exceeds_licence');
    // Discard, then a second decision on the same item is refused.
    const q4 = await as(p.editorB, (trx) => sourceItems.get(trx, queue[3]!.id)) as SourceItemRow;
    const discarded = await cmd(p.editorB, (trx, ctx) => sourceItems.decide(trx, ctx, q4.id, q4.revision, 'discard', null));
    assert.equal(discarded.status, 'discarded');
    await refused(cmd(p.editorA, (trx, ctx) => sourceItems.decide(trx, ctx, q4.id, discarded.revision, 'discard', null)), '23514', 'sources.item_decided');
    // Two editors decide the same item at once: exactly one decision commits.
    const ctxs = await Promise.all([w.act.elevate(p.editorA), w.act.elevate(p.editorB)]);
    const race = await Promise.allSettled([
      as(p.editorA, (trx) => sourceItems.decide(trx, ctxs[0], q3.id, q3.revision, 'discard', null)),
      as(p.editorB, (trx) => sourceItems.decide(trx, ctxs[1], q3.id, q3.revision, 'discard', null)),
    ]);
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await count("SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'source_item.discarded' AND object_id = $1", [q3.id]), 1);
  });

  await t.test('acceptance: a display-only source never reaches a model provider or a peer (negative tests)', async () => {
    const display = await activeSource({ allowedUses: DISPLAY_ONLY, name: 'Synthetic Display-only Journal' });
    const [row] = await importItems(display.id, [item('x1')]);
    assert.ok(row);
    await refused(as(p.editorA, (trx) => sourceItems.egress(trx, row.id, 'model_provider')), '23514', 'sources.licence_forbids_model_use');
    await refused(as(p.editorA, (trx) => sourceItems.egress(trx, row.id, 'peer')), '23514', 'sources.licence_forbids_syndication');
    await refused(cmd(p.editorA, (trx, ctx) => sourceItems.recordAssist(trx, ctx, row.id, row.revision, 'Synthetic assisted summary', 'en')), '23514', 'sources.licence_forbids_model_use');
    await refused(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.source_item SET assisted_summary = 'x', assisted_language = 'en', assisted_at = now() WHERE id = ${row.id}::uuid`.execute(trx)), '23514');
    await refused(as(p.outsider, (trx) => sourceItems.egress(trx, row.id, 'model_provider')), 'P0002', 'admin.not_found');
    // Drafted into a publication, the cited source carries display-only flags: CNT-001 refuses assistant use and the
    // peer export never lists the item.
    const { pub } = await draftFromItem(p.editorA, row, { assisted: true });
    const [ref] = (await as(p.editorA, (trx) => trx.selectFrom('publication_version').select('source_refs').where('publication_id', '=', pub.id).executeTakeFirstOrThrow())).source_refs as { allowedUses: Record<string, boolean> }[];
    assert.equal(ref?.allowedUses.sendToModelProviders, false);
    assert.equal(ref?.allowedUses.syndicateToPeers, false);
    const ctxA = await w.act.elevate(p.editorA);
    const ctxB = await w.act.elevate(p.editorB);
    const review = await as(p.editorA, (trx) => publications.transition(trx, ctxA, pub.id, pub.revision, 'in_review'));
    await refused(as(p.editorB, (trx) => publications.publish(trx, ctxB, pub.id, review.revision, null)), '23514', 'content.licence_forbids_model_use');
    const exported = await withMaintenance(db.admin, (trx) => sourcesWorker.peerExport(trx, w.hubId, 500));
    assert.ok(!exported.some((x) => x.itemId === row.id), 'never exported to peers');
    // An open source's drafted item is exported and may be sent to a model; after the source is narrowed to display
    // only, the same old copy may not (the stricter reading wins).
    const open = await activeSource({ name: 'Synthetic Open Journal' });
    const [openItem] = await importItems(open.id, [item('x2', { summary: 'Synthetic summary', fullText: 'Synthetic full text' })]);
    assert.ok(openItem);
    const payload = await as(p.editorA, (trx) => sourceItems.egress(trx, openItem.id, 'model_provider'));
    assert.equal(payload.fullText, 'Synthetic full text');
    await draftFromItem(p.editorA, openItem);
    assert.ok((await withMaintenance(db.admin, (trx) => sourcesWorker.peerExport(trx, w.hubId, 500))).some((x) => x.itemId === openItem.id));
    const current = await as(p.stewardA, (trx) => sources.get(trx, open.id)) as SourceRow;
    await cmd(p.stewardB, (trx, ctx) => sources.setTerms(trx, ctx, open.id, current.revision, { ...sourceInput(p.stewardB), allowedUses: DISPLAY_ONLY }));
    await refused(as(p.editorA, (trx) => sourceItems.egress(trx, openItem.id, 'model_provider')), '23514', 'sources.licence_forbids_model_use');
    assert.ok(!(await withMaintenance(db.admin, (trx) => sourcesWorker.peerExport(trx, w.hubId, 500))).some((x) => x.itemId === openItem.id));
    assert.deepEqual(await as(p.editorA, (trx) => sourceItems.effectiveUses(trx, openItem.id)), DISPLAY_ONLY);
  });

  await t.test('output projections apply current and snapshot licences independently', async () => {
    const source = await activeSource();
    const [row] = await importItems(source.id, [item('projection', { summary: 'Synthetic summary', fullText: 'Synthetic text' })]);
    assert.ok(row);
    await draftFromItem(p.editorA, row);
    const narrow = { ...OPEN_USES, displaySummary: false, storeFullText: false, rewriteWithAttribution: false };
    let current = await cmd(p.stewardA, (trx, ctx) => sources.setTerms(trx, ctx, source.id, source.revision, { ...sourceInput(p.stewardA), allowedUses: narrow }));
    const payload = await as(p.editorA, (trx) => sourceItems.egress(trx, row.id, 'model_provider'));
    assert.deepEqual([payload.summary, payload.fullText], [null, null]);
    const exported = await withMaintenance(db.admin, (trx) => sourcesWorker.peerExport(trx, w.hubId, 500));
    assert.equal(exported.find((x) => x.itemId === row.id)?.summary, null, 'syndication alone does not authorize a stored summary');
    current = await cmd(p.stewardA, (trx, ctx) => sources.setTerms(trx, ctx, source.id, current.revision, { ...sourceInput(p.stewardA), allowedUses: { ...narrow, displayHeadlineAndLink: false, indexForSearch: false } }));
    assert.ok(!(await withMaintenance(db.admin, (trx) => sourcesWorker.peerExport(trx, w.hubId, 500))).some((x) => x.itemId === row.id));
    assert.ok(!(await withMaintenance(db.admin, (trx) => sourcesWorker.recommendable(trx, w.hubId, 500))).some((x) => x.item_id === row.id));
    // A later widening cannot turn facts imported without display permission into public provenance.
    const record = uuid();
    await importItems(source.id, [item('snapshot')], [{ recordKind: 'company', recordId: record, field: 'legalName', value: 'Synthetic Snapshot LLC', itemExternalId: null }]);
    current = await cmd(p.stewardA, (trx, ctx) => sources.setTerms(trx, ctx, source.id, current.revision, { ...sourceInput(p.stewardA), allowedUses: OPEN_USES }));
    await cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, source.id, current.revision, 'active'));
    assert.deepEqual((await anon((trx) => publicSources.provenance(trx, w.hubId, 'company', record)) as { fields: unknown[] }).fields, []);
  });

  await t.test('takedown: deactivate records, redact text, tombstones for retrieval and federation, the reason audited', async () => {
    const s = await activeSource({ name: 'Synthetic Takedown Journal' });
    const company = uuid();
    const items = await importItems(s.id, [item('t1', { summary: 'Synthetic summary', fullText: 'Synthetic text' }), item('t2')], [
      { recordKind: 'company', recordId: company, field: 'legalName', value: 'Synthetic Fixtures LLC', itemExternalId: 'synthetic-t1' },
      { recordKind: 'company', recordId: company, field: 'website', value: 'https://synthetic-fixtures.example', itemExternalId: null },
    ]);
    const { pub } = await draftFromItem(p.editorA, items[0]!);
    const provenance = await anon((trx) => publicSources.provenance(trx, w.hubId, 'company', company)) as { label: string; fields: { field: string; source: { name: string } }[] };
    assert.equal(provenance.label, 'sourced');
    assert.deepEqual(provenance.fields.map((f) => f.field), ['legalName', 'website']);
    assert.equal(provenance.fields[0]?.source.name, 'Synthetic Takedown Journal');
    const staged = await cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, s.id, { items: [item('t3')], fields: [], links: [{ left: { kind: 'company', id: company }, rightLocalId: uuid(), rightGlobalId: null, evidence: 'identifier_match' }] }));
    await refused(cmd(p.stewardA, (trx, ctx) => sources.takedown(trx, ctx, { sourceId: s.id, itemId: null }, 'legal_demand', '')), '22023', 'sources.takedown_reason_required');
    const takedown = await cmd(p.stewardB, (trx, ctx) => sources.takedown(trx, ctx, { sourceId: s.id, itemId: null }, 'rights_holder_request', 'Synthetic rights holder request #1'));
    assert.deepEqual([takedown.items_taken_down, takedown.fields_deactivated, takedown.publication_ids], [3, 2, [pub.id]]);
    const after = await as(p.stewardA, (trx) => sources.get(trx, s.id)) as SourceRow;
    assert.deepEqual([after.status, after.pause_reason], ['taken_down', 'takedown']);
    const rows = await as(p.stewardA, (trx) => sourceItems.list(trx, w.hubId, { batchId: items[0]!.import_batch_id }));
    assert.ok(rows.every((r) => r.status === 'taken_down' && r.summary === null && r.full_text === null), 'stored text is redacted');
    assert.equal((await as(p.stewardA, (trx) => importBatches.get(trx, staged.id)))?.status, 'taken_down');
    assert.equal((await as(p.stewardA, (trx) => recordLinks.list(trx, w.hubId))).find((l) => l.import_batch_id === staged.id)?.state, 'withdrawn');
    assert.equal(await anon((trx) => publicSources.provenance(trx, w.hubId, 'company', company)).then((v) => (v as { fields: unknown[] }).fields.length), 0, 'the public provenance is gone');
    const tombs = await as(p.stewardA, (trx) => takedowns.tombstones(trx, takedown.id));
    const by = (channel: string, kind: string) => tombs.filter((x) => x.channel === channel && x.target_kind === kind).length;
    assert.deepEqual([by('retrieval', 'source'), by('retrieval', 'source_item'), by('retrieval', 'sourced_record'), by('federation', 'source'), by('federation', 'source_item'), by('federation', 'sourced_record')], [1, 3, 1, 0, 3, 1]);
    assert.ok(tombs.filter((x) => x.channel === 'federation').every((x) => x.apply_by && x.apply_by.getTime() - x.issued_at.getTime() === 72 * 3_600_000));
    assert.equal(await count("SELECT 1 FROM trustwork.outbox_event WHERE type IN ('sources.retrieval_tombstone', 'sources.federation_tombstone') AND payload ->> 'hubId' = $1 AND aggregate_id = ANY ($2::text[])", [w.hubId, tombs.map((x) => x.id)]), tombs.length);
    const outbox = await db.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM trustwork.outbox_event WHERE type = 'sources.federation_tombstone' AND aggregate_id = $1", [tombs.find((x) => x.channel === 'federation')!.id]);
    assert.deepEqual(Object.keys(outbox.rows[0]!.payload).sort(), ['applyBy', 'hubId', 'reason', 'recordKind', 'targetId', 'targetKind', 'tombstoneId'], 'identifiers only');
    const audit = await db.admin.query<{ reason_text: string; actor_person_id: string }>("SELECT reason_text, actor_person_id FROM trustwork.admin_audit_event WHERE action = 'source.taken_down' AND object_id = $1", [s.id]);
    assert.equal(audit.rows[0]?.actor_person_id, p.stewardB);
    assert.equal((await as(p.stewardA, (trx) => takedowns.get(trx, takedown.id)))?.note, 'Synthetic rights holder request #1', 'the reason is recorded with the takedown');
    // A taken-down source stays down for every writer; its items cannot be decided or sent anywhere.
    await refused(cmd(p.stewardA, (trx, ctx) => sources.setStatus(trx, ctx, s.id, after.revision, 'active')), '23514', 'sources.taken_down');
    await refused(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.source SET status = 'active', pause_reason = NULL, paused_at = NULL WHERE id = ${s.id}::uuid`.execute(trx)), '23514', 'sources.taken_down');
    await refused(as(p.editorA, (trx) => sourceItems.egress(trx, items[1]!.id, 'model_provider')), '23514', 'sources.taken_down');
    await refused(cmd(p.stewardB, (trx, ctx) => sources.takedown(trx, ctx, { sourceId: s.id, itemId: null }, 'legal_demand', 'Again')), '23514', 'sources.taken_down');
    await refused(withMaintenance(db.admin, (trx) => sql`DELETE FROM trustwork.source_tombstone WHERE takedown_id = ${takedown.id}::uuid`.execute(trx)), '23000', 'audit.append_only');

    // One item only, racing an editor's decision on it: whatever commits first, the item ends taken down.
    const s2 = await activeSource({ name: 'Synthetic Item Takedown Journal' });
    const [one, two] = await importItems(s2.id, [item('u1'), item('u2')]);
    const ctxSteward = await w.act.elevate(p.stewardB);
    const ctxEditor = await w.act.elevate(p.editorA);
    const race = await Promise.allSettled([
      as(p.editorA, (trx) => sourceItems.decide(trx, ctxEditor, one!.id, one!.revision, 'discard', null)),
      as(p.stewardB, (trx) => sources.takedown(trx, ctxSteward, { sourceId: null, itemId: one!.id }, 'licence_ended', 'Synthetic licence ended')),
    ]);
    assert.equal(race[1].status, 'fulfilled', JSON.stringify(race[1]));
    assert.equal((await as(p.stewardA, (trx) => sourceItems.get(trx, one!.id)))?.status, 'taken_down');
    assert.equal((await as(p.stewardA, (trx) => sourceItems.get(trx, two!.id)))?.status, 'queued', 'other items stay');
    assert.equal((await as(p.stewardA, (trx) => sources.get(trx, s2.id)))?.status, 'active', 'the source stays');
    const itemTombs = await withMaintenance(db.admin, (trx) => trx.selectFrom('source_tombstone').selectAll().where('target_id', '=', one!.id).execute());
    assert.deepEqual(itemTombs.map((x) => `${x.channel}:${x.reason}`).sort(), ['federation:licence_ended', 'retrieval:licence_ended']);
  });

  await t.test('record links: links, never merges; the proposer never decides; a person is linked only with their confirmation', async () => {
    const link = await cmd(p.stewardA, (trx, ctx) => recordLinks.propose(trx, ctx, w.hubId, { left: { kind: 'person', id: p.writer }, rightLocalId: uuid(), rightGlobalId: null, evidence: 'identifier_match' }));
    await refused(cmd(p.stewardA, (trx, ctx) => recordLinks.decide(trx, ctx, link.id, link.revision, 'accept')), '42501', 'sources.self_review');
    await refused(cmd(p.stewardB, (trx, ctx) => recordLinks.decide(trx, ctx, link.id, link.revision, 'accept')), '23514', 'sources.person_confirmation_required');
    assert.equal((await cmd(p.stewardB, (trx, ctx) => recordLinks.decide(trx, ctx, link.id, link.revision, 'reject'))).state, 'rejected');
    const company = await cmd(p.stewardA, (trx, ctx) => recordLinks.propose(trx, ctx, w.hubId, { left: { kind: 'company', id: w.content.company }, rightLocalId: null, rightGlobalId: 'trustwork://peer.example/company/synthetic-1', evidence: 'identifier_match' }));
    const accepted = await cmd(p.stewardB, (trx, ctx) => recordLinks.decide(trx, ctx, company.id, company.revision, 'accept'));
    assert.deepEqual([accepted.state, accepted.decided_by], ['accepted', p.stewardB]);
    await refused(cmd(p.stewardA, (trx, ctx) => recordLinks.decide(trx, ctx, company.id, accepted.revision, 'reject')), '23514', 'sources.link_decided');
  });

  await t.test('sponsored content: off by default, a second person switches it on, labelled, never a ranking or recommendation input', async () => {
    assert.equal(await as(p.officerA, (trx) => sponsoredPolicy.current(trx, w.hubId)), undefined, 'no policy row: off');
    const s = await activeSource({ name: 'Synthetic Sponsor Feed' });
    const sponsoredItem = item('s1', { sponsored: { sponsorName: 'Synthetic Sponsor Inc.' } });
    await refused(cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, s.id, { items: [sponsoredItem], fields: [], links: [] })), '23514', 'sources.sponsored_off');
    await refused(cmd(p.officerA, (trx, ctx) => sponsoredPolicy.set(trx, ctx, w.hubId, { allowed: true, maxSlotsPerPage: 1, requireVerifiedSponsor: false, approvalId: null })), '42501', 'admin.approval_required');
    await refused(cmd(p.stewardA, (trx, ctx) => sponsoredPolicy.set(trx, ctx, w.hubId, { allowed: false, maxSlotsPerPage: 0, requireVerifiedSponsor: true, approvalId: null })), '42501', 'admin.forbidden');
    const input = { hubId: w.hubId, version: 1, allowed: true, maxSlotsPerPage: 1, requireVerifiedSponsor: true };
    const digest = computeDigest(sponsoredPolicyDigestInput(input)).value;
    assert.equal(await sourcesWorker.sponsoredDigest(db.app, input), digest, 'the database recomputes exactly what the contract digests');
    const request = await cmd(p.officerA, (trx, ctx) => approvals.request(trx, ctx, { action: 'sponsored.enable', scope: { kind: 'hub', hubId: w.hubId }, actionDigest: digest }));
    await refused(cmd(p.officerA, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest)), '42501', 'admin.self_approval');
    await cmd(p.officerB, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    await refused(cmd(p.officerA, (trx, ctx) => sponsoredPolicy.set(trx, ctx, w.hubId, { allowed: true, maxSlotsPerPage: 2, requireVerifiedSponsor: true, approvalId: request.id })), '23514', 'admin.approval_mismatch');
    const v1 = await cmd(p.officerA, (trx, ctx) => sponsoredPolicy.set(trx, ctx, w.hubId, { allowed: true, maxSlotsPerPage: 1, requireVerifiedSponsor: true, approvalId: request.id }));
    assert.deepEqual([v1.version, v1.allowed, v1.approval_id], [1, true, request.id]);
    await refused(cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, s.id, { items: [sponsoredItem], fields: [], links: [] })), '23514', 'sources.sponsor_unverified');
    const input2 = { ...input, version: 2, requireVerifiedSponsor: false };
    const digest2 = computeDigest(sponsoredPolicyDigestInput(input2)).value;
    const request2 = await cmd(p.officerB, (trx, ctx) => approvals.request(trx, ctx, { action: 'sponsored.enable', scope: { kind: 'hub', hubId: w.hubId }, actionDigest: digest2 }));
    await cmd(p.officerA, (trx, ctx) => approvals.decide(trx, ctx, request2.id, 'approve', digest2));
    await cmd(p.officerB, (trx, ctx) => sponsoredPolicy.set(trx, ctx, w.hubId, { allowed: true, maxSlotsPerPage: 1, requireVerifiedSponsor: false, approvalId: request2.id }));
    const [sp, plain] = await importItems(s.id, [sponsoredItem, item('s2')]);
    assert.deepEqual([sp?.sponsored, sp?.sponsor_name], [true, 'Synthetic Sponsor Inc.']);
    await draftFromItem(p.editorA, sp!);
    await draftFromItem(p.editorA, plain!);
    const recommendable = await withMaintenance(db.admin, (trx) => sourcesWorker.recommendable(trx, w.hubId, 500));
    assert.ok(recommendable.some((r) => r.item_id === plain!.id), 'ordinary items are a recommendation input');
    assert.ok(!recommendable.some((r) => r.item_id === sp!.id), 'sponsored items never are');
    assert.ok(!(await withMaintenance(db.admin, (trx) => sourcesWorker.peerExport(trx, w.hubId, 500))).some((x) => x.itemId === sp!.id));
    const slot = await anon((trx) => publicSources.sponsoredSlot(trx, w.hubId)) as { label: string; items: { itemId: string; sponsorName: string }[] };
    assert.equal(slot.label, 'sponsored');
    assert.deepEqual(slot.items.map((x) => [x.itemId, x.sponsorName]), [[sp!.id, 'Synthetic Sponsor Inc.']]);
    // Tightening sponsor verification also removes previously admitted unverified sponsors.
    const input3 = { ...input, version: 3, requireVerifiedSponsor: true };
    const digest3 = computeDigest(sponsoredPolicyDigestInput(input3)).value;
    const request3 = await cmd(p.officerA, (trx, ctx) => approvals.request(trx, ctx, { action: 'sponsored.enable', scope: { kind: 'hub', hubId: w.hubId }, actionDigest: digest3 }));
    await cmd(p.officerB, (trx, ctx) => approvals.decide(trx, ctx, request3.id, 'approve', digest3));
    await cmd(p.officerA, (trx, ctx) => sponsoredPolicy.set(trx, ctx, w.hubId, { allowed: true, maxSlotsPerPage: 1, requireVerifiedSponsor: true, approvalId: request3.id }));
    assert.deepEqual((await anon((trx) => publicSources.sponsoredSlot(trx, w.hubId)) as { items: unknown[] }).items, []);
    // Switching it off needs no second person and empties the slot at once.
    await refused(cmd(p.officerA, (trx, ctx) => sponsoredPolicy.set(trx, ctx, w.hubId, { allowed: false, maxSlotsPerPage: 0, requireVerifiedSponsor: true, approvalId: request.id })), '22023', 'sources.invalid_policy');
    const off = await cmd(p.officerA, (trx, ctx) => sponsoredPolicy.set(trx, ctx, w.hubId, { allowed: false, maxSlotsPerPage: 0, requireVerifiedSponsor: true, approvalId: null }));
    assert.deepEqual([off.version, off.allowed], [4, false]);
    assert.deepEqual((await anon((trx) => publicSources.sponsoredSlot(trx, w.hubId)) as { items: unknown[] }).items, []);
    await refused(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.sponsored_content_policy SET allowed = true WHERE id = ${off.id}::uuid`.execute(trx)), '23000', 'audit.append_only');
    await refused(withMaintenance(db.admin, (trx) => sql`INSERT INTO trustwork.sponsored_content_policy (hub_id, version, allowed, max_slots_per_page, require_verified_sponsor, set_by)
      VALUES (${w.hubId}::uuid, 99, true, 1, false, ${p.officerA}::uuid)`.execute(trx)), '23514');
  });

  await t.test('public provenance shows only activated, displayable, live facts', async () => {
    const s = await activeSource({ name: 'Synthetic Register Feed' });
    const record = uuid();
    const batch = await cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, s.id, { items: [item('pv1')], fields: [{ recordKind: 'product_entry', recordId: record, field: 'modelNumber', value: 'SYN-100', itemExternalId: null }], links: [] }));
    assert.equal(await anon((trx) => publicSources.provenance(trx, w.hubId, 'product_entry', record)).then((v) => (v as { fields: unknown[] }).fields.length), 0, 'staged facts are not public');
    await cmd(p.stewardB, (trx, ctx) => importBatches.decide(trx, ctx, batch.id, batch.revision, 'activate'));
    assert.equal(await anon((trx) => publicSources.provenance(trx, w.hubId, 'product_entry', record)).then((v) => (v as { fields: unknown[] }).fields.length), 1);
    assert.equal(await anon((trx) => publicSources.provenance(trx, w.otherHubId, 'product_entry', record)).then((v) => (v as { fields: unknown[] }).fields.length), 0, 'another hub sees nothing');
    await refused(cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, s.id, { items: [item('pv2')], fields: [{ recordKind: 'company', recordId: record, field: 'qualityScore', value: '5', itemExternalId: null }], links: [] })), '23514');
  });
});
