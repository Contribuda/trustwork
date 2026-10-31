// Trustwork plan-step taxonomy: loader and validator (PLAN-000). The data in this directory is CC0 1.0.
// Run `node data/taxonomy/validate.mjs` for a summary; tests/taxonomy runs the same checks inside `npm run check`.
// Pure functions over a plain object, so tests can mutate a copy and expect the matching error.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TAXONOMY_DIR = dirname(fileURLToPath(import.meta.url));

const CODE = /^[a-z]+(?:\.[a-z0-9_]+)*$/;
const STEP_KEY = /^[a-z0-9_]+$/;
const STATUSES = new Set(['draft', 'released', 'retired']);
const PLACEHOLDER = /\b(?:TODO|TBD|FIXME|XXX)\b|lorem ipsum/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const FIELDS = {
  stage: ['code', 'parent', 'status', 'predecessors'],
  project_type: ['code', 'parent', 'status'],
  work_type: ['code', 'parent', 'status', 'stage', 'predecessors', 'trades', 'materials', 'permits', 'produces', 'crosswalks'],
  trade: ['code', 'parent', 'status', 'kind'],
  material: ['code', 'parent', 'status', 'crosswalks'],
  permit_type: ['code', 'parent', 'status', 'stage', 'predecessors'],
  inspection_type: ['code', 'parent', 'status', 'stage', 'predecessors', 'permits'],
  decision: ['code', 'parent', 'status', 'stage', 'predecessors'],
};
const FACET_FIELDS = { step: ['applicability', 'authority', 'verification', 'sources'], trade: ['licensing', 'verification', 'sources'] };

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== '.DS_Store').flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** Reads every taxonomy file into one plain object. */
export function loadTaxonomy(dir = TAXONOMY_DIR) {
  const manifest = readJson(join(dir, 'manifest.json'));
  const read = (sub) => listJson(join(dir, sub)).map((f) => ({ file: `${sub}/${f}`, ...readJson(join(dir, sub, f)) }));
  return {
    manifest,
    schemes: Object.fromEntries(manifest.schemes.map((s) => [s.id, readJson(join(dir, s.file))])),
    crosswalkSchemes: readJson(join(dir, 'crosswalks/schemes.json')).schemes,
    jurisdictions: read('jurisdictions'),
    examples: read('examples'),
    releases: read('releases'),
    locales: Object.fromEntries(listJson(join(dir, 'locales')).map((f) => [f.replace(/\.json$/, ''), readJson(join(dir, 'locales', f))])),
    files: walk(dir).map((p) => relative(dir, p).split('\\').join('/')).sort(),
  };
}

/** Index of every term: code -> { term, scheme, children, leaf }. */
export function indexTerms(tax) {
  const index = new Map();
  for (const scheme of tax.manifest.schemes) {
    for (const term of tax.schemes[scheme.id]?.terms ?? []) {
      if (!index.has(term.code)) index.set(term.code, { term, scheme: scheme.id, children: [] });
    }
  }
  for (const entry of index.values()) {
    const parent = entry.term.parent && index.get(entry.term.parent);
    if (parent) parent.children.push(entry.term.code);
  }
  for (const entry of index.values()) entry.leaf = entry.children.length === 0 && entry.term.code !== schemeOf(tax, entry.scheme).prefix;
  return index;
}

const schemeOf = (tax, id) => tax.manifest.schemes.find((s) => s.id === id);
const statusOf = (term) => term.status ?? 'released';

/** Returns the node list of a cycle in a directed graph (node -> predecessors), or null. */
export function findCycle(graph) {
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of graph.keys()) if (!state.has(node)) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

/** Nodes reachable from `start` following successor edges of a predecessor graph. */
function reachableFrom(graph, start) {
  const successors = new Map();
  for (const [node, preds] of graph) for (const p of preds) successors.set(p, [...(successors.get(p) ?? []), node]);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) for (const next of successors.get(queue.shift()) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
}

