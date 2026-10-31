// PLAN-000: the open plan-step taxonomy validates, and every check fails on the defect it guards against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTaxonomy, validateTaxonomy, validateHubCrosswalk, indexTerms, relations, graphs } from '../../data/taxonomy/validate.mjs';

const base = loadTaxonomy();
const fresh = () => structuredClone(base);
const terms = (tax, scheme) => tax.schemes[scheme].terms;
const term = (tax, code) => Object.values(tax.schemes).flatMap((s) => s.terms).find((t) => t.code === code);
const example = (tax, projectType) => tax.examples.find((e) => e.projectType === projectType);
const step = (ex, key) => ex.steps.find((s) => s.key === key);
const expectError = (tax, pattern) => {
  const errors = validateTaxonomy(tax);
  assert.ok(errors.some((e) => pattern.test(e)), `expected an error matching ${pattern}, got:\n${errors.slice(0, 10).join('\n') || '(none)'}`);
};

test('the shipped taxonomy is valid', () => {
  assert.deepEqual(validateTaxonomy(base), []);
});

test('the taxonomy is CC0 and ships its licence text', () => {
  assert.equal(base.manifest.licence, 'CC0-1.0');
  assert.match(readFileSync(new URL('../../data/taxonomy/LICENSE', import.meta.url), 'utf8'), /CC0 1\.0 Universal/);
});

test('it covers stages, work types, trades, materials, permits, inspections, decisions and project types', () => {
  const index = indexTerms(base);
  const leaves = (scheme) => [...index.values()].filter((e) => e.scheme === scheme && e.leaf).length;
  for (const [scheme, min] of Object.entries({ stage: 10, work_type: 50, trade: 30, material: 50, permit_type: 10, inspection_type: 10, decision: 5, project_type: 5 })) {
    assert.ok(leaves(scheme) >= min, `${scheme}: ${leaves(scheme)} leaves`);
  }
});

test('codes are unique across schemes', () => {
  const tax = fresh();
  terms(tax, 'trade').push({ code: 'trade.plumber', parent: 'trade.systems', kind: 'craft' });
  expectError(tax, /trade\.plumber: duplicate code/);
});

test('codes follow the format and the scheme prefix', () => {
  const tax = fresh();
  terms(tax, 'trade').push({ code: 'material.oops', parent: 'trade.systems', kind: 'craft' });
  terms(tax, 'trade').push({ code: 'trade.Bad-Code', parent: 'trade.systems', kind: 'craft' });
  expectError(tax, /material\.oops: code must start with the scheme prefix/);
  expectError(tax, /trade\.Bad-Code.*code must match/);
});

test('predecessor cycles are rejected', () => {
  const tax = fresh();
  term(tax, 'work.planning.brief').predecessors = ['decision.final_acceptance'];
  expectError(tax, /steps: predecessor cycle/);
  const stages = fresh();
  term(stages, 'stage.define').predecessors = ['stage.handover'];
  expectError(stages, /stages: predecessor cycle/);
});

test('predecessors must exist and be sequenced leaves', () => {
  const tax = fresh();
  term(tax, 'work.structure.walls').predecessors.push('work.structure.unknown', 'trade.framer', 'work.structure');
  expectError(tax, /predecessor work\.structure\.unknown is not/);
  expectError(tax, /predecessor trade\.framer is not/);
  expectError(tax, /predecessor work\.structure is not/);
});

test('every term reaches its scheme root and every step is reachable from the start', () => {
  const orphan = fresh();
  terms(orphan, 'material').push({ code: 'material.orphan.thing', parent: 'material.orphan', crosswalks: { ifc: [], etim: [] } });
  expectError(orphan, /material\.orphan\.thing: parent material\.orphan does not exist/);
  const dangling = fresh();
  term(dangling, 'work.exterior.landscaping').predecessors = [];
  expectError(dangling, /work\.exterior\.landscaping: not reachable from work\.planning\.brief/);
  const stage = fresh();
  term(stage, 'stage.handover').predecessors = [];
  expectError(stage, /stage stage\.handover: not reachable from stage\.define/);
});

test('a predecessor never sits in a later stage', () => {
  const tax = fresh();
  term(tax, 'work.exterior.landscaping').predecessors.push('work.closeout.documentation');
  expectError(tax, /work\.exterior\.landscaping: in stage\.exterior_finishes but its predecessor work\.closeout\.documentation is in the later stage\.handover/);
});

test('relations point to leaves of the right scheme and produces uses the plan item kinds', () => {
  const tax = fresh();
  Object.assign(term(tax, 'work.interior.tile'), { trades: ['material.finishes.ceramic_tile'], produces: ['magic'] });
  expectError(tax, /trades entry material\.finishes\.ceramic_tile is not a trade leaf/);
  expectError(tax, /produces "magic"/);
});

