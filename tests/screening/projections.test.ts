import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { z } from 'zod';
import * as contracts from '../../packages/contracts/src/index.js';
import * as sanctions from '../../packages/contracts/src/sanctions.js';
import { SCREENING_PRIVATE_FIELDS } from '../../packages/contracts/src/sanctions.js';
import { SKIP_REASON, provisionTestDatabase } from '../data/helpers/postgres.js';

/**
 * SANC-003 acceptance: no screening field appears in any public, counterparty, search, federation or agent projection
 * (ADR 014 decision 16). Three layers:
 *
 * 1. Contracts: no schema outside the screening contracts (and the staff-only hub console) carries a screening field,
 *    so no projection built from them can; the projection schemas are named and checked first.
 * 2. Database: no function, view or policy outside the screening module reads a screening table, so no public read,
 *    search document, federation export or agent context derived in SQL can include one.
 * 3. Sources: no API module, web page, worker job or repository other than the screening slice imports the screening
 *    repository or names a screening table.
 */

type Walkable = { _zod?: { def?: Record<string, unknown> } };
/** Every object key reachable in a Zod 4 schema (objects, wrappers, arrays, unions, intersections, records, pipes, lazies). */
function keysOf(schema: unknown, seen = new Set<unknown>()): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const def = (node as Walkable)._zod?.def;
    if (!def) return;
    switch (def.type) {
      case 'object':
        for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) {
          out.add(key);
          walk(value);
        }
        if (def.catchall) walk(def.catchall);
        break;
      case 'array': walk(def.element); break;
      case 'union': for (const option of def.options as unknown[]) walk(option); break;
      case 'intersection': walk(def.left); walk(def.right); break;
      case 'record': case 'map': walk(def.keyType); walk(def.valueType); break;
      case 'set': walk(def.valueType); break;
      case 'tuple': for (const item of (def.items as unknown[]) ?? []) walk(item); if (def.rest) walk(def.rest); break;
      case 'pipe': walk(def.in); walk(def.out); break;
      case 'lazy': walk((def.getter as () => unknown)()); break;
      default:
        if (def.innerType) walk(def.innerType);
    }
  };
  walk(schema);
  return out;
}

const isSchema = (value: unknown): value is z.ZodType => !!value && typeof value === 'object' && !!(value as Walkable)._zod?.def;
const screeningSchemas = new Set<unknown>(Object.values(sanctions).filter(isSchema));
const PRIVATE = new Set<string>(SCREENING_PRIVATE_FIELDS);
/** Projections by name: what the public, counterparties, search, federation and agents receive. */
const PROJECTION_NAME = /(Public|Participant|Counterparty|Shared|Search|Federat|Peer|Manifest|Agent|Mcp|Directory|Listing|Snapshot|Projection|Profile|Passport|Credential|Recommendation)/;

test('contracts: no projection schema, and no schema outside the screening contracts, carries a screening field', () => {
  const exported = Object.entries(contracts).filter(([, value]) => isSchema(value) && !screeningSchemas.has(value)) as [string, z.ZodType][];
  assert.ok(exported.length > 200, `walked ${exported.length} schemas`);
  const projections = exported.filter(([name]) => PROJECTION_NAME.test(name));
  assert.ok(projections.length > 20, `found ${projections.length} projection schemas`);
  for (const [name, schema] of projections) {
    const leaked = [...keysOf(schema)].filter((key) => PRIVATE.has(key));
    assert.deepEqual(leaked, [], `${name} carries no screening field`);
  }
  for (const [name, schema] of exported) {
    const leaked = [...keysOf(schema)].filter((key) => PRIVATE.has(key));
    assert.deepEqual(leaked, [], `${name} carries no screening field`);
  }
  // The screening contracts themselves do carry them (the check is not vacuous).
  assert.ok(keysOf(sanctions.ScreeningStateSchema).has('moneyHeld'));
  assert.ok(keysOf(sanctions.ScreeningMatchSchema).has('matchedKey'));
});

