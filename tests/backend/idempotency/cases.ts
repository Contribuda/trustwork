import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client, Harness, Response } from '../helpers/app.js';
import type { PersonaKey, seedPersonas } from '../helpers/personas.js';

/**
 * Per-module crash cases for tests/backend/idempotency/crash.test.ts. Each file in ./cases exports a `CrashCase` as
 * its default export; the crash test runs them in file-name order after its own cases and before it checks that every
 * in-transaction route was covered. Parallel slices add a file instead of editing crash.test.ts.
 */
export interface CrashRoute { action: string; client: Client; url: string; body?: unknown; effects: () => Promise<number> }

export interface CrashContext {
  h: Harness;
  seed: Awaited<ReturnType<typeof seedPersonas>>;
  /** A fresh client signed in as the persona. */
  as: (key: PersonaKey) => Promise<Client>;
  /** Runs the BE-005 crash sequence for one route and returns the single successful response. */
  exactlyOnce: (route: CrashRoute) => Promise<Response>;
}

export interface CrashCase {
  /** Subtest name, starting with the work package (`SANC-003: screening decisions`). */
  name: string;
  run: (ctx: CrashContext) => Promise<void>;
}

const casesDir = join(dirname(fileURLToPath(import.meta.url)), 'cases');

export async function loadCrashCases(): Promise<CrashCase[]> {
  const files = readdirSync(casesDir).filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts')).sort();
  const cases: CrashCase[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(casesDir, file)).href)) as { default?: CrashCase };
    if (!mod.default || typeof mod.default.run !== 'function') throw new Error(`${file}: export default a CrashCase`);
    cases.push(mod.default);
  }
  return cases;
}
