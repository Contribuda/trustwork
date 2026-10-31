import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getCountryPack } from '@trustwork/country-packs';
import { FIXTURE_FILES } from '../../../apps/web/fixtures/schemas.js';
import { DATASETS, datasetForCountry, selectDataset } from '../../../apps/web/fixtures/datasets.js';
import { ENGINE_LOCALES } from '../i18n/helpers.js';
import { dataDirectory } from '../../config/helpers.js';
import { REPO, US_DIR, US_FILES, properNames, translatableStrings, usFile, usOverrideTags, usOverrides, type Json } from './dataset.js';

/**
 * DEMO-US: the United States demo dataset (San Diego County) is complete, contract-valid, visibly synthetic, free of
 * real identifiers, verification marks and invented traffic, localized into every engine language, and selected by
 * the deployment configuration. Runs without a browser; the browser checks are in demo-us.spec.ts.
 */

type Row = Record<string, Json>;
const rows = (file: (typeof US_FILES)[number]): Row[] => usFile(file)[file] as Row[];
const companies = rows('companies') as Array<Row & { slug: string; region: string; company: Row & { id: string; name: string; status: string; legalIdentifiers: Array<{ kind: string; value: string; status: string }> } }>;
const people = rows('people') as Array<Row & { slug: string; region: string; person: Row & { id: string; displayName: string; profileVisibility: string } }>;
const projects = rows('projects') as Array<Row & { slug: string; region: string; project: Row & { id: string; owner: { kind: string; id: string } } }>;
const workspace = usFile('workspace') as unknown as {
  personas: Record<string, { personId: string; companyId: string | null }>;
  memberships: Array<{ personId: string; companyId: string; status: string; role: string; permissions: string[] }>;
  rfqs: Array<{ owner: { kind: string; id: string } }>;
  leads: Array<{ companyId: string }>;
};

/** Every string value in a JSON tree with its pointer. */
function strings(node: Json, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((child, i) => strings(child, `${path}/${i}`));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, child]) => strings(child, `${path}/${k}`));
  return [];
}
const all = US_FILES.flatMap((file) => strings(usFile(file) as Json, file));

for (const [name, schema] of Object.entries(FIXTURE_FILES)) {
  test(`US fixture ${name} parses with its contract-backed schema and is labelled synthetic`, () => {
    const json = JSON.parse(readFileSync(resolve(US_DIR, name), 'utf8')) as { synthetic?: unknown; description?: string };
    const result = schema.safeParse(json);
    assert.ok(result.success, result.success ? '' : JSON.stringify(result.error.issues.slice(0, 5)));
    assert.equal(json.synthetic, true);
    assert.match(json.description ?? '', /synthetic/i, `${name}: the description says the data is synthetic`);
  });
}

test('the dataset is one metro area: people, companies, projects, events, publications, magazine issues and courses', () => {
  const counts = Object.fromEntries(US_FILES.filter((f) => f !== 'workspace').map((f) => [f, rows(f).length]));
  for (const [file, count] of Object.entries(counts)) assert.ok(count >= 2, `${file}: ${count}`);
  const pack = getCountryPack('US')!;
  const regions = new Set(pack.regions.map((r) => r.code));
  for (const row of [...people, ...companies, ...projects]) assert.ok(regions.has(row.region), `${row.slug}: ${row.region} is a US pack region`);
  assert.deepEqual([...new Set([...people, ...companies, ...projects].map((r) => r.region))], ['US-CA'], 'everything is in California (San Diego County)');
  for (const event of rows('events') as Array<{ slug: string; timezone: string; region: string | null }>) {
    assert.equal(event.timezone, 'America/Los_Angeles', event.slug);
    assert.ok(event.region === null || event.region === 'US-CA', event.slug);
  }
  assert.ok(projects.some((p) => (p.project as unknown as { milestones: unknown[] }).milestones.length >= 4), 'projects carry plans (milestones)');
});