test('every label key is present in English, and no locale has unknown or empty keys', () => {
  const missing = fresh();
  delete missing.locales.en.labels['work.interior.tile'];
  expectError(missing, /locale en: 1 missing labels key\(s\): work\.interior\.tile/);
  const question = fresh();
  delete question.locales.en.questions['permit.building'];
  expectError(question, /locale en: 1 missing questions key\(s\): permit\.building/);
  const unknown = fresh();
  unknown.locales.es.labels['work.nothing'] = 'Nada';
  expectError(unknown, /locale es: unknown labels key work\.nothing/);
  const empty = fresh();
  empty.locales.ka.labels['stage.design'] = ' ';
  expectError(empty, /locale ka: labels\.stage\.design must be non-empty/);
});

test('every engine locale translates every key, and only the reference locale is the reference', () => {
  for (const tag of base.manifest.locales) {
    const locale = base.locales[tag];
    assert.equal(Object.keys(locale.labels).length, indexTerms(base).size, tag);
    assert.equal(locale.status, tag === 'en' ? 'reference' : 'machine_draft', `${tag}: translations other than English await native review`);
  }
  const tax = fresh();
  tax.locales.ru.status = 'reference';
  expectError(tax, /locale ru: status must be machine_draft or reviewed/);
});

test('released codes are stable: never deleted, never released as draft, never silently added', () => {
  const removed = fresh();
  terms(removed, 'trade').splice(terms(removed, 'trade').findIndex((t) => t.code === 'trade.cleaner'), 1);
  expectError(removed, /released code trade\.cleaner no longer exists/);
  const draft = fresh();
  term(draft, 'trade.cleaner').status = 'draft';
  expectError(draft, /trade\.cleaner: released in 1\.0\.0 but marked draft/);
  const added = fresh();
  terms(added, 'trade').push({ code: 'trade.glazier', parent: 'trade.envelope', kind: 'craft' });
  for (const tag of added.manifest.locales) added.locales[tag].labels['trade.glazier'] = 'Glazier';
  expectError(added, /trade\.glazier: status released but not listed in any release file/);
  const asDraft = fresh();
  terms(asDraft, 'trade').push({ code: 'trade.glazier', parent: 'trade.envelope', kind: 'craft', status: 'draft' });
  for (const tag of asDraft.manifest.locales) asDraft.locales[tag].labels['trade.glazier'] = 'Glazier';
  assert.deepEqual(validateTaxonomy(asDraft), [], 'a draft term may be added before its release');
  const retired = fresh();
  term(retired, 'trade.cleaner').status = 'retired';
  expectError(retired, /work\.closeout\.cleaning: trades entry trade\.cleaner is retired/);
});

