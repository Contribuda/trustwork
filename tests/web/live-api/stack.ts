import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApp } from '../../../apps/api/src/app.js';
import type { Clock } from '../../../apps/api/src/modules/identity/ports.js';
import { createPool, withMaintenance, withPrincipal } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../../packages/data/src/repositories/kernel.js';
import { budgets } from '../../../packages/data/src/repositories/billing.js';
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
    if (req.method === 'POST' && url.pathname === '/screen') {
      // SANC-004: the money and commitment gates refuse unscreened parties; the worker is not part of this stack, so the
      // control server activates synthetic baseline lists and screens every person and company through the worker's code.
      if (!db) return send(res, 400, { error: 'bad request' });
      return send(res, 200, await screenEveryoneClear(db.admin));
    }
    return send(res, 404, { error: 'not found' });
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
