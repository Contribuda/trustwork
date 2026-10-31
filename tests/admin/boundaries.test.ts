import test from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { FORBIDDEN_CONTROL_WORDS } from '@trustwork/contracts';
import { ADMIN_REQUEST_SCHEMAS } from '../../apps/api/src/modules/platform-admin/schemas.js';
import { AdminStaffController, ModerationParticipantController } from '../../apps/api/src/modules/platform-admin/platform-admin.controller.js';
import { ElevationGuard } from '../../apps/api/src/modules/identity/second-factor/elevation.guard.js';
import { IDEMPOTENT_ROUTES } from '../../apps/api/src/common/idempotency/index.js';
import { IDEMPOTENT } from '../../apps/api/src/common/request.js';

const ROOT = new URL('../../', import.meta.url).pathname;

function sources(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.next')) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

/** ADM-001 acceptance: "No module imports platform-admin." Only the composition root mounts it. */
test('no module imports platform-admin; only the composition root mounts it', () => {
  const importing: string[] = [];
  for (const base of ['apps/api/src', 'apps/worker/src', 'apps/web', 'packages']) {
    for (const file of sources(join(ROOT, base))) {
      const rel = relative(ROOT, file);
      if (rel.startsWith('apps/api/src/modules/platform-admin/')) continue;
      const text = readFileSync(file, 'utf8');
      if (/(?:from|import)\s*\(?\s*['"][^'"]*platform-admin[^'"]*['"]/.test(text)) importing.push(rel);
    }
  }
  assert.deepEqual(importing, ['apps/api/src/app.module.ts']);
  // The module itself reaches other modules only through identity (sessions, elevation) and its own ports.
  const own = sources(join(ROOT, 'apps/api/src/modules/platform-admin'));
  for (const file of own) {
    for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"](\.\.\/[^'"]+)['"]/g)) {
      const target = match[1] as string;
      assert.ok(/^\.\.\/(identity|\.\.\/(common|deps))\//.test(target) || /^\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/packages\/data\/src\/(repositories|schema)\/admin\.js$/.test(target),
        `${relative(ROOT, file)} imports ${target}`);
    }
  }
});

/** Every property name and enum value a request schema of the module accepts (JSON Schema walk). */
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

/** ADM-001 acceptance: "No endpoint accepts a ranking weight, score, position or badge." */
test('no administration endpoint accepts a ranking weight, score, position or badge', () => {
  let names = 0;
  for (const [name, schema] of Object.entries(ADMIN_REQUEST_SCHEMAS)) {
    for (const word of vocabulary(schema)) {
      names += 1;
      assert.ok(!FORBIDDEN_CONTROL_WORDS.test(word), `${name} accepts "${word}"`);
    }
  }
  assert.ok(names > 100, `walked ${names} field names and values`);
  // Strict objects: an extra ranking field is refused, never ignored.
  const sample = ADMIN_REQUEST_SCHEMAS.DecideModerationCaseCommandSchema as z.ZodType;
  for (const field of ['score', 'rank', 'position', 'badge', 'weight', 'boost', 'featured']) {
    const parsed = sample.safeParse({ contractVersion: '1.0.0', idempotencyKey: 'k', reason: 'r', decision: 'warning', [field]: 1 });
    assert.equal(parsed.success, false, field);
  }
  // Route paths carry none of the words either.
  for (const controller of [AdminStaffController, ModerationParticipantController]) {
    const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
    for (const key of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as unknown as Record<string, unknown>)[key];
      if (typeof handler !== 'function' || key === 'constructor') continue;
      const path = `${base}/${(Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? ''}`;
      assert.ok(!FORBIDDEN_CONTROL_WORDS.test(path.replace(/\/v1\//, '/')), path);
    }
  }
});

/** No impersonation: no route of the whole API issues a session for, or acts as, another person. */
test('no route anywhere in the API impersonates a person', () => {
  const offenders: string[] = [];
  for (const file of sources(join(ROOT, 'apps/api/src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/@(?:Controller|Get|Post|Put|Patch|Delete)\(\s*'([^']*)'/g)) {
      if (/(impersonat|login-as|log-in-as|act-as|sudo|switch-user|become)/i.test(match[1] as string)) offenders.push(`${relative(ROOT, file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every staff route is behind the elevation guard; every mutation is idempotent and completes in its transaction', () => {
  const guards = (Reflect.getMetadata(GUARDS_METADATA, AdminStaffController) as unknown[] | undefined) ?? [];
  assert.ok(guards.includes(ElevationGuard), 'class-level ElevationGuard');
  let mutations = 0;
  for (const controller of [AdminStaffController, ModerationParticipantController]) {
    for (const key of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as unknown as Record<string, unknown>)[key];
      if (typeof handler !== 'function' || key === 'constructor') continue;
      const method = Reflect.getMetadata('method', handler) as number | undefined;
      if (method !== 1) continue; // RequestMethod.POST
      mutations += 1;
      const options = Reflect.getMetadata(IDEMPOTENT, handler) as { action: string } | undefined;
      assert.ok(options, `${controller.name}.${key} is @Idempotent`);
      assert.equal(IDEMPOTENT_ROUTES[options.action]?.kind, 'in_transaction', options.action);
    }
  }
  assert.equal(mutations, 21);
});