/** Nodes from which `end` is reachable (ancestors in successor direction). */
function reaching(graph, end) {
  const seen = new Set([end]);
  const queue = [end];
  while (queue.length) for (const prev of graph.get(queue.shift()) ?? []) if (!seen.has(prev)) { seen.add(prev); queue.push(prev); }
  return seen;
}

/** Transitive predecessor sets for an acyclic graph: node -> Set of every node that must come before it. */
function ancestors(graph) {
  const memo = new Map();
  const get = (node) => {
    if (memo.has(node)) return memo.get(node);
    memo.set(node, new Set());
    const all = new Set();
    for (const p of graph.get(node) ?? []) { all.add(p); for (const a of get(p)) all.add(a); }
    memo.set(node, all);
    return all;
  };
  for (const node of graph.keys()) get(node);
  return memo;
}

/** The step graph (sequenced leaf code -> predecessor codes) and the stage graph. */
export function graphs(tax, index = indexTerms(tax)) {
  const steps = new Map();
  const stages = new Map();
  for (const [code, entry] of index) {
    if (!entry.leaf) continue;
    if (entry.scheme === 'stage') stages.set(code, entry.term.predecessors ?? []);
    else if (schemeOf(tax, entry.scheme)?.sequenced) steps.set(code, entry.term.predecessors ?? []);
  }
  return { steps, stages };
}

