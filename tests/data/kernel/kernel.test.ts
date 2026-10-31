import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { computeDigest, conversionRule, convertQuantity, ROUNDING_MODES, UNIT_CATALOGUE, type RoundingMode } from '@trustwork/contracts';
import { COUNTRIES, getPack, PACKS, RESTRICTED } from '@trustwork/country-packs';
import { bindTransaction, withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import {
  contentVersion, exchangeRates, hubs, jurisdictions, KernelError, kernelReference, kernelSync, quantities, taxonomy, units, type KernelReferenceData,
} from '../../../packages/data/src/repositories/kernel.js';
import { TABLE_COLUMNS } from '../../../packages/data/src/schema/kernel.js';
import { provisionTestDatabase, SKIP_REASON, sqlState } from '../helpers/postgres.js';

interface Taxonomy { schemes: Record<string, { terms: { code: string }[] }>; releases: Record<string, unknown>[]; manifest: { schemes: { id: string }[] } }
const taxonomyModule = (await import(new URL('../../../data/taxonomy/validate.mjs', import.meta.url).href)) as {
  loadTaxonomy(): Taxonomy;
  relations(tax: Taxonomy): { from: string; relation: string; to: string }[];
};
const { loadTaxonomy, relations } = taxonomyModule;
const MIGRATION_DIR = fileURLToPath(new URL('../../../packages/data/migrations/kernel/', import.meta.url));
const KERNEL_TABLES = Object.keys(TABLE_COLUMNS).sort();

/** The SQL text of the kernel slice without comments, for the "no real-world literal" checks. */
function kernelSql(): string {
  return readdirSync(MIGRATION_DIR).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(MIGRATION_DIR, f), 'utf8')).join('\n')
    .split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
}
function quotedLiterals(sqlText: string): Set<string> {
  return new Set([...sqlText.matchAll(/'([^']*)'/g)].map((m) => m[1] as string));
}

test('the kernel migration states no real-world fact as a SQL literal (pure check, no database)', () => {
  const literals = quotedLiterals(kernelSql());
  const places = [...RESTRICTED.places.map((p) => p.code), ...COUNTRIES.map((c) => c.code), ...PACKS.flatMap((p) => [p.code, ...p.regions.map((r) => r.code)])];
  assert.deepEqual(places.filter((code) => literals.has(code)), [], 'no jurisdiction or restricted-place code');
  const convertible = UNIT_CATALOGUE.filter((u) => u.toBase !== null);
  assert.deepEqual(convertible.filter((u) => literals.has(u.code) || (u.toBase !== '1' && literals.has(u.toBase as string))).map((u) => u.code), [], 'no unit code or factor');
  const tax = loadTaxonomy();
  const codes = Object.values(tax.schemes).flatMap((s) => s.terms.map((t) => t.code)).filter((code) => code.includes('.'));
  assert.deepEqual(codes.filter((code) => literals.has(code)), [], 'no taxonomy code');
});

test('reference builders read only the sources of truth', async () => {
  const data = await kernelReference.fromRepository();
  assert.deepEqual(data.restricted.map((r) => r.code).sort(), RESTRICTED.places.map((p) => p.code).sort());
  assert.equal(data.units.length, UNIT_CATALOGUE.length);
  const packCodes = [...new Set(data.jurisdictions.filter((j) => j.source === 'pack').map((j) => j.packCode))].sort();
  assert.deepEqual(packCodes, PACKS.map((p) => p.code).sort());
  for (const code of ['UZ', 'GE', 'AM', 'AZ', ...(getPack('US') ? ['US'] : [])]) assert.ok(packCodes.includes(code), `${code} loads from its pack`);
  assert.equal(data.jurisdictions.some((j) => RESTRICTED.places.some((p) => p.code === j.code)), false, 'no restricted code is ever offered to the database');
  // Parents always come before children.
  const seen = new Set<string>();
  for (const j of data.jurisdictions) {
    if (j.parent) assert.ok(seen.has(j.parent), `${j.code} after ${j.parent}`);
    seen.add(j.code);
  }
});

const db = await provisionTestDatabase('kernel');

test('kernel persistence under the restricted runtime role', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const rejects = async (promise: Promise<unknown>, state: string, hint?: string) => {
    const error = await promise.then(() => null, (e: unknown) => e);
    assert.ok(error, 'expected a rejection');
    assert.equal(sqlState(error), state, String(error));
    if (hint) assert.equal((error as { hint?: string }).hint, hint, String(error));
  };
  /** Runs fn as maintenance and rolls everything back. */
  const scratch = async (fn: (trx: Transaction) => Promise<unknown>) => {
    const marker = new Error('rollback');
    await withMaintenance(db.admin, async (trx) => {
      await fn(trx);
      throw marker;
    }).catch((e: unknown) => {
      if (e !== marker) throw e;
    });
  };
  /** Public reference reads need no identity: the runtime login inside a plain transaction. */
  const anon = async <T>(fn: (trx: Transaction) => Promise<T>): Promise<T> => {
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(bindTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release(true);
    }
  };

  await t.test('every kernel table is ENABLE + FORCE RLS, owned by trustwork_owner, and the runtime role can only read (evidence: insert)', async () => {
    const { rows } = await db.admin.query<{ relname: string; force: boolean; owner: string }>(
      `SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS force, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'trustwork' AND c.relname = ANY($1) ORDER BY relname`, [KERNEL_TABLES]);
    assert.deepEqual(rows.map((r) => r.relname), KERNEL_TABLES);
    assert.ok(rows.every((r) => r.force && r.owner === 'trustwork_owner'));
    for (const table of KERNEL_TABLES) {
      type Privileges = { s: boolean; i: boolean; u: boolean; d: boolean; t: boolean; r: boolean };
      const privileges: pg.QueryResult<Privileges> = await db.admin.query<Privileges>(
        `SELECT has_table_privilege('trustwork_app', $1, 'SELECT') AS s, has_table_privilege('trustwork_app', $1, 'INSERT') AS i,
                has_any_column_privilege('trustwork_app', $1, 'UPDATE') AS u, has_table_privilege('trustwork_app', $1, 'DELETE') AS d,
                has_table_privilege('trustwork_app', $1, 'TRUNCATE') AS t, has_table_privilege('trustwork_app', $1, 'REFERENCES') AS r`, [`trustwork.${table}`]);
      const p: Privileges | undefined = privileges.rows[0];
      assert.deepEqual(p, { s: true, i: false, u: false, d: false, t: false, r: false }, table === 'evidence_artifact' ? undefined : table);
    }
    const evidenceInsert = await db.admin.query<{ any: boolean; scan: boolean; hold: boolean }>(
      `SELECT has_any_column_privilege('trustwork_app', 'trustwork.evidence_artifact', 'INSERT') AS any,
              has_column_privilege('trustwork_app', 'trustwork.evidence_artifact', 'scan_state', 'INSERT') AS scan,
              has_column_privilege('trustwork_app', 'trustwork.evidence_artifact', 'legal_hold', 'INSERT') AS hold`);
    assert.deepEqual(evidenceInsert.rows[0], { any: true, scan: false, hold: false });
    const recompute = await db.admin.query<{ x: boolean }>("SELECT has_function_privilege('trustwork_app', 'trustwork.kernel_recompute_restrictions()', 'EXECUTE') AS x");
    assert.equal(recompute.rows[0]?.x, false, 'the recompute stays owner-only');
    const lock = await db.admin.query<{ x: boolean }>("SELECT has_function_privilege('trustwork_app', 'trustwork.kernel_lock_restrictions_shared()', 'EXECUTE') AS x");
    assert.equal(lock.rows[0]?.x, false);
    const definers = await db.admin.query("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork' AND p.prosecdef AND p.proname LIKE 'kernel%'");
    assert.equal(definers.rowCount, 0, 'the kernel adds no SECURITY DEFINER function');
  });

  await t.test('before the restricted list is loaded every place counts as restricted (fail closed)', async () => {
    const { rows } = await db.app.query<{ r: boolean }>("SELECT trustwork.kernel_place_restricted('US') AS r");
    assert.equal(rows[0]?.r, true);
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('jurisdiction').values({ code: 'GE', level: 'country', source: 'pack', pack_code: 'GE', pack_version: 'v', selectable: true }).execute()), '23514', 'kernel.restricted_place');
    await rejects(withMaintenance(db.admin, (trx) => kernelSync.apply(trx, { restricted: [], units: [], conversionRules: [], jurisdictions: [], taxonomy: { releases: [], terms: [], relations: [] } })), 'kernel.sync_conflict' as never);
  });

  let data: KernelReferenceData;
  await t.test('the maintenance command loads everything from the sources and is idempotent', async () => {
    const result = spawnSync(process.execPath, ['packages/data/bin/kernel-sync.mjs'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: db.adminConfig.connectionString as string } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^kernel-sync: \{/);
    data = await kernelReference.fromRepository();
    const before = await db.admin.query<{ n: number; rev: number }>('SELECT count(*)::int AS n, sum(revision)::int AS rev FROM trustwork.jurisdiction');
    const report = await withMaintenance(db.admin, (trx) => kernelSync.apply(trx, data));
    assert.deepEqual({ changes: report.restrictionChanges, retired: report.jurisdictionsRetired }, { changes: 0, retired: 0 });
    const after = await db.admin.query<{ n: number; rev: number }>('SELECT count(*)::int AS n, sum(revision)::int AS rev FROM trustwork.jurisdiction');
    assert.deepEqual(after.rows[0], before.rows[0], 'a second sync changes nothing (revisions stable)');
    const counts = await db.admin.query<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM trustwork.restricted_place) AS restricted, (SELECT count(*)::int FROM trustwork.unit) AS units,
      (SELECT count(*)::int FROM trustwork.unit_conversion_rule) AS rules, (SELECT count(*)::int FROM trustwork.taxonomy_term) AS terms,
      (SELECT count(*)::int FROM trustwork.step_term_relation) AS relations, (SELECT count(*)::int FROM trustwork.taxonomy_release) AS releases`);
    assert.deepEqual(counts.rows[0], { restricted: RESTRICTED.places.length, units: UNIT_CATALOGUE.length, rules: data.conversionRules.length, terms: data.taxonomy.terms.length, relations: data.taxonomy.relations.length, releases: data.taxonomy.releases.length });
  });

  await t.test('two concurrent syncs serialize on the kernel lock and both succeed', async () => {
    const reports = await Promise.all([withMaintenance(db.admin, (trx) => kernelSync.apply(trx, data)), withMaintenance(db.admin, (trx) => kernelSync.apply(trx, data))]);
    assert.deepEqual(reports.map((r) => r.jurisdictionsRetired), [0, 0]);
  });

  await t.test('US, UZ, GE, AM and AZ jurisdictions come from their packs only, with the pack content version', async () => {
    for (const pack of PACKS) {
      const rows = await anon((trx) => jurisdictions.selectable(trx, pack.code));
      assert.deepEqual(rows.map((r) => r.code).sort(), [pack.code, ...pack.regions.map((r) => r.code)].sort(), pack.code);
      assert.ok(rows.every((r) => r.source === 'pack' && r.pack_code === pack.code && r.pack_version === contentVersion(pack) && !r.restricted));
    }
    const us = await anon((trx) => jurisdictions.get(trx, 'US'));
    assert.equal(us?.source, getPack('US') ? 'pack' : 'dataset', 'the US is a country row from the ISO dataset until the US pack lands, then its pack');
    const countries = await anon((trx) => jurisdictions.countries(trx));
    assert.deepEqual(countries.map((c) => c.code), [...COUNTRIES.map((c) => c.code)].sort());
    const restrictedVisible = await db.app.query('SELECT code FROM trustwork.jurisdiction WHERE restricted');
    assert.equal(restrictedVisible.rowCount, 0);
  });

  await t.test('restricted places: never a jurisdiction, never selectable, never a hub territory or hub country', async () => {
    for (const place of RESTRICTED.places) {
      const r: pg.QueryResult<{ r: boolean }> = await db.app.query<{ r: boolean }>('SELECT trustwork.kernel_place_restricted($1) AS r', [place.code]);
      assert.equal(r.rows[0]?.r, true, place.code);
      await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('jurisdiction').values({
        code: place.code, parent_code: place.code.length > 2 ? place.code.slice(0, 2) : null, level: place.code.length > 2 ? 'subdivision' : 'country',
        source: 'dataset', pack_code: null, pack_version: 'v', selectable: false,
      }).execute()), '23514', 'kernel.restricted_place');
    }
    const placeChecks = await db.app.query<{ code: string; r: boolean }>("SELECT code, trustwork.kernel_place_restricted(code) AS r FROM unnest(ARRAY['UA-43:sevastopol-bay', 'ua-43', 'UA', 'UA-30', 'GE-TB']) AS code");
    assert.deepEqual(placeChecks.rows.map((r) => [r.code, r.r]), [['UA-43:sevastopol-bay', true], ['ua-43', true], ['UA', false], ['UA-30', false], ['GE-TB', false]]);

    const uz = getPack('UZ');
    assert.ok(uz);
    const region = uz.regions[0]?.code as string;
    const hub = await withMaintenance(db.admin, (trx) => hubs.create(trx, { slug: 'kernel-test-uz', packCode: 'UZ', packVersion: contentVersion(uz) }));
    await withMaintenance(db.admin, (trx) => hubs.addTerritory(trx, { hubId: hub.id, level: 'country', code: 'UZ' }));
    await withMaintenance(db.admin, (trx) => hubs.addTerritory(trx, { hubId: hub.id, level: 'region', code: region }));
    await withMaintenance(db.admin, (trx) => hubs.addTerritory(trx, { hubId: hub.id, level: 'place', code: `${region}:old-town` }));
    for (const [level, code] of [['country', 'RU'], ['region', 'UA-43'], ['region', 'UA-14'], ['place', 'UA-40:harbour'], ['country', 'KP']] as const) {
      await rejects(withMaintenance(db.admin, (trx) => hubs.addTerritory(trx, { hubId: hub.id, level, code })), '23514', 'kernel.restricted_place');
    }
    await rejects(withMaintenance(db.admin, (trx) => hubs.addTerritory(trx, { hubId: hub.id, level: 'region', code: 'UZ-ZZ' })), '23503', 'kernel.jurisdiction_unknown');
    await rejects(withMaintenance(db.admin, (trx) => hubs.create(trx, { slug: 'kernel-test-ru', packCode: 'RU', packVersion: 'v' })), '23514', 'kernel.restricted_place');
    await rejects(withMaintenance(db.admin, (trx) => hubs.create(trx, { slug: 'kernel-test-ir', packCode: 'IR', packVersion: 'v' })), '23514', 'kernel.restricted_place');
    await rejects(withMaintenance(db.admin, (trx) => hubs.create(trx, { slug: 'kernel-test-kz', packCode: 'KZ', packVersion: 'v' })), '23514', 'kernel.pack_unknown');
    // The runtime role writes no hub, territory or jurisdiction at all.
    await rejects(db.app.query('INSERT INTO trustwork.hub_territory (hub_id, level, code) VALUES ($1, $2, $3)', [hub.id, 'country', 'RU']), '42501');
    await rejects(db.app.query("INSERT INTO trustwork.jurisdiction (code, level, source, pack_version) VALUES ('XA', 'country', 'dataset', 'v')"), '42501');
    await rejects(db.app.query("UPDATE trustwork.jurisdiction SET selectable = true"), '42501');
    await rejects(db.app.query('DELETE FROM trustwork.restricted_place'), '42501');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('jurisdiction').where('code', '=', 'UZ').execute()), '23000', 'kernel.jurisdiction_permanent');
  });

  await t.test('a place that becomes restricted turns unselectable, hidden and refused (user-assigned ISO code XA as a stand-in)', async () => {
    await withMaintenance(db.admin, (trx) => trx.insertInto('jurisdiction').values({ code: 'XA', level: 'country', source: 'dataset', pack_code: null, pack_version: 'test', selectable: true }).execute());
    await scratch(async (trx) => {
      await trx.insertInto('restricted_place').values({ code: 'XA', basis: 'test stand-in' }).execute();
      await trx.selectNoFrom((eb) => eb.fn('trustwork.kernel_recompute_restrictions', []).as('n')).execute();
      const row = await trx.selectFrom('jurisdiction').select(['restricted', 'selectable']).where('code', '=', 'XA').executeTakeFirstOrThrow();
      assert.deepEqual(row, { restricted: true, selectable: false });
      await assert.rejects(trx.updateTable('jurisdiction').set({ selectable: true }).where('code', '=', 'XA').execute(), (e: unknown) => sqlState(e) === '23514');
    });
    // restricted is computed: a written value is overwritten by the list.
    const written = await withMaintenance(db.admin, async (trx) => {
      await trx.updateTable('jurisdiction').set({ restricted: true, selectable: false }).where('code', '=', 'XA').execute();
      return trx.selectFrom('jurisdiction').select('restricted').where('code', '=', 'XA').executeTakeFirstOrThrow();
    });
    assert.equal(written.restricted, false, 'the stored flag follows the list, not the written value');
  });

  await t.test('concurrency: a territory insert waits for a running restricted-list sync and then sees the new list', async () => {
    await withMaintenance(db.admin, (trx) => trx.insertInto('jurisdiction').values({ code: 'XB', level: 'country', source: 'dataset', pack_code: null, pack_version: 'test', selectable: true }).execute());
    const hub = await withMaintenance(db.admin, (trx) => hubs.create(trx, { slug: 'kernel-test-race', packCode: null, packVersion: null }));
    const syncer = new pg.Client(db.adminConfig);
    const writer = new pg.Client(db.adminConfig);
    await syncer.connect();
    await writer.connect();
    try {
      for (const c of [syncer, writer]) {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE trustwork_owner');
        await c.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      }
      await syncer.query("SELECT pg_advisory_xact_lock(hashtext('trustwork.kernel_restrictions'))");
      await syncer.query("INSERT INTO trustwork.restricted_place (code, basis) VALUES ('XB', 'test stand-in')");
      await syncer.query('SELECT trustwork.kernel_recompute_restrictions()');
      let settled = false;
      const insert = writer.query("INSERT INTO trustwork.hub_territory (hub_id, level, code) VALUES ($1, 'country', 'XB')", [hub.id]).finally(() => {
        settled = true;
      });
      insert.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(settled, false, 'the territory check waits for the sync');
      await syncer.query('COMMIT');
      await rejects(insert, '23514', 'kernel.restricted_place');
      await writer.query('ROLLBACK');
    } finally {
      await syncer.end();
      await writer.end();
    }
  });

  await t.test('units: catalogue and explicit rules match the contract exactly', async () => {
    const list = await anon((trx) => units.list(trx));
    assert.deepEqual(list.map((u) => u.code).sort(), UNIT_CATALOGUE.map((u) => u.code).sort());
    for (const [from, to] of [['ft', 'm'], ['m', 'ft'], ['ac', 'ha'], ['us_gal', 'l'], ['short_ton', 't'], ['h', 'min']] as const) {
      const rule = await anon((trx) => units.rule(trx, from, to));
      const expected = conversionRule(from, to);
      assert.deepEqual([rule?.numerator, rule?.denominator], [expected.numerator.toString(), expected.denominator.toString()], `${from}->${to}`);
    }
    assert.equal(await anon((trx) => units.rule(trx, 'pc', 'set')), undefined, 'count units never convert');
    assert.equal(await anon((trx) => units.rule(trx, 'm', 'kg')), undefined, 'no rule across dimensions');
  });

  await t.test('quantities: same-unit addition only; conversion only through a stored rule, equal to the contract', async () => {
    assert.deepEqual(await anon((trx) => quantities.add(trx, { value: '1.5', unit: 'm' }, { value: '2.25', unit: 'm' })), { value: '3.75', unit: 'm' });
    assert.deepEqual(await anon((trx) => quantities.add(trx, { value: '-1.5', unit: 'm2' }, { value: '1.5', unit: 'm2' })), { value: '0.0', unit: 'm2' });
    for (const [a, b] of [['m', 'ft'], ['m2', 'ft2'], ['kg', 'lb'], ['pc', 'set']] as const) {
      await assert.rejects(anon((trx) => quantities.add(trx, { value: '1', unit: a }, { value: '1', unit: b })), (e: unknown) => e instanceof KernelError && e.code === 'validation.unit_mismatch');
    }
    await rejects(db.app.query("SELECT trustwork.kernel_quantity_add('1', 'm', '1', 'ft')"), '22023', 'validation.unit_mismatch');
    await rejects(db.app.query("SELECT trustwork.kernel_quantity_add('1.0000001', 'm', '1', 'm')"), '22023', 'validation.decimal');

    const values = ['0', '1', '-1', '2.5', '-2.5', '0.000001', '123456.789012', '-0.5', '999999.999999'];
    const pairs = [['m', 'ft'], ['ft', 'm'], ['ac', 'm2'], ['yd3', 'm3'], ['lb', 'kg'], ['h', 's'], ['bdft', 'l'], ['pc', 'pc']] as const;
    let compared = 0;
    for (const [from, to] of pairs) {
      for (const value of values) {
        for (const rounding of ROUNDING_MODES as readonly RoundingMode[]) {
          for (const scale of [0, 2, 6]) {
            const expected = convertQuantity({ value, unit: from }, to, { scale, rounding });
            const actual = await anon((trx) => quantities.convert(trx, { value, unit: from }, to, { scale, rounding }));
            assert.deepEqual(actual, expected, `${value} ${from} -> ${to} scale ${scale} ${rounding}`);
            compared++;
          }
        }
      }
    }
    assert.equal(compared, pairs.length * values.length * ROUNDING_MODES.length * 3);
    for (const [from, to] of [['pc', 'set'], ['m', 'kg'], ['ls', 'pc'], ['m', 'parsec']] as const) {
      await assert.rejects(anon((trx) => quantities.convert(trx, { value: '1', unit: from }, to, { scale: 2, rounding: 'half-even' })), (e: unknown) => e instanceof KernelError && e.code === 'validation.unit_conversion', `${from}->${to}`);
    }
    await rejects(db.app.query("SELECT trustwork.kernel_quantity_convert('1', 'm', 'ft', 7, 'half-even')"), '22023', 'validation.unit_conversion');
    await rejects(db.app.query("SELECT trustwork.kernel_quantity_convert('1', 'm', 'ft', 2, NULL)"), '22023', 'validation.unit_conversion');
  });

  await t.test('conversion uses the stored rule and nothing else: without the row there is no conversion', async () => {
    await scratch(async (trx) => {
      await trx.deleteFrom('unit_conversion_rule').where('from_unit', '=', 'm').where('to_unit', '=', 'ft').execute();
      assert.deepEqual(await quantities.convert(trx, { value: '1', unit: 'ft' }, 'm', { scale: 4, rounding: 'half-even' }), { value: '0.3048', unit: 'm' }, 'the reverse rule still exists');
      await assert.rejects(quantities.convert(trx, { value: '1', unit: 'm' }, 'ft', { scale: 2, rounding: 'half-even' }), (e: unknown) => e instanceof KernelError && e.code === 'validation.unit_conversion');
    });
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('unit_conversion_rule').values({ from_unit: 'm', to_unit: 'kg', numerator: '1', denominator: '1', source: 'test' }).execute()), '23514', 'validation.unit_conversion');
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('unit_conversion_rule').values({ from_unit: 'pc', to_unit: 'set', numerator: '1', denominator: '1', source: 'test' }).execute()), '23514', 'validation.unit_conversion');
    await rejects(db.app.query("INSERT INTO trustwork.unit_conversion_rule (from_unit, to_unit, numerator, denominator, source) VALUES ('m', 'ft', 1, 1, 'x')"), '42501');
    await rejects(db.app.query("UPDATE trustwork.unit_conversion_rule SET numerator = 2"), '42501');
  });

  await t.test('taxonomy: plan-step terms, releases and relations from data/taxonomy; codes stable once released', async () => {
    const tax = loadTaxonomy();
    const release = tax.releases[0] as Record<string, unknown>;
    const { file: _file, ...payload } = release;
    void _file;
    const stored = await db.app.query<{ version: string; digest: string }>('SELECT version, digest FROM trustwork.taxonomy_release WHERE hub_id IS NULL');
    assert.deepEqual(stored.rows, [{ version: payload.version, digest: computeDigest({ payload }).value }]);
    for (const scheme of ['work_type', 'trade', 'material', 'stage', 'permit_type', 'inspection_type', 'decision', 'project_type'] as const) {
      const terms = await anon((trx) => taxonomy.terms(trx, scheme));
      assert.equal(terms.length, tax.schemes[scheme]?.terms.length, scheme);
    }
    const roofing = await anon((trx) => taxonomy.relationsFrom(trx, 'work.envelope.roofing'));
    const expected = relations(tax).filter((r) => r.from === 'work.envelope.roofing');
    assert.deepEqual(roofing.map((r) => `${r.relation}:${r.to_code}`).sort(), expected.map((r) => `${r.relation}:${r.to}`).sort());
    const kinds = await db.app.query<{ relation: string }>('SELECT DISTINCT relation FROM trustwork.step_term_relation ORDER BY relation');
    assert.deepEqual(kinds.rows.map((r) => r.relation), [...new Set(relations(tax).map((r) => r.relation))].sort());
    assert.ok(kinds.rows.some((r) => r.relation === 'precedes') && kinds.rows.some((r) => r.relation === 'in_stage'));
    const trade = await anon((trx) => taxonomy.term(trx, 'trade.general_contractor'));
    assert.equal((trade?.attributes as { kind?: string }).kind, 'contractor');

    const code = 'work.envelope.roofing';
    for (const change of [{ code: 'work.envelope.roof' }, { status: 'draft' as const }, { scheme: 'material' as const }]) {
      await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('taxonomy_term').set(change).where('code', '=', code).where('hub_id', 'is', null).execute()), '23000', 'kernel.taxonomy_code_stable');
    }
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('taxonomy_term').where('code', '=', code).execute()), '23000', 'kernel.taxonomy_code_stable');
    await scratch(async (trx) => {
      await trx.updateTable('taxonomy_term').set({ status: 'retired' }).where('code', '=', code).where('hub_id', 'is', null).execute();
      await assert.rejects(trx.updateTable('taxonomy_term').set({ status: 'released' }).where('code', '=', code).where('hub_id', 'is', null).execute(), (e: unknown) => (e as { hint?: string }).hint === 'kernel.taxonomy_code_stable');
    });
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('taxonomy_release').set({ digest: '0'.repeat(64) }).execute()), '23000', 'audit.append_only');
    await rejects(db.app.query("INSERT INTO trustwork.taxonomy_term (scheme, code) VALUES ('trade', 'trade.app_written')"), '42501');
  });

  await t.test('taxonomy: hub extensions never redefine engine codes; relation schemes are checked; drafts are not served', async () => {
    const hub = await withMaintenance(db.admin, (trx) => hubs.create(trx, { slug: 'kernel-test-taxonomy', lifecycle: 'soft_launch', packCode: 'GE', packVersion: contentVersion(getPack('GE')) }));
    const engineParent = await withMaintenance(db.admin, (trx) => trx.selectFrom('taxonomy_term').select('id').where('code', '=', 'work.envelope').where('hub_id', 'is', null).executeTakeFirstOrThrow());
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('taxonomy_term').values({ hub_id: hub.id, scheme: 'work_type', code: 'work.envelope.roofing', parent_id: engineParent.id }).execute()), '23505', 'kernel.taxonomy_engine_code');
    const local = await withMaintenance(db.admin, (trx) => trx.insertInto('taxonomy_term').values({ hub_id: hub.id, scheme: 'work_type', code: 'work.envelope.local_clay_tiles', parent_id: engineParent.id }).returning('id').executeTakeFirstOrThrow());
    const visible = await db.app.query('SELECT 1 FROM trustwork.taxonomy_term WHERE id = $1', [local.id]);
    assert.equal(visible.rowCount, 0, 'draft terms are never served');
    const material = await withMaintenance(db.admin, (trx) => trx.selectFrom('taxonomy_term').select('id').where('scheme', '=', 'material').where('parent_id', 'is not', null).executeTakeFirstOrThrow());
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('step_term_relation').values({ hub_id: hub.id, from_term_id: local.id, relation: 'requires_trade', to_term_id: material.id }).execute()), '23514', 'kernel.taxonomy_relation_scheme');
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('step_term_relation').values({ hub_id: null, from_term_id: local.id, relation: 'uses_material', to_term_id: material.id }).execute()), '23514', 'kernel.taxonomy_relation_scope');
    await withMaintenance(db.admin, (trx) => trx.insertInto('step_term_relation').values({ hub_id: hub.id, from_term_id: local.id, relation: 'uses_material', to_term_id: material.id }).execute());
  });

  await t.test('concurrency: an engine term and a hub term with the same new code cannot both commit', async () => {
    const hub = await withMaintenance(db.admin, (trx) => hubs.create(trx, { slug: 'kernel-test-taxrace', packCode: null, packVersion: null }));
    const a = new pg.Client(db.adminConfig);
    const b = new pg.Client(db.adminConfig);
    await a.connect();
    await b.connect();
    try {
      for (const c of [a, b]) {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE trustwork_owner');
        await c.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      }
      await a.query("INSERT INTO trustwork.taxonomy_term (scheme, code) VALUES ('skill', 'skill.concurrent_probe')");
      let settled = false;
      const second = b.query("INSERT INTO trustwork.taxonomy_term (hub_id, scheme, code) VALUES ($1, 'skill', 'skill.concurrent_probe')", [hub.id]).finally(() => {
        settled = true;
      });
      second.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(settled, false, 'the hub insert waits on the code lock');
      await a.query('COMMIT');
      await rejects(second, '23505', 'kernel.taxonomy_engine_code');
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }
  });

  await t.test('hubs: the runtime role sees hubs from soft launch on, never drafts', async () => {
    const draft = await withMaintenance(db.admin, (trx) => hubs.create(trx, { slug: 'kernel-test-draft', packCode: null, packVersion: null }));
    const live = await withMaintenance(db.admin, (trx) => hubs.create(trx, { slug: 'kernel-test-live', lifecycle: 'public', packCode: 'AM', packVersion: contentVersion(getPack('AM')) }));
    assert.equal(await anon((trx) => hubs.get(trx, draft.id)), undefined);
    assert.equal((await anon((trx) => hubs.bySlug(trx, 'kernel-test-live')))?.id, live.id);
    await rejects(db.app.query("UPDATE trustwork.hub SET lifecycle = 'public'"), '42501');
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('hub').values({ slug: 'kernel-test-half', pack_code: 'AM', pack_version: null }).execute()), '23514');
  });

  await t.test('exchange-rate snapshots: append-only, explicit, maintenance-written', async () => {
    const snapshot = await withMaintenance(db.admin, (trx) => exchangeRates.record(trx, { base: 'USD', quote: 'GEL', rate: '2.7', source: 'test fixture rate', observedAt: '2026-10-30T12:00:00Z' }));
    await withMaintenance(db.admin, (trx) => exchangeRates.record(trx, { base: 'USD', quote: 'GEL', rate: '2.71', source: 'test fixture rate', observedAt: '2026-10-31T12:00:00Z' }));
    assert.equal((await anon((trx) => exchangeRates.latest(trx, 'USD', 'GEL')))?.rate, '2.71');
    assert.equal((await anon((trx) => exchangeRates.get(trx, snapshot.id)))?.rate, '2.7');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('exchange_rate_snapshot').set({ rate: '3' }).execute()), '23000', 'audit.append_only');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('exchange_rate_snapshot').execute()), '23000', 'audit.append_only');
    for (const [base, quote, rate] of [['USD', 'USD', '1'], ['USD', 'EUR', '0'], ['USD', 'EUR', '-1'], ['USD', 'EUR', '1.0000001'], ['usd', 'EUR', '1']]) {
      await rejects(withMaintenance(db.admin, (trx) => exchangeRates.record(trx, { base: base as string, quote: quote as string, rate: rate as string, source: 'x', observedAt: '2026-10-31T00:00:00Z' })), '23514');
    }
    await rejects(db.app.query("INSERT INTO trustwork.exchange_rate_snapshot (base_currency, quote_currency, rate, source, observed_at) VALUES ('USD', 'EUR', '1', 'x', now())"), '42501');
  });

  await t.test('the runtime role under a principal sees the same public reference data and still cannot write it', async () => {
    const person = await withMaintenance(db.admin, (trx) => trx.insertInto('person').values({ display_name: 'Kernel Probe' }).returning(['id', 'authz_epoch']).executeTakeFirstOrThrow());
    const count = await withPrincipal(db.app, { personId: person.id, authzEpoch: person.authz_epoch }, (trx) => trx.selectFrom('unit').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow());
    assert.equal(Number(count.n), UNIT_CATALOGUE.length);
    await assert.rejects(withPrincipal(db.app, { personId: person.id, authzEpoch: person.authz_epoch }, (trx) => trx.insertInto('restricted_place').values({ code: 'XC', basis: 'x' }).execute()), (e: unknown) => sqlState(e) === '42501');
  });
});
