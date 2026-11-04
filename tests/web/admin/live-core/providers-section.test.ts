import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CreateConnectionCommandSchema, RecordModelPricingCommandSchema, SetEgressRuleCommandSchema } from '../../../../packages/contracts/src/providers.js';
import { RegisterCredentialCommandSchema } from '../../../../packages/contracts/src/hub-core.js';
import { providerRefusal, readProviders } from '../../../../apps/web/app/admin/_data/live-providers.js';
import { connectionDraft, credentialDraft, egressCell, pricingDraft, PROVIDER_COMMANDS, providerFormProblem } from '../../../../apps/web/app/admin/hubs/[hub]/integrations/providers/_commands.js';

/** The pure parts of HC-100 and HC-102 on the live API, and where a secret can and cannot go. */
const HUB = '11111111-1111-4111-8111-111111111111';
const OTHER_HUB = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-11-04T12:00:00.000Z');
const envelope = { contractVersion: '1.0.0', idempotencyKey: 'synthetic-key-0001', reason: 'Synthetic' };
const form = { currency: 'USD', now: NOW };
const orNothing = async <T>(read: Promise<T>) => read;
const FOLDER = 'apps/web/app/admin/hubs/[hub]/integrations/providers';

test('what the forms send is what the strict API schemas accept', () => {
  const connection = { label: 'Synthetic', adapterId: 'synthetic_vendor', mode: 'manual', 'cap.llm': 'on', 'cap.ocr': 'on', hostingKind: 'vendor', hostingCountry: 'us', zeroRetention: 'on', storageCountry: 'us', region: 'us-east-1', endpoint: 'https://vendor.example.org/v1' };
  const parsed = CreateConnectionCommandSchema.parse({ ...envelope, ...connectionDraft(connection) });
  assert.deepEqual(parsed.capabilities, ['llm', 'ocr']);
  assert.deepEqual(parsed.hosting, { kind: 'vendor', country: 'US', zeroRetention: true, trainsOnInputs: false, broker: false });
  assert.deepEqual(CreateConnectionCommandSchema.parse({ ...envelope, ...connectionDraft({ ...connection, hostingKind: 'self_hosted', endpoint: '' }) }).hosting, { kind: 'self_hosted', country: 'US' });
  assert.equal(RegisterCredentialCommandSchema.parse({ ...envelope, ...credentialDraft({ credProvider: 'synthetic_reg', credAdapter: 'synthetic_api', credMode: 'live', credStore: 'env', credRef: 'env:SYNTHETIC' }) }).secret.ref, 'env:SYNTHETIC');
  const pricing = pricingDraft({ priceConnection: ID, priceModel: 'model-1', priceInput: '0.15', priceOutput: '', priceBasis: 'measured', priceNote: '' }, form);
  assert.equal(RecordModelPricingCommandSchema.parse({ ...envelope, ...pricing }).observedAt, NOW.toISOString());
  assert.equal(SetEgressRuleCommandSchema.parse({ ...envelope, approvalId: null, ...egressCell({ egressConnection: ID, egressClass: 'public', egressDecision: 'allow' }) }).requireInResidency, false);
});

test('allowing non-public data always carries both requirements, whatever the form says', () => {
  assert.deepEqual(egressCell({ egressConnection: ID, egressClass: 'person_private', egressDecision: 'allow' }), { connectionId: ID, dataClass: 'person_private', decision: 'allow', requireInResidency: true, requireZeroRetention: true });
  assert.deepEqual(egressCell({ egressConnection: ID, egressClass: 'person_private', egressDecision: 'deny' }), { connectionId: ID, dataClass: 'person_private', decision: 'deny', requireInResidency: false, requireZeroRetention: false });
});

test('a form that cannot be right never leaves the console', () => {
  const problem = (command: Parameters<typeof providerFormProblem>[0], fields: Record<string, string>) => providerFormProblem(command, fields, form);
  const connection = { label: 'Synthetic', adapterId: 'synthetic_fake', mode: 'fake', 'cap.llm': 'on', hostingKind: 'self_hosted', hostingCountry: 'US' };
  assert.equal(problem('providers.connection_create', connection), null);
  assert.deepEqual(problem('providers.connection_create', { ...connection, adapterId: 'Bad Name' }), { field: 'adapterId' });
  assert.deepEqual(problem('providers.connection_create', { ...connection, 'cap.llm': '' }), { field: 'capabilities' });
  assert.deepEqual(problem('providers.connection_create', { ...connection, hostingCountry: 'Georgia' }), { field: 'hostingCountry' });
  assert.deepEqual(problem('providers.connection_create', { ...connection, credentialRefId: ID }), { field: 'credentialRefId' }, 'a fake holds no credential');
  assert.deepEqual(problem('providers.connection_create', { ...connection, endpoint: 'ftp://vendor.example.org' }), { field: 'endpoint' });
  assert.deepEqual(problem('providers.credential_register', { credProvider: 'p_x', credAdapter: 'a_x', credMode: 'live', credStore: 'envelope_db', credRef: 'x' }), { field: 'credStore' }, 'the sealed store is written only by the secret route');
  assert.deepEqual(problem('providers.kill_release', { killSwitchId: ID, incidentNote: '  ' }), { field: 'incidentNote' });
  assert.deepEqual(problem('providers.connection_test', { connectionId: 'x' }), { field: 'connectionId' });
  assert.deepEqual(problem('providers.pricing_record', { priceConnection: ID, priceModel: 'm', priceInput: '-1', priceBasis: 'contract' }), { field: 'priceInput' });
});