/** Validates the whole taxonomy; returns a list of error strings (empty when valid). */
export function validateTaxonomy(tax) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  const { manifest } = tax;
  if (manifest.licence !== 'CC0-1.0') err('manifest: licence must be CC0-1.0');
  if (!SEMVER.test(manifest.version ?? '')) err('manifest: version must be semantic (x.y.z)');
  if (!manifest.locales?.includes(manifest.referenceLocale)) err('manifest: the reference locale must be listed in locales');

  // Terms: format, uniqueness, scheme, fields, hierarchy.
  const seen = new Map();
  for (const scheme of manifest.schemes) {
    const file = tax.schemes[scheme.id];
    if (!file) { err(`scheme ${scheme.id}: file ${scheme.file} missing`); continue; }
    if (file.scheme !== scheme.id) err(`scheme ${scheme.id}: file declares scheme "${file.scheme}"`);
    const roots = [];
    for (const term of file.terms ?? []) {
      const code = term.code;
      if (typeof code !== 'string' || !CODE.test(code)) { err(`term ${JSON.stringify(code)}: code must match ${CODE}`); continue; }
      if (seen.has(code)) err(`term ${code}: duplicate code (also in ${seen.get(code)})`);
      seen.set(code, scheme.id);
      if (code !== scheme.prefix && !code.startsWith(`${scheme.prefix}.`)) err(`term ${code}: code must start with the scheme prefix "${scheme.prefix}."`);
      for (const key of Object.keys(term)) if (!FIELDS[scheme.id]?.includes(key)) err(`term ${code}: unknown field "${key}"`);
      if (!STATUSES.has(statusOf(term))) err(`term ${code}: status must be draft, released or retired`);
      if (code === scheme.prefix) { roots.push(code); if (term.parent) err(`term ${code}: the scheme root has no parent`); }
      else if (!term.parent) err(`term ${code}: missing parent (only the scheme root "${scheme.prefix}" has none)`);
    }
    if (roots.length !== 1) err(`scheme ${scheme.id}: needs exactly one root term "${scheme.prefix}"`);
  }
  const index = indexTerms(tax);
  const leafIn = (code, schemeId) => index.get(code)?.scheme === schemeId && index.get(code).leaf;

  for (const [code, { term, scheme }] of index) {
    if (term.parent) {
      const parent = index.get(term.parent);
      if (!parent) err(`term ${code}: parent ${term.parent} does not exist`);
      else if (parent.scheme !== scheme) err(`term ${code}: parent ${term.parent} is in another scheme`);
    }
    // Every term reaches its scheme root through parents (no orphans, no parent cycles).
    const chain = new Set([code]);
    let cur = term;
    while (cur?.parent && !chain.has(cur.parent)) { chain.add(cur.parent); cur = index.get(cur.parent)?.term; }
    if (cur?.parent) err(`term ${code}: parent cycle through ${cur.parent}`);
    else if (cur && cur.code !== schemeOf(tax, scheme).prefix) err(`term ${code}: not reachable from the scheme root`);
  }

  // Relations on leaves; groups carry none.
  const sequencedFields = ['stage', 'predecessors', 'trades', 'materials', 'permits', 'produces', 'crosswalks'];
  for (const [code, { term, scheme, leaf }] of index) {
    if (!leaf) {
      for (const key of sequencedFields) if (key in term) err(`term ${code}: group terms carry no ${key}; put it on the leaves`);
      continue;
    }
    const s = schemeOf(tax, scheme);
    if (s.sequenced || scheme === 'stage') {
      if (!Array.isArray(term.predecessors)) err(`term ${code}: predecessors must be an array (empty for a start)`);
    }
    if (s.sequenced && !leafIn(term.stage, 'stage')) err(`term ${code}: stage ${term.stage} is not a stage`);
    const refs = (key, schemeId) => {
      if (!(key in term)) return;
      if (!Array.isArray(term[key])) return err(`term ${code}: ${key} must be an array`);
      if (new Set(term[key]).size !== term[key].length) err(`term ${code}: duplicate entries in ${key}`);
      for (const ref of term[key]) {
        if (!leafIn(ref, schemeId)) err(`term ${code}: ${key} entry ${ref} is not a ${schemeId} leaf`);
        else if (statusOf(term) !== 'retired' && statusOf(index.get(ref).term) === 'retired') err(`term ${code}: ${key} entry ${ref} is retired`);
      }
    };
    if (scheme === 'work_type') {
      for (const key of ['trades', 'materials', 'permits', 'produces', 'crosswalks']) if (!(key in term)) err(`term ${code}: missing ${key}`);
      refs('trades', 'trade');
      refs('materials', 'material');
      refs('permits', 'permit_type');
      for (const p of term.produces ?? []) if (!manifest.produces.includes(p)) err(`term ${code}: produces "${p}" is not one of ${manifest.produces.join(', ')}`);
    }
    if (scheme === 'inspection_type') {
      if (!term.permits?.length) err(`term ${code}: an inspection names the permit(s) it belongs to`);
      refs('permits', 'permit_type');
    }
    if (scheme === 'trade' && !manifest.tradeKinds.includes(term.kind)) err(`term ${code}: kind must be one of ${manifest.tradeKinds.join(', ')}`);
    if (scheme === 'work_type' || scheme === 'material') checkCrosswalks(tax, code, scheme, term, err);
    if (s.sequenced || scheme === 'stage') {
      if (Array.isArray(term.predecessors) && new Set(term.predecessors).size !== term.predecessors.length) err(`term ${code}: duplicate predecessors`);
      for (const p of term.predecessors ?? []) {
        if (p === code) err(`term ${code}: lists itself as a predecessor`);
        else if (scheme === 'stage' ? !leafIn(p, 'stage') : !(index.get(p)?.leaf && schemeOf(tax, index.get(p).scheme)?.sequenced)) {
          err(`term ${code}: predecessor ${p} is not a ${scheme === 'stage' ? 'stage' : 'sequenced leaf term'}`);
        }
      }
    }
  }

  // Predecessor graphs: acyclic, reachable, stage-consistent.
  const { steps, stages } = graphs(tax, index);
  const stageCycle = findCycle(stages);
  if (stageCycle) err(`stages: predecessor cycle ${stageCycle.join(' -> ')}`);
  const stepCycle = findCycle(steps);
  if (stepCycle) err(`steps: predecessor cycle ${stepCycle.join(' -> ')}`);
  if (!stages.has(manifest.stageStart) || !stages.has(manifest.stageEnd)) err('manifest: stageStart and stageEnd must be stages');
  else {
    const fromStart = reachableFrom(stages, manifest.stageStart);
    const toEnd = reaching(stages, manifest.stageEnd);
    for (const code of stages.keys()) {
      if (!fromStart.has(code)) err(`stage ${code}: not reachable from ${manifest.stageStart}`);
      if (!toEnd.has(code)) err(`stage ${code}: does not lead to ${manifest.stageEnd}`);
    }
  }
  if (!steps.has(manifest.sequenceStart)) err(`manifest: sequenceStart ${manifest.sequenceStart} is not a sequenced leaf`);
  else if (!stepCycle) {
    const fromStart = reachableFrom(steps, manifest.sequenceStart);
    for (const code of steps.keys()) if (!fromStart.has(code)) err(`term ${code}: not reachable from ${manifest.sequenceStart} through predecessors`);
  }
  if (!stageCycle && !stepCycle) {
    const stageBefore = ancestors(stages);
    for (const [code, preds] of steps) {
      const mine = index.get(code).term.stage;
      for (const p of preds) {
        const theirs = index.get(p)?.term.stage;
        if (theirs && mine && stageBefore.get(theirs)?.has(mine)) err(`term ${code}: in ${mine} but its predecessor ${p} is in the later ${theirs}`);
      }
    }
  }

  checkReleases(tax, index, err);
  checkLocales(tax, index, err);
  checkJurisdictions(tax, index, err);
  if (!stepCycle) for (const example of tax.examples) checkExample(tax, index, steps, example, err);
  checkFiles(tax, err);
  return errors;
}

