import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/*
 * ADR 014 decision 3 (owner, 2026-10-31): the engine ships no code that geolocates the server it runs on, phones home or
 * disables itself by location. The review checklist in docs/operations/sanctions-our-services.md is the control; this
 * test is a tripwire behind it, not a proof. It fails when the admission module reaches for the network or the host,
 * or when engine source names a public "what is my address / where am I" service.
 */

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const ADMISSION = join(ROOT, 'packages/compliance/src/admission');
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name.startsWith('.next')) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && SOURCE.test(entry.name) ? [path] : [];
  });
}

test('the admission module judges the other party only: no network, host or process access', () => {
  const files = sourceFiles(ADMISSION);
  assert.ok(files.length > 0);
  const forbidden = [
    /from\s+['"](?:node:)?(?:os|net|dns|http|https|http2|dgram|tls|child_process|fs|worker_threads)['"]/,
    /\bfetch\s*\(/,
    /\bprocess\.(?:env|exit|kill)\b/,
    /\bnetworkInterfaces\b/,
    /\bXMLHttpRequest\b|\bWebSocket\b/,
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of forbidden) assert.ok(!pattern.test(text), `${relative(ROOT, file)} matches ${pattern}`);
  }
});

test('engine source names no public address-echo or self-geolocation service', () => {
  const services = /\b(?:api\.ipify\.org|ipinfo\.io|ip-api\.com|ipapi\.co|ifconfig\.me|ifconfig\.co|icanhazip\.com|checkip\.amazonaws\.com|ipgeolocation\.io|freegeoip|geoplugin|myexternalip|ident\.me|wtfismyip)\b/i;
  const hits: string[] = [];
  for (const top of ['apps', 'packages', 'scripts', 'infra']) {
    let files: string[] = [];
    try {
      files = sourceFiles(join(ROOT, top));
    } catch {
      continue;
    }
    for (const file of files) {
      if (services.test(readFileSync(file, 'utf8'))) hits.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(hits, []);
});
