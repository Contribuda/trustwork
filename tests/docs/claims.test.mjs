import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { applyActions, BOT_LOGIN, checkPullRequest, githubClient, loadIssues, overlaps, packageIdFromTitle, parseAgent, parseCommand, readMarkers, reconcile } from '../../scripts/claims.mjs';
import { load } from '../../scripts/work-packages.mjs';

// Synthetic packages: AAA-001 done; BBB-001 and CCC-001 open and available; DDD-001 waits for BBB-001;
// EEE-001 owns a path nested in CCC-001's paths; FFF/GGG/HHH-001 are available for the per-person limit.
const pkg = (id, paths, { status = 'open', dependsOn = [] } = {}) => ({ id, title: id, area: 'x', status, dependsOn, handbook: 'docs/engine/README.md', goal: 'g', read: [], steps: ['s'], acceptance: ['a'], paths });
const packages = {
  schemaVersion: 1,
  packages: [
    pkg('AAA-001', ['apps/a'], { status: 'done' }),
    pkg('BBB-001', ['apps/b', 'tests/b'], { dependsOn: ['AAA-001'] }),
    pkg('CCC-001', ['packages/c']),
    pkg('DDD-001', ['apps/d'], { dependsOn: ['BBB-001'] }),
    pkg('EEE-001', ['packages/c/nested']),
    pkg('FFF-001', ['apps/f']),
    pkg('GGG-001', ['apps/g']),
    pkg('HHH-001', ['apps/h']),
  ],
};
const T0 = Date.parse('2026-11-02T10:00:00Z');
const DAY = 86_400_000;
const at = (days) => new Date(T0 + days * DAY).toISOString();
let nextId = 1000;
const comment = (author, body, days = 0, association = 'NONE') => ({ id: nextId++, author, association, body, createdAt: at(days) });
const claimBody = (id, human, { scope = null, until = '2026-11-08', agent = 'Codex (gpt-5)', plan = ['Write the schema', 'Add tests'] } = {}) =>
  [`Agent: ${agent} for ${human}`, `/claim ${id}`, `human: ${human}`, `scope: ${(scope ?? packages.packages.find((p) => p.id === id).paths).join(', ')}`, `until: ${until}`, 'plan:', ...plan.map((s) => `- ${s}`)].join('\n');
const issue = (number, id, comments = [], extra = {}) => ({ number, title: `[WP ${id}] ${id}`, labels: ['work-package'], assignees: [], comments, ...extra });

/** Runs reconcile and folds its comments back into the issues as bot comments, as GitHub would after applyActions. */
function step(issues, now) {
  const result = reconcile({ issues, packages, now });
  for (const a of result.actions.filter((x) => x.type === 'comment')) issues.find((i) => i.number === a.issue).comments.push({ id: nextId++, author: BOT_LOGIN, association: 'NONE', body: a.body, createdAt: new Date(now).toISOString() });
  for (const a of result.actions.filter((x) => x.type === 'labels')) { const i = issues.find((x) => x.number === a.issue); i.labels = [...i.labels.filter((l) => !a.remove.includes(l)), ...a.add]; }
  for (const a of result.actions.filter((x) => x.type === 'assignees')) { const i = issues.find((x) => x.number === a.issue); i.assignees = [...i.assignees.filter((l) => !a.remove.includes(l)), ...a.add]; }
  return result;
}
const lastBot = (i) => i.comments.filter((c) => c.author === BOT_LOGIN).at(-1);
const records = (i) => i.comments.filter((c) => c.author === BOT_LOGIN).flatMap((c) => readMarkers(c.body));

