import test from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { FORBIDDEN_CONTROL_WORDS } from '@trustwork/contracts';
import { SUPPORT_REQUEST_SCHEMAS } from '../../apps/api/src/modules/support/schemas.js';
import { SupportParticipantController, SupportStaffController } from '../../apps/api/src/modules/support/support.controller.js';
import { AccessExplanationSchema, explainAccess } from '../../apps/api/src/modules/support/explainer.js';
import { SupportAccountCardSchema, toAccountCard } from '../../apps/api/src/modules/support/views.js';
import { ElevationGuard } from '../../apps/api/src/modules/identity/second-factor/elevation.guard.js';
import { IDEMPOTENT_ROUTES } from '../../apps/api/src/common/idempotency/index.js';
import { IDEMPOTENT } from '../../apps/api/src/common/request.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const MODULE = join(ROOT, 'apps/api/src/modules/support');

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) ? [path] : [];
  });
}
function handlers(controller: object): Array<{ key: string; handler: object; method: number | undefined; path: string }> {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const proto = (controller as { prototype: Record<string, unknown> }).prototype;
  return Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor' && typeof proto[k] === 'function').map((key) => {
    const handler = proto[key] as object;
    return { key, handler, method: Reflect.getMetadata('method', handler) as number | undefined, path: `${base}/${(Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? ''}` };
  });
}

/** SUP-001 acceptance: no endpoint issues a session for another person. */
test('no support route or code path creates a session, sets a cookie or acts as another person', () => {
  for (const file of sources(MODULE)) {
    const text = readFileSync(file, 'utf8');
    for (const forbidden of ['createSession', 'setCookie', 'assumePrincipal', 'withPrincipal', 'withoutPrincipal', 'setChallengeCookie', 'set_principal', 'impersonat']) {
      assert.ok(!text.includes(forbidden), `${relative(ROOT, file)} uses ${forbidden}`);
    }
  }
  for (const controller of [SupportStaffController, SupportParticipantController]) {
    for (const { path } of handlers(controller)) assert.ok(!/(impersonat|login-as|log-in-as|act-as|sudo|switch-user|become|session)/i.test(path), path);
  }
});

test('the support module reaches other modules only through identity, common and its data slices; nothing imports it but the composition root', () => {
  for (const file of sources(MODULE)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"](\.\.\/[^'"]+)['"]/g)) {
      const target = match[1] as string;
      assert.ok(/^\.\.\/(identity|\.\.\/(common|deps))\//.test(target) || /^\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/packages\/data\/src\/(repositories|schema)\/(support|admin)\.js$/.test(target),
        `${relative(ROOT, file)} imports ${target}`);
      assert.ok(!target.includes('platform-admin'), `${relative(ROOT, file)} imports platform-admin`);
    }
  }
  const importing: string[] = [];
  for (const file of sources(join(ROOT, 'apps/api/src'))) {
    const rel = relative(ROOT, file);
    if (rel.startsWith('apps/api/src/modules/support/')) continue;
    if (/(?:from|import)\s*\(?\s*['"][^'"]*modules\/support\/[^'"]*['"]/.test(readFileSync(file, 'utf8'))) importing.push(rel);
  }
  assert.deepEqual(importing, ['apps/api/src/app.module.ts']);
});

test('every staff route is behind the elevation guard; every mutation is idempotent and completes in its transaction', () => {
  const guards = (Reflect.getMetadata(GUARDS_METADATA, SupportStaffController) as unknown[] | undefined) ?? [];
  assert.ok(guards.includes(ElevationGuard), 'class-level ElevationGuard');
  // Recorded queries: POST so a query never sits in a URL; repeating one records it again and changes nothing else.
  const QUERIES = new Set(['lookup', 'accountCard', 'explain']);
  let mutations = 0;
  for (const controller of [SupportStaffController, SupportParticipantController]) {
    for (const { key, handler, method } of handlers(controller)) {
      if (method !== 1) continue; // RequestMethod.POST
      if (controller === SupportStaffController && QUERIES.has(key)) {
        assert.equal(Reflect.getMetadata(IDEMPOTENT, handler), undefined, key);
        continue;
      }
      mutations += 1;
      const options = Reflect.getMetadata(IDEMPOTENT, handler) as { action: string } | undefined;
      assert.ok(options, `${controller.name}.${key} is @Idempotent`);
      assert.equal(IDEMPOTENT_ROUTES[options.action]?.kind, 'in_transaction', options.action);
    }
  }
  assert.equal(mutations, 12);
});

function vocabulary(schema: z.ZodType): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === 'object') out.push(...Object.keys(record.properties));
    if (Array.isArray(record.enum)) out.push(...record.enum.filter((v): v is string => typeof v === 'string'));
    if (typeof record.const === 'string') out.push(record.const);
    Object.values(record).forEach(walk);
  };
  walk(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
  return out;
}

