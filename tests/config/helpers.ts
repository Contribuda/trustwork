import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { federalFixture } from '../country-packs/v2/federal-fixture.js';

export const REPO = resolve(import.meta.dirname, '../..');
export const WEB = join(REPO, 'apps/web');
export const PROBE = join(REPO, 'tests/config/probe.mjs');

/** The synthetic federal pack (user-assigned code XF, nothing real) as a deployment would drop it in: enabled, suggesting a new language. */
export function syntheticPack(language = 'pt'): Record<string, unknown> {
  const fixture = federalFixture();
  const regions = fixture.regions.map((region) => ({ ...region, name: { ...region.name, [language]: region.name.en } }));
  return { ...fixture, enabled: true, locales: ['en', language], defaultLocale: language, regions };
}

/** A fresh, empty data directory; `write` adds files to it by relative path. */
export function dataDirectory(): { dir: string; write: (path: string, content: unknown) => void; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-data-'));
  return {
    dir,
    write: (path, content) => {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export type Probe = {
  defaultCountry: string | null;
  packs: string[];
  offeredLanguages: string[];
  languageOffered: boolean;
  countryOffered: string | null;
  countryName: string | null;
  countryLanguage: string | null;
  visitor: { country: string; locale: string; chosen: boolean };
  chooser: { country: string; locale: string; chosen: boolean };
  gateTitle: string | null;
  uiDictionary: boolean;
  fixtureLanguages: string[];
  fixtureText: string | null;
  brandName: { en: string | null; ru: string | null };
  russianWordmark: boolean;
};

/** Environment of a server start: only what the test sets (no inherited TRUSTWORK_* or NEXT_PUBLIC_* values). */
function startEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TRUSTWORK_') && !key.startsWith('NEXT_PUBLIC_')));
  return { ...clean, ...env };
}

/** Starts the configuration as the server would, in a new process (a restart), and returns what visitors get. */
export function probe(env: Record<string, string>): Probe {
  const run = spawnSync(process.execPath, ['--import', 'tsx', PROBE, REPO], { cwd: WEB, env: startEnv(env), encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`probe failed (${run.status}): ${run.stderr}`);
  const line = run.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as Probe;
}

/** Runs the server's start-up check (`apps/web/instrumentation.ts`) in a new process; returns its exit code and log. */
export function startupCheck(env: Record<string, string>): { status: number | null; log: string } {
  const script = `import(${JSON.stringify(join(WEB, 'instrumentation.ts'))}).then((m) => m.register())`;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], { cwd: WEB, env: startEnv({ NEXT_RUNTIME: 'nodejs', ...env }), encoding: 'utf8' });
  return { status: run.status, log: `${run.stdout}${run.stderr}` };
}