test('parses claim blocks, agent lines, fences, list scopes and ignores look-alike commands', () => {
  const parsed = parseCommand(['Agent: Claude Code (opus) for octocat', '```text', '/claim bbb-001', 'Human: @octocat', 'scope:', '- `apps/b/`', '- ./tests/b', 'until: 2026-11-08', 'plan:', '1. one', '2. two', '```'].join('\r\n'));
  assert.equal(parsed.command, 'claim');
  assert.equal(parsed.id, 'BBB-001');
  assert.equal(parsed.fields.human, '@octocat');
  assert.deepEqual(parsed.fields.scope, ['apps/b', 'tests/b']);
  assert.deepEqual(parsed.fields.plan, ['one', 'two']);
  assert.deepEqual(parseAgent(parsed.fields.agent), { agent: 'Claude Code (opus)', forHuman: 'octocat' });
  assert.equal(parseCommand('I /claim nothing here\n> /claim BBB-001'), null);
  assert.equal(parseCommand('/claimed BBB-001'), null);
  assert.equal(parseCommand('/heartbeat BBB-001 schema done').note, 'schema done');
  assert.equal(packageIdFromTitle('[WP INTL-UZ] Uzbekistan'), 'INTL-UZ');
  assert.ok(overlaps('packages/c', 'packages/c/nested') && !overlaps('packages/c', 'packages/cc'));
});

test('a valid claim is accepted, recorded, labelled and assigned; the next run has nothing to do', () => {
  const issues = [issue(2, 'BBB-001', [comment('octocat', claimBody('BBB-001', 'octocat'))], { labels: ['work-package', 'ready-to-claim'] })];
  const result = step(issues, T0 + 60_000);
  assert.equal(result.claims.length, 1);
  assert.match(lastBot(issues[0]).body, /Claim accepted/);
  assert.deepEqual(records(issues[0])[0].scope, ['apps/b', 'tests/b']);
  assert.deepEqual(issues[0].labels, ['work-package', 'claimed']);
  assert.deepEqual(issues[0].assignees, ['octocat']);
  assert.deepEqual(step(issues, T0 + 120_000).actions, []);
});

test('first valid claim wins; later claims are rejected with the reason, and order is by comment time not run time', () => {
  const second = comment('bob', claimBody('BBB-001', 'bob'), 0.01);
  const first = comment('alice', claimBody('BBB-001', 'alice'), 0);
  const issues = [issue(2, 'BBB-001', [second, first])];
  const result = step(issues, T0 + DAY / 2);
  assert.equal(result.claims[0].human, 'alice');
  const replies = issues[0].comments.filter((c) => c.author === BOT_LOGIN).map((c) => c.body);
  assert.match(replies[0], /Claim accepted/);
  assert.match(replies[1], /not recorded[\s\S]*already claimed by `alice`/);
});

test('claims are rejected for the wrong issue, unfinished dependencies, done packages, bad scope, until and missing fields', () => {
  const cases = [
    [issue(3, 'CCC-001', [comment('a', claimBody('BBB-001', 'a'))]), /this issue is for `CCC-001`/],
    [issue(4, 'DDD-001', [comment('a', claimBody('DDD-001', 'a'))]), /dependencies not done yet: `BBB-001`/],
    [issue(1, 'AAA-001', [comment('a', claimBody('AAA-001', 'a'))]), /status is `done`/],
    [issue(2, 'BBB-001', [comment('a', claimBody('BBB-001', 'a', { scope: ['apps/b', 'packages/contracts'] }))]), /`packages\/contracts` is outside the package paths/],
    [issue(2, 'BBB-001', [comment('a', claimBody('BBB-001', 'a', { scope: ['apps/b/../x'] }))]), /invalid path/],
    [issue(2, 'BBB-001', [comment('a', claimBody('BBB-001', 'a', { until: '2026-11-20' }))]), /at most 7 days ahead/],
    [issue(2, 'BBB-001', [comment('a', claimBody('BBB-001', 'a', { until: '2026-02-30' }))]), /YYYY-MM-DD/],
    [issue(2, 'BBB-001', [comment('a', claimBody('BBB-001', 'a', { plan: [] }))]), /add `plan:`/],
    [issue(2, 'BBB-001', [comment('a', '/claim BBB-001\nscope: apps/b\nuntil: 2026-11-05\nplan:\n- x')]), /add `human:[\s\S]*add `agent:/],
    [issue(2, 'BBB-001', [comment('a', claimBody('BBB-001', 'a', { agent: '<tool and model>' }))]), /replace the template placeholders/],
    [issue(2, 'BBB-001', [comment('a', claimBody('BBB-001', 'a').replace('for a', 'for someone-else'))]), /agent line names `someone-else`/],
  ];
  for (const [i, reason] of cases) {
    const result = step([i], T0 + 1000);
    assert.equal(result.claims.length, 0, String(reason));
    assert.match(lastBot(i).body, reason);
    assert.match(lastBot(i).body, /Nothing changed/);
  }
});

