import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UNTRUSTED_CHANNELS, untrusted } from './channels.js';
import { checkRegistry, defineSuite, runScenario, type SafetySuite } from './harness.js';
import { OWASP_FRAMEWORKS } from './owasp.js';
import { AgentSafetyReportSchema, buildReport } from './report.js';
import { CORE_SUITES, loadSuites } from './suites/index.js';

/** The harness itself (EVAL-001): registry rules, coverage of both OWASP lists, the report contract and module discovery. */

const pure = (id: string, owasp: string[] = ['LLM01']) => ({ id, kind: 'pure' as const, title: id, owasp: owasp as never, defence: 'a structural defence', run() {} });

test('suites are validated: dotted ids under the suite, known OWASP items, a defence, no duplicates', () => {
  assert.doesNotThrow(() => defineSuite({ id: 'demo', title: 'Demo', owner: { kind: 'core' }, scenarios: [pure('demo.one')] }));
  assert.throws(() => defineSuite({ id: 'demo', title: 'Demo', owner: { kind: 'core' }, scenarios: [pure('other.one')] }), /not prefixed/);
  assert.throws(() => defineSuite({ id: 'demo', title: 'Demo', owner: { kind: 'core' }, scenarios: [pure('demo.one', ['LLM11'])] }), /unknown OWASP item LLM11/);
  assert.throws(() => defineSuite({ id: 'demo', title: 'Demo', owner: { kind: 'core' }, scenarios: [pure('demo.one', [])] }), /not a control/);
  assert.throws(() => defineSuite({ id: 'demo', title: 'Demo', owner: { kind: 'core' }, scenarios: [pure('demo.one'), pure('demo.one')] }), /duplicate/);
  assert.throws(() => defineSuite({ id: 'demo', title: 'Demo', owner: { kind: 'core' }, scenarios: [{ ...pure('demo.one'), defence: '' }] }), /names no defence/);
  const a: SafetySuite = { id: 'mod.a', title: 'A', owner: { kind: 'module', moduleKey: 'a' }, scenarios: [pure('mod.a.x')] };
  assert.deepEqual(checkRegistry([a, { ...a }]), ['duplicate suite id mod.a', 'scenario mod.a.x registered by mod.a and mod.a']);
});

test('a failing scenario is recorded with its message, a runtime scenario without a database is skipped', async () => {
  const suite: SafetySuite = { id: 'demo', title: 'Demo', owner: { kind: 'core' }, scenarios: [] };
  const failed = await runScenario(suite, { ...pure('demo.fails'), run() { throw new Error('effect without mandate'); } }, null);
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail!, /effect without mandate/);
  const skipped = await runScenario(suite, { id: 'demo.db', kind: 'runtime', title: 'db', owasp: ['LLM06'], defence: 'a structural defence', async run() {} }, null);
  assert.deepEqual([skipped.status, skipped.detail], ['skipped', 'no local PostgreSQL']);
});

test('every item of both OWASP lists has a core scenario or a written reason', () => {
  const mapped = new Set(CORE_SUITES.flatMap((s) => s.scenarios.flatMap((sc) => sc.owasp as readonly string[])));
  for (const framework of OWASP_FRAMEWORKS) {
    assert.equal(framework.items.length, 10, framework.id);
    for (const item of framework.items) {
      assert.ok(mapped.has(item.id) || (item.notApplicable ?? '').length > 20, `${item.id} ${item.title} has no scenario and no reason`);
      assert.ok(item.scope.length > 40, `${item.id} states its scope`);
    }
  }
});

