import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { OWASP_FRAMEWORKS } from './owasp.js';
import { runScenario, type SafetySuite, type ScenarioResult } from './harness.js';

/**
 * Machine-readable report of an agent safety run (EVAL-001), mapped item by item to the OWASP Top 10 for LLM
 * Applications 2025 and the OWASP Top 10 for Agentic Applications 2026. A release attaches the report produced by
 * `node --import tsx tests/agent-safety/core/report.ts --out <file>`; the test run writes the same report when
 * TRUSTWORK_AGENT_SAFETY_REPORT names a file.
 */

export const REPORT_SCHEMA_ID = 'trustwork.agent-safety-report/1';

const StatusSchema = z.enum(['passed', 'failed', 'skipped']);
const ItemStatusSchema = z.enum(['covered', 'failed', 'not_run', 'not_applicable', 'gap']);
export const AgentSafetyReportSchema = z.strictObject({
  schema: z.literal(REPORT_SCHEMA_ID),
  generatedAt: z.iso.datetime(),
  commit: z.string().max(64).nullable(),
  environment: z.strictObject({ model: z.literal('scripted fake (ScriptedModel)'), providers: z.literal('fake effect providers'), network: z.literal('none'), database: z.enum(['local postgresql', 'not available']) }),
  summary: z.strictObject({ scenarios: z.int().min(0), passed: z.int().min(0), failed: z.int().min(0), skipped: z.int().min(0) }),
  gate: z.strictObject({ passed: z.boolean(), complete: z.boolean(), reasons: z.array(z.string()) }),
  frameworks: z.array(z.strictObject({
    id: z.string(), title: z.string(), url: z.url(),
    items: z.array(z.strictObject({
      id: z.string().regex(/^(LLM|ASI)\d{2}$/), title: z.string(), status: ItemStatusSchema, scope: z.string(), notApplicable: z.string().nullable(),
      scenarios: z.array(z.string()), passed: z.int().min(0), failed: z.int().min(0), skipped: z.int().min(0),
    })).length(10),
  })).length(2),
  suites: z.array(z.strictObject({
    id: z.string(), title: z.string(), owner: z.string(),
    scenarios: z.array(z.strictObject({
      id: z.string(), title: z.string(), kind: z.enum(['pure', 'runtime']), owasp: z.array(z.string()), channel: z.string().nullable(), control: z.boolean(), defence: z.string(),
      status: StatusSchema, detail: z.string().nullable(), durationMs: z.int().min(0),
    })),
  })),
  limitations: z.array(z.string()).min(1),
});
export type AgentSafetyReport = z.infer<typeof AgentSafetyReportSchema>;

/** Stated in every report: what a deterministic suite with a scripted model cannot prove. */
export const LIMITATIONS: readonly string[] = [
  'The model is a scripted fake playing a fully hijacked agent: the suite proves structural defences, never that a real model resists injection, answers correctly or writes safe free text.',
  'Private constraints are refused by field name in effect payloads and are never given to the model; a value a person typed into the conversation and a real model copied into a free-text message field is not detected by value (follow-up: outbound projection serializer for message bodies).',
  'Envelope delivery and negotiation sessions (AGT-001), connections (MCP-0xx), the extension registry (AGT-023) and ingestion pipelines are not running yet; their channels are covered at contract level and by fixtures their suites reuse.',
  'Reconciliation of unknown outcomes, crash recovery and concurrent dispatch are proven by tests/assistant/runtime.test.ts, not repeated here.',
];

const ownerLabel = (s: SafetySuite) => (s.owner.kind === 'core' ? 'core' : s.owner.kind === 'module' ? `module:${s.owner.moduleKey}` : `extension:${s.owner.extensionId}`);

