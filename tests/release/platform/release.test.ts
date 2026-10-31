import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mailConfigFromEnv, renderMail, SmtpTransport, type OutgoingMail } from '../../../apps/worker/src/mail/index.js';
import { createReader, linksIn, parseMessage, ReleaseSmtpSink } from './smtp-sink.mjs';
import { playwrightCounts, SUITES, tapCounts } from './run.mjs';

/**
 * QA-002 release harness, checked in `npm test` without Docker: the SMTP sink against the worker's real SMTP client and
 * templates, the overlay's settings, the suites the release runs and the written gate list.
 */
const REPO = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(REPO, path), 'utf8');

test('QA-002 release SMTP sink', async (t) => {
  const sink = new ReleaseSmtpSink();
  const port = await sink.listen(0, '127.0.0.1');
  const reader = createReader(sink);
  await new Promise<void>((r) => reader.listen(0, '127.0.0.1', () => r()));
  const readerPort = (reader.address() as { port: number }).port;
  t.after(async () => {
    reader.close();
    await sink.close();
  });

  // The worker's configuration exactly as the release overlay sets it (host and port of the test sink instead).
  const config = mailConfigFromEnv({
    NODE_ENV: 'development', MAIL_TRANSPORT: 'smtp', MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_PORT: String(port), MAIL_SMTP_SECURITY: 'none',
    MAIL_FROM_ADDRESS: 'no-reply@release-hub.example.invalid', MAIL_PUBLIC_ORIGIN: 'http://localhost:8391', MAIL_SECRET_KEY: 'ab'.repeat(32),
  });
  const send = async (to: string, localePreferences: string[], token: string) => {
    const rendered = renderMail(config.render, { template: 'verify_email', localePreferences, params: { hours: '24' }, secret: token });
    const mail: OutgoingMail = {
      messageId: `${token}@release-hub.example.invalid`, idempotencyKey: `job:${token}`, from: { address: config.from, name: rendered.fromName }, replyTo: null,
      to, subject: rendered.subject, text: rendered.text, html: rendered.html, locale: rendered.locale, headers: {},
    };
    return new SmtpTransport(config.smtp!).send(mail, new AbortController().signal);
  };

  await t.test('the worker submits a Spanish verification message; the reader returns subject, language and the one-time link', async () => {
    const receipt = await send('rosa@example.invalid', ['es-US', 'es'], 'release-token-spanish-0001');
    assert.match(receipt.providerMessageId ?? '', /^RELEASE\d+$/);
    const response = await fetch(`http://127.0.0.1:${readerPort}/messages?to=${encodeURIComponent('Rosa@Example.invalid')}`);
    assert.equal(response.status, 200);
    const { items } = (await response.json()) as { items: Array<{ subject: string; language: string; links: string[]; from: string }> };
    assert.equal(items.length, 1);
    assert.equal(items[0]!.language, 'es');
    assert.ok(items[0]!.subject.length > 0 && /[^\x00-\x7f]|[a-z]/i.test(items[0]!.subject), 'decoded subject');
    assert.equal(items[0]!.from, 'no-reply@release-hub.example.invalid');
    const link = new URL(items[0]!.links.find((l) => l.includes('/verify-email/'))!);
    assert.equal(link.origin, 'http://localhost:8391');
    assert.equal(link.pathname, '/verify-email/release-token-spanish-0001');
  });

  await t.test('English by default; messages to other addresses are not returned', async () => {
    await send('riley@example.invalid', [], 'release-token-english-0002');
    const english = sink.to('riley@example.invalid');
    assert.equal(english.length, 1);
    assert.equal(english[0]!.language, 'en');
    assert.deepEqual(sink.to('nobody@example.invalid'), []);
    assert.equal((await fetch(`http://127.0.0.1:${readerPort}/messages`, { method: 'POST' })).status, 404, 'the reader has no write route');
  });

  await t.test('the parser handles the renderer output and refuses non-MIME text', () => {
    assert.equal(parseMessage('no header separator'), null);
    assert.equal(parseMessage('Subject: x\r\n\r\nplain body'), null);
    assert.deepEqual(linksIn('see https://a.example/x and\nhttp://b.example/y?z=1'), ['https://a.example/x', 'http://b.example/y?z=1']);
  });
});

test('QA-002 release overlay keeps the release settings', () => {
  const overlay = read('tests/release/platform/compose.release.yaml');
  const service = (name: string) => {
    const start = overlay.indexOf(`\n  ${name}:\n`);
    assert.ok(start >= 0, `service ${name} in the overlay`);
    const rest = overlay.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  assert.match(service('worker'), /MAIL_TRANSPORT: smtp/);
  assert.match(service('worker'), /MAIL_SMTP_HOST: smtp-sink/);
  assert.match(service('web'), /TRUSTWORK_DEMO_MODE: "0"/);
  for (const name of ['api', 'web']) {
    assert.match(service(name), /TRUSTWORK_JURISDICTION_GATE: (ranges_file|edge_header|upstream_gate)/, `${name}: an explicit, attestable gate mode`);
    assert.doesNotMatch(service(name), /TRUSTWORK_JURISDICTION_GATE: fake/);
  }
  assert.match(service('smtp-sink'), /127\.0\.0\.1:\$\{TRUSTWORK_RELEASE_MAIL_PORT/, 'the mail reader is published on loopback only');
  assert.doesNotMatch(overlay, /^name:/m, 'the runner chooses the project name, never the shared trustwork-local');
  const runner = read('tests/release/platform/run.mjs');
  assert.match(runner, /refusing the shared development project name trustwork-local/);
  assert.match(runner, /'down', '-v', '--remove-orphans'/);
});

test('QA-002 suites exist and the counters read node:test and Playwright output', () => {
  for (const files of Object.values(SUITES)) for (const file of files) assert.ok(existsSync(resolve(REPO, file)), file);
  assert.deepEqual(Object.keys(SUITES), ['negative authorization', 'readiness', 'worker faults']);
  assert.deepEqual(tapCounts('TAP version 13\n# tests 12\n# suites 2\n# pass 11\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n'), { tests: 12, pass: 11, fail: 0, skipped: 1, todo: 0, cancelled: 0 });
  assert.ok(Number.isNaN(tapCounts('').tests), 'no output is not zero tests');
  assert.equal(playwrightCounts(resolve(REPO, 'tests/release/platform/does-not-exist.json')), null);
});

test('QA-002 release document carries the checklist, the gate list and no deployment', () => {
  const doc = read('docs/quality/release/platform.md');
  for (const heading of ['## Release checklist', '## Owner gate list', '## Known limitations', '## Defects found', '## Versioning and tagging plan', '## Provider modes']) assert.ok(doc.includes(heading), heading);
  for (const gate of Object.keys(SUITES)) assert.ok(doc.toLowerCase().includes(gate), `suite gate "${gate}" in the document`);
  assert.match(doc, /No deployment happens in QA-002/);
  const workflow = read('.github/workflows/release-platform.yml');
  assert.match(workflow, /run\.mjs suites/);
  assert.match(workflow, /run\.mjs stack/);
  assert.doesNotMatch(workflow, /railway|docker push|\$\{\{\s*secrets\./i, 'the release workflow deploys and pushes nothing');
});
