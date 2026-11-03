import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REVIEW_STATUSES, UNREVIEWED, readLocaleReview, reviewStatement, shownStatus, type LocaleReview, type LocaleReviewStatement } from '@trustwork/i18n-runtime/review-status';

/**
 * INTL-007: no translation claims a review that did not happen. The contract, the recorded state of every language,
 * the review labels in every engine language and the table of the localization chapter.
 */
const REPO = resolve(import.meta.dirname, '../../..');
const LOCALES = join(REPO, 'apps/web/locales');
const ENGINE_LANGUAGES = ['en', 'es', 'uz-Latn', 'ka', 'hy', 'az-Latn'];

type Script = { languagesTable(root?: string): string; languagesStatement(root?: string): LocaleReviewStatement; chapterTable(chapter: string): string };
const script = (await import(new URL('../../../scripts/locale-status.mjs', import.meta.url).href)) as Script;

const languageDirectories = () => readdirSync(LOCALES).filter((name) => statSync(join(LOCALES, name)).isDirectory());
const metadata = (tag: string): unknown => JSON.parse(readFileSync(join(LOCALES, `${tag}.meta.json`), 'utf8'));

const reviewed = { status: 'native_reviewed', reviewers: [{ handle: 'a-reviewer', consent: true }], reviewedOn: '2026-12-01', namespaces: ['core', 'public'], reviewLink: 'https://example.org/review/1' };

test('a language without metadata is a machine draft, never reviewed', () => {
  for (const raw of [undefined, null, 'native_reviewed', 7, [], {}]) assert.deepEqual(readLocaleReview('ka', raw), UNREVIEWED);
  assert.equal(shownStatus(readLocaleReview('ka', undefined), ['core']), 'machine_draft');
});

test('a complete review record counts', () => {
  const review = readLocaleReview('ka', reviewed);
  assert.equal(review.status, 'native_reviewed');
  assert.deepEqual(review.reviewers, ['a-reviewer']);
  assert.equal(readLocaleReview('ka', { ...reviewed, status: 'community_reviewed' }).status, 'community_reviewed');
});

test('a review record that does not hold up stays a machine draft', () => {
  const broken: Array<[string, Record<string, unknown>]> = [
    ['an unknown status', { status: 'professionally_reviewed' }],
    ['no reviewer', { reviewers: [] }],
    ['no reviewers field', { reviewers: undefined }],
    ['a reviewer without consent', { reviewers: [{ handle: 'a-reviewer' }] }],
    ['a reviewer who refused', { reviewers: [{ handle: 'a-reviewer', consent: false }] }],
    ['consent that is not literally true', { reviewers: [{ handle: 'a-reviewer', consent: 'yes' }] }],
    ['one of two reviewers without consent', { reviewers: [{ handle: 'a-reviewer', consent: true }, { handle: 'someone-else', consent: false }] }],
    ['a name that is not a public handle', { reviewers: [{ handle: 'Jane Doe <jane@example.org>', consent: true }] }],
    ['no date', { reviewedOn: null }],
    ['a date that does not exist', { reviewedOn: '2026-02-30' }],
    ['a date in another format', { reviewedOn: '12/01/2026' }],
    ['no namespaces', { namespaces: [] }],
    ['a malformed namespace', { namespaces: ['core', '../secrets'] }],
    ['no link', { reviewLink: null }],
    ['a link that is not https', { reviewLink: 'http://example.org/review/1' }],
    ['a script link', { reviewLink: 'javascript:alert(1)' }],
  ];
  for (const [name, change] of broken) {
    const review = readLocaleReview('ka', { ...reviewed, ...change });
    assert.equal(review.status, 'machine_draft', name);
    assert.deepEqual(review.reviewers, [], `${name}: no handle survives`);
    assert.equal(shownStatus(review, ['core']), 'machine_draft', name);
  }
});

test('only English is the reference', () => {
  assert.equal(readLocaleReview('en', { status: 'reference' }).status, 'reference');
  assert.equal(readLocaleReview('ka', { status: 'reference' }).status, 'machine_draft');
  assert.equal(readLocaleReview('en', undefined).status, 'machine_draft', 'a missing record claims nothing, not even for English');
});

