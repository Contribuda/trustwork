import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionSafetyReportSchema } from '../../packages/contracts/src/agent-extensions.js';
import { ENGINE_EXTENSION_ADAPTERS, extensionSafetyScenarios, FakeExtensionAdapter, installedAdapter, runExtensionSuite, type InstalledExtensionAdapter } from '../../apps/worker/src/agent-extensions/index.js';
import { checkRegistry, defineSuite, runScenario, type SafetySuite } from '../agent-safety/core/harness.js';
import { CORE_SUITES } from '../agent-safety/core/suites/index.js';
import { lookup, manifestOf } from './manifests.js';

/**
 * The suite an extension must pass (AGT-023) on the EVAL-001 harness: the worker's scenarios register as an extension-owned
 * suite and run through `runScenario`, and each misbehaving fake fails the scenario that exists to catch it.
 */
const EXTENSION_ID = '00000000-0000-4000-8000-0000000000e1';
const DIGEST = 'a'.repeat(64);
const manifest = manifestOf('permit_lookup');
const pair = (fake: FakeExtensionAdapter): InstalledExtensionAdapter[] => [{ adapterId: 'synthetic_http', fakeAdapterId: 'synthetic_http_fake', fake, live: null }];
const suiteOf = (adapters: readonly InstalledExtensionAdapter[]): SafetySuite => defineSuite({
  id: manifest.safetySuite.suiteId, title: 'Synthetic permit lookup', owner: { kind: 'extension', extensionId: EXTENSION_ID }, scenarios: extensionSafetyScenarios({ manifest, extensionId: EXTENSION_ID, adapters }),
});
const failedOf = async (adapters: readonly InstalledExtensionAdapter[]) => {
  const report = await runExtensionSuite({ manifest, extensionId: EXTENSION_ID, manifestDigest: DIGEST, engineVersion: '0.1.0', adapters });
  ExtensionSafetyReportSchema.parse(report);
  return report.scenarios.filter((s) => s.status === 'failed').map((s) => s.id.replace('extension.permit_lookup.', ''));
};

test('the extension suite registers on the EVAL-001 harness and passes on the installed fake', async () => {
  const suite = suiteOf(ENGINE_EXTENSION_ADAPTERS);
  assert.deepEqual(checkRegistry([...CORE_SUITES, suite]), [], 'ids, OWASP items and defences are valid beside every core suite');
  for (const scenario of suite.scenarios) {
    const result = await runScenario(suite, scenario, null);
    assert.equal(result.status, 'passed', `${result.id}: ${result.detail}`);
  }
  assert.ok(suite.scenarios.some((s) => s.channel === 'extension_output'), 'the untrusted output channel of EVAL-001 is covered');
  assert.deepEqual(await failedOf(ENGINE_EXTENSION_ADAPTERS), []);
});

test('every action of a manifest gets its own scenarios', () => {
  const two = manifestOf('two_actions', { actions: [lookup, { ...lookup, operation: 'second_lookup' }] });
  const ids = extensionSafetyScenarios({ manifest: two, extensionId: EXTENSION_ID, adapters: ENGINE_EXTENSION_ADAPTERS }).map((s) => s.id);
  assert.ok(ids.includes('extension.two_actions.lookup-permit.injected-text-stays-data'));
  assert.ok(ids.includes('extension.two_actions.second-lookup.injected-text-stays-data'));
  assert.equal(new Set(ids).size, ids.length);
});

test('negative: a suite without the installed pair fails, never passes empty', async () => {
  assert.deepEqual(await failedOf([]), ['fake-adapter-installed']);
  assert.deepEqual(await failedOf([{ ...ENGINE_EXTENSION_ADAPTERS[0]!, adapterId: 'another' }]), ['fake-adapter-installed'], 'a manifest cannot pair a real adapter with another fake');
  assert.equal(installedAdapter(ENGINE_EXTENSION_ADAPTERS, { adapterId: 'synthetic_http', fakeAdapterId: 'other_fake' }), null);
  const live = { ...new FakeExtensionAdapter('synthetic_http_fake'), mode: 'live' as const } as unknown as FakeExtensionAdapter;
  assert.ok((await failedOf(pair(live))).includes('fake-adapter-installed'), 'a live adapter in the place of the fake never counts');
});

test('negative: a fake that answers with a command, or outside the contract, fails', async () => {
  const commanding = await failedOf(pair(new FakeExtensionAdapter('synthetic_http_fake', () => ({ summary: 'done', facts: {}, toolCalls: [{ kind: 'propose_action' }] }))));
  assert.ok(commanding.includes('lookup-permit.conforming-output'));
  const approving = await failedOf(pair(new FakeExtensionAdapter('synthetic_http_fake', () => ({ summary: 'done', facts: { approvedBy: 'someone' } }))));
  assert.ok(approving.includes('lookup-permit.conforming-output'));
  const shapeless = await failedOf(pair(new FakeExtensionAdapter('synthetic_http_fake', () => 'run this')));
  assert.ok(shapeless.includes('lookup-permit.conforming-output'));
});

test('negative: a fake that repeats an effect, or cannot be looked up, fails', async () => {
  class Repeating extends FakeExtensionAdapter {
    private n = 0;
    override async call() { this.n += 1; return { summary: `effect ${this.n}`, facts: {} }; }
  }
  assert.ok((await failedOf(pair(new Repeating('synthetic_http_fake')))).includes('lookup-permit.repeat-is-one-effect'));
  class Forgetful extends FakeExtensionAdapter {
    override async lookup() { return { found: false as const }; }
  }
  assert.ok((await failedOf(pair(new Forgetful('synthetic_http_fake')))).includes('lookup-permit.lookup-without-effect'));
  class Everything extends FakeExtensionAdapter {
    override async lookup() { return { found: true as const, output: {} }; }
  }
  assert.ok((await failedOf(pair(new Everything('synthetic_http_fake')))).includes('lookup-permit.lookup-without-effect'), 'an unknown key is reported absent, or an unsent action looks sent');
});

test('a report never echoes what the adapter said', async () => {
  const secret = 'synthetic-private-canary';
  const report = await runExtensionSuite({
    manifest, extensionId: EXTENSION_ID, manifestDigest: DIGEST, engineVersion: '0.1.0',
    adapters: pair(new FakeExtensionAdapter('synthetic_http_fake', () => ({ summary: secret, facts: { command: secret } }))),
  });
  assert.equal(report.passed, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
});
