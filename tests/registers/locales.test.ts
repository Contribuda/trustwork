import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SOURCED_FACT_KINDS, SourcedFactValueSchemas, wordingProblems } from '../../packages/contracts/src/sourced-facts.js';

/**
 * REG-001: the company-page register panel (`companyPage.registerFacts`) in every maintained language. Russian is not
 * maintained (ADR 009 decision 11) and falls back to English, so it is not required here. Every language has exactly
 * the English keys and placeholders; every fact kind and every status the contract can carry has a label; the English
 * copy never claims the hub certified, licensed, verified or approved anyone.
 */
const MAINTAINED = ['en', 'es', 'uz-Latn', 'ka', 'hy', 'az-Latn'] as const;

type Tree = { [key: string]: string | Tree };
const panel = (lang: string): Tree => (JSON.parse(readFileSync(resolve(`apps/web/locales/${lang}/companies.json`), 'utf8')) as { companyPage: { registerFacts: Tree } }).companyPage.registerFacts;
const leaves = (tree: Tree, prefix = ''): Array<[string, string]> =>
  Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [[`${prefix}${k}`, v] as [string, string]] : leaves(v, `${prefix}${k}.`)));
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every maintained language has the English keys and placeholders of the register panel', () => {
  const en = new Map(leaves(panel('en')));
  for (const lang of MAINTAINED) {
    const mine = new Map(leaves(panel(lang)));
    assert.deepEqual([...mine.keys()].sort(), [...en.keys()].sort(), lang);
    for (const [key, text] of mine) {
      assert.ok(text.trim().length > 0, `${lang}: ${key}`);
      assert.deepEqual(placeholders(text), placeholders(en.get(key) as string), `${lang}: ${key} placeholders`);
      if (lang !== 'en') assert.ok(!/[Ѐ-ӿ]/.test(text), `${lang}: ${key} has no Cyrillic`);
    }
  }
});

test('every fact kind and every status the contract can carry has a label', () => {
  const en = panel('en') as { kind: Record<string, string>; status: Record<string, string> };
  assert.deepEqual(Object.keys(en.kind).sort(), [...SOURCED_FACT_KINDS].sort());
  const statuses = new Set<string>();
  for (const schema of Object.values(SourcedFactValueSchemas)) {
    for (const field of ['status', 'registrationStatus']) {
      const options = (schema.shape as Record<string, { options?: readonly string[] }>)[field]?.options;
      for (const option of options ?? []) statuses.add(option);
    }
  }
  assert.deepEqual(Object.keys(en.status).sort(), [...statuses].sort());
});

test('the English copy never claims the hub certified, licensed, verified or approved anyone', () => {
  for (const [key, text] of leaves(panel('en'))) assert.deepEqual(wordingProblems(text), [], key);
});
