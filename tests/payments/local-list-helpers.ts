import assert from 'node:assert/strict';
import type { sourceWorld } from './source-helpers.js';
import type { Harness } from '../backend/helpers/app.js';
import { syntheticListSources, installSyntheticListSources } from '../web/admin/screening/list-fixtures.js';
import { proposeScreeningList, decideScreeningList } from '../../packages/data/src/repositories/screening-list-authority.js';
import { getPack, validatePack } from '../../packages/country-packs/src/index.js';
import { registeredListSources } from '../../packages/compliance/src/lists/catalog.js';
import { withMaintenance } from '@trustwork/data';
import { syncScreeningListSources } from '../../packages/data/src/repositories/screening-list-authority.js';
import { activateList } from '../screening/helpers.js';
import { SYNTHETIC_SDN } from '../screening-gates/helpers.js';
type World = Awaited<ReturnType<typeof sourceWorld>>;
/** Real installed-source, two-person list approval and worker ingestion; all list facts remain synthetic. */
export async function localPaymentLists(h: Harness, first: World, second: World) {
  assert.equal(first.w.nodeId, second.w.nodeId);
  for (const w of [first, second]) await w.a.assignSensitive({ personId: w.w.people.officer, role: 'compliance-officer', scope: { kind: 'node', nodeId: w.w.nodeId } });
  await installSyntheticListSources(h.db.admin);
  const [source] = await first.q('SELECT id FROM trustwork.screening_list_source WHERE current');
  const create = async (hubId: string) => {
    const proposal = await first.a.cmd(first.w.people.officer, (trx, ctx) => proposeScreeningList(trx, ctx, { hubId, sourceId: source!.id as string,
      cadenceSeconds: 86400, warnAfterSeconds: 259200, staleAfterSeconds: 604800, reason: 'Synthetic responsible hub list', evidence: 'source_review' }));
    const [row] = await first.q('SELECT action_digest FROM trustwork.screening_list_proposal WHERE id=$1', [proposal.id]);
    await second.a.cmd(second.w.people.officer, (trx, ctx) => decideScreeningList(trx, ctx, proposal.id, { decision: 'approve', actionDigest: row!.action_digest as string, reason: 'Synthetic distinct current reviewer' }));
    const [list] = await first.q('SELECT id FROM trustwork.screening_list WHERE hub_id=$1 AND source_id=$2', [hubId, source!.id]);
    const version = await activateList(first.pool, list!.id as string, SYNTHETIC_SDN);
    return { id: list!.id as string, version };
  };
  const catalog = [...syntheticListSources()]; let serial = 0;
  const prepareAdditional = async (hubId: string) => {
    const marker = ++serial, pack = getPack('US')!;
    const sources = registeredListSources([validatePack({ ...pack, facets: { ...pack.facets, sanctions: [{
      id: `synthetic-payment-export-${marker}`, name: { en: `Synthetic payment export ${marker}` }, authority: { name: { en: 'Synthetic test authority' }, url: 'https://ofac.treasury.gov/' },
      url: `https://ofac.treasury.gov/synthetic-payment-${marker}`, verification: 'official',
      sources: [{ url: `https://ofac.treasury.gov/synthetic-payment-${marker}`, what: 'Synthetic fixture only; no source was fetched or reviewed', accessed: '2026-10-31' }], adapter: { capability: 'sanctions_list', id: 'ofac-sls-xml' },
    }] } })]);
    catalog.push(...sources); await withMaintenance(h.db.admin, (trx) => syncScreeningListSources(trx, catalog));
    const [source] = await first.q('SELECT id FROM trustwork.screening_list_source WHERE source_digest=$1', [sources[0]!.sourceDigest]);
    const proposal = await first.a.cmd(first.w.people.officer, (trx, ctx) => proposeScreeningList(trx, ctx, { hubId, sourceId: source!.id as string,
      cadenceSeconds: 86400, warnAfterSeconds: 259200, staleAfterSeconds: 604800, reason: 'Synthetic newly configured local list', evidence: 'source_review' }));
    const [row] = await first.q('SELECT action_digest FROM trustwork.screening_list_proposal WHERE id=$1', [proposal.id]);
    return { id: proposal.id, digest: row!.action_digest as string, sourceId: source!.id as string, ctx: await second.a.elevate(second.w.people.officer), actor: second.w.people.officer,
      finish: async () => { const [list] = await first.q('SELECT id FROM trustwork.screening_list WHERE hub_id=$1 AND source_id=$2', [hubId, source!.id]);
        return activateList(first.pool, list!.id as string, SYNTHETIC_SDN); } };
  };
  return { payer: await create(first.hubId), payee: await create(second.hubId), create, prepareAdditional };

}

/** Stage changed synthetic bytes through the owning worker API, leaving activation for a real competing transaction. */
export async function stageLocalPaymentList(h: Harness, listId: string, marker: number) {
  const { withMaintenance } = await import('@trustwork/data');
  const { screeningListWorker } = await import('../../packages/data/src/repositories/screening-lists.js');
  const { listDigest, parseOfacSlsXml, renderOfacSlsXml, sourceDigest } = await import('../../packages/compliance/src/lists/index.js');
  const { checkListSanity } = await import('../../packages/contracts/src/sanctions.js');
  const parsed = parseOfacSlsXml(renderOfacSlsXml({ publishedOn: '2026-10-20', entries: [...SYNTHETIC_SDN,
    { uid: String(980000 + marker), type: 'entity', lastName: `SYNTHETIC COVERAGE MARKER ${marker}`, programs: ['SYNTHETIC-COVERAGE'] }] }));
  return withMaintenance(h.db.admin, async (trx) => {
    const prior = await screeningListWorker.lock(trx, listId);
    return screeningListWorker.stage(trx, { listId, publishedOn: parsed.publishedOn, fetchedAt: new Date(), mode: 'file',
      sourceDigest: sourceDigest(listDigest(parsed.entries)), digest: listDigest(parsed.entries), entries: parsed.entries,
      sanity: checkListSanity({ parsedCount: parsed.entries.length, declaredCount: parsed.declaredCount, previousCount: prior?.active?.entryCount ?? null, maxDropShare: 0.99, minEntries: 1 }) });
  });
}
