/**
 * Claims bot and contribution checks for work packages (docs/engine/agent-onboarding.md, section 5).
 *
 *   node scripts/claims.mjs lint [file|-] [--at <ISO time>]   check a /claim, /heartbeat or /release comment before posting it
 *   node scripts/claims.mjs status [--repo owner/name] [--json]  active claims across work package issues (read-only)
 *   node scripts/claims.mjs run [--repo owner/name] [--dry-run]  reconcile claims, labels and assignees (the claims workflow)
 *   node scripts/claims.mjs pr --event <file> [--base <sha> --head <sha>]  check a pull request description (the pull request workflow)
 *
 * The ledger is the work package issue itself. People and agents post commands as comments; the bot answers each
 * command once, and its answer carries a machine-readable record of the decision. Replaying an issue's comments in
 * order therefore always yields the same claims: recorded decisions are authoritative, unanswered commands are judged
 * against docs/engine/work-packages.json at the time they were posted, and a claim expires seven days after its last
 * claim or heartbeat. The bot only comments, labels and assigns; status changes in work-packages.json land in pull
 * requests that maintainers review and merge.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as loadWorkPackages, validPath } from './work-packages.mjs';

export const CLAIM_TTL_DAYS = 7;
export const HEARTBEAT_DAYS = 3;
export const MAX_ACTIVE_CLAIMS_PER_HUMAN = 3;
/** A maintainer claiming for themselves (for example while conducting a coordinated wave of agents) may hold more. */
export const MAX_ACTIVE_CLAIMS_PER_MAINTAINER = 20;
export const BOT_LOGIN = 'github-actions[bot]';
export const LABELS = {
  claimed: { name: 'claimed', color: 'FBCA04', description: 'A valid claim is active; see the latest claims bot comment' },
  ready: { name: 'ready-to-claim', color: '2DA44E', description: 'Every dependency is done; claim it with /claim' },
  waiting: { name: 'waiting', color: 'BFBFBF', description: 'Waiting for dependencies' },
};
const MANAGED_LABELS = Object.values(LABELS).map((l) => l.name);
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
/**
 * Handles named in .github/CODEOWNERS are maintainers too: GitHub reports a private organization member's comments
 * as CONTRIBUTOR or NONE to the Actions token, so the association alone misses them.
 */
export const CODEOWNER_HANDLES = (() => {
  try {
    const text = readFileSync(resolve(process.cwd(), '.github/CODEOWNERS'), 'utf8');
    return new Set([...text.matchAll(/@([A-Za-z0-9-]+)(?!\/)/g)].map((m) => m[1].toLowerCase()));
  } catch { return new Set(); }
})();
const isMaintainer = (author, association) => MAINTAINER_ASSOCIATIONS.has(association) || CODEOWNER_HANDLES.has(String(author ?? '').toLowerCase());
const DAY = 24 * 60 * 60 * 1000;
const MARKER = 'trustwork-claims';
const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const PACKAGE_ID = /\b(ADM-UX-\d{3}|[A-Z][A-Z0-9]*-(?:\d{3}|[A-Z]{2,3}))\b/g;
const LIST_KEYS = new Set(['scope', 'plan']);
const KEYS = new Set(['human', 'agent', 'scope', 'until', 'plan']);