test('nobody can claim in another person\'s name, but a maintainer can claim on someone\'s behalf', () => {
  const impostor = issue(2, 'BBB-001', [comment('mallory', claimBody('BBB-001', 'alice'))]);
  step([impostor], T0 + 1000);
  assert.match(lastBot(impostor).body, /post the claim from the accountable person's account/);
  const behalf = issue(2, 'BBB-001', [comment('maintainer', claimBody('BBB-001', 'alice'), 0, 'OWNER')]);
  const result = step([behalf], T0 + 1000);
  assert.equal(result.claims[0].human, 'alice');
});

test('heartbeats extend the claim; only the claimant or a maintainer may heartbeat or release', () => {
  const i = issue(2, 'BBB-001', [comment('alice', claimBody('BBB-001', 'alice'))]);
  step([i], T0 + 1000);
  i.comments.push(comment('bob', '/heartbeat BBB-001 progress', 1));
  i.comments.push(comment('bob', '/release BBB-001 mine now', 1.1));
  i.comments.push(comment('alice', '/heartbeat BBB-001', 1.2));
  i.comments.push(comment('alice', 'Agent: Codex for alice\n/heartbeat BBB-001 schema merged\nuntil: 2026-11-12', 6));
  const result = step([i], T0 + 6.5 * DAY);
  const replies = i.comments.filter((c) => c.author === BOT_LOGIN).map((c) => c.body);
  assert.match(replies[1], /only `alice`, the claim's author or a maintainer can heartbeat/);
  assert.match(replies[2], /only `alice`.*can release/);
  assert.match(replies[3], /add a short progress note/);
  assert.match(replies[4], /Heartbeat recorded[\s\S]*2026-11-15 10:00 UTC; planned finish 2026-11-12/);
  assert.equal(result.claims[0].expiresAt, '2026-11-15T10:00:00.000Z');
  assert.equal(result.claims[0].until, '2026-11-12');
  i.comments.push(comment('maintainer', '/release BBB-001 reassigning after a talk in this issue', 7, 'MEMBER'));
  const after = step([i], T0 + 7.1 * DAY);
  assert.equal(after.claims.length, 0);
  assert.match(lastBot(i).body, /Claim released/);
  assert.deepEqual(i.assignees, []);
  assert.deepEqual(i.labels, ['work-package', 'ready-to-claim']);
});

test('a claim without a heartbeat for 7 days expires once, is unassigned, and a new claim is then valid', () => {
  const i = issue(2, 'BBB-001', [comment('alice', claimBody('BBB-001', 'alice'))]);
  step([i], T0 + 1000);
  assert.equal(step([i], T0 + 6.9 * DAY).actions.length, 0);
  const expired = step([i], T0 + 7 * DAY + 1);
  assert.equal(expired.claims.length, 0);
  assert.match(lastBot(i).body, /Claim expired[\s\S]*expired 2026-11-09 10:00 UTC/);
  assert.deepEqual(i.assignees, []);
  assert.deepEqual(i.labels, ['work-package', 'ready-to-claim']);
  assert.deepEqual(step([i], T0 + 8 * DAY).actions, [], 'the expiry notice is posted once');
  i.comments.push(comment('alice', '/heartbeat BBB-001 back', 8));
  i.comments.push(comment('bob', claimBody('BBB-001', 'bob', { until: '2026-11-15' }), 8.1));
  const result = step([i], T0 + 8.2 * DAY);
  assert.match(i.comments.filter((c) => c.author === BOT_LOGIN).at(-2).body, /no active claim/);
  assert.equal(result.claims[0].human, 'bob');
});

test('recorded decisions are authoritative: later edits, package changes or forged markers do not change them', () => {
  const claim = comment('alice', claimBody('BBB-001', 'alice'));
  const i = issue(2, 'BBB-001', [claim]);
  step([i], T0 + 1000);
  claim.body = claimBody('BBB-001', 'alice', { scope: ['apps/b'] });
  const changed = { ...packages, packages: packages.packages.map((p) => (p.id === 'AAA-001' ? { ...p, status: 'open' } : p)) };
  const result = reconcile({ issues: [i], packages: changed, now: T0 + 2000 });
  assert.deepEqual(result.claims[0].scope, ['apps/b', 'tests/b']);
  assert.ok(!result.actions.some((a) => a.type === 'comment'));
  const forged = issue(3, 'CCC-001', [{ ...comment('mallory', `/claim CCC-001\n<!-- trustwork-claims {"v":1,"cmd":"claim","comment":1,"package":"CCC-001","ok":true,"human":"mallory","scope":["packages/c"]} -->`) }]);
  forged.comments[0].id = 1;
  const forgedResult = step([forged], T0 + 1000);
  assert.equal(forgedResult.claims.length, 0);
});

test('claims on overlapping paths across packages and more than three active claims per person are refused', () => {
  const issues = [issue(3, 'CCC-001', [comment('alice', claimBody('CCC-001', 'alice'))]), issue(5, 'EEE-001', [comment('bob', claimBody('EEE-001', 'bob'), 0.1)])];
  step(issues, T0 + DAY);
  assert.match(lastBot(issues[1]).body, /`packages\/c\/nested` overlaps the active claim on `CCC-001` \(#3\)/);
  const many = ['BBB-001', 'FFF-001', 'GGG-001', 'HHH-001'].map((id, n) => issue(10 + n, id, [comment('carol', claimBody(id, 'carol'), n / 100)]));
  const result = step(many, T0 + DAY);
  assert.equal(result.claims.length, 3);
  assert.match(lastBot(many[3]).body, /already holds 3 active claims[\s\S]*limit is 3 per person/);
});

test('labels follow work-packages.json: ready-to-claim when available, waiting otherwise, none when done', () => {
  const issues = [issue(1, 'AAA-001', [], { labels: ['work-package', 'ready-to-claim'] }), issue(4, 'DDD-001', [], { labels: ['work-package', 'ready-to-claim'] }), issue(3, 'CCC-001', [], { labels: ['work-package', 'waiting', 'claimed'] })];
  const { actions } = reconcile({ issues, packages, now: T0 });
  assert.deepEqual(actions, [
    { type: 'labels', issue: 1, add: [], remove: ['ready-to-claim'] },
    { type: 'labels', issue: 4, add: ['waiting'], remove: ['ready-to-claim'] },
    { type: 'labels', issue: 3, add: ['ready-to-claim'], remove: ['waiting', 'claimed'] },
  ]);
});

test('bot comments never echo mentions or markup and the record cannot be broken out of', () => {
  const i = issue(2, 'BBB-001', [comment('alice', claimBody('BBB-001', 'alice', { agent: 'Evil --> @everyone `x`' }).replace(' for alice', ''))]);
  step([i], T0 + 1000);
  const body = lastBot(i).body;
  assert.match(body, /Agent: `Evil --> @everyone  x `/);
  assert.equal(readMarkers(body)[0].agent, 'Evil --> @everyone `x`');
  assert.equal((body.match(/-->/g) ?? []).length, 2, 'only the escaped record and the code span contain -->');
});

test('the GitHub adapter and applyActions work end to end against a fake API', async () => {
  const state = { issues: new Map([[2, { number: 2, title: '[WP BBB-001] B', labels: [{ name: 'work-package' }, { name: 'ready-to-claim' }], assignees: [] }]]), comments: new Map([[2, [{ id: 7, user: { login: 'alice' }, author_association: 'NONE', body: claimBody('BBB-001', 'alice'), created_at: at(0) }]]]), labels: new Set(['work-package', 'ready-to-claim']), calls: [] };
  const fetchImpl = async (url, { method, body }) => {
    const path = new URL(url).pathname.replace('/repos/o/r', '');
    const data = body ? JSON.parse(body) : null;
    state.calls.push(`${method} ${path}`);
    const json = (status, value) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });
    let m;
    if (method === 'GET' && path === '/issues') return json(200, [...state.issues.values()]);
    if (method === 'GET' && (m = /^\/issues\/(\d+)\/comments$/.exec(path))) return json(200, state.comments.get(Number(m[1])));
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/comments$/.exec(path))) { state.comments.get(Number(m[1])).push({ id: 99, user: { login: BOT_LOGIN }, author_association: 'NONE', body: data.body, created_at: at(0.01) }); return json(201, {}); }
    if (method === 'GET' && (m = /^\/labels\/(.+)$/.exec(path))) return state.labels.has(decodeURIComponent(m[1])) ? json(200, {}) : json(404, {});
    if (method === 'POST' && path === '/labels') { state.labels.add(data.name); return json(201, {}); }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/labels$/.exec(path))) { state.issues.get(Number(m[1])).labels.push(...data.labels.map((name) => ({ name }))); return json(200, []); }
    if (method === 'DELETE' && (m = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(path))) { const i = state.issues.get(Number(m[1])); i.labels = i.labels.filter((l) => l.name !== decodeURIComponent(m[2])); return json(200, []); }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/assignees$/.exec(path))) { const i = state.issues.get(Number(m[1])); i.assignees.push(...data.assignees.map((login) => ({ login }))); return json(201, { assignees: i.assignees }); }
    return json(500, { message: `unexpected ${method} ${path}` });
  };
  const client = githubClient({ token: 't', repo: 'o/r', fetchImpl, api: 'https://api.test' });
  const issues = await loadIssues(client);
  const { actions } = reconcile({ issues, packages, now: T0 + 1000 });
  const failures = await applyActions(client, actions, () => {});
  assert.deepEqual(failures, []);
  assert.ok(state.labels.has('claimed'), 'the claimed label is created when missing');
  assert.deepEqual(state.issues.get(2).labels.map((l) => l.name), ['work-package', 'claimed']);
  assert.deepEqual(state.issues.get(2).assignees.map((a) => a.login), ['alice']);
  const again = reconcile({ issues: await loadIssues(client), packages, now: T0 + 2000 });
  assert.deepEqual(again.actions, []);
  assert.throws(() => githubClient({ repo: 'not a repo' }), /owner\/name/);
});

