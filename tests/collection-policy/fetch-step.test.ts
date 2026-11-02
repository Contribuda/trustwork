import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Collector, type CollectFetch, type CollectResponse } from '../../apps/worker/src/collect/collector.js';
import { collectionPort, FETCHED, fetchStep, type CollectionPort, type FetchedItem, type SourceRow } from '../../apps/worker/src/collect/fetch-step.js';
import type { StepContext } from '../../apps/worker/src/pipelines/engine.js';
import { botUserAgent } from '../../packages/contracts/src/collection-policy.js';
import { ALL_USES } from '../../packages/contracts/src/sources.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { buildSourcesWorld, sourceInput } from '../sources/helpers.js';
import { sources } from '../../packages/data/src/repositories/sources.js';

/**
 * SRC-002 part 2: the pipeline `fetch` step runs every source of the version through the gate; allowed content is
 * carried with its uses, denied sources are counted, and a changed signal pauses the source's pipelines instead of
 * fetching. The database function gives the worker exactly the fields the gate needs and the runtime role nothing.
 */
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const ROBOTS = 'User-agent: *\nAllow: /';
const HUB = 'hub-1';
const row = (over: Partial<SourceRow> = {}): SourceRow => ({
  id: 'src-1', hub_id: HUB, kind: 'web_page', url: 'https://registry.example/companies', status: 'active', allowed_uses: { ...ALL_USES }, terms_automated_access: 'permitted',
  personal_data: false, legal_basis: null, terms_digest: null, rsl_status: 'absent', rsl_ceiling: null, rsl_digest: null, robots_digest: sha(ROBOTS), ...over,
});
function net(routes: Record<string, { status: number; body?: string }>) {
  const calls: string[] = [];
  const fetch: CollectFetch = async (url) => {
    calls.push(url);
    const r = routes[url] ?? { status: 404 };
    const res: CollectResponse = { status: r.status, url, headers: { get: () => null }, text: async () => r.body ?? '' };
    return res;
  };
  return { calls, fetch };
}
function context(sourceIds: string[]): StepContext {
  return {
    run: { id: 'run-1', hub_id: HUB } as StepContext['run'], version: { source_ids: sourceIds } as StepContext['version'], step: { kind: 'fetch', modelRouteId: null, modelJob: null, settings: {} },
    index: 0, dryRun: false, counts: { fetched: 0, new: 0, duplicates: 0, skippedByLicence: 0, skippedByRobots: 0, proposed: 0, failed: 0 }, carry: new Map(),
    effect: async () => ({ status: 'dry' as const }), charge: async () => undefined,
  };
}
function port(rows: SourceRow[]): CollectionPort & { paused: Array<[string, string]> } {
  const paused: Array<[string, string]> = [];
  return { paused, source: async (id) => rows.find((r) => r.id === id) ?? null, changed: async (id, reason) => { paused.push([id, reason]); return 1; } };
}

test('allowed sources are carried with their uses; robots-denied and inactive ones are counted, never fetched', async () => {
  const n = net({
    'https://registry.example/robots.txt': { status: 200, body: ROBOTS }, 'https://registry.example/companies': { status: 200, body: '<html>Synthetic register page</html>' },
    'https://closed.example/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' },
  });
  const p = port([row(), row({ id: 'src-2', url: 'https://closed.example/list', robots_digest: null }), row({ id: 'src-3', status: 'paused', url: 'https://paused.example/x' })]);
  const ctx = context(['src-1', 'src-2', 'src-3', 'src-missing']);
  await fetchStep({ collector: new Collector({ fetch: n.fetch, userAgent: botUserAgent('https://hub.example/bot') }), port: p })(ctx);
  const items = ctx.carry.get(FETCHED) as FetchedItem[];
  assert.deepEqual(items.map((i) => i.sourceId), ['src-1']);
  assert.equal(items[0]!.body, '<html>Synthetic register page</html>');
  assert.deepEqual([ctx.counts.fetched, ctx.counts.skippedByRobots, ctx.counts.skippedByLicence, ctx.counts.failed], [1, 1, 1, 1]);
  assert.equal(n.calls.includes('https://closed.example/list'), false, 'a robots-denied URL is never requested');
  assert.equal(n.calls.some((u) => u.startsWith('https://paused.example')), false, 'an inactive source sends nothing at all');
});

test('a changed robots.txt pauses the source\'s pipelines and fetches nothing from it', async () => {
  const n = net({ 'https://registry.example/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n# new terms' }, 'https://registry.example/companies': { status: 200, body: 'x' } });
  const p = port([row()]);
  const ctx = context(['src-1']);
  await fetchStep({ collector: new Collector({ fetch: n.fetch, userAgent: botUserAgent('https://hub.example/bot') }), port: p })(ctx);
  assert.deepEqual(p.paused, [['src-1', 'robots']]);
  assert.deepEqual(ctx.carry.get(FETCHED), []);
  assert.equal(n.calls.includes('https://registry.example/companies'), false);
});

test('a source of another hub is never collected by this run', async () => {
  const n = net({});
  const ctx = context(['src-1']);
  await fetchStep({ collector: new Collector({ fetch: n.fetch, userAgent: botUserAgent('https://hub.example/bot') }), port: port([row({ hub_id: 'hub-other' })]) })(ctx);
  assert.deepEqual(n.calls, []);
  assert.equal(ctx.counts.failed, 1);
});

const env = await provisionWorkerDatabase('collection_view');

test('database: the worker reads the gate\'s fields of one source; the runtime role cannot call the function', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const w = await buildSourcesWorld(env.db.admin, env.apiPool);
  const ctx = await w.content.act.elevate(w.people.stewardA);
  const registered = await w.content.act.as(w.people.stewardA, (trx) => sources.register(trx, ctx, w.hubId, sourceInput(w.people.stewardA)));
  const worker = env.workerPool(2);
  const view = await collectionPort(worker).source(registered.id);
  assert.ok(view);
  assert.equal(view.id, registered.id);
  assert.equal(view.status, 'proposed');
  assert.equal(view.hub_id, w.hubId);
  assert.deepEqual(Object.keys(view).sort(), ['allowed_uses', 'hub_id', 'id', 'kind', 'legal_basis', 'personal_data', 'robots_digest', 'rsl_ceiling', 'rsl_digest', 'rsl_status', 'status',
    'terms_automated_access', 'terms_digest', 'url'].sort(), 'exactly the fields the gate reads');
  assert.equal(await collectionPort(worker).source('00000000-0000-4000-8000-000000000000'), null);
  await assert.rejects(tx(env.apiPool, (trx) => import('kysely').then(({ sql }) => sql`SELECT * FROM trustwork.sources_collection_view(${registered.id}::uuid)`.execute(trx))), /permission denied/);
});
