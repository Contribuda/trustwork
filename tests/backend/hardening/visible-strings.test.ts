import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { createApp, expectError, SKIP_REASON, startHarness } from '../helpers/app.js';
import { count, providerState } from './helpers.js';

const API_SRC = resolve('apps/api/src');
/** Development fixtures (synthetic seed data) are not served text; everything else in apps/api is. */
const EXCLUDED = [join(API_SRC, 'dev')];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (EXCLUDED.includes(path)) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** String literals and template text of a source (the parser skips comments and handles regex/template context). */
function literalsOf(fileName: string, text: string): { line: number; text: string }[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
const literals = (file: string) => literalsOf(file, readFileSync(file, 'utf8'));

/**
 * BE-002 acceptance: "No visible string is hard-coded in apps/api." The API answers with machine codes and English
 * technical messages; product copy lives in the locale files. Any letter outside ASCII in a string literal is copy
 * in some interface language (the former Russian fallback display name was one) and fails this lint.
 */
test('apps/api string literals carry no interface-language copy', () => {
  const offenders: string[] = [];
  const files = sources(API_SRC);
  assert.ok(files.length > 20, 'the scan sees the API sources');
  for (const file of files) {
    for (const literal of literals(file)) {
      if (/[^\x00-\x7F]/.test(literal.text)) offenders.push(`${relative(process.cwd(), file)}:${literal.line} ${JSON.stringify(literal.text)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the lint catches a hard-coded fallback name and ignores comments', () => {
  const probe = "// \u0423\u0447\u0430\u0441\u0442\u043d\u0438\u043a in a comment is fine\nconst name = identity.name ?? '\u0423\u0447\u0430\u0441\u0442\u043d\u0438\u043a';\nconst t = `${name} \u2014 ok`;";
  const hits = literalsOf('probe.ts', probe).filter((l) => /[^\x00-\x7F]/.test(l.text));
  assert.deepEqual(hits.map((h) => h.line), [2, 3]);
});

const h = await startHarness('hardening_strings');

test('provider identities without a name store none; disabled providers answer 404 on every route', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());

  await t.test('a provider sign-up without a name stores NULL and the API returns displayName null', async () => {
    const client = h.client();
    const state = await providerState(client, 'apple');
    h.apple.enqueue({ subject: 'apple-nameless', email: 'nameless@example.invalid', emailVerified: false, name: null });
    assert.match(String((await client.get(`/v1/auth/apple/callback?code=fake&state=${state}`)).headers.location), /auth=verification_pending/);
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.person p JOIN trustwork.credential c ON c.person_id = p.id WHERE c.provider_subject = 'apple-nameless' AND p.display_name IS NULL"), 1);
    const me = await client.get('/v1/me');
    assert.equal(me.status, 200);
    assert.equal((me.body as { person: { displayName: string | null } }).person.displayName, null);
  });

  await t.test('a blank provider name is not invented from the address either', async () => {
    const client = h.client();
    const state = await providerState(client, 'google');
    h.google.enqueue({ subject: 'google-blank', email: 'blank-name@example.invalid', emailVerified: true, name: '   ' });
    assert.match(String((await client.get(`/v1/auth/google/callback?code=fake&state=${state}`)).headers.location), /auth=signed_in/);
    assert.equal(((await client.get('/v1/me')).body as { person: { displayName: string | null } }).person.displayName, null);
  });

  await t.test('with providers disabled, start, callback and link answer 404 before any flow state is read', async () => {
    const disabled = await createApp({ env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test' }, pool: h.pool, clock: h.clock, log: () => undefined });
    try {
      for (const provider of ['google', 'apple']) {
        const callback = await disabled.fastify.inject({ method: 'GET', url: `/v1/auth/${provider}/callback?code=x&state=y` });
        assert.equal(callback.statusCode, 404, callback.body);
        assert.equal(JSON.parse(callback.body).code, 'access.not_found');
        const start = await disabled.fastify.inject({ method: 'POST', url: `/v1/auth/${provider}/start`, headers: { 'X-Trustwork-Request': '1', 'sec-fetch-site': 'same-origin' } });
        assert.equal(start.statusCode, 404);
      }
    } finally {
      await disabled.app.close();
    }
    expectError(await h.client().get('/v1/auth/google/callback?code=x&state=y'), 400, 'auth.provider.state_mismatch');
  });
});
