import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DEVELOPMENT_MAIL_SECRET_KEY, deriveMailSecretKey, mailSecretKeyFromEnv, MailSecretError, sealMailSecret, unsealMailSecret } from '@trustwork/data';
import {
  asciiAddress, deliveryIdFromMessageId, encodeHeaderText, mailConfigFromEnv, MailOutcomeUnknownError, MailRejectedError, MailTemporaryError, parseFeedback,
  redactAddresses, renderMime, SmtpTransport, type OutgoingMail, type SmtpConfig,
} from '../../../apps/worker/src/mail/index.js';
import { requestLocales } from '../../../apps/api/src/modules/identity/mail.js';
import { parseMessage, SmtpSink } from './helpers/smtp-sink.js';

const mail = (overrides: Partial<OutgoingMail> = {}): OutgoingMail => ({
  messageId: '0b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f@hub.example',
  idempotencyKey: 'job:1',
  from: { address: 'no-reply@hub.example', name: 'Trustwork' },
  replyTo: null,
  to: 'reader@example.test',
  subject: 'Confirm your email address',
  text: 'Hello,\n.leading dot line\nhttps://hub.example/verify-email/abc\n',
  html: '<p>Hello</p>',
  locale: 'en',
  headers: { 'X-Entity-Ref-ID': '0b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f' },
  ...overrides,
});
const smtp = (port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1', port, security: 'none', auth: null, clientName: 'worker.test', connectTimeoutMs: 400, commandTimeoutMs: 400, dataTimeoutMs: 400, ...overrides,
});
const signal = () => new AbortController().signal;

test('MAIL-001 MIME rendering', async (t) => {
  await t.test('UTF-8 subjects and display names become encoded words; parts round-trip; Message-ID and automatic-mail headers', () => {
    const subject = 'Подтвердите адрес электронной почты для сервиса';
    const raw = renderMime(mail({ subject, from: { address: 'no-reply@hub.example', name: 'გამარჯობა' }, text: 'Plain ტექსტი' }), new Date('2026-10-31T10:00:00Z'));
    assert.ok(raw.split('\r\n').every((line) => line.length <= 998), 'line length');
    const parsed = parseMessage(raw);
    assert.equal(parsed.subject, subject);
    assert.equal(parsed.text, 'Plain ტექსტი');
    assert.equal(parsed.headers.get('message-id'), '<0b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f@hub.example>');
    assert.equal(parsed.headers.get('auto-submitted'), 'auto-generated');
    assert.equal(parsed.headers.get('content-language'), 'en');
    assert.equal(parsed.headers.get('date'), 'Sat, 31 Oct 2026 10:00:00 +0000');
    assert.match(parsed.headers.get('from') ?? '', /^=\?UTF-8\?B\?.+\?= <no-reply@hub\.example>$/);
  });

  await t.test('header injection and non-ASCII local parts are refused; IDN domains become punycode', () => {
    assert.throws(() => renderMime(mail({ subject: 'x\r\nBcc: victim@example.test' })));
    assert.throws(() => renderMime(mail({ to: 'a@b.test\r\nBcc: c@d.test' })));
    assert.throws(() => asciiAddress('иван@example.test'));
    assert.equal(asciiAddress('user@bücher.example'), 'user@xn--bcher-kva.example');
    assert.equal(encodeHeaderText('plain ascii'), 'plain ascii');
  });
});

