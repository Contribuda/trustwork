import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { screeningWorld } from './world.js';
import { expectError } from '../../../backend/helpers/app.js';
import { login } from '../../../backend/helpers/personas.js';
import { baselineIds } from '../../../screening-lists/helpers.js';
import { person, screen } from '../../../screening/helpers.js';
import { geolocationView } from '../../../../apps/api/src/modules/jurisdiction/geolocation.controller.js';
import { loadRangeTable, rangesFileGate, restrictedPlaces, upstreamGate, ScreeningListsOverviewSchema, ScreeningVersionsSchema, ScreeningGeolocationSchema, ScreeningSubjectPanelSchema, ScreeningMetricsSchema } from '../../../../packages/contracts/src/sanctions.js';

function rangeGate(month: string) {
  return rangesFileGate(loadRangeTable({ format: 'trustwork-restricted-ranges-1', dataset: 'synthetic-ranges', month,
    attribution: 'Synthetic local test dataset', codes: ['CU'], v4: [[0xc0000200, 0xc00002ff, 0]], v6: [] }, restrictedPlaces(['CU'])));
}

test('active geolocation metadata distinguishes unknown, current and stale without guessing a date', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  assert.equal(geolocationView(upstreamGate(), now).freshness, 'unknown');
  assert.equal(geolocationView(rangeGate('2026-10'), now).ageMonths, 1);
  assert.equal(geolocationView(rangeGate('2026-09'), now).freshness, 'known');
  assert.equal(geolocationView(rangeGate('2026-08'), now).freshness, 'stale');
});

let foreignSession: Map<string, string>;
let foreignPerson: string;

