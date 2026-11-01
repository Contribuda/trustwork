import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { z } from 'zod';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { FORBIDDEN_CONTROL_WORDS } from '@trustwork/contracts';
import * as providers from '../../packages/contracts/src/providers.js';
import { PROVIDER_REASON_CODES } from '../../packages/contracts/src/providers.js';
import { ProvidersController } from '../../apps/api/src/modules/providers/providers.controller.js';
import { ElevationGuard } from '../../apps/api/src/modules/identity/second-factor/elevation.guard.js';
import { FakeProviderAdapter, ProviderAdapterRegistry } from '../../apps/api/src/modules/providers/adapters.js';
import {
  ExternalSecretReader, FakeKms, FakeVault, kmsSecretSealer, LocalKeyEncryption, parseKek, SecretSealer, SecretStoreError, SecretValue, secretSealerFromEnv,
} from '../../apps/api/src/modules/providers/secret-store.js';
import { IDEMPOTENT_ROUTES } from '../../apps/api/src/common/idempotency/routes.js';
import { IDEMPOTENT } from '../../apps/api/src/common/request.js';

const LOCALES = ['en', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn', 'es'];

test('secret store: envelope encryption round trip, keyed fingerprints, no plaintext in the sealed form', async () => {
  const kek = randomBytes(32);
  const local = new LocalKeyEncryption(kek);
  const sealer = new SecretSealer(local, local.fingerprintKey());
  const value = new SecretValue(`sk-synthetic-${randomBytes(16).toString('hex')}`);
  const sealed = await sealer.seal(value);
  assert.match(sealed.fingerprint, /^[a-f0-9]{12}$/);
  assert.equal(sealed.fingerprint, sealer.fingerprint(value), 'the fingerprint is stable for a value');
  assert.notEqual(sealed.fingerprint, sealer.fingerprint(new SecretValue('another-synthetic-value')));
  assert.equal(sealed.iv.length, 12);
  assert.equal(sealed.authTag.length, 16);
  for (const part of [sealed.ciphertext, sealed.wrappedKey]) assert.ok(!part.toString('latin1').includes(value.reveal()), 'no plaintext in the sealed parts');
  assert.equal((await sealer.open(sealed)).reveal(), value.reveal());
  // Two seals of one value differ (fresh data key and IV each time).
  const again = await sealer.seal(value);
  assert.notDeepEqual(again.ciphertext, sealed.ciphertext);
  // Tampering fails closed; another KEK cannot open it.
  await assert.rejects(sealer.open({ ...sealed, ciphertext: Buffer.concat([sealed.ciphertext.subarray(0, -1), Buffer.from([sealed.ciphertext.at(-1)! ^ 1])]) }));
  const other = new LocalKeyEncryption(randomBytes(32));
  await assert.rejects(new SecretSealer(other, other.fingerprintKey()).open(sealed), (e: unknown) => e instanceof SecretStoreError && e.code === 'kek_mismatch');
  // The value never renders.
  assert.equal(String(value), '[secret]');
  assert.equal(JSON.stringify({ value }), '{"value":"[secret]"}');
  assert.equal(inspect({ value }), '{ value: [secret] }');
});

test('secret store: an external KMS adapter interface with a fake, and credential references outside the database', async () => {
  const kms = new FakeKms('synthetic-key');
  const sealer = kmsSecretSealer(kms, randomBytes(32));
  const sealed = await sealer.seal(new SecretValue('synthetic-kms-protected-value'));
  assert.equal(sealed.kekId, 'kms:synthetic-key');
  assert.equal((await sealer.open(sealed)).reveal(), 'synthetic-kms-protected-value');
  assert.deepEqual(kms.calls, ['encrypt', 'decrypt']);

  const reader = new ExternalSecretReader({ SYNTHETIC_PROVIDER_KEY: 'synthetic-env-value' }, new FakeVault({ 'kv/synthetic': 'synthetic-vault-value' }));
  assert.equal((await reader.read('env', 'SYNTHETIC_PROVIDER_KEY')).reveal(), 'synthetic-env-value');
  assert.equal((await reader.read('external_vault', 'kv/synthetic')).reveal(), 'synthetic-vault-value');
  await assert.rejects(reader.read('env', 'lower_case'), (e: unknown) => e instanceof SecretStoreError && e.code === 'ref_invalid');
  await assert.rejects(reader.read('file', '../etc/passwd'), (e: unknown) => e instanceof SecretStoreError && e.code === 'ref_invalid');
  await assert.rejects(reader.read('external_kms', 'kv/missing'), SecretStoreError);
});

test('secret store: a KEK from the environment; placeholders and missing keys leave the store unconfigured', () => {
  assert.equal(parseKek(undefined), null);
  assert.equal(parseKek('change_me'), null);
  assert.equal(parseKek('0'.repeat(64)), null);
  assert.equal(parseKek('a'.repeat(64)), null);
  assert.equal(parseKek('short'), null);
  assert.equal(parseKek(randomBytes(32).toString('hex'))?.length, 32);
  assert.equal(parseKek(randomBytes(32).toString('base64'))?.length, 32);
  assert.equal(secretSealerFromEnv({}), null);
  assert.ok(secretSealerFromEnv({ TRUSTWORK_KEK: randomBytes(32).toString('hex') }) instanceof SecretSealer);
});

test('adapters: fakes for fake mode, nothing live unless registered', async () => {
  const registry = new ProviderAdapterRegistry();
  assert.equal(registry.resolve('openai', 'fake').adapter?.id, 'fake');
  assert.equal(registry.resolve('register_manual', 'manual').adapter?.id, 'manual');
  assert.deepEqual(registry.resolve('openai', 'live'), { adapter: null, reason: 'adapter_unavailable' });
  const fake = new FakeProviderAdapter('openai_compatible');
  registry.register(fake);
  assert.equal(registry.resolve('openai_compatible', 'live').adapter, fake);
  assert.throws(() => registry.register(new FakeProviderAdapter('fake')));
  const report = await fake.test({ probes: providers.syntheticProbesFor(['llm']), endpoint: null, secret: null });
  assert.equal(report.outcome, 'ok');
});

/** Every property name and enum value a request schema accepts (JSON Schema walk). */
function vocabulary(schema: z.ZodType): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === 'object') out.push(...Object.keys(record.properties));
    if (Array.isArray(record.enum)) out.push(...record.enum.filter((v): v is string => typeof v === 'string'));
    Object.values(record).forEach(walk);
  };
  walk(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
  return out;
}

