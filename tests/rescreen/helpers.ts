import { withMaintenance, type DataPool } from '@trustwork/data';
import { HandlerRegistry, Metrics, Worker, type LogLevel } from '@trustwork/worker';
import type { FakeListEntry } from '../../packages/compliance/src/lists/index.js';
import { registerRescreen, VersionCache, type RescreenRuntime } from '../../apps/worker/src/rescreen/index.js';
import { DEFAULT_RESCREEN_CONFIG, type RescreenConfig } from '../../apps/worker/src/rescreen/config.js';
import { registerScreening } from '../../apps/worker/src/screening/index.js';
import { CONFIG } from '../screening/helpers.js';

/**
 * Helpers of the SANC-005 suites. Every person, company and list entry here is invented and labelled synthetic; none
 * is, or is meant to resemble, a listed person or company.
 */

export interface LogLine { level: LogLevel; message: string; fields: Record<string, unknown> }

/** A worker with the screening (SANC-003) and re-screening (SANC-005) handlers, no maintenance tasks. */
export function rescreenWorker(pool: DataPool, options: { config?: Partial<RescreenConfig>; logs?: LogLine[]; metrics?: Metrics; cache?: VersionCache; concurrency?: number } = {}) {
  const metrics = options.metrics ?? new Metrics();
  const logs = options.logs ?? [];
  const runtime: RescreenRuntime = {
    pool, metrics, log: (level, message, fields = {}) => logs.push({ level, message, fields }), screening: CONFIG,
    config: { ...DEFAULT_RESCREEN_CONFIG, yieldSeconds: 1, ...options.config }, cache: options.cache ?? new VersionCache(),
  };
  const registry = new HandlerRegistry();
  registerScreening(registry, { pool, metrics, log: runtime.log, config: CONFIG });
  registerRescreen(registry, runtime);
  const worker = new Worker({ pool, registry, metrics, config: { pollIntervalMs: 20, concurrency: options.concurrency ?? 2, workerId: `rescreen-test-${Math.random().toString(16).slice(2, 8)}` }, tasks: () => [], random: () => 0 });
  return { worker, runtime, metrics, logs };
}

/** Runs relay and jobs until two quiet iterations (delayed jobs are not waited for). */
export async function drain(worker: Worker, maxIterations = 2000): Promise<number> {
  let quiet = 0;
  let iterations = 0;
  for (; iterations < maxIterations && quiet < 2; iterations += 1) {
    const report = await worker.runOnce({ rethrow: true });
    await worker.idle();
    quiet = report.leased === 0 && report.relayed === 0 ? quiet + 1 : 0;
  }
  return iterations;
}

/** Makes every delayed re-screening batch due now (backpressure and blocked waits), so tests need not sleep. */
export const dueNow = (admin: DataPool) => admin.query("UPDATE trustwork.job SET next_at = now() WHERE kind = 'screening.rescreen_batch' AND state = 'queued'");

const SYLLABLES_A = ['bra', 'cor', 'dal', 'fen', 'gar', 'hol', 'jor', 'kel', 'lum', 'mar', 'nor', 'pel', 'quin', 'ros', 'sal', 'tor', 'ul', 'ver', 'wil', 'yar', 'zen'];
const SYLLABLES_B = ['wick', 'dale', 'mont', 'ford', 'shaw', 'ley', 'ton', 'by', 'ridge', 'vale', 'more', 'stead', 'wyn', 'holt', 'brook', 'croft', 'mere', 'ward', 'well', 'lyn'];

/** A deterministic invented name for index `i` (two or three tokens; never one of the synthetic list entries). */
export function syntheticName(i: number, kind: 'person' | 'company'): string {
  const a = SYLLABLES_A.length;
  const b = SYLLABLES_B.length;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const first = cap(SYLLABLES_A[i % a] as string) + (SYLLABLES_B[Math.floor(i / a) % b] as string);
  const last = cap(SYLLABLES_A[Math.floor(i / (a * b)) % a] as string) + (SYLLABLES_B[(i * 7) % b] as string) + (SYLLABLES_A[(i * 3) % a] as string);
  return kind === 'person' ? `${first} ${last}` : `${first} ${last} Synthetic Works`;
}

/** Inserts synthetic persons and companies in bulk through the maintenance path (no events: like an imported hub). */
export async function population(admin: DataPool, counts: { persons: number; companies: number; offset?: number }): Promise<void> {
  const offset = counts.offset ?? 0;
  const chunk = 5000;
  for (let from = 0; from < counts.persons; from += chunk) {
    const names = Array.from({ length: Math.min(chunk, counts.persons - from) }, (_, k) => syntheticName(offset + from + k, 'person'));
    await withMaintenance(admin, (trx) => trx.insertInto('person').values(names.map((display_name) => ({ display_name }))).execute());
  }
  for (let from = 0; from < counts.companies; from += chunk) {
    const names = Array.from({ length: Math.min(chunk, counts.companies - from) }, (_, k) => syntheticName(offset + from + k, 'company'));
    await withMaintenance(admin, (trx) => trx.insertInto('company').values(names.map((display_name) => ({ display_name, claim_status: 'claimed' as const }))).execute());
  }
}

/** Invented list entries (individuals and entities) that share no token with `syntheticName`. */
export function syntheticEntries(count: number, prefix = 94): FakeListEntry[] {
  const out: FakeListEntry[] = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const word = (n: number, len: number) => Array.from({ length: len }, (_, k) => letters[(n * (k + 7) + k * 13) % 26]).join('');
  for (let i = 0; i < count; i += 1) {
    const uid = `${prefix}${String(i).padStart(6, '0')}`;
    if (i % 5 === 4) out.push({ uid, type: 'entity', lastName: `Xq${word(i, 6)} Zx${word(i + 3, 5)} Synthetic Holdings`, programs: ['SYNTHETIC-E'] });
    else out.push({ uid, type: 'individual', firstName: `Xq${word(i, 5)}`, lastName: `ZX${word(i + 11, 7).toUpperCase()}`, programs: ['SYNTHETIC-E'] });
  }
  return out;
}