test('no real identifier, contact or address: invalid EIN prefixes, DEMO numbers, 555-01xx phones, example.invalid only', () => {
  const einPattern = new RegExp(getCountryPack('US')!.registrationIdentifier.pattern!);
  for (const c of companies) for (const id of c.company.legalIdentifiers) {
    assert.equal(id.kind, 'US-EIN');
    assert.match(id.value, /^00-\d{7}$/, `${c.slug}: EIN prefix 00 is never issued by the IRS`);
    assert.ok(!einPattern.test(id.value), `${c.slug}: the identifier must not be a valid EIN`);
  }
  const problems: string[] = [];
  for (const [pointer, value] of all) {
    const key = pointer.split('/').pop()!;
    if (/@/.test(value) && !/@example\.invalid$/.test(value)) problems.push(`${pointer}: ${value}`);
    if (/^https?:\/\//.test(value) && new URL(value).hostname !== 'example.invalid') problems.push(`${pointer}: ${value}`);
    if (key === 'phone' && !/^\+1 \d{3}-555-01\d\d$/.test(value)) problems.push(`${pointer}: ${value}`);
    if (key === 'number' && !/^DEMO-/.test(value)) problems.push(`${pointer}: ${value}`);
    if (key === 'address' && !/\((demo address|demo site, no real address|demo venue, no real address)\)$/.test(value)) problems.push(`${pointer}: ${value}`);
  }
  assert.deepEqual(problems, []);
});

test('every company name is visibly a demo name and every person name is invented', () => {
  for (const c of companies) assert.match(c.company.name, /\b(Sample|Example|Demo|Ejemplo)\b/, c.slug);
  const names = people.map((p) => p.person.displayName);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /\b(Sample\w*|\w*[Ee]xample\w*|Demo\w*|Mock\w*|Ejemplo|Muestra|Fictora|Sketchley|Draftman|Placeholder)\b/, `${name} carries a placeholder surname`);
});

test('no verification marks, no scores and no invented traffic', () => {
  for (const c of companies) {
    assert.notEqual(c.company.status, 'verified', c.slug);
    for (const id of c.company.legalIdentifiers) assert.notEqual(id.status, 'verified', c.slug);
  }
  for (const [pointer, value] of all) {
    if (pointer.endsWith('/evidence') && pointer.includes('/certificates/')) assert.equal(value, 'asserted', pointer);
    if (pointer.includes('/documents/') && pointer.endsWith('/evidence')) assert.equal(value, 'asserted', pointer);
  }
  for (const p of people) {
    const profile = p.profile as { accreditation?: unknown; platformCertificates?: unknown[] } | null | undefined;
    assert.equal(profile?.accreditation, undefined, `${p.slug}: no platform accreditation in the US demo`);
    assert.equal(profile?.platformCertificates?.length ?? 0, 0, `${p.slug}: no platform certificates in the US demo`);
  }
  for (const c of companies) assert.equal((c.profile as { accreditation?: unknown } | null)?.accreditation, undefined, c.slug);
  for (const e of rows('events') as Array<{ slug: string; registered: number; tickets: Array<{ taken: number; currency: string }> }>) {
    assert.equal(e.registered, 0, `${e.slug}: no invented registrations`);
    for (const t of e.tickets) {
      assert.equal(t.taken, 0, `${e.slug}: no invented ticket sales`);
      assert.equal(t.currency, 'USD');
    }
  }
  for (const issue of rows('issues') as Array<{ poll?: unknown }>) assert.ok(issue.poll === undefined || issue.poll !== null);
  assert.ok(!all.some(([pointer]) => /\/(rating|score|stars)$/.test(pointer)), 'no rating or score fields');
});

test('records refer only to records of the same dataset', () => {
  const ids = new Set([...people.map((p) => p.person.id), ...companies.map((c) => c.company.id), ...projects.map((p) => p.project.id), ...(rows('publications') as Array<{ publication: { id: string } }>).map((p) => p.publication.id), ...(workspace as unknown as { rfqs: Array<{ id: string }> }).rfqs.map((r) => r.id)]);
  const refs = all.filter(([pointer, value]) => /(?:Id|Ids\/\d+|\/id)$/.test(pointer) && /^us-(person|company|project|pub|rfq)-/.test(value));
  const dangling = refs.filter(([, value]) => !ids.has(value)).map(([pointer, value]) => `${pointer}: ${value}`);
  assert.ok(refs.length > 100, `references checked: ${refs.length}`);
  assert.deepEqual(dangling, []);
  const slugs = new Set([...people.map((p) => p.slug), ...companies.map((c) => c.slug)]);
  for (const [pointer, value] of all) if (/\/(personSlug|companySlug|authorSlug)$/.test(pointer)) assert.ok(slugs.has(value), `${pointer}: ${value}`);
});

