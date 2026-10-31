import test from 'node:test';
import assert from 'node:assert/strict';
import { MATCHER_VERSION, screenedNamesDigest } from '../../packages/compliance/src/matching/index.js';
import type { RescreenSubjectRow } from '../../packages/data/src/repositories/rescreen.js';
import { RescreenRunSchema, RescreenRunAlertEventSchema, RescreenRunFinishedEventSchema } from '../../packages/contracts/src/sanctions.js';
import { deltaEligible, isCurrent, rescreenConfigFromEnv, RescreenConfigError, sameSettings, subjectFacts, touchesDelta, type DeltaTokens } from '../../apps/worker/src/rescreen/index.js';

/** Pure parts of SANC-005: settings, the per-subject decisions and the delta test. Synthetic names only. */

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';
const config = { fuzzyThreshold: null, vesselsAndAircraft: false };

function row(overrides: Partial<RescreenSubjectRow> = {}): RescreenSubjectRow {
  const names = overrides.names ?? ['Quentin Brightwater'];
  return {
    kind: 'person', id: '44444444-4444-4444-8444-444444444444', names, namesDigest: 'd'.repeat(64), hasState: true, stateNamesDigest: 'd'.repeat(64), lastOutcome: 'clear',
    screenedVersions: [V1, C1], hasMatches: false, lastMatcherVersion: MATCHER_VERSION, lastFuzzyThreshold: null, lastScreenedNamesDigest: screenedNamesDigest(names), ...overrides,
  };
}

test('settings: defaults, bounds and refusals', () => {
  assert.deepEqual(rescreenConfigFromEnv({}), { batchSize: 500, windowSeconds: 21_600, weeklySeconds: 604_800, retryAfterSeconds: 3600, yieldReadyJobs: 200, yieldSeconds: 5, blockedSeconds: 300 });
  assert.equal(rescreenConfigFromEnv({ RESCREEN_WEEKLY_DAYS: '1' }).weeklySeconds, 86_400);
  assert.equal(rescreenConfigFromEnv({ RESCREEN_BATCH: '2000', RESCREEN_WINDOW_HOURS: '24' }).windowSeconds, 86_400);
  for (const [name, value] of [['RESCREEN_BATCH', '10'], ['RESCREEN_BATCH', '9000'], ['RESCREEN_WEEKLY_DAYS', '14'], ['RESCREEN_WINDOW_HOURS', '0'], ['RESCREEN_RETRY_MINUTES', 'soon'], ['RESCREEN_YIELD_SECONDS', '1.5']]) {
    assert.throws(() => rescreenConfigFromEnv({ [name as string]: value }), RescreenConfigError, `${name}=${value}`);
  }
});

test('current: screened against every active version with the same names; otherwise not', () => {
  assert.equal(isCurrent(row(), [V1, C1]), true);
  assert.equal(isCurrent(row(), [V2, C1]), false, 'a newer version is active');
  assert.equal(isCurrent(row({ stateNamesDigest: 'e'.repeat(64) }), [V1, C1]), false, 'renamed since');
  assert.equal(isCurrent(row({ lastOutcome: 'not_screened' }), [V1, C1]), false, 'the last screening could not run');
  assert.equal(isCurrent(row({ hasState: false, lastOutcome: null }), [V1, C1]), false, 'never screened');
  assert.equal(isCurrent(row({ lastOutcome: 'possible_match' }), [V1, C1]), true, 'an open case is current too: the review queue has it');
});

