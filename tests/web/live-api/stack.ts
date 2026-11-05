import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApp } from '../../../apps/api/src/app.js';
import type { Clock } from '../../../apps/api/src/modules/identity/ports.js';
import { createPool, withMaintenance, withPrincipal } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../../packages/data/src/repositories/kernel.js';
import { budgets } from '../../../packages/data/src/repositories/billing.js';
import { adminSetup, staffRoleDefinitions } from '../../../packages/data/src/repositories/admin.js';
import { principalFor } from '../../data/helpers/seed.js';
import { screenEveryoneClear } from '../../screening-gates/helpers.js';
import { endPool, provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { CommittedMailbox } from '../../worker/mail/helpers/committed-mailbox.js';
import { API_PORT, CONTROL_PORT, WEB_ORIGIN } from './ports.js';

/**
 * Real backend for the live API browser suite (WEB-004), started by Playwright as a web server from the repository
 * root: a fresh PostgreSQL database with every migration (the same backends as the database tests: an external URL,
 * Docker or embedded-postgres), the API on a restricted runtime role, and a mailbox that reads the mail intents the API
 * committed (MAIL-001: mail leaves through the outbox; the tokens are opened with the shared `MAIL_SECRET_KEY`, exactly
 * what the worker would mail). A loopback-only control server lets the tests read that mailbox, move the API clock forward to reach
 * the step-up window and grant a person a transaction budget (WEB-002; no budget route exists yet) and screen everyone against synthetic baseline lists (SANC-004; the worker is not part of this stack). None of this is product code; nothing leaves the machine. The database is dropped on exit.
 */
class MovableClock implements Clock {
  offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}

const mailKeyHex = randomBytes(32).toString('hex');
// A throwaway key-encryption key, new for every run, so a synthetic secret can be sealed; nothing outlives the database.
const kekHex = randomBytes(32).toString('hex');
let mailbox: CommittedMailbox | null = null;
const clock = new MovableClock();

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

const control = createServer((req, res) => {
  void (async () => {
    try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/mail') {
      const to = url.searchParams.get('to') ?? '';
      const items = mailbox ? (await mailbox.to(to)).reverse().map((m) => ({ to, template: m.template, params: m.params })) : [];
      return send(res, 200, { items });
    }
    if (req.method === 'POST' && url.pathname === '/clock') {
      const body = await readJson(req);
      clock.offsetMs = typeof body.offsetMs === 'number' ? body.offsetMs : 0;
      return send(res, 200, { offsetMs: clock.offsetMs });
    }
    if (req.method === 'POST' && url.pathname === '/budget') {
      // WEB-002: no budget route exists yet (BILL-001 exposes none); the commerce journey needs a transaction budget the
      // buyer grants itself, exactly as the runtime function would through the future billing screens.
      const body = await readJson(req);
      if (!pool || !db || typeof body.personId !== 'string' || typeof body.limitMinor !== 'string' || typeof body.currency !== 'string') return send(res, 400, { error: 'bad request' });
      const principal = await principalFor(db.admin, body.personId);
      const id = await withPrincipal(pool, principal, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null, periodFrom: '2026-01-01T00:00:00Z', periodTo: '2030-01-01T00:00:00Z', limitMinor: body.limitMinor as string, currency: body.currency as string }));
      return send(res, 200, { id });
    }
    if (req.method === 'POST' && url.pathname === '/staff') {
      // HUBC-007: the console journeys need staff of a node and of a hub. The setup wizard's founding administrators and
      // the console's own assignment flow are covered elsewhere; here a synthetic test definition (a fresh version of the
      // named role with exactly the listed permissions) is assigned through the maintenance path, as a setup run would.
      const body = await readJson(req);
      const scope = body.scope as { kind?: unknown; nodeId?: unknown; hubId?: unknown } | undefined;
      if (!db || typeof body.personId !== 'string' || typeof body.role !== 'string' || !Array.isArray(body.permissions) || !scope || (scope.kind !== 'node' && scope.kind !== 'hub')) {
        return send(res, 400, { error: 'bad request' });
      }
      const result = await withMaintenance(db.admin, async (trx) => {
        const node = (await trx.selectFrom('admin_node').select('id').executeTakeFirst()) ?? (await trx.insertInto('admin_node').values({ label: 'Synthetic live node' }).returning('id').executeTakeFirstOrThrow());
        // A founding platform owner (as the setup wizard records one) grants every test role; created once.
        let founder = (await trx.selectFrom('staff_role_assignment').select('person_id').where('setup_bootstrap', '=', true).executeTakeFirst())?.person_id;
        if (!founder) {
          await staffRoleDefinitions.release(trx, { version: 1, role: 'platform-owner', scopes: ['platform'], permissions: ['admin.staff.assign', 'admin.staff.read'],
            caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
          founder = (await trx.insertInto('person').values({ display_name: 'Synthetic Live Founder' }).returning('id').executeTakeFirstOrThrow()).id;
          await adminSetup.bootstrapFirstAdmin(trx, { personId: founder, role: 'platform-owner', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic live setup' });
        }
        const latest = await trx.selectFrom('staff_role_definition_version').select((eb) => eb.fn.max('version').as('v')).where('role', '=', body.role as never).executeTakeFirst();
        const version = Math.max(900, Number(latest?.v ?? 0) + 1);
        await trx.insertInto('staff_role_definition_version').values({ role: body.role as never, version, scopes: [scope.kind as 'node' | 'hub'], permissions: body.permissions as never,
          grant_max_hours: 72, sod_mode: 'reduced' } as never).execute();
        await trx.insertInto('staff_role_assignment').values({
          person_id: body.personId as string, role: body.role as never, scope_kind: scope.kind as 'node' | 'hub',
          node_id: scope.kind === 'node' ? (typeof scope.nodeId === 'string' ? scope.nodeId : node.id) : null,
          hub_id: scope.kind === 'hub' ? (scope.hubId as string) : null, definition_version: version, granted_by: founder, reason: 'Synthetic live console journey',
        } as never).execute();
        // The API keeps a resolved principal until the person's authority epoch moves (as every authority change does).
        await trx.updateTable('person').set((eb) => ({ authz_epoch: eb('authz_epoch', '+', 1) })).where('id', '=', body.personId as string).execute();
        return { nodeId: node.id, version };
      });
      return send(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/definition') {
      // HC-150: a released role definition the console's role catalogue offers (the next version of the named role).
      const body = await readJson(req);
      if (!db || typeof body.role !== 'string' || !Array.isArray(body.scopes) || !Array.isArray(body.permissions)) return send(res, 400, { error: 'bad request' });
      const version = await withMaintenance(db.admin, async (trx) => {
        const latest = await trx.selectFrom('staff_role_definition_version').select((eb) => eb.fn.max('version').as('v')).where('role', '=', body.role as never).executeTakeFirst();
        const next = Number(latest?.v ?? 0) + 1;
        await staffRoleDefinitions.release(trx, { version: next, role: body.role as never, scopes: body.scopes as never, permissions: body.permissions as never,
          caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
        return next;
      });
      return send(res, 200, { version });
    }
    if (req.method === 'POST' && url.pathname === '/serving-origin') {
      // A fresh installation has no registered origin: this rehearses that state and restores the stack's own.
      const body = await readJson(req);
      if (!db || typeof body.active !== 'boolean') return send(res, 400, { error: 'bad request' });
      const active = body.active;
      await withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.agent_serving_hub SET active = ${active}`.execute(trx));
      return send(res, 200, { active });
    }
    if (req.method === 'POST' && url.pathname === '/screen') {
      // SANC-004: the money and commitment gates refuse unscreened parties; the worker is not part of this stack, so the
      // control server activates synthetic baseline lists and screens every person and company through the worker's code.
      if (!db) return send(res, 400, { error: 'bad request' });
      return send(res, 200, await screenEveryoneClear(db.admin));
    }
    return send(res, 404, { error: 'not found' });
    } catch (error) {
      // A failing control call answers 500 and never takes the stack down with it.
      console.error('[live-api] control', error);
      return send(res, 500, { error: error instanceof Error ? error.message : 'error' });
    }
  })();
});
// Bind the loopback ports before a database exists, so a taken port fails fast and leaves nothing behind.
await new Promise<void>((resolveListen, reject) => {
  control.once('error', reject);
  control.listen(CONTROL_PORT, '127.0.0.1', () => resolveListen());
});

const db = await provisionTestDatabase('web_live');
if (!db) {
  console.error(SKIP_REASON);
  control.close();
  process.exit(1);
}
let pool: ReturnType<typeof createPool> | null = null;
let created: Awaited<ReturnType<typeof createApp>> | null = null;
let closing = false;
async function shutdown(code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  control.close();
  await created?.close().catch(() => undefined);
  db!.teardown.begin();
  if (pool) await endPool(pool).catch(() => undefined);
  await db!.close().catch(() => undefined);
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

try {
  await db.migrate();
  // Reference data (units, restricted places) as a deployment loads it; without it every place code is refused (fail closed).
  await withMaintenance(db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  // Explicit synthetic serving authority for governed service and anonymous public projection tests.
  await withMaintenance(db.admin, async trx => {
    const hub = await trx.insertInto('hub').values({ slug: 'synthetic-live-api', lifecycle: 'draft' }).returning('id').executeTakeFirstOrThrow();
    await sql`INSERT INTO trustwork.agent_serving_hub(origin,hub_id) VALUES(${WEB_ORIGIN},${hub.id}::uuid)`.execute(trx);
  });
  await db.createAppLogin();
  pool = db.teardown.watch(createPool({ ...db.appConfig, max: 8 }));
  mailbox = new CommittedMailbox(db.admin, Buffer.from(mailKeyHex, 'hex'));
  created = await createApp({
    env: {
      API_HOST: '127.0.0.1',
      API_PORT: String(API_PORT),
      // The browser loads the web origin; the API proves same-origin mutations against it.
      PUBLIC_ORIGIN: WEB_ORIGIN,
      AUTH_PROVIDER_MODE: 'disabled',
      // Every browser request reaches the API through the web server's rewrite (one peer address).
      API_TRUSTED_PROXY_HOPS: '1',
      AUTH_RATE_LIMIT_PER_MINUTE: '10000',
      AUTH_LOCKOUT_THRESHOLD: '50',
      API_LOG_LEVEL: 'error',
      MAIL_SECRET_KEY: mailKeyHex,
      TRUSTWORK_KEK: kekHex,
    },
    pool,
    clock,
    logSink: (line) => {
      if (line.includes('"level":"error"')) console.error('[api]', line);
    },
  });
  await created.app.listen(API_PORT, '127.0.0.1');
} catch (error) {
  console.error('[live-api] start failed', error);
  await shutdown(1);
}
console.log(`[live-api] database=${db.databaseName} api=:${API_PORT} control=:${CONTROL_PORT} origin=${WEB_ORIGIN}`);
