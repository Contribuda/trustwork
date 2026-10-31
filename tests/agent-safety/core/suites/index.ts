import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRegistry, type SafetySuite } from '../harness.js';
import { corePolicySuite } from './policy.js';
import { coreRuntimeSuite } from './runtime.js';

/** The core suites of EVAL-001, in run order (pure first). */
export const CORE_SUITES: readonly SafetySuite[] = [corePolicySuite, coreRuntimeSuite];

/** Where module suites live (AGT-019 owns the directory); each `*.suite.ts` file exports `safetySuites`. */
export const MODULE_SUITES_DIR = fileURLToPath(new URL('../../modules/', import.meta.url));

function suiteFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return suiteFiles(path);
    return entry.isFile() && entry.name.endsWith('.suite.ts') ? [path] : [];
  }).sort();
}

/**
 * Core suites plus every module suite under tests/agent-safety/modules. A module suite file exports
 * `export const safetySuites: readonly SafetySuite[]` built with `defineSuite`; ids must be unique across the registry.
 */
export async function loadSuites(moduleDir: string = MODULE_SUITES_DIR): Promise<SafetySuite[]> {
  const suites: SafetySuite[] = [...CORE_SUITES];
  for (const file of suiteFiles(moduleDir)) {
    const mod = (await import(pathToFileURL(file).href)) as { safetySuites?: readonly SafetySuite[] };
    if (!Array.isArray(mod.safetySuites) || mod.safetySuites.length === 0) throw new Error(`${file} exports no safetySuites`);
    suites.push(...mod.safetySuites);
  }
  const problems = checkRegistry(suites);
  if (problems.length) throw new Error(`agent safety registry: ${problems.join('; ')}`);
  return suites;
}