test('MAIL-001 SMTP transport against a local sink', async (t) => {
  const sink = await new SmtpSink().start();
  t.after(() => sink.stop());
  t.beforeEach(() => {
    sink.mode = 'ok';
    sink.auth = null;
    sink.rejectRecipients.clear();
  });

  await t.test('accepted: the sink receives the exact message (a leading dot survives); the queue id is the provider reference', async () => {
    const before = sink.messages.length;
    const receipt = await new SmtpTransport(smtp(sink.port)).send(mail(), signal());
    assert.match(receipt.providerMessageId ?? '', /^SINK\d+$/);
    const received = sink.messages[before]!;
    assert.deepEqual(received.to, ['reader@example.test']);
    assert.equal(received.from, 'no-reply@hub.example');
    assert.equal(parseMessage(received.raw).text, mail().text, 'the body survives transfer');
  });

  await t.test('AUTH PLAIN is used on loopback when configured; wrong credentials are a permanent refusal', async () => {
    sink.auth = { user: 'relay', password: 'local-test-only' };
    await new SmtpTransport(smtp(sink.port, { auth: { user: 'relay', password: 'local-test-only' } })).send(mail(), signal());
    await assert.rejects(new SmtpTransport(smtp(sink.port, { auth: { user: 'relay', password: 'wrong' } })).send(mail(), signal()), (e: unknown) => e instanceof MailRejectedError && e.code === 535);
    assert.throws(() => new SmtpTransport(smtp(sink.port, { host: 'relay.example', auth: { user: 'u', password: 'p' } })), /without TLS/);
  });

  await t.test('550 at RCPT: rejected, the address itself refused; 451: temporary; 554 after DATA: rejected', async () => {
    sink.rejectRecipients.add('gone@example.test');
    await assert.rejects(new SmtpTransport(smtp(sink.port)).send(mail({ to: 'gone@example.test' }), signal()), (e: unknown) => e instanceof MailRejectedError && e.recipientRejected && e.code === 550);
    sink.mode = 'tempfail_rcpt';
    await assert.rejects(new SmtpTransport(smtp(sink.port)).send(mail(), signal()), (e: unknown) => e instanceof MailTemporaryError && e.code === 451);
    sink.mode = 'reject_data';
    await assert.rejects(new SmtpTransport(smtp(sink.port)).send(mail(), signal()), (e: unknown) => e instanceof MailRejectedError && !e.recipientRejected);
  });

  await t.test('a server that never greets: temporary (nothing was sent) within the connect timeout', async () => {
    sink.mode = 'stall_greeting';
    const started = Date.now();
    await assert.rejects(new SmtpTransport(smtp(sink.port)).send(mail(), signal()), MailTemporaryError);
    assert.ok(Date.now() - started < 2000);
  });

  await t.test('a server that swallows the body and never answers: outcome unknown, never a retryable error', async () => {
    sink.mode = 'stall_after_data';
    await assert.rejects(new SmtpTransport(smtp(sink.port)).send(mail(), signal()), MailOutcomeUnknownError);
  });

  await t.test('abort before the body is temporary; a refused connection is temporary; STARTTLS required but absent is temporary', async () => {
    sink.mode = 'stall_greeting';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(new SmtpTransport(smtp(sink.port, { connectTimeoutMs: 5000 })).send(mail(), controller.signal), MailTemporaryError);
    sink.mode = 'ok';
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await assert.rejects(new SmtpTransport(smtp(port)).send(mail(), signal()), MailTemporaryError);
    await assert.rejects(new SmtpTransport(smtp(sink.port, { security: 'starttls' })).send(mail(), signal()), (e: unknown) => e instanceof MailTemporaryError && /STARTTLS/.test(e.message));
  });
});