test('personas: a general contractor, a sole-proprietor subcontractor, a homeowner, a buyer and a reader', () => {
  const company = (id: string | null) => companies.find((c) => c.company.id === id);
  const person = (id: string) => people.find((p) => p.person.id === id)!;
  const active = (personId: string) => workspace.memberships.find((m) => m.personId === personId && m.status === 'active');
  const { mixed, seller, owner, buyer, reader } = workspace.personas;
  assert.ok(mixed && seller && owner && buyer && reader);

  const gc = company(mixed.companyId)!;
  assert.ok((gc.kinds as string[]).includes('generalContractor'), 'mixed: a general contractor');
  assert.ok(active(mixed.personId)?.permissions.includes('company.deals.manage'));
  assert.ok(workspace.rfqs.some((r) => r.owner.id === gc.company.id) && workspace.leads.some((l) => l.companyId === gc.company.id), 'the contractor buys and sells');

  const sole = company(seller.companyId)!;
  assert.match(String(sole.company.publicDescription), /sole proprietorship/i, 'seller: a sole proprietorship');
  assert.deepEqual(sole.company.legalIdentifiers, [], 'a sole proprietorship publishes no EIN');
  assert.equal(workspace.memberships.filter((m) => m.companyId === sole.company.id && m.status === 'active').length, 1, 'one owner-operator');
  assert.ok(workspace.leads.some((l) => l.companyId === sole.company.id) && !workspace.rfqs.some((r) => r.owner.id === sole.company.id), 'the subcontractor sells only');

  assert.equal(owner.companyId, null);
  assert.equal(person(owner.personId).roleLine, 'Homeowner');
  assert.ok(projects.some((p) => p.project.owner.kind === 'person' && p.project.owner.id === owner.personId), 'the homeowner owns a personal project');
  assert.ok(workspace.rfqs.some((r) => r.owner.kind === 'person' && r.owner.id === owner.personId), 'and buys for it personally');

  const client = company(buyer.companyId)!;
  assert.ok((client.kinds as string[]).includes('client'), 'buyer: works for a client company');
  assert.ok(workspace.rfqs.some((r) => r.owner.id === client.company.id) && !workspace.leads.some((l) => l.companyId === client.company.id), 'the buyer buys only');

  assert.equal(reader.companyId, null);
  assert.equal(active(reader.personId), undefined, 'reader: no company');
});

