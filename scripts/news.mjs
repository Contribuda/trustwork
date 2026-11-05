/**
 * News: what changed in Trustwork over a period, read from git history alone (no network unless --fetch).
 *
 *   npm run news                              the last 14 days on origin/main (or HEAD when there is no origin/main)
 *   npm run news -- --since "30 days ago"     any period git understands ("2026-11-01", "1 week ago")
 *   npm run news -- --fetch                   run `git fetch origin` first, so the news is current
 *   npm run news -- --ref main --json         another branch; machine-readable output for agents
 *
 * It reports: work packages whose status changed (from docs/engine/work-packages.json at the start and the end of the
 * period), merged changes grouped by work package, decisions (ADRs added or changed), changes to what is live
 * (docs/engine/status.md) and changes to the Trustwork Book (docs/book). Open pull requests and claims are on GitHub:
 * `gh pr list` and `npm run claims -- status`.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

if (args.includes('--fetch')) tryGit('fetch', '--quiet', 'origin');
const ref = option('--ref', tryGit('rev-parse', '--verify', '--quiet', 'origin/main') ? 'origin/main' : 'HEAD');
const since = option('--since', '14 days ago');
const json = args.includes('--json');

const lines = (out) => (out ? out.split('\n').filter(Boolean) : []);
const commits = lines(git('log', ref, `--since=${since}`, '--no-merges', '--format=%h%x09%cs%x09%s')).map((l) => {
  const [sha, date, subject] = l.split('\t');
  const ids = [...new Set([...subject.matchAll(/\b([A-Z][A-Z0-9]*-(?:\d{3}|[A-Z]{2,3}))\b/g)].map((m) => m[1]))];
  return { sha, date, subject, ids };
});

const WP = 'docs/engine/work-packages.json';
const packagesAt = (rev) => { const text = rev ? tryGit('show', `${rev}:${WP}`) : ''; try { return text ? JSON.parse(text).packages : []; } catch { return []; } };
const base = tryGit('rev-list', '-1', `--before=${since}`, ref);
const before = new Map(packagesAt(base).map((p) => [p.id, p]));
const now = packagesAt(ref);
const titles = new Map(now.map((p) => [p.id, p.title]));
const statusChanges = now.filter((p) => before.get(p.id)?.status !== p.status).map((p) => ({ id: p.id, title: p.title, from: before.get(p.id)?.status ?? 'new', to: p.status }));
const counts = now.reduce((c, p) => ({ ...c, [p.status]: (c[p.status] || 0) + 1 }), {});

const byPackage = new Map();
for (const c of commits) for (const id of c.ids.length ? c.ids : ['(no package)']) byPackage.set(id, [...(byPackage.get(id) || []), c]);

const touched = (path) => lines(git('log', ref, `--since=${since}`, '--no-merges', '--format=%cs%x09%s', '--', path)).map((l) => { const [date, subject] = l.split('\t'); return { date, subject }; });
const adrFiles = [...new Set(lines(git('log', ref, `--since=${since}`, '--no-merges', '--name-only', '--format=', '--', 'docs/adr')).filter((f) => /\/\d{3}-.*\.md$/.test(f)))].sort();
const firstHeading = (file) => { const text = tryGit('show', `${ref}:${file}`); return (text.match(/^#\s+(.+)$/m) || [null, file])[1]; };
const adrs = adrFiles.map((file) => ({ file, title: firstHeading(file), added: !tryGit('cat-file', '-e', `${base}:${file}`) && !!base }));

const news = {
  ref, since, head: tryGit('rev-parse', '--short', ref), commits: commits.length,
  workPackages: { counts, statusChanges },
  byPackage: [...byPackage].sort((a, b) => b[1].length - a[1].length).map(([id, list]) => ({ id, title: titles.get(id) ?? null, changes: list.map((c) => `${c.date} ${c.subject}`) })),
  decisions: adrs,
  status: touched('docs/engine/status.md'),
  book: touched('docs/book'),
};

if (json) {
  console.log(JSON.stringify(news, null, 2));
} else {
  const out = [];
  out.push(`Trustwork news on ${ref} at ${news.head}, since ${since}: ${news.commits} changes.`);
  out.push(`Work packages now: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ')}.`);
  if (statusChanges.length) {
    out.push('', 'Work packages that moved:');
    for (const order of ['done', 'in_review', 'in_progress', 'open', 'blocked', 'rejected']) for (const c of statusChanges.filter((x) => x.to === order)) out.push(`  ${c.id} ${c.from} -> ${c.to}: ${c.title}`);
  }
  if (adrs.length) { out.push('', 'Decisions (ADRs) added or changed:'); for (const a of adrs) out.push(`  ${a.added ? 'new ' : ''}${a.file}: ${a.title}`); }
  if (news.status.length) { out.push('', 'Changes to what is live (docs/engine/status.md):'); for (const s of news.status.slice(0, 15)) out.push(`  ${s.date} ${s.subject}`); }
  if (news.book.length) { out.push('', 'Changes to the Trustwork Book:'); for (const s of news.book) out.push(`  ${s.date} ${s.subject}`); }
  out.push('', 'Changes by work package:');
  for (const p of news.byPackage.slice(0, 25)) {
    out.push(`  ${p.id}${p.title ? ` (${p.title})` : ''}: ${p.changes.length}`);
    for (const c of p.changes.slice(0, 3)) out.push(`    ${c}`);
  }
  if (news.byPackage.length > 25) out.push(`  ... and ${news.byPackage.length - 25} more packages (use --json for all).`);
  out.push('', 'Open pull requests and active claims live on GitHub: gh pr list; npm run claims -- status.');
  console.log(out.join('\n'));
}