test('no support request accepts a ranking weight, score, position, badge or a person to act as', () => {
  let names = 0;
  for (const [name, schema] of Object.entries(SUPPORT_REQUEST_SCHEMAS)) {
    for (const word of vocabulary(schema as z.ZodType)) {
      names += 1;
      assert.ok(!FORBIDDEN_CONTROL_WORDS.test(word), `${name} accepts "${word}"`);
      assert.ok(!/^(actAs|asPerson|impersonate|onBehalfOfPersonId|sessionFor)$/i.test(word), `${name} accepts "${word}"`);
    }
  }
  assert.ok(names > 60, `walked ${names} field names and values`);
  for (const field of ['score', 'actAs', 'sessionFor', 'priority']) {
    assert.equal(SUPPORT_REQUEST_SCHEMAS.PlainCommandSchema.safeParse({ contractVersion: '1.0.0', idempotencyKey: 'k', reason: 'r', [field]: 1 }).success, false, field);
  }
});

test('response schemas are strict allowlists: the card and the explainer refuse any extra field', () => {
  const card = {
    personId: '0b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f', displayName: null, maskedEmail: 'sy***@example.invalid', emailVerified: true, accountState: 'active',
    secondFactor: { enrolled: false, methods: 0 }, activeSessions: 1, recovery: 'none', employer: null, entitlements: [], openCases: 0, consents: [],
  };
  assert.equal(SupportAccountCardSchema.safeParse(card).success, true);
  for (const leak of [{ email: 'synthetic@example.invalid' }, { sessions: [{ ipPrefix: '203.0.113.0/24' }] }, { passwordHash: 'x' }, { totpSecret: 'x' }, { projects: [] }]) {
    assert.equal(SupportAccountCardSchema.safeParse({ ...card, ...leak }).success, false, Object.keys(leak)[0]);
  }
  assert.throws(() => toAccountCard({ ...card, maskedEmail: 'synthetic@example.invalid' }), 'an unmasked address fails the response');
  assert.equal(AccessExplanationSchema.safeParse({ effect: 'deny', capability: 'read.shared', reason: 'no_participation', disclose: 'not_found', participationId: card.personId }).success, false);
  assert.equal(AccessExplanationSchema.safeParse({ effect: 'allow', capability: 'read.shared', projection: 'shared_party', basis: ['participation'], basisIds: [card.personId] }).success, false);
});

test('explainer (pure): unverified e-mail, owner and company permission reasons map from the identity policy', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const person = '0b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f';
  const company = '1b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f';
  const resource = { kind: 'project' as const, id: '2b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f' };
  const base = { emailVerified: true, authzEpoch: 1, membership: null, endedCompanies: [], owner: null, rows: [] };
  assert.deepEqual(explainAccess(person, { ...base, emailVerified: false }, resource, 'negotiate', now), { effect: 'deny', capability: 'negotiate', reason: 'email_unverified', disclose: 'forbidden' });
  assert.deepEqual(explainAccess(person, { ...base, owner: { kind: 'person', id: person } }, resource, 'read.owner_private', now), { effect: 'allow', capability: 'read.owner_private', projection: 'owner_private', basis: ['owner'] });
  const member = { companyId: company, membershipId: '3b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f', role: 'member' as const, permissions: [], companyAuthzEpoch: 1 };
  assert.deepEqual(explainAccess(person, { ...base, membership: member, owner: { kind: 'company', id: company } }, resource, 'read.shared', now),
    { effect: 'deny', capability: 'read.shared', reason: 'membership_permission_missing', disclose: 'not_found' });
  assert.deepEqual(explainAccess(person, { ...base, endedCompanies: [company], owner: { kind: 'company', id: company } }, resource, 'read.shared', now),
    { effect: 'deny', capability: 'read.shared', reason: 'membership_ended', disclose: 'not_found' });
});