test('MAIL-001 configuration guards, sealing, language parsing and feedback parsing', async (t) => {
  await t.test('production refuses the log transport, a missing or development key, plain-HTTP links and clear-text relays', () => {
    const key = 'ab'.repeat(32);
    const prod = { NODE_ENV: 'production', MAIL_SECRET_KEY: key, MAIL_PUBLIC_ORIGIN: 'https://hub.example', MAIL_FROM_ADDRESS: 'no-reply@hub.example' };
    assert.equal(mailConfigFromEnv(prod).transport, 'fake');
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_TRANSPORT: 'log' }), /not allowed/);
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_SECRET_KEY: undefined }), /MAIL_SECRET_KEY is required/);
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_SECRET_KEY: DEVELOPMENT_MAIL_SECRET_KEY.toString('hex') }), /development key/);
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_SECRET_KEY: 'abcd' }), /at least 32 bytes/);
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_PUBLIC_ORIGIN: 'http://hub.example' }), /https/);
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_TRANSPORT: 'smtp' }), /MAIL_SMTP_HOST/);
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_TRANSPORT: 'smtp', MAIL_SMTP_HOST: 'relay.example', MAIL_SMTP_SECURITY: 'none' }), /loopback/);
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_TRANSPORT: 'smtp', MAIL_SMTP_HOST: 'relay.example', MAIL_SMTP_USER: 'u' }), /go together/);
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_LOCALES: 'en,pl' }), /no mail dictionary for pl/);
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_DEFAULT_LOCALE: 'ka', MAIL_LOCALES: 'en' }), /MAIL_DEFAULT_LOCALE/);
    assert.throws(() => mailConfigFromEnv({ ...prod, TRUSTWORK_BRAND: 'unknown' }), /unknown brand overlay/);
    assert.throws(() => mailConfigFromEnv({ ...prod, MAIL_LINK_RECOVERY: 'https://evil.example/x' }), /path/);
    const smtpConfig = mailConfigFromEnv({ ...prod, MAIL_TRANSPORT: 'smtp', MAIL_SMTP_HOST: 'relay.example', MAIL_SMTP_USER: 'u', MAIL_SMTP_PASSWORD: 'p' });
    assert.equal(smtpConfig.smtp?.security, 'starttls');
    assert.equal(smtpConfig.smtp?.port, 587);
    assert.equal(smtpConfig.render.brandOverlay, 'stroyreputation-ru');
    assert.equal(mailConfigFromEnv({ ...prod, TRUSTWORK_BRAND: 'none' }).render.brandOverlay, null);
    assert.ok(mailSecretKeyFromEnv({}).equals(DEVELOPMENT_MAIL_SECRET_KEY), 'outside production the API and the worker agree without setup');
  });

  await t.test('a sealed token opens only with the same key and the same delivery id', () => {
    const key = deriveMailSecretKey(Buffer.alloc(32, 7));
    const sealed = sealMailSecret(key, 'delivery-a', 'one-time-token');
    assert.ok(!sealed.includes(Buffer.from('one-time-token')), 'ciphertext, not the token');
    assert.equal(unsealMailSecret(key, 'delivery-a', sealed), 'one-time-token');
    assert.throws(() => unsealMailSecret(key, 'delivery-b', sealed), MailSecretError);
    assert.throws(() => unsealMailSecret(deriveMailSecretKey(Buffer.alloc(32, 8)), 'delivery-a', sealed), MailSecretError);
    const tampered = Buffer.from(sealed);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 1, tampered.length - 1);
    assert.throws(() => unsealMailSecret(key, 'delivery-a', tampered), MailSecretError);
  });

  await t.test('Accept-Language becomes sanitised preferences, best first', () => {
    assert.deepEqual(requestLocales('ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'), ['ru-RU', 'ru', 'en-US', 'en']);
    assert.deepEqual(requestLocales('ka;q=0.5, hy'), ['hy', 'ka']);
    assert.deepEqual(requestLocales('uz-latn, *;q=0.1, en;q=0'), ['uz-Latn']);
    assert.deepEqual(requestLocales('<script>, x-klingon, ru;q=abc'), []);
    assert.deepEqual(requestLocales(undefined), []);
    assert.equal(requestLocales(Array.from({ length: 20 }, (_, i) => `en-${String(100 + i)}`).join(',')).length, 6);
  });

  await t.test('feedback events are validated; Message-IDs map back to deliveries; addresses never reach error text', () => {
    const id = '0b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f';
    assert.deepEqual(parseFeedback({ provider: 'smtp', eventId: 'evt-1', kind: 'bounce', bounce: 'hard', deliveryId: id }), { provider: 'smtp', eventId: 'evt-1', kind: 'bounce', bounce: 'hard', deliveryId: id });
    assert.throws(() => parseFeedback({ provider: 'smtp', eventId: 'evt-1', kind: 'bounce', deliveryId: id }), /hard or soft/);
    assert.throws(() => parseFeedback({ provider: 'SMTP!', eventId: 'evt-1', kind: 'delivered', deliveryId: id }));
    assert.throws(() => parseFeedback({ provider: 'smtp', eventId: 'evt 1', kind: 'delivered', deliveryId: id }));
    assert.throws(() => parseFeedback({ provider: 'smtp', eventId: 'evt-1', kind: 'opened', deliveryId: id }), /kind/);
    assert.equal(deliveryIdFromMessageId(`<${id}@hub.example>`), id);
    assert.equal(deliveryIdFromMessageId('<other@hub.example>'), null);
    assert.equal(redactAddresses('RCPT: 550 5.1.1 <gone@example.test>: Recipient address rejected'), 'RCPT: 550 5.1.1 <<address>>: Recipient address rejected');
  });
});