test('the engine works without any proprietary classification: shipped crosswalks are open schemes only', () => {
  const shipped = new Set(base.crosswalkSchemes.filter((c) => c.distribution === 'shipped').map((c) => c.id));
  assert.deepEqual([...shipped].sort(), ['etim', 'ifc']);
  for (const [code, { term: t }] of indexTerms(base)) for (const key of Object.keys(t.crosswalks ?? {})) assert.ok(shipped.has(key), `${code} ships ${key}`);
  const licensed = fresh();
  term(licensed, 'work.interior.tile').crosswalks.masterformat = ['SYNTHETIC-1'];
  expectError(licensed, /masterformat is a licensed classification; its mappings are hub data and never ship/);
  const file = fresh();
  file.files.push('crosswalks/masterformat.json');
  expectError(file, /file crosswalks\/masterformat\.json: not part of the taxonomy layout \(licensed crosswalks are hub data/);
});

test('open crosswalk slots exist on every work type and material leaf and follow the scheme format', () => {
  const tax = fresh();
  delete term(tax, 'material.openings.windows').crosswalks.etim;
  term(tax, 'work.envelope.roofing').crosswalks.ifc.push('roofing');
  expectError(tax, /material\.openings\.windows: missing etim crosswalk slot/);
  expectError(tax, /work\.envelope\.roofing: ifc crosswalk "roofing" does not match/);
});

test('a hub-licensed crosswalk validates against the open taxonomy and needs a licence record', () => {
  const crosswalk = {
    scheme: 'masterformat',
    hub: 'us-demo',
    licence: { holder: 'Synthetic Hub Operator LLC', reference: 'SYNTHETIC-LICENCE-1', validUntil: '2027-12-31', uses: ['display'] },
    mappings: { 'work.interior.tile': ['SYNTHETIC-A'], 'material.finishes.ceramic_tile': ['SYNTHETIC-B'] },
  };
  assert.deepEqual(validateHubCrosswalk(base, crosswalk), []);
  assert.match(validateHubCrosswalk(base, { ...crosswalk, licence: {} }).join('\n'), /licence needs holder/);
  assert.match(validateHubCrosswalk(base, { ...crosswalk, mappings: { 'work.nothing': ['X'] } }).join('\n'), /work\.nothing is not a taxonomy leaf/);
  assert.match(validateHubCrosswalk(base, { ...crosswalk, mappings: { 'decision.go_ahead': ['X'] } }).join('\n'), /does not apply to decision/);
  assert.match(validateHubCrosswalk(base, { ...crosswalk, scheme: 'ifc' }).join('\n'), /ifc is an open scheme/);
});

test('jurisdiction facets never present a requirement as verified without a source', () => {
  const us = base.jurisdictions.find((j) => j.pack === 'US');
  const facets = [...Object.values(us.permits), ...Object.values(us.inspections), ...Object.values(us.trades)];
  assert.ok(facets.length > 0);
  for (const f of facets) assert.equal(f.verification, 'unverified');
  const tax = fresh();
  tax.jurisdictions.find((j) => j.pack === 'US').permits['permit.building'].verification = 'verified';
  expectError(tax, /permit\.building: verification "verified" needs at least one source/);
  const cited = fresh();
  cited.jurisdictions.find((j) => j.pack === 'US').permits['permit.building'].citation = 'Section 1';
  expectError(cited, /permit\.building: unknown field "citation"/);
  const gap = fresh();
  delete gap.jurisdictions.find((j) => j.pack === 'US').inspections['inspection.footing'];
  expectError(gap, /no inspections facet for inspection\.footing/);
});

test('the US new house example covers the build end to end in a valid order', () => {
  const ex = example(base, 'project.new_house');
  assert.equal(ex.synthetic, true);
  const used = new Set(ex.steps.map((s) => s.term));
  const index = indexTerms(base);
  const stages = new Set([...used].map((c) => index.get(c).term.stage).filter(Boolean));
  for (const s of graphs(base).stages.keys()) assert.ok(stages.has(s), `new house example skips ${s}`);
  for (const code of ['permit.building', 'inspection.footing', 'inspection.framing', 'inspection.building_final', 'permit.occupancy', 'decision.final_acceptance']) assert.ok(used.has(code), code);
  assert.equal(ex.steps[0].term, 'work.planning.brief');
});

test('the US renovation example orders abatement and demolition before alterations', () => {
  const ex = example(base, 'project.whole_house_renovation');
  assert.ok(ex);
  const keys = ex.steps.map((s) => s.key);
  assert.ok(keys.indexOf('i_clearance') < keys.indexOf('demolition'));
  assert.ok(keys.indexOf('demolition') < keys.indexOf('alterations'));
});

test('examples are acyclic, connected and respect the taxonomy order and permits', () => {
  const cycle = fresh();
  step(example(cycle, 'project.new_house'), 'brief').after = ['acceptance'];
  expectError(cycle, /step cycle/);
  const order = fresh();
  step(example(order, 'project.new_house'), 'tile').after = ['i_insulation'];
  expectError(order, /step tile \(work\.interior\.tile\) must come after drywall \(work\.interior\.drywall\): taxonomy predecessor/);
  const permitLate = fresh();
  const ex = example(permitLate, 'project.whole_house_renovation');
  step(ex, 'plumbing_rough').after = ['windows_doors', 'alterations'];
  step(ex, 'p_plumbing').after = ['application', 'plumbing_rough'];
  expectError(permitLate, /step plumbing_rough \(work\.mep\.plumbing_rough\) must come after p_plumbing \(permit\.plumbing\): needed permit/);
  const loose = fresh();
  example(loose, 'project.new_house').steps.push({ key: 'extra', kind: 'task', term: 'work.mep.solar_pv', after: ['roofing'] });
  expectError(loose, /needs exactly one start and one end step/);
  const noPermit = fresh();
  const nh = example(noPermit, 'project.new_house');
  nh.steps = nh.steps.filter((s) => s.key !== 'p_grading').map((s) => ({ ...s, after: s.after.filter((a) => a !== 'p_grading') }));
  expectError(noPermit, /inspection step i_erosion has none of its permits/);
  const kind = fresh();
  step(example(kind, 'project.new_house'), 'p_building').kind = 'task';
  expectError(kind, /step p_building \(task\) needs a work_type leaf, got permit\.building/);
  const real = fresh();
  example(real, 'project.new_house').synthetic = false;
  expectError(real, /worked examples are synthetic/);
});

test('relations use the data model vocabulary for DATA-003', () => {
  const rows = relations(base);
  const kinds = new Set(rows.map((r) => r.relation));
  for (const k of ['precedes', 'precedes_stage', 'in_stage', 'requires_trade', 'uses_material', 'needs_permit_type']) assert.ok(kinds.has(k), k);
  assert.ok(rows.some((r) => r.from === 'work.interior.tile' && r.relation === 'requires_trade' && r.to === 'trade.tile_setter'));
});