test('delta eligibility fails closed', () => {
  const facts = subjectFacts(row(), config);
  assert.deepEqual(facts.tokens, ['brightwater', 'quentin']);
  assert.equal(facts.screenable, true);
  assert.equal(deltaEligible(row(), facts, config), true);
  const refused: [string, Partial<RescreenSubjectRow>][] = [
    ['no state', { hasState: false }],
    ['a possible match', { lastOutcome: 'possible_match' }],
    ['insufficient name', { lastOutcome: 'insufficient_name' }],
    ['any match row, even decided', { hasMatches: true }],
    ['renamed', { stateNamesDigest: 'e'.repeat(64) }],
    ['another matcher', { lastMatcherVersion: 'engine-rule-0+fuzzy-jw-1+name-key-1' }],
    ['another fuzzy setting', { lastFuzzyThreshold: 0.9 }],
    ['other normalized names', { lastScreenedNamesDigest: 'f'.repeat(64) }],
    ['no versions', { screenedVersions: [] }],
  ];
  for (const [why, overrides] of refused) assert.equal(deltaEligible(row(overrides), facts, config), false, why);
  const company = row({ kind: 'company', names: ['Brightquay Synthetic Freight LLC'] });
  assert.equal(deltaEligible(company, subjectFacts(company, config), config), true);
  const withVessels = { ...config, vesselsAndAircraft: true };
  assert.equal(deltaEligible(company, subjectFacts(company, withVessels), withVessels), false, 'results do not record the vessel setting');
  const mono = row({ names: ['Exampleton'] });
  assert.equal(subjectFacts(mono, config).screenable, false);
  assert.equal(deltaEligible(mono, subjectFacts(mono, config), config), false);
  assert.equal(sameSettings(row(), { fuzzyThreshold: 0.92 }), false);
});

test('the delta test: tokens of added keys per entry type, initials only with the fuzzy layer', () => {
  const delta: DeltaTokens = {
    tokens: new Map([['individual', new Set(['ansel', 'mockridge'])], ['entity', new Set(['greymarsh', 'synthetic', 'trading'])]]),
    initials: new Map([['individual', new Set(['a', 'm'])], ['entity', new Set(['g', 's', 't'])]]),
    keyCount: 2,
  };
  assert.equal(touchesDelta(delta, ['individual'], ['ansel', 'mockridge'], false), true);
  assert.equal(touchesDelta(delta, ['individual'], ['brightwater', 'quentin'], false), false);
  assert.equal(touchesDelta(delta, ['individual'], ['synthetic', 'moderator'], false), false, 'an entity key never meets a person');
  assert.equal(touchesDelta(delta, ['entity'], ['brightquay', 'freight', 'synthetic'], false), true);
  assert.equal(touchesDelta(delta, ['individual'], ['mxyz', 'qrst'], true), true, 'with the fuzzy layer a shared initial is enough');
  assert.equal(touchesDelta(delta, ['individual'], ['brightwater', 'quentin'], true), false);
});

test('contracts: run view and events carry counts and identifiers only', () => {
  const base = {
    id: V1, trigger: 'list_version', mode: 'delta', listVersionId: V2, previousVersionId: V1, requestedBy: null, state: 'done', phase: 'all', blockedReason: null, windowSeconds: 21_600,
    subjectsTotal: 10, subjectsDone: 10, candidatesScreened: 1, screenedFull: 0, screenedDelta: 9, alreadyCurrent: 1, verified: 0,
    outcomes: { clear: 9, possibleMatch: 1, insufficientName: 0, notScreened: 0 }, matchesOpened: 1, failures: 0, resumed: 0, overdue: false,
    queuedAt: '2026-10-31T10:00:00.000Z', startedAt: '2026-10-31T10:00:01.000Z', finishedAt: '2026-10-31T10:00:09.000Z',
  };
  assert.ok(RescreenRunSchema.safeParse(base).success);
  assert.ok(!RescreenRunSchema.safeParse({ ...base, mode: 'full' }).success, 'a list-version run is a delta run');
  assert.ok(!RescreenRunSchema.safeParse({ ...base, trigger: 'manual', mode: 'full', listVersionId: null, previousVersionId: null }).success, 'a manual run names who asked');
  assert.ok(!RescreenRunSchema.safeParse({ ...base, finishedAt: null }).success);
  assert.ok(!RescreenRunSchema.safeParse({ ...base, windowSeconds: 60 }).success);
  assert.ok(RescreenRunFinishedEventSchema.safeParse({ runId: V1, trigger: 'scheduled', mode: 'full', subjectsTotal: 3, subjectsDone: 3, matchesOpened: 0, durationSeconds: 2 }).success);
  assert.ok(!RescreenRunAlertEventSchema.safeParse({ runId: V1, trigger: 'scheduled', alert: 'failed', mutable: true }).success, 'alerts cannot be muted');
});
