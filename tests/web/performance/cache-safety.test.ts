import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * WEB-005 acceptance "no private or personalized data is ever cached for another visitor", as structural guarantees.
 * Every document carries a per-request CSP nonce, so every page renders per request and nothing is kept as a shared
 * page: there is no full-page cache, no cache handler and no static page in the public tree. Public pages also never
 * read the session or request headers (their only visitor input is the chosen country, through `primePublicLocale`) or
 * inject raw HTML, so full-page caching can return once a no-inline-script or build-time hash approach is proven. The browser side is public-isolation.spec.ts; the live API
 * side is tests/web/live-api/cache.e2e.ts.
 */
const WEB = resolve(import.meta.dirname, '../../../apps/web');
const PUBLIC = join(WEB, 'app/(public)');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const rel = (file: string) => relative(WEB, file);

test('public pages render per request: the language layout is force-dynamic and no page opts into static rendering or revalidation', () => {
  const layout = readFileSync(join(PUBLIC, '[lang]/layout.tsx'), 'utf8');
  assert.match(layout, /export const dynamic = 'force-dynamic';/);
  const files = walk(join(PUBLIC, '[lang]')).filter((file) => /\.(tsx?)$/.test(file));
  assert.ok(files.length >= 40, `${files.length} files`);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /export const dynamic = '(?:error|force-static)'/, `${rel(file)} must not be static: it would be served without its nonce`);
    assert.doesNotMatch(source, /export const revalidate\b|generateStaticParams/, `${rel(file)} must not be prerendered or revalidated`);
  }
  assert.equal(existsSync(join(WEB, 'cache-handler.mjs')), false, 'no full-page cache handler');
  assert.doesNotMatch(readFileSync(join(WEB, 'next.config.ts'), 'utf8'), /cacheHandler/);
});

test('nothing in the public tree reads the session, request headers or the cookie language, or injects raw HTML', () => {
  const files = [...walk(PUBLIC), ...walk(join(WEB, 'components/public')), ...walk(join(WEB, 'components/home'))].filter((file) => /\.tsx?$/.test(file));
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from 'next\/headers'/, `${rel(file)} imports next/headers`);
    assert.doesNotMatch(source, /\b(?:cookies|headers|draftMode)\(\)/, `${rel(file)} reads request data`);
    assert.doesNotMatch(source, /\b(?:getPrincipal|requirePrincipal|primeLocale)\b/, `${rel(file)} resolves the visitor on the server`);
    for (const line of source.split('\n').filter((l) => l.includes("from '@/app/_lib/principal'"))) assert.match(line, /^import type /, `${rel(file)} imports principal helpers (types only are allowed)`);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/, `${rel(file)} injects raw HTML`);
  }
});

test('the workspace, sign-in, onboarding, console and refusal trees are per request; there is no app-wide force-dynamic', () => {
  for (const file of ['app/app/layout.tsx', 'app/(auth)/layout.tsx', 'app/onboarding/layout.tsx', 'app/admin/layout.tsx', 'app/restricted/layout.tsx', 'app/app/viewer/route.ts']) {
    assert.match(readFileSync(join(WEB, file), 'utf8'), /export const dynamic = 'force-dynamic';/, file);
  }
  assert.doesNotMatch(readFileSync(join(WEB, 'app/layout.tsx'), 'utf8'), /export const dynamic/);
  const viewer = readFileSync(join(WEB, 'app/app/viewer/route.ts'), 'utf8');
  assert.match(viewer, /'Cache-Control': 'private, no-store'/);
  assert.match(viewer, /Vary: 'Cookie'/);
});
