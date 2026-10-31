#!/usr/bin/env node
// Licence allowlist check over package-lock.json: every installed package (runtime and development) must carry
// an SPDX expression whose terms are allowed by scripts/ci/license-policy.json. Reads only the lockfile, so it
// needs no node_modules and no network. Usage: node scripts/ci/licenses.mjs [lockfile] [policy]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Evaluates an SPDX license expression against the allowed identifiers. OR needs one allowed side, AND needs
 * both; parentheses group; "WITH <exception>" is accepted only when the whole "id WITH exception" is allowed.
 */
export function expressionAllowed(expression, allowed) {
  const tokens = String(expression).replace(/[()]/g, (p) => ` ${p} `).trim().split(/\s+/).filter(Boolean);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];
  function primary() {
    const token = next();
    if (token === undefined) throw new Error(`incomplete licence expression "${expression}"`);
    if (token === '(') {
      const value = disjunction();
      if (next() !== ')') throw new Error(`unbalanced licence expression "${expression}"`);
      return value;
    }
    if (peek()?.toUpperCase() === 'WITH') {
      next();
      const exception = next();
      return allowed.has(`${token} WITH ${exception}`);
    }
    return allowed.has(token);
  }
  function conjunction() {
    let value = primary();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      value = primary() && value;
    }
    return value;
  }
  function disjunction() {
    let value = conjunction();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      value = conjunction() || value;
    }
    return value;
  }
  const result = disjunction();
  if (position !== tokens.length) throw new Error(`unexpected "${tokens[position]}" in licence expression "${expression}"`);
  return result;
}

const packageName = (path, entry) => entry.name ?? path.replace(/^.*node_modules\//, '');

/** Returns the packages whose licence is missing, malformed or not allowed (empty array: compliant). */
export function checkLockfile(lock, policy) {
  const allowed = new Set(Object.keys(policy.allowed ?? {}));
  const exceptions = policy.exceptions ?? {};
  const problems = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === '' || entry.link) continue; // the root and workspace links are checked through their target entries
    const name = packageName(path, entry);
    const id = `${name}@${entry.version ?? '?'}`;
    if (exceptions[id]) continue;
    const license = typeof entry.license === 'string' ? entry.license : null;
    if (!license) {
      problems.push({ id, path, license: null, reason: 'no licence declared in package-lock.json' });
      continue;
    }
    try {
      if (!expressionAllowed(license, allowed)) problems.push({ id, path, license, reason: 'licence not in scripts/ci/license-policy.json' });
    } catch (error) {
      problems.push({ id, path, license, reason: error.message });
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lockPath = resolve(process.argv[2] ?? 'package-lock.json');
  const policyPath = resolve(process.argv[3] ?? new URL('./license-policy.json', import.meta.url).pathname);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const problems = checkLockfile(lock, policy);
  const total = Object.keys(lock.packages ?? {}).filter((path) => path !== '' && !lock.packages[path].link).length;
  if (problems.length) {
    for (const p of problems) console.error(`::error::licence: ${p.id} (${p.path}): ${p.license ?? 'none'}: ${p.reason}`);
    console.error(`licences: ${problems.length} of ${total} packages violate the allowlist; add a reviewed entry to scripts/ci/license-policy.json or replace the dependency`);
    process.exitCode = 1;
  } else {
    console.log(`licences: ${total} packages, all within the allowlist`);
  }
}
