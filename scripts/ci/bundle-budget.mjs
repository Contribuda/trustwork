#!/usr/bin/env node
// Client bundle-size budget for the Next.js web app (webpack build). Measures gzip bytes of the JavaScript a
// browser downloads: the shared root chunks, the heaviest route (shared chunks plus every client chunk the
// route's client-reference manifest lists) and all client chunks together, and compares them with
// scripts/ci/bundle-budget.json. Usage: node scripts/ci/bundle-budget.mjs [distDir] [budget.json]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';

const gzipBytes = (file) => gzipSync(readFileSync(file), { level: 9 }).length;

function walk(directory, predicate) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path, predicate);
    return entry.isFile() && predicate(path) ? [path] : [];
  });
}

/** Evaluates a page_client-reference-manifest.js (it assigns globalThis.__RSC_MANIFEST) in an isolated context. */
function readClientManifest(file) {
  const sandbox = { globalThis: {}, self: {} };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file, timeout: 1_000 });
  return sandbox.__RSC_MANIFEST ?? {};
}

/** Chunk paths ("static/chunks/...js") referenced by every client module of one route manifest entry. */
function routeChunks(entry) {
  const chunks = new Set();
  for (const module of Object.values(entry.clientModules ?? {})) {
    for (const chunk of module.chunks ?? []) {
      if (typeof chunk !== 'string' || !chunk.endsWith('.js')) continue;
      chunks.add(decodeURIComponent(chunk.replace(/^\/?(?:_next\/)?/, '')));
    }
  }
  return chunks;
}

export function measure(distDir) {
  const dist = resolve(distDir);
  const buildManifest = join(dist, 'build-manifest.json');
  if (!existsSync(buildManifest)) throw new Error(`${buildManifest} not found: build the web app first (NEXT_DIST_DIR=.next-e2e npx next build --webpack)`);
  const sizes = new Map();
  const size = (chunk) => {
    if (!sizes.has(chunk)) {
      const file = join(dist, chunk);
      if (!existsSync(file)) throw new Error(`chunk ${chunk} is listed by a manifest but missing from ${dist}`);
      sizes.set(chunk, gzipBytes(file));
    }
    return sizes.get(chunk);
  };
  const root = JSON.parse(readFileSync(buildManifest, 'utf8')).rootMainFiles ?? [];
  const sharedGzipBytes = root.reduce((sum, chunk) => sum + size(chunk), 0);
  const routes = [];
  for (const file of walk(join(dist, 'server', 'app'), (path) => path.endsWith('page_client-reference-manifest.js'))) {
    for (const [route, entry] of Object.entries(readClientManifest(file))) {
      const chunks = new Set([...root, ...routeChunks(entry)]);
      routes.push({ route, gzipBytes: [...chunks].reduce((sum, chunk) => sum + size(chunk), 0) });
    }
  }
  if (!routes.length) throw new Error(`no client-reference manifests under ${join(dist, 'server', 'app')}: is this a webpack App Router build?`);
  routes.sort((a, b) => b.gzipBytes - a.gzipBytes || a.route.localeCompare(b.route));
  const totalGzipBytes = walk(join(dist, 'static', 'chunks'), (path) => path.endsWith('.js')).reduce((sum, file) => sum + gzipBytes(file), 0);
  return { sharedGzipBytes, largestRoute: routes[0], totalGzipBytes, routes };
}

/** Lines describing every metric over its budget (empty: within budget). */
export function compare(measured, budget) {
  const over = [];
  const check = (label, actual, limit) => {
    if (typeof limit !== 'number') throw new Error(`budget for ${label} is missing`);
    if (actual > limit) over.push(`${label}: ${actual} gzip bytes > budget ${limit} (+${actual - limit})`);
  };
  check('shared root chunks', measured.sharedGzipBytes, budget.sharedGzipBytes);
  check(`largest route (${measured.largestRoute.route})`, measured.largestRoute.gzipBytes, budget.largestRouteGzipBytes);
  check('all client chunks', measured.totalGzipBytes, budget.totalGzipBytes);
  return over;
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const distDir = process.argv[2] ?? 'apps/web/.next-e2e';
  const budgetPath = resolve(process.argv[3] ?? new URL('./bundle-budget.json', import.meta.url).pathname);
  const measured = measure(distDir);
  const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
  console.log(`bundle (${relative(process.cwd(), resolve(distDir)) || '.'}, gzip -9):`);
  console.log(`  shared root chunks  ${kib(measured.sharedGzipBytes).padStart(10)}  budget ${kib(budget.sharedGzipBytes)}`);
  console.log(`  largest route       ${kib(measured.largestRoute.gzipBytes).padStart(10)}  budget ${kib(budget.largestRouteGzipBytes)}  ${measured.largestRoute.route}`);
  console.log(`  all client chunks   ${kib(measured.totalGzipBytes).padStart(10)}  budget ${kib(budget.totalGzipBytes)}`);
  for (const { route, gzipBytes } of measured.routes.slice(0, 5)) console.log(`    ${kib(gzipBytes).padStart(10)}  ${route}`);
  const over = compare(measured, budget);
  if (over.length) {
    for (const line of over) console.error(`::error::bundle budget exceeded: ${line}`);
    console.error('Reduce client JavaScript, or raise scripts/ci/bundle-budget.json in a reviewed change that explains why.');
    process.exitCode = 1;
  }
}
