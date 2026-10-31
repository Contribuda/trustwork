/**
 * Validates every country pack against the schema and the engine's invariants (OSS-001 pack validator).
 *
 *   node --import tsx scripts/validate-country-packs.ts [path/to/pack.json ...]
 *
 * Without arguments it checks the packs shipped in packages/country-packs/packs. A pack passes when it
 * passes `packProblems` (schema v1 or v2, restricted places, sourced and verified facts), has a dictionary for its default locale (or is marked partial/draft),
 * cites sources for identifier, residency and the pack itself, and its regions are unique ISO 3166-2 codes.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { RESTRICTED, isRestricted, packProblems } from '../packages/country-packs/src/index.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => resolve(p))
  : readdirSync(resolve(root, 'packages/country-packs/packs'))
      .filter((f) => f.endsWith('.json') && f !== 'restricted.json')
      .map((f) => resolve(root, 'packages/country-packs/packs', f));

let failures = 0;
for (const file of files) {
  const problems: string[] = [];
  let pack;
  try {
    // Schema v1/v2, restricted places, facts (sources, verification levels, rates, adapters), time zones (CTRY-002).
    const check = packProblems(JSON.parse(readFileSync(file, 'utf8')));
    if (!check.pack) {
      console.log(`✖ ${basename(file)}`);
      for (const p of check.problems) console.log(`    - ${p}`);
      failures += 1;
      continue;
    }
    pack = check.pack;
  } catch (error) {
    console.log(`✖ ${basename(file)}: ${error instanceof Error ? error.message.split('\n').slice(0, 6).join(' ') : String(error)}`);
    failures += 1;
    continue;
  }
  if (isRestricted(pack.code) || RESTRICTED.places.some((p) => p.code === pack.code)) problems.push(`${pack.code} is a restricted place (ADR-009) and cannot be a pack`);
  if (!pack.locales.includes(pack.defaultLocale)) problems.push('defaultLocale must be one of locales');
  if (!pack.registrationIdentifier.kind.startsWith(`${pack.code}-`)) problems.push(`registrationIdentifier.kind must start with ${pack.code}-`);
  try {
    new RegExp(pack.registrationIdentifier.pattern);
    if (!new RegExp(pack.registrationIdentifier.pattern).test(pack.registrationIdentifier.example)) problems.push('registrationIdentifier.example does not match pattern');
  } catch {
    problems.push('registrationIdentifier.pattern is not a valid regular expression');
  }
  const codes = new Set<string>();
  for (const region of pack.regions) {
    if (!region.code.startsWith(`${pack.code}-`)) problems.push(`region ${region.code} must start with ${pack.code}-`);
    if (codes.has(region.code)) problems.push(`duplicate region ${region.code}`);
    codes.add(region.code);
    for (const tag of pack.locales) if (!region.name[tag] && !region.name.en) problems.push(`region ${region.code} has no name for ${tag} or en`);
  }
  for (const tag of [pack.defaultLocale]) {
    const dict = resolve(root, 'apps/web/app/_lib/locales', `${tag}.json`);
    const ui = resolve(root, 'packages/ui/locales', `${tag}.json`);
    if (pack.status === 'complete' && (!existsSync(dict) || !existsSync(ui))) problems.push(`complete pack needs dictionaries for ${tag} in apps/web and packages/ui`);
    if (pack.status !== 'complete' && !existsSync(ui)) problems.push(`no design-system dictionary for ${tag}; add packages/ui/locales/${tag}.json or the UI falls back to English everywhere`);
  }
  for (const [name, sources] of [['pack', pack.sources], ['registrationIdentifier', pack.registrationIdentifier.sources], ['dataResidency', pack.dataResidency.sources]] as const) {
    if (!sources.length) problems.push(`${name} has no sources`);
  }
  // legalTemplates are template keys resolved under docs/legal/templates/<key>.md. The sanctions section is
  // mandatory (ADR-009); terms and privacy templates are pending and only warn until they exist.
  for (const key of ['terms', 'privacy', 'sanctions'] as const) {
    const template = resolve(root, 'docs/legal/templates', `${key === 'sanctions' ? 'terms-sanctions-and-export-controls' : pack.legalTemplates[key]}.md`);
    if (!existsSync(template)) {
      if (key === 'sanctions') problems.push(`legalTemplates.sanctions template is missing: ${template}`);
      else console.log(`  ! ${basename(file)}: legalTemplates.${key} template not written yet (docs/legal/templates/${pack.legalTemplates[key]}.md)`);
    }
  }
  if (problems.length) {
    failures += 1;
    console.log(`✖ ${basename(file)} (${pack.code})`);
    for (const p of problems) console.log(`    - ${p}`);
  } else {
    console.log(`✔ ${basename(file)} (${pack.code}, ${pack.status}, ${pack.locales.join('/')}, ${pack.currency.code}, ${pack.regions.length} regions)`);
  }
}
if (failures) {
  console.log(`${failures} pack(s) failed`);
  process.exit(1);
}