function checkCrosswalks(tax, code, scheme, term, err) {
  if (!term.crosswalks || typeof term.crosswalks !== 'object') return err(`term ${code}: missing crosswalks slots`);
  const shipped = tax.crosswalkSchemes.filter((c) => c.distribution === 'shipped' && c.appliesTo.includes(scheme));
  for (const key of Object.keys(term.crosswalks)) {
    const known = tax.crosswalkSchemes.find((c) => c.id === key);
    if (known?.distribution === 'hub_licensed') err(`term ${code}: ${key} is a licensed classification; its mappings are hub data and never ship in the repository`);
    else if (!shipped.some((c) => c.id === key)) err(`term ${code}: crosswalk ${key} is not an open scheme for ${scheme}`);
  }
  for (const c of shipped) {
    const values = term.crosswalks[c.id];
    if (!Array.isArray(values)) { err(`term ${code}: missing ${c.id} crosswalk slot`); continue; }
    if (new Set(values).size !== values.length) err(`term ${code}: duplicate ${c.id} crosswalk entries`);
    for (const v of values) if (typeof v !== 'string' || !new RegExp(c.codeFormat).test(v)) err(`term ${code}: ${c.id} crosswalk "${v}" does not match ${c.codeFormat}`);
  }
}

function checkReleases(tax, index, err) {
  const released = new Map();
  const versions = [];
  for (const release of tax.releases) {
    if (!SEMVER.test(release.version ?? '') || !DATE.test(release.date ?? '')) err(`${release.file}: needs version (x.y.z) and date (YYYY-MM-DD)`);
    versions.push(release.version);
    if (!Array.isArray(release.codes) || new Set(release.codes).size !== release.codes.length) { err(`${release.file}: codes must be a list without duplicates`); continue; }
    for (const code of release.codes) {
      if (!released.has(code)) released.set(code, release.version);
      const entry = index.get(code);
      if (!entry) err(`${release.file}: released code ${code} no longer exists (released codes are never deleted or renamed; retire them)`);
      else if (statusOf(entry.term) === 'draft') err(`term ${code}: released in ${release.version} but marked draft`);
    }
  }
  const latest = versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
  if (latest !== tax.manifest.version) err(`manifest: version ${tax.manifest.version} has no release file (latest is ${latest ?? 'none'})`);
  for (const [code, { term }] of index) if (statusOf(term) !== 'draft' && !released.has(code)) err(`term ${code}: status ${statusOf(term)} but not listed in any release file`);
}

