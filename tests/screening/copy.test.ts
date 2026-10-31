import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OWN_COMPLIANCE_STATUSES, ownComplianceStatus, SCREENING_HOLD_REASONS, type ScreeningState } from '../../packages/contracts/src/sanctions.js';

/** SANC-003: every status word the API can name exists in every engine language, and none names a list or an entry. */
const ROOT = resolve(import.meta.dirname, '../../apps/web/locales');
const lookup = (tree: unknown, key: string): unknown => key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);

test('every screening message key exists in every engine language', () => {
  const languages = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(languages, ['az-Latn', 'en', 'es', 'hy', 'ka', 'ru', 'uz-Latn']);
  const keys = new Set<string>();
  const subject = { kind: 'person' as const, id: '11111111-1111-4111-8111-111111111111' };
  const states: ScreeningState[] = [
    { subject, moneyHeld: false, suspended: false, reasons: [], lastOutcome: 'clear', lastScreenedAt: null, checkedAt: new Date().toISOString() },
    ...SCREENING_HOLD_REASONS.map((reason) => ({ subject, moneyHeld: true, suspended: reason === 'confirmed', reasons: [reason], lastOutcome: null, lastScreenedAt: null, checkedAt: new Date().toISOString() })),
  ];
  const statuses = new Set<string>();
  for (const state of states) for (const appealable of [true, false]) {
    const own = ownComplianceStatus(state, appealable);
    statuses.add(own.status);
    for (const key of own.messageKeys) keys.add(key);
  }
  assert.deepEqual([...statuses].sort(), [...OWN_COMPLIANCE_STATUSES].sort(), 'every status is reachable');
  for (const language of languages) {
    const tree = JSON.parse(readFileSync(join(ROOT, language, 'screening.json'), 'utf8'));
    for (const key of keys) {
      const value = lookup(tree, key);
      assert.equal(typeof value, 'string', `${language}: ${key}`);
      assert.ok((value as string).length > 10);
      assert.doesNotMatch(value as string, /OFAC|SDN|list entry|\{/i, `${language}: ${key} names no list and has no placeholder`);
    }
  }
});