test('a refusal keeps its reason; a stale page is called stale', () => {
  const code = (answer: Parameters<typeof providerRefusal>[0]) => { const o = providerRefusal(answer); return o.status === 'rejected' ? [o.code, o.detail] : o.status; };
  const refused = (reason: string) => ({ status: 400, code: 'validation.schema', body: { details: { reason } } });
  assert.equal(code({ status: 404, code: 'access.not_found' }), 'not_found');
  assert.deepEqual(code({ status: 401, code: 'auth.session_invalid' }), ['elevation_required', []]);
  assert.deepEqual(code({ status: 403, code: 'access.forbidden' }), ['denied', []]);
  assert.deepEqual(code({ status: 403, code: 'access.second_approver_required', body: { details: { reason: 'self_approval' } } }), ['own_request', []]);
  assert.deepEqual(code({ status: 403, code: 'access.second_approver_required', body: { details: { reason: 'not_requester' } } }), ['second_person_pending', []]);
  assert.deepEqual(code({ status: 409, code: 'validation.revision_conflict', body: { details: { reason: 'revision_conflict' } } }), ['stale', []]);
  assert.deepEqual(code(refused('egress_training')), ['provider_reason', ['egress_training']]);
  assert.deepEqual(code(refused('restricted_place')), ['provider_reason', ['restricted_place']]);
  assert.deepEqual(code({ status: 400, code: 'validation.schema' }), ['invalid', []]);
});

test('a secret value has one way in: the browser to the write-only route, past no server action and no console field', () => {
  const entry = readFileSync(`${FOLDER}/SecretEntry.tsx`, 'utf8');
  assert.match(entry, /^'use client';/, 'it runs in the browser');
  assert.match(entry, /<input id=\{id\} name="secret" type="password"/, 'a native input: its name has no `f.` prefix, so the console action would not collect it');
  assert.doesNotMatch(entry, /submitConsoleCommand|ConsoleForm|useActionState|PasswordField|value=\{/, 'no server action, no controlled field and no state holds the value');
  assert.doesNotMatch(entry, /console\.|localStorage|sessionStorage/);
  for (const file of [`${FOLDER}/_commands.ts`, 'apps/web/app/admin/_data/live-providers.ts']) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\/secret['"`]|f\.value|\bvalue:\s*f\b/, `${file} sends no secret`);
  }
  for (const command of PROVIDER_COMMANDS) assert.doesNotMatch(command, /secret_(write|submit|set)/, 'no console command writes a secret');
});

test('the view keeps references and state: nothing else an API row might carry reaches a page', async () => {
  const connection = {
    id: ID, hubId: HUB, adapterId: 'synthetic_x', label: 'Synthetic', capabilities: ['llm'], mode: 'manual', endpoint: null, hosting: { kind: 'self_hosted', country: 'US' }, storageCountry: null, region: null, inHubResidency: true, status: 'draft',
    secret: { source: 'envelope', credentialRefId: null, versions: [{ ref: { id: ID, store: 'envelope_db', ref: 'envelope:1', keyedFingerprint: 'abcdefabcdef', version: 1, createdAt: NOW.toISOString(), createdBy: ME, rotatedAt: null, lastUsedAt: null, ciphertext: 'SEALED-BYTES' }, status: 'active', graceUntil: null, destroyedAt: null }] },
    lastTest: null, killSwitchId: null, revision: 1, enable: null, wrappedKey: 'WRAPPED-KEY',
  };
  const get = async (path: string) => {
    if (path.endsWith('/providers/connections')) return { items: [connection, { ...connection, id: ME, hubId: OTHER_HUB }] };
    if (path.endsWith('/credentials')) return { items: [{ id: ID, provider: 'p', adapter: 'a', mode: 'live', secret: { store: 'env', ref: 'env:NAME' }, status: 'active', revision: 1, activation: null, value: 'A-VALUE' }] };
    return null;
  };
  const view = await readProviders({ get }, orNothing, HUB, ME, NOW);
  assert.deepEqual(view?.connections.map((c) => c.id), [ID], "another hub's connection is dropped");
  const text = JSON.stringify(view);
  for (const leak of ['SEALED-BYTES', 'WRAPPED-KEY', 'A-VALUE']) assert.ok(!text.includes(leak), leak);
  assert.ok(text.includes('abcdefabcdef') && text.includes('env:NAME'), 'the fingerprint and the reference are what staff see');
  assert.deepEqual([view?.costs, view?.egress, view?.egressReview], [null, null, null], 'an unreadable list is null, never empty');
  assert.equal(await readProviders({ get: async () => null }, orNothing, HUB, ME, NOW), null);
});