const root = resolve(new URL('..', import.meta.url).pathname);
const lower = (s) => String(s ?? '').toLowerCase();
const day = (time) => new Date(time).toISOString().slice(0, 10);
const isoMinute = (time) => new Date(time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
/** Text echoed from a comment into a bot comment: one line, no backticks, inside a code span (no mentions, no markup). */
const code = (value) => '`' + String(value ?? '').replace(/[`\r\n]/g, ' ').slice(0, 120) + '`';

export function packageIdFromTitle(title) {
  return /^\s*\[WP\s+([A-Z][A-Z0-9-]*)\]/.exec(title ?? '')?.[1] ?? null;
}

export function overlaps(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

const within = (path, owner) => path === owner || path.startsWith(`${owner}/`);
const normalizePath = (p) => p.replace(/^[`'"]+|[`'",;]+$/g, '').replace(/^\.\//, '').replace(/\/+$/, '');

/** "Claude Code (opus) for octocat" → { agent: 'Claude Code (opus)', forHuman: 'octocat' }. */
export function parseAgent(value) {
  const text = String(value ?? '').trim();
  const m = /^(.*?)\s+for\s+@?([A-Za-z0-9-]+)\s*$/i.exec(text);
  return m ? { agent: m[1].trim(), forHuman: m[2] } : { agent: text, forHuman: null };
}

/** Parses the first command line (/claim, /heartbeat, /release) of a comment and its key: value fields. */
export function parseCommand(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n').filter((line) => !/^\s*(```|~~~)/.test(line));
  let commandLine = -1;
  let match = null;
  for (let i = 0; i < lines.length && commandLine < 0; i++) {
    match = /^\s*\/(claim|heartbeat|release)(?=\s|$)\s*(\S*)\s*(.*)$/i.exec(lines[i]);
    if (match) commandLine = i;
  }
  if (commandLine < 0) return null;
  const fields = { human: '', agent: '', scope: [], until: '', plan: [] };
  const other = [];
  let listKey = null;
  lines.forEach((line, i) => {
    if (i === commandLine) return;
    const kv = /^\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    const key = lower(kv?.[1]);
    if (kv && KEYS.has(key)) {
      const value = kv[2].trim();
      if (key === 'scope') fields.scope.push(...value.split(/[\s,]+/).filter(Boolean));
      else if (key === 'plan') { if (value) fields.plan.push(value); }
      else if (!fields[key]) fields[key] = value;
      listKey = LIST_KEYS.has(key) ? key : null;
      return;
    }
    const bullet = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet && listKey) {
      if (listKey === 'scope') fields.scope.push(...bullet[1].split(/[\s,]+/).filter(Boolean));
      else fields.plan.push(bullet[1].trim());
      return;
    }
    if (line.trim()) { other.push(line.trim()); listKey = null; }
  });
  fields.scope = [...new Set(fields.scope.map(normalizePath).filter(Boolean))];
  return {
    command: lower(match[1]),
    id: match[2].replace(/[`.,:;]+$/, '').toUpperCase(),
    note: (match[3].trim() || other.join(' ')).slice(0, 500),
    fields,
  };
}

function validateUntil(until, at) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || day(Date.parse(`${until}T00:00:00Z`) || 0) !== until) return `\`until\` must be a date written as YYYY-MM-DD (got ${code(until)})`;
  const from = day(at);
  const latest = day(Date.parse(`${from}T00:00:00Z`) + CLAIM_TTL_DAYS * DAY);
  if (until < from || until > latest) return `\`until\` must be between ${from} and ${latest} (at most ${CLAIM_TTL_DAYS} days ahead)`;
  return null;
}

const mayActOn = (claim, author, association) => isMaintainer(author, association) || [claim.human, claim.author].some((h) => lower(h) === lower(author));

/**
 * Judges one command. `active` maps package id → active claim at time `at`. Returns a decision record
 * { cmd, package, ok, reasons, ... } that the bot writes into its answer.
 */
export function decide({ parsed, issuePackageId, author, association, at, packages, active }) {
  const byId = new Map(packages.packages.map((p) => [p.id, p]));
  const reasons = [];
  const id = parsed.id;
  const decision = { cmd: parsed.command, package: id, ok: false, reasons };
  if (!id) reasons.push(`name the package: \`/${parsed.command} <ID>\``);
  else if (issuePackageId !== id) reasons.push(`this issue is for ${issuePackageId ? code(issuePackageId) : 'no work package'}; use the issue titled \`[WP ${id}] …\``);
  const pkg = byId.get(id);
  if (id && !pkg) reasons.push(`${code(id)} is not in docs/engine/work-packages.json`);
  const current = active.get(id);

  if (parsed.command === 'claim') {
    const f = parsed.fields;
    if (pkg) {
      if (pkg.status !== 'open') reasons.push(`the package status is ${code(pkg.status)}; only \`open\` packages can be claimed`);
      const waiting = pkg.dependsOn.filter((d) => byId.get(d)?.status !== 'done');
      if (waiting.length) reasons.push(`dependencies not done yet: ${waiting.map(code).join(', ')}`);
      if (current) reasons.push(lower(current.human) === lower(f.human) ? `${code(current.human)} already holds this claim; use \`/heartbeat ${id} <note>\`` : `already claimed by ${code(current.human)}; ask in this issue (expiry never authorizes a takeover)`);
    }
    const human = f.human.replace(/^@/, '');
    if (!human) reasons.push('add `human: <GitHub handle of the accountable person>`');
    else if (!HANDLE.test(human)) reasons.push(`\`human\` is not a GitHub handle: ${code(human)}`);
    const agent = parseAgent(f.agent);
    if (!agent.agent) reasons.push('add `agent: <tool and model>` (or `agent: none`)');
    if (agent.forHuman && human && lower(agent.forHuman) !== lower(human)) reasons.push(`the agent line names ${code(agent.forHuman)} but \`human\` is ${code(human)}`);
    if (human && lower(author) !== lower(human) && !isMaintainer(author, association)) reasons.push(`post the claim from the accountable person's account (comment by ${code(author)}, \`human\` is ${code(human)})`);
    if (!f.scope.length) reasons.push('add `scope:` with the package paths you will change (all of them or a narrower part)');
    for (const path of f.scope) {
      if (!validPath(path)) reasons.push(`invalid path in scope: ${code(path)}`);
      else if (pkg && !pkg.paths.some((owner) => within(path, owner))) reasons.push(`${code(path)} is outside the package paths (${pkg.paths.map(code).join(', ')})`);
    }
    if (!f.until) reasons.push(`add \`until: YYYY-MM-DD\` (at most ${CLAIM_TTL_DAYS} days ahead)`);
    else { const problem = validateUntil(f.until, at); if (problem) reasons.push(problem); }
    if (!f.plan.length) reasons.push('add `plan:` with three to five steps');
    const placeholders = [f.human, f.agent, f.until, ...f.scope, ...f.plan].filter((v) => /<[^>]*>/.test(v));
    if (placeholders.length) reasons.push(`replace the template placeholders: ${placeholders.map(code).join(', ')}`);
    const mine = [...active.values()].filter((c) => lower(c.human) === lower(human) && c.package !== id);
    const limit = human && lower(author) === lower(human) && isMaintainer(author, association) ? MAX_ACTIVE_CLAIMS_PER_MAINTAINER : MAX_ACTIVE_CLAIMS_PER_HUMAN;
    if (human && mine.length >= limit) reasons.push(`${code(human)} already holds ${mine.length} active claims (${mine.map((c) => code(c.package)).join(', ')}); the limit is ${limit} per ${limit === MAX_ACTIVE_CLAIMS_PER_HUMAN ? 'person' : 'maintainer'}`);
    for (const other of active.values()) {
      if (other.package === id) continue;
      const clash = f.scope.find((path) => other.scope.some((theirs) => overlaps(path, theirs)));
      if (clash) reasons.push(`${code(clash)} overlaps the active claim on ${code(other.package)} (#${other.issue}); narrow the scope or coordinate there`);
    }
    Object.assign(decision, { human, agent: agent.agent.slice(0, 120), scope: f.scope, until: f.until, author });
  } else {
    if (pkg && !current) reasons.push(`there is no active claim on ${code(id)}${parsed.command === 'heartbeat' ? `; post \`/claim ${id}\` instead` : ''}`);
    if (current && !mayActOn(current, author, association)) reasons.push(`only ${code(current.human)}, the claim's author or a maintainer can ${parsed.command} this claim`);
    if (parsed.command === 'heartbeat') {
      if (!parsed.note) reasons.push(`add a short progress note: \`/heartbeat ${id} <note>\``);
      if (parsed.fields.until) { const problem = validateUntil(parsed.fields.until, at); if (problem) reasons.push(problem); else decision.until = parsed.fields.until; }
    }
  }
  decision.ok = reasons.length === 0;
  return decision;
}

const marker = (record) => `<!-- ${MARKER} ${JSON.stringify(record).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`;

export function readMarkers(body) {
  const out = [];
  for (const m of String(body ?? '').matchAll(new RegExp(`<!-- ${MARKER} (\\{[^\\n]*?\\}) -->`, 'g'))) {
    try { out.push(JSON.parse(m[1])); } catch { /* not ours */ }
  }
  return out;
}

const footer = '<sub>Automated by `.github/workflows/claims.yml` (`scripts/claims.mjs`). This comment records the decision; editing the original comment does not change it. Maintainers review and merge; the bot never edits `docs/engine/work-packages.json`.</sub>';

export function renderReply(decision, { issue, expiresAt }) {
  const record = { v: 1, cmd: decision.cmd, comment: decision.comment, package: decision.package, ok: decision.ok };
  if (decision.ok && decision.cmd === 'claim') Object.assign(record, { human: decision.human, agent: decision.agent, scope: decision.scope, until: decision.until, author: decision.author });
  if (decision.ok && decision.until) record.until = decision.until;
  const id = code(decision.package || '?');
  let text;
  if (!decision.ok) {
    text = [`**${decision.cmd[0].toUpperCase()}${decision.cmd.slice(1)} not recorded** for ${id}:`, '', ...decision.reasons.map((r) => `- ${r}`), '', 'Nothing changed. Post a corrected comment; you can check it first with `npm run claims -- lint <file>` (format: docs/engine/agent-onboarding.md, section 5).'].join('\n');
  } else if (decision.cmd === 'claim') {
    text = [
      `**Claim accepted** for ${id}.`,
      '',
      `- Accountable person: ${code(decision.human)} (assigned)`,
      `- Agent: ${code(decision.agent)}`,
      `- Scope: ${decision.scope.map(code).join(', ')}`,
      `- Planned finish: ${decision.until}`,
      `- Expires without a heartbeat: ${isoMinute(expiresAt)}`,
      '',
      `Next: heartbeat with \`/heartbeat ${decision.package} <note>\` at least every ${HEARTBEAT_DAYS} days; open a pull request that names ${id} and #${issue} and moves the package to \`in_progress\` in \`docs/engine/work-packages.json\`; release with \`/release ${decision.package} <reason>\` if you stop.`,
    ].join('\n');
  } else if (decision.cmd === 'heartbeat') {
    text = `**Heartbeat recorded** for ${id}. The claim now expires without a further heartbeat at ${isoMinute(expiresAt)}${decision.until ? `; planned finish ${decision.until}` : ''}.`;
  } else {
    text = `**Claim released** on ${id}. The package can be claimed again with a new \`/claim\` comment once it is open with every dependency done.`;
  }
  return `${text}\n\n${footer}\n${marker(record)}`;
}

export function renderExpiry(claim, expiredAt) {
  const record = { v: 1, cmd: 'expire', claim: claim.comment, package: claim.package };
  return `**Claim expired** on ${code(claim.package)}: no claim or heartbeat from ${code(claim.human)} for ${CLAIM_TTL_DAYS} days (expired ${isoMinute(expiredAt)}). The package is unassigned and can be claimed again. A new claimant starts fresh; reusing the previous branch needs the previous claimant's agreement in this issue.\n\n${footer}\n${marker(record)}`;
}

/**
 * Replays every work package issue and returns the active claims and the actions that bring GitHub in line:
 * answers to unanswered commands, expiry notices, label changes and assignee changes.
 * issues: [{ number, title, labels: [name], assignees: [login], comments: [{ id, author, association, body, createdAt }] }]
 */
export function reconcile({ issues, packages, now = Date.now(), botLogin = BOT_LOGIN }) {
  const byId = new Map(packages.packages.map((p) => [p.id, p]));
  const records = new Map();
  const noticed = new Set();
  const events = [];
  for (const issue of issues) {
    const packageId = packageIdFromTitle(issue.title);
    for (const comment of issue.comments) {
      if (comment.author === botLogin) {
        for (const r of readMarkers(comment.body)) {
          if (r.cmd === 'expire') noticed.add(String(r.claim));
          else if (r.comment !== undefined) records.set(String(r.comment), r);
        }
        continue;
      }
      const parsed = parseCommand(comment.body);
      if (parsed) events.push({ issue, packageId, comment, parsed, at: Date.parse(comment.createdAt) });
    }
  }
  events.sort((a, b) => a.at - b.at || Number(a.comment.id) - Number(b.comment.id));

  const active = new Map();
  const actions = [];
  const endedNow = new Map();
  const expiresAt = (claim) => claim.lastActivity + CLAIM_TTL_DAYS * DAY;
  const expire = (time) => {
    for (const claim of [...active.values()]) {
      if (expiresAt(claim) > time) continue;
      active.delete(claim.package);
      if (!noticed.has(String(claim.comment))) {
        noticed.add(String(claim.comment));
        actions.push({ type: 'comment', issue: claim.issue, body: renderExpiry(claim, expiresAt(claim)) });
        endedNow.set(claim.issue, claim.human);
      }
    }
  };

  for (const event of events) {
    expire(event.at);
    const recorded = records.get(String(event.comment.id));
    const decision = recorded
      ? { ...recorded, reasons: [] }
      : { ...decide({ parsed: event.parsed, issuePackageId: event.packageId, author: event.comment.author, association: event.comment.association, at: event.at, packages, active }), comment: event.comment.id };
    const current = active.get(decision.package);
    if (decision.ok && decision.cmd === 'claim') {
      active.set(decision.package, { package: decision.package, issue: event.issue.number, human: decision.human, agent: decision.agent, scope: decision.scope ?? [], until: decision.until, author: decision.author ?? event.comment.author, comment: event.comment.id, claimedAt: event.at, lastActivity: event.at });
    } else if (decision.ok && decision.cmd === 'heartbeat' && current) {
      current.lastActivity = event.at;
      if (decision.until) current.until = decision.until;
    } else if (decision.ok && decision.cmd === 'release' && current) {
      active.delete(decision.package);
      if (!recorded) endedNow.set(current.issue, current.human);
    }
    if (!recorded) {
      const claim = active.get(decision.package);
      actions.push({ type: 'comment', issue: event.issue.number, body: renderReply(decision, { issue: event.issue.number, expiresAt: claim ? expiresAt(claim) : event.at }) });
    }
  }
  expire(now);

  const done = new Set(packages.packages.filter((p) => p.status === 'done').map((p) => p.id));
  for (const issue of issues) {
    const pkg = byId.get(packageIdFromTitle(issue.title));
    if (!pkg) continue;
    const claim = active.get(pkg.id);
    let want = null;
    if (claim) want = LABELS.claimed.name;
    else if (pkg.status === 'open') want = pkg.dependsOn.every((d) => done.has(d)) ? LABELS.ready.name : LABELS.waiting.name;
    else if (pkg.status === 'blocked') want = LABELS.waiting.name;
    const add = want && !issue.labels.includes(want) ? [want] : [];
    const remove = issue.labels.filter((l) => MANAGED_LABELS.includes(l) && l !== want);
    if (add.length || remove.length) actions.push({ type: 'labels', issue: issue.number, add, remove });
    const assignAdd = claim && !issue.assignees.some((a) => lower(a) === lower(claim.human)) ? [claim.human] : [];
    const ended = endedNow.get(issue.number);
    const assignRemove = ended && (!claim || lower(claim.human) !== lower(ended)) ? issue.assignees.filter((a) => lower(a) === lower(ended)) : [];
    if (assignAdd.length || assignRemove.length) actions.push({ type: 'assignees', issue: issue.number, add: assignAdd, remove: assignRemove });
  }
  const claims = [...active.values()].map((c) => ({ ...c, expiresAt: new Date(expiresAt(c)).toISOString() }));
  return { claims, actions };
}

/** Minimal GitHub REST adapter (global fetch, no dependency). Tests use an in-memory fake with the same methods. */
export function githubClient({ token, repo, fetchImpl = globalThis.fetch, api = 'https://api.github.com' }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('repository must be owner/name (GITHUB_REPOSITORY or --repo)');
  const request = async (method, path, body, { allow404 = false } = {}) => {
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'trustwork-claims' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/json';
    const res = await fetchImpl(`${api}/repos/${repo}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  };
  const all = async (path) => {
    const rows = [];
    for (let page = 1; ; page++) {
      const batch = await request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  };
  return {
    async listWorkPackageIssues() {
      const rows = await all('/issues?state=open&labels=work-package');
      return rows.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)), assignees: (i.assignees ?? []).map((a) => a.login) }));
    },
    async listComments(issue) {
      return (await all(`/issues/${issue}/comments`)).map((c) => ({ id: c.id, author: c.user?.login ?? '', association: c.author_association, body: c.body ?? '', createdAt: c.created_at }));
    },
    createComment: (issue, body) => request('POST', `/issues/${issue}/comments`, { body }),
    addLabels: (issue, labels) => request('POST', `/issues/${issue}/labels`, { labels }),
    removeLabel: (issue, label) => request('DELETE', `/issues/${issue}/labels/${encodeURIComponent(label)}`, undefined, { allow404: true }),
    async addAssignees(issue, assignees) { return ((await request('POST', `/issues/${issue}/assignees`, { assignees }))?.assignees ?? []).map((a) => a.login); },
    removeAssignees: (issue, assignees) => request('DELETE', `/issues/${issue}/assignees`, { assignees }),
    async ensureLabel({ name, color, description }) {
      if (!(await request('GET', `/labels/${encodeURIComponent(name)}`, undefined, { allow404: true }))) await request('POST', '/labels', { name, color, description });
    },
  };
}

export async function loadIssues(client) {
  const issues = await client.listWorkPackageIssues();
  for (const issue of issues) issue.comments = await client.listComments(issue.number);
  return issues;
}

/** Applies reconcile() actions; keeps going after a failed action and returns the failures. */
export async function applyActions(client, actions, log = console.log) {
  const failures = [];
  const needed = new Set(actions.flatMap((a) => (a.type === 'labels' ? a.add : [])));
  for (const label of Object.values(LABELS).filter((l) => needed.has(l.name))) {
    try { await client.ensureLabel(label); } catch (error) { failures.push(`label ${label.name}: ${error.message}`); }
  }
  for (const action of actions) {
    try {
      if (action.type === 'comment') await client.createComment(action.issue, action.body);
      if (action.type === 'labels') {
        if (action.add.length) await client.addLabels(action.issue, action.add);
        for (const label of action.remove) await client.removeLabel(action.issue, label);
      }
      if (action.type === 'assignees') {
        if (action.add.length) {
          const now = await client.addAssignees(action.issue, action.add);
          const dropped = action.add.filter((h) => !now.some((a) => lower(a) === lower(h)));
          if (dropped.length) log(`::warning::#${action.issue}: GitHub did not assign ${dropped.join(', ')} (only people who commented on the issue or have repository access can be assigned)`);
        }
        if (action.remove.length) await client.removeAssignees(action.issue, action.remove);
      }
      log(`#${action.issue}: ${describe(action)}`);
    } catch (error) {
      failures.push(`#${action.issue} ${action.type}: ${error.message}`);
    }
  }
  return failures;
}

const describe = (a) => (a.type === 'comment' ? `comment (${/\*\*(.+?)\*\*/.exec(a.body)?.[1] ?? 'notice'})` : `${a.type} +[${a.add.join(', ')}] -[${a.remove.join(', ')}]`);

// ---------- Pull request description check ----------

function sections(body) {
  const out = new Map();
  let current = null;
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { current = lower(heading[1]); out.set(current, []); } else if (current) out.get(current).push(line);
  }
  const find = (prefix) => { for (const [k, v] of out) if (k.startsWith(prefix)) return v.join('\n'); return null; };
  return find;
}
const checkboxes = (text) => [...String(text ?? '').matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/gm)].map((m) => ({ checked: m[1] !== ' ', text: m[2].trim() }));
const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
const SHA = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/;
const RESULTS = /\b(?:pass(?:ed|es)?|exit(?:ed)?(?:\s+code)?\s*[:=]?\s*0|\d+\s+(?:tests?|suites?|pass(?:ed)?|ok))\b/i;
const EXEMPT_AUTHORS = new Set(['dependabot[bot]', 'renovate[bot]']);

/**
 * Validates a pull request description against .github/PULL_REQUEST_TEMPLATE.md and the work package rules.
 * Returns { errors, warnings }. changedFiles are repository paths changed by the pull request.
 */
export function checkPullRequest({ body, author = '', changedFiles = [], packages }) {
  const errors = [];
  const warnings = [];
  if (EXEMPT_AUTHORS.has(author)) return { errors, warnings: [`${author} is exempt from the description check`] };
  const text = stripComments(String(body ?? '').replace(/\r\n?/g, '\n'));
  const section = sections(text);
  const filled = (s) => s !== null && s.split('\n').some((line) => line.trim() && !/<[^>]+>/.test(line));

  for (const [name, label] of [['what changed', 'What changed'], ['why', 'Why']]) {
    if (section(name) === null) errors.push(`missing section "## ${label}" (use .github/PULL_REQUEST_TEMPLATE.md)`);
    else if (!filled(section(name))) errors.push(`section "${label}" is empty or still has template placeholders`);
  }

  const verified = section('how it was verified');
  if (verified === null) errors.push('missing section "## How it was verified"');
  else {
    if (!checkboxes(verified).some((b) => b.checked && /npm run check/.test(b.text))) errors.push('verification: tick the `npm run check` box after running it on the head commit');
    if (!SHA.test(verified)) errors.push('verification: name the commit SHA the checks ran on');
    if (!RESULTS.test(verified)) errors.push('verification: paste results (exit codes, test counts or the passing summary line)');
    if (/<sha>/.test(verified)) warnings.push('verification: the `<sha>` placeholder is still there');
  }

  const ai = section('made with an ai agent');
  if (ai === null) errors.push('missing section "## Made with an AI agent?"');
  else {
    const boxes = checkboxes(ai).filter((b) => b.checked);
    const yes = boxes.some((b) => /^yes\b/i.test(b.text));
    const no = boxes.some((b) => /^no\b/i.test(b.text));
    if (yes === no) errors.push('AI agent: tick exactly one of "No" or "Yes"');
    const line = /^\s*(?:[-*]\s+(?:\[[ xX]\]\s+)?)?Agent:\s*(.*)$/im.exec(text)?.[1]?.trim() ?? '';
    const declared = line && !/<[^>]+>/.test(line) && lower(line) !== 'none';
    if (yes) {
      const agent = parseAgent(line);
      if (!declared || !agent.forHuman) errors.push('AI agent: fill in `Agent: <tool and model> for <human handle>`');
      else if (author && lower(agent.forHuman) !== lower(author)) warnings.push(`AI agent: the Agent line names ${agent.forHuman}, the pull request is opened by ${author}; the named person must sign off the commits`);
    }
    if (no && declared) errors.push('AI agent: "No" is ticked but an Agent line is filled in');
  }

  const signoff = section('sign-off');
  if (signoff === null || !checkboxes(signoff).some((b) => b.checked)) errors.push('sign-off: tick the DCO box (every commit carries Signed-off-by of the accountable person; the DCO job checks the commits)');

  const mentioned = new Set([...text.matchAll(PACKAGE_ID)].map((m) => m[1]));
  const byId = new Map(packages.packages.map((p) => [p.id, p]));
  for (const id of mentioned) if (!byId.has(id) && /^(?:[A-Z]+|ADM-UX)-\d{3}$/.test(id)) warnings.push(`${id} is not a work package id`);
  const unreferenced = new Map();
  // A done package still owns its paths: a later change to them names it (or a broader open package), so a package
  // that sets itself to done in its own pull request is not shadowed by an open package with broader paths. Only
  // rejected packages own nothing.
  for (const file of changedFiles) {
    const owners = packages.packages.filter((p) => p.status !== 'rejected' && p.paths.some((path) => within(file, path))).map((p) => p.id);
    if (owners.length && !owners.some((id) => mentioned.has(id))) unreferenced.set(owners.join(' or '), [...(unreferenced.get(owners.join(' or ')) ?? []), file]);
  }
  // Work outside any package (for example a new country pack) may touch a package's paths when the description says
  // "Work package: none" and links the issue that agreed the change; maintainers then see the overlap as a warning.
  const outsidePackages = /^\s*work package:\s*none\b/im.test(text) && /(^|\s)#\d+\b/.test(text);
  for (const [owners, files] of unreferenced) {
    const message = `work package: ${files.length} changed file(s) belong to ${owners} (for example ${files[0]})`;
    if (outsidePackages) warnings.push(`${message}; the description says "Work package: none", so a maintainer must confirm this does not collide with an active claim`);
    else errors.push(`${message}; name the package id and link its issue (#<number>), or write "Work package: none" and link the issue that agreed the change`);
  }
  return { errors, warnings };
}

function changedFilesBetween(base, head) {
  if (!base || !head) return [];
  return execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
}

// ---------- Command line ----------

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const [command, ...args] = argv;
  const packages = loadWorkPackages();
  if (command === 'lint') {
    const file = args.find((a) => !a.startsWith('--') && a !== option(args, '--at')) ?? '-';
    const body = readFileSync(file === '-' ? 0 : file, 'utf8');
    const parsed = parseCommand(body);
    if (!parsed) { console.error('no /claim, /heartbeat or /release line found'); return 1; }
    const at = Date.parse(option(args, '--at') ?? new Date().toISOString());
    const pkgId = parsed.id;
    const author = parsed.fields.human.replace(/^@/, '') || 'unknown';
    const decision = decide({ parsed, issuePackageId: pkgId, author, association: 'NONE', at, packages, active: new Map(parsed.command === 'claim' ? [] : [[pkgId, { package: pkgId, human: author, author, scope: [] }]]) });
    if (decision.ok) { console.log(`ok: ${parsed.command} ${pkgId} is well-formed and fits work-packages.json (active claims are checked by the bot on GitHub)`); return 0; }
    console.error(decision.reasons.map((r) => `- ${r.replace(/`/g, '')}`).join('\n'));
    return 1;
  }
  if (command === 'pr') {
    const event = JSON.parse(readFileSync(option(args, '--event') ?? process.env.GITHUB_EVENT_PATH, 'utf8'));
    const pr = event.pull_request ?? {};
    const changedFiles = changedFilesBetween(option(args, '--base') ?? pr.base?.sha, option(args, '--head') ?? pr.head?.sha);
    const { errors, warnings } = checkPullRequest({ body: pr.body ?? '', author: pr.user?.login, changedFiles, packages });
    const asWarnings = pr.draft ? errors : [];
    for (const w of [...warnings, ...asWarnings]) console.log(`::warning::${w}`);
    if (!pr.draft) for (const e of errors) console.log(`::error::${e}`);
    const summary = errors.length ? `Pull request description: ${errors.length} problem(s)${pr.draft ? ' (draft: reported as warnings)' : ''}\n\n${errors.map((e) => `- ${e}`).join('\n')}` : 'Pull request description: complete.';
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    console.log(summary);
    return errors.length && !pr.draft ? 1 : 0;
  }
  if (command === 'run' || command === 'status') {
    const repo = option(args, '--repo') ?? process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const client = githubClient({ token, repo });
    const issues = await loadIssues(client);
    const { claims, actions } = reconcile({ issues, packages, now: Date.now(), botLogin: process.env.CLAIMS_BOT_LOGIN ?? BOT_LOGIN });
    if (command === 'status') {
      if (args.includes('--json')) console.log(JSON.stringify({ claims, pendingActions: actions.length }, null, 2));
      else {
        console.log(claims.length ? 'Active claims:' : 'No active claims.');
        for (const c of claims) console.log(`  ${c.package.padEnd(10)} #${String(c.issue).padEnd(4)} ${c.human} (agent: ${c.agent}) scope ${c.scope.join(', ')} expires ${c.expiresAt}`);
        if (actions.length) console.log(`\n${actions.length} action(s) pending for the claims bot.`);
      }
      return 0;
    }
    if (args.includes('--dry-run')) { console.log(JSON.stringify(actions, null, 2)); return 0; }
    const failures = await applyActions(client, actions);
    console.log(`claims: ${issues.length} work package issues, ${claims.length} active claims, ${actions.length} actions, ${failures.length} failures`);
    for (const f of failures) console.log(`::error::${f}`);
    return failures.length ? 1 : 0;
  }
  console.error('usage: node scripts/claims.mjs lint [file|-] [--at ISO] | status [--repo owner/name] [--json] | run [--repo owner/name] [--dry-run] | pr --event <file>');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'scripts/claims.mjs')) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 1; });
}