const ROOT = resolve(import.meta.dirname, '../..');
function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name.startsWith('.next')) return [];
    if (entry.isDirectory()) return files(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

test('sources: only the screening slice reads screening records', () => {
  const TABLES = /screening_(subject_state|result|match|decision|report_draft)\b|repositories\/screening\.js|modules\/screening\//;
  const allowed = [
    'apps/api/src/modules/screening/', 'apps/worker/src/screening/', 'packages/data/src/repositories/screening.ts', 'packages/data/src/schema/screening.ts',
    // SANC-005 re-screening is part of the screening engine: it records results through the screening repository.
    'apps/worker/src/rescreen/', 'packages/data/src/repositories/rescreen.ts', 'packages/data/src/schema/rescreen.ts',
    // Registration only: the identity module mounts the screening routes; the composition root adds the suspension hook.
    'apps/api/src/modules/identity/identity.module.ts', 'apps/api/src/app.ts',
    // DATA-002 names `screening_result` as an object type a staff case grant may cover (staff_case), without reading it.
    'packages/data/src/schema/admin.ts',
  ];
  const sources = [
    ...files(join(ROOT, 'apps/api/src'), /\.ts$/), ...files(join(ROOT, 'apps/worker/src'), /\.ts$/), ...files(join(ROOT, 'packages/data/src'), /\.ts$/),
    ...files(join(ROOT, 'apps/web'), /\.(ts|tsx)$/), ...files(join(ROOT, 'packages/contracts/src'), /\.ts$/),
  ];
  assert.ok(sources.length > 100);
  const offenders = sources.map((f) => relative(ROOT, f)).filter((f) => !allowed.some((a) => f.startsWith(a))).filter((f) => TABLES.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(offenders, [], 'no other module, page or repository reads screening records');
});

const db = await provisionTestDatabase('screening_projections');

test('database: no function, view or policy outside the screening module reads a screening table', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  const TABLES = ['screening_subject_state', 'screening_result', 'screening_match', 'screening_decision', 'screening_report_draft'];
  const pattern = `(${TABLES.join('|')})`;
  const fns = await db.admin.query<{ proname: string }>(
    "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork' AND p.prosrc ~ $1 ORDER BY 1", [pattern]);
  assert.ok(fns.rows.length > 5, 'the screening functions themselves are found');
  for (const row of fns.rows) assert.match(row.proname, /^screening_/, `${row.proname} is a screening function`);
  const publicReads = (await db.admin.query<{ proname: string }>(
    "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork' AND (p.proname ~ '(public|search|federat|agent|assistant|directory|profiles|catalogue|trust_)' ) AND p.prosrc ~ $1", [pattern])).rows;
  assert.deepEqual(publicReads, [], 'no public, search, federation, directory, profile, catalogue, trust or assistant read touches screening');
  const views = await db.admin.query<{ viewname: string }>("SELECT viewname FROM pg_views WHERE schemaname = 'trustwork' AND definition ~ $1", [pattern]);
  assert.deepEqual(views.rows, []);
  const policies = await db.admin.query<{ tablename: string; policyname: string }>(
    "SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'trustwork' AND tablename NOT LIKE 'screening\\_%' AND (coalesce(qual, '') ~ $1 OR coalesce(with_check, '') ~ $1)", [pattern]);
  assert.deepEqual(policies.rows, [], 'no other table opens or narrows on screening data');
  const reads = await db.admin.query<{ tablename: string; policyname: string; qual: string }>("SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname = 'trustwork' AND tablename = ANY ($1) AND cmd = 'SELECT'", [TABLES]);
  for (const row of reads.rows) assert.equal(row.qual, 'jurisdiction_staff_reader()', `${row.tablename}: only compliance staff and auditors read`);
  assert.equal(reads.rows.length, TABLES.length);
});
