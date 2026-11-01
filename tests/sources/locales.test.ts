import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { AllowedUsesSchema, LegalBasisSchema, SourceLicenceSchema, SourcePauseReasonSchema, TAKEDOWN_REASONS } from '@trustwork/contracts';
import {
  CrawlPolicyStatusSchema, ImportBatchStatusSchema, REGISTRY_SOURCE_STATUSES, RslStatusSchema, SourceItemStatusSchema,
} from '../../packages/contracts/src/sources.js';

/**
 * Every visible registry word has a string in all seven engine languages (namespace `sources`): statuses, licence flags,
 * licences, legal bases, RSL and robots outcomes, the labels readers see ("From sources", "Sponsored", "Machine-assisted
 * draft") and each refusal the database explains to a person (`details.reason` -> `sources.refusal.<reason>`).
 */
const ENGINE_LANGUAGES = ['en', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn', 'es'];
const read = (tag: string) => (JSON.parse(readFileSync(`apps/web/locales/${tag}/sources.json`, 'utf8')) as { sources: Record<string, Record<string, string>> }).sources;
/** Refusals that are shape or programming errors (explained by the generic validation messages), not decisions a person reads. */
const TECHNICAL = new Set(['immutable', 'invalid_batch', 'invalid_channel', 'invalid_decision', 'invalid_policy', 'invalid_rsl', 'invalid_terms', 'revision_conflict']);

test('the sources namespace exists in every engine language with the same keys', () => {
  const tags = readdirSync('apps/web/locales', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(tags, [...ENGINE_LANGUAGES].sort());
  const flat = (o: Record<string, Record<string, string>>) => Object.entries(o).flatMap(([g, v]) => Object.keys(v).map((k) => `${g}.${k}`)).sort();
  const en = flat(read('en'));
  for (const tag of ENGINE_LANGUAGES) {
    assert.deepEqual(flat(read(tag)), en, tag);
    if (tag !== 'en') for (const [g, values] of Object.entries(read(tag))) for (const [k, v] of Object.entries(values)) assert.notEqual(v, read('en')[g]![k], `${tag}: ${g}.${k} is untranslated`);
  }
});

test('every registry vocabulary value and every person-facing refusal has a string', () => {
  const en = read('en');
  const expect = (group: string, values: readonly string[]) => assert.deepEqual([...values].filter((v) => !(v in (en[group] ?? {}))), [], group);
  expect('use', Object.keys(AllowedUsesSchema.shape));
  expect('status', REGISTRY_SOURCE_STATUSES);
  expect('pauseReason', SourcePauseReasonSchema.options);
  expect('licence', SourceLicenceSchema.shape.kind.options);
  expect('legalBasis', LegalBasisSchema.options);
  expect('rsl', RslStatusSchema.options);
  expect('crawl', CrawlPolicyStatusSchema.options);
  expect('item', SourceItemStatusSchema.options);
  expect('batch', ImportBatchStatusSchema.options);
  expect('takedownReason', TAKEDOWN_REASONS);
  expect('label', ['sourced', 'sponsored', 'machineAssisted']);
  const sqlText = readFileSync('packages/data/migrations/sources/20261103040000_sources.sql', 'utf8');
  const hints = [...new Set([...sqlText.matchAll(/HINT = 'sources\.([a-z_]+)'/g)].map((m) => m[1] as string))];
  const dynamic = ['licence_restricts_use', 'rewrite_needs_full_text', 'rsl_forbids_use'];
  const service = readFileSync('apps/api/src/modules/sources/sources.service.ts', 'utf8');
  const apiReasons = [...new Set([...service.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1] as string))].filter((r) => r !== 'idempotency_key_mismatch');
  expect('refusal', [...hints.filter((h) => !TECHNICAL.has(h)), ...dynamic, ...apiReasons]);
  assert.ok(hints.length > 20, `${hints.length} hints found`);
});
