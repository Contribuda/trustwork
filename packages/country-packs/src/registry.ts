import { isRestricted } from './restricted.js';
import type { CountryPack } from './schema.js';
import { packProblems, validatePack } from './validate.js';
import { installClientPacks } from './client.js';
import uz from '../packs/uz.json' with { type: 'json' };
import ge from '../packs/ge.json' with { type: 'json' };
import am from '../packs/am.json' with { type: 'json' };
import az from '../packs/az.json' with { type: 'json' };
import us from '../packs/us.json' with { type: 'json' };
import gb from '../packs/gb.json' with { type: 'json' };
import ca from '../packs/ca.json' with { type: 'json' };

/**
 * The pack registry (CFG-001). The packs in `packages/country-packs/packs` ship with the engine as data (built in, so
 * the database kernel sync can read them without a file system; the browser bundle carries only their client subset,
 * `./client.ts`). A deployment adds or replaces
 * packs at start from its data directory (`<dataDir>/country-packs/<code>.json`, loaded by `@trustwork/config`); every
 * file goes through the same validator as the built-in ones, so an invalid or restricted pack never becomes active.
 * The registry holds no default country: which country a visitor starts in is deployment configuration.
 */
export const BUILT_IN_PACKS: readonly CountryPack[] = [uz, ge, am, az, us, gb, ca].map((raw) => validatePack(raw));

let active: readonly CountryPack[] = BUILT_IN_PACKS;
let byCode = new Map(active.map((p) => [p.code, p]));

/** Every active pack: the built-in ones, then the deployment's, a deployment pack replacing a built-in pack of the same code. */
export function packs(): readonly CountryPack[] {
  return active;
}

export function getPack(code: string): CountryPack | null {
  return byCode.get(code.toUpperCase()) ?? null;
}

/** Packs offered in the country selector: enabled and, by construction, never restricted. */
export function enabledPacks(): readonly CountryPack[] {
  return active.filter((p) => p.enabled);
}

/**
 * Makes a deployment's packs active next to the built-in ones. Each pack is checked again here (restricted places and
 * duplicates are refused), so a caller can never install what the validator would reject.
 */
export function installPacks(extra: readonly CountryPack[]): void {
  const seen = new Set<string>();
  for (const pack of extra) {
    if (isRestricted(pack.code)) throw new Error(`Country pack ${pack.code} is a restricted place and cannot be installed`);
    if (seen.has(pack.code)) throw new Error(`Country pack ${pack.code} is installed twice`);
    seen.add(pack.code);
  }
  const merged = new Map(BUILT_IN_PACKS.map((p) => [p.code, p]));
  for (const pack of extra) merged.set(pack.code, pack);
  active = [...merged.values()];
  byCode = new Map(active.map((p) => [p.code, p]));
  // The browser entry's registry follows, so helpers shared by server and client components see the same packs here.
  installClientPacks(extra);
}

/** Back to the built-in packs only (tests, and a deployment without a data directory). */
export function resetPacks(): void {
  installPacks([]);
}

export type PackFileCheck = { pack: CountryPack | null; problems: string[] };

/**
 * Checks one pack file from a data directory: the validator's problems, plus the file-name rule (`<code>.json` in lower
 * case, so two files can never claim the same country). Restricted places fail in the validator and again here.
 */
export function checkPackFile(fileName: string, raw: unknown): PackFileCheck {
  const { pack, problems } = packProblems(raw);
  const out = problems.map((problem) => `${fileName}: ${problem}`);
  const code = pack?.code ?? (typeof raw === 'object' && raw && 'code' in raw && typeof raw.code === 'string' ? raw.code : null);
  if (code && isRestricted(code) && !out.some((p) => p.includes('restricted'))) out.unshift(`${fileName}: ${code} is a restricted place and cannot exist as a pack`);
  if (code && fileName !== `${code.toLowerCase()}.json`) out.push(`${fileName}: a pack for ${code} must be named ${code.toLowerCase()}.json`);
  return { pack: out.length ? null : pack, problems: out };
}
