import test from 'node:test';
import assert from 'node:assert/strict';
import { awardAmount, awardDigest, checkSelection, outcomeFeedback, sharedStatus } from '../../apps/api/src/modules/sourcing/awards.js';
import type { BidLevelSheetPayload, QuoteVersionRow } from '../../apps/api/src/modules/sourcing/deps.js';

const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const version = (id: string, gross: string, lines: (string | null)[] = ['a', 'b']) => ({ id, quote_id: `quote-${id}`, payload: { totals: { gross: usd(gross) }, lines: lines.map((rfqLineId) => ({ rfqLineId })) } }) as unknown as QuoteVersionRow;
const reasonOf = (fn: () => void) => { try { fn(); } catch (e) { return (e as { details?: { reason?: string } }).details?.reason; } return null; };
const selection = (id: string, keys: string[], share = '1') => ({ quoteVersionId: id, rfqLineKeys: keys, share });
const sheet = (columns: { id: string; comparable: boolean }[]) => ({
  columns: columns.map((c) => ({ kind: 'quote_version', key: `q-${c.id}`, quoteVersionId: c.id, version: 1, digest: { algorithm: 'trustwork-digest-1', value: 'a'.repeat(64) }, comparable: c.comparable, staleReason: null })),
  cells: [], adjustments: [], currency: 'USD', exchangeRateSnapshot: null,
}) as unknown as BidLevelSheetPayload;

test('an award binds whole quote versions: a part of one or a share below 1 is refused, whichever way it is written', () => {
  const versions = new Map([['v1', version('v1', '100', ['a', 'b'])], ['v2', version('v2', '100', ['c', null])]]);
  assert.equal(reasonOf(() => checkSelection([selection('v1', ['a', 'b'])], versions)), null);
  assert.equal(reasonOf(() => checkSelection([selection('v1', ['b', 'a'], '1.000')], versions)), null, 'one, however it is written');
  assert.equal(reasonOf(() => checkSelection([selection('v2', ['c'])], versions)), null, 'an unsolicited line belongs to the version and is bound with it');
  assert.equal(reasonOf(() => checkSelection([selection('v1', ['a'])], versions)), 'partial_award_unavailable');
  assert.equal(reasonOf(() => checkSelection([selection('v1', ['a', 'b', 'c'])], versions)), 'partial_award_unavailable');
  assert.equal(reasonOf(() => checkSelection([selection('v1', ['a', 'b'], '0.999')], versions)), 'partial_award_unavailable');
  assert.equal(reasonOf(() => checkSelection([selection('unknown', ['a'])], versions)), 'pin_mismatch');
});

test('the approval digest covers the sheet, the selection and the reasons', () => {
  const base = { rfqId: 'r', sheetVersionId: 's', sheetDigest: 'd', selection: [selection('v1', ['a'])], reasons: [{ category: 'price' as const, text: 'Lowest' }] };
  const value = awardDigest(base).value;
  assert.equal(awardDigest({ ...base }).value, value);
  assert.notEqual(awardDigest({ ...base, sheetDigest: 'e' }).value, value);
  assert.notEqual(awardDigest({ ...base, selection: [selection('v2', ['a'])] }).value, value);
  assert.notEqual(awardDigest({ ...base, reasons: [{ category: 'scope', text: 'Lowest' }] }).value, value);
});

test('a route weighs the native gross: one currency sums exactly, mixed currencies have no amount', () => {
  const eur = { ...version('e', '0'), payload: { totals: { gross: { minorUnits: '500000000', currency: 'EUR' } }, lines: [] } } as unknown as QuoteVersionRow;
  const versions = new Map([['a', version('a', '100')], ['b', version('b', '250')], ['e', eur]]);
  assert.deepEqual(awardAmount([selection('a', []), selection('b', [])], versions), usd('350'));
  assert.deepEqual(awardAmount([selection('e', [])], versions), { minorUnits: '500000000', currency: 'EUR' });
  assert.equal(awardAmount([selection('a', []), selection('e', [])], versions), null);
});

test('a route condition reads the status all selected suppliers share; a split or a supplier outside the base is unknown', () => {
  assert.equal(sharedStatus([]), null);
  assert.equal(sharedStatus(['approved']), 'approved');
  assert.equal(sharedStatus(['on_hold', 'on_hold']), 'on_hold');
  assert.equal(sharedStatus(['blocked', 'prospect']), null, 'no one status stands for both, so no step naming either is missed');
  assert.equal(sharedStatus(['approved', null]), null);
});

test('feedback: exact bands against the awarded total; the winner and non-comparable columns get none; a reason a notice may not name is dropped', () => {
  const versions = new Map([['won', version('won', '100000')], ['near', version('near', '105000')], ['mid', version('mid', '115000')], ['far', version('far', '115001')], ['stale', version('stale', '100')]]);
  const payload = sheet([{ id: 'won', comparable: true }, { id: 'near', comparable: true }, { id: 'mid', comparable: true }, { id: 'far', comparable: true }, { id: 'stale', comparable: false }]);
  const feedback = outcomeFeedback({ sheet: payload, awardedVersionIds: ['won'], versions, sellerOf: (row) => `seller-${row.id}`, reasons: [{ category: 'quality', text: 'Better references' }, { category: 'lead_time', text: 'Earlier delivery' }] });
  assert.deepEqual(feedback, {
    'seller-near': { band: 'within_5pct', reason: 'lead_time' }, 'seller-mid': { band: 'within_15pct', reason: 'lead_time' }, 'seller-far': { band: 'above_15pct', reason: 'lead_time' },
  });
  const noReason = outcomeFeedback({ sheet: payload, awardedVersionIds: ['won'], versions, sellerOf: (row) => `seller-${row.id}`, reasons: [{ category: 'other', text: 'Internal' }] });
  assert.equal(noReason['seller-near']?.reason, null);
});
