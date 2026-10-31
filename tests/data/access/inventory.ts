import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Per-module access inventory for tests/data/access.test.ts. Each file in ./modules declares the forced-RLS tables
 * and SECURITY DEFINER functions its migrations add, so parallel slices add a file instead of editing the shared
 * lists in access.test.ts (which stay for the modules that predate this directory). Files are discovered by listing
 * the directory; a new module needs no edit here.
 */
export interface AccessInventory {
  /** Work package that owns the migration, for review (`SANC-003`). */
  package: string;
  /** Tables with ENABLE and FORCE ROW LEVEL SECURITY. */
  forcedTables: readonly string[];
  /** SECURITY DEFINER functions the API role (trustwork_app) may execute. */
  apiDefiners?: readonly string[];
  /** SECURITY DEFINER functions only the worker role may execute. */
  workerDefiners?: readonly string[];
  /** SECURITY DEFINER trigger or helper functions nobody may call directly (not executable by trustwork_app). */
  internalDefiners?: readonly string[];
}

export interface MergedInventory {
  forcedTables: string[];
  apiDefiners: string[];
  workerDefiners: string[];
  internalDefiners: string[];
}

const modulesDir = join(dirname(fileURLToPath(import.meta.url)), 'modules');

export async function loadAccessInventory(): Promise<MergedInventory> {
  const merged: MergedInventory = { forcedTables: [], apiDefiners: [], workerDefiners: [], internalDefiners: [] };
  const files = readdirSync(modulesDir).filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts')).sort();
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(modulesDir, file)).href)) as { default?: AccessInventory };
    const inv = mod.default;
    if (!inv || typeof inv.package !== 'string' || !Array.isArray(inv.forcedTables)) throw new Error(`${file}: export default an AccessInventory`);
    merged.forcedTables.push(...inv.forcedTables);
    merged.apiDefiners.push(...(inv.apiDefiners ?? []));
    merged.workerDefiners.push(...(inv.workerDefiners ?? []));
    merged.internalDefiners.push(...(inv.internalDefiners ?? []));
  }
  return merged;
}