test('the core suite covers every attack the package names', () => {
  const ids = CORE_SUITES.flatMap((s) => s.scenarios.map((sc) => sc.id));
  const channels = new Set(CORE_SUITES.flatMap((s) => s.scenarios.map((sc) => sc.channel).filter(Boolean)));
  for (const channel of ['attachment', 'imported_news', 'email', 'agent_envelope_note', 'web_page', 'retrieved_evidence', 'conversation_history', 'connection_input', 'extension_output', 'chat']) {
    assert.ok(channels.has(channel as never), `injection through ${channel}`);
  }
  for (const expected of ['mandate-widening-through-chat', 'private-constraint-leakage', 'competitor-price-relay', 'negotiation-loop', 'budget-exhaustion', 'human-only-commit', 'stop-control']) {
    assert.ok(ids.some((id) => id.endsWith(expected)), expected);
  }
  assert.ok(CORE_SUITES.some((s) => s.scenarios.some((sc) => sc.control)), 'a positive control proves effects are observed');
});

test('untrusted fixtures carry a fresh canary in every channel; retrieved evidence matches the retrieval contract', () => {
  const markers = new Set<string>();
  for (const channel of UNTRUSTED_CHANNELS) {
    const c = untrusted(channel, 'do something bad');
    assert.ok(c.text.includes(c.canary) && c.text.includes('do something bad'), channel);
    markers.add(c.canary);
  }
  assert.equal(markers.size, UNTRUSTED_CHANNELS.length);
  assert.ok(untrusted('retrieved_evidence', 'x').evidence);
  assert.equal(untrusted('email', 'x').evidence, null);
});

test('the report is machine-readable, maps both lists and fails the gate on a failure or a gap', () => {
  const suite = defineSuite({ id: 'demo', title: 'Demo', owner: { kind: 'core' }, scenarios: [pure('demo.one', ['LLM01', 'ASI01'])] });
  const result = { suite: 'demo', id: 'demo.one', title: 'demo.one', kind: 'pure' as const, owasp: ['LLM01' as const, 'ASI01' as const], defence: 'd', channel: null, control: false, durationMs: 1 };
  const passing = buildReport([suite], [{ ...result, status: 'passed', detail: null }], { database: false, commit: 'abc', now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(AgentSafetyReportSchema.safeParse(JSON.parse(JSON.stringify(passing))).success, true);
  const llm01 = passing.frameworks[0]!.items.find((i) => i.id === 'LLM01')!;
  assert.deepEqual([llm01.status, llm01.scenarios, llm01.passed], ['covered', ['demo.one'], 1]);
  assert.equal(passing.frameworks[0]!.items.find((i) => i.id === 'LLM02')!.status, 'gap');
  assert.equal(passing.gate.passed, false, 'a demo suite leaves gaps');
  const failing = buildReport([suite], [{ ...result, status: 'failed', detail: 'boom' }], { database: false, commit: null });
  assert.equal(failing.frameworks[1]!.items.find((i) => i.id === 'ASI01')!.status, 'failed');
  assert.ok(failing.gate.reasons.includes('failed: demo.one'));
});

test('module suites under tests/agent-safety/modules are discovered and join the registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-safety-modules-'));
  try {
    mkdirSync(join(dir, 'quoting'));
    const harness = pathToFileURL(join(import.meta.dirname, 'harness.ts')).href;
    writeFileSync(join(dir, 'quoting', 'quoting.suite.ts'), `import { defineSuite } from '${harness}';
export const safetySuites = [defineSuite({ id: 'module.quoting', title: 'Quoting', owner: { kind: 'module', moduleKey: 'quoting' }, scenarios: [
  { id: 'module.quoting.floor', kind: 'pure', title: 'floor', owasp: ['LLM02'], defence: 'the floor never leaves the seller', run() {} },
] })];
`);
    writeFileSync(join(dir, 'quoting', 'helper.ts'), 'export const notASuite = 1;\n');
    const suites = await loadSuites(dir);
    assert.deepEqual(suites.map((s) => s.id), [...CORE_SUITES.map((s) => s.id), 'module.quoting']);
    writeFileSync(join(dir, 'clash.suite.ts'), `import { defineSuite } from '${harness}';
export const safetySuites = [defineSuite({ id: 'module.quoting', title: 'Clash', owner: { kind: 'module', moduleKey: 'quoting' }, scenarios: [] })];
`);
    await assert.rejects(loadSuites(dir), /duplicate suite id module.quoting/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
