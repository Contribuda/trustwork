import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_REASON } from '../../backend/helpers/app.js';
import { runScenario, type ScenarioResult } from './harness.js';
import { buildReport, writeReport } from './report.js';
import { startRuntime } from './runtime.js';
import { loadSuites } from './suites/index.js';

/**
 * EVAL-001: every registered agent safety suite (core, and module suites under tests/agent-safety/modules) against
 * the scripted model, the AST-001 runtime and fake providers. Pure scenarios always run; runtime scenarios need the
 * local PostgreSQL of the test harness (no network). Set TRUSTWORK_AGENT_SAFETY_REPORT=<file> to keep the report.
 */
const suites = await loadSuites();
const runtime = await startRuntime('agent_safety');
const results: ScenarioResult[] = [];

test('agent safety suites (OWASP LLM Top 10 2025 and Agentic Top 10 2026)', { timeout: 600_000 }, async (t) => {
  t.after(async () => {
    await runtime?.close();
  });
  for (const suite of suites) {
    await t.test(suite.id, async (st) => {
      for (const scenario of suite.scenarios) {
        const skip = scenario.kind === 'runtime' && !runtime ? SKIP_REASON : false;
        await st.test(`${scenario.id} [${scenario.owasp.join(', ') || 'control'}]`, { skip }, async () => {
          const result = await runScenario(suite, scenario, runtime);
          results.push(result);
          if (result.status === 'failed') assert.fail(result.detail ?? 'failed');
        });
        if (skip) results.push(await runScenario(suite, scenario, null));
      }
    });
  }

  await t.test('the report maps every OWASP item and records no failure', () => {
    const report = buildReport(suites, results, { database: runtime !== null });
    if (process.env.TRUSTWORK_AGENT_SAFETY_REPORT) writeReport(process.env.TRUSTWORK_AGENT_SAFETY_REPORT, report);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.scenarios, suites.reduce((n, s) => n + s.scenarios.length, 0), 'every scenario has a result');
    const gaps = report.frameworks.flatMap((f) => f.items).filter((i) => i.status === 'gap' || i.status === 'failed');
    assert.deepEqual(gaps.map((i) => i.id), []);
    assert.equal(report.gate.passed, true, report.gate.reasons.join('; '));
    if (runtime) assert.equal(report.gate.complete, true, report.gate.reasons.join('; '));
  });
});