test('SANC-006 authorized reads, repository freshness, exact subject lookup and cohort suppression', { timeout: 240_000 }, async (t) => {
  const w = await screeningWorld('sanc006_reads', 'https://trustwork.test', { gate: rangeGate('2026-01') });
  t.after(() => w.close());
  foreignSession = new Map(w.first.jar); foreignPerson = w.seed.people.petr;
  const ids = await baselineIds(w.h.db.admin);
  const metricsUrl = `/v1/admin/screening/metrics?hubId=${w.hubId}`;
  const routes = ['/v1/admin/screening/lists', `/v1/admin/screening/lists/${ids.sdn}/versions`, '/v1/admin/jurisdiction/geolocation', metricsUrl,
    `/v1/admin/screening/subjects/lookup/person/${w.seed.people.petr}`, `/v1/admin/screening/subjects/lookup/company/${w.seed.companies.unrelated}`, `/v1/admin/screening/list-authority?hubId=${w.hubId}`];
  await t.test('every read refuses anonymous, subject, ordinary account, unelevated staff and elevated staff without screening authority', async () => {
    const ordinary = w.h.client(); await login(ordinary, 'pure');
    for (const route of routes) {
      expectError(await w.h.client().get(route), 401, 'auth.session_invalid');
      for (const client of [w.subject, ordinary, w.unelevated]) expectError(await client.get(route), 403, 'access.forbidden');
      expectError(await w.otherStaff.get(route), 404, 'access.not_found');
      assert.equal((await w.first.get(route)).status, 200, route);
    }
    expectError(await w.first.get(`/v1/admin/screening/subjects/lookup/person/${randomUUID()}`), 404, 'access.not_found');
    expectError(await w.first.get(`/v1/admin/screening/subjects/lookup/company/${w.seed.people.petr}`), 404, 'access.not_found');
    expectError(await w.first.get(`/v1/admin/screening/metrics?hubId=${randomUUID()}`), 404, 'access.not_found');
  });
  await t.test('lists read actual versions and missing, warning and stale repository input', async () => {
    const read = async () => ScreeningListsOverviewSchema.parse((await w.first.get(routes[0]!)).body);
    const initial = await read(); assert.equal(initial.available, true);
    assert.equal(initial.items.length, 2); assert.ok(initial.items.every((list) => list.freshness.state === 'fresh' && list.activeVersion));
    const versions = ScreeningVersionsSchema.parse((await w.first.get(routes[1]!)).body);
    assert.equal(versions.items[0]?.id, initial.items.find((list) => list.id === ids.sdn)?.activeVersion?.id);
    assert.equal(versions.items[0]?.entryCount, 5);
    for (const [age, expected] of [[null, 'missing'], [4, 'warning'], [8, 'stale']] as const) {
      await withMaintenance(w.h.db.admin, (trx) => trx.updateTable('screening_list').set({ last_checked_at: age === null ? null : new Date(Date.now() - age * 86_400_000) }).where('id', '=', ids.sdn).execute());
      const next = await read(); assert.equal(next.items.find((list) => list.id === ids.sdn)?.freshness.state, expected);
      assert.equal(next.available, expected === 'warning');
    }
    await withMaintenance(w.h.db.admin, (trx) => trx.updateTable('screening_list').set({ last_checked_at: new Date() }).where('id', '=', ids.sdn).execute());
    const text = JSON.stringify(initial);
    for (const field of ['source_url', 'sourceUrl', 'entryName', 'name_keys', 'attributes', 'sanity']) assert.ok(!text.includes(field), field);
  });
  await t.test('geolocation describes the actual installed adapter; both participant types use only the screening projection', async () => {
    expectError(await w.first.get(`/v1/people/${w.seed.people.petr}/profile`), 404, 'access.not_found');
    const geo = ScreeningGeolocationSchema.parse((await w.first.get(routes[2]!)).body);
    assert.equal(geo.gate.dataset, 'synthetic-ranges-2026-01'); assert.equal(geo.gate.mode, 'ranges_file'); assert.equal(geo.freshness, 'stale');
    for (const [kind, id] of [['person', w.seed.people.petr], ['company', w.seed.companies.unrelated]] as const) {
      const response = await w.first.get(`/v1/admin/screening/subjects/lookup/${kind}/${id}`);
      const view = ScreeningSubjectPanelSchema.parse(response.body);
      assert.deepEqual(view.subject, { kind, id });
      assert.deepEqual(response.body, view, 'strict allowlist; no private profile/company card or unrelated case data');
      const byState = await w.first.get(`/v1/admin/screening/subjects/${view.subjectStateId}`);
      assert.deepEqual(byState.body, view);
    }
  });
  await t.test('unknown hub metrics have no invented denominator; durations exclude cohorts below ten distinct people', async () => {
    const read = async () => ScreeningMetricsSchema.parse((await w.first.get(metricsUrl)).body);
    const initial = await read(); assert.ok(initial.metrics.every((metric) => metric.state === 'unknown' && metric.value === null));
    assert.deepEqual(initial.rescreenDurations, []);
    const run = await w.first.post('/v1/admin/screening/rescreen-runs', { reason: 'Synthetic cohort boundary test' });
    assert.equal(run.status, 200); const runId = (run.body as { id: string }).id;
    await withMaintenance(w.h.db.admin, async (trx) => {
      await trx.updateTable('screening_rescreen_run').set({ state: 'running', started_at: new Date(Date.now() - 5000), subjects_total: 11 }).where('id', '=', runId).execute();
    });
    const add = async (kind: 'person' | 'company', id: string) => {
      const result = await screen(w.worker, { kind, id });
      await withMaintenance(w.h.db.admin, (trx) => trx.insertInto('screening_rescreen_item').values({ run_id: runId,
        subject_person_id: kind === 'person' ? id : null, subject_company_id: kind === 'company' ? id : null,
        phase: 'all', method: 'full', result_id: result.resultId, outcome: result.outcome }).execute());
    };
    for (let n = 0; n < 9; n++) await add('person', (await person(w.h.db.admin, `Synthetic cohort person ${n}`)).id);
    await add('company', w.seed.companies.unrelated);
    await withMaintenance(w.h.db.admin, (trx) => trx.updateTable('screening_rescreen_run').set({ state: 'done', subjects_done: 10, finished_at: new Date() }).where('id', '=', runId).execute());
    assert.deepEqual((await read()).rescreenDurations, [], 'nine people plus a company do not prove ten distinct principals');
    const suppressed = (await w.first.get('/v1/admin/screening/rescreen-runs')).body as { items: { id: string; progress: unknown }[] };
    assert.equal(suppressed.items.find((item) => item.id === runId)?.progress, null);
    assert.ok(!JSON.stringify(suppressed).includes('subjectsDone'));
    await add('person', (await person(w.h.db.admin, 'Synthetic tenth cohort person')).id);
    const after = await read(); assert.equal(after.rescreenDurations.length, 1); assert.equal(after.rescreenDurations[0]?.runId, runId);
    assert.ok(after.rescreenDurations[0]!.seconds >= 5);
    assert.ok(!JSON.stringify(after).includes('subject_person_id'));
    const runs = (await w.first.get('/v1/admin/screening/rescreen-runs')).body as { items: { id: string; progress: { subjectsDone: number } | null }[] };
    assert.equal(runs.items.find((item) => item.id === runId)?.progress?.subjectsDone, 10);
  });
});

test('node auditor can read new projections but cannot mutate', { timeout: 240_000 }, async (t) => {
  const w = await screeningWorld('sanc006_auditor', 'https://trustwork.test', { auditorSecond: true }); t.after(() => w.close());
  const routes = ['/v1/admin/screening/lists', '/v1/admin/jurisdiction/geolocation', `/v1/admin/screening/metrics?hubId=${w.hubId}`,
    `/v1/admin/screening/subjects/lookup/person/${w.seed.people.petr}`, `/v1/admin/screening/subjects/lookup/company/${w.seed.companies.unrelated}`, `/v1/admin/screening/list-authority?hubId=${w.hubId}`];
  const foreign = w.h.client(); for (const [name, value] of foreignSession) foreign.jar.set(name, value);
  for (const route of routes) {
    assert.equal((await w.second.get(route)).status, 200, route);
    expectError(await foreign.get(route), 401, 'auth.session_invalid');
  }
  expectError(await w.second.get(`/v1/admin/screening/subjects/lookup/person/${foreignPerson}`), 404, 'access.not_found');
  expectError(await w.second.post('/v1/admin/screening/list-proposals', {hubId:w.hubId,sourceId:randomUUID(),cadenceSeconds:86400,warnAfterSeconds:259200,staleAfterSeconds:604800,reason:'Synthetic auditor write refused',evidence:'source_review'}),403,'access.forbidden');
  expectError(await w.second.post('/v1/admin/screening/rescreen-runs', { reason: 'Synthetic auditor cannot write' }), 403, 'access.forbidden');
});