test('a review speaks for the namespaces it covered', () => {
  const review = readLocaleReview('ka', reviewed);
  assert.equal(shownStatus(review, ['core', 'public']), 'native_reviewed');
  assert.equal(shownStatus(review, ['core']), 'native_reviewed');
  assert.equal(shownStatus(review, ['core', 'public', 'commerce']), 'machine_draft', 'a namespace the review left out, or one added since, is not reviewed');
});

test('the machine-readable form carries the status and the consented record, never a contributor note', () => {
  const statement = reviewStatement(
    [
      { tag: 'en', review: readLocaleReview('en', { status: 'reference', note: 'private to the docs', package: 'INTL-002' }) },
      { tag: 'ka', review: readLocaleReview('ka', reviewed) },
      { tag: 'hy', review: readLocaleReview('hy', undefined) },
    ],
    ['core', 'public', 'commerce'],
  );
  assert.equal(statement.schema, 'trustwork-locale-review/1');
  assert.equal(statement.reference, 'en');
  assert.deepEqual(statement.locales.map(({ tag, status }) => [tag, status]), [['en', 'reference'], ['ka', 'machine_draft'], ['hy', 'machine_draft']]);
  assert.deepEqual(statement.locales[1]!.review, { status: 'native_reviewed', reviewers: ['a-reviewer'], reviewedOn: '2026-12-01', namespaces: ['core', 'public'], link: 'https://example.org/review/1' });
  assert.equal(statement.locales[2]!.review, null);
  assert.doesNotMatch(JSON.stringify(statement), /private to the docs|INTL-002/);
});

test('every language has a record that holds up, with the state recorded for it', () => {
  const namespaces = readdirSync(join(LOCALES, 'en')).map((name) => name.replace(/\.json$/, ''));
  for (const tag of languageDirectories()) {
    const raw = metadata(tag) as { status: string };
    const review = readLocaleReview(tag, raw);
    assert.equal(review.status, raw.status, `${tag}.meta.json must hold up as recorded`);
    assert.ok(review.package, `${tag}.meta.json names its package`);
    if (tag === 'en') assert.equal(shownStatus(review, namespaces), 'reference');
    else assert.notEqual(review.status, 'reference', tag);
  }
  // Nobody has reviewed these yet (ADR 012 decision 30); a pull request with a named reviewer changes this list.
  for (const tag of ['uz-Latn', 'ka', 'hy', 'az-Latn', 'es', 'ru']) assert.equal(readLocaleReview(tag, metadata(tag)).status, 'machine_draft', tag);
});

test('the review labels exist in every engine language, and no Russian was added', () => {
  const read = (tag: string) => (JSON.parse(readFileSync(join(LOCALES, tag, 'translations.json'), 'utf8')) as { translations: { status: Record<string, { label: string; description: string }> } }).translations;
  const english = read('en');
  for (const tag of ENGINE_LANGUAGES) {
    const { status } = read(tag);
    assert.deepEqual(Object.keys(status).sort(), [...REVIEW_STATUSES].sort(), tag);
    assert.equal(new Set(REVIEW_STATUSES.map((name) => status[name]!.label)).size, REVIEW_STATUSES.length, `${tag}: four different labels`);
    for (const name of REVIEW_STATUSES) {
      assert.ok(status[name]!.label.trim() && status[name]!.description.trim(), `${tag} ${name}`);
      if (tag === 'en') continue;
      assert.notEqual(status[name]!.label, english.status[name]!.label, `${tag} ${name}: the label is translated`);
      assert.notEqual(status[name]!.description, english.status[name]!.description, `${tag} ${name}: the description is translated`);
    }
    if (tag === 'ka' || tag === 'hy') assert.doesNotMatch(JSON.stringify(read(tag)).replace(/"[a-zA-Z_]+":/g, '').replace(/\{[a-z]+\}/g, ''), /[A-Za-z]/, `${tag} has no Latin words`);
  }
  assert.throws(() => statSync(join(LOCALES, 'ru', 'translations.json')), 'Russian is not maintained (ADR 009 decision 11)');
});

test('the printed table is the table of the localization chapter', () => {
  const chapter = readFileSync(join(REPO, 'docs/engine/localization.md'), 'utf8');
  assert.equal(script.chapterTable(chapter), script.languagesTable());
  for (const tag of languageDirectories()) assert.ok(script.languagesTable().includes(`| \`${tag}\` |`), `${tag} is in the table`);
});