export function gitCommit(): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function buildReport(suites: readonly SafetySuite[], results: readonly ScenarioResult[], meta: { database: boolean; commit?: string | null; now?: Date }): AgentSafetyReport {
  const byId = new Map(results.map((r) => [r.id, r]));
  const count = (ids: readonly string[], status: ScenarioResult['status']) => ids.filter((id) => byId.get(id)?.status === status).length;
  const all = suites.flatMap((s) => s.scenarios);
  const frameworks = OWASP_FRAMEWORKS.map((f) => ({
    id: f.id, title: f.title, url: f.url,
    items: f.items.map((item) => {
      const ids = all.filter((s) => (s.owasp as readonly string[]).includes(item.id)).map((s) => s.id);
      const passed = count(ids, 'passed');
      const failed = count(ids, 'failed');
      const skipped = ids.length - passed - failed;
      const status = item.notApplicable ? 'not_applicable' as const : ids.length === 0 ? 'gap' as const : failed > 0 ? 'failed' as const : passed > 0 ? 'covered' as const : 'not_run' as const;
      return { id: item.id, title: item.title, status, scope: item.scope, notApplicable: item.notApplicable ?? null, scenarios: ids, passed, failed, skipped };
    }),
  }));
  const summary = { scenarios: results.length, passed: results.filter((r) => r.status === 'passed').length, failed: results.filter((r) => r.status === 'failed').length, skipped: results.filter((r) => r.status === 'skipped').length };
  const items = frameworks.flatMap((f) => f.items);
  const reasons = [
    ...results.filter((r) => r.status === 'failed').map((r) => `failed: ${r.id}`),
    ...items.filter((i) => i.status === 'gap').map((i) => `no scenario and no written reason: ${i.id}`),
    ...all.filter((s) => !byId.has(s.id)).map((s) => `not run: ${s.id}`),
  ];
  const incomplete = [...items.filter((i) => i.status === 'not_run').map((i) => `only skipped scenarios: ${i.id}`), ...results.filter((r) => r.status === 'skipped').map((r) => `skipped: ${r.id}`)];
  return AgentSafetyReportSchema.parse({
    schema: REPORT_SCHEMA_ID,
    generatedAt: (meta.now ?? new Date()).toISOString(),
    commit: meta.commit === undefined ? gitCommit() : meta.commit,
    environment: { model: 'scripted fake (ScriptedModel)', providers: 'fake effect providers', network: 'none', database: meta.database ? 'local postgresql' : 'not available' },
    summary,
    gate: { passed: reasons.length === 0, complete: reasons.length === 0 && incomplete.length === 0, reasons: [...reasons, ...incomplete] },
    frameworks,
    suites: suites.map((s) => ({
      id: s.id, title: s.title, owner: ownerLabel(s),
      scenarios: s.scenarios.map((sc) => {
        const r = byId.get(sc.id);
        return {
          id: sc.id, title: sc.title, kind: sc.kind, owasp: [...sc.owasp], channel: sc.channel ?? null, control: sc.control ?? false, defence: sc.defence,
          status: r?.status ?? 'skipped', detail: r ? r.detail : 'not run', durationMs: r?.durationMs ?? 0,
        };
      }),
    })),
    limitations: [...LIMITATIONS],
  });
}

export function writeReport(path: string, report: AgentSafetyReport): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
}

/** CLI: runs every registered suite (runtime scenarios on local PostgreSQL when available) and writes the report. */
async function main(argv: readonly string[]): Promise<number> {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (!out) {
    console.error('usage: node --import tsx tests/agent-safety/core/report.ts --out <file.json>');
    return 2;
  }
  const { loadSuites } = await import('./suites/index.js');
  const { startRuntime } = await import('./runtime.js');
  const suites = await loadSuites();
  const needsRuntime = suites.some((s) => s.scenarios.some((sc) => sc.kind === 'runtime'));
  const runtime = needsRuntime ? await startRuntime('agent_safety_report') : null;
  const results: ScenarioResult[] = [];
  try {
    for (const suite of suites) for (const scenario of suite.scenarios) results.push(await runScenario(suite, scenario, runtime));
  } finally {
    await runtime?.close();
  }
  const report = buildReport(suites, results, { database: runtime !== null });
  writeReport(out, report);
  console.log(`agent safety report: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped; gate ${report.gate.passed ? 'passed' : 'failed'}${report.gate.complete ? '' : ' (incomplete)'} -> ${out}`);
  return report.gate.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(error); process.exitCode = 1; });
}