function checkLocales(tax, index, err) {
  const { manifest } = tax;
  const expected = {
    labels: [...index.keys()],
    questions: [...index].filter(([, e]) => e.leaf && schemeOf(tax, e.scheme).questions).map(([code]) => code),
    values: Object.entries(manifest.facetValues).flatMap(([facet, values]) => values.map((v) => `${facet}.${v}`)),
    messages: manifest.messages,
  };
  for (const tag of manifest.locales) {
    const locale = tax.locales[tag];
    if (!locale) { err(`locale ${tag}: locales/${tag}.json missing`); continue; }
    if (locale.locale !== tag) err(`locale ${tag}: file declares locale "${locale.locale}"`);
    const wantStatus = tag === manifest.referenceLocale ? ['reference'] : ['machine_draft', 'reviewed'];
    if (!wantStatus.includes(locale.status)) err(`locale ${tag}: status must be ${wantStatus.join(' or ')}`);
    if (typeof locale.review !== 'string' || !locale.review.trim()) err(`locale ${tag}: say who wrote or reviewed the translation (review)`);
    for (const [section, keys] of Object.entries(expected)) {
      const dict = locale[section] ?? {};
      const missing = keys.filter((k) => !(k in dict));
      if (missing.length) err(`locale ${tag}: ${missing.length} missing ${section} key(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`);
      for (const [key, text] of Object.entries(dict)) {
        if (!keys.includes(key)) err(`locale ${tag}: unknown ${section} key ${key}`);
        else if (typeof text !== 'string' || !text.trim() || text !== text.trim() || PLACEHOLDER.test(text)) err(`locale ${tag}: ${section}.${key} must be non-empty trimmed text without placeholders`);
      }
    }
  }
  for (const tag of Object.keys(tax.locales)) if (!manifest.locales.includes(tag)) err(`locale ${tag}: not listed in manifest.locales`);
}