test('the script reads a language without metadata as a machine draft, and a review with its record', () => {
  const root = mkdtempSync(join(tmpdir(), 'trustwork-locale-status-'));
  try {
    const write = (path: string, content: unknown) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), JSON.stringify(content));
    };
    write('en/translations.json', JSON.parse(readFileSync(join(LOCALES, 'en/translations.json'), 'utf8')));
    write('en/core.json', {});
    write('en/public.json', {});
    write('en.meta.json', { status: 'reference' });
    write('xx/core.json', {});
    write('ka/core.json', {});
    write('ka.meta.json', reviewed);
    write('hy/core.json', {});
    write('hy.meta.json', { ...reviewed, reviewers: [{ handle: 'a-reviewer', consent: false }] });
    const rows = script.languagesTable(root).split('\n');
    const row = (tag: string) => rows.find((line) => line.startsWith(`| \`${tag}\` |`))!;
    assert.match(row('xx'), /\| Machine draft \| — \|/);
    assert.match(row('hy'), /\| Machine draft \| — \|/);
    assert.doesNotMatch(row('hy'), /a-reviewer/, 'a handle without consent is never printed');
    assert.match(row('en'), /\| Reference \|/);
    assert.match(row('ka'), /\| Machine draft \| `a-reviewer`, 2026-12-01, `core`, `public`, \[review\]\(https:\/\/example\.org\/review\/1\) \|/, 'translations is a namespace the review left out');
    write('ka.meta.json', { ...reviewed, namespaces: ['core', 'public', 'translations'] });
    assert.match(script.languagesTable(root).split('\n').find((line) => line.startsWith('| `ka` |'))!, /\| Native reviewed \|/);
    assert.equal(script.languagesStatement(root).locales.find((entry) => entry.tag === 'xx')?.status, 'machine_draft');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the server reads a deployment record first and claims nothing for one that fails', async () => {
  const data = mkdtempSync(join(tmpdir(), 'trustwork-locale-review-'));
  mkdirSync(join(data, 'locales'), { recursive: true });
  const previous = process.env.TRUSTWORK_DATA_DIR;
  process.env.TRUSTWORK_DATA_DIR = data;
  try {
    type Review = { localeReview(tag: string): LocaleReview; reviewStatusOf(tag: string): string; localeReviewStatement(tags: readonly string[]): LocaleReviewStatement };
    // Loaded at run time, after the environment names the data directory; the path keeps it outside the root type check.
    const { appNamespaces } = (await import(new URL('../../../apps/web/app/_lib/locale-data.ts', import.meta.url).href)) as { appNamespaces(): string[] };
    const write = (tag: string, body: string) => writeFileSync(join(data, 'locales', `${tag}.meta.json`), body);
    write('ka', JSON.stringify({ ...reviewed, namespaces: appNamespaces() }));
    write('hy', JSON.stringify({ status: 'native_reviewed' }));
    write('az-Latn', '{ not json');
    write('es', JSON.stringify({ status: 'reference' }));
    const server = (await import(new URL('../../../apps/web/components/locale/review.ts', import.meta.url).href)) as Review;
    assert.equal(server.reviewStatusOf('ka'), 'native_reviewed', 'the deployment record replaces the built-in one');
    assert.equal(server.reviewStatusOf('hy'), 'machine_draft', 'a claim without evidence');
    assert.equal(server.reviewStatusOf('az-Latn'), 'machine_draft', 'a file that does not parse');
    assert.equal(server.reviewStatusOf('es'), 'machine_draft', 'only English is the reference');
    assert.equal(server.reviewStatusOf('xx-no-record'), 'machine_draft', 'no file at all');
    assert.equal(server.reviewStatusOf('en'), 'reference', 'the built-in record is used when the deployment has none');
    assert.deepEqual(server.localeReviewStatement(['en', 'xx-no-record']).locales.map((entry) => entry.status), ['reference', 'machine_draft']);
  } finally {
    if (previous === undefined) delete process.env.TRUSTWORK_DATA_DIR;
    else process.env.TRUSTWORK_DATA_DIR = previous;
    rmSync(data, { recursive: true, force: true });
  }
});
