// node:test reporter that stays silent while tests run and, at the end, prints every skipped test with its file
// and reason. scripts/run-tests.mjs adds it next to the spec reporter (destination stderr) so a run that
// "passes" with skipped database suites says so loudly. CI sets TRUSTWORK_REQUIRE_PG=1, which turns those
// skips into failures (tests/data/helpers/postgres.ts).
import { relative } from 'node:path';

const DATABASE_SKIP = /no PostgreSQL/;

export function formatSkipSummary(skips, cwd = process.cwd()) {
  if (!skips.length) return '';
  const lines = [`\nSKIPPED: ${skips.length} test${skips.length === 1 ? '' : 's'} did not run (a skip counts as success):`];
  for (const skip of skips) {
    const where = skip.file ? `${relative(cwd, skip.file)}` : '(unknown file)';
    lines.push(`  - ${where}: ${skip.name}${typeof skip.reason === 'string' ? ` [${skip.reason}]` : ''}`);
  }
  if (skips.some((skip) => DATABASE_SKIP.test(String(skip.reason)))) {
    lines.push('Database suites were skipped: start PostgreSQL (`npm run infra:up`) or set TRUSTWORK_TEST_DATABASE_URL.');
    lines.push('Set TRUSTWORK_REQUIRE_PG=1 to make a missing database fail the run, as CI does.');
  }
  return `${lines.join('\n')}\n`;
}

export default async function* skipSummaryReporter(source) {
  const skips = [];
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { data } = event;
    if (data.skip === undefined || data.skip === false) continue;
    skips.push({ name: data.name, file: data.file, reason: data.skip });
  }
  const summary = formatSkipSummary(skips);
  if (summary) yield summary;
}