test('boundaries: no providers command accepts a ranking word; staff routes are elevated; mutations are idempotent except the secret', () => {
  const commands = Object.entries(providers).filter(([name, v]) => /CommandSchema$/.test(name) && v instanceof z.ZodType) as [string, z.ZodType][];
  assert.ok(commands.length >= 14);
  for (const [name, schema] of commands) for (const word of vocabulary(schema)) assert.ok(!FORBIDDEN_CONTROL_WORDS.test(word), `${name} accepts "${word}"`);
  const guards = (Reflect.getMetadata(GUARDS_METADATA, ProvidersController) as unknown[] | undefined) ?? [];
  assert.ok(guards.includes(ElevationGuard), 'class-level ElevationGuard');
  const unrecorded: string[] = [];
  for (const key of Object.getOwnPropertyNames(ProvidersController.prototype)) {
    const handler = (ProvidersController.prototype as unknown as Record<string, unknown>)[key];
    if (typeof handler !== 'function' || key === 'constructor') continue;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
    assert.ok(!FORBIDDEN_CONTROL_WORDS.test(path), path);
    if (Reflect.getMetadata('method', handler) !== 1) continue; // RequestMethod.POST
    const options = Reflect.getMetadata(IDEMPOTENT, handler) as { action: string } | undefined;
    if (!options) unrecorded.push(key);
    else assert.equal(IDEMPOTENT_ROUTES[options.action]?.kind, 'in_transaction', options.action);
  }
  assert.deepEqual(unrecorded.sort(), ['explain', 'submitSecret'], 'only the secret (never recorded) and the read-only preview are not idempotent');
});

test('no network code: the providers module makes no outbound call of its own', () => {
  const dir = join(process.cwd(), 'apps/api/src/modules/providers');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.ok(!/\bfetch\(|node:https?|from 'undici'|axios|XMLHttpRequest/.test(text), `${file} makes no outbound call`);
  }
  const worker = readFileSync(join(process.cwd(), 'apps/worker/src/providers/index.ts'), 'utf8');
  assert.ok(!/\bfetch\(|node:https?/.test(worker));
});

test('locales: every reason code, test outcome, scope and data class is explained in all seven engine languages', () => {
  const load = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), 'apps/web/locales', locale, 'providers.json'), 'utf8')) as { providers: Record<string, Record<string, string>> };
  const en = load('en').providers;
  const groups: Record<string, readonly string[]> = {
    reasons: PROVIDER_REASON_CODES,
    testOutcomes: ['ok', 'auth_failed', 'unreachable', 'rate_limited', 'quota_exceeded', 'residency_mismatch', 'model_missing', 'error'],
    routeScopes: ['job', 'module', 'extension'],
    dataClasses: ['public', 'person_private', 'company_private', 'project_restricted', 'deal_party_private'],
    secretStatus: ['active', 'grace', 'destroyed'],
    capState: ['ok', 'alert', 'exhausted'],
  };
  for (const locale of LOCALES) {
    const messages = load(locale).providers;
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort(), `${locale}: same groups`);
    for (const [group, keys] of Object.entries(groups)) {
      for (const key of keys) assert.ok(typeof messages[group]?.[key] === 'string' && messages[group]![key]!.length > 0, `${locale}: providers.${group}.${key}`);
      assert.deepEqual(Object.keys(messages[group] ?? {}).sort(), Object.keys(en[group] ?? {}).sort(), `${locale}: providers.${group} has exactly the English keys`);
    }
    if (locale !== 'ru') assert.ok(!/[Ѐ-ӿ]/.test(JSON.stringify(messages)), `${locale}: no Cyrillic outside the Russian file`);
  }
});
