import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicFeeCategory } from '../../../apps/web/app/(public)/[lang]/pricing/categories.js';
import { FeeTermsSchema } from '../../../packages/contracts/src/billing-fees.js';
import { syntheticTerms } from './helpers.js';

test('pricing resolves actual consultation and task registry labels in every language without exposing unknown keys',()=>{
  assert.ok(FeeTermsSchema.safeParse(syntheticTerms({kind:'task',categoryKey:'work.envelope.roofing'})).success);
  for (const categoryKey of ['work..roofing','work.roofing.','.work.roofing','work.Roofing','x'.repeat(62)]) {
    assert.equal(FeeTermsSchema.safeParse(syntheticTerms({kind:'task',categoryKey})).success,false);
  }
  for(const locale of ['en','es','ru','uz-Latn','ka','hy','az-Latn']) {
    const consultations=JSON.parse(readFileSync(`apps/web/locales/${locale}/consultations.json`,'utf8')).consultations.kind;
    const pricing=JSON.parse(readFileSync(`apps/web/locales/${locale}/pricing.json`,'utf8')).pricing;
    const taxonomy=JSON.parse(readFileSync(`data/taxonomy/locales/${locale}.json`,'utf8')).labels;
    const translate=(key:string)=>key==='pricing.allCategories'?pricing.allCategories:consultations[key.split('.').at(-1)!];
    for(const kind of Object.keys(consultations)) assert.equal(publicFeeCategory('consultation',kind,locale,translate),consultations[kind]);
    assert.equal(publicFeeCategory('task','work.envelope.roofing',locale,translate),taxonomy['work.envelope.roofing']);
    assert.equal(publicFeeCategory('task',null,locale,translate),pricing.allCategories);
    assert.equal(publicFeeCategory('consultation','synthetic_review',locale,translate),null);
    assert.equal(publicFeeCategory('task','synthetic_review',locale,translate),null);
    assert.equal(publicFeeCategory('ticket','drawing_review',locale,translate),null);
    assert.ok(pricing.categoryUnavailable && pricing.details && pricing.digest);
  }
});