test('every reader-facing string of the US dataset has its own copy in every engine language except English', () => {
  const names = properNames();
  const tags = ENGINE_LOCALES.filter((tag) => tag !== 'en');
  assert.deepEqual(usOverrideTags(), [...tags].sort(), 'one override file per engine language');
  const expected = US_FILES.flatMap((file) => translatableStrings(file, usFile(file) as Json, names).map(([pointer, text]) => [`${file}:${pointer}`, text] as const));
  assert.ok(expected.length > 600, `translatable strings: ${expected.length}`);
  const shape = (text: string) => [/^## /gm, /^- /gm, /^> /gm, /\n\n/g, /\*\*/g].map((re) => (text.match(re) ?? []).length).join('/');
  for (const tag of tags) {
    const overrides = usOverrides(tag);
    const have = new Map(Object.entries(overrides).flatMap(([file, map]) => Object.entries(map).map(([pointer, text]) => [`${file}:${pointer}`, text] as const)));
    const missing = expected.filter(([key]) => !have.has(key)).map(([key]) => key);
    assert.deepEqual(missing.slice(0, 10), [], `${tag}: ${missing.length} strings fall back to English`);
    const wanted = new Set<string>(expected.map(([key]) => key));
    assert.deepEqual([...have.keys()].filter((key) => !wanted.has(key)), [], `${tag}: overrides only reader-facing strings`);
    for (const [key, english] of expected) {
      const text = have.get(key)!;
      assert.ok(text.trim().length > 0, `${tag} ${key} is empty`);
      assert.equal(shape(text), shape(english), `${tag} ${key} keeps the markdown structure`);
      if (tag !== 'ru') assert.ok(!/[Ѐ-ӿ]/.test(text), `${tag} ${key} contains Cyrillic`);
    }
    for (const [file, map] of Object.entries(overrides)) {
      const copy = structuredClone(usFile(file as (typeof US_FILES)[number])) as Record<string, unknown>;
      for (const [pointer, text] of Object.entries(map)) {
        const parts = pointer.split('/');
        let node: unknown = copy;
        for (const part of parts.slice(0, -1)) node = Array.isArray(node) ? node[Number(part)] : (node as Record<string, unknown>)[part];
        const last = parts.at(-1)!;
        assert.equal(typeof (node as Record<string, unknown>)[last], 'string', `${tag} ${file}:${pointer}`);
        (node as Record<string, unknown>)[last] = text;
      }
      const result = FIXTURE_FILES[`${file}.json` as keyof typeof FIXTURE_FILES].safeParse(copy);
      assert.ok(result.success, result.success ? '' : `${tag}/${file}: ${JSON.stringify(result.error.issues.slice(0, 3))}`);
    }
  }
});

test('dataset selection: the visitor country, then the configured default country, then the example hub', () => {
  assert.deepEqual(DATASETS.us.countries, ['US']);
  assert.equal(datasetForCountry('us'), 'us');
  assert.equal(datasetForCountry('UZ'), 'example');
  for (const code of ['GE', 'AM', 'AZ']) assert.equal(datasetForCountry(code), 'example', `${code} stays a selectable example`);
  assert.equal(datasetForCountry('FR'), null);
  assert.equal(selectDataset(null, 'US'), 'us', 'a first visit to the US hub');
  assert.equal(selectDataset('', 'US'), 'us');
  assert.equal(selectDataset('UZ', 'US'), 'example', 'choosing Uzbekistan on the US hub');
  assert.equal(selectDataset('FR', 'US'), 'us', 'a country without its own dataset reads the hub default');
  assert.equal(selectDataset('US', 'UZ'), 'us', 'choosing the United States on a UZ-default deployment');
  assert.equal(selectDataset(null, 'UZ'), 'example');
  assert.equal(selectDataset(null, null), 'example', 'no configuration: the example hub, as before');
});

/** A fresh server process per observation (the configuration is read once per process; CFG-001). */
function probe(env: Record<string, string>): { dataset: string; languages: string[]; firstCompany: string; firstTagline: string; regions: string[] } {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TRUSTWORK_') && !key.startsWith('NEXT_PUBLIC_')));
  const run = spawnSync(process.execPath, ['--import', 'tsx', join(REPO, 'tests/web/demo-us/probe.mjs'), REPO], { cwd: join(REPO, 'apps/web'), env: { ...clean, ...env }, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`probe failed (${run.status}): ${run.stderr}`);
  return JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
}

test('the configured default country selects the dataset at server start (US, UZ and none)', () => {
  const us = probe({ TRUSTWORK_DEFAULT_COUNTRY: 'US' });
  assert.equal(us.dataset, 'us');
  assert.equal(us.firstCompany, 'Sample Coast Builders');
  assert.deepEqual(us.regions, ['US-CA']);
  assert.deepEqual([...us.languages].sort(), [...ENGINE_LOCALES].sort(), 'US demo content in every engine language');
  assert.equal(probe({ TRUSTWORK_DEFAULT_COUNTRY: 'UZ' }).dataset, 'example');
  assert.equal(probe({}).dataset, 'example');
  const es = probe({ TRUSTWORK_DEFAULT_COUNTRY: 'US', PROBE_LANGUAGE: 'es' });
  assert.match(es.firstTagline, /contratista general/i);
});

test('a deployment can replace the US demo copy of a language from its data directory (CFG-001)', () => {
  const data = dataDirectory();
  try {
    data.write('fixtures/us/i18n/es.json', { companies: { 'companies/0/profile/tagline': 'Texto de la implantación' } });
    const replaced = probe({ TRUSTWORK_DEFAULT_COUNTRY: 'US', TRUSTWORK_DATA_DIR: data.dir, PROBE_LANGUAGE: 'es' });
    assert.equal(replaced.firstTagline, 'Texto de la implantación');
  } finally {
    data.remove();
  }
});