function checkJurisdictions(tax, index, err) {
  const values = tax.manifest.facetValues;
  for (const j of tax.jurisdictions) {
    if (!/^[A-Z]{2}$/.test(j.pack ?? '')) err(`${j.file}: pack must be an ISO 3166-1 alpha-2 country-pack code`);
    if (j.file !== `jurisdictions/${j.pack}.json`) err(`${j.file}: file name must match the pack code`);
    const sections = { permits: ['permit_type', 'step'], inspections: ['inspection_type', 'step'], trades: ['trade', 'trade'] };
    for (const [section, [schemeId, kind]] of Object.entries(sections)) {
      const facets = j[section] ?? {};
      const leaves = [...index].filter(([, e]) => e.scheme === schemeId && e.leaf).map(([code]) => code);
      for (const code of leaves) if (!(code in facets) && statusOf(index.get(code).term) === 'released') err(`${j.file}: no ${section} facet for ${code}`);
      for (const [code, facet] of Object.entries(facets)) {
        const where = `${j.file}: ${code}`;
        if (!leaves.includes(code)) { err(`${where}: not a ${schemeId} leaf`); continue; }
        for (const key of Object.keys(facet)) if (!FACET_FIELDS[kind].includes(key)) err(`${where}: unknown field "${key}"`);
        for (const key of FACET_FIELDS[kind].filter((k) => k !== 'sources')) if (!values[key]?.includes(facet[key])) err(`${where}: ${key} "${facet[key]}" is not one of ${values[key]?.join(', ')}`);
        if (!Array.isArray(facet.sources)) { err(`${where}: sources must be an array`); continue; }
        for (const source of facet.sources) {
          if (!/^https:\/\//.test(source?.url ?? '') || !source.what || !DATE.test(source.accessed ?? '')) err(`${where}: each source needs an https url, what it supports and an accessed date`);
        }
        if (facet.verification !== 'unverified' && facet.sources.length === 0) err(`${where}: verification "${facet.verification}" needs at least one source`);
      }
    }
  }
}

function checkExample(tax, index, stepGraph, example, err) {
  const where = example.file;
  const kinds = tax.manifest.exampleStepKinds;
  if (example.synthetic !== true) err(`${where}: worked examples are synthetic and must say so`);
  if (!(index.get(example.projectType)?.scheme === 'project_type' && index.get(example.projectType).leaf)) err(`${where}: projectType ${example.projectType} is not a project type`);
  if (!tax.jurisdictions.some((j) => j.pack === example.jurisdiction)) err(`${where}: no jurisdiction facets for ${example.jurisdiction}`);
  const steps = example.steps ?? [];
  const byKey = new Map();
  const terms = new Map();
  for (const step of steps) {
    if (!STEP_KEY.test(step.key ?? '')) err(`${where}: step key ${JSON.stringify(step.key)} must match ${STEP_KEY}`);
    if (byKey.has(step.key)) err(`${where}: duplicate step key ${step.key}`);
    byKey.set(step.key, step);
    const entry = index.get(step.term);
    if (!kinds[step.kind]) err(`${where}: step ${step.key} has unknown kind ${step.kind}`);
    else if (!entry?.leaf || !kinds[step.kind].includes(entry.scheme)) err(`${where}: step ${step.key} (${step.kind}) needs a ${kinds[step.kind].join(' or ')} leaf, got ${step.term}`);
    else if (statusOf(entry.term) !== 'released') err(`${where}: step ${step.key} uses ${statusOf(entry.term)} term ${step.term}`);
    if (terms.has(step.term)) err(`${where}: term ${step.term} used by both ${terms.get(step.term)} and ${step.key}`);
    terms.set(step.term, step.key);
  }
  const graph = new Map(steps.map((s) => [s.key, s.after ?? []]));
  for (const step of steps) for (const a of step.after ?? []) if (!byKey.has(a) || a === step.key) err(`${where}: step ${step.key} comes after unknown step ${a}`);
  const cycle = findCycle(graph);
  if (cycle) return err(`${where}: step cycle ${cycle.join(' -> ')}`);
  const starts = steps.filter((s) => !(s.after ?? []).length).map((s) => s.key);
  const hasSuccessor = new Set(steps.flatMap((s) => s.after ?? []));
  const ends = steps.filter((s) => !hasSuccessor.has(s.key)).map((s) => s.key);
  if (starts.length !== 1 || ends.length !== 1) err(`${where}: needs exactly one start and one end step (starts: ${starts.join(', ')}; ends: ${ends.join(', ')})`);
  else {
    const fromStart = reachableFrom(graph, starts[0]);
    const toEnd = reaching(graph, ends[0]);
    for (const s of steps) {
      if (!fromStart.has(s.key)) err(`${where}: step ${s.key} is not reachable from ${starts[0]}`);
      if (!toEnd.has(s.key)) err(`${where}: step ${s.key} does not lead to ${ends[0]}`);
    }
  }
  // The example respects the taxonomy order and puts every needed permit before the work it covers.
  // Direct taxonomy predecessors only: a chain through steps the example leaves out (for example new-build framing in a
  // renovation) implies nothing about the steps it keeps.
  const before = ancestors(graph);
  const must = (earlierTerm, step, why) => {
    const earlier = terms.get(earlierTerm);
    if (earlier && !before.get(step.key)?.has(earlier)) err(`${where}: step ${step.key} (${step.term}) must come after ${earlier} (${earlierTerm}): ${why}`);
  };
  for (const step of steps) {
    for (const a of stepGraph.get(step.term) ?? []) must(a, step, 'taxonomy predecessor');
    const permits = index.get(step.term)?.term.permits ?? [];
    for (const p of permits) must(p, step, 'needed permit');
    if (step.kind === 'inspection' && !permits.some((p) => terms.has(p))) err(`${where}: inspection step ${step.key} has none of its permits (${permits.join(', ')}) in the example`);
  }
}

function checkFiles(tax, err) {
  const allowed = new Set(['README.md', 'LICENSE', 'manifest.json', 'validate.mjs', 'crosswalks/schemes.json', ...tax.manifest.schemes.map((s) => s.file), ...tax.manifest.locales.map((l) => `locales/${l}.json`)]);
  for (const file of tax.files) {
    if (allowed.has(file) || /^(?:jurisdictions|examples|releases)\/[^/]+\.json$/.test(file)) continue;
    err(`file ${file}: not part of the taxonomy layout${file.startsWith('crosswalks/') ? ' (licensed crosswalks are hub data and never ship here)' : ''}`);
  }
}

/** Validates a hub's licensed crosswalk (kept outside the repository) against the open taxonomy. */
export function validateHubCrosswalk(tax, crosswalk) {
  const errors = [];
  const index = indexTerms(tax);
  const scheme = tax.crosswalkSchemes.find((c) => c.id === crosswalk?.scheme);
  if (!scheme) return [`crosswalk: unknown scheme ${crosswalk?.scheme}`];
  if (scheme.distribution !== 'hub_licensed') errors.push(`crosswalk: ${scheme.id} is an open scheme; it ships with the taxonomy, not as hub data`);
  const licence = crosswalk.licence ?? {};
  if (!licence.holder || !licence.reference || !DATE.test(licence.validUntil ?? '') || !Array.isArray(licence.uses) || !licence.uses.length) {
    errors.push('crosswalk: licence needs holder, reference, validUntil (YYYY-MM-DD) and the permitted uses');
  }
  if (!/^[a-z0-9-]+$/.test(crosswalk.hub ?? '')) errors.push('crosswalk: hub must be a hub identifier');
  for (const [code, targets] of Object.entries(crosswalk.mappings ?? {})) {
    const entry = index.get(code);
    if (!entry?.leaf) errors.push(`crosswalk: ${code} is not a taxonomy leaf`);
    else if (!scheme.appliesTo.includes(entry.scheme)) errors.push(`crosswalk: ${scheme.id} does not apply to ${entry.scheme} (${code})`);
    if (!Array.isArray(targets) || !targets.length || targets.some((t) => typeof t !== 'string' || !t.trim())) errors.push(`crosswalk: ${code} needs a non-empty list of target codes`);
  }
  return errors;
}

/** Relation rows in the vocabulary of the data model's step_term_relation (docs/data/model.md, section 2). */
export function relations(tax) {
  const rows = [];
  for (const [code, { term, scheme, leaf }] of indexTerms(tax)) {
    if (!leaf) continue;
    for (const p of term.predecessors ?? []) rows.push({ from: p, relation: scheme === 'stage' ? 'precedes_stage' : 'precedes', to: code });
    if (term.stage) rows.push({ from: code, relation: 'in_stage', to: term.stage });
    for (const t of term.trades ?? []) rows.push({ from: code, relation: 'requires_trade', to: t });
    for (const m of term.materials ?? []) rows.push({ from: code, relation: 'uses_material', to: m });
    for (const p of term.permits ?? []) rows.push({ from: code, relation: 'needs_permit_type', to: p });
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tax = loadTaxonomy();
  const errors = validateTaxonomy(tax);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    const counts = Object.fromEntries(Object.entries(tax.schemes).map(([id, f]) => [id, f.terms.length]));
    console.log(`Taxonomy ${tax.manifest.version} valid: ${JSON.stringify(counts)}, ${tax.examples.length} worked examples, ${tax.manifest.locales.length} locales.`);
  }
}
