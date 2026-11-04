import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { DataPool } from '@trustwork/data';
import type { AgentCapability } from '../../../../packages/contracts/src/agent-catalog.js';
import { AgentExtensionManifestSchema, ExtensionSafetyReportSchema, type ExtensionSafetyReport } from '../../../../packages/contracts/src/agent-extensions.js';
import { agentExtensionWorker } from '../../../../packages/data/src/repositories/agent-extensions.js';
import { inTransaction } from '../db.js';
import type { HandlerRegistry } from '../handlers.js';
import type { Logger } from '../log.js';
import type { ScheduledTask } from '../scheduler.js';
import { ENGINE_EXTENSION_ADAPTERS, type InstalledExtensionAdapter } from './adapters.js';
import { runExtensionSuite } from './safety.js';

export * from './adapters.js';
export { extensionSafetyScenarios, runExtensionSuite, type ExtensionScenario } from './safety.js';

export const EXTENSION_SAFETY_RUN = 'agents.extension_safety_run';
export const EXTENSION_ENGINE_TICK_TASK = 'agents.extension_engine_tick';

export interface ExtensionRuntime {
  pool: DataPool;
  /** The engine this worker runs; a suite passed on another engine is stale and is run again. */
  engineVersion: string;
  adapters: readonly InstalledExtensionAdapter[];
  log: Logger;
}

/** The release of this checkout, from the worker's own package; a release bumps it, which starts the rechecks. */
export function engineVersion(env: NodeJS.ProcessEnv = process.env): string {
  const stated = env.TRUSTWORK_ENGINE_VERSION?.trim();
  if (stated) return stated.slice(0, 40);
  return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

export function extensionRuntime(pool: DataPool, log: Logger): ExtensionRuntime {
  return { pool, engineVersion: engineVersion(), adapters: ENGINE_EXTENSION_ADAPTERS, log };
}

const RunReferenceSchema = z.strictObject({ runId: z.uuid() });

/** A manifest the engine no longer accepts is a failed suite, not a crash: that is what withdraws it. */
function refusedManifestReport(suiteId: string, manifestDigest: string, version: string): ExtensionSafetyReport {
  return {
    schema: 'trustwork.agent-safety-report/1', suiteId, engineVersion: version, onFakeAdapter: true, manifestDigest,
    scenarios: [{ id: `${suiteId}.manifest-holds`, status: 'failed', owasp: ['LLM06', 'ASI02'], detail: 'manifest_invalid' }], passed: false,
  };
}

/**
 * The suite job. Everything it reads comes from the stored version under the job's lease, and only this role can record the
 * result: a pass makes the version `tested`; a failure of a tested or active version suspends it in the same transaction.
 */
export function registerExtensionSafetyRuns(registry: HandlerRegistry, runtime: ExtensionRuntime): void {
  registry.onJob({
    kind: EXTENSION_SAFETY_RUN, mode: 'transactional', parse: RunReferenceSchema.parse,
    async run({ trx, job, payload }) {
      const target = await agentExtensionWorker.loadRun(trx, payload.runId, job.id, job.fencing_token);
      if (target.state !== 'requested') return;
      const parsed = AgentExtensionManifestSchema.safeParse(target.manifest);
      const stored = target.manifest as { safetySuite: { suiteId: string } };
      const report = parsed.success
        ? await runExtensionSuite({ manifest: parsed.data, extensionId: target.extensionId, manifestDigest: target.manifestDigest, engineVersion: runtime.engineVersion, adapters: runtime.adapters, builtIn: target.builtIn as Pick<AgentCapability, 'mandateAction' | 'confirmation'>[] })
        : refusedManifestReport(stored.safetySuite.suiteId, target.manifestDigest, runtime.engineVersion);
      const outcome = await agentExtensionWorker.recordRun(trx, payload.runId, job.id, job.fencing_token, ExtensionSafetyReportSchema.parse(report));
      runtime.log(outcome === 'passed' ? 'info' : 'warn', 'extension safety suite finished', { runId: payload.runId, versionId: target.versionId, outcome, failed: report.scenarios.filter((s) => s.status === 'failed').length });
    },
  });
}

/** After an engine update: reports the running engine and asks a run for every version whose passing suite is from another. */
export function extensionEngineTickTask(runtime: ExtensionRuntime): ScheduledTask {
  return {
    name: EXTENSION_ENGINE_TICK_TASK, intervalSeconds: 300,
    run: () => inTransaction(runtime.pool, async (trx) => ({ requested: await agentExtensionWorker.engineTick(trx, runtime.engineVersion) })),
  };
}