const goodBody = (extra = '') => `## What changed

Adds the claims bot.

## Why

Work package: none · issue #12
Contributors need automation.

## How it was verified

- [x] \`npm run check\` at the head commit \`3f2a9c1\`: exit 0, 412 tests passed
- [ ] Focused tests

## Made with an AI agent?

- [ ] No: no AI agent wrote any part of this change
- [x] Yes: the accountable human reviewed every change and signs off below

Agent: Claude Code (claude-opus-5) for octocat
${extra}
## Sign-off

- [x] Every commit carries \`Signed-off-by\` of the accountable human (DCO)
`;

test('the pull request check accepts a complete description and explains every gap', () => {
  assert.deepEqual(checkPullRequest({ body: goodBody(), author: 'octocat', packages }), { errors: [], warnings: [] });
  const template = readFileSync(new URL('../../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
  const errors = checkPullRequest({ body: template, author: 'octocat', packages }).errors.join('\n');
  for (const expected of [/"What changed" is empty/, /"Why" is empty/, /tick the `npm run check` box/, /commit SHA/, /paste results/, /exactly one of "No" or "Yes"/, /tick the DCO box/]) assert.match(errors, expected);
  const noAgent = goodBody().replace('- [x] Yes', '- [ ] Yes').replace('- [ ] No', '- [x] No');
  assert.match(checkPullRequest({ body: noAgent, author: 'octocat', packages }).errors.join('\n'), /"No" is ticked but an Agent line is filled in/);
  assert.deepEqual(checkPullRequest({ body: noAgent.replace(/Agent: .*/, 'Agent: <tool and model> for <human handle>'), author: 'octocat', packages }).errors, []);
  assert.match(checkPullRequest({ body: goodBody().replace(/Agent: .*/, 'Agent: <tool and model> for <human handle>'), author: 'octocat', packages }).errors.join('\n'), /fill in `Agent:/);
  assert.match(checkPullRequest({ body: goodBody(), author: 'someone', packages }).warnings.join('\n'), /names octocat, the pull request is opened by someone/);
  assert.deepEqual(checkPullRequest({ body: '', author: 'dependabot[bot]', packages }).errors, []);
});

test('a pull request that changes a package\'s paths must name the package, or say "Work package: none" with an issue', () => {
  const touching = { author: 'octocat', packages, changedFiles: ['apps/b/x.ts', 'apps/a/old.ts', 'README.md'] };
  const withoutEscape = goodBody().replace('Work package: none · issue #12', 'Implements it.');
  assert.match(checkPullRequest({ ...touching, body: withoutEscape }).errors.join('\n'), /1 changed file\(s\) belong to BBB-001 \(for example apps\/b\/x.ts\)/);
  assert.deepEqual(checkPullRequest({ ...touching, body: withoutEscape.replace('Implements it.', 'Work package: `BBB-001` · issue #2') }).errors, []);
  const escape = checkPullRequest({ ...touching, body: goodBody() });
  assert.deepEqual(escape.errors, []);
  assert.match(escape.warnings.join('\n'), /maintainer must confirm/);
  assert.deepEqual(checkPullRequest({ ...touching, changedFiles: ['packages/c/nested/x.ts'], body: withoutEscape.replace('Implements it.', 'Part of EEE-001') }).errors, [], 'naming any owning package is enough');
});

test('agent-facing workflows pin actions by SHA, keep minimal permissions and never interpolate comment text into a shell', () => {
  const dir = new URL('../../.github/workflows/', import.meta.url);
  for (const name of readdirSync(dir)) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    for (const m of text.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${name}: ${m[1]} must be pinned by commit SHA`);
    assert.doesNotMatch(text, /\$\{\{\s*github\.event\.(comment|issue|pull_request)\.(body|title)/, `${name} must read untrusted text from the event file`);
    assert.doesNotMatch(text, /pull_request_target/, `${name} must not run untrusted code with write tokens`);
  }
  const claims = readFileSync(new URL('claims.yml', dir), 'utf8');
  assert.match(claims, /permissions:\n {2}contents: read\n {2}issues: write\nconcurrency:/);
  assert.match(readFileSync(new URL('pull-request.yml', dir), 'utf8'), /permissions:\n {2}contents: read\nconcurrency:/);
});

test('every package in the real work-packages.json can be claimed with its own paths as scope', () => {
  const real = load();
  for (const p of real.packages.filter((x) => x.paths.length)) {
    const parsed = parseCommand(claimBody(p.id, 'octocat', { scope: p.paths }).replace(/until: .*/, 'until: 2026-11-05'));
    assert.deepEqual(parsed.fields.scope, p.paths, p.id);
  }
});
